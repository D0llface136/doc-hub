/**
 * Emergency mode.
 *
 * GET  /api/emergency/active            currently active codes (drives the banner)
 * GET  /api/emergency                   history
 * POST /api/emergency                   activate a code
 * POST /api/emergency/:id/acknowledge   record that a responder is coming
 * POST /api/emergency/:id/resolve       stand down
 *
 * Activating a code notifies every active staff member, raises the linked
 * patient's triage priority, and pushes a live event so connected HUDs can show
 * the banner and play their alert sound immediately.
 */
import { Router } from 'express';
import { one, rows, transaction } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z, text, listQuery } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { publish } from '../lib/events.js';
import { notifyAll, broadcastChange } from '../lib/notify.js';

const router = Router();
router.use(requireAuth);

const CODE_TYPES = ['code_blue', 'code_red', 'code_black', 'trauma', 'mass_casualty', 'lockdown', 'all_clear'];

/** Human-readable labels, sent with the event so the HUD does not hardcode them. */
const CODE_LABELS = {
  code_blue: 'CODE BLUE - Cardiac arrest',
  code_red: 'CODE RED - Fire',
  code_black: 'CODE BLACK - Bomb threat',
  trauma: 'TRAUMA ALERT',
  mass_casualty: 'MASS CASUALTY INCIDENT',
  lockdown: 'FACILITY LOCKDOWN',
  all_clear: 'ALL CLEAR',
};

const EVENT_SELECT = `
  SELECT e.*,
         activator.full_name AS activated_by_name,
         resolver.full_name AS resolved_by_name,
         pt.mrn, pt.first_name || ' ' || pt.last_name AS patient_name,
         v.visit_number,
         (extract(epoch from (COALESCE(e.resolved_at, now()) - e.activated_at)) / 60)::int AS duration_minutes
    FROM emergency_events e
    LEFT JOIN staff activator ON activator.id = e.activated_by
    LEFT JOIN staff resolver ON resolver.id = e.resolved_by
    LEFT JOIN patients pt ON pt.id = e.patient_id
    LEFT JOIN patient_visits v ON v.id = e.visit_id
`;

router.get(
  '/active',
  asyncHandler(async (_req, res) => {
    const list = await rows(
      `${EVENT_SELECT} WHERE e.status IN ('active','acknowledged') ORDER BY e.activated_at DESC`
    );
    return ok(res, list.map((event) => ({ ...event, label: CODE_LABELS[event.code_type] ?? event.code_type })));
  })
);

router.get(
  '/',
  requirePermission('stats:read'),
  validate(listQuery.extend({ status: z.string().max(20).optional(), code_type: z.string().max(30).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req);
    const q = req.validatedQuery;

    const filters = [];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.status) add(q.status, (p) => `e.status = ${p}`);
    if (q.code_type) add(q.code_type, (p) => `e.code_type = ${p}`);

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const { count } = await one(`SELECT count(*)::int AS count FROM emergency_events e ${where}`, params);

    const list = await rows(
      `${EVENT_SELECT} ${where} ORDER BY e.activated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

router.post(
  '/',
  requirePermission('emergency:activate'),
  validate(
    z.object({
      code_type: z.enum(CODE_TYPES),
      location: z.string().max(200).optional().nullable(),
      description: z.string().max(2000).optional().nullable(),
      patient_id: z.string().uuid().optional().nullable(),
      visit_id: z.string().uuid().optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const b = req.body;

    // "All clear" is a stand-down, not a new alert.
    if (b.code_type === 'all_clear') {
      const resolved = await one(
        `WITH updated AS (
           UPDATE emergency_events
              SET status = 'resolved', resolved_by = $1, resolved_at = now(),
                  resolution_notes = COALESCE(resolution_notes, 'Cleared by all-clear signal')
            WHERE status IN ('active','acknowledged') RETURNING 1)
         SELECT count(*)::int AS count FROM updated`,
        [req.staff.id]
      );

      publish('emergency:cleared', { clearedBy: req.staff.full_name, count: resolved.count });
      await audit({ req, action: 'all_clear', entityType: 'emergency_events', description: `Cleared ${resolved.count} active code(s)` });

      return ok(res, { cleared: resolved.count });
    }

    const event = await transaction(async (client) => {
      const { rows: inserted } = await client.query(
        `INSERT INTO emergency_events
           (code_type, location, description, patient_id, visit_id, activated_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.code_type, b.location ?? null, b.description ?? null, b.patient_id ?? null, b.visit_id ?? null, req.staff.id]
      );

      // An emergency involving a waiting patient jumps them up the queue.
      if (b.visit_id) {
        await client.query(
          `UPDATE patient_visits SET priority = 'emergency'
            WHERE id = $1 AND status IN ('waiting','being_seen')`,
          [b.visit_id]
        );
      } else if (b.patient_id) {
        await client.query(
          `UPDATE patient_visits SET priority = 'emergency'
            WHERE patient_id = $1 AND status IN ('waiting','being_seen') AND deleted_at IS NULL`,
          [b.patient_id]
        );
      }

      return inserted[0];
    });

    const label = CODE_LABELS[b.code_type] ?? b.code_type;

    // Push before persisting notifications so the banner appears with the least
    // possible delay; the durable rows follow immediately after.
    publish('emergency:activated', {
      id: event.id,
      code_type: event.code_type,
      label,
      location: event.location,
      description: event.description,
      activated_by: req.staff.full_name,
      activated_at: event.activated_at,
      patient_id: event.patient_id,
      visit_id: event.visit_id,
      /** The HUD plays its alert sound when this is true. */
      sound: true,
    });

    await notifyAll({
      type: 'emergency',
      title: label,
      body: [event.location, event.description].filter(Boolean).join(' - ') || 'Respond immediately.',
      link: '#/emergency',
      entityType: 'emergency_events',
      entityId: event.id,
    });

    await audit({
      req, action: 'activate', entityType: 'emergency_events', entityId: event.id,
      description: `Activated ${label}${event.location ? ` at ${event.location}` : ''}`,
    });

    if (b.visit_id || b.patient_id) broadcastChange('queue', { emergency: true });

    return created(res, { ...event, label });
  })
);

router.post(
  '/:id/acknowledge',
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'event id');

    const event = await one(
      `UPDATE emergency_events
          SET status = CASE WHEN status = 'active' THEN 'acknowledged' ELSE status END,
              -- Append this responder if they are not already listed.
              responders = CASE
                WHEN responders @> $2::jsonb THEN responders
                ELSE responders || $2::jsonb END
        WHERE id = $1 AND status IN ('active','acknowledged')
        RETURNING *`,
      [id, JSON.stringify([{ staff_id: req.staff.id, name: req.staff.full_name, at: new Date().toISOString() }])]
    );
    if (!event) throw badRequest('That code is not active.');

    publish('emergency:acknowledged', {
      id: event.id,
      responder: req.staff.full_name,
      responder_count: Array.isArray(event.responders) ? event.responders.length : 0,
    });

    await audit({ req, action: 'acknowledge', entityType: 'emergency_events', entityId: id, description: 'Acknowledged emergency code' });

    return ok(res, event);
  })
);

router.post(
  '/:id/resolve',
  requirePermission('emergency:resolve'),
  validate(z.object({ resolution_notes: text(2000, 'Resolution notes') })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'event id');

    const event = await one(
      `UPDATE emergency_events
          SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_notes = $3
        WHERE id = $1 AND status IN ('active','acknowledged')
        RETURNING *`,
      [id, req.staff.id, req.body.resolution_notes]
    );
    if (!event) throw notFound('Active emergency code');

    publish('emergency:resolved', {
      id: event.id,
      code_type: event.code_type,
      resolved_by: req.staff.full_name,
    });

    await audit({
      req, action: 'resolve', entityType: 'emergency_events', entityId: id,
      description: `Resolved ${CODE_LABELS[event.code_type] ?? event.code_type}`,
    });

    return ok(res, event);
  })
);

export default router;
