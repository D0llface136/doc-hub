/**
 * Laboratory orders and results.
 *
 * GET  /api/laboratory/orders             worklist
 * POST /api/laboratory/orders             order one or more tests
 * GET  /api/laboratory/orders/:id         one order with its results
 * PATCH /api/laboratory/orders/:id        update status / notes
 * POST /api/laboratory/orders/:id/collect mark the specimen collected
 * POST /api/laboratory/orders/:id/results enter a result (completes the order)
 * POST /api/laboratory/orders/:id/cancel  cancel an order
 * GET  /api/laboratory/summary            counts for the dashboard widget
 */
import { Router } from 'express';
import { one, rows, transaction } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z, text, listQuery } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { broadcastChange, notifyStaff, notifyRole } from '../lib/notify.js';

const router = Router();
router.use(requireAuth);

const ORDER_SELECT = `
  SELECT lo.*,
         pt.mrn, pt.first_name, pt.last_name,
         pt.first_name || ' ' || pt.last_name AS patient_name,
         orderer.full_name AS ordered_by_name,
         collector.full_name AS collected_by_name,
         completer.full_name AS completed_by_name,
         v.visit_number,
         cat.category, cat.specimen_type, cat.unit, cat.reference_range, cat.turnaround_minutes,
         (extract(epoch from (now() - lo.ordered_at)) / 60)::int AS elapsed_minutes,
         (SELECT json_agg(row_to_json(lr) ORDER BY lr.resulted_at)
            FROM laboratory_results lr WHERE lr.order_id = lo.id) AS results
    FROM laboratory_orders lo
    JOIN patients pt ON pt.id = lo.patient_id
    LEFT JOIN staff orderer ON orderer.id = lo.ordered_by
    LEFT JOIN staff collector ON collector.id = lo.collected_by
    LEFT JOIN staff completer ON completer.id = lo.completed_by
    LEFT JOIN patient_visits v ON v.id = lo.visit_id
    LEFT JOIN lab_test_catalog cat ON cat.id = lo.test_id
`;

const ORDER_PRIORITY = `
  CASE lo.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
  lo.ordered_at
`;

router.get(
  '/orders',
  requirePermission('lab:read'),
  validate(
    listQuery.extend({
      status: z.string().max(20).optional(),
      priority: z.string().max(20).optional(),
      patient_id: z.string().uuid().optional(),
      visit_id: z.string().uuid().optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req, 50);
    const q = req.validatedQuery;

    const filters = ['lo.deleted_at IS NULL'];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.status) add(q.status, (p) => `lo.status = ${p}`);
    if (q.priority) add(q.priority, (p) => `lo.priority = ${p}`);
    if (q.patient_id) add(q.patient_id, (p) => `lo.patient_id = ${p}`);
    if (q.visit_id) add(q.visit_id, (p) => `lo.visit_id = ${p}`);
    if (q.search) {
      add(`%${q.search}%`, (p) => `(lo.test_name ILIKE ${p} OR (pt.first_name || ' ' || pt.last_name) ILIKE ${p} OR pt.mrn ILIKE ${p})`);
    }

    const where = filters.join(' AND ');

    const { count } = await one(
      `SELECT count(*)::int AS count FROM laboratory_orders lo JOIN patients pt ON pt.id = lo.patient_id WHERE ${where}`,
      params
    );

    const list = await rows(
      `${ORDER_SELECT} WHERE ${where} ORDER BY ${ORDER_PRIORITY} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

router.get(
  '/summary',
  requirePermission('lab:read'),
  asyncHandler(async (_req, res) => {
    const counts = await rows(
      `SELECT status, count(*)::int AS count FROM laboratory_orders WHERE deleted_at IS NULL GROUP BY status`
    );
    const summary = counts.reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {
      ordered: 0, collected: 0, in_progress: 0, completed: 0, cancelled: 0, rejected: 0,
    });

    const critical = await one(
      `SELECT count(*)::int AS count
         FROM laboratory_results lr
         JOIN laboratory_orders lo ON lo.id = lr.order_id
        WHERE lr.flag = 'critical' AND lo.deleted_at IS NULL
          AND lr.resulted_at > now() - interval '24 hours'`
    );

    const stat = await one(
      `SELECT count(*)::int AS count FROM laboratory_orders
        WHERE deleted_at IS NULL AND priority = 'stat' AND status NOT IN ('completed','cancelled')`
    );

    return ok(res, { ...summary, critical_last_24h: critical.count, pending_stat: stat.count });
  })
);

const orderSchema = z.object({
  patient_id: z.string().uuid(),
  visit_id: z.string().uuid().optional().nullable(),
  priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
  clinical_notes: z.string().max(2000).optional().nullable(),
  /** One request may order a whole panel. */
  tests: z
    .array(
      z.object({
        test_id: z.string().uuid().optional().nullable(),
        test_name: z.string().max(160).optional().nullable(),
      })
    )
    .min(1, 'Select at least one test')
    .max(30),
});

router.post(
  '/orders',
  requirePermission('lab:order'),
  validate(orderSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const patient = await one(
      'SELECT id, mrn, first_name, last_name FROM patients WHERE id = $1 AND deleted_at IS NULL',
      [b.patient_id]
    );
    if (!patient) throw notFound('Patient');

    const orders = await transaction(async (client) => {
      const inserted = [];

      for (const testRequest of b.tests) {
        let testName = testRequest.test_name;
        let testId = testRequest.test_id ?? null;

        if (testId) {
          const { rows: cat } = await client.query(
            'SELECT id, name, category FROM lab_test_catalog WHERE id = $1 AND is_active = true',
            [testId]
          );
          if (cat.length === 0) throw badRequest('One of the selected tests is not available.');
          testName = cat[0].name;
        }

        if (!testName) throw badRequest('Each test needs either a catalogue id or a name.');

        const { rows: r } = await client.query(
          `INSERT INTO laboratory_orders
             (visit_id, patient_id, test_id, test_name, priority, clinical_notes, ordered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [b.visit_id ?? null, b.patient_id, testId, testName, b.priority, b.clinical_notes ?? null, req.staff.id]
        );
        inserted.push(r[0]);
      }

      return inserted;
    });

    await audit({
      req, action: 'create', entityType: 'laboratory_orders',
      entityId: orders[0].id,
      description: `Ordered ${orders.map((o) => o.test_name).join(', ')} for ${patient.first_name} ${patient.last_name}`,
    });

    broadcastChange('laboratory', { patientId: b.patient_id, count: orders.length });

    await notifyRole({
      roleCode: 'lab_tech',
      type: b.priority === 'stat' ? 'warning' : 'info',
      title: b.priority === 'stat' ? 'STAT laboratory order' : 'New laboratory order',
      body: `${orders.map((o) => o.test_name).join(', ')} - ${patient.first_name} ${patient.last_name} (${patient.mrn})`,
      link: '#/laboratory',
      entityType: 'laboratory_orders',
      entityId: orders[0].id,
    });

    return created(res, orders);
  })
);

router.get(
  '/orders/:id',
  requirePermission('lab:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'order id');
    const order = await one(`${ORDER_SELECT} WHERE lo.id = $1 AND lo.deleted_at IS NULL`, [id]);
    if (!order) throw notFound('Laboratory order');

    const attachments = await rows(
      `SELECT a.*, s.full_name AS uploaded_by_name
         FROM attachments a LEFT JOIN staff s ON s.id = a.uploaded_by
        WHERE a.entity_type = 'laboratory_result' AND a.deleted_at IS NULL
          AND a.entity_id IN (SELECT id FROM laboratory_results WHERE order_id = $1)`,
      [id]
    );

    return ok(res, { ...order, attachments });
  })
);

router.patch(
  '/orders/:id',
  requirePermission('lab:result'),
  validate(
    z.object({
      status: z.enum(['ordered', 'collected', 'in_progress', 'completed', 'cancelled', 'rejected']).optional(),
      priority: z.enum(['routine', 'urgent', 'stat']).optional(),
      clinical_notes: z.string().max(2000).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'order id');

    const updated = await one(
      `UPDATE laboratory_orders SET
         status         = COALESCE($2, status),
         priority       = COALESCE($3, priority),
         clinical_notes = COALESCE($4, clinical_notes),
         completed_at   = CASE WHEN $2 = 'completed' AND completed_at IS NULL THEN now() ELSE completed_at END,
         completed_by   = CASE WHEN $2 = 'completed' AND completed_by IS NULL THEN $5 ELSE completed_by END
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id, req.body.status ?? null, req.body.priority ?? null, req.body.clinical_notes ?? null, req.staff.id]
    );
    if (!updated) throw notFound('Laboratory order');

    await audit({ req, action: 'update', entityType: 'laboratory_orders', entityId: id, description: `Updated ${updated.test_name}` });
    broadcastChange('laboratory', { orderId: id });

    return ok(res, updated);
  })
);

router.post(
  '/orders/:id/collect',
  requirePermission('lab:result'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'order id');

    const updated = await one(
      `UPDATE laboratory_orders
          SET status = 'collected', collected_by = $2, collected_at = now()
        WHERE id = $1 AND deleted_at IS NULL AND status = 'ordered'
        RETURNING *`,
      [id, req.staff.id]
    );
    if (!updated) throw badRequest('That order is not awaiting collection.');

    await audit({ req, action: 'collect', entityType: 'laboratory_orders', entityId: id, description: `Collected specimen for ${updated.test_name}` });
    broadcastChange('laboratory', { orderId: id, status: 'collected' });

    return ok(res, updated);
  })
);

const resultSchema = z.object({
  result_value: text(500, 'Result'),
  unit: z.string().max(40).optional().nullable(),
  reference_range: z.string().max(120).optional().nullable(),
  flag: z.enum(['normal', 'high', 'low', 'critical', 'abnormal', 'inconclusive']).default('normal'),
  interpretation: z.string().max(4000).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  /** Images or scanned reports, as URLs. */
  attachments: z
    .array(
      z.object({
        file_name: text(200, 'File name'),
        file_url: z.string().url().max(1000),
        mime_type: z.string().max(100).optional().nullable(),
        caption: z.string().max(300).optional().nullable(),
      })
    )
    .max(20)
    .optional(),
  /** Leave the order open when a panel has more results to come. */
  complete_order: z.boolean().default(true),
});

router.post(
  '/orders/:id/results',
  requirePermission('lab:result'),
  validate(resultSchema),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'order id');
    const b = req.body;

    const order = await one(
      `SELECT lo.*, pt.mrn, pt.first_name || ' ' || pt.last_name AS patient_name
         FROM laboratory_orders lo JOIN patients pt ON pt.id = lo.patient_id
        WHERE lo.id = $1 AND lo.deleted_at IS NULL`,
      [id]
    );
    if (!order) throw notFound('Laboratory order');
    if (order.status === 'cancelled') throw badRequest('That order was cancelled.');

    const result = await transaction(async (client) => {
      const { rows: r } = await client.query(
        `INSERT INTO laboratory_results
           (order_id, test_name, result_value, unit, reference_range, flag,
            interpretation, notes, resulted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          id, order.test_name, b.result_value, b.unit ?? null, b.reference_range ?? null,
          b.flag, b.interpretation ?? null, b.notes ?? null, req.staff.id,
        ]
      );
      const resultRow = r[0];

      for (const attachment of b.attachments ?? []) {
        await client.query(
          `INSERT INTO attachments (entity_type, entity_id, file_name, file_url, mime_type, caption, uploaded_by)
           VALUES ('laboratory_result', $1, $2, $3, $4, $5, $6)`,
          [resultRow.id, attachment.file_name, attachment.file_url, attachment.mime_type ?? null, attachment.caption ?? null, req.staff.id]
        );
      }

      if (b.complete_order) {
        await client.query(
          `UPDATE laboratory_orders
              SET status = 'completed', completed_by = $2, completed_at = now()
            WHERE id = $1`,
          [id, req.staff.id]
        );
      } else {
        await client.query("UPDATE laboratory_orders SET status = 'in_progress' WHERE id = $1", [id]);
      }

      return resultRow;
    });

    await audit({
      req, action: 'result', entityType: 'laboratory_results', entityId: result.id,
      description: `Resulted ${order.test_name} for ${order.patient_name}: ${b.result_value} (${b.flag})`,
    });

    broadcastChange('laboratory', { orderId: id, flag: b.flag });

    // Critical results must reach the ordering clinician immediately.
    if (order.ordered_by) {
      const isCritical = b.flag === 'critical';
      await notifyStaff({
        staffId: order.ordered_by,
        type: isCritical ? 'emergency' : 'lab_result',
        title: isCritical ? 'CRITICAL lab result' : 'Lab result available',
        body: `${order.test_name} - ${order.patient_name}: ${b.result_value}${b.unit ? ` ${b.unit}` : ''} (${b.flag})`,
        link: order.visit_id ? `#/visits/${order.visit_id}` : `#/patients/${order.patient_id}`,
        entityType: 'laboratory_results',
        entityId: result.id,
      });
    }

    return created(res, result);
  })
);

router.post(
  '/orders/:id/cancel',
  requirePermission('lab:order'),
  validate(z.object({ reason: z.string().max(500).optional().nullable() })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'order id');

    const cancelled = await one(
      `UPDATE laboratory_orders
          SET status = 'cancelled',
              clinical_notes = CASE WHEN $2::text IS NULL THEN clinical_notes
                                    ELSE COALESCE(clinical_notes || E'\\n', '') || 'Cancelled: ' || $2 END
        WHERE id = $1 AND deleted_at IS NULL AND status NOT IN ('completed','cancelled')
        RETURNING *`,
      [id, req.body.reason ?? null]
    );
    if (!cancelled) throw badRequest('That order cannot be cancelled.');

    await audit({ req, action: 'cancel', entityType: 'laboratory_orders', entityId: id, description: `Cancelled ${cancelled.test_name}` });
    broadcastChange('laboratory', { orderId: id, status: 'cancelled' });

    return ok(res, cancelled);
  })
);

export default router;
