/**
 * Insurance providers and patient policies.
 *
 * GET    /api/insurance/providers            provider catalogue
 * POST   /api/insurance/providers            add a provider     (catalog:manage)
 * PATCH  /api/insurance/providers/:id        edit a provider    (catalog:manage)
 * GET    /api/insurance/policies             policies (filterable by patient)
 * POST   /api/insurance/policies             attach a policy to a patient
 * PATCH  /api/insurance/policies/:id         edit a policy
 * POST   /api/insurance/policies/:id/verify  verify / deny / expire coverage
 * DELETE /api/insurance/policies/:id         archive a policy
 */
import { Router } from 'express';
import { one, rows } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z, text, money, listQuery } from '../lib/validate.js';
import { audit, diffChanges } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// --- Providers -------------------------------------------------------------

router.get(
  '/providers',
  requirePermission('insurance:read'),
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { search } = req.validatedQuery;

    const list = await rows(
      `SELECT ip.*,
              (SELECT count(*) FROM patient_insurance pi
                WHERE pi.provider_id = ip.id AND pi.deleted_at IS NULL) AS policy_count
         FROM insurance_providers ip
        WHERE ip.deleted_at IS NULL
          AND ($1::text IS NULL OR ip.name ILIKE $1)
        ORDER BY ip.is_active DESC, ip.name`,
      [search ? `%${search}%` : null]
    );

    return ok(res, list);
  })
);

const providerSchema = z.object({
  name: text(120, 'Provider name'),
  contact_phone: z.string().max(40).optional().nullable(),
  contact_email: z.string().email().max(160).optional().nullable(),
  default_coverage: z.coerce.number().min(0).max(1).default(0.8),
  default_copay: money.default(0),
  is_active: z.boolean().default(true),
  notes: z.string().max(2000).optional().nullable(),
});

router.post(
  '/providers',
  requirePermission('catalog:manage'),
  validate(providerSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const provider = await one(
      `INSERT INTO insurance_providers
         (name, contact_phone, contact_email, default_coverage, default_copay, is_active, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.name, b.contact_phone ?? null, b.contact_email ?? null, b.default_coverage, b.default_copay, b.is_active, b.notes ?? null]
    );

    await audit({ req, action: 'create', entityType: 'insurance_providers', entityId: provider.id, description: `Added provider ${b.name}` });
    return created(res, provider);
  })
);

router.patch(
  '/providers/:id',
  requirePermission('catalog:manage'),
  validate(providerSchema.partial()),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'provider id');
    const existing = await one('SELECT * FROM insurance_providers WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Insurance provider');

    const b = req.body;
    const updated = await one(
      `UPDATE insurance_providers SET
         name             = COALESCE($2, name),
         contact_phone    = COALESCE($3, contact_phone),
         contact_email    = COALESCE($4, contact_email),
         default_coverage = COALESCE($5, default_coverage),
         default_copay    = COALESCE($6, default_copay),
         is_active        = COALESCE($7, is_active),
         notes            = COALESCE($8, notes)
       WHERE id = $1 RETURNING *`,
      [
        id, b.name ?? null, b.contact_phone ?? null, b.contact_email ?? null,
        b.default_coverage ?? null, b.default_copay ?? null,
        b.is_active === undefined ? null : b.is_active, b.notes ?? null,
      ]
    );

    await audit({
      req, action: 'update', entityType: 'insurance_providers', entityId: id,
      changes: diffChanges(existing, updated), description: `Updated provider ${existing.name}`,
    });

    return ok(res, updated);
  })
);

// --- Patient policies ------------------------------------------------------

const POLICY_SELECT = `
  SELECT pi.*,
         pt.mrn, pt.first_name || ' ' || pt.last_name AS patient_name,
         ip.name AS provider_catalog_name, ip.default_coverage, ip.default_copay,
         verifier.full_name AS verified_by_name,
         (pi.expiration_date IS NOT NULL AND pi.expiration_date < CURRENT_DATE) AS is_expired
    FROM patient_insurance pi
    JOIN patients pt ON pt.id = pi.patient_id
    LEFT JOIN insurance_providers ip ON ip.id = pi.provider_id
    LEFT JOIN staff verifier ON verifier.id = pi.verified_by
`;

router.get(
  '/policies',
  requirePermission('insurance:read'),
  validate(
    listQuery.extend({
      patient_id: z.string().uuid().optional(),
      verification_status: z.string().max(20).optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req);
    const q = req.validatedQuery;

    const filters = ['pi.deleted_at IS NULL'];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.patient_id) add(q.patient_id, (p) => `pi.patient_id = ${p}`);
    if (q.verification_status) add(q.verification_status, (p) => `pi.verification_status = ${p}`);
    if (q.search) {
      add(`%${q.search}%`, (p) => `(pi.policy_number ILIKE ${p} OR (pt.first_name || ' ' || pt.last_name) ILIKE ${p} OR pt.mrn ILIKE ${p})`);
    }

    const where = filters.join(' AND ');

    const { count } = await one(
      `SELECT count(*)::int AS count FROM patient_insurance pi JOIN patients pt ON pt.id = pi.patient_id WHERE ${where}`,
      params
    );

    const list = await rows(
      `${POLICY_SELECT} WHERE ${where} ORDER BY pi.is_primary DESC, pi.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

const policySchema = z.object({
  patient_id: z.string().uuid(),
  provider_id: z.string().uuid().optional().nullable(),
  provider_name: z.string().max(120).optional().nullable(),
  policy_number: text(60, 'Policy number'),
  group_number: z.string().max(60).optional().nullable(),
  policy_holder_name: z.string().max(120).optional().nullable(),
  coverage_percent: z.coerce.number().min(0).max(1).optional().nullable(),
  copay_amount: money.default(0),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  expiration_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  is_primary: z.boolean().default(true),
});

router.post(
  '/policies',
  requirePermission('insurance:read'),
  validate(policySchema),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const patient = await one('SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL', [b.patient_id]);
    if (!patient) throw notFound('Patient');

    // Inherit the provider's defaults so a receptionist only has to type the
    // policy number for a known insurer.
    let coverage = b.coverage_percent;
    let copay = b.copay_amount;
    let providerName = b.provider_name;

    if (b.provider_id) {
      const provider = await one('SELECT * FROM insurance_providers WHERE id = $1 AND deleted_at IS NULL', [b.provider_id]);
      if (!provider) throw badRequest('That insurance provider does not exist.');
      coverage = coverage ?? Number(provider.default_coverage);
      copay = copay || Number(provider.default_copay);
      providerName = providerName ?? provider.name;
    }

    if (b.is_primary) {
      await one(
        'UPDATE patient_insurance SET is_primary = false WHERE patient_id = $1 AND deleted_at IS NULL RETURNING id',
        [b.patient_id]
      );
    }

    const policy = await one(
      `INSERT INTO patient_insurance
         (patient_id, provider_id, provider_name, policy_number, group_number,
          policy_holder_name, coverage_percent, copay_amount, effective_date,
          expiration_date, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        b.patient_id, b.provider_id ?? null, providerName ?? null, b.policy_number,
        b.group_number ?? null, b.policy_holder_name ?? null, coverage ?? null,
        copay, b.effective_date ?? null, b.expiration_date ?? null, b.is_primary,
      ]
    );

    await audit({
      req, action: 'create', entityType: 'patient_insurance', entityId: policy.id,
      description: `Added policy ${b.policy_number}`,
    });

    return created(res, policy);
  })
);

router.patch(
  '/policies/:id',
  requirePermission('insurance:read'),
  validate(policySchema.partial().omit({ patient_id: true })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'policy id');
    const existing = await one('SELECT * FROM patient_insurance WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Policy');

    const b = req.body;
    const updated = await one(
      `UPDATE patient_insurance SET
         provider_id        = COALESCE($2, provider_id),
         provider_name      = COALESCE($3, provider_name),
         policy_number      = COALESCE($4, policy_number),
         group_number       = COALESCE($5, group_number),
         policy_holder_name = COALESCE($6, policy_holder_name),
         coverage_percent   = COALESCE($7, coverage_percent),
         copay_amount       = COALESCE($8, copay_amount),
         effective_date     = COALESCE($9, effective_date),
         expiration_date    = COALESCE($10, expiration_date),
         -- Any change to the terms invalidates a previous verification.
         verification_status = CASE
           WHEN $4::text IS NOT NULL OR $7::numeric IS NOT NULL THEN 'unverified'
           ELSE verification_status END
       WHERE id = $1 RETURNING *`,
      [
        id, b.provider_id ?? null, b.provider_name ?? null, b.policy_number ?? null,
        b.group_number ?? null, b.policy_holder_name ?? null, b.coverage_percent ?? null,
        b.copay_amount ?? null, b.effective_date ?? null, b.expiration_date ?? null,
      ]
    );

    await audit({
      req, action: 'update', entityType: 'patient_insurance', entityId: id,
      changes: diffChanges(existing, updated), description: `Updated policy ${existing.policy_number}`,
    });

    return ok(res, updated);
  })
);

router.post(
  '/policies/:id/verify',
  requirePermission('insurance:verify'),
  validate(
    z.object({
      verification_status: z.enum(['verified', 'denied', 'expired', 'pending', 'unverified']),
      coverage_percent: z.coerce.number().min(0).max(1).optional().nullable(),
      copay_amount: money.optional(),
      verification_notes: z.string().max(2000).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'policy id');
    const b = req.body;

    const existing = await one('SELECT * FROM patient_insurance WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Policy');

    // Verifying a policy that has already lapsed is almost certainly a mistake.
    if (b.verification_status === 'verified' && existing.expiration_date && new Date(existing.expiration_date) < new Date()) {
      throw badRequest(`That policy expired on ${existing.expiration_date}. Mark it expired, or update the expiry date first.`);
    }

    const updated = await one(
      `UPDATE patient_insurance SET
         verification_status = $2,
         coverage_percent    = COALESCE($3, coverage_percent),
         copay_amount        = COALESCE($4, copay_amount),
         verification_notes  = COALESCE($5, verification_notes),
         verified_by         = $6,
         verified_at         = now()
       WHERE id = $1 RETURNING *`,
      [id, b.verification_status, b.coverage_percent ?? null, b.copay_amount ?? null, b.verification_notes ?? null, req.staff.id]
    );

    await audit({
      req, action: 'verify', entityType: 'patient_insurance', entityId: id,
      description: `Policy ${existing.policy_number} marked ${b.verification_status}`,
    });

    return ok(res, updated);
  })
);

router.delete(
  '/policies/:id',
  requirePermission('insurance:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'policy id');

    const inUse = await one(
      "SELECT id FROM invoices WHERE patient_insurance_id = $1 AND deleted_at IS NULL AND status NOT IN ('paid','void') LIMIT 1",
      [id]
    );
    if (inUse) throw badRequest('That policy is attached to an open invoice.');

    const removed = await one(
      'UPDATE patient_insurance SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING policy_number',
      [id]
    );
    if (!removed) throw notFound('Policy');

    await audit({ req, action: 'delete', entityType: 'patient_insurance', entityId: id, description: `Archived policy ${removed.policy_number}` });
    return ok(res, { archived: true });
  })
);

export default router;
