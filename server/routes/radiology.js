/**
 * Radiology / imaging.
 *
 * GET   /api/radiology/orders                worklist
 * POST  /api/radiology/orders                order a study
 * GET   /api/radiology/orders/:id            one study with images
 * PATCH /api/radiology/orders/:id            update status / findings
 * POST  /api/radiology/orders/:id/images     attach an image URL
 * DELETE /api/radiology/orders/:id/images/:imageId
 * POST  /api/radiology/orders/:id/interpret  file the radiologist's read
 * GET   /api/radiology/summary               dashboard counts
 */
import { Router } from 'express';
import { one, rows, transaction } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z, text, listQuery } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { broadcastChange, notifyStaff, notifyRole } from '../lib/notify.js';

const router = Router();
router.use(requireAuth);

const ORDER_SELECT = `
  SELECT ro.*,
         pt.mrn, pt.first_name, pt.last_name,
         pt.first_name || ' ' || pt.last_name AS patient_name,
         orderer.full_name AS ordered_by_name,
         reader.full_name AS interpreted_by_name,
         v.visit_number,
         (extract(epoch from (now() - ro.ordered_at)) / 60)::int AS elapsed_minutes,
         (SELECT json_agg(row_to_json(a) ORDER BY a.created_at)
            FROM attachments a
           WHERE a.entity_type = 'radiology_order' AND a.entity_id = ro.id
             AND a.deleted_at IS NULL) AS images
    FROM radiology_orders ro
    JOIN patients pt ON pt.id = ro.patient_id
    LEFT JOIN staff orderer ON orderer.id = ro.ordered_by
    LEFT JOIN staff reader ON reader.id = ro.interpreted_by
    LEFT JOIN patient_visits v ON v.id = ro.visit_id
`;

router.get(
  '/orders',
  requirePermission('radiology:read'),
  validate(
    listQuery.extend({
      status: z.string().max(20).optional(),
      modality: z.string().max(20).optional(),
      patient_id: z.string().uuid().optional(),
      visit_id: z.string().uuid().optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req, 50);
    const q = req.validatedQuery;

    const filters = ['ro.deleted_at IS NULL'];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.status) add(q.status, (p) => `ro.status = ${p}`);
    if (q.modality) add(q.modality, (p) => `ro.modality = ${p}`);
    if (q.patient_id) add(q.patient_id, (p) => `ro.patient_id = ${p}`);
    if (q.visit_id) add(q.visit_id, (p) => `ro.visit_id = ${p}`);
    if (q.search) {
      add(`%${q.search}%`, (p) => `(ro.study_name ILIKE ${p} OR (pt.first_name || ' ' || pt.last_name) ILIKE ${p} OR pt.mrn ILIKE ${p})`);
    }

    const where = filters.join(' AND ');

    const { count } = await one(
      `SELECT count(*)::int AS count FROM radiology_orders ro JOIN patients pt ON pt.id = ro.patient_id WHERE ${where}`,
      params
    );

    const list = await rows(
      `${ORDER_SELECT} WHERE ${where}
        ORDER BY CASE ro.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, ro.ordered_at
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

router.get(
  '/summary',
  requirePermission('radiology:read'),
  asyncHandler(async (_req, res) => {
    const counts = await rows(
      'SELECT status, count(*)::int AS count FROM radiology_orders WHERE deleted_at IS NULL GROUP BY status'
    );
    const summary = counts.reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {
      ordered: 0, scheduled: 0, in_progress: 0, awaiting_read: 0, completed: 0, cancelled: 0,
    });
    return ok(res, summary);
  })
);

router.post(
  '/orders',
  requirePermission('radiology:order'),
  validate(
    z.object({
      patient_id: z.string().uuid(),
      visit_id: z.string().uuid().optional().nullable(),
      test_id: z.string().uuid().optional().nullable(),
      study_name: text(160, 'Study name'),
      modality: z.enum(['xray', 'ct', 'mri', 'ultrasound', 'mammogram', 'fluoroscopy', 'other']).default('xray'),
      body_part: z.string().max(120).optional().nullable(),
      priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
      clinical_history: z.string().max(4000).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const patient = await one(
      'SELECT id, mrn, first_name, last_name FROM patients WHERE id = $1 AND deleted_at IS NULL',
      [b.patient_id]
    );
    if (!patient) throw notFound('Patient');

    const order = await one(
      `INSERT INTO radiology_orders
         (visit_id, patient_id, test_id, study_name, modality, body_part,
          priority, clinical_history, ordered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        b.visit_id ?? null, b.patient_id, b.test_id ?? null, b.study_name,
        b.modality, b.body_part ?? null, b.priority, b.clinical_history ?? null, req.staff.id,
      ]
    );

    await audit({
      req, action: 'create', entityType: 'radiology_orders', entityId: order.id,
      description: `Ordered ${b.modality.toUpperCase()} ${b.study_name} for ${patient.first_name} ${patient.last_name}`,
    });

    broadcastChange('radiology', { orderId: order.id });

    await notifyRole({
      roleCode: 'radiology_tech',
      type: b.priority === 'stat' ? 'warning' : 'info',
      title: b.priority === 'stat' ? 'STAT imaging order' : 'New imaging order',
      body: `${b.study_name} - ${patient.first_name} ${patient.last_name} (${patient.mrn})`,
      link: '#/radiology',
      entityType: 'radiology_orders',
      entityId: order.id,
    });

    return created(res, order);
  })
);

router.get(
  '/orders/:id',
  requirePermission('radiology:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'order id');
    const order = await one(`${ORDER_SELECT} WHERE ro.id = $1 AND ro.deleted_at IS NULL`, [id]);
    if (!order) throw notFound('Imaging order');
    return ok(res, order);
  })
);

router.patch(
  '/orders/:id',
  requirePermission('radiology:read'),
  validate(
    z.object({
      status: z.enum(['ordered', 'scheduled', 'in_progress', 'awaiting_read', 'completed', 'cancelled']).optional(),
      priority: z.enum(['routine', 'urgent', 'stat']).optional(),
      body_part: z.string().max(120).optional().nullable(),
      findings: z.string().max(8000).optional().nullable(),
      clinical_history: z.string().max(4000).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'order id');
    const b = req.body;

    const updated = await one(
      `UPDATE radiology_orders SET
         status           = COALESCE($2, status),
         priority         = COALESCE($3, priority),
         body_part        = COALESCE($4, body_part),
         findings         = COALESCE($5, findings),
         clinical_history = COALESCE($6, clinical_history),
         completed_at     = CASE WHEN $2 = 'completed' AND completed_at IS NULL THEN now() ELSE completed_at END
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id, b.status ?? null, b.priority ?? null, b.body_part ?? null, b.findings ?? null, b.clinical_history ?? null]
    );
    if (!updated) throw notFound('Imaging order');

    await audit({ req, action: 'update', entityType: 'radiology_orders', entityId: id, description: `Updated ${updated.study_name}` });
    broadcastChange('radiology', { orderId: id });

    return ok(res, updated);
  })
);

/**
 * Attach an image. Second Life texture UUIDs and external image hosts are both
 * common, so we store a URL rather than binary data - the SL browser can render
 * either, and the service stays stateless.
 */
router.post(
  '/orders/:id/images',
  requirePermission('radiology:read'),
  validate(
    z.object({
      file_name: text(200, 'File name'),
      file_url: z.string().url('Must be a valid URL').max(1000),
      mime_type: z.string().max(100).optional().nullable(),
      caption: z.string().max(300).optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'order id');

    const order = await one('SELECT id, study_name, status FROM radiology_orders WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!order) throw notFound('Imaging order');

    const image = await transaction(async (client) => {
      const { rows: r } = await client.query(
        `INSERT INTO attachments (entity_type, entity_id, file_name, file_url, mime_type, caption, uploaded_by)
         VALUES ('radiology_order', $1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, req.body.file_name, req.body.file_url, req.body.mime_type ?? null, req.body.caption ?? null, req.staff.id]
      );

      // The first image means the study has actually been performed.
      if (['ordered', 'scheduled', 'in_progress'].includes(order.status)) {
        await client.query("UPDATE radiology_orders SET status = 'awaiting_read' WHERE id = $1", [id]);
      }

      return r[0];
    });

    await audit({
      req, action: 'upload', entityType: 'radiology_orders', entityId: id,
      description: `Uploaded image "${req.body.file_name}" to ${order.study_name}`,
    });

    broadcastChange('radiology', { orderId: id, status: 'awaiting_read' });

    return created(res, image);
  })
);

router.delete(
  '/orders/:id/images/:imageId',
  requirePermission('radiology:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'order id');
    const imageId = requireUuid(req.params.imageId, 'image id');

    const removed = await one(
      `UPDATE attachments SET deleted_at = now()
        WHERE id = $1 AND entity_type = 'radiology_order' AND entity_id = $2 AND deleted_at IS NULL
        RETURNING id, file_name`,
      [imageId, id]
    );
    if (!removed) throw notFound('Image');

    await audit({ req, action: 'delete', entityType: 'attachments', entityId: imageId, description: `Removed image "${removed.file_name}"` });
    return ok(res, { removed: true });
  })
);

router.post(
  '/orders/:id/interpret',
  requirePermission('radiology:interpret'),
  validate(
    z.object({
      findings: z.string().max(8000).optional().nullable(),
      impression: text(8000, 'Impression'),
      mark_complete: z.boolean().default(true),
      is_critical: z.boolean().default(false),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'order id');
    const b = req.body;

    const order = await one(
      `SELECT ro.*, pt.first_name || ' ' || pt.last_name AS patient_name, pt.mrn
         FROM radiology_orders ro JOIN patients pt ON pt.id = ro.patient_id
        WHERE ro.id = $1 AND ro.deleted_at IS NULL`,
      [id]
    );
    if (!order) throw notFound('Imaging order');
    if (order.status === 'cancelled') throw badRequest('That study was cancelled.');

    const updated = await one(
      `UPDATE radiology_orders SET
         findings       = COALESCE($2, findings),
         impression     = $3,
         interpreted_by = $4,
         interpreted_at = now(),
         status         = CASE WHEN $5 THEN 'completed' ELSE status END,
         completed_at   = CASE WHEN $5 AND completed_at IS NULL THEN now() ELSE completed_at END
       WHERE id = $1 RETURNING *`,
      [id, b.findings ?? null, b.impression, req.staff.id, b.mark_complete]
    );

    await audit({
      req, action: 'interpret', entityType: 'radiology_orders', entityId: id,
      description: `Interpreted ${order.study_name} for ${order.patient_name}${b.is_critical ? ' (CRITICAL)' : ''}`,
    });

    broadcastChange('radiology', { orderId: id, status: updated.status });

    if (order.ordered_by) {
      await notifyStaff({
        staffId: order.ordered_by,
        type: b.is_critical ? 'emergency' : 'info',
        title: b.is_critical ? 'CRITICAL imaging finding' : 'Imaging report available',
        body: `${order.study_name} - ${order.patient_name}: ${b.impression.slice(0, 160)}`,
        link: order.visit_id ? `#/visits/${order.visit_id}` : `#/patients/${order.patient_id}`,
        entityType: 'radiology_orders',
        entityId: id,
      });
    }

    return ok(res, updated);
  })
);

export default router;
