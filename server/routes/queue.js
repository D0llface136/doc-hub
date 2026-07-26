/**
 * Waiting-room queue.
 *
 * GET  /api/queue                      current queue with live wait estimates
 * POST /api/queue/call-next            call the next patient by priority
 * POST /api/queue/:visitId/call        call a specific patient
 * POST /api/queue/:visitId/no-show     mark as a no-show
 * POST /api/queue/:visitId/priority    change triage priority
 * POST /api/queue/:visitId/transfer    reassign to a different clinician
 * POST /api/queue/:visitId/notify      send this patient's team a message
 */
import { Router } from 'express';
import { one, rows, transaction } from '../db/pool.js';
import { asyncHandler, ok, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { broadcastChange, notifyStaff } from '../lib/notify.js';
import { estimateWait, PRIORITY_WEIGHT } from '../lib/clinical.js';

const router = Router();
router.use(requireAuth);

/**
 * Priority ordering used everywhere in this module. Emergency first, then
 * urgent, then normal; within a band, whoever arrived first.
 */
const QUEUE_ORDER = `
  CASE v.priority WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
  v.checked_in_at
`;

router.get(
  '/',
  requirePermission('visits:read'),
  validate(z.object({ include_in_progress: z.enum(['true', 'false']).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const includeInProgress = req.validatedQuery.include_in_progress !== 'false';

    const statuses = includeInProgress ? ['waiting', 'being_seen'] : ['waiting'];

    const list = await rows(
      `SELECT v.id AS visit_id, v.visit_number, v.queue_number, v.priority, v.status,
              v.visit_type, v.chief_complaint, v.checked_in_at, v.called_at,
              v.estimated_wait_minutes,
              (extract(epoch from (now() - v.checked_in_at)) / 60)::int AS waiting_minutes,
              p.id AS patient_id, p.mrn, p.first_name, p.last_name,
              p.first_name || ' ' || p.last_name AS patient_name,
              CASE WHEN p.date_of_birth IS NULL THEN NULL
                   ELSE extract(year from age(p.date_of_birth))::int END AS patient_age,
              d.id AS doctor_id, d.full_name AS doctor_name,
              (SELECT count(*) FROM patient_allergies a
                WHERE a.patient_id = p.id AND a.deleted_at IS NULL
                  AND a.severity IN ('severe','life_threatening')) AS critical_allergies
         FROM patient_visits v
         JOIN patients p ON p.id = v.patient_id
         LEFT JOIN staff d ON d.id = v.assigned_doctor_id
        WHERE v.deleted_at IS NULL AND v.status = ANY($1)
        ORDER BY ${QUEUE_ORDER}`,
      [statuses]
    );

    const { active_doctors } = await one(
      `SELECT count(*)::int AS active_doctors
         FROM staff s JOIN staff_roles r ON r.id = s.role_id
        WHERE s.is_on_duty = true AND s.status = 'active' AND s.deleted_at IS NULL
          AND r.code IN ('doctor','nurse')`
    );

    // Average consultation length over the last 50 completed visits, so the
    // estimate reflects how this clinic actually runs rather than a constant.
    const { avg_minutes } = await one(
      `SELECT COALESCE(avg(extract(epoch from (completed_at - seen_at)) / 60), 15)::int AS avg_minutes
         FROM (SELECT seen_at, completed_at FROM patient_visits
                WHERE seen_at IS NOT NULL AND completed_at IS NOT NULL AND deleted_at IS NULL
                ORDER BY completed_at DESC LIMIT 50) recent`
    );

    const averageConsult = Math.min(Math.max(avg_minutes || 15, 5), 60);

    let waitingPosition = 0;
    const queue = list.map((entry) => {
      const estimated =
        entry.status === 'waiting'
          ? entry.estimated_wait_minutes ?? estimateWait(waitingPosition++, active_doctors, averageConsult)
          : 0;
      return { ...entry, estimated_wait_minutes: estimated };
    });

    const summary = {
      waiting: queue.filter((q) => q.status === 'waiting').length,
      being_seen: queue.filter((q) => q.status === 'being_seen').length,
      emergency: queue.filter((q) => q.priority === 'emergency' && q.status === 'waiting').length,
      urgent: queue.filter((q) => q.priority === 'urgent' && q.status === 'waiting').length,
      active_doctors,
      average_consult_minutes: averageConsult,
      longest_wait_minutes: queue.reduce((max, q) => Math.max(max, q.waiting_minutes ?? 0), 0),
    };

    return ok(res, { queue, summary });
  })
);

/**
 * Move a visit into 'being_seen' and stamp who called it.
 * Shared by call-next and the explicit per-visit call.
 */
async function callVisit(client, visitId, staffId, assignSelf) {
  const { rows: updated } = await client.query(
    `UPDATE patient_visits
        SET status = 'being_seen',
            called_at = now(),
            seen_at = COALESCE(seen_at, now()),
            assigned_doctor_id = CASE WHEN $3 THEN $2 ELSE assigned_doctor_id END
      WHERE id = $1 AND status = 'waiting' AND deleted_at IS NULL
      RETURNING *`,
    [visitId, staffId, assignSelf]
  );
  return updated[0] ?? null;
}

router.post(
  '/call-next',
  requirePermission('queue:manage'),
  validate(
    z.object({
      // A doctor calling the next patient normally takes them; reception
      // calling on a doctor's behalf does not.
      assign_to_me: z.boolean().default(true),
      priority: z.enum(['normal', 'urgent', 'emergency']).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { assign_to_me, priority } = req.body;

    const result = await transaction(async (client) => {
      // FOR UPDATE SKIP LOCKED: if two clinicians hit "call next" at the same
      // moment they get different patients instead of both getting the same one.
      const { rows: candidates } = await client.query(
        `SELECT v.id
           FROM patient_visits v
          WHERE v.deleted_at IS NULL AND v.status = 'waiting'
            AND ($1::text IS NULL OR v.priority = $1)
          ORDER BY ${QUEUE_ORDER}
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [priority ?? null]
      );

      if (candidates.length === 0) return null;

      const visit = await callVisit(client, candidates[0].id, req.staff.id, assign_to_me);
      if (!visit) return null;

      const { rows: full } = await client.query(
        `SELECT v.*, p.mrn, p.first_name || ' ' || p.last_name AS patient_name
           FROM patient_visits v JOIN patients p ON p.id = v.patient_id
          WHERE v.id = $1`,
        [visit.id]
      );
      return full[0];
    });

    if (!result) return ok(res, { called: null, message: 'The waiting room is empty.' });

    await audit({
      req, action: 'call_patient', entityType: 'patient_visits', entityId: result.id,
      description: `Called ${result.patient_name} (queue #${result.queue_number})`,
    });

    broadcastChange('queue', { visitId: result.id, calledBy: req.staff.full_name });

    return ok(res, { called: result });
  })
);

router.post(
  '/:visitId/call',
  requirePermission('queue:manage'),
  validate(z.object({ assign_to_me: z.boolean().default(false) })),
  asyncHandler(async (req, res) => {
    const visitId = requireUuid(req.params.visitId, 'visit id');

    const visit = await transaction((client) => callVisit(client, visitId, req.staff.id, req.body.assign_to_me));

    if (!visit) {
      const exists = await one('SELECT status FROM patient_visits WHERE id = $1 AND deleted_at IS NULL', [visitId]);
      if (!exists) throw notFound('Visit');
      throw badRequest(`This visit is "${exists.status}", not waiting.`);
    }

    await audit({
      req, action: 'call_patient', entityType: 'patient_visits', entityId: visitId,
      description: `Called queue #${visit.queue_number}`,
    });
    broadcastChange('queue', { visitId });

    return ok(res, visit);
  })
);

router.post(
  '/:visitId/no-show',
  requirePermission('queue:manage'),
  validate(z.object({ reason: z.string().max(500).optional().nullable() })),
  asyncHandler(async (req, res) => {
    const visitId = requireUuid(req.params.visitId, 'visit id');

    const visit = await one(
      `UPDATE patient_visits
          SET status = 'no_show', completed_at = now()
        WHERE id = $1 AND status IN ('waiting','being_seen') AND deleted_at IS NULL
        RETURNING *`,
      [visitId]
    );
    if (!visit) throw badRequest('That visit is not in the queue.');

    if (req.body.reason) {
      await one(
        `INSERT INTO visit_notes (visit_id, author_id, note_type, body)
         VALUES ($1,$2,'general',$3) RETURNING id`,
        [visitId, req.staff.id, `Marked as no-show: ${req.body.reason}`]
      );
    }

    await audit({
      req, action: 'no_show', entityType: 'patient_visits', entityId: visitId,
      description: `Marked queue #${visit.queue_number} as a no-show`,
    });
    broadcastChange('queue', { visitId });

    return ok(res, visit);
  })
);

router.post(
  '/:visitId/priority',
  requirePermission('queue:manage'),
  validate(
    z.object({
      priority: z.enum(['normal', 'urgent', 'emergency']),
      reason: z.string().max(500).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const visitId = requireUuid(req.params.visitId, 'visit id');

    const visit = await one(
      'UPDATE patient_visits SET priority = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [visitId, req.body.priority]
    );
    if (!visit) throw notFound('Visit');

    await audit({
      req, action: 'set_priority', entityType: 'patient_visits', entityId: visitId,
      changes: { priority: { from: null, to: req.body.priority } },
      description: `Set priority to ${req.body.priority}${req.body.reason ? `: ${req.body.reason}` : ''}`,
    });

    broadcastChange('queue', { visitId, priority: req.body.priority });

    // Escalating to emergency is worth interrupting the assigned clinician for.
    if (req.body.priority === 'emergency' && visit.assigned_doctor_id) {
      await notifyStaff({
        staffId: visit.assigned_doctor_id,
        type: 'warning',
        title: 'Patient escalated to emergency',
        body: `Visit ${visit.visit_number}${req.body.reason ? ` - ${req.body.reason}` : ''}`,
        link: `#/visits/${visitId}`,
        entityType: 'patient_visits',
        entityId: visitId,
      });
    }

    return ok(res, visit);
  })
);

router.post(
  '/:visitId/transfer',
  requirePermission('queue:manage'),
  validate(
    z.object({
      doctor_id: z.string().uuid().nullable(),
      note: z.string().max(500).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const visitId = requireUuid(req.params.visitId, 'visit id');
    const { doctor_id, note } = req.body;

    if (doctor_id) {
      const doctor = await one(
        `SELECT s.id, s.full_name FROM staff s
          WHERE s.id = $1 AND s.deleted_at IS NULL AND s.status = 'active'`,
        [doctor_id]
      );
      if (!doctor) throw badRequest('That clinician is not available.');
    }

    const visit = await one(
      'UPDATE patient_visits SET assigned_doctor_id = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [visitId, doctor_id]
    );
    if (!visit) throw notFound('Visit');

    await audit({
      req, action: 'transfer', entityType: 'patient_visits', entityId: visitId,
      description: doctor_id ? `Transferred visit ${visit.visit_number}` : `Unassigned visit ${visit.visit_number}`,
    });

    broadcastChange('queue', { visitId });

    if (doctor_id) {
      await notifyStaff({
        staffId: doctor_id,
        type: 'queue',
        title: 'Patient transferred to you',
        body: `Visit ${visit.visit_number}${note ? ` - ${note}` : ''}`,
        link: `#/visits/${visitId}`,
        entityType: 'patient_visits',
        entityId: visitId,
      });
    }

    return ok(res, visit);
  })
);

router.post(
  '/:visitId/notify',
  requirePermission('queue:manage'),
  validate(
    z.object({
      title: z.string().trim().min(1).max(120),
      body: z.string().max(1000).optional().nullable(),
      staff_id: z.string().uuid().optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const visitId = requireUuid(req.params.visitId, 'visit id');
    const visit = await one('SELECT * FROM patient_visits WHERE id = $1 AND deleted_at IS NULL', [visitId]);
    if (!visit) throw notFound('Visit');

    const target = req.body.staff_id ?? visit.assigned_doctor_id;
    if (!target) throw badRequest('No clinician is assigned to this visit, and no recipient was given.');

    await notifyStaff({
      staffId: target,
      type: 'queue',
      title: req.body.title,
      body: req.body.body ?? `Visit ${visit.visit_number}`,
      link: `#/visits/${visitId}`,
      entityType: 'patient_visits',
      entityId: visitId,
    });

    return ok(res, { sent: true });
  })
);

export default router;
