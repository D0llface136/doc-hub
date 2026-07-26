/**
 * Visits: check-in, the current encounter, and everything recorded during it.
 *
 * POST   /api/visits/checkin           check a patient in (creates them if new)
 * GET    /api/visits                   list / filter visits
 * GET    /api/visits/:id               the full encounter
 * PATCH  /api/visits/:id               update status, assignment, complaint
 * GET|POST  /api/visits/:id/notes      clinical notes
 * GET|POST  /api/visits/:id/vitals     vitals for this encounter
 * GET|PUT   /api/visits/:id/symptoms   symptom checklist (PUT replaces the set)
 * GET|PUT   /api/visits/:id/exam       physical examination
 * GET|POST  /api/visits/:id/diagnoses  diagnoses
 * DELETE    /api/visits/:id/diagnoses/:dxId
 * GET|POST  /api/visits/:id/treatments treatment plan
 * PATCH     /api/visits/:id/treatments/:treatmentId
 * POST      /api/visits/:id/discharge  discharge the patient
 */
import { Router } from 'express';
import { one, rows, query, transaction } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { validate, z, text, optionalIsoDate, listQuery } from '../lib/validate.js';
import { audit, diffChanges } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { broadcastChange, notifyStaff } from '../lib/notify.js';
import { calculateBmi, classifyVitals } from '../lib/clinical.js';

const router = Router();
router.use(requireAuth);

/** Load a visit or 404. Returns the raw row. */
async function loadVisit(id) {
  const visit = await one('SELECT * FROM patient_visits WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!visit) throw notFound('Visit');
  return visit;
}

// --- Check-in --------------------------------------------------------------

const checkinSchema = z
  .object({
    // Either an existing patient...
    patient_id: z.string().uuid().optional(),
    // ...or enough detail to register one on the spot.
    patient: z
      .object({
        first_name: text(80, 'First name'),
        last_name: text(80, 'Last name'),
        date_of_birth: optionalIsoDate,
        gender: z.enum(['male', 'female', 'non_binary', 'other', 'undisclosed']).optional().nullable(),
        blood_type: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']).optional().nullable(),
        phone_number: z.string().max(40).optional().nullable(),
        sl_avatar_key: z.string().uuid().optional().nullable(),
        sl_avatar_name: z.string().max(120).optional().nullable(),
        emergency_contact_name: z.string().max(120).optional().nullable(),
        emergency_contact_phone: z.string().max(40).optional().nullable(),
        insurance_provider: z.string().max(120).optional().nullable(),
        insurance_number: z.string().max(60).optional().nullable(),
      })
      .optional(),

    visit_type: z.enum(['walk_in', 'scheduled', 'emergency', 'follow_up', 'telehealth']).default('walk_in'),
    priority: z.enum(['normal', 'urgent', 'emergency']).default('normal'),
    chief_complaint: z.string().max(1000).optional().nullable(),
    appointment_id: z.string().uuid().optional().nullable(),
    assigned_doctor_id: z.string().uuid().optional().nullable(),
    estimated_wait_minutes: z.coerce.number().int().min(0).max(600).optional().nullable(),
  })
  .refine((data) => data.patient_id || data.patient, {
    message: 'Provide either patient_id for an existing patient, or patient details to register a new one',
    path: ['patient_id'],
  });

router.post(
  '/checkin',
  requirePermission('visits:write'),
  validate(checkinSchema),
  asyncHandler(async (req, res) => {
    const body = req.body;

    const result = await transaction(async (client) => {
      let patientId = body.patient_id;

      if (!patientId) {
        const p = body.patient;
        const { rows: inserted } = await client.query(
          `INSERT INTO patients
             (first_name, last_name, date_of_birth, gender, blood_type, phone_number,
              sl_avatar_key, sl_avatar_name, registered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, mrn, first_name, last_name`,
          [
            p.first_name, p.last_name, p.date_of_birth ?? null, p.gender ?? null,
            p.blood_type ?? null, p.phone_number ?? null, p.sl_avatar_key ?? null,
            p.sl_avatar_name ?? null, req.staff.id,
          ]
        );
        patientId = inserted[0].id;

        if (p.emergency_contact_name) {
          await client.query(
            `INSERT INTO emergency_contacts (patient_id, full_name, phone_number, is_primary)
             VALUES ($1,$2,$3,true)`,
            [patientId, p.emergency_contact_name, p.emergency_contact_phone ?? null]
          );
        }

        if (p.insurance_number) {
          await client.query(
            `INSERT INTO patient_insurance (patient_id, provider_name, policy_number)
             VALUES ($1,$2,$3)`,
            [patientId, p.insurance_provider ?? null, p.insurance_number]
          );
        }
      } else {
        const { rows: found } = await client.query(
          'SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL',
          [patientId]
        );
        if (found.length === 0) throw notFound('Patient');

        // A patient can only hold one open visit at a time; otherwise the queue
        // shows duplicates and notes land on the wrong encounter.
        const { rows: open } = await client.query(
          `SELECT id, visit_number FROM patient_visits
            WHERE patient_id = $1 AND status IN ('waiting','being_seen') AND deleted_at IS NULL`,
          [patientId]
        );
        if (open.length > 0) {
          throw conflict(`This patient is already checked in (visit ${open[0].visit_number}).`);
        }
      }

      const { rows: visitRows } = await client.query(
        `INSERT INTO patient_visits
           (patient_id, appointment_id, visit_type, priority, chief_complaint,
            assigned_doctor_id, estimated_wait_minutes, checked_in_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'waiting')
         RETURNING *`,
        [
          patientId,
          body.appointment_id ?? null,
          body.visit_type,
          // An emergency visit type implies emergency priority even if the
          // receptionist left the priority dropdown alone.
          body.visit_type === 'emergency' && body.priority === 'normal' ? 'emergency' : body.priority,
          body.chief_complaint ?? null,
          body.assigned_doctor_id ?? null,
          body.estimated_wait_minutes ?? null,
          req.staff.id,
        ]
      );

      if (body.appointment_id) {
        await client.query("UPDATE appointments SET status = 'checked_in' WHERE id = $1", [body.appointment_id]);
      }

      const { rows: full } = await client.query(
        `SELECT v.*, p.mrn, p.first_name, p.last_name,
                p.first_name || ' ' || p.last_name AS patient_name
           FROM patient_visits v JOIN patients p ON p.id = v.patient_id
          WHERE v.id = $1`,
        [visitRows[0].id]
      );

      return full[0];
    });

    await audit({
      req, action: 'create', entityType: 'patient_visits', entityId: result.id,
      description: `Checked in ${result.patient_name} as queue #${result.queue_number} (${result.priority})`,
    });

    broadcastChange('queue', { visitId: result.id, priority: result.priority });

    if (result.assigned_doctor_id) {
      await notifyStaff({
        staffId: result.assigned_doctor_id,
        type: 'queue',
        title: 'Patient assigned to you',
        body: `${result.patient_name} - queue #${result.queue_number}`,
        link: `#/visits/${result.id}`,
        entityType: 'patient_visits',
        entityId: result.id,
      });
    }

    return created(res, result);
  })
);

// --- List / read -----------------------------------------------------------

router.get(
  '/',
  requirePermission('visits:read'),
  validate(
    listQuery.extend({
      status: z.string().max(20).optional(),
      priority: z.string().max(20).optional(),
      doctor_id: z.string().uuid().optional(),
      patient_id: z.string().uuid().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req);
    const q = req.validatedQuery;

    const filters = ['v.deleted_at IS NULL'];
    const params = [];

    /**
     * Push one parameter and add a filter built from its placeholder number.
     * `build` receives the placeholder (e.g. "$3") so a value can be reused in
     * several columns of the same condition.
     */
    const addFilter = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.status) addFilter(q.status, (p) => `v.status = ${p}`);
    if (q.priority) addFilter(q.priority, (p) => `v.priority = ${p}`);
    if (q.doctor_id) addFilter(q.doctor_id, (p) => `v.assigned_doctor_id = ${p}`);
    if (q.patient_id) addFilter(q.patient_id, (p) => `v.patient_id = ${p}`);
    if (q.date) addFilter(q.date, (p) => `v.checked_in_at::date = ${p}::date`);
    if (q.search) {
      addFilter(
        `%${q.search}%`,
        (p) => `((p.first_name || ' ' || p.last_name) ILIKE ${p} OR p.mrn ILIKE ${p} OR v.visit_number ILIKE ${p})`
      );
    }

    const where = filters.join(' AND ');

    const { count } = await one(
      `SELECT count(*)::int AS count FROM patient_visits v JOIN patients p ON p.id = v.patient_id WHERE ${where}`,
      params
    );

    const list = await rows(
      `SELECT v.*, p.mrn, p.first_name, p.last_name,
              p.first_name || ' ' || p.last_name AS patient_name,
              d.full_name AS doctor_name, n.full_name AS nurse_name
         FROM patient_visits v
         JOIN patients p ON p.id = v.patient_id
         LEFT JOIN staff d ON d.id = v.assigned_doctor_id
         LEFT JOIN staff n ON n.id = v.assigned_nurse_id
        WHERE ${where}
        ORDER BY v.checked_in_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

router.get(
  '/:id',
  requirePermission('visits:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');

    const visit = await one(
      `SELECT v.*, p.mrn, p.first_name, p.last_name,
              p.first_name || ' ' || p.last_name AS patient_name,
              p.date_of_birth, p.gender, p.blood_type, p.phone_number,
              CASE WHEN p.date_of_birth IS NULL THEN NULL
                   ELSE extract(year from age(p.date_of_birth))::int END AS patient_age,
              d.full_name AS doctor_name, n.full_name AS nurse_name,
              c.full_name AS checked_in_by_name
         FROM patient_visits v
         JOIN patients p ON p.id = v.patient_id
         LEFT JOIN staff d ON d.id = v.assigned_doctor_id
         LEFT JOIN staff n ON n.id = v.assigned_nurse_id
         LEFT JOIN staff c ON c.id = v.checked_in_by
        WHERE v.id = $1 AND v.deleted_at IS NULL`,
      [id]
    );
    if (!visit) throw notFound('Visit');

    const [notes, vitalsList, symptoms, exam, diagnoses, treatments, prescriptions, labs, imaging, allergies, discharge, invoice] =
      await Promise.all([
        rows(
          `SELECT vn.*, s.full_name AS author_name
             FROM visit_notes vn LEFT JOIN staff s ON s.id = vn.author_id
            WHERE vn.visit_id = $1 AND vn.deleted_at IS NULL
            ORDER BY vn.is_pinned DESC, vn.created_at DESC`,
          [id]
        ),
        rows(
          `SELECT v.*, s.full_name AS recorded_by_name
             FROM vitals v LEFT JOIN staff s ON s.id = v.recorded_by
            WHERE v.visit_id = $1 AND v.deleted_at IS NULL
            ORDER BY v.recorded_at DESC`,
          [id]
        ),
        rows(
          `SELECT vs.*, sym.name AS symptom_name, sym.category
             FROM visit_symptoms vs LEFT JOIN symptoms sym ON sym.id = vs.symptom_id
            WHERE vs.visit_id = $1
            ORDER BY vs.created_at`,
          [id]
        ),
        one(
          `SELECT pe.*, s.full_name AS examiner_name
             FROM physical_exams pe LEFT JOIN staff s ON s.id = pe.examiner_id
            WHERE pe.visit_id = $1 AND pe.deleted_at IS NULL
            ORDER BY pe.created_at DESC LIMIT 1`,
          [id]
        ),
        rows(
          `SELECT vd.*, dx.name AS diagnosis_name, dx.code AS diagnosis_code,
                  dx.category, s.full_name AS diagnosed_by_name
             FROM visit_diagnoses vd
             LEFT JOIN diagnoses dx ON dx.id = vd.diagnosis_id
             LEFT JOIN staff s ON s.id = vd.diagnosed_by
            WHERE vd.visit_id = $1
            ORDER BY vd.is_primary DESC, vd.diagnosed_at`,
          [id]
        ),
        rows(
          `SELECT t.*, s.full_name AS ordered_by_name
             FROM treatments t LEFT JOIN staff s ON s.id = t.ordered_by
            WHERE t.visit_id = $1 AND t.deleted_at IS NULL
            ORDER BY t.ordered_at`,
          [id]
        ),
        rows(
          `SELECT rx.*, s.full_name AS prescriber_name,
                  pq.status AS pharmacy_status
             FROM prescriptions rx
             LEFT JOIN staff s ON s.id = rx.prescribed_by
             LEFT JOIN pharmacy_queue pq ON pq.prescription_id = rx.id
            WHERE rx.visit_id = $1 AND rx.deleted_at IS NULL
            ORDER BY rx.prescribed_at`,
          [id]
        ),
        rows(
          `SELECT lo.*, s.full_name AS ordered_by_name,
                  (SELECT json_agg(row_to_json(lr) ORDER BY lr.resulted_at)
                     FROM laboratory_results lr WHERE lr.order_id = lo.id) AS results
             FROM laboratory_orders lo LEFT JOIN staff s ON s.id = lo.ordered_by
            WHERE lo.visit_id = $1 AND lo.deleted_at IS NULL
            ORDER BY lo.ordered_at`,
          [id]
        ),
        rows(
          `SELECT ro.*, s.full_name AS ordered_by_name,
                  (SELECT json_agg(row_to_json(a)) FROM attachments a
                    WHERE a.entity_type = 'radiology_order' AND a.entity_id = ro.id
                      AND a.deleted_at IS NULL) AS images
             FROM radiology_orders ro LEFT JOIN staff s ON s.id = ro.ordered_by
            WHERE ro.visit_id = $1 AND ro.deleted_at IS NULL
            ORDER BY ro.ordered_at`,
          [id]
        ),
        rows('SELECT * FROM patient_allergies WHERE patient_id = $1 AND deleted_at IS NULL', [visit.patient_id]),
        one('SELECT * FROM discharge_records WHERE visit_id = $1 ORDER BY discharged_at DESC LIMIT 1', [id]),
        one('SELECT * FROM invoices WHERE visit_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1', [id]),
      ]);

    // Flag any vitals outside normal range so the UI can colour them without
    // duplicating the thresholds in JavaScript.
    const vitalsWithFlags = vitalsList.map((v) => ({ ...v, flags: classifyVitals(v) }));

    return ok(res, {
      visit,
      allergies,
      notes,
      vitals: vitalsWithFlags,
      symptoms,
      physical_exam: exam,
      diagnoses,
      treatments,
      prescriptions,
      laboratory: labs,
      radiology: imaging,
      discharge,
      invoice,
    });
  })
);

const updateVisitSchema = z.object({
  status: z.enum(['waiting', 'being_seen', 'completed', 'admitted', 'discharged', 'no_show', 'cancelled']).optional(),
  priority: z.enum(['normal', 'urgent', 'emergency']).optional(),
  chief_complaint: z.string().max(1000).optional().nullable(),
  pain_scale: z.coerce.number().int().min(0).max(10).optional().nullable(),
  assigned_doctor_id: z.string().uuid().optional().nullable(),
  assigned_nurse_id: z.string().uuid().optional().nullable(),
  estimated_wait_minutes: z.coerce.number().int().min(0).max(600).optional().nullable(),
  disposition: z.enum(['discharged', 'admitted', 'transferred', 'ama', 'deceased', 'referred']).optional().nullable(),
});

router.patch(
  '/:id',
  requirePermission('visits:write'),
  validate(updateVisitSchema),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const existing = await loadVisit(id);
    const body = req.body;

    const updated = await one(
      `UPDATE patient_visits SET
         status                 = COALESCE($2, status),
         priority               = COALESCE($3, priority),
         chief_complaint        = COALESCE($4, chief_complaint),
         pain_scale             = COALESCE($5, pain_scale),
         assigned_doctor_id     = COALESCE($6, assigned_doctor_id),
         assigned_nurse_id      = COALESCE($7, assigned_nurse_id),
         estimated_wait_minutes = COALESCE($8, estimated_wait_minutes),
         disposition            = COALESCE($9, disposition),
         -- Stamp the lifecycle timestamps the first time each status is seen.
         seen_at      = CASE WHEN $2 = 'being_seen' AND seen_at IS NULL THEN now() ELSE seen_at END,
         completed_at = CASE WHEN $2 IN ('completed','discharged') AND completed_at IS NULL THEN now() ELSE completed_at END
       WHERE id = $1
       RETURNING *`,
      [
        id, body.status ?? null, body.priority ?? null, body.chief_complaint ?? null,
        body.pain_scale ?? null, body.assigned_doctor_id ?? null, body.assigned_nurse_id ?? null,
        body.estimated_wait_minutes ?? null, body.disposition ?? null,
      ]
    );

    await audit({
      req, action: 'update', entityType: 'patient_visits', entityId: id,
      changes: diffChanges(existing, updated),
      description: `Updated visit ${existing.visit_number}`,
    });

    if (body.status || body.priority || body.assigned_doctor_id) broadcastChange('queue', { visitId: id });

    return ok(res, updated);
  })
);

// --- Notes -----------------------------------------------------------------

router.get(
  '/:id/notes',
  requirePermission('records:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const list = await rows(
      `SELECT n.*, s.full_name AS author_name, s.display_title AS author_title
         FROM visit_notes n LEFT JOIN staff s ON s.id = n.author_id
        WHERE n.visit_id = $1 AND n.deleted_at IS NULL
        ORDER BY n.is_pinned DESC, n.created_at DESC`,
      [id]
    );
    return ok(res, list);
  })
);

router.post(
  '/:id/notes',
  requirePermission('records:write'),
  validate(
    z.object({
      note_type: z.enum(['progress', 'physician', 'nursing', 'triage', 'procedure', 'discharge', 'addendum', 'general']).default('progress'),
      body: text(20000, 'Note'),
      is_pinned: z.boolean().default(false),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    await loadVisit(id);

    const note = await one(
      `INSERT INTO visit_notes (visit_id, author_id, note_type, body, is_pinned)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, req.staff.id, req.body.note_type, req.body.body, req.body.is_pinned]
    );

    await audit({
      req, action: 'create', entityType: 'visit_notes', entityId: note.id,
      description: `Added ${req.body.note_type} note`,
    });

    return created(res, { ...note, author_name: req.staff.full_name });
  })
);

// --- Vitals ----------------------------------------------------------------

const vitalsSchema = z.object({
  temperature_c: z.coerce.number().min(20).max(46).optional().nullable(),
  bp_systolic: z.coerce.number().int().min(40).max(300).optional().nullable(),
  bp_diastolic: z.coerce.number().int().min(20).max(200).optional().nullable(),
  heart_rate: z.coerce.number().int().min(10).max(300).optional().nullable(),
  respiratory_rate: z.coerce.number().int().min(2).max(80).optional().nullable(),
  oxygen_saturation: z.coerce.number().int().min(0).max(100).optional().nullable(),
  blood_sugar_mgdl: z.coerce.number().int().min(10).max(1200).optional().nullable(),
  weight_kg: z.coerce.number().min(0.5).max(700).optional().nullable(),
  height_cm: z.coerce.number().min(20).max(300).optional().nullable(),
  pain_scale: z.coerce.number().int().min(0).max(10).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

router.get(
  '/:id/vitals',
  requirePermission('vitals:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const list = await rows(
      `SELECT v.*, s.full_name AS recorded_by_name
         FROM vitals v LEFT JOIN staff s ON s.id = v.recorded_by
        WHERE v.visit_id = $1 AND v.deleted_at IS NULL
        ORDER BY v.recorded_at DESC`,
      [id]
    );
    return ok(res, list.map((v) => ({ ...v, flags: classifyVitals(v) })));
  })
);

router.post(
  '/:id/vitals',
  requirePermission('vitals:write'),
  validate(vitalsSchema),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const visit = await loadVisit(id);
    const body = req.body;

    // Fall back to the patient's recorded height so BMI still works when the
    // nurse only enters a weight.
    const patient = await one('SELECT height_cm, weight_kg FROM patients WHERE id = $1', [visit.patient_id]);
    const heightCm = body.height_cm ?? patient?.height_cm ?? null;
    const weightKg = body.weight_kg ?? patient?.weight_kg ?? null;
    const bmi = calculateBmi(weightKg, heightCm);

    const record = await one(
      `INSERT INTO vitals
         (visit_id, patient_id, recorded_by, temperature_c, bp_systolic, bp_diastolic,
          heart_rate, respiratory_rate, oxygen_saturation, blood_sugar_mgdl,
          weight_kg, height_cm, bmi, pain_scale, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        id, visit.patient_id, req.staff.id, body.temperature_c ?? null,
        body.bp_systolic ?? null, body.bp_diastolic ?? null, body.heart_rate ?? null,
        body.respiratory_rate ?? null, body.oxygen_saturation ?? null,
        body.blood_sugar_mgdl ?? null, weightKg, heightCm, bmi,
        body.pain_scale ?? null, body.notes ?? null,
      ]
    );

    // Keep the patient's standing height/weight current.
    if (body.height_cm || body.weight_kg) {
      await query(
        'UPDATE patients SET height_cm = COALESCE($2, height_cm), weight_kg = COALESCE($3, weight_kg) WHERE id = $1',
        [visit.patient_id, body.height_cm ?? null, body.weight_kg ?? null]
      );
    }

    const flags = classifyVitals(record);

    await audit({
      req, action: 'create', entityType: 'vitals', entityId: record.id,
      description: `Recorded vitals for visit ${visit.visit_number}`,
    });

    // A critical reading should reach the assigned doctor without them having
    // to be looking at the chart.
    const critical = Object.entries(flags).filter(([, level]) => level === 'red');
    if (critical.length > 0 && visit.assigned_doctor_id) {
      await notifyStaff({
        staffId: visit.assigned_doctor_id,
        type: 'warning',
        title: 'Critical vitals recorded',
        body: `Visit ${visit.visit_number}: ${critical.map(([field]) => field).join(', ')}`,
        link: `#/visits/${id}`,
        entityType: 'vitals',
        entityId: record.id,
      });
    }

    return created(res, { ...record, flags });
  })
);

// --- Symptoms --------------------------------------------------------------

router.get(
  '/:id/symptoms',
  requirePermission('records:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const list = await rows(
      `SELECT vs.*, s.name AS symptom_name, s.category
         FROM visit_symptoms vs LEFT JOIN symptoms s ON s.id = vs.symptom_id
        WHERE vs.visit_id = $1 ORDER BY vs.created_at`,
      [id]
    );
    return ok(res, list);
  })
);

/**
 * Replace the whole symptom set for the visit. The checklist UI submits its
 * complete state, so a PUT is the honest verb - unchecking a box has to remove
 * the row, which a POST-per-symptom cannot express.
 */
router.put(
  '/:id/symptoms',
  requirePermission('records:write'),
  validate(
    z.object({
      symptoms: z
        .array(
          z.object({
            symptom_id: z.string().uuid().optional().nullable(),
            custom_name: z.string().max(160).optional().nullable(),
            severity: z.enum(['mild', 'moderate', 'severe']).optional().nullable(),
            duration: z.string().max(80).optional().nullable(),
            notes: z.string().max(500).optional().nullable(),
          })
        )
        .max(100),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    await loadVisit(id);

    const saved = await transaction(async (client) => {
      await client.query('DELETE FROM visit_symptoms WHERE visit_id = $1', [id]);

      const inserted = [];
      for (const symptom of req.body.symptoms) {
        if (!symptom.symptom_id && !symptom.custom_name) continue;
        const { rows: r } = await client.query(
          `INSERT INTO visit_symptoms (visit_id, symptom_id, custom_name, severity, duration, notes, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            id, symptom.symptom_id ?? null, symptom.custom_name ?? null,
            symptom.severity ?? null, symptom.duration ?? null, symptom.notes ?? null, req.staff.id,
          ]
        );
        inserted.push(r[0]);
      }
      return inserted;
    });

    await audit({
      req, action: 'update', entityType: 'visit_symptoms', entityId: id,
      description: `Recorded ${saved.length} symptom(s)`,
    });

    return ok(res, saved);
  })
);

// --- Physical examination --------------------------------------------------

const examSchema = z.object({
  general_appearance: z.string().max(4000).optional().nullable(),
  heent: z.string().max(4000).optional().nullable(),
  cardiovascular: z.string().max(4000).optional().nullable(),
  respiratory: z.string().max(4000).optional().nullable(),
  abdomen: z.string().max(4000).optional().nullable(),
  neurological: z.string().max(4000).optional().nullable(),
  skin: z.string().max(4000).optional().nullable(),
  musculoskeletal: z.string().max(4000).optional().nullable(),
  additional_notes: z.string().max(8000).optional().nullable(),
});

router.get(
  '/:id/exam',
  requirePermission('records:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const exam = await one(
      `SELECT pe.*, s.full_name AS examiner_name
         FROM physical_exams pe LEFT JOIN staff s ON s.id = pe.examiner_id
        WHERE pe.visit_id = $1 AND pe.deleted_at IS NULL
        ORDER BY pe.created_at DESC LIMIT 1`,
      [id]
    );
    return ok(res, exam);
  })
);

/** Upsert: one examination per visit, edited in place as the clinician works. */
router.put(
  '/:id/exam',
  requirePermission('records:write'),
  validate(examSchema),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    await loadVisit(id);
    const b = req.body;

    const existing = await one(
      'SELECT id FROM physical_exams WHERE visit_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [id]
    );

    const values = [
      b.general_appearance ?? null, b.heent ?? null, b.cardiovascular ?? null,
      b.respiratory ?? null, b.abdomen ?? null, b.neurological ?? null,
      b.skin ?? null, b.musculoskeletal ?? null, b.additional_notes ?? null,
    ];

    const exam = existing
      ? await one(
          `UPDATE physical_exams SET
             general_appearance = $2, heent = $3, cardiovascular = $4, respiratory = $5,
             abdomen = $6, neurological = $7, skin = $8, musculoskeletal = $9,
             additional_notes = $10, examiner_id = $11
           WHERE id = $1 RETURNING *`,
          [existing.id, ...values, req.staff.id]
        )
      : await one(
          `INSERT INTO physical_exams
             (visit_id, general_appearance, heent, cardiovascular, respiratory,
              abdomen, neurological, skin, musculoskeletal, additional_notes, examiner_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [id, ...values, req.staff.id]
        );

    await audit({
      req, action: existing ? 'update' : 'create', entityType: 'physical_exams', entityId: exam.id,
      description: 'Recorded physical examination',
    });

    return ok(res, exam);
  })
);

// --- Diagnoses -------------------------------------------------------------

router.get(
  '/:id/diagnoses',
  requirePermission('records:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const list = await rows(
      `SELECT vd.*, dx.name AS diagnosis_name, dx.code AS diagnosis_code, dx.category,
              s.full_name AS diagnosed_by_name
         FROM visit_diagnoses vd
         LEFT JOIN diagnoses dx ON dx.id = vd.diagnosis_id
         LEFT JOIN staff s ON s.id = vd.diagnosed_by
        WHERE vd.visit_id = $1
        ORDER BY vd.is_primary DESC, vd.diagnosed_at`,
      [id]
    );
    return ok(res, list);
  })
);

router.post(
  '/:id/diagnoses',
  requirePermission('diagnoses:write'),
  validate(
    z
      .object({
        diagnosis_id: z.string().uuid().optional().nullable(),
        custom_name: z.string().max(200).optional().nullable(),
        is_primary: z.boolean().default(false),
        certainty: z.enum(['suspected', 'probable', 'confirmed', 'ruled_out']).default('confirmed'),
        notes: z.string().max(2000).optional().nullable(),
        // When a custom diagnosis proves useful, add it to the library so the
        // next clinician can pick it from the list.
        add_to_library: z.boolean().default(false),
      })
      .refine((d) => d.diagnosis_id || d.custom_name, {
        message: 'Choose a diagnosis from the library or enter a custom one',
        path: ['diagnosis_id'],
      })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const visit = await loadVisit(id);
    const b = req.body;

    const record = await transaction(async (client) => {
      let diagnosisId = b.diagnosis_id ?? null;

      if (!diagnosisId && b.custom_name && b.add_to_library) {
        const { rows: libRows } = await client.query(
          `INSERT INTO diagnoses (name, category, created_by, is_common)
           VALUES ($1, 'custom', $2, false)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [b.custom_name, req.staff.id]
        );
        diagnosisId = libRows[0]?.id ?? null;
      }

      // Only one primary diagnosis per visit.
      if (b.is_primary) {
        await client.query('UPDATE visit_diagnoses SET is_primary = false WHERE visit_id = $1', [id]);
      }

      const { rows: r } = await client.query(
        `INSERT INTO visit_diagnoses
           (visit_id, diagnosis_id, custom_name, is_primary, certainty, notes, diagnosed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, diagnosisId, diagnosisId ? null : b.custom_name, b.is_primary, b.certainty, b.notes ?? null, req.staff.id]
      );
      return r[0];
    });

    await audit({
      req, action: 'create', entityType: 'visit_diagnoses', entityId: record.id,
      description: `Diagnosed on visit ${visit.visit_number}`,
    });

    return created(res, record);
  })
);

router.delete(
  '/:id/diagnoses/:dxId',
  requirePermission('diagnoses:write'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const dxId = requireUuid(req.params.dxId, 'diagnosis id');

    const removed = await one('DELETE FROM visit_diagnoses WHERE id = $1 AND visit_id = $2 RETURNING id', [dxId, id]);
    if (!removed) throw notFound('Diagnosis');

    await audit({ req, action: 'delete', entityType: 'visit_diagnoses', entityId: dxId, description: 'Removed diagnosis' });
    return ok(res, { removed: true });
  })
);

// --- Treatment plan --------------------------------------------------------

router.get(
  '/:id/treatments',
  requirePermission('records:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const list = await rows(
      `SELECT t.*, s.full_name AS ordered_by_name
         FROM treatments t LEFT JOIN staff s ON s.id = t.ordered_by
        WHERE t.visit_id = $1 AND t.deleted_at IS NULL ORDER BY t.ordered_at`,
      [id]
    );
    return ok(res, list);
  })
);

router.post(
  '/:id/treatments',
  requirePermission('treatments:write'),
  validate(
    z.object({
      treatment_type: z.enum([
        'observation', 'medication', 'referral', 'physical_therapy',
        'laboratory', 'imaging', 'admission', 'procedure', 'counseling', 'other',
      ]),
      description: z.string().max(2000).optional().nullable(),
      physician_notes: z.string().max(8000).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    await loadVisit(id);

    const record = await one(
      `INSERT INTO treatments (visit_id, treatment_type, description, physician_notes, ordered_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, req.body.treatment_type, req.body.description ?? null, req.body.physician_notes ?? null, req.staff.id]
    );

    await audit({
      req, action: 'create', entityType: 'treatments', entityId: record.id,
      description: `Added ${req.body.treatment_type} to treatment plan`,
    });

    return created(res, record);
  })
);

router.patch(
  '/:id/treatments/:treatmentId',
  requirePermission('treatments:write'),
  validate(
    z.object({
      status: z.enum(['planned', 'in_progress', 'completed', 'cancelled']).optional(),
      description: z.string().max(2000).optional().nullable(),
      physician_notes: z.string().max(8000).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const treatmentId = requireUuid(req.params.treatmentId, 'treatment id');

    const updated = await one(
      `UPDATE treatments SET
         status          = COALESCE($3, status),
         description     = COALESCE($4, description),
         physician_notes = COALESCE($5, physician_notes),
         completed_at    = CASE WHEN $3 = 'completed' AND completed_at IS NULL THEN now() ELSE completed_at END
       WHERE id = $1 AND visit_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [treatmentId, id, req.body.status ?? null, req.body.description ?? null, req.body.physician_notes ?? null]
    );
    if (!updated) throw notFound('Treatment');

    await audit({ req, action: 'update', entityType: 'treatments', entityId: treatmentId, description: 'Updated treatment' });
    return ok(res, updated);
  })
);

// --- Discharge -------------------------------------------------------------

router.post(
  '/:id/discharge',
  requirePermission('discharge:write'),
  validate(
    z.object({
      discharge_status: z.enum(['recovered', 'improved', 'transferred', 'admitted', 'ama', 'deceased', 'referred']),
      condition_on_discharge: z.string().max(1000).optional().nullable(),
      instructions: z.string().max(8000).optional().nullable(),
      medication_summary: z.string().max(4000).optional().nullable(),
      follow_up_required: z.boolean().default(false),
      follow_up_date: optionalIsoDate,
      transferred_to: z.string().max(200).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'visit id');
    const visit = await loadVisit(id);

    if (visit.status === 'discharged') throw badRequest('This visit is already discharged.');

    const b = req.body;

    const record = await transaction(async (client) => {
      // Roll the current prescription list into the discharge summary if the
      // clinician did not write one.
      let medicationSummary = b.medication_summary;
      if (!medicationSummary) {
        const { rows: rx } = await client.query(
          `SELECT medication_name, dosage, frequency, duration
             FROM prescriptions WHERE visit_id = $1 AND deleted_at IS NULL`,
          [id]
        );
        medicationSummary =
          rx.length > 0
            ? rx.map((r) => `${r.medication_name} - ${r.dosage}, ${r.frequency}${r.duration ? ` for ${r.duration}` : ''}`).join('\n')
            : null;
      }

      const { rows: discharge } = await client.query(
        `INSERT INTO discharge_records
           (visit_id, patient_id, discharge_status, condition_on_discharge, instructions,
            medication_summary, follow_up_required, follow_up_date, transferred_to, discharged_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          id, visit.patient_id, b.discharge_status, b.condition_on_discharge ?? null,
          b.instructions ?? null, medicationSummary, b.follow_up_required,
          b.follow_up_date ?? null, b.transferred_to ?? null, req.staff.id,
        ]
      );

      const dispositionMap = {
        recovered: 'discharged',
        improved: 'discharged',
        transferred: 'transferred',
        admitted: 'admitted',
        ama: 'ama',
        deceased: 'deceased',
        referred: 'referred',
      };

      await client.query(
        `UPDATE patient_visits
            SET status = $2, disposition = $3, discharged_at = now(),
                completed_at = COALESCE(completed_at, now())
          WHERE id = $1`,
        [id, b.discharge_status === 'admitted' ? 'admitted' : 'discharged', dispositionMap[b.discharge_status]]
      );

      if (b.discharge_status === 'deceased') {
        await client.query('UPDATE patients SET is_deceased = true WHERE id = $1', [visit.patient_id]);
      }

      return discharge[0];
    });

    await audit({
      req, action: 'discharge', entityType: 'patient_visits', entityId: id,
      description: `Discharged visit ${visit.visit_number} as ${b.discharge_status}`,
    });

    broadcastChange('queue', { visitId: id });

    return created(res, record);
  })
);

export default router;
