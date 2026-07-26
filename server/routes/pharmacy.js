/**
 * Pharmacy terminal.
 *
 * GET  /api/pharmacy/queue          the working queue, grouped by status
 * GET  /api/pharmacy/queue/:id      one queue entry with full context
 * POST /api/pharmacy/queue/:id/fill      pending  -> ready   (decrements stock)
 * POST /api/pharmacy/queue/:id/dispense  ready    -> picked up
 * POST /api/pharmacy/queue/:id/reject    pending  -> rejected
 * POST /api/pharmacy/queue/:id/cancel    cancel an entry
 * GET  /api/pharmacy/stock          medications at or below reorder level
 */
import { Router } from 'express';
import { one, rows, transaction } from '../db/pool.js';
import { asyncHandler, ok, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z, listQuery } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { broadcastChange, notifyStaff } from '../lib/notify.js';

const router = Router();
router.use(requireAuth);

const QUEUE_SELECT = `
  SELECT pq.*,
         rx.medication_name, rx.dosage, rx.frequency, rx.duration, rx.quantity,
         rx.refills, rx.instructions, rx.prescribed_at, rx.visit_id,
         rx.medication_id, rx.prescribed_by,
         pt.mrn, pt.first_name, pt.last_name,
         pt.first_name || ' ' || pt.last_name AS patient_name,
         prescriber.full_name AS prescriber_name,
         filler.full_name AS filled_by_name,
         dispenser.full_name AS dispensed_by_name,
         m.is_controlled, m.stock_quantity, m.unit_cost, m.form,
         (extract(epoch from (now() - pq.created_at)) / 60)::int AS waiting_minutes
    FROM pharmacy_queue pq
    JOIN prescriptions rx ON rx.id = pq.prescription_id
    JOIN patients pt ON pt.id = pq.patient_id
    LEFT JOIN staff prescriber ON prescriber.id = rx.prescribed_by
    LEFT JOIN staff filler ON filler.id = pq.filled_by
    LEFT JOIN staff dispenser ON dispenser.id = pq.dispensed_by
    LEFT JOIN medications m ON m.id = rx.medication_id
`;

/** Emergency first, then urgent, then oldest waiting. */
const QUEUE_ORDER = `
  CASE pq.priority WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
  pq.created_at
`;

router.get(
  '/queue',
  requirePermission('pharmacy:read'),
  validate(listQuery.extend({ status: z.string().max(20).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req, 50);
    const q = req.validatedQuery;

    const filters = [];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.status) add(q.status, (p) => `pq.status = ${p}`);
    if (q.search) {
      add(
        `%${q.search}%`,
        (p) => `(rx.medication_name ILIKE ${p} OR (pt.first_name || ' ' || pt.last_name) ILIKE ${p} OR pt.mrn ILIKE ${p})`
      );
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const { count } = await one(
      `SELECT count(*)::int AS count
         FROM pharmacy_queue pq
         JOIN prescriptions rx ON rx.id = pq.prescription_id
         JOIN patients pt ON pt.id = pq.patient_id
         ${where}`,
      params
    );

    const list = await rows(
      `${QUEUE_SELECT} ${where} ORDER BY ${QUEUE_ORDER} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

// Tab badge counts span the whole queue, not the current page, so they stay
// correct while a filter is applied. Kept separate from the list response so
// the pagination envelope has one shape everywhere.
router.get(
  '/queue/summary',
  requirePermission('pharmacy:read'),
  asyncHandler(async (_req, res) => {
    const counts = await rows('SELECT status, count(*)::int AS count FROM pharmacy_queue GROUP BY status');
    const summary = counts.reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {
      pending: 0, in_progress: 0, ready: 0, picked_up: 0, rejected: 0, cancelled: 0,
    });

    const oldest = await one(
      `SELECT (extract(epoch from (now() - min(created_at))) / 60)::int AS minutes
         FROM pharmacy_queue WHERE status = 'pending'`
    );

    return ok(res, { ...summary, oldest_pending_minutes: oldest?.minutes ?? 0 });
  })
);

router.get(
  '/queue/:id',
  requirePermission('pharmacy:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'queue entry id');
    const entry = await one(`${QUEUE_SELECT} WHERE pq.id = $1`, [id]);
    if (!entry) throw notFound('Pharmacy queue entry');

    // Allergies matter most at the point of dispensing, so surface them here.
    const allergies = await rows(
      'SELECT substance, reaction, severity FROM patient_allergies WHERE patient_id = $1 AND deleted_at IS NULL',
      [entry.patient_id]
    );

    return ok(res, { ...entry, allergies });
  })
);

/** Fetch a queue entry and assert it is in one of the expected states. */
async function loadEntryInState(client, id, allowedStatuses) {
  const { rows: found } = await client.query(
    `SELECT pq.*, rx.medication_name, rx.medication_id, rx.quantity, rx.prescribed_by,
            pt.first_name || ' ' || pt.last_name AS patient_name
       FROM pharmacy_queue pq
       JOIN prescriptions rx ON rx.id = pq.prescription_id
       JOIN patients pt ON pt.id = pq.patient_id
      WHERE pq.id = $1
      FOR UPDATE OF pq`,
    [id]
  );

  if (found.length === 0) throw notFound('Pharmacy queue entry');
  const entry = found[0];

  if (!allowedStatuses.includes(entry.status)) {
    throw badRequest(
      `This prescription is "${entry.status}"; expected ${allowedStatuses.map((s) => `"${s}"`).join(' or ')}.`
    );
  }

  return entry;
}

router.post(
  '/queue/:id/fill',
  requirePermission('pharmacy:manage'),
  validate(z.object({ notes: z.string().max(1000).optional().nullable() })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'queue entry id');

    const result = await transaction(async (client) => {
      const entry = await loadEntryInState(client, id, ['pending', 'in_progress']);

      // Decrement stock when the medication is catalogued. Filling below zero
      // is allowed but flagged, since a roleplay clinic should not hard-block
      // on inventory it may not have been keeping up to date.
      let stockWarning = null;
      if (entry.medication_id) {
        const { rows: med } = await client.query(
          'SELECT name, stock_quantity, reorder_level FROM medications WHERE id = $1 FOR UPDATE',
          [entry.medication_id]
        );

        if (med.length > 0) {
          const remaining = med[0].stock_quantity - entry.quantity;
          if (remaining < 0) {
            stockWarning = `Only ${med[0].stock_quantity} unit(s) of ${med[0].name} in stock; ${entry.quantity} required.`;
          }
          await client.query(
            'UPDATE medications SET stock_quantity = GREATEST(stock_quantity - $2, 0) WHERE id = $1',
            [entry.medication_id, entry.quantity]
          );
          if (remaining >= 0 && remaining <= med[0].reorder_level) {
            stockWarning = `${med[0].name} is down to ${remaining} unit(s) - at or below the reorder level.`;
          }
        }
      }

      const { rows: updated } = await client.query(
        `UPDATE pharmacy_queue
            SET status = 'ready', filled_by = $2, filled_at = now(),
                notes = COALESCE($3, notes)
          WHERE id = $1 RETURNING *`,
        [id, req.staff.id, req.body.notes ?? null]
      );

      await client.query("UPDATE prescriptions SET status = 'filled' WHERE id = $1", [entry.prescription_id]);

      return { entry: updated[0], prescription: entry, stockWarning };
    });

    await audit({
      req, action: 'fill', entityType: 'pharmacy_queue', entityId: id,
      description: `Filled ${result.prescription.medication_name} for ${result.prescription.patient_name}`,
    });

    broadcastChange('pharmacy', { queueId: id, status: 'ready' });

    if (result.prescription.prescribed_by) {
      await notifyStaff({
        staffId: result.prescription.prescribed_by,
        type: 'prescription',
        title: 'Prescription ready',
        body: `${result.prescription.medication_name} for ${result.prescription.patient_name}`,
        link: '#/pharmacy',
        entityType: 'pharmacy_queue',
        entityId: id,
      });
    }

    return ok(res, { ...result.entry, stock_warning: result.stockWarning });
  })
);

router.post(
  '/queue/:id/dispense',
  requirePermission('pharmacy:manage'),
  validate(
    z.object({
      collected_by: z.string().max(120).optional().nullable(),
      notes: z.string().max(1000).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'queue entry id');

    const result = await transaction(async (client) => {
      const entry = await loadEntryInState(client, id, ['ready']);

      const { rows: updated } = await client.query(
        `UPDATE pharmacy_queue
            SET status = 'picked_up', dispensed_by = $2, dispensed_at = now(),
                notes = CASE WHEN $3::text IS NULL THEN notes
                             ELSE COALESCE(notes || E'\\n', '') || $3 END
          WHERE id = $1 RETURNING *`,
        [
          id,
          req.staff.id,
          req.body.collected_by ? `Collected by: ${req.body.collected_by}` : req.body.notes ?? null,
        ]
      );

      await client.query("UPDATE prescriptions SET status = 'dispensed' WHERE id = $1", [entry.prescription_id]);

      return { entry: updated[0], prescription: entry };
    });

    await audit({
      req, action: 'dispense', entityType: 'pharmacy_queue', entityId: id,
      description: `Dispensed ${result.prescription.medication_name} to ${result.prescription.patient_name}`,
    });

    broadcastChange('pharmacy', { queueId: id, status: 'picked_up' });

    return ok(res, result.entry);
  })
);

router.post(
  '/queue/:id/reject',
  requirePermission('pharmacy:manage'),
  validate(z.object({ reason: z.string().trim().min(1, 'A reason is required').max(500) })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'queue entry id');

    const result = await transaction(async (client) => {
      const entry = await loadEntryInState(client, id, ['pending', 'in_progress', 'ready']);

      const { rows: updated } = await client.query(
        `UPDATE pharmacy_queue
            SET status = 'rejected', rejected_reason = $2, filled_by = $3
          WHERE id = $1 RETURNING *`,
        [id, req.body.reason, req.staff.id]
      );

      // Return the prescription to the prescriber's court rather than leaving
      // it in a pharmacy state nobody owns.
      await client.query("UPDATE prescriptions SET status = 'active' WHERE id = $1", [entry.prescription_id]);

      return { entry: updated[0], prescription: entry };
    });

    await audit({
      req, action: 'reject', entityType: 'pharmacy_queue', entityId: id,
      description: `Rejected ${result.prescription.medication_name}: ${req.body.reason}`,
    });

    broadcastChange('pharmacy', { queueId: id, status: 'rejected' });

    if (result.prescription.prescribed_by) {
      await notifyStaff({
        staffId: result.prescription.prescribed_by,
        type: 'warning',
        title: 'Prescription rejected by pharmacy',
        body: `${result.prescription.medication_name} - ${req.body.reason}`,
        link: `#/prescriptions/${result.prescription.prescription_id}`,
        entityType: 'prescriptions',
        entityId: result.prescription.prescription_id,
      });
    }

    return ok(res, result.entry);
  })
);

router.post(
  '/queue/:id/cancel',
  requirePermission('pharmacy:manage'),
  validate(z.object({ reason: z.string().max(500).optional().nullable() })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'queue entry id');

    const entry = await one(
      `UPDATE pharmacy_queue SET status = 'cancelled',
              notes = CASE WHEN $2::text IS NULL THEN notes
                           ELSE COALESCE(notes || E'\\n', '') || 'Cancelled: ' || $2 END
        WHERE id = $1 AND status IN ('pending','in_progress','ready')
        RETURNING *`,
      [id, req.body.reason ?? null]
    );
    if (!entry) throw badRequest('That entry cannot be cancelled in its current state.');

    await audit({ req, action: 'cancel', entityType: 'pharmacy_queue', entityId: id, description: 'Cancelled pharmacy entry' });
    broadcastChange('pharmacy', { queueId: id, status: 'cancelled' });

    return ok(res, entry);
  })
);

router.get(
  '/stock',
  requirePermission('pharmacy:read'),
  asyncHandler(async (_req, res) => {
    const low = await rows(
      `SELECT id, name, generic_name, strength, form, stock_quantity, reorder_level, unit_cost, is_controlled
         FROM medications
        WHERE deleted_at IS NULL AND is_active = true AND stock_quantity <= reorder_level
        ORDER BY (stock_quantity - reorder_level), name`
    );

    const totals = await one(
      `SELECT count(*)::int AS total_items,
              count(*) FILTER (WHERE stock_quantity = 0)::int AS out_of_stock,
              count(*) FILTER (WHERE stock_quantity <= reorder_level AND stock_quantity > 0)::int AS low_stock
         FROM medications WHERE deleted_at IS NULL AND is_active = true`
    );

    return ok(res, { low_stock: low, totals });
  })
);

export default router;
