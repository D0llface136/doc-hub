/**
 * Patient records.
 *
 * GET    /api/patients                     search / list
 * POST   /api/patients                     register a new patient
 * GET    /api/patients/lookup              find by SL avatar key (HUD helper)
 * GET    /api/patients/:id                 demographics + flags
 * PATCH  /api/patients/:id                 edit demographics
 * DELETE /api/patients/:id                 archive
 * GET    /api/patients/:id/chart           the complete medical record
 * GET    /api/patients/:id/visits          visit history
 * GET    /api/patients/:id/vitals          historical vitals (for graphing)
 * ...    /api/patients/:id/allergies       allergy list
 * ...    /api/patients/:id/conditions      chronic condition list
 * ...    /api/patients/:id/contacts        emergency contacts
 * ...    /api/patients/:id/insurance       insurance policies
 */
import { Router } from 'express';
import { one, rows, query, transaction } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, readSort, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z, text, optionalIsoDate, listQuery } from '../lib/validate.js';
import { audit, diffChanges } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const GENDERS = ['male', 'female', 'non_binary', 'other', 'undisclosed'];
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'];

const SORTABLE = {
  name: 'p.last_name',
  mrn: 'p.mrn',
  created: 'p.created_at',
  last_visit: 'last_visit_at',
};

/** Confirm a patient exists (and is not archived) before touching sub-resources. */
async function assertPatientExists(id) {
  const patient = await one('SELECT id, first_name, last_name FROM patients WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!patient) throw notFound('Patient');
  return patient;
}

// --- List & search ---------------------------------------------------------

router.get(
  '/',
  requirePermission('patients:read'),
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req);
    const { search } = req.validatedQuery;
    const orderBy = readSort(req, SORTABLE, 'name');

    const filters = ['p.deleted_at IS NULL'];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      filters.push(`(
        p.first_name ILIKE $${i} OR p.last_name ILIKE $${i}
        OR (p.first_name || ' ' || p.last_name) ILIKE $${i}
        OR p.mrn ILIKE $${i} OR p.phone_number ILIKE $${i}
        OR p.sl_avatar_name ILIKE $${i}
      )`);
    }

    const where = filters.join(' AND ');

    const { count } = await one(`SELECT count(*)::int AS count FROM patients p WHERE ${where}`, params);

    const list = await rows(
      `SELECT p.id, p.mrn, p.first_name, p.last_name,
              p.first_name || ' ' || p.last_name AS full_name,
              p.date_of_birth, p.gender, p.blood_type, p.phone_number,
              p.sl_avatar_name, p.is_deceased, p.created_at,
              CASE WHEN p.date_of_birth IS NULL THEN NULL
                   ELSE extract(year from age(p.date_of_birth))::int END AS age,
              (SELECT count(*) FROM patient_visits v
                WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS visit_count,
              (SELECT max(v.checked_in_at) FROM patient_visits v
                WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS last_visit_at,
              (SELECT count(*) FROM patient_allergies a
                WHERE a.patient_id = p.id AND a.deleted_at IS NULL) AS allergy_count
         FROM patients p
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

/**
 * Look a patient up by their Second Life avatar key. This is what an in-world
 * scanner or exam-table HUD calls after detecting who is standing on it.
 */
router.get(
  '/lookup',
  requirePermission('patients:read'),
  validate(z.object({ sl_avatar_key: z.string().uuid().optional(), mrn: z.string().max(40).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { sl_avatar_key, mrn } = req.validatedQuery;
    if (!sl_avatar_key && !mrn) throw badRequest('Provide either sl_avatar_key or mrn.');

    const patient = await one(
      `SELECT p.*, extract(year from age(p.date_of_birth))::int AS age
         FROM patients p
        WHERE p.deleted_at IS NULL
          AND ($1::uuid IS NULL OR p.sl_avatar_key = $1)
          AND ($2::text IS NULL OR p.mrn = $2)
        LIMIT 1`,
      [sl_avatar_key ?? null, mrn ?? null]
    );

    if (!patient) throw notFound('Patient');

    const activeVisit = await one(
      `SELECT id, visit_number, status, priority, queue_number
         FROM patient_visits
        WHERE patient_id = $1 AND status IN ('waiting','being_seen') AND deleted_at IS NULL
        ORDER BY checked_in_at DESC LIMIT 1`,
      [patient.id]
    );

    return ok(res, { ...patient, active_visit: activeVisit });
  })
);

// --- Create ----------------------------------------------------------------

const patientSchema = z.object({
  first_name: text(80, 'First name'),
  last_name: text(80, 'Last name'),
  date_of_birth: optionalIsoDate,
  gender: z.enum(GENDERS).optional().nullable(),
  blood_type: z.enum(BLOOD_TYPES).optional().nullable(),
  height_cm: z.coerce.number().min(20).max(300).optional().nullable(),
  weight_kg: z.coerce.number().min(0.5).max(700).optional().nullable(),
  phone_number: z.string().max(40).optional().nullable(),
  email: z.string().email().max(160).optional().nullable(),
  address: z.string().max(400).optional().nullable(),
  sl_avatar_key: z.string().uuid().optional().nullable(),
  sl_avatar_name: z.string().max(120).optional().nullable(),
  photo_url: z.string().url().max(500).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  // Convenience: allow the check-in form to send these in one request.
  allergies: z.array(z.object({
    substance: text(120, 'Substance'),
    reaction: z.string().max(200).optional().nullable(),
    severity: z.enum(['mild', 'moderate', 'severe', 'life_threatening']).default('moderate'),
  })).max(50).optional(),
  conditions: z.array(z.object({
    condition: text(160, 'Condition'),
    status: z.enum(['active', 'resolved', 'in_remission', 'chronic']).default('active'),
    notes: z.string().max(500).optional().nullable(),
  })).max(50).optional(),
  emergency_contact: z.object({
    full_name: text(120, 'Contact name'),
    relationship: z.string().max(60).optional().nullable(),
    phone_number: z.string().max(40).optional().nullable(),
  }).optional(),
  insurance: z.object({
    provider_id: z.string().uuid().optional().nullable(),
    provider_name: z.string().max(120).optional().nullable(),
    policy_number: text(60, 'Policy number'),
    group_number: z.string().max(60).optional().nullable(),
  }).optional(),
});

router.post(
  '/',
  requirePermission('patients:write'),
  validate(patientSchema),
  asyncHandler(async (req, res) => {
    const body = req.body;

    const patient = await transaction(async (client) => {
      const { rows: inserted } = await client.query(
        `INSERT INTO patients
           (first_name, last_name, date_of_birth, gender, blood_type, height_cm,
            weight_kg, phone_number, email, address, sl_avatar_key, sl_avatar_name,
            photo_url, notes, registered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          body.first_name, body.last_name, body.date_of_birth ?? null,
          body.gender ?? null, body.blood_type ?? null, body.height_cm ?? null,
          body.weight_kg ?? null, body.phone_number ?? null, body.email ?? null,
          body.address ?? null, body.sl_avatar_key ?? null, body.sl_avatar_name ?? null,
          body.photo_url ?? null, body.notes ?? null, req.staff.id,
        ]
      );
      const record = inserted[0];

      for (const allergy of body.allergies ?? []) {
        await client.query(
          `INSERT INTO patient_allergies (patient_id, substance, reaction, severity, noted_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [record.id, allergy.substance, allergy.reaction ?? null, allergy.severity, req.staff.id]
        );
      }

      for (const condition of body.conditions ?? []) {
        await client.query(
          `INSERT INTO patient_conditions (patient_id, condition, status, notes, noted_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [record.id, condition.condition, condition.status, condition.notes ?? null, req.staff.id]
        );
      }

      if (body.emergency_contact) {
        await client.query(
          `INSERT INTO emergency_contacts (patient_id, full_name, relationship, phone_number, is_primary)
           VALUES ($1,$2,$3,$4,true)`,
          [
            record.id,
            body.emergency_contact.full_name,
            body.emergency_contact.relationship ?? null,
            body.emergency_contact.phone_number ?? null,
          ]
        );
      }

      if (body.insurance) {
        await client.query(
          `INSERT INTO patient_insurance
             (patient_id, provider_id, provider_name, policy_number, group_number)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            record.id,
            body.insurance.provider_id ?? null,
            body.insurance.provider_name ?? null,
            body.insurance.policy_number,
            body.insurance.group_number ?? null,
          ]
        );
      }

      return record;
    });

    await audit({
      req,
      action: 'create',
      entityType: 'patients',
      entityId: patient.id,
      description: `Registered patient ${patient.first_name} ${patient.last_name} (${patient.mrn})`,
    });

    return created(res, patient);
  })
);

// --- Read / update / archive ----------------------------------------------

router.get(
  '/:id',
  requirePermission('patients:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'patient id');

    const patient = await one(
      `SELECT p.*,
              CASE WHEN p.date_of_birth IS NULL THEN NULL
                   ELSE extract(year from age(p.date_of_birth))::int END AS age,
              s.full_name AS registered_by_name
         FROM patients p
         LEFT JOIN staff s ON s.id = p.registered_by
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id]
    );
    if (!patient) throw notFound('Patient');

    const [allergies, conditions, contacts, insurance, activeVisit] = await Promise.all([
      rows('SELECT * FROM patient_allergies WHERE patient_id = $1 AND deleted_at IS NULL ORDER BY severity DESC, substance', [id]),
      rows('SELECT * FROM patient_conditions WHERE patient_id = $1 AND deleted_at IS NULL ORDER BY status, condition', [id]),
      rows('SELECT * FROM emergency_contacts WHERE patient_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC', [id]),
      rows(
        `SELECT pi.*, ip.name AS provider_catalog_name
           FROM patient_insurance pi
           LEFT JOIN insurance_providers ip ON ip.id = pi.provider_id
          WHERE pi.patient_id = $1 AND pi.deleted_at IS NULL
          ORDER BY pi.is_primary DESC, pi.created_at DESC`,
        [id]
      ),
      one(
        `SELECT id, visit_number, status, priority, queue_number, chief_complaint, checked_in_at
           FROM patient_visits
          WHERE patient_id = $1 AND status IN ('waiting','being_seen') AND deleted_at IS NULL
          ORDER BY checked_in_at DESC LIMIT 1`,
        [id]
      ),
    ]);

    // Viewing a chart is itself auditable in a real EHR; keep the same habit.
    await audit({ req, action: 'view', entityType: 'patients', entityId: id, description: `Viewed ${patient.mrn}` });

    return ok(res, { ...patient, allergies, conditions, emergency_contacts: contacts, insurance, active_visit: activeVisit });
  })
);

router.patch(
  '/:id',
  requirePermission('patients:write'),
  validate(patientSchema.partial().omit({ allergies: true, conditions: true, emergency_contact: true, insurance: true })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'patient id');
    const existing = await one('SELECT * FROM patients WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Patient');

    const updated = await one(
      `UPDATE patients SET
         first_name     = COALESCE($2, first_name),
         last_name      = COALESCE($3, last_name),
         date_of_birth  = COALESCE($4, date_of_birth),
         gender         = COALESCE($5, gender),
         blood_type     = COALESCE($6, blood_type),
         height_cm      = COALESCE($7, height_cm),
         weight_kg      = COALESCE($8, weight_kg),
         phone_number   = COALESCE($9, phone_number),
         email          = COALESCE($10, email),
         address        = COALESCE($11, address),
         sl_avatar_key  = COALESCE($12, sl_avatar_key),
         sl_avatar_name = COALESCE($13, sl_avatar_name),
         photo_url      = COALESCE($14, photo_url),
         notes          = COALESCE($15, notes)
       WHERE id = $1
       RETURNING *`,
      [
        id, req.body.first_name ?? null, req.body.last_name ?? null, req.body.date_of_birth ?? null,
        req.body.gender ?? null, req.body.blood_type ?? null, req.body.height_cm ?? null,
        req.body.weight_kg ?? null, req.body.phone_number ?? null, req.body.email ?? null,
        req.body.address ?? null, req.body.sl_avatar_key ?? null, req.body.sl_avatar_name ?? null,
        req.body.photo_url ?? null, req.body.notes ?? null,
      ]
    );

    await audit({
      req, action: 'update', entityType: 'patients', entityId: id,
      changes: diffChanges(existing, updated),
      description: `Updated patient ${existing.mrn}`,
    });

    return ok(res, updated);
  })
);

router.delete(
  '/:id',
  requirePermission('patients:delete'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'patient id');
    const patient = await assertPatientExists(id);

    const openVisit = await one(
      `SELECT id FROM patient_visits
        WHERE patient_id = $1 AND status IN ('waiting','being_seen') AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (openVisit) throw badRequest('This patient has an open visit. Close it before archiving the record.');

    await query('UPDATE patients SET deleted_at = now() WHERE id = $1', [id]);
    await audit({
      req, action: 'delete', entityType: 'patients', entityId: id,
      description: `Archived patient ${patient.first_name} ${patient.last_name}`,
    });

    return ok(res, { archived: true });
  })
);

// --- Complete chart --------------------------------------------------------

/**
 * The full record in one response. The HUD loads this once when a chart is
 * opened, rather than making a dozen round trips over the SL browser's
 * relatively slow connection.
 */
router.get(
  '/:id/chart',
  requirePermission('patients:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'patient id');
    await assertPatientExists(id);

    const [patient, allergies, conditions, contacts, insurance, visits, vitals, prescriptions, labs, imaging, surgeries, invoices, certificates] =
      await Promise.all([
        one(
          `SELECT p.*, CASE WHEN p.date_of_birth IS NULL THEN NULL
                       ELSE extract(year from age(p.date_of_birth))::int END AS age
             FROM patients p WHERE p.id = $1`,
          [id]
        ),
        rows('SELECT * FROM patient_allergies WHERE patient_id = $1 AND deleted_at IS NULL', [id]),
        rows('SELECT * FROM patient_conditions WHERE patient_id = $1 AND deleted_at IS NULL', [id]),
        rows('SELECT * FROM emergency_contacts WHERE patient_id = $1 AND deleted_at IS NULL', [id]),
        rows('SELECT * FROM patient_insurance WHERE patient_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC', [id]),
        rows(
          `SELECT v.id, v.visit_number, v.visit_type, v.status, v.priority, v.chief_complaint,
                  v.checked_in_at, v.completed_at, v.disposition,
                  d.full_name AS doctor_name,
                  (SELECT string_agg(COALESCE(dx.name, vd.custom_name), ', ')
                     FROM visit_diagnoses vd LEFT JOIN diagnoses dx ON dx.id = vd.diagnosis_id
                    WHERE vd.visit_id = v.id) AS diagnoses,
                  (SELECT count(*) FROM prescriptions rx WHERE rx.visit_id = v.id AND rx.deleted_at IS NULL) AS prescription_count,
                  (SELECT count(*) FROM laboratory_orders lo WHERE lo.visit_id = v.id AND lo.deleted_at IS NULL) AS lab_count,
                  (SELECT sum(i.total) FROM invoices i WHERE i.visit_id = v.id AND i.deleted_at IS NULL) AS billed_total
             FROM patient_visits v
             LEFT JOIN staff d ON d.id = v.assigned_doctor_id
            WHERE v.patient_id = $1 AND v.deleted_at IS NULL
            ORDER BY v.checked_in_at DESC
            LIMIT 100`,
          [id]
        ),
        rows(
          `SELECT * FROM vitals WHERE patient_id = $1 AND deleted_at IS NULL
            ORDER BY recorded_at DESC LIMIT 50`,
          [id]
        ),
        rows(
          `SELECT rx.*, s.full_name AS prescriber_name
             FROM prescriptions rx LEFT JOIN staff s ON s.id = rx.prescribed_by
            WHERE rx.patient_id = $1 AND rx.deleted_at IS NULL
            ORDER BY rx.prescribed_at DESC LIMIT 100`,
          [id]
        ),
        rows(
          `SELECT lo.*, s.full_name AS ordered_by_name,
                  (SELECT json_agg(row_to_json(lr)) FROM laboratory_results lr WHERE lr.order_id = lo.id) AS results
             FROM laboratory_orders lo LEFT JOIN staff s ON s.id = lo.ordered_by
            WHERE lo.patient_id = $1 AND lo.deleted_at IS NULL
            ORDER BY lo.ordered_at DESC LIMIT 100`,
          [id]
        ),
        rows(
          `SELECT ro.*, s.full_name AS ordered_by_name
             FROM radiology_orders ro LEFT JOIN staff s ON s.id = ro.ordered_by
            WHERE ro.patient_id = $1 AND ro.deleted_at IS NULL
            ORDER BY ro.ordered_at DESC LIMIT 50`,
          [id]
        ),
        rows(
          `SELECT sg.*, s.full_name AS surgeon_name
             FROM surgeries sg LEFT JOIN staff s ON s.id = sg.surgeon_id
            WHERE sg.patient_id = $1 AND sg.deleted_at IS NULL
            ORDER BY COALESCE(sg.start_time, sg.scheduled_at) DESC LIMIT 50`,
          [id]
        ),
        rows(
          `SELECT id, invoice_number, status, billing_type, total, amount_paid, balance_due, created_at
             FROM invoices WHERE patient_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 50`,
          [id]
        ),
        rows(
          `SELECT id, certificate_number, template, title, issued_at, valid_from, valid_until, public_token
             FROM medical_certificates WHERE patient_id = $1 AND deleted_at IS NULL
            ORDER BY issued_at DESC LIMIT 50`,
          [id]
        ),
      ]);

    await audit({ req, action: 'view', entityType: 'patients', entityId: id, description: `Opened full chart for ${patient.mrn}` });

    return ok(res, {
      patient,
      allergies,
      conditions,
      emergency_contacts: contacts,
      insurance,
      visits,
      vitals,
      prescriptions,
      laboratory: labs,
      radiology: imaging,
      surgeries,
      invoices,
      certificates,
    });
  })
);

router.get(
  '/:id/visits',
  requirePermission('visits:read'),
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'patient id');
    const { page, limit, offset } = readPagination(req);

    const { count } = await one(
      'SELECT count(*)::int AS count FROM patient_visits WHERE patient_id = $1 AND deleted_at IS NULL',
      [id]
    );

    const list = await rows(
      `SELECT v.*, d.full_name AS doctor_name, n.full_name AS nurse_name
         FROM patient_visits v
         LEFT JOIN staff d ON d.id = v.assigned_doctor_id
         LEFT JOIN staff n ON n.id = v.assigned_nurse_id
        WHERE v.patient_id = $1 AND v.deleted_at IS NULL
        ORDER BY v.checked_in_at DESC
        LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

/** Vitals history, oldest first, ready to plot. */
router.get(
  '/:id/vitals',
  requirePermission('vitals:read'),
  validate(z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'patient id');
    const limit = req.validatedQuery.limit ?? 100;

    const list = await rows(
      `SELECT v.*, s.full_name AS recorded_by_name
         FROM vitals v LEFT JOIN staff s ON s.id = v.recorded_by
        WHERE v.patient_id = $1 AND v.deleted_at IS NULL
        ORDER BY v.recorded_at DESC
        LIMIT $2`,
      [id, limit]
    );

    return ok(res, list.reverse());
  })
);

// --- Sub-resources ---------------------------------------------------------

/**
 * Generate matching list/create/delete routes for the simple child tables.
 * They differ only in table name, columns and permission, so writing them out
 * eight times would just be an opportunity for them to drift apart.
 */
function childResource({ path, table, permission, columns, schema, orderBy, label }) {
  router.get(
    `/:id/${path}`,
    requirePermission('patients:read'),
    asyncHandler(async (req, res) => {
      const id = requireUuid(req.params.id, 'patient id');
      const list = await rows(
        `SELECT * FROM ${table} WHERE patient_id = $1 AND deleted_at IS NULL ORDER BY ${orderBy}`,
        [id]
      );
      return ok(res, list);
    })
  );

  router.post(
    `/:id/${path}`,
    requirePermission(permission),
    validate(schema),
    asyncHandler(async (req, res) => {
      const id = requireUuid(req.params.id, 'patient id');
      await assertPatientExists(id);

      const placeholders = columns.map((_, i) => `$${i + 2}`).join(', ');
      const values = columns.map((col) => {
        // Attribution columns default to the signed-in user rather than
        // trusting whatever the client sent.
        if (col === 'noted_by') return req.staff.id;
        return req.body[col] ?? null;
      });

      const record = await one(
        `INSERT INTO ${table} (patient_id, ${columns.join(', ')})
         VALUES ($1, ${placeholders}) RETURNING *`,
        [id, ...values]
      );

      await audit({
        req, action: 'create', entityType: table, entityId: record.id,
        description: `Added ${label} for patient ${id}`,
      });
      return created(res, record);
    })
  );

  router.delete(
    `/:id/${path}/:childId`,
    requirePermission(permission),
    asyncHandler(async (req, res) => {
      const id = requireUuid(req.params.id, 'patient id');
      const childId = requireUuid(req.params.childId, `${label} id`);

      const removed = await one(
        `UPDATE ${table} SET deleted_at = now()
          WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL RETURNING id`,
        [childId, id]
      );
      if (!removed) throw notFound(label);

      await audit({ req, action: 'delete', entityType: table, entityId: childId, description: `Removed ${label}` });
      return ok(res, { removed: true });
    })
  );
}

childResource({
  path: 'allergies',
  table: 'patient_allergies',
  permission: 'patients:write',
  columns: ['substance', 'reaction', 'severity', 'noted_by'],
  orderBy: `CASE severity WHEN 'life_threatening' THEN 0 WHEN 'severe' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, substance`,
  label: 'Allergy',
  schema: z.object({
    substance: text(120, 'Substance'),
    reaction: z.string().max(200).optional().nullable(),
    severity: z.enum(['mild', 'moderate', 'severe', 'life_threatening']).default('moderate'),
    noted_by: z.string().uuid().optional().nullable(),
  }),
});

childResource({
  path: 'conditions',
  table: 'patient_conditions',
  permission: 'patients:write',
  columns: ['condition', 'diagnosed_on', 'status', 'notes', 'noted_by'],
  orderBy: 'status, condition',
  label: 'Condition',
  schema: z.object({
    condition: text(160, 'Condition'),
    diagnosed_on: optionalIsoDate,
    status: z.enum(['active', 'resolved', 'in_remission', 'chronic']).default('active'),
    notes: z.string().max(1000).optional().nullable(),
    noted_by: z.string().uuid().optional().nullable(),
  }),
});

childResource({
  path: 'contacts',
  table: 'emergency_contacts',
  permission: 'patients:write',
  columns: ['full_name', 'relationship', 'phone_number', 'email', 'is_primary'],
  orderBy: 'is_primary DESC, full_name',
  label: 'Emergency contact',
  schema: z.object({
    full_name: text(120, 'Contact name'),
    relationship: z.string().max(60).optional().nullable(),
    phone_number: z.string().max(40).optional().nullable(),
    email: z.string().email().max(160).optional().nullable(),
    is_primary: z.boolean().default(false),
  }),
});

export default router;
