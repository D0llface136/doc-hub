/**
 * Staff and role management.
 *
 * GET    /api/staff                 directory (paginated, filterable)
 * GET    /api/staff/active          who is on duty right now
 * GET    /api/staff/permissions     the permission catalogue
 * GET    /api/staff/roles           roles and their permissions
 * POST   /api/staff/roles           create a role            (settings:manage)
 * PATCH  /api/staff/roles/:id       edit a role              (settings:manage)
 * GET    /api/staff/:id             one staff member
 * POST   /api/staff                 create an account        (staff:manage)
 * PATCH  /api/staff/:id             edit an account          (staff:manage)
 * POST   /api/staff/:id/password    force a password reset   (staff:manage)
 * DELETE /api/staff/:id             archive an account       (staff:manage)
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';
import { one, rows, query } from '../db/pool.js';
import { asyncHandler, ok, created, paginated, readPagination, readSort, requireUuid } from '../lib/http.js';
import { badRequest, notFound, forbidden, conflict } from '../lib/errors.js';
import { validate, z, text, listQuery } from '../lib/validate.js';
import { audit, diffChanges } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS, ALL_PERMISSIONS, expandPermissions } from '../lib/permissions.js';

const router = Router();

router.use(requireAuth);

const SORTABLE = {
  name: 's.full_name',
  role: 'r.rank',
  status: 's.status',
  last_login: 's.last_login_at',
  created: 's.created_at',
};

// --- Directory -------------------------------------------------------------

router.get(
  '/',
  requirePermission('staff:read'),
  validate(listQuery.extend({ role: z.string().max(40).optional(), status: z.string().max(20).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = readPagination(req);
    const { search, role, status } = req.validatedQuery;
    const orderBy = readSort(req, SORTABLE, 'name');

    const filters = ['s.deleted_at IS NULL'];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      filters.push(`(s.full_name ILIKE $${params.length} OR s.username ILIKE $${params.length}
                     OR s.staff_number ILIKE $${params.length})`);
    }
    if (role) {
      params.push(role);
      filters.push(`r.code = $${params.length}`);
    }
    if (status) {
      params.push(status);
      filters.push(`s.status = $${params.length}`);
    }

    const where = filters.join(' AND ');

    const { count } = await one(
      `SELECT count(*)::int AS count FROM staff s JOIN staff_roles r ON r.id = s.role_id WHERE ${where}`,
      params
    );

    const list = await rows(
      `SELECT s.id, s.staff_number, s.username, s.full_name, s.display_title,
              s.department, s.email, s.status, s.is_on_duty, s.sl_avatar_name,
              s.last_login_at, s.last_seen_at, s.created_at,
              r.code AS role_code, r.name AS role_name, r.rank AS role_rank
         FROM staff s
         JOIN staff_roles r ON r.id = s.role_id
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return paginated(res, list, { page, limit, total: count });
  })
);

/** Staff currently on duty, used by the dashboard "active doctors" widget. */
router.get(
  '/active',
  asyncHandler(async (req, res) => {
    const list = await rows(
      `SELECT s.id, s.full_name, s.display_title, s.department, s.last_seen_at,
              r.code AS role_code, r.name AS role_name,
              (SELECT count(*) FROM patient_visits v
                WHERE v.assigned_doctor_id = s.id AND v.status = 'being_seen'
                  AND v.deleted_at IS NULL) AS active_patients
         FROM staff s
         JOIN staff_roles r ON r.id = s.role_id
        WHERE s.deleted_at IS NULL AND s.status = 'active' AND s.is_on_duty = true
        ORDER BY r.rank, s.full_name`
    );
    return ok(res, list);
  })
);

router.get('/permissions', asyncHandler(async (_req, res) => ok(res, PERMISSIONS)));

// --- Roles -----------------------------------------------------------------

router.get(
  '/roles',
  asyncHandler(async (_req, res) => {
    const list = await rows(
      `SELECT r.id, r.code, r.name, r.description, r.permissions, r.rank, r.is_system,
              (SELECT count(*) FROM staff s WHERE s.role_id = r.id AND s.deleted_at IS NULL) AS staff_count
         FROM staff_roles r
        ORDER BY r.rank, r.name`
    );
    return ok(
      res,
      list.map((role) => ({ ...role, effectivePermissions: expandPermissions(role.permissions) }))
    );
  })
);

const roleSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscores'),
  name: text(80, 'Role name'),
  description: z.string().max(500).optional().nullable(),
  rank: z.coerce.number().int().min(0).max(999).default(100),
  permissions: z
    .array(z.string())
    .max(200)
    .refine(
      (list) => list.every((p) => p === '*' || p.endsWith(':*') || ALL_PERMISSIONS.includes(p)),
      'Contains a permission that does not exist'
    ),
});

router.post(
  '/roles',
  requirePermission('settings:manage'),
  validate(roleSchema),
  asyncHandler(async (req, res) => {
    const { code, name, description, rank, permissions } = req.body;

    const role = await one(
      `INSERT INTO staff_roles (code, name, description, rank, permissions)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [code, name, description ?? null, rank, JSON.stringify(permissions)]
    );

    await audit({ req, action: 'create', entityType: 'staff_roles', entityId: role.id, description: `Created role ${code}` });
    return created(res, role);
  })
);

router.patch(
  '/roles/:id',
  requirePermission('settings:manage'),
  validate(roleSchema.partial().omit({ code: true })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'role id');
    const existing = await one('SELECT * FROM staff_roles WHERE id = $1', [id]);
    if (!existing) throw notFound('Role');

    // The administrator role keeps "*" no matter what, otherwise a mistaken
    // edit can lock every administrator out of the settings screen.
    if (existing.code === 'administrator' && req.body.permissions && !req.body.permissions.includes('*')) {
      throw badRequest('The administrator role must retain full access ("*").');
    }

    const updated = await one(
      `UPDATE staff_roles
          SET name        = COALESCE($2, name),
              description = COALESCE($3, description),
              rank        = COALESCE($4, rank),
              permissions = COALESCE($5, permissions)
        WHERE id = $1
        RETURNING *`,
      [
        id,
        req.body.name ?? null,
        req.body.description ?? null,
        req.body.rank ?? null,
        req.body.permissions ? JSON.stringify(req.body.permissions) : null,
      ]
    );

    await audit({
      req,
      action: 'update',
      entityType: 'staff_roles',
      entityId: id,
      changes: diffChanges(existing, updated),
      description: `Updated role ${existing.code}`,
    });
    return ok(res, updated);
  })
);

// --- Individual accounts ---------------------------------------------------

router.get(
  '/:id',
  requirePermission('staff:read'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'staff id');
    const staff = await one(
      `SELECT s.id, s.staff_number, s.username, s.full_name, s.display_title,
              s.department, s.email, s.status, s.is_on_duty, s.sl_avatar_key,
              s.sl_avatar_name, s.last_login_at, s.last_seen_at, s.created_at,
              r.id AS role_id, r.code AS role_code, r.name AS role_name,
              r.rank AS role_rank, r.permissions AS role_permissions
         FROM staff s
         JOIN staff_roles r ON r.id = s.role_id
        WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [id]
    );
    if (!staff) throw notFound('Staff member');

    const stats = await one(
      `SELECT
         (SELECT count(*) FROM patient_visits v WHERE v.assigned_doctor_id = $1 AND v.deleted_at IS NULL) AS visits_seen,
         (SELECT count(*) FROM prescriptions p WHERE p.prescribed_by = $1 AND p.deleted_at IS NULL) AS prescriptions_written,
         (SELECT count(*) FROM laboratory_orders l WHERE l.ordered_by = $1 AND l.deleted_at IS NULL) AS labs_ordered`,
      [id]
    );

    return ok(res, { ...staff, effectivePermissions: expandPermissions(staff.role_permissions), stats });
  })
);

const createStaffSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(60)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dot, underscore and hyphen only'),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
  full_name: text(120, 'Full name'),
  role_code: text(40, 'Role'),
  display_title: z.string().max(40).optional().nullable(),
  department: z.string().max(80).optional().nullable(),
  email: z.string().email().max(160).optional().nullable(),
  sl_avatar_key: z.string().uuid().optional().nullable(),
  sl_avatar_name: z.string().max(120).optional().nullable(),
  must_change_password: z.boolean().default(true),
});

router.post(
  '/',
  requirePermission('staff:manage'),
  validate(createStaffSchema),
  asyncHandler(async (req, res) => {
    const body = req.body;

    const role = await one('SELECT id, code, rank FROM staff_roles WHERE code = $1', [body.role_code]);
    if (!role) throw badRequest(`Unknown role "${body.role_code}".`);

    // You cannot create an account more senior than your own.
    if (role.rank < req.staff.role.rank) {
      throw forbidden(`You cannot create an account with the "${role.code}" role.`);
    }

    const existing = await one('SELECT id FROM staff WHERE lower(username) = lower($1)', [body.username]);
    if (existing) throw conflict('That username is already taken.');

    const hash = await bcrypt.hash(body.password, config.auth.bcryptRounds);

    const staff = await one(
      `INSERT INTO staff
         (username, password_hash, full_name, display_title, role_id, department,
          email, sl_avatar_key, sl_avatar_name, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, staff_number, username, full_name, display_title, department,
                 email, status, created_at`,
      [
        body.username,
        hash,
        body.full_name,
        body.display_title ?? null,
        role.id,
        body.department ?? null,
        body.email ?? null,
        body.sl_avatar_key ?? null,
        body.sl_avatar_name ?? null,
        body.must_change_password,
      ]
    );

    await audit({
      req,
      action: 'create',
      entityType: 'staff',
      entityId: staff.id,
      description: `Created ${role.code} account "${body.username}"`,
    });

    return created(res, { ...staff, role: { code: role.code } });
  })
);

const updateStaffSchema = z.object({
  full_name: text(120, 'Full name').optional(),
  display_title: z.string().max(40).optional().nullable(),
  role_code: z.string().max(40).optional(),
  department: z.string().max(80).optional().nullable(),
  email: z.string().email().max(160).optional().nullable(),
  sl_avatar_key: z.string().uuid().optional().nullable(),
  sl_avatar_name: z.string().max(120).optional().nullable(),
  status: z.enum(['active', 'inactive', 'suspended', 'on_break', 'off_duty']).optional(),
});

router.patch(
  '/:id',
  requirePermission('staff:manage'),
  validate(updateStaffSchema),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'staff id');

    const existing = await one(
      `SELECT s.*, r.code AS role_code, r.rank AS role_rank
         FROM staff s JOIN staff_roles r ON r.id = s.role_id
        WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [id]
    );
    if (!existing) throw notFound('Staff member');

    if (existing.role_rank < req.staff.role.rank) {
      throw forbidden('You cannot modify an account more senior than your own.');
    }

    let roleId = null;
    if (req.body.role_code && req.body.role_code !== existing.role_code) {
      const role = await one('SELECT id, code, rank FROM staff_roles WHERE code = $1', [req.body.role_code]);
      if (!role) throw badRequest(`Unknown role "${req.body.role_code}".`);
      if (role.rank < req.staff.role.rank) throw forbidden(`You cannot grant the "${role.code}" role.`);
      roleId = role.id;
    }

    // Guard against removing the last administrator.
    if ((req.body.status && req.body.status !== 'active') || roleId) {
      if (existing.role_code === 'administrator') {
        const { count } = await one(
          `SELECT count(*)::int AS count FROM staff s JOIN staff_roles r ON r.id = s.role_id
            WHERE r.code = 'administrator' AND s.status = 'active' AND s.deleted_at IS NULL`
        );
        if (count <= 1) throw badRequest('This is the last active administrator account.');
      }
    }

    const updated = await one(
      `UPDATE staff
          SET full_name      = COALESCE($2, full_name),
              display_title  = COALESCE($3, display_title),
              role_id        = COALESCE($4, role_id),
              department     = COALESCE($5, department),
              email          = COALESCE($6, email),
              sl_avatar_key  = COALESCE($7, sl_avatar_key),
              sl_avatar_name = COALESCE($8, sl_avatar_name),
              status         = COALESCE($9, status)
        WHERE id = $1
        RETURNING id, staff_number, username, full_name, display_title, department,
                  email, status, is_on_duty, role_id`,
      [
        id,
        req.body.full_name ?? null,
        req.body.display_title ?? null,
        roleId,
        req.body.department ?? null,
        req.body.email ?? null,
        req.body.sl_avatar_key ?? null,
        req.body.sl_avatar_name ?? null,
        req.body.status ?? null,
      ]
    );

    // Suspending or deactivating an account must end its live sessions.
    if (req.body.status && req.body.status !== 'active') {
      await query('UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [id]);
    }

    await audit({
      req,
      action: 'update',
      entityType: 'staff',
      entityId: id,
      changes: diffChanges(existing, updated),
      description: `Updated account "${existing.username}"`,
    });

    return ok(res, updated);
  })
);

router.post(
  '/:id/password',
  requirePermission('staff:manage'),
  validate(z.object({ new_password: z.string().min(10).max(200), must_change: z.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'staff id');

    const target = await one(
      `SELECT s.id, s.username, r.rank AS role_rank
         FROM staff s JOIN staff_roles r ON r.id = s.role_id
        WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [id]
    );
    if (!target) throw notFound('Staff member');
    if (target.role_rank < req.staff.role.rank) {
      throw forbidden('You cannot reset the password of a more senior account.');
    }

    const hash = await bcrypt.hash(req.body.new_password, config.auth.bcryptRounds);
    await query('UPDATE staff SET password_hash = $2, must_change_password = $3, failed_logins = 0, locked_until = NULL WHERE id = $1', [
      id,
      hash,
      req.body.must_change,
    ]);
    await query('UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [id]);

    await audit({
      req,
      action: 'reset_password',
      entityType: 'staff',
      entityId: id,
      description: `Reset password for "${target.username}"`,
    });

    return ok(res, { reset: true });
  })
);

router.delete(
  '/:id',
  requirePermission('staff:manage'),
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'staff id');
    if (id === req.staff.id) throw badRequest('You cannot archive your own account.');

    const target = await one(
      `SELECT s.id, s.username, r.code AS role_code, r.rank AS role_rank
         FROM staff s JOIN staff_roles r ON r.id = s.role_id
        WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [id]
    );
    if (!target) throw notFound('Staff member');
    if (target.role_rank < req.staff.role.rank) throw forbidden('You cannot archive a more senior account.');

    if (target.role_code === 'administrator') {
      const { count } = await one(
        `SELECT count(*)::int AS count FROM staff s JOIN staff_roles r ON r.id = s.role_id
          WHERE r.code = 'administrator' AND s.status = 'active' AND s.deleted_at IS NULL`
      );
      if (count <= 1) throw badRequest('This is the last active administrator account.');
    }

    // Soft delete: clinical records reference this row and must keep their
    // author. The username is freed so it can be reissued.
    await query(
      `UPDATE staff
          SET deleted_at = now(), status = 'inactive', is_on_duty = false,
              username = username || '.archived.' || extract(epoch from now())::bigint
        WHERE id = $1`,
      [id]
    );
    await query('UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [id]);

    await audit({
      req,
      action: 'delete',
      entityType: 'staff',
      entityId: id,
      description: `Archived account "${target.username}"`,
    });

    return ok(res, { archived: true });
  })
);

export default router;
