/**
 * Medical certificates and printable documents.
 *
 * GET  /api/certificates/templates      available templates + their placeholders
 * GET  /api/certificates                list
 * POST /api/certificates                issue a certificate
 * GET  /api/certificates/:id            one certificate
 * DELETE /api/certificates/:id          revoke
 * GET  /api/certificates/public/:token  fetch by public token (no login)
 *
 * A certificate stores rendered text rather than a template reference, so the
 * wording a patient was given cannot change retroactively when a template is
 * edited.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { one, rows } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z, text, listQuery } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { config } from '../config/env.js';

const router = Router();

/**
 * Built-in templates. `{{placeholders}}` are filled from the patient, visit and
 * the `fields` object supplied when issuing.
 */
export const TEMPLATES = {
  work_excuse: {
    label: 'Work Excuse',
    title: 'Certificate of Medical Excuse - Employment',
    placeholders: ['days', 'return_date', 'reason'],
    body: `This is to certify that {{patient_name}} (MRN {{mrn}}) was examined at {{clinic_name}} on {{visit_date}}.

In my professional opinion the patient is medically unfit to attend work for {{days}} day(s), and may return to normal duties on {{return_date}}.

Reason: {{reason}}

Issued by {{clinician}} on {{issue_date}}.`,
  },

  school_note: {
    label: 'School Absence Note',
    title: 'Certificate of Medical Excuse - Education',
    placeholders: ['days', 'return_date', 'reason'],
    body: `This is to certify that {{patient_name}} (MRN {{mrn}}) attended {{clinic_name}} on {{visit_date}} and received medical care.

The student was unable to attend classes for {{days}} day(s) and is cleared to return on {{return_date}}.

Reason: {{reason}}

Issued by {{clinician}} on {{issue_date}}.`,
  },

  fitness_clearance: {
    label: 'Fitness Clearance',
    title: 'Certificate of Medical Fitness',
    placeholders: ['activity', 'restrictions', 'valid_until'],
    body: `This is to certify that {{patient_name}} (MRN {{mrn}}) was examined at {{clinic_name}} on {{visit_date}}.

Following examination, the patient is considered medically fit to participate in: {{activity}}.

Restrictions or conditions: {{restrictions}}

This clearance is valid until {{valid_until}}.

Issued by {{clinician}} on {{issue_date}}.`,
  },

  admission_letter: {
    label: 'Hospital Admission Letter',
    title: 'Notice of Hospital Admission',
    placeholders: ['admitting_diagnosis', 'ward', 'expected_stay'],
    body: `{{patient_name}} (MRN {{mrn}}, date of birth {{date_of_birth}}) has been admitted to {{clinic_name}} on {{visit_date}}.

Admitting diagnosis: {{admitting_diagnosis}}
Ward / unit: {{ward}}
Expected length of stay: {{expected_stay}}

Please direct enquiries to the admitting clinician, {{clinician}}.

Issued on {{issue_date}}.`,
  },

  discharge_summary: {
    label: 'Discharge Summary',
    title: 'Discharge Summary',
    placeholders: ['diagnosis', 'treatment', 'medications', 'follow_up', 'instructions'],
    body: `DISCHARGE SUMMARY - {{clinic_name}}

Patient: {{patient_name}} (MRN {{mrn}})
Date of birth: {{date_of_birth}}
Visit: {{visit_number}}
Date of service: {{visit_date}}

DIAGNOSIS
{{diagnosis}}

TREATMENT PROVIDED
{{treatment}}

DISCHARGE MEDICATIONS
{{medications}}

FOLLOW-UP
{{follow_up}}

INSTRUCTIONS FOR THE PATIENT
{{instructions}}

Discharged by {{clinician}} on {{issue_date}}.`,
  },

  custom: {
    label: 'Custom Document',
    title: 'Medical Document',
    placeholders: [],
    body: '{{content}}',
  },
};

/** Replace every {{placeholder}}; unknown ones become a visible blank. */
function render(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === '' ? '__________' : String(value);
  });
}

// --- Public access (no authentication) -------------------------------------
//
// Registered before the router-wide requireAuth so an in-world sign or a
// patient's browser can open a certificate from its unguessable token alone.

router.get(
  '/public/:token',
  asyncHandler(async (req, res) => {
    const token = String(req.params.token ?? '');
    if (!/^[a-f0-9]{32,64}$/i.test(token)) throw notFound('Certificate');

    const certificate = await one(
      `SELECT c.certificate_number, c.template, c.title, c.body, c.valid_from,
              c.valid_until, c.issued_at,
              pt.first_name || ' ' || pt.last_name AS patient_name, pt.mrn,
              s.full_name AS issued_by_name, s.display_title AS issued_by_title
         FROM medical_certificates c
         JOIN patients pt ON pt.id = c.patient_id
         LEFT JOIN staff s ON s.id = c.issued_by
        WHERE c.public_token = $1 AND c.deleted_at IS NULL`,
      [token]
    );
    if (!certificate) throw notFound('Certificate');

    return ok(res, certificate);
  })
);

router.use(requireAuth);

router.get('/templates', asyncHandler(async (_req, res) =>
  ok(
    res,
    Object.entries(TEMPLATES).map(([key, tpl]) => ({
      key,
      label: tpl.label,
      title: tpl.title,
      placeholders: tpl.placeholders,
      preview: tpl.body,
    }))
  )
));

router.get(
  '/',
  requirePermission('patients:read'),
  validate(listQuery.extend({ patient_id: z.string().uuid().optional(), template: z.string().max(40).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req);
    const q = req.validatedQuery;

    const filters = ['c.deleted_at IS NULL'];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.patient_id) add(q.patient_id, (p) => `c.patient_id = ${p}`);
    if (q.template) add(q.template, (p) => `c.template = ${p}`);
    if (q.search) {
      add(`%${q.search}%`, (p) => `(c.title ILIKE ${p} OR c.certificate_number ILIKE ${p} OR (pt.first_name || ' ' || pt.last_name) ILIKE ${p})`);
    }

    const where = filters.join(' AND ');

    const { count } = await one(
      `SELECT count(*)::int AS count FROM medical_certificates c JOIN patients pt ON pt.id = c.patient_id WHERE ${where}`,
      params
    );

    const list = await rows(
      `SELECT c.*, pt.mrn, pt.first_name || ' ' || pt.last_name AS patient_name,
              s.full_name AS issued_by_name
         FROM medical_certificates c
         JOIN patients pt ON pt.id = c.patient_id
         LEFT JOIN staff s ON s.id = c.issued_by
        WHERE ${where}
        ORDER BY c.issued_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

router.post(
  '/',
  requirePermission('certificates:write'),
  validate(
    z.object({
      patient_id: z.string().uuid(),
      visit_id: z.string().uuid().optional().nullable(),
      template: z.enum(Object.keys(TEMPLATES)),
      title: z.string().max(200).optional().nullable(),
      /** Values for the template placeholders. */
      fields: z.record(z.string().max(4000)).optional(),
      /** Overrides the rendered body entirely. */
      body: z.string().max(20000).optional().nullable(),
      valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
      valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const template = TEMPLATES[b.template];

    const patient = await one(
      `SELECT id, mrn, first_name, last_name, date_of_birth FROM patients
        WHERE id = $1 AND deleted_at IS NULL`,
      [b.patient_id]
    );
    if (!patient) throw notFound('Patient');

    let visit = null;
    if (b.visit_id) {
      visit = await one('SELECT visit_number, checked_in_at FROM patient_visits WHERE id = $1 AND deleted_at IS NULL', [b.visit_id]);
      if (!visit) throw badRequest('That visit does not exist.');
    }

    const clinicName = await one("SELECT value FROM clinic_settings WHERE key = 'clinic.name'");

    const values = {
      ...(b.fields ?? {}),
      patient_name: `${patient.first_name} ${patient.last_name}`,
      mrn: patient.mrn,
      date_of_birth: patient.date_of_birth ?? 'not recorded',
      clinic_name: clinicName?.value ?? 'the clinic',
      clinician: [req.staff.display_title, req.staff.full_name].filter(Boolean).join(' '),
      visit_number: visit?.visit_number ?? 'n/a',
      visit_date: visit ? new Date(visit.checked_in_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      issue_date: new Date().toISOString().slice(0, 10),
    };

    const body = b.body ?? render(template.body, values);
    const title = b.title ?? template.title;

    const certificateNumber = `CERT-${new Date().getFullYear()}-${crypto.randomInt(100_000, 999_999)}`;
    const publicToken = crypto.randomBytes(24).toString('hex');

    const certificate = await one(
      `INSERT INTO medical_certificates
         (certificate_number, patient_id, visit_id, template, title, body,
          valid_from, valid_until, issued_by, public_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        certificateNumber, b.patient_id, b.visit_id ?? null, b.template, title, body,
        b.valid_from ?? null, b.valid_until ?? null, req.staff.id, publicToken,
      ]
    );

    await audit({
      req, action: 'create', entityType: 'medical_certificates', entityId: certificate.id,
      description: `Issued ${template.label} for ${patient.first_name} ${patient.last_name}`,
    });

    return created(res, {
      ...certificate,
      patient_name: `${patient.first_name} ${patient.last_name}`,
      public_url: `${config.publicBaseUrl}/print.html?token=${publicToken}`,
    });
  })
);

router.get(
  '/:id',
  requirePermission('patients:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'certificate id');

    const certificate = await one(
      `SELECT c.*, pt.mrn, pt.first_name || ' ' || pt.last_name AS patient_name,
              pt.date_of_birth, s.full_name AS issued_by_name, s.display_title AS issued_by_title,
              v.visit_number
         FROM medical_certificates c
         JOIN patients pt ON pt.id = c.patient_id
         LEFT JOIN staff s ON s.id = c.issued_by
         LEFT JOIN patient_visits v ON v.id = c.visit_id
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id]
    );
    if (!certificate) throw notFound('Certificate');

    return ok(res, {
      ...certificate,
      public_url: certificate.public_token ? `${config.publicBaseUrl}/print.html?token=${certificate.public_token}` : null,
    });
  })
);

router.delete(
  '/:id',
  requirePermission('certificates:write'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'certificate id');

    // Revoking clears the public token so any circulated link stops working.
    const revoked = await one(
      `UPDATE medical_certificates SET deleted_at = now(), public_token = NULL
        WHERE id = $1 AND deleted_at IS NULL RETURNING certificate_number`,
      [id]
    );
    if (!revoked) throw notFound('Certificate');

    await audit({ req, action: 'delete', entityType: 'medical_certificates', entityId: id, description: `Revoked ${revoked.certificate_number}` });
    return ok(res, { revoked: true });
  })
);

export default router;
