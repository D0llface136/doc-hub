/**
 * Internal staff messaging.
 *
 * GET  /api/messages/inbox           messages addressed to me
 * GET  /api/messages/sent            messages I sent
 * GET  /api/messages/:id             one thread entry with its read receipts
 * POST /api/messages                 send to a department and/or named staff
 * POST /api/messages/:id/read        mark read
 * POST /api/messages/read-all        mark everything read
 * DELETE /api/messages/:id           archive from my inbox
 *
 * A message can target a department (broadcast) and/or a list of individuals.
 * Either way a row in message_recipients is created per person, which is what
 * makes per-person read receipts possible.
 */
import { Router } from 'express';
import { one, rows, transaction } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z, text, listQuery } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { publishToStaff } from '../lib/events.js';

const router = Router();
router.use(requireAuth);

const DEPARTMENTS = ['reception', 'nursing', 'doctors', 'laboratory', 'pharmacy', 'radiology', 'administration', 'all'];

/** Which roles receive a message sent to a given department. */
const DEPARTMENT_ROLES = {
  reception: ['receptionist'],
  nursing: ['nurse'],
  doctors: ['doctor'],
  laboratory: ['lab_tech'],
  pharmacy: ['pharmacist'],
  radiology: ['radiology_tech'],
  administration: ['administrator'],
};

router.get(
  '/inbox',
  requirePermission('messaging:read'),
  validate(listQuery.extend({ unread_only: z.enum(['true', 'false']).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req);
    const unreadOnly = req.validatedQuery.unread_only === 'true';

    const filters = ['mr.staff_id = $1', 'mr.archived_at IS NULL', 'm.deleted_at IS NULL'];
    const params = [req.staff.id];

    if (unreadOnly) filters.push('mr.read_at IS NULL');
    if (req.validatedQuery.search) {
      params.push(`%${req.validatedQuery.search}%`);
      filters.push(`(m.subject ILIKE $${params.length} OR m.body ILIKE $${params.length})`);
    }

    const where = filters.join(' AND ');

    const { count } = await one(
      `SELECT count(*)::int AS count
         FROM message_recipients mr JOIN internal_messages m ON m.id = mr.message_id
        WHERE ${where}`,
      params
    );

    const list = await rows(
      `SELECT m.id, m.subject, m.body, m.priority, m.department, m.created_at,
              m.related_patient_id, m.related_visit_id,
              mr.read_at, mr.id AS recipient_id,
              sender.full_name AS sender_name, sender.display_title AS sender_title,
              sender_role.name AS sender_role,
              pt.first_name || ' ' || pt.last_name AS related_patient_name
         FROM message_recipients mr
         JOIN internal_messages m ON m.id = mr.message_id
         LEFT JOIN staff sender ON sender.id = m.sender_id
         LEFT JOIN staff_roles sender_role ON sender_role.id = sender.role_id
         LEFT JOIN patients pt ON pt.id = m.related_patient_id
        WHERE ${where}
        ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                 m.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

router.get(
  '/sent',
  requirePermission('messaging:read'),
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req);

    const { count } = await one(
      'SELECT count(*)::int AS count FROM internal_messages WHERE sender_id = $1 AND deleted_at IS NULL',
      [req.staff.id]
    );

    const list = await rows(
      `SELECT m.*,
              (SELECT count(*) FROM message_recipients mr WHERE mr.message_id = m.id) AS recipient_count,
              (SELECT count(*) FROM message_recipients mr WHERE mr.message_id = m.id AND mr.read_at IS NOT NULL) AS read_count
         FROM internal_messages m
        WHERE m.sender_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT $2 OFFSET $3`,
      [req.staff.id, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

router.post(
  '/',
  requirePermission('messaging:write'),
  validate(
    z
      .object({
        department: z.enum(DEPARTMENTS).optional().nullable(),
        recipient_ids: z.array(z.string().uuid()).max(100).optional(),
        subject: z.string().max(200).optional().nullable(),
        body: text(10000, 'Message'),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
        related_patient_id: z.string().uuid().optional().nullable(),
        related_visit_id: z.string().uuid().optional().nullable(),
      })
      .refine((d) => d.department || (d.recipient_ids && d.recipient_ids.length > 0), {
        message: 'Choose a department or at least one recipient',
        path: ['department'],
      })
  ),
  asyncHandler(async (req, res) => {
    const b = req.body;

    const result = await transaction(async (client) => {
      const { rows: inserted } = await client.query(
        `INSERT INTO internal_messages
           (sender_id, department, subject, body, priority, related_patient_id, related_visit_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          req.staff.id, b.department ?? null, b.subject ?? null, b.body,
          b.priority, b.related_patient_id ?? null, b.related_visit_id ?? null,
        ]
      );
      const message = inserted[0];

      // Build the recipient set from the department expansion plus any named
      // individuals, de-duplicated, excluding the sender.
      const recipientIds = new Set(b.recipient_ids ?? []);

      if (b.department) {
        const roleCodes = b.department === 'all' ? null : DEPARTMENT_ROLES[b.department] ?? [];
        const { rows: staffRows } = await client.query(
          `SELECT s.id FROM staff s JOIN staff_roles r ON r.id = s.role_id
            WHERE s.deleted_at IS NULL AND s.status = 'active'
              AND ($1::text[] IS NULL OR r.code = ANY($1))`,
          [roleCodes]
        );
        staffRows.forEach((row) => recipientIds.add(row.id));
      }

      recipientIds.delete(req.staff.id);

      if (recipientIds.size === 0) {
        throw badRequest('That message has no recipients - the department may be empty.');
      }

      for (const staffId of recipientIds) {
        await client.query(
          `INSERT INTO message_recipients (message_id, staff_id) VALUES ($1,$2)
           ON CONFLICT (message_id, staff_id) DO NOTHING`,
          [message.id, staffId]
        );
      }

      return { message, recipientIds: [...recipientIds] };
    });

    // Push it live to anyone currently connected.
    for (const staffId of result.recipientIds) {
      publishToStaff(staffId, 'message', {
        id: result.message.id,
        subject: result.message.subject,
        body: result.message.body,
        priority: result.message.priority,
        sender_name: req.staff.full_name,
        created_at: result.message.created_at,
      });
    }

    await audit({
      req, action: 'create', entityType: 'internal_messages', entityId: result.message.id,
      description: `Sent ${b.priority} message to ${result.recipientIds.length} recipient(s)`,
    });

    return created(res, { ...result.message, recipient_count: result.recipientIds.length });
  })
);

router.get(
  '/:id',
  requirePermission('messaging:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'message id');

    const message = await one(
      `SELECT m.*, sender.full_name AS sender_name, sender.display_title AS sender_title
         FROM internal_messages m
         LEFT JOIN staff sender ON sender.id = m.sender_id
        WHERE m.id = $1 AND m.deleted_at IS NULL`,
      [id]
    );
    if (!message) throw notFound('Message');

    const isRecipient = await one(
      'SELECT id FROM message_recipients WHERE message_id = $1 AND staff_id = $2',
      [id, req.staff.id]
    );
    if (!isRecipient && message.sender_id !== req.staff.id) throw notFound('Message');

    // Read receipts are visible to the sender; recipients just see their own.
    const receipts =
      message.sender_id === req.staff.id
        ? await rows(
            `SELECT mr.staff_id, mr.read_at, s.full_name
               FROM message_recipients mr JOIN staff s ON s.id = mr.staff_id
              WHERE mr.message_id = $1 ORDER BY s.full_name`,
            [id]
          )
        : [];

    return ok(res, { ...message, receipts, my_read_at: isRecipient ? undefined : null });
  })
);

router.post(
  '/:id/read',
  requirePermission('messaging:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'message id');

    const updated = await one(
      `UPDATE message_recipients SET read_at = COALESCE(read_at, now())
        WHERE message_id = $1 AND staff_id = $2 RETURNING *`,
      [id, req.staff.id]
    );
    if (!updated) throw notFound('Message');

    return ok(res, updated);
  })
);

router.post(
  '/read-all',
  requirePermission('messaging:read'),
  asyncHandler(async (req, res) => {
    const result = await one(
      `WITH updated AS (
         UPDATE message_recipients SET read_at = now()
          WHERE staff_id = $1 AND read_at IS NULL RETURNING 1)
       SELECT count(*)::int AS count FROM updated`,
      [req.staff.id]
    );
    return ok(res, { marked_read: result.count });
  })
);

router.delete(
  '/:id',
  requirePermission('messaging:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'message id');

    const archived = await one(
      'UPDATE message_recipients SET archived_at = now() WHERE message_id = $1 AND staff_id = $2 RETURNING id',
      [id, req.staff.id]
    );
    if (!archived) throw notFound('Message');

    return ok(res, { archived: true });
  })
);

export default router;
