/**
 * Notifications.
 *
 * GET    /api/notifications           my notifications
 * GET    /api/notifications/count     unread badge counts
 * POST   /api/notifications/:id/read  mark one read
 * POST   /api/notifications/read-all  mark everything read
 * DELETE /api/notifications/:id       dismiss
 */
import { Router } from 'express';
import { one, rows } from '../db/pool.js';
import { asyncHandler, ok, paginated, readPagination, requireUuid } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { validate, z, listQuery } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  validate(listQuery.extend({ unread_only: z.enum(['true', 'false']).optional(), type: z.string().max(30).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req, 30);
    const q = req.validatedQuery;

    const filters = ['staff_id = $1', '(expires_at IS NULL OR expires_at > now())'];
    const params = [req.staff.id];

    if (q.unread_only === 'true') filters.push('read_at IS NULL');
    if (q.type) {
      params.push(q.type);
      filters.push(`type = $${params.length}`);
    }

    const where = filters.join(' AND ');

    const { count } = await one(`SELECT count(*)::int AS count FROM notifications WHERE ${where}`, params);

    const list = await rows(
      `SELECT * FROM notifications WHERE ${where}
        ORDER BY read_at IS NOT NULL, created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

router.get(
  '/count',
  asyncHandler(async (req, res) => {
    const counts = await one(
      `SELECT
         (SELECT count(*) FROM notifications
           WHERE staff_id = $1 AND read_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())) AS notifications,
         (SELECT count(*) FROM notifications
           WHERE staff_id = $1 AND read_at IS NULL AND type = 'emergency'
             AND (expires_at IS NULL OR expires_at > now())) AS emergencies,
         (SELECT count(*) FROM message_recipients
           WHERE staff_id = $1 AND read_at IS NULL AND archived_at IS NULL) AS messages`,
      [req.staff.id]
    );
    return ok(res, counts);
  })
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'notification id');
    const updated = await one(
      'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND staff_id = $2 RETURNING *',
      [id, req.staff.id]
    );
    if (!updated) throw notFound('Notification');
    return ok(res, updated);
  })
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await one(
      `WITH updated AS (
         UPDATE notifications SET read_at = now()
          WHERE staff_id = $1 AND read_at IS NULL RETURNING 1)
       SELECT count(*)::int AS count FROM updated`,
      [req.staff.id]
    );
    return ok(res, { marked_read: result.count });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'notification id');
    const removed = await one('DELETE FROM notifications WHERE id = $1 AND staff_id = $2 RETURNING id', [id, req.staff.id]);
    if (!removed) throw notFound('Notification');
    return ok(res, { dismissed: true });
  })
);

export default router;
