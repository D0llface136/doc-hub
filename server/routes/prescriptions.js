/**
 * Prescriptions.
 *
 * GET    /api/prescriptions                list / filter
 * POST   /api/prescriptions                write a prescription
 * GET    /api/prescriptions/:id            one prescription
 * PATCH  /api/prescriptions/:id            edit before it is filled
 * POST   /api/prescriptions/:id/send       send to the pharmacy queue
 * GET    /api/prescriptions/:id/label      printable label data (and SL rez payload)
 * POST   /api/prescriptions/:id/cancel     cancel
 */
import { Router } from 'express';
import { one, rows, transaction } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z, text, listQuery } from '../lib/validate.js';
import { audit, diffChanges } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { broadcastChange, notifyRole } from '../lib/notify.js';
import { config } from '../config/env.js';

const router = Router();
router.use(requireAuth);

/** Statuses after which the prescription is locked against edits. */
const LOCKED_STATUSES = ['filled', 'dispensed', 'completed', 'cancelled'];

router.get(
  '/',
  requirePermission('prescriptions:read'),
  validate(
    listQuery.extend({
      status: z.string().max(30).optional(),
      patient_id: z.string().uuid().optional(),
      visit_id: z.string().uuid().optional(),
      prescriber_id: z.string().uuid().optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req);
    const q = req.validatedQuery;

    const filters = ['rx.deleted_at IS NULL'];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.status) add(q.status, (p) => `rx.status = ${p}`);
    if (q.patient_id) add(q.patient_id, (p) => `rx.patient_id = ${p}`);
    if (q.visit_id) add(q.visit_id, (p) => `rx.visit_id = ${p}`);
    if (q.prescriber_id) add(q.prescriber_id, (p) => `rx.prescribed_by = ${p}`);
    if (q.search) {
      add(
        `%${q.search}%`,
        (p) => `(rx.medication_name ILIKE ${p} OR (pt.first_name || ' ' || pt.last_name) ILIKE ${p} OR pt.mrn ILIKE ${p})`
      );
    }

    const where = filters.join(' AND ');

    const { count } = await one(
      `SELECT count(*)::int AS count FROM prescriptions rx JOIN patients pt ON pt.id = rx.patient_id WHERE ${where}`,
      params
    );

    const list = await rows(
      `SELECT rx.*, pt.mrn, pt.first_name || ' ' || pt.last_name AS patient_name,
              s.full_name AS prescriber_name, pq.status AS pharmacy_status, pq.id AS pharmacy_queue_id,
              m.is_controlled, m.form
         FROM prescriptions rx
         JOIN patients pt ON pt.id = rx.patient_id
         LEFT JOIN staff s ON s.id = rx.prescribed_by
         LEFT JOIN medications m ON m.id = rx.medication_id
         LEFT JOIN pharmacy_queue pq ON pq.prescription_id = rx.id
        WHERE ${where}
        ORDER BY rx.prescribed_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

const prescriptionSchema = z
  .object({
    patient_id: z.string().uuid(),
    visit_id: z.string().uuid().optional().nullable(),
    medication_id: z.string().uuid().optional().nullable(),
    medication_name: z.string().max(200).optional().nullable(),
    dosage: text(80, 'Dosage'),
    frequency: text(80, 'Frequency'),
    duration: z.string().max(80).optional().nullable(),
    quantity: z.coerce.number().int().min(1).max(1000).default(1),
    refills: z.coerce.number().int().min(0).max(12).default(0),
    instructions: z.string().max(1000).optional().nullable(),
    /** Queue it for the pharmacy immediately rather than as a separate step. */
    send_to_pharmacy: z.boolean().default(false),
  })
  .refine((d) => d.medication_id || d.medication_name, {
    message: 'Choose a medication from the catalogue or type its name',
    path: ['medication_id'],
  });

router.post(
  '/',
  requirePermission('prescriptions:write'),
  validate(prescriptionSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const patient = await one(
      'SELECT id, mrn, first_name, last_name FROM patients WHERE id = $1 AND deleted_at IS NULL',
      [b.patient_id]
    );
    if (!patient) throw notFound('Patient');

    let medication = null;
    if (b.medication_id) {
      medication = await one('SELECT * FROM medications WHERE id = $1 AND deleted_at IS NULL', [b.medication_id]);
      if (!medication) throw badRequest('That medication is not in the catalogue.');
      if (!medication.is_active) throw badRequest(`${medication.name} is not currently stocked.`);
    }

    const medicationName = medication
      ? `${medication.name}${medication.strength ? ` ${medication.strength}` : ''}`
      : b.medication_name;

    // Allergy check. This does not block prescribing - a clinician may have a
    // reason - but the warning is returned so the UI can confirm, and it is
    // written into the audit trail either way.
    const allergyWarnings = await rows(
      `SELECT substance, reaction, severity
         FROM patient_allergies
        WHERE patient_id = $1 AND deleted_at IS NULL
          AND ($2::text ILIKE '%' || substance || '%'
               OR ($3::text IS NOT NULL AND $3::text ILIKE '%' || substance || '%'))`,
      [b.patient_id, medicationName, medication?.generic_name ?? null]
    );

    const result = await transaction(async (client) => {
      const { rows: inserted } = await client.query(
        `INSERT INTO prescriptions
           (visit_id, patient_id, medication_id, medication_name, dosage, frequency,
            duration, quantity, refills, instructions, prescribed_by, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() + interval '90 days')
         RETURNING *`,
        [
          b.visit_id ?? null, b.patient_id, b.medication_id ?? null, medicationName,
          b.dosage, b.frequency, b.duration ?? null, b.quantity, b.refills,
          b.instructions ?? null, req.staff.id,
          b.send_to_pharmacy ? 'sent_to_pharmacy' : 'active',
        ]
      );
      const prescription = inserted[0];

      if (b.send_to_pharmacy) {
        await client.query(
          `INSERT INTO pharmacy_queue (prescription_id, patient_id, priority)
           VALUES ($1,$2,$3)`,
          [prescription.id, b.patient_id, 'normal']
        );
      }

      return prescription;
    });

    await audit({
      req, action: 'create', entityType: 'prescriptions', entityId: result.id,
      description: `Prescribed ${medicationName} for ${patient.first_name} ${patient.last_name}` +
        (allergyWarnings.length > 0 ? ` (ALLERGY WARNING: ${allergyWarnings.map((a) => a.substance).join(', ')})` : ''),
    });

    if (b.send_to_pharmacy) {
      broadcastChange('pharmacy', { prescriptionId: result.id });
      await notifyRole({
        roleCode: 'pharmacist',
        type: 'prescription',
        title: 'New prescription to fill',
        body: `${medicationName} for ${patient.first_name} ${patient.last_name} (${patient.mrn})`,
        link: '#/pharmacy',
        entityType: 'prescriptions',
        entityId: result.id,
      });
    }

    return created(res, { ...result, allergy_warnings: allergyWarnings });
  })
);

router.get(
  '/:id',
  requirePermission('prescriptions:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'prescription id');
    const prescription = await one(
      `SELECT rx.*, pt.mrn, pt.first_name, pt.last_name,
              pt.first_name || ' ' || pt.last_name AS patient_name, pt.date_of_birth,
              s.full_name AS prescriber_name, s.display_title AS prescriber_title,
              pq.status AS pharmacy_status, pq.id AS pharmacy_queue_id,
              m.form, m.is_controlled, m.unit_cost
         FROM prescriptions rx
         JOIN patients pt ON pt.id = rx.patient_id
         LEFT JOIN staff s ON s.id = rx.prescribed_by
         LEFT JOIN medications m ON m.id = rx.medication_id
         LEFT JOIN pharmacy_queue pq ON pq.prescription_id = rx.id
        WHERE rx.id = $1 AND rx.deleted_at IS NULL`,
      [id]
    );
    if (!prescription) throw notFound('Prescription');
    return ok(res, prescription);
  })
);

router.patch(
  '/:id',
  requirePermission('prescriptions:write'),
  validate(
    z.object({
      dosage: z.string().max(80).optional(),
      frequency: z.string().max(80).optional(),
      duration: z.string().max(80).optional().nullable(),
      quantity: z.coerce.number().int().min(1).max(1000).optional(),
      refills: z.coerce.number().int().min(0).max(12).optional(),
      instructions: z.string().max(1000).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'prescription id');
    const existing = await one('SELECT * FROM prescriptions WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Prescription');

    if (LOCKED_STATUSES.includes(existing.status)) {
      throw badRequest(`This prescription is "${existing.status}" and can no longer be edited.`);
    }

    const b = req.body;
    const updated = await one(
      `UPDATE prescriptions SET
         dosage       = COALESCE($2, dosage),
         frequency    = COALESCE($3, frequency),
         duration     = COALESCE($4, duration),
         quantity     = COALESCE($5, quantity),
         refills      = COALESCE($6, refills),
         instructions = COALESCE($7, instructions)
       WHERE id = $1 RETURNING *`,
      [id, b.dosage ?? null, b.frequency ?? null, b.duration ?? null, b.quantity ?? null, b.refills ?? null, b.instructions ?? null]
    );

    await audit({
      req, action: 'update', entityType: 'prescriptions', entityId: id,
      changes: diffChanges(existing, updated),
      description: `Edited prescription for ${existing.medication_name}`,
    });

    return ok(res, updated);
  })
);

router.post(
  '/:id/send',
  requirePermission('prescriptions:write'),
  validate(z.object({ priority: z.enum(['normal', 'urgent', 'emergency']).default('normal') })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'prescription id');

    const prescription = await one(
      `SELECT rx.*, pt.mrn, pt.first_name || ' ' || pt.last_name AS patient_name
         FROM prescriptions rx JOIN patients pt ON pt.id = rx.patient_id
        WHERE rx.id = $1 AND rx.deleted_at IS NULL`,
      [id]
    );
    if (!prescription) throw notFound('Prescription');
    if (LOCKED_STATUSES.includes(prescription.status)) {
      throw badRequest(`This prescription is already "${prescription.status}".`);
    }

    const queueEntry = await transaction(async (client) => {
      // Re-queue an existing rejected entry rather than creating a duplicate.
      const { rows: existing } = await client.query('SELECT * FROM pharmacy_queue WHERE prescription_id = $1', [id]);

      let entry;
      if (existing.length > 0) {
        const { rows: r } = await client.query(
          `UPDATE pharmacy_queue
              SET status = 'pending', priority = $2, rejected_reason = NULL
            WHERE prescription_id = $1 RETURNING *`,
          [id, req.body.priority]
        );
        entry = r[0];
      } else {
        const { rows: r } = await client.query(
          `INSERT INTO pharmacy_queue (prescription_id, patient_id, priority)
           VALUES ($1,$2,$3) RETURNING *`,
          [id, prescription.patient_id, req.body.priority]
        );
        entry = r[0];
      }

      await client.query("UPDATE prescriptions SET status = 'sent_to_pharmacy' WHERE id = $1", [id]);
      return entry;
    });

    await audit({
      req, action: 'send_to_pharmacy', entityType: 'prescriptions', entityId: id,
      description: `Sent ${prescription.medication_name} to the pharmacy`,
    });

    broadcastChange('pharmacy', { prescriptionId: id });
    await notifyRole({
      roleCode: 'pharmacist',
      type: 'prescription',
      title: req.body.priority === 'normal' ? 'New prescription to fill' : `${req.body.priority.toUpperCase()} prescription`,
      body: `${prescription.medication_name} for ${prescription.patient_name} (${prescription.mrn})`,
      link: '#/pharmacy',
      entityType: 'prescriptions',
      entityId: id,
    });

    return ok(res, queueEntry);
  })
);

/**
 * Everything needed to print a pharmacy label, or to build the description of
 * an in-world prescription bottle. `rez_payload` is a compact string an LSL
 * script can drop straight into llSetObjectDesc / llRezObject parameters.
 */
router.get(
  '/:id/label',
  requirePermission('prescriptions:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'prescription id');

    const rx = await one(
      `SELECT rx.*, pt.mrn, pt.first_name, pt.last_name, pt.date_of_birth,
              s.full_name AS prescriber_name, s.display_title AS prescriber_title
         FROM prescriptions rx
         JOIN patients pt ON pt.id = rx.patient_id
         LEFT JOIN staff s ON s.id = rx.prescribed_by
        WHERE rx.id = $1 AND rx.deleted_at IS NULL`,
      [id]
    );
    if (!rx) throw notFound('Prescription');

    const clinicName = await one("SELECT value FROM clinic_settings WHERE key = 'clinic.name'");

    const label = {
      clinic_name: clinicName?.value ?? 'Clinic',
      prescription_id: rx.id,
      patient_name: `${rx.first_name} ${rx.last_name}`,
      patient_mrn: rx.mrn,
      date_of_birth: rx.date_of_birth,
      medication: rx.medication_name,
      dosage: rx.dosage,
      frequency: rx.frequency,
      duration: rx.duration,
      quantity: rx.quantity,
      refills: rx.refills,
      instructions: rx.instructions ?? `Take ${rx.dosage} ${rx.frequency}.`,
      prescriber: [rx.prescriber_title, rx.prescriber_name].filter(Boolean).join(' '),
      prescribed_at: rx.prescribed_at,
      expires_at: rx.expires_at,
      verify_url: `${config.publicBaseUrl}/#/prescriptions/${rx.id}`,
    };

    // Pipe-delimited because LSL's llParseString2List is cheap and JSON parsing
    // in LSL is not. Field order is fixed; see docs/LSL-INTEGRATION.md.
    label.rez_payload = [
      rx.id,
      `${rx.first_name} ${rx.last_name}`,
      rx.medication_name,
      rx.dosage,
      rx.frequency,
      rx.duration ?? '',
      String(rx.quantity),
      label.instructions,
    ]
      .map((part) => String(part).replace(/\|/g, '/'))
      .join('|');

    return ok(res, label);
  })
);

router.post(
  '/:id/cancel',
  requirePermission('prescriptions:write'),
  validate(z.object({ reason: z.string().max(500).optional().nullable() })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'prescription id');

    const cancelled = await transaction(async (client) => {
      const { rows: r } = await client.query(
        `UPDATE prescriptions SET status = 'cancelled'
          WHERE id = $1 AND deleted_at IS NULL AND status NOT IN ('dispensed','completed')
          RETURNING *`,
        [id]
      );
      if (r.length === 0) return null;

      await client.query(
        `UPDATE pharmacy_queue SET status = 'cancelled', notes = COALESCE(notes,'') || $2
          WHERE prescription_id = $1 AND status IN ('pending','in_progress','ready')`,
        [id, req.body.reason ? `\nCancelled: ${req.body.reason}` : '\nCancelled by prescriber']
      );

      return r[0];
    });

    if (!cancelled) throw badRequest('This prescription cannot be cancelled - it may already be dispensed.');

    await audit({
      req, action: 'cancel', entityType: 'prescriptions', entityId: id,
      description: `Cancelled ${cancelled.medication_name}${req.body.reason ? `: ${req.body.reason}` : ''}`,
    });

    broadcastChange('pharmacy', { prescriptionId: id });

    return ok(res, cancelled);
  })
);

export default router;
