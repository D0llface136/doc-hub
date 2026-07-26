/**
 * Surgical records.
 *
 * GET    /api/surgery                    list
 * POST   /api/surgery                    schedule a procedure
 * GET    /api/surgery/:id                one record with the surgical team
 * PATCH  /api/surgery/:id                update details
 * POST   /api/surgery/:id/start          mark started
 * POST   /api/surgery/:id/complete       record the outcome
 * POST   /api/surgery/:id/assistants     add a team member
 * DELETE /api/surgery/:id/assistants/:assistantId
 */
import { Router } from 'express';
import { one, rows, transaction } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z, text, isoDateTime, listQuery } from '../lib/validate.js';
import { audit, diffChanges } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { notifyStaff } from '../lib/notify.js';

const router = Router();
router.use(requireAuth);

const SURGERY_SELECT = `
  SELECT sg.*,
         pt.mrn, pt.first_name, pt.last_name,
         pt.first_name || ' ' || pt.last_name AS patient_name,
         pt.blood_type,
         surgeon.full_name AS surgeon_name, surgeon.display_title AS surgeon_title,
         anaes.full_name AS anesthesiologist_name,
         v.visit_number,
         CASE WHEN sg.start_time IS NOT NULL AND sg.end_time IS NOT NULL
              THEN (extract(epoch from (sg.end_time - sg.start_time)) / 60)::int
              ELSE NULL END AS duration_minutes,
         (SELECT json_agg(json_build_object(
                    'id', sa.id, 'staff_id', sa.staff_id,
                    'name', COALESCE(a_staff.full_name, sa.staff_name),
                    'role', sa.role))
            FROM surgery_assistants sa
            LEFT JOIN staff a_staff ON a_staff.id = sa.staff_id
           WHERE sa.surgery_id = sg.id) AS assistants
    FROM surgeries sg
    JOIN patients pt ON pt.id = sg.patient_id
    LEFT JOIN staff surgeon ON surgeon.id = sg.surgeon_id
    LEFT JOIN staff anaes ON anaes.id = sg.anesthesiologist_id
    LEFT JOIN patient_visits v ON v.id = sg.visit_id
`;

router.get(
  '/',
  requirePermission('surgery:read'),
  validate(
    listQuery.extend({
      status: z.string().max(20).optional(),
      patient_id: z.string().uuid().optional(),
      surgeon_id: z.string().uuid().optional(),
    }),
    'query'
  ),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req);
    const q = req.validatedQuery;

    const filters = ['sg.deleted_at IS NULL'];
    const params = [];
    const add = (value, build) => {
      params.push(value);
      filters.push(build(`$${params.length}`));
    };

    if (q.status) add(q.status, (p) => `sg.status = ${p}`);
    if (q.patient_id) add(q.patient_id, (p) => `sg.patient_id = ${p}`);
    if (q.surgeon_id) add(q.surgeon_id, (p) => `sg.surgeon_id = ${p}`);
    if (q.search) {
      add(`%${q.search}%`, (p) => `(sg.procedure_name ILIKE ${p} OR (pt.first_name || ' ' || pt.last_name) ILIKE ${p} OR pt.mrn ILIKE ${p})`);
    }

    const where = filters.join(' AND ');

    const { count } = await one(
      `SELECT count(*)::int AS count FROM surgeries sg JOIN patients pt ON pt.id = sg.patient_id WHERE ${where}`,
      params
    );

    const list = await rows(
      `${SURGERY_SELECT} WHERE ${where}
        ORDER BY COALESCE(sg.start_time, sg.scheduled_at, sg.created_at) DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

router.post(
  '/',
  requirePermission('surgery:write'),
  validate(
    z.object({
      patient_id: z.string().uuid(),
      visit_id: z.string().uuid().optional().nullable(),
      procedure_name: text(200, 'Procedure'),
      procedure_code: z.string().max(40).optional().nullable(),
      surgeon_id: z.string().uuid().optional().nullable(),
      anesthesia_type: z.enum(['none', 'local', 'regional', 'spinal', 'general', 'sedation']).optional().nullable(),
      anesthesiologist_id: z.string().uuid().optional().nullable(),
      operating_room: z.string().max(60).optional().nullable(),
      scheduled_at: isoDateTime.optional().nullable(),
      cost: z.coerce.number().min(0).max(9_999_999).default(0),
      assistants: z
        .array(
          z.object({
            staff_id: z.string().uuid().optional().nullable(),
            staff_name: z.string().max(120).optional().nullable(),
            role: z.string().max(80).optional().nullable(),
          })
        )
        .max(20)
        .optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const patient = await one(
      'SELECT id, first_name, last_name FROM patients WHERE id = $1 AND deleted_at IS NULL',
      [b.patient_id]
    );
    if (!patient) throw notFound('Patient');

    const surgery = await transaction(async (client) => {
      const { rows: r } = await client.query(
        `INSERT INTO surgeries
           (visit_id, patient_id, procedure_name, procedure_code, surgeon_id,
            anesthesia_type, anesthesiologist_id, operating_room, scheduled_at, cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          b.visit_id ?? null, b.patient_id, b.procedure_name, b.procedure_code ?? null,
          b.surgeon_id ?? null, b.anesthesia_type ?? null, b.anesthesiologist_id ?? null,
          b.operating_room ?? null, b.scheduled_at ?? null, b.cost,
        ]
      );
      const record = r[0];

      for (const assistant of b.assistants ?? []) {
        if (!assistant.staff_id && !assistant.staff_name) continue;
        await client.query(
          `INSERT INTO surgery_assistants (surgery_id, staff_id, staff_name, role)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (surgery_id, staff_id) DO NOTHING`,
          [record.id, assistant.staff_id ?? null, assistant.staff_name ?? null, assistant.role ?? null]
        );
      }

      return record;
    });

    await audit({
      req, action: 'create', entityType: 'surgeries', entityId: surgery.id,
      description: `Scheduled ${b.procedure_name} for ${patient.first_name} ${patient.last_name}`,
    });

    if (b.surgeon_id && b.surgeon_id !== req.staff.id) {
      await notifyStaff({
        staffId: b.surgeon_id,
        type: 'info',
        title: 'Surgery scheduled',
        body: `${b.procedure_name} - ${patient.first_name} ${patient.last_name}`,
        link: `#/surgery/${surgery.id}`,
        entityType: 'surgeries',
        entityId: surgery.id,
      });
    }

    return created(res, surgery);
  })
);

router.get(
  '/:id',
  requirePermission('surgery:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'surgery id');
    const surgery = await one(`${SURGERY_SELECT} WHERE sg.id = $1 AND sg.deleted_at IS NULL`, [id]);
    if (!surgery) throw notFound('Surgical record');
    return ok(res, surgery);
  })
);

router.patch(
  '/:id',
  requirePermission('surgery:write'),
  validate(
    z.object({
      procedure_name: z.string().max(200).optional(),
      procedure_code: z.string().max(40).optional().nullable(),
      surgeon_id: z.string().uuid().optional().nullable(),
      anesthesia_type: z.enum(['none', 'local', 'regional', 'spinal', 'general', 'sedation']).optional().nullable(),
      anesthesiologist_id: z.string().uuid().optional().nullable(),
      operating_room: z.string().max(60).optional().nullable(),
      scheduled_at: isoDateTime.optional().nullable(),
      status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled', 'postponed']).optional(),
      operative_notes: z.string().max(20000).optional().nullable(),
      post_op_instructions: z.string().max(8000).optional().nullable(),
      cost: z.coerce.number().min(0).max(9_999_999).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'surgery id');
    const existing = await one('SELECT * FROM surgeries WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Surgical record');

    const b = req.body;
    const updated = await one(
      `UPDATE surgeries SET
         procedure_name       = COALESCE($2, procedure_name),
         procedure_code       = COALESCE($3, procedure_code),
         surgeon_id           = COALESCE($4, surgeon_id),
         anesthesia_type      = COALESCE($5, anesthesia_type),
         anesthesiologist_id  = COALESCE($6, anesthesiologist_id),
         operating_room       = COALESCE($7, operating_room),
         scheduled_at         = COALESCE($8, scheduled_at),
         status               = COALESCE($9, status),
         operative_notes      = COALESCE($10, operative_notes),
         post_op_instructions = COALESCE($11, post_op_instructions),
         cost                 = COALESCE($12, cost)
       WHERE id = $1 RETURNING *`,
      [
        id, b.procedure_name ?? null, b.procedure_code ?? null, b.surgeon_id ?? null,
        b.anesthesia_type ?? null, b.anesthesiologist_id ?? null, b.operating_room ?? null,
        b.scheduled_at ?? null, b.status ?? null, b.operative_notes ?? null,
        b.post_op_instructions ?? null, b.cost ?? null,
      ]
    );

    await audit({
      req, action: 'update', entityType: 'surgeries', entityId: id,
      changes: diffChanges(existing, updated),
      description: `Updated ${existing.procedure_name}`,
    });

    return ok(res, updated);
  })
);

router.post(
  '/:id/start',
  requirePermission('surgery:write'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'surgery id');

    const started = await one(
      `UPDATE surgeries
          SET status = 'in_progress', start_time = COALESCE(start_time, now())
        WHERE id = $1 AND deleted_at IS NULL AND status IN ('scheduled','postponed')
        RETURNING *`,
      [id]
    );
    if (!started) throw badRequest('That procedure is not in a state that can be started.');

    await audit({ req, action: 'start', entityType: 'surgeries', entityId: id, description: `Started ${started.procedure_name}` });
    return ok(res, started);
  })
);

router.post(
  '/:id/complete',
  requirePermission('surgery:write'),
  validate(
    z.object({
      outcome: z.enum(['successful', 'partial', 'unsuccessful', 'aborted']),
      complications: z.string().max(4000).optional().nullable(),
      operative_notes: z.string().max(20000).optional().nullable(),
      post_op_instructions: z.string().max(8000).optional().nullable(),
      end_time: isoDateTime.optional().nullable(),
    })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'surgery id');
    const b = req.body;

    const existing = await one('SELECT * FROM surgeries WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing) throw notFound('Surgical record');
    if (existing.status === 'completed') throw badRequest('That procedure is already complete.');

    const completed = await one(
      `UPDATE surgeries SET
         status               = 'completed',
         outcome              = $2,
         complications        = COALESCE($3, complications),
         operative_notes      = COALESCE($4, operative_notes),
         post_op_instructions = COALESCE($5, post_op_instructions),
         start_time           = COALESCE(start_time, now()),
         end_time             = COALESCE($6, now())
       WHERE id = $1 RETURNING *`,
      [id, b.outcome, b.complications ?? null, b.operative_notes ?? null, b.post_op_instructions ?? null, b.end_time ?? null]
    );

    await audit({
      req, action: 'complete', entityType: 'surgeries', entityId: id,
      description: `Completed ${completed.procedure_name} - outcome: ${b.outcome}`,
    });

    return ok(res, completed);
  })
);

router.post(
  '/:id/assistants',
  requirePermission('surgery:write'),
  validate(
    z
      .object({
        staff_id: z.string().uuid().optional().nullable(),
        staff_name: z.string().max(120).optional().nullable(),
        role: z.string().max(80).optional().nullable(),
      })
      .refine((d) => d.staff_id || d.staff_name, {
        message: 'Choose a staff member or type a name',
        path: ['staff_id'],
      })
  ),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'surgery id');
    const surgery = await one('SELECT id FROM surgeries WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!surgery) throw notFound('Surgical record');

    const assistant = await one(
      `INSERT INTO surgery_assistants (surgery_id, staff_id, staff_name, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (surgery_id, staff_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [id, req.body.staff_id ?? null, req.body.staff_name ?? null, req.body.role ?? null]
    );

    await audit({ req, action: 'create', entityType: 'surgery_assistants', entityId: assistant.id, description: 'Added surgical team member' });
    return created(res, assistant);
  })
);

router.delete(
  '/:id/assistants/:assistantId',
  requirePermission('surgery:write'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'surgery id');
    const assistantId = requireUuid(req.params.assistantId, 'assistant id');

    const removed = await one(
      'DELETE FROM surgery_assistants WHERE id = $1 AND surgery_id = $2 RETURNING id',
      [assistantId, id]
    );
    if (!removed) throw notFound('Team member');

    await audit({ req, action: 'delete', entityType: 'surgery_assistants', entityId: assistantId, description: 'Removed surgical team member' });
    return ok(res, { removed: true });
  })
);

export default router;
