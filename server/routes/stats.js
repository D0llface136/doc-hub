/**
 * Statistics and reports.
 *
 * GET /api/stats/dashboard    everything the home dashboard needs, one request
 * GET /api/stats/overview     headline figures for an arbitrary period
 * GET /api/stats/diagnoses    most common diagnoses
 * GET /api/stats/workload     per-clinician activity
 * GET /api/stats/wait-times   wait time distribution over a period
 * GET /api/stats/audit        the audit log            (audit:read)
 *
 * The dashboard endpoint is deliberately one round trip: the Second Life
 * browser pays a noticeable cost per request, so six widgets should not mean
 * six calls.
 */
import { Router } from 'express';
import { one, rows } from '../db/pool.js';
import { asyncHandler, ok, paginated, readPagination } from '../lib/http.js';
import { validate, z, listQuery } from '../lib/validate.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/dashboard',
  requirePermission('stats:read'),
  asyncHandler(async (req, res) => {
    const [queue, todayVisits, emergencies, appointments, pharmacy, laboratory, revenue, activeStaff, unread] =
      await Promise.all([
        one(
          `SELECT
             count(*) FILTER (WHERE status = 'waiting')::int AS waiting,
             count(*) FILTER (WHERE status = 'being_seen')::int AS being_seen,
             count(*) FILTER (WHERE status = 'waiting' AND priority = 'emergency')::int AS emergency_waiting,
             count(*) FILTER (WHERE status = 'waiting' AND priority = 'urgent')::int AS urgent_waiting,
             COALESCE(max(extract(epoch from (now() - checked_in_at)) / 60) FILTER (WHERE status = 'waiting'), 0)::int AS longest_wait_minutes
           FROM patient_visits WHERE deleted_at IS NULL`
        ),
        one(
          `SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE status IN ('completed','discharged'))::int AS completed,
             count(*) FILTER (WHERE status = 'admitted')::int AS admitted,
             count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
             count(*) FILTER (WHERE visit_type = 'emergency')::int AS emergency_visits,
             COALESCE(avg(extract(epoch from (COALESCE(seen_at, now()) - checked_in_at)) / 60), 0)::int AS avg_wait_minutes
           FROM patient_visits
           WHERE deleted_at IS NULL AND checked_in_at::date = CURRENT_DATE`
        ),
        rows(
          `SELECT e.id, e.code_type, e.location, e.description, e.activated_at, e.status,
                  s.full_name AS activated_by_name
             FROM emergency_events e LEFT JOIN staff s ON s.id = e.activated_by
            WHERE e.status IN ('active','acknowledged')
            ORDER BY e.activated_at DESC LIMIT 10`
        ),
        one(
          `SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE status IN ('scheduled','confirmed'))::int AS upcoming,
             count(*) FILTER (WHERE status = 'checked_in')::int AS checked_in,
             count(*) FILTER (WHERE status = 'completed')::int AS completed,
             count(*) FILTER (WHERE status = 'no_show')::int AS no_shows
           FROM appointments
           WHERE deleted_at IS NULL AND scheduled_start::date = CURRENT_DATE`
        ),
        one(
          `SELECT
             count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'ready')::int AS ready,
             count(*) FILTER (WHERE status = 'picked_up' AND dispensed_at::date = CURRENT_DATE)::int AS dispensed_today
           FROM pharmacy_queue`
        ),
        one(
          `SELECT
             count(*) FILTER (WHERE status IN ('ordered','collected','in_progress'))::int AS pending,
             count(*) FILTER (WHERE status = 'completed' AND completed_at::date = CURRENT_DATE)::int AS completed_today,
             count(*) FILTER (WHERE priority = 'stat' AND status NOT IN ('completed','cancelled'))::int AS pending_stat
           FROM laboratory_orders WHERE deleted_at IS NULL`
        ),
        one(
          `SELECT
             COALESCE(sum(amount) FILTER (WHERE paid_at::date = CURRENT_DATE), 0) AS today,
             COALESCE(sum(amount) FILTER (WHERE paid_at >= date_trunc('month', CURRENT_DATE)), 0) AS month,
             (SELECT COALESCE(sum(balance_due), 0) FROM invoices
               WHERE deleted_at IS NULL AND status IN ('issued','partially_paid','overdue')) AS outstanding
           FROM payments`
        ),
        rows(
          `SELECT s.id, s.full_name, s.display_title, r.code AS role_code, r.name AS role_name,
                  s.last_seen_at,
                  (SELECT count(*) FROM patient_visits v
                    WHERE v.assigned_doctor_id = s.id AND v.status = 'being_seen'
                      AND v.deleted_at IS NULL) AS active_patients
             FROM staff s JOIN staff_roles r ON r.id = s.role_id
            WHERE s.deleted_at IS NULL AND s.status = 'active' AND s.is_on_duty = true
            ORDER BY r.rank, s.full_name`
        ),
        one(
          `SELECT
             (SELECT count(*) FROM notifications WHERE staff_id = $1 AND read_at IS NULL) AS notifications,
             (SELECT count(*) FROM message_recipients WHERE staff_id = $1 AND read_at IS NULL AND archived_at IS NULL) AS messages`,
          [req.staff.id]
        ),
      ]);

    const recentNotifications = await rows(
      `SELECT id, type, title, body, link, created_at, read_at
         FROM notifications
        WHERE staff_id = $1 AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC LIMIT 8`,
      [req.staff.id]
    );

    return ok(res, {
      generated_at: new Date().toISOString(),
      queue,
      today: todayVisits,
      emergencies,
      appointments,
      pharmacy,
      laboratory,
      revenue,
      active_staff: activeStaff,
      unread,
      recent_notifications: recentNotifications,
    });
  })
);

router.get(
  '/overview',
  requirePermission('stats:read'),
  validate(z.object({ days: z.coerce.number().int().min(1).max(365).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const days = req.validatedQuery.days ?? 30;
    const interval = `${days} days`;

    const [visits, waitTimes, clinical, financial] = await Promise.all([
      one(
        `SELECT
           count(*)::int AS total_visits,
           count(DISTINCT patient_id)::int AS unique_patients,
           count(*) FILTER (WHERE visit_type = 'emergency')::int AS emergency_visits,
           count(*) FILTER (WHERE visit_type = 'walk_in')::int AS walk_ins,
           count(*) FILTER (WHERE visit_type = 'scheduled')::int AS scheduled,
           count(*) FILTER (WHERE status IN ('completed','discharged'))::int AS completed,
           count(*) FILTER (WHERE status = 'admitted')::int AS admitted,
           count(*) FILTER (WHERE status = 'no_show')::int AS no_shows
         FROM patient_visits
         WHERE deleted_at IS NULL AND checked_in_at >= now() - $1::interval`,
        [interval]
      ),
      one(
        `SELECT
           COALESCE(avg(extract(epoch from (seen_at - checked_in_at)) / 60), 0)::int AS avg_wait_minutes,
           COALESCE(
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch from (seen_at - checked_in_at)) / 60), 0)::int AS median_wait_minutes,
           COALESCE(max(extract(epoch from (seen_at - checked_in_at)) / 60), 0)::int AS max_wait_minutes,
           COALESCE(avg(extract(epoch from (completed_at - seen_at)) / 60), 0)::int AS avg_consult_minutes
         FROM patient_visits
         WHERE deleted_at IS NULL AND seen_at IS NOT NULL
           AND checked_in_at >= now() - $1::interval`,
        [interval]
      ),
      one(
        `SELECT
           (SELECT count(*) FROM prescriptions
             WHERE deleted_at IS NULL AND prescribed_at >= now() - $1::interval) AS prescriptions_written,
           (SELECT count(*) FROM pharmacy_queue
             WHERE status = 'picked_up' AND dispensed_at >= now() - $1::interval) AS prescriptions_dispensed,
           (SELECT count(*) FROM laboratory_orders
             WHERE deleted_at IS NULL AND ordered_at >= now() - $1::interval) AS labs_ordered,
           (SELECT count(*) FROM laboratory_orders
             WHERE deleted_at IS NULL AND status = 'completed' AND completed_at >= now() - $1::interval) AS labs_completed,
           (SELECT count(*) FROM radiology_orders
             WHERE deleted_at IS NULL AND ordered_at >= now() - $1::interval) AS imaging_ordered,
           (SELECT count(*) FROM surgeries
             WHERE deleted_at IS NULL AND status = 'completed' AND end_time >= now() - $1::interval) AS surgeries_completed,
           (SELECT count(*) FROM emergency_events
             WHERE activated_at >= now() - $1::interval) AS emergency_codes`,
        [interval]
      ),
      one(
        `SELECT
           (SELECT COALESCE(sum(amount), 0) FROM payments WHERE paid_at >= now() - $1::interval) AS revenue,
           (SELECT count(*)::int FROM invoices
             WHERE deleted_at IS NULL AND created_at >= now() - $1::interval) AS invoices_created,
           (SELECT COALESCE(sum(balance_due), 0) FROM invoices
             WHERE deleted_at IS NULL AND status IN ('issued','partially_paid','overdue')) AS outstanding`,
        [interval]
      ),
    ]);

    const daily = await rows(
      `SELECT checked_in_at::date AS date,
              count(*)::int AS visits,
              count(*) FILTER (WHERE visit_type = 'emergency')::int AS emergencies
         FROM patient_visits
        WHERE deleted_at IS NULL AND checked_in_at >= now() - $1::interval
        GROUP BY checked_in_at::date
        ORDER BY date`,
      [interval]
    );

    return ok(res, { period_days: days, visits, wait_times: waitTimes, clinical, financial, daily });
  })
);

router.get(
  '/diagnoses',
  requirePermission('stats:read'),
  validate(z.object({ days: z.coerce.number().int().min(1).max(365).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const days = req.validatedQuery.days ?? 30;
    const limit = req.validatedQuery.limit ?? 10;

    const list = await rows(
      `SELECT COALESCE(d.name, vd.custom_name) AS diagnosis,
              d.category,
              count(*)::int AS count,
              count(DISTINCT v.patient_id)::int AS unique_patients
         FROM visit_diagnoses vd
         JOIN patient_visits v ON v.id = vd.visit_id
         LEFT JOIN diagnoses d ON d.id = vd.diagnosis_id
        WHERE v.deleted_at IS NULL
          AND vd.diagnosed_at >= now() - ($1 || ' days')::interval
          AND vd.certainty <> 'ruled_out'
        GROUP BY COALESCE(d.name, vd.custom_name), d.category
        ORDER BY count DESC
        LIMIT $2`,
      [String(days), limit]
    );

    return ok(res, list);
  })
);

router.get(
  '/workload',
  requirePermission('stats:read'),
  validate(z.object({ days: z.coerce.number().int().min(1).max(365).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const days = String(req.validatedQuery.days ?? 30);

    const list = await rows(
      `SELECT s.id, s.full_name, s.display_title, r.name AS role_name,
              (SELECT count(*) FROM patient_visits v
                WHERE v.assigned_doctor_id = s.id AND v.deleted_at IS NULL
                  AND v.checked_in_at >= now() - ($1 || ' days')::interval) AS patients_seen,
              (SELECT count(*) FROM prescriptions rx
                WHERE rx.prescribed_by = s.id AND rx.deleted_at IS NULL
                  AND rx.prescribed_at >= now() - ($1 || ' days')::interval) AS prescriptions,
              (SELECT count(*) FROM laboratory_orders lo
                WHERE lo.ordered_by = s.id AND lo.deleted_at IS NULL
                  AND lo.ordered_at >= now() - ($1 || ' days')::interval) AS labs_ordered,
              (SELECT COALESCE(avg(extract(epoch from (v.completed_at - v.seen_at)) / 60), 0)::int
                 FROM patient_visits v
                WHERE v.assigned_doctor_id = s.id AND v.completed_at IS NOT NULL AND v.seen_at IS NOT NULL
                  AND v.checked_in_at >= now() - ($1 || ' days')::interval) AS avg_consult_minutes
         FROM staff s JOIN staff_roles r ON r.id = s.role_id
        WHERE s.deleted_at IS NULL AND r.code IN ('doctor','nurse')
        ORDER BY patients_seen DESC, s.full_name`,
      [days]
    );

    return ok(res, list);
  })
);

router.get(
  '/wait-times',
  requirePermission('stats:read'),
  validate(z.object({ days: z.coerce.number().int().min(1).max(90).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const days = String(req.validatedQuery.days ?? 7);

    const buckets = await rows(
      `SELECT
         CASE
           WHEN minutes < 10 THEN '0-9'
           WHEN minutes < 20 THEN '10-19'
           WHEN minutes < 30 THEN '20-29'
           WHEN minutes < 60 THEN '30-59'
           ELSE '60+'
         END AS bucket,
         count(*)::int AS count
       FROM (
         SELECT extract(epoch from (seen_at - checked_in_at)) / 60 AS minutes
           FROM patient_visits
          WHERE deleted_at IS NULL AND seen_at IS NOT NULL
            AND checked_in_at >= now() - ($1 || ' days')::interval
       ) waits
       GROUP BY bucket
       ORDER BY min(minutes)`,
      [days]
    );

    const byPriority = await rows(
      `SELECT priority,
              COALESCE(avg(extract(epoch from (seen_at - checked_in_at)) / 60), 0)::int AS avg_minutes,
              count(*)::int AS count
         FROM patient_visits
        WHERE deleted_at IS NULL AND seen_at IS NOT NULL
          AND checked_in_at >= now() - ($1 || ' days')::interval
        GROUP BY priority`,
      [days]
    );

    return ok(res, { buckets, by_priority: byPriority });
  })
);

router.get(
  '/audit',
  requirePermission('audit:read'),
  validate(
    listQuery.extend({
      staff_id: z.string().uuid().optional(),
      entity_type: z.string().max(60).optional(),
      entity_id: z.string().uuid().optional(),
      action: z.string().max(40).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req, 50);
    const q = req.validatedQuery;

    const filters = [];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.staff_id) add(q.staff_id, (p) => `staff_id = ${p}`);
    if (q.entity_type) add(q.entity_type, (p) => `entity_type = ${p}`);
    if (q.entity_id) add(q.entity_id, (p) => `entity_id = ${p}`);
    if (q.action) add(q.action, (p) => `action = ${p}`);
    if (q.from) add(q.from, (p) => `created_at >= ${p}`);
    if (q.to) add(q.to, (p) => `created_at <= ${p}`);
    if (q.search) add(`%${q.search}%`, (p) => `(description ILIKE ${p} OR staff_name ILIKE ${p})`);

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const { count } = await one(`SELECT count(*)::int AS count FROM audit_logs ${where}`, params);

    const list = await rows(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

export default router;
