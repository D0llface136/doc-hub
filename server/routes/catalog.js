/**
 * Reference catalogues: medications, diagnoses, symptoms and orderable tests.
 *
 * GET    /api/catalog/medications      search the formulary
 * POST   /api/catalog/medications      add                    (catalog:manage)
 * PATCH  /api/catalog/medications/:id  edit                   (catalog:manage)
 * DELETE /api/catalog/medications/:id  retire                 (catalog:manage)
 * POST   /api/catalog/medications/:id/stock  adjust inventory (catalog:manage)
 *
 * ...and the same shape for /diagnoses, /symptoms and /lab-tests.
 *
 * These are the lists the clinical screens search against, so read access is
 * open to any signed-in staff member while editing needs catalog:manage.
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

// --- Medications -----------------------------------------------------------

router.get(
  '/medications',
  validate(
    listQuery.extend({
      category: z.string().max(60).optional(),
      controlled: z.enum(['true', 'false']).optional(),
      in_stock: z.enum(['true', 'false']).optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req, 50);
    const q = req.validatedQuery;

    const filters = ['m.deleted_at IS NULL'];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.search) {
      add(`%${q.search}%`, (p) => `(m.name ILIKE ${p} OR m.generic_name ILIKE ${p} OR m.category ILIKE ${p})`);
    }
    if (q.category) add(q.category, (p) => `m.category = ${p}`);
    if (q.controlled) add(q.controlled === 'true', (p) => `m.is_controlled = ${p}`);
    if (q.in_stock === 'true') filters.push('m.stock_quantity > 0');

    const where = filters.join(' AND ');

    const { count } = await one(`SELECT count(*)::int AS count FROM medications m WHERE ${where}`, params);

    const list = await rows(
      `SELECT m.*,
              (m.stock_quantity <= m.reorder_level) AS needs_reorder,
              (SELECT count(*) FROM prescriptions rx
                WHERE rx.medication_id = m.id AND rx.deleted_at IS NULL
                  AND rx.prescribed_at > now() - interval '30 days') AS prescribed_last_30d
         FROM medications m
        WHERE ${where}
        ORDER BY m.is_active DESC, m.name
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

const medicationSchema = z.object({
  name: text(160, 'Medication name'),
  generic_name: z.string().max(160).optional().nullable(),
  form: z.enum(['tablet', 'capsule', 'liquid', 'injection', 'topical', 'inhaler', 'patch', 'suppository', 'drops', 'other']).optional().nullable(),
  strength: z.string().max(60).optional().nullable(),
  category: z.string().max(80).optional().nullable(),
  is_controlled: z.boolean().default(false),
  requires_approval: z.boolean().default(false),
  default_dosage: z.string().max(80).optional().nullable(),
  default_frequency: z.string().max(80).optional().nullable(),
  default_instructions: z.string().max(500).optional().nullable(),
  unit_cost: money.default(0),
  stock_quantity: z.coerce.number().int().min(0).max(1_000_000).default(0),
  reorder_level: z.coerce.number().int().min(0).max(100_000).default(10),
  contraindications: z.string().max(2000).optional().nullable(),
  is_active: z.boolean().default(true),
});

router.post(
  '/medications',
  requirePermission('catalog:manage'),
  validate(medicationSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const medication = await one(
      `INSERT INTO medications
         (name, generic_name, form, strength, category, is_controlled, requires_approval,
          default_dosage, default_frequency, default_instructions, unit_cost,
          stock_quantity, reorder_level, contraindications, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        b.name, b.generic_name ?? null, b.form ?? null, b.strength ?? null, b.category ?? null,
        b.is_controlled, b.requires_approval, b.default_dosage ?? null, b.default_frequency ?? null,
        b.default_instructions ?? null, b.unit_cost, b.stock_quantity, b.reorder_level,
        b.contraindications ?? null, b.is_active,
      ]
    );

    await audit({ req, action: 'create', entityType: 'medications', entityId: medication.id, description: `Added ${b.name} to the formulary` });
    return created(res, medication);
  })
);

router.patch(
  '/medications/:id',
  requirePermission('catalog:manage'),
  validate(medicationSchema.partial()),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'medication id');
    const existing = await one('SELECT * FROM medications WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Medication');

    const b = req.body;
    const updated = await one(
      `UPDATE medications SET
         name                 = COALESCE($2, name),
         generic_name         = COALESCE($3, generic_name),
         form                 = COALESCE($4, form),
         strength             = COALESCE($5, strength),
         category             = COALESCE($6, category),
         is_controlled        = COALESCE($7, is_controlled),
         requires_approval    = COALESCE($8, requires_approval),
         default_dosage       = COALESCE($9, default_dosage),
         default_frequency    = COALESCE($10, default_frequency),
         default_instructions = COALESCE($11, default_instructions),
         unit_cost            = COALESCE($12, unit_cost),
         stock_quantity       = COALESCE($13, stock_quantity),
         reorder_level        = COALESCE($14, reorder_level),
         contraindications    = COALESCE($15, contraindications),
         is_active            = COALESCE($16, is_active)
       WHERE id = $1 RETURNING *`,
      [
        id, b.name ?? null, b.generic_name ?? null, b.form ?? null, b.strength ?? null,
        b.category ?? null,
        b.is_controlled === undefined ? null : b.is_controlled,
        b.requires_approval === undefined ? null : b.requires_approval,
        b.default_dosage ?? null, b.default_frequency ?? null, b.default_instructions ?? null,
        b.unit_cost ?? null, b.stock_quantity ?? null, b.reorder_level ?? null,
        b.contraindications ?? null,
        b.is_active === undefined ? null : b.is_active,
      ]
    );

    await audit({
      req, action: 'update', entityType: 'medications', entityId: id,
      changes: diffChanges(existing, updated), description: `Updated ${existing.name}`,
    });

    return ok(res, updated);
  })
);

/** Stock adjustment with a reason, kept separate so it lands in the audit log. */
router.post(
  '/medications/:id/stock',
  requirePermission('catalog:manage'),
  validate(
    z.object({
      // Positive to receive stock, negative to write it off.
      adjustment: z.coerce.number().int().min(-100_000).max(100_000),
      reason: text(300, 'Reason'),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'medication id');

    const updated = await one(
      `UPDATE medications SET stock_quantity = GREATEST(stock_quantity + $2, 0)
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, req.body.adjustment]
    );
    if (!updated) throw notFound('Medication');

    await audit({
      req, action: 'stock_adjust', entityType: 'medications', entityId: id,
      changes: { stock_quantity: { from: updated.stock_quantity - req.body.adjustment, to: updated.stock_quantity } },
      description: `${req.body.adjustment >= 0 ? 'Received' : 'Removed'} ${Math.abs(req.body.adjustment)} x ${updated.name}: ${req.body.reason}`,
    });

    return ok(res, updated);
  })
);

router.delete(
  '/medications/:id',
  requirePermission('catalog:manage'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'medication id');

    const active = await one(
      `SELECT count(*)::int AS count FROM prescriptions
        WHERE medication_id = $1 AND deleted_at IS NULL
          AND status IN ('active','sent_to_pharmacy','filled')`,
      [id]
    );
    if (active.count > 0) {
      throw badRequest(`${active.count} active prescription(s) use this medication. Deactivate it instead of removing it.`);
    }

    const removed = await one(
      'UPDATE medications SET deleted_at = now(), is_active = false WHERE id = $1 AND deleted_at IS NULL RETURNING name',
      [id]
    );
    if (!removed) throw notFound('Medication');

    await audit({ req, action: 'delete', entityType: 'medications', entityId: id, description: `Retired ${removed.name}` });
    return ok(res, { retired: true });
  })
);

// --- Diagnoses -------------------------------------------------------------

router.get(
  '/diagnoses',
  validate(listQuery.extend({ category: z.string().max(60).optional(), common_only: z.enum(['true', 'false']).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req, 50);
    const q = req.validatedQuery;

    const filters = ['d.deleted_at IS NULL', 'd.is_active = true'];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.search) add(`%${q.search}%`, (p) => `(d.name ILIKE ${p} OR d.code ILIKE ${p} OR d.category ILIKE ${p})`);
    if (q.category) add(q.category, (p) => `d.category = ${p}`);
    if (q.common_only === 'true') filters.push('d.is_common = true');

    const where = filters.join(' AND ');

    const { count } = await one(`SELECT count(*)::int AS count FROM diagnoses d WHERE ${where}`, params);

    const list = await rows(
      `SELECT d.*,
              (SELECT count(*) FROM visit_diagnoses vd WHERE vd.diagnosis_id = d.id) AS use_count
         FROM diagnoses d
        WHERE ${where}
        ORDER BY d.is_common DESC, d.name
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

const diagnosisSchema = z.object({
  code: z.string().max(40).optional().nullable(),
  name: text(200, 'Diagnosis name'),
  category: z.string().max(80).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  severity: z.enum(['mild', 'moderate', 'severe', 'critical']).optional().nullable(),
  is_common: z.boolean().default(false),
  is_active: z.boolean().default(true),
});

router.post(
  '/diagnoses',
  requirePermission('diagnoses:write'),
  validate(diagnosisSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const diagnosis = await one(
      `INSERT INTO diagnoses (code, name, category, description, severity, is_common, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.code ?? null, b.name, b.category ?? null, b.description ?? null, b.severity ?? null, b.is_common, b.is_active, req.staff.id]
    );

    await audit({ req, action: 'create', entityType: 'diagnoses', entityId: diagnosis.id, description: `Added diagnosis "${b.name}"` });
    return created(res, diagnosis);
  })
);

router.patch(
  '/diagnoses/:id',
  requirePermission('catalog:manage'),
  validate(diagnosisSchema.partial()),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'diagnosis id');
    const existing = await one('SELECT * FROM diagnoses WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Diagnosis');

    const b = req.body;
    const updated = await one(
      `UPDATE diagnoses SET
         code        = COALESCE($2, code),
         name        = COALESCE($3, name),
         category    = COALESCE($4, category),
         description = COALESCE($5, description),
         severity    = COALESCE($6, severity),
         is_common   = COALESCE($7, is_common),
         is_active   = COALESCE($8, is_active)
       WHERE id = $1 RETURNING *`,
      [
        id, b.code ?? null, b.name ?? null, b.category ?? null, b.description ?? null,
        b.severity ?? null,
        b.is_common === undefined ? null : b.is_common,
        b.is_active === undefined ? null : b.is_active,
      ]
    );

    await audit({ req, action: 'update', entityType: 'diagnoses', entityId: id, changes: diffChanges(existing, updated), description: `Updated "${existing.name}"` });
    return ok(res, updated);
  })
);

router.delete(
  '/diagnoses/:id',
  requirePermission('catalog:manage'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'diagnosis id');
    const removed = await one(
      'UPDATE diagnoses SET deleted_at = now(), is_active = false WHERE id = $1 AND deleted_at IS NULL RETURNING name',
      [id]
    );
    if (!removed) throw notFound('Diagnosis');

    await audit({ req, action: 'delete', entityType: 'diagnoses', entityId: id, description: `Retired diagnosis "${removed.name}"` });
    return ok(res, { retired: true });
  })
);

// --- Symptoms --------------------------------------------------------------

router.get(
  '/symptoms',
  validate(listQuery.extend({ common_only: z.enum(['true', 'false']).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validatedQuery;

    const list = await rows(
      `SELECT * FROM symptoms
        WHERE is_active = true
          AND ($1::text IS NULL OR name ILIKE $1)
          AND ($2::boolean IS NULL OR is_common = $2)
        ORDER BY is_common DESC, sort_order, name`,
      [q.search ? `%${q.search}%` : null, q.common_only === 'true' ? true : null]
    );

    return ok(res, list);
  })
);

router.post(
  '/symptoms',
  requirePermission('catalog:manage'),
  validate(
    z.object({
      name: text(120, 'Symptom name'),
      category: z.string().max(80).optional().nullable(),
      description: z.string().max(1000).optional().nullable(),
      is_common: z.boolean().default(false),
      sort_order: z.coerce.number().int().min(0).max(9999).default(100),
    })
  ),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const symptom = await one(
      `INSERT INTO symptoms (name, category, description, is_common, sort_order)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (name) DO UPDATE SET is_active = true, is_common = EXCLUDED.is_common
       RETURNING *`,
      [b.name, b.category ?? null, b.description ?? null, b.is_common, b.sort_order]
    );

    await audit({ req, action: 'create', entityType: 'symptoms', entityId: symptom.id, description: `Added symptom "${b.name}"` });
    return created(res, symptom);
  })
);

router.delete(
  '/symptoms/:id',
  requirePermission('catalog:manage'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'symptom id');
    const removed = await one('UPDATE symptoms SET is_active = false WHERE id = $1 RETURNING name', [id]);
    if (!removed) throw notFound('Symptom');

    await audit({ req, action: 'delete', entityType: 'symptoms', entityId: id, description: `Retired symptom "${removed.name}"` });
    return ok(res, { retired: true });
  })
);

// --- Orderable tests (laboratory and imaging) ------------------------------

router.get(
  '/lab-tests',
  validate(listQuery.extend({ category: z.string().max(30).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validatedQuery;

    const list = await rows(
      `SELECT * FROM lab_test_catalog
        WHERE is_active = true
          AND ($1::text IS NULL OR name ILIKE $1 OR code ILIKE $1)
          AND ($2::text IS NULL OR category = $2)
        ORDER BY category, name`,
      [q.search ? `%${q.search}%` : null, q.category ?? null]
    );

    return ok(res, list);
  })
);

const labTestSchema = z.object({
  code: z.string().max(40).optional().nullable(),
  name: text(160, 'Test name'),
  category: z.enum(['laboratory', 'imaging', 'pathology', 'other']).default('laboratory'),
  modality: z.string().max(40).optional().nullable(),
  specimen_type: z.string().max(60).optional().nullable(),
  turnaround_minutes: z.coerce.number().int().min(1).max(10_080).default(30),
  reference_range: z.string().max(160).optional().nullable(),
  unit: z.string().max(40).optional().nullable(),
  cost: money.default(0),
  is_active: z.boolean().default(true),
});

router.post(
  '/lab-tests',
  requirePermission('catalog:manage'),
  validate(labTestSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const test = await one(
      `INSERT INTO lab_test_catalog
         (code, name, category, modality, specimen_type, turnaround_minutes,
          reference_range, unit, cost, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        b.code ?? null, b.name, b.category, b.modality ?? null, b.specimen_type ?? null,
        b.turnaround_minutes, b.reference_range ?? null, b.unit ?? null, b.cost, b.is_active,
      ]
    );

    await audit({ req, action: 'create', entityType: 'lab_test_catalog', entityId: test.id, description: `Added test "${b.name}"` });
    return created(res, test);
  })
);

router.patch(
  '/lab-tests/:id',
  requirePermission('catalog:manage'),
  validate(labTestSchema.partial()),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'test id');
    const existing = await one('SELECT * FROM lab_test_catalog WHERE id = $1', [id]);
    if (!existing) throw notFound('Test');

    const b = req.body;
    const updated = await one(
      `UPDATE lab_test_catalog SET
         code               = COALESCE($2, code),
         name               = COALESCE($3, name),
         category           = COALESCE($4, category),
         modality           = COALESCE($5, modality),
         specimen_type      = COALESCE($6, specimen_type),
         turnaround_minutes = COALESCE($7, turnaround_minutes),
         reference_range    = COALESCE($8, reference_range),
         unit               = COALESCE($9, unit),
         cost               = COALESCE($10, cost),
         is_active          = COALESCE($11, is_active)
       WHERE id = $1 RETURNING *`,
      [
        id, b.code ?? null, b.name ?? null, b.category ?? null, b.modality ?? null,
        b.specimen_type ?? null, b.turnaround_minutes ?? null, b.reference_range ?? null,
        b.unit ?? null, b.cost ?? null,
        b.is_active === undefined ? null : b.is_active,
      ]
    );

    await audit({ req, action: 'update', entityType: 'lab_test_catalog', entityId: id, changes: diffChanges(existing, updated), description: `Updated test "${existing.name}"` });
    return ok(res, updated);
  })
);

export default router;
