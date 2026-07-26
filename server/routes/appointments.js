/**
 * Appointment scheduling.
 *
 * GET    /api/appointments                  list within a date range
 * GET    /api/appointments/calendar         day/week grid grouped by doctor
 * GET    /api/appointments/availability     free slots for a doctor on a date
 * POST   /api/appointments                  schedule (optionally recurring)
 * GET    /api/appointments/:id              one appointment
 * PATCH  /api/appointments/:id              edit
 * POST   /api/appointments/:id/reschedule   move to a new time
 * POST   /api/appointments/:id/cancel       cancel (optionally the whole series)
 * GET|PUT /api/appointments/availability/:doctorId  weekly working hours
 */
import { Router } from 'express';
import { one, rows, transaction } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { validate, z, isoDate, isoDateTime, listQuery } from '../lib/validate.js';
import { audit, diffChanges } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { notifyStaff, broadcastChange } from '../lib/notify.js';

const router = Router();
router.use(requireAuth);

const APPOINTMENT_SELECT = `
  SELECT a.*,
         pt.mrn, pt.first_name, pt.last_name,
         pt.first_name || ' ' || pt.last_name AS patient_name,
         pt.phone_number AS patient_phone,
         d.full_name AS doctor_name, d.display_title AS doctor_title,
         creator.full_name AS created_by_name
    FROM appointments a
    JOIN patients pt ON pt.id = a.patient_id
    LEFT JOIN staff d ON d.id = a.doctor_id
    LEFT JOIN staff creator ON creator.id = a.created_by
`;

/**
 * Reject an appointment that overlaps an existing one for the same clinician.
 * Cancelled and no-show appointments do not block the slot.
 */
async function assertNoClash(client, { doctorId, start, end, excludeId }) {
  if (!doctorId) return;

  const { rows: clash } = await client.query(
    `SELECT a.id, a.scheduled_start, pt.first_name || ' ' || pt.last_name AS patient_name
       FROM appointments a JOIN patients pt ON pt.id = a.patient_id
      WHERE a.doctor_id = $1
        AND a.deleted_at IS NULL
        AND a.status NOT IN ('cancelled','no_show','rescheduled')
        AND ($4::uuid IS NULL OR a.id <> $4)
        AND a.scheduled_start < $3 AND a.scheduled_end > $2
      LIMIT 1`,
    [doctorId, start, end, excludeId ?? null]
  );

  if (clash.length > 0) {
    throw conflict(
      `That clinician already has an appointment with ${clash[0].patient_name} at ${new Date(clash[0].scheduled_start).toISOString()}.`
    );
  }
}

// --- Listing ---------------------------------------------------------------

router.get(
  '/',
  requirePermission('appointments:read'),
  validate(
    listQuery.extend({
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      doctor_id: z.string().uuid().optional(),
      patient_id: z.string().uuid().optional(),
      status: z.string().max(20).optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req, 50);
    const q = req.validatedQuery;

    const filters = ['a.deleted_at IS NULL'];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.from) add(q.from, (p) => `a.scheduled_end >= ${p}`);
    if (q.to) add(q.to, (p) => `a.scheduled_start <= ${p}`);
    if (q.doctor_id) add(q.doctor_id, (p) => `a.doctor_id = ${p}`);
    if (q.patient_id) add(q.patient_id, (p) => `a.patient_id = ${p}`);
    if (q.status) add(q.status, (p) => `a.status = ${p}`);
    if (q.search) add(`%${q.search}%`, (p) => `((pt.first_name || ' ' || pt.last_name) ILIKE ${p} OR pt.mrn ILIKE ${p})`);

    const where = filters.join(' AND ');

    const { count } = await one(
      `SELECT count(*)::int AS count FROM appointments a JOIN patients pt ON pt.id = a.patient_id WHERE ${where}`,
      params
    );

    const list = await rows(
      `${APPOINTMENT_SELECT} WHERE ${where} ORDER BY a.scheduled_start
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

/**
 * Calendar view: every appointment in a date range, grouped by clinician, plus
 * that clinician's working hours - enough for the SPA to draw the grid in one
 * request.
 */
router.get(
  '/calendar',
  requirePermission('appointments:read'),
  validate(
    z.object({
      date: isoDate,
      days: z.coerce.number().int().min(1).max(31).default(1),
      doctor_id: z.string().uuid().optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { date, days, doctor_id } = req.validatedQuery;

    const appointments = await rows(
      `${APPOINTMENT_SELECT}
        WHERE a.deleted_at IS NULL
          AND a.scheduled_start >= $1::date
          AND a.scheduled_start < ($1::date + ($2 || ' days')::interval)
          AND ($3::uuid IS NULL OR a.doctor_id = $3)
        ORDER BY a.scheduled_start`,
      [date, String(days), doctor_id ?? null]
    );

    const doctors = await rows(
      `SELECT s.id, s.full_name, s.display_title, s.is_on_duty,
              (SELECT json_agg(row_to_json(av) ORDER BY av.day_of_week, av.start_time)
                 FROM doctor_availability av
                WHERE av.doctor_id = s.id AND av.is_active = true) AS availability
         FROM staff s JOIN staff_roles r ON r.id = s.role_id
        WHERE s.deleted_at IS NULL AND s.status = 'active'
          AND r.code IN ('doctor','nurse')
          AND ($1::uuid IS NULL OR s.id = $1)
        ORDER BY r.rank, s.full_name`,
      [doctor_id ?? null]
    );

    return ok(res, { date, days, doctors, appointments });
  })
);

/**
 * Free slots for one clinician on one date, derived from their weekly working
 * hours minus anything already booked.
 */
router.get(
  '/availability',
  requirePermission('appointments:read'),
  validate(
    z.object({
      doctor_id: z.string().uuid(),
      date: isoDate,
      slot_minutes: z.coerce.number().int().min(5).max(240).optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { doctor_id, date, slot_minutes } = req.validatedQuery;

    // JS getUTCDay() and Postgres EXTRACT(DOW) both use 0 = Sunday.
    const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();

    const windows = await rows(
      `SELECT start_time, end_time, slot_minutes
         FROM doctor_availability
        WHERE doctor_id = $1 AND day_of_week = $2 AND is_active = true
        ORDER BY start_time`,
      [doctor_id, dayOfWeek]
    );

    if (windows.length === 0) return ok(res, { date, doctor_id, slots: [], reason: 'No working hours set for that day.' });

    const booked = await rows(
      `SELECT scheduled_start, scheduled_end FROM appointments
        WHERE doctor_id = $1 AND deleted_at IS NULL
          AND status NOT IN ('cancelled','no_show','rescheduled')
          AND scheduled_start >= $2::date AND scheduled_start < $2::date + interval '1 day'`,
      [doctor_id, date]
    );

    const slots = [];
    for (const window of windows) {
      const size = slot_minutes ?? window.slot_minutes;
      let cursor = new Date(`${date}T${window.start_time}Z`);
      const windowEnd = new Date(`${date}T${window.end_time}Z`);

      while (cursor < windowEnd) {
        const slotEnd = new Date(cursor.getTime() + size * 60_000);
        if (slotEnd > windowEnd) break;

        const overlaps = booked.some(
          (b) => new Date(b.scheduled_start) < slotEnd && new Date(b.scheduled_end) > cursor
        );

        slots.push({
          start: cursor.toISOString(),
          end: slotEnd.toISOString(),
          available: !overlaps && slotEnd > new Date(),
        });

        cursor = slotEnd;
      }
    }

    return ok(res, { date, doctor_id, slots });
  })
);

// --- Create ----------------------------------------------------------------

const appointmentSchema = z
  .object({
    patient_id: z.string().uuid(),
    doctor_id: z.string().uuid().optional().nullable(),
    scheduled_start: isoDateTime,
    scheduled_end: isoDateTime.optional(),
    duration_minutes: z.coerce.number().int().min(5).max(480).default(30),
    appointment_type: z
      .enum(['consultation', 'follow_up', 'procedure', 'lab', 'imaging', 'vaccination', 'physical', 'other'])
      .default('consultation'),
    reason: z.string().max(1000).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    recurrence_rule: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).optional().nullable(),
    recurrence_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  })
  .refine((d) => !d.recurrence_rule || d.recurrence_until, {
    message: 'A recurring appointment needs an end date',
    path: ['recurrence_until'],
  });

/** Step a date forward by one recurrence interval. */
function advance(date, rule) {
  const next = new Date(date);
  switch (rule) {
    case 'daily': next.setUTCDate(next.getUTCDate() + 1); break;
    case 'weekly': next.setUTCDate(next.getUTCDate() + 7); break;
    case 'biweekly': next.setUTCDate(next.getUTCDate() + 14); break;
    case 'monthly': next.setUTCMonth(next.getUTCMonth() + 1); break;
    default: return null;
  }
  return next;
}

const MAX_RECURRENCES = 104; // two years of weekly appointments

router.post(
  '/',
  requirePermission('appointments:write'),
  validate(appointmentSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const patient = await one(
      'SELECT id, mrn, first_name, last_name FROM patients WHERE id = $1 AND deleted_at IS NULL',
      [b.patient_id]
    );
    if (!patient) throw notFound('Patient');

    const start = new Date(b.scheduled_start);
    const end = b.scheduled_end ? new Date(b.scheduled_end) : new Date(start.getTime() + b.duration_minutes * 60_000);
    if (end <= start) throw badRequest('The appointment must end after it starts.');

    const result = await transaction(async (client) => {
      await assertNoClash(client, { doctorId: b.doctor_id, start, end });

      const { rows: first } = await client.query(
        `INSERT INTO appointments
           (patient_id, doctor_id, scheduled_start, scheduled_end, appointment_type,
            reason, notes, recurrence_rule, recurrence_until, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          b.patient_id, b.doctor_id ?? null, start, end, b.appointment_type,
          b.reason ?? null, b.notes ?? null, b.recurrence_rule ?? null,
          b.recurrence_until ?? null, req.staff.id,
        ]
      );
      const parent = first[0];
      const series = [parent];

      if (b.recurrence_rule) {
        const until = new Date(`${b.recurrence_until}T23:59:59Z`);
        let cursorStart = advance(start, b.recurrence_rule);
        let cursorEnd = advance(end, b.recurrence_rule);
        let generated = 0;

        while (cursorStart && cursorStart <= until && generated < MAX_RECURRENCES) {
          // A clash in the series skips that occurrence rather than aborting
          // the whole booking - the clinician can fill the gap manually.
          const { rows: clash } = await client.query(
            `SELECT 1 FROM appointments
              WHERE doctor_id = $1 AND deleted_at IS NULL
                AND status NOT IN ('cancelled','no_show','rescheduled')
                AND scheduled_start < $3 AND scheduled_end > $2 LIMIT 1`,
            [b.doctor_id ?? null, cursorStart, cursorEnd]
          );

          if (clash.length === 0) {
            const { rows: child } = await client.query(
              `INSERT INTO appointments
                 (patient_id, doctor_id, scheduled_start, scheduled_end, appointment_type,
                  reason, notes, recurrence_parent_id, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
              [
                b.patient_id, b.doctor_id ?? null, cursorStart, cursorEnd,
                b.appointment_type, b.reason ?? null, b.notes ?? null, parent.id, req.staff.id,
              ]
            );
            series.push(child[0]);
          }

          cursorStart = advance(cursorStart, b.recurrence_rule);
          cursorEnd = advance(cursorEnd, b.recurrence_rule);
          generated += 1;
        }
      }

      return series;
    });

    await audit({
      req, action: 'create', entityType: 'appointments', entityId: result[0].id,
      description: `Scheduled ${result.length} appointment(s) for ${patient.first_name} ${patient.last_name}`,
    });

    broadcastChange('appointments', { appointmentId: result[0].id });

    if (b.doctor_id) {
      await notifyStaff({
        staffId: b.doctor_id,
        type: 'appointment',
        title: 'New appointment scheduled',
        body: `${patient.first_name} ${patient.last_name} - ${start.toISOString()}`,
        link: '#/appointments',
        entityType: 'appointments',
        entityId: result[0].id,
      });
    }

    return created(res, { appointment: result[0], series_count: result.length, series: result });
  })
);

router.get(
  '/:id',
  requirePermission('appointments:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'appointment id');
    const appointment = await one(`${APPOINTMENT_SELECT} WHERE a.id = $1 AND a.deleted_at IS NULL`, [id]);
    if (!appointment) throw notFound('Appointment');
    return ok(res, appointment);
  })
);

router.patch(
  '/:id',
  requirePermission('appointments:write'),
  validate(
    z.object({
      doctor_id: z.string().uuid().optional().nullable(),
      appointment_type: z
        .enum(['consultation', 'follow_up', 'procedure', 'lab', 'imaging', 'vaccination', 'physical', 'other'])
        .optional(),
      reason: z.string().max(1000).optional().nullable(),
      notes: z.string().max(2000).optional().nullable(),
      status: z
        .enum(['scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'])
        .optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'appointment id');
    const existing = await one('SELECT * FROM appointments WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Appointment');

    const b = req.body;
    const updated = await one(
      `UPDATE appointments SET
         doctor_id        = COALESCE($2, doctor_id),
         appointment_type = COALESCE($3, appointment_type),
         reason           = COALESCE($4, reason),
         notes            = COALESCE($5, notes),
         status           = COALESCE($6, status)
       WHERE id = $1 RETURNING *`,
      [id, b.doctor_id ?? null, b.appointment_type ?? null, b.reason ?? null, b.notes ?? null, b.status ?? null]
    );

    await audit({
      req, action: 'update', entityType: 'appointments', entityId: id,
      changes: diffChanges(existing, updated),
      description: 'Updated appointment',
    });
    broadcastChange('appointments', { appointmentId: id });

    return ok(res, updated);
  })
);

router.post(
  '/:id/reschedule',
  requirePermission('appointments:write'),
  validate(
    z.object({
      scheduled_start: isoDateTime,
      scheduled_end: isoDateTime.optional(),
      duration_minutes: z.coerce.number().int().min(5).max(480).default(30),
      doctor_id: z.string().uuid().optional().nullable(),
      reason: z.string().max(500).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'appointment id');
    const b = req.body;

    const existing = await one(
      `SELECT a.*, pt.first_name || ' ' || pt.last_name AS patient_name
         FROM appointments a JOIN patients pt ON pt.id = a.patient_id
        WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [id]
    );
    if (!existing) throw notFound('Appointment');
    if (['completed', 'cancelled'].includes(existing.status)) {
      throw badRequest(`A ${existing.status} appointment cannot be rescheduled.`);
    }

    const start = new Date(b.scheduled_start);
    const end = b.scheduled_end ? new Date(b.scheduled_end) : new Date(start.getTime() + b.duration_minutes * 60_000);
    const doctorId = b.doctor_id ?? existing.doctor_id;

    // A reschedule creates a new appointment and marks the old one, so the
    // history of what was moved and when stays intact.
    const replacement = await transaction(async (client) => {
      await assertNoClash(client, { doctorId, start, end, excludeId: id });

      await client.query(
        `UPDATE appointments
            SET status = 'rescheduled',
                notes = COALESCE(notes || E'\\n', '') || 'Rescheduled' ||
                        CASE WHEN $2::text IS NULL THEN '' ELSE ': ' || $2 END
          WHERE id = $1`,
        [id, b.reason ?? null]
      );

      const { rows: r } = await client.query(
        `INSERT INTO appointments
           (patient_id, doctor_id, scheduled_start, scheduled_end, appointment_type,
            reason, notes, rescheduled_from_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          existing.patient_id, doctorId, start, end, existing.appointment_type,
          existing.reason, existing.notes, id, req.staff.id,
        ]
      );
      return r[0];
    });

    await audit({
      req, action: 'reschedule', entityType: 'appointments', entityId: id,
      description: `Rescheduled ${existing.patient_name} to ${start.toISOString()}`,
    });
    broadcastChange('appointments', { appointmentId: replacement.id });

    return ok(res, replacement);
  })
);

router.post(
  '/:id/cancel',
  requirePermission('appointments:write'),
  validate(
    z.object({
      reason: z.string().max(500).optional().nullable(),
      cancel_series: z.boolean().default(false),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'appointment id');

    const existing = await one('SELECT * FROM appointments WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Appointment');

    const cancelled = await transaction(async (client) => {
      const { rows: primary } = await client.query(
        `UPDATE appointments
            SET status = 'cancelled', cancelled_reason = $2
          WHERE id = $1 AND status NOT IN ('completed','cancelled')
          RETURNING *`,
        [id, req.body.reason ?? null]
      );

      let seriesCount = primary.length;

      if (req.body.cancel_series) {
        // Cancel future occurrences only; past ones are history.
        const parentId = existing.recurrence_parent_id ?? existing.id;
        const { rowCount } = await client.query(
          `UPDATE appointments
              SET status = 'cancelled', cancelled_reason = $2
            WHERE (id = $1 OR recurrence_parent_id = $1)
              AND scheduled_start >= now()
              AND status NOT IN ('completed','cancelled')`,
          [parentId, req.body.reason ?? 'Series cancelled']
        );
        seriesCount = rowCount;
      }

      return { appointment: primary[0] ?? existing, cancelled_count: seriesCount };
    });

    await audit({
      req, action: 'cancel', entityType: 'appointments', entityId: id,
      description: `Cancelled ${cancelled.cancelled_count} appointment(s)`,
    });
    broadcastChange('appointments', { appointmentId: id });

    return ok(res, cancelled);
  })
);

// --- Working hours ---------------------------------------------------------

router.get(
  '/availability/:doctorId',
  requirePermission('appointments:read'),
  asyncHandler(async (req, res) => {
    const doctorId = requireUuid(req.params.doctorId, 'doctor id');
    const list = await rows(
      'SELECT * FROM doctor_availability WHERE doctor_id = $1 ORDER BY day_of_week, start_time',
      [doctorId]
    );
    return ok(res, list);
  })
);

/** Replace a clinician's whole weekly schedule in one call. */
router.put(
  '/availability/:doctorId',
  requirePermission('appointments:write'),
  validate(
    z.object({
      windows: z
        .array(
          z.object({
            day_of_week: z.coerce.number().int().min(0).max(6),
            start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM'),
            end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM'),
            slot_minutes: z.coerce.number().int().min(5).max(240).default(30),
          })
        )
        .max(50),
    })
  ),
  asyncHandler(async (req, res) => {
    const doctorId = requireUuid(req.params.doctorId, 'doctor id');

    const saved = await transaction(async (client) => {
      await client.query('DELETE FROM doctor_availability WHERE doctor_id = $1', [doctorId]);

      const inserted = [];
      for (const w of req.body.windows) {
        if (w.end_time <= w.start_time) {
          throw badRequest(`Working hours on day ${w.day_of_week} end before they start.`);
        }
        const { rows: r } = await client.query(
          `INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time, slot_minutes)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [doctorId, w.day_of_week, w.start_time, w.end_time, w.slot_minutes]
        );
        inserted.push(r[0]);
      }
      return inserted;
    });

    await audit({
      req, action: 'update', entityType: 'doctor_availability', entityId: doctorId,
      description: `Set ${saved.length} availability window(s)`,
    });

    return ok(res, saved);
  })
);

export default router;
