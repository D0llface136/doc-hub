/**
 * In-world (LSL) bridge.
 *
 * Every route here requires the shared `X-Clinic-Key` header. Routes that act
 * on behalf of a person additionally require `X-Staff-Token`.
 *
 * Responses default to a compact pipe-delimited text format, because
 * llParseString2List is cheap in LSL while JSON parsing is not and a script's
 * memory is measured in kilobytes. Add `?format=json` to get the normal API
 * envelope instead.
 *
 * Text protocol
 *   Success: OK|<field>|<field>|...
 *   Failure: ERR|<code>|<message>
 * Literal pipes in any field are replaced with "/".
 *
 * POST /api/lsl/ping           connectivity + clinic name
 * POST /api/lsl/auth           sign in, returns a staff token
 * GET  /api/lsl/patient        look a patient up by avatar key
 * POST /api/lsl/checkin        kiosk check-in
 * GET  /api/lsl/queue          compact waiting-room summary
 * POST /api/lsl/vitals         record vitals from an exam table
 * POST /api/lsl/emergency      raise a code from a wall button
 * GET  /api/lsl/prescription   bottle rez payload
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { one, rows, query, transaction } from '../db/pool.js';
import { asyncHandler } from '../lib/http.js';
import { ApiError, unauthorized, notFound, badRequest } from '../lib/errors.js';
import { validate, z } from '../lib/validate.js';
import { audit, clientIp } from '../lib/audit.js';
import { requireLslKey, attachLslStaff, signToken } from '../middleware/auth.js';
import { hasPermission } from '../lib/permissions.js';
import { calculateBmi, classifyVitals } from '../lib/clinical.js';
import { broadcastChange, notifyAll } from '../lib/notify.js';
import { publish } from '../lib/events.js';
import { config } from '../config/env.js';

const router = Router();

/** Escape and join fields into the pipe-delimited text protocol. */
function textResponse(res, fields) {
  const line = fields.map((f) => String(f ?? '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ')).join('|');
  res.type('text/plain; charset=utf-8');
  return res.send(line);
}

/** Reply in whichever format the caller asked for. */
function reply(req, res, fields, json) {
  if (req.query.format === 'json') return res.json({ success: true, data: json ?? fields });
  return textResponse(res, ['OK', ...fields]);
}

/**
 * Error responses have to follow the text protocol too, otherwise an LSL
 * script sees a JSON blob it cannot parse and reports "unknown error".
 */
function lslErrorHandler(err, req, res, next) {
  if (req.query.format === 'json') return next(err);

  const status = err instanceof ApiError ? err.status : 500;
  const code = err instanceof ApiError ? err.code : 'INTERNAL_ERROR';
  const message = err instanceof ApiError ? err.message : 'Server error';

  if (status >= 500) console.error('[lsl] unhandled:', err.message);

  res.status(status).type('text/plain; charset=utf-8');
  return res.send(['ERR', code, message.replace(/\|/g, '/')].join('|'));
}

// In-world objects can misbehave (a looping timer, a copied HUD). Cap them.
const lslLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => req.get('x-sl-object-key') ?? clientIp(req) ?? 'unknown',
  handler: (_req, res) => {
    res.status(429).type('text/plain');
    res.send('ERR|RATE_LIMITED|Slow down - too many requests from this object');
  },
});

router.use(lslLimiter);
router.use(requireLslKey);
router.use(attachLslStaff);

/** Require an authenticated staff member with a given permission. */
function needStaff(permission) {
  return (req, _res, next) => {
    if (!req.staff) return next(unauthorized('This action needs an X-Staff-Token header.'));
    if (permission && !hasPermission(req.staff.permissions, permission)) {
      return next(new ApiError(403, 'FORBIDDEN', `${req.staff.role.name} cannot do that.`));
    }
    return next();
  };
}

// --- Connectivity ----------------------------------------------------------

router.post(
  '/ping',
  asyncHandler(async (req, res) => {
    const clinicName = await one("SELECT value FROM clinic_settings WHERE key = 'clinic.name'");
    const queue = await one(
      `SELECT count(*) FILTER (WHERE status = 'waiting')::int AS waiting,
              count(*) FILTER (WHERE status = 'waiting' AND priority = 'emergency')::int AS emergencies
         FROM patient_visits WHERE deleted_at IS NULL`
    );
    const active = await one(
      "SELECT count(*)::int AS count FROM emergency_events WHERE status IN ('active','acknowledged')"
    );

    return reply(
      req,
      res,
      [clinicName?.value ?? 'Clinic', queue.waiting, queue.emergencies, active.count, new Date().toISOString()],
      {
        clinic_name: clinicName?.value ?? 'Clinic',
        waiting: queue.waiting,
        emergency_waiting: queue.emergencies,
        active_codes: active.count,
        server_time: new Date().toISOString(),
      }
    );
  })
);

// --- Authentication --------------------------------------------------------

router.post(
  '/auth',
  validate(
    z.object({
      username: z.string().trim().min(1).max(60),
      password: z.string().min(1).max(200),
      avatar_key: z.string().uuid().optional(),
      avatar_name: z.string().max(120).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { username, password, avatar_key, avatar_name } = req.body;

    const staff = await one(
      `SELECT s.*, r.code AS role_code, r.name AS role_name
         FROM staff s JOIN staff_roles r ON r.id = s.role_id
        WHERE lower(s.username) = lower($1) AND s.deleted_at IS NULL`,
      [username]
    );

    const hash = staff?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
    const matches = await bcrypt.compare(password, hash);

    if (!staff || !matches) throw unauthorized('Incorrect username or password');
    if (staff.status !== 'active') throw unauthorized(`Account is ${staff.status}`);

    const { token, tokenId, expiresAt } = signToken(staff);

    await query(
      `INSERT INTO staff_sessions (staff_id, token_id, expires_at, ip_address, user_agent, source)
       VALUES ($1,$2,$3,$4,$5,'lsl')`,
      [staff.id, tokenId, expiresAt, clientIp(req), req.get('x-sl-object-name')?.slice(0, 300) ?? 'LSL object']
    );

    await query(
      `UPDATE staff SET last_login_at = now(), last_seen_at = now(), is_on_duty = true,
              sl_avatar_key = COALESCE($2, sl_avatar_key), sl_avatar_name = COALESCE($3, sl_avatar_name)
        WHERE id = $1`,
      [staff.id, avatar_key ?? null, avatar_name ?? null]
    );

    await audit({ req, action: 'login', entityType: 'staff', entityId: staff.id, description: `${staff.full_name} signed in from in-world` });
    publish('staff:signed_in', { staffId: staff.id, fullName: staff.full_name, role: staff.role_code });

    return reply(req, res, [token, staff.full_name, staff.role_code, expiresAt.toISOString()], {
      token,
      full_name: staff.full_name,
      role: staff.role_code,
      expires_at: expiresAt,
    });
  })
);

// --- Patient lookup --------------------------------------------------------

router.get(
  '/patient',
  needStaff('patients:read'),
  validate(z.object({ avatar_key: z.string().uuid().optional(), mrn: z.string().max(40).optional(), format: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { avatar_key, mrn } = req.validatedQuery;
    if (!avatar_key && !mrn) throw badRequest('Provide avatar_key or mrn');

    const patient = await one(
      `SELECT p.id, p.mrn, p.first_name, p.last_name, p.blood_type,
              CASE WHEN p.date_of_birth IS NULL THEN NULL
                   ELSE extract(year from age(p.date_of_birth))::int END AS age,
              (SELECT string_agg(a.substance, ', ') FROM patient_allergies a
                WHERE a.patient_id = p.id AND a.deleted_at IS NULL) AS allergies
         FROM patients p
        WHERE p.deleted_at IS NULL
          AND ($1::uuid IS NULL OR p.sl_avatar_key = $1)
          AND ($2::text IS NULL OR p.mrn = $2)
        LIMIT 1`,
      [avatar_key ?? null, mrn ?? null]
    );
    if (!patient) throw notFound('Patient');

    const visit = await one(
      `SELECT id, visit_number, status, queue_number, priority
         FROM patient_visits
        WHERE patient_id = $1 AND status IN ('waiting','being_seen') AND deleted_at IS NULL
        ORDER BY checked_in_at DESC LIMIT 1`,
      [patient.id]
    );

    return reply(
      req,
      res,
      [
        patient.id,
        patient.mrn,
        `${patient.first_name} ${patient.last_name}`,
        patient.age ?? '',
        patient.blood_type ?? 'unknown',
        patient.allergies ?? 'none',
        visit?.id ?? '',
        visit?.status ?? 'none',
        visit?.queue_number ?? '',
      ],
      { ...patient, active_visit: visit }
    );
  })
);

// --- Kiosk check-in --------------------------------------------------------

router.post(
  '/checkin',
  needStaff('visits:write'),
  validate(
    z.object({
      patient_id: z.string().uuid().optional(),
      avatar_key: z.string().uuid().optional(),
      first_name: z.string().max(80).optional(),
      last_name: z.string().max(80).optional(),
      avatar_name: z.string().max(120).optional(),
      chief_complaint: z.string().max(500).optional(),
      priority: z.enum(['normal', 'urgent', 'emergency']).default('normal'),
      visit_type: z.enum(['walk_in', 'scheduled', 'emergency']).default('walk_in'),
    })
  ),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const result = await transaction(async (client) => {
      let patientId = b.patient_id ?? null;

      // A kiosk usually knows only the avatar key, so resolve or register.
      if (!patientId && b.avatar_key) {
        const { rows: found } = await client.query(
          'SELECT id FROM patients WHERE sl_avatar_key = $1 AND deleted_at IS NULL',
          [b.avatar_key]
        );
        patientId = found[0]?.id ?? null;
      }

      if (!patientId) {
        if (!b.first_name || !b.last_name) {
          throw badRequest('New patient needs first_name and last_name');
        }
        const { rows: inserted } = await client.query(
          `INSERT INTO patients (first_name, last_name, sl_avatar_key, sl_avatar_name, registered_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [b.first_name, b.last_name, b.avatar_key ?? null, b.avatar_name ?? null, req.staff.id]
        );
        patientId = inserted[0].id;
      }

      const { rows: open } = await client.query(
        `SELECT id, visit_number, queue_number FROM patient_visits
          WHERE patient_id = $1 AND status IN ('waiting','being_seen') AND deleted_at IS NULL`,
        [patientId]
      );
      // Re-scanning an already-queued patient returns their existing slot
      // rather than erroring - a kiosk cannot usefully recover from a failure.
      if (open.length > 0) return { ...open[0], existing: true, patient_id: patientId };

      const { rows: visit } = await client.query(
        `INSERT INTO patient_visits
           (patient_id, visit_type, priority, chief_complaint, checked_in_by, status)
         VALUES ($1,$2,$3,$4,$5,'waiting')
         RETURNING id, visit_number, queue_number, priority`,
        [
          patientId, b.visit_type,
          b.visit_type === 'emergency' && b.priority === 'normal' ? 'emergency' : b.priority,
          b.chief_complaint ?? null, req.staff.id,
        ]
      );

      return { ...visit[0], existing: false, patient_id: patientId };
    });

    if (!result.existing) {
      await audit({ req, action: 'create', entityType: 'patient_visits', entityId: result.id, description: `In-world check-in, queue #${result.queue_number}` });
      broadcastChange('queue', { visitId: result.id });
    }

    const ahead = await one(
      `SELECT count(*)::int AS count FROM patient_visits
        WHERE status = 'waiting' AND deleted_at IS NULL AND queue_number < $1 AND queue_date = CURRENT_DATE`,
      [result.queue_number]
    );

    return reply(
      req,
      res,
      [result.id, result.visit_number, result.queue_number, ahead.count, result.existing ? '1' : '0'],
      { ...result, patients_ahead: ahead.count }
    );
  })
);

// --- Queue board -----------------------------------------------------------

router.get(
  '/queue',
  needStaff('visits:read'),
  validate(z.object({ limit: z.coerce.number().int().min(1).max(20).optional(), format: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const limit = req.validatedQuery.limit ?? 5;

    const list = await rows(
      `SELECT v.queue_number, v.priority,
              p.first_name || ' ' || left(p.last_name, 1) || '.' AS display_name,
              (extract(epoch from (now() - v.checked_in_at)) / 60)::int AS waiting_minutes,
              d.full_name AS doctor_name
         FROM patient_visits v
         JOIN patients p ON p.id = v.patient_id
         LEFT JOIN staff d ON d.id = v.assigned_doctor_id
        WHERE v.deleted_at IS NULL AND v.status = 'waiting'
        ORDER BY CASE v.priority WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, v.checked_in_at
        LIMIT $1`,
      [limit]
    );

    if (req.query.format === 'json') return res.json({ success: true, data: list });

    // One record per line so a board script can iterate with llList2String.
    const lines = list.map((entry) =>
      [entry.queue_number, entry.display_name, entry.priority, entry.waiting_minutes, entry.doctor_name ?? '-']
        .map((f) => String(f).replace(/\|/g, '/'))
        .join('|')
    );

    res.type('text/plain; charset=utf-8');
    return res.send(['OK', String(list.length), ...lines].join('\n'));
  })
);

// --- Exam table vitals -----------------------------------------------------

router.post(
  '/vitals',
  needStaff('vitals:write'),
  validate(
    z.object({
      visit_id: z.string().uuid(),
      temperature_c: z.coerce.number().min(20).max(46).optional(),
      bp_systolic: z.coerce.number().int().min(40).max(300).optional(),
      bp_diastolic: z.coerce.number().int().min(20).max(200).optional(),
      heart_rate: z.coerce.number().int().min(10).max(300).optional(),
      respiratory_rate: z.coerce.number().int().min(2).max(80).optional(),
      oxygen_saturation: z.coerce.number().int().min(0).max(100).optional(),
      blood_sugar_mgdl: z.coerce.number().int().min(10).max(1200).optional(),
      weight_kg: z.coerce.number().min(0.5).max(700).optional(),
      height_cm: z.coerce.number().min(20).max(300).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const visit = await one('SELECT id, patient_id, visit_number FROM patient_visits WHERE id = $1 AND deleted_at IS NULL', [b.visit_id]);
    if (!visit) throw notFound('Visit');

    const patient = await one('SELECT height_cm, weight_kg FROM patients WHERE id = $1', [visit.patient_id]);
    const heightCm = b.height_cm ?? patient?.height_cm ?? null;
    const weightKg = b.weight_kg ?? patient?.weight_kg ?? null;
    const bmi = calculateBmi(weightKg, heightCm);

    const record = await one(
      `INSERT INTO vitals
         (visit_id, patient_id, recorded_by, temperature_c, bp_systolic, bp_diastolic,
          heart_rate, respiratory_rate, oxygen_saturation, blood_sugar_mgdl,
          weight_kg, height_cm, bmi)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        b.visit_id, visit.patient_id, req.staff.id, b.temperature_c ?? null,
        b.bp_systolic ?? null, b.bp_diastolic ?? null, b.heart_rate ?? null,
        b.respiratory_rate ?? null, b.oxygen_saturation ?? null,
        b.blood_sugar_mgdl ?? null, weightKg, heightCm, bmi,
      ]
    );

    const flags = classifyVitals(record);
    const worst = Object.values(flags).includes('red') ? 'red' : Object.values(flags).includes('yellow') ? 'yellow' : 'green';

    await audit({ req, action: 'create', entityType: 'vitals', entityId: record.id, description: `In-world vitals for ${visit.visit_number}` });

    return reply(req, res, [record.id, bmi ?? '', worst, Object.keys(flags).filter((k) => flags[k] === 'red').join(',')], {
      ...record,
      flags,
      overall: worst,
    });
  })
);

// --- Wall-mounted emergency button -----------------------------------------

router.post(
  '/emergency',
  needStaff('emergency:activate'),
  validate(
    z.object({
      code_type: z.enum(['code_blue', 'code_red', 'code_black', 'trauma', 'mass_casualty', 'lockdown']),
      location: z.string().max(200).optional(),
      description: z.string().max(500).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const event = await one(
      `INSERT INTO emergency_events (code_type, location, description, activated_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [b.code_type, b.location ?? req.lslClient?.region ?? null, b.description ?? null, req.staff.id]
    );

    const label = b.code_type.replace('_', ' ').toUpperCase();

    publish('emergency:activated', {
      id: event.id,
      code_type: event.code_type,
      label,
      location: event.location,
      description: event.description,
      activated_by: req.staff.full_name,
      activated_at: event.activated_at,
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

    await audit({ req, action: 'activate', entityType: 'emergency_events', entityId: event.id, description: `In-world ${label}` });

    return reply(req, res, [event.id, label, event.activated_at.toISOString()], event);
  })
);

// --- Prescription bottle ---------------------------------------------------

router.get(
  '/prescription',
  needStaff('prescriptions:read'),
  validate(z.object({ id: z.string().uuid(), format: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const rx = await one(
      `SELECT rx.*, pt.first_name, pt.last_name, s.full_name AS prescriber_name
         FROM prescriptions rx
         JOIN patients pt ON pt.id = rx.patient_id
         LEFT JOIN staff s ON s.id = rx.prescribed_by
        WHERE rx.id = $1 AND rx.deleted_at IS NULL`,
      [req.validatedQuery.id]
    );
    if (!rx) throw notFound('Prescription');

    const instructions = rx.instructions ?? `Take ${rx.dosage} ${rx.frequency}.`;

    return reply(
      req,
      res,
      [
        rx.id,
        `${rx.first_name} ${rx.last_name}`,
        rx.medication_name,
        rx.dosage,
        rx.frequency,
        rx.duration ?? '',
        rx.quantity,
        instructions,
        rx.prescriber_name ?? '',
        `${config.publicBaseUrl}/#/prescriptions/${rx.id}`,
      ],
      { ...rx, instructions }
    );
  })
);

router.use(lslErrorHandler);

export default router;
