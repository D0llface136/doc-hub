/**
 * Authentication endpoints.
 *
 * POST   /api/auth/login            sign in, receive a JWT
 * POST   /api/auth/logout           revoke the current session
 * GET    /api/auth/me               current staff member + permissions
 * PATCH  /api/auth/me               update own profile fields
 * POST   /api/auth/change-password  rotate own password
 * POST   /api/auth/duty             toggle on/off duty
 * GET    /api/auth/sessions         list own active sessions
 * DELETE /api/auth/sessions/:id     revoke one of own sessions
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';
import { one, rows, query } from '../db/pool.js';
import { asyncHandler, ok, requireUuid } from '../lib/http.js';
import { unauthorized, badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate, z, text } from '../lib/validate.js';
import { audit, clientIp } from '../lib/audit.js';
import { signToken, requireAuth, describeStaff } from '../middleware/auth.js';
import { expandPermissions } from '../lib/permissions.js';
import { publish } from '../lib/events.js';

const router = Router();

// Brute-force protection. Keyed by IP + username so one attacker cannot lock
// out every account from a shared address, and a distributed attempt against
// one account still trips the limit.
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${clientIp(req) ?? 'unknown'}:${String(req.body?.username ?? '').toLowerCase()}`,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again in a few minutes.' },
  },
});

const loginSchema = z.object({
  username: text(60, 'Username'),
  password: z.string().min(1, 'Password is required').max(200),
  // Optional: the HUD passes the wearer's key so the account can be linked to
  // an avatar on first sign-in from in-world.
  sl_avatar_key: z.string().uuid().optional(),
  sl_avatar_name: z.string().max(120).optional(),
});

router.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { username, password, sl_avatar_key, sl_avatar_name } = req.body;

    const staff = await one(
      `SELECT s.*, r.code AS role_code, r.name AS role_name,
              r.rank AS role_rank, r.permissions AS role_permissions
         FROM staff s
         JOIN staff_roles r ON r.id = s.role_id
        WHERE lower(s.username) = lower($1) AND s.deleted_at IS NULL`,
      [username]
    );

    // Compare against a dummy hash when the user does not exist, so the
    // response time does not reveal which usernames are real.
    const hash = staff?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
    const passwordMatches = await bcrypt.compare(password, hash);

    if (!staff || !passwordMatches) {
      if (staff) {
        const failures = staff.failed_logins + 1;
        const lockUntil =
          failures >= config.auth.maxFailedLogins
            ? new Date(Date.now() + config.auth.lockoutMinutes * 60_000)
            : null;
        await query(
          'UPDATE staff SET failed_logins = $2, locked_until = COALESCE($3, locked_until) WHERE id = $1',
          [staff.id, failures, lockUntil]
        );
        await audit({
          req,
          action: 'login_failed',
          entityType: 'staff',
          entityId: staff.id,
          description: `Failed sign-in for ${staff.username} (attempt ${failures})`,
        });
      }
      throw unauthorized('Incorrect username or password.');
    }

    if (staff.locked_until && new Date(staff.locked_until) > new Date()) {
      const minutes = Math.ceil((new Date(staff.locked_until) - Date.now()) / 60_000);
      throw forbidden(`Account locked after too many failed attempts. Try again in ${minutes} minute(s).`);
    }

    if (staff.status === 'suspended') throw forbidden('This account is suspended. Contact an administrator.');
    if (staff.status === 'inactive') throw forbidden('This account is inactive. Contact an administrator.');

    const { token, tokenId, expiresAt } = signToken(staff);

    await query(
      `INSERT INTO staff_sessions (staff_id, token_id, expires_at, ip_address, user_agent, source)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        staff.id,
        tokenId,
        expiresAt,
        clientIp(req),
        req.get('user-agent')?.slice(0, 300) ?? null,
        req.get('x-clinic-key') ? 'lsl' : 'web',
      ]
    );

    await query(
      `UPDATE staff
          SET last_login_at = now(), last_seen_at = now(), failed_logins = 0, locked_until = NULL,
              sl_avatar_key  = COALESCE($2, sl_avatar_key),
              sl_avatar_name = COALESCE($3, sl_avatar_name)
        WHERE id = $1`,
      [staff.id, sl_avatar_key ?? null, sl_avatar_name ?? null]
    );

    await audit({
      req,
      action: 'login',
      entityType: 'staff',
      entityId: staff.id,
      description: `${staff.full_name} signed in`,
    });

    // Let dashboards refresh their "active staff" widget.
    publish('staff:signed_in', { staffId: staff.id, fullName: staff.full_name, role: staff.role_code });

    return ok(res, {
      token,
      expiresAt,
      staff: {
        id: staff.id,
        staff_number: staff.staff_number,
        username: staff.username,
        full_name: staff.full_name,
        display_title: staff.display_title,
        department: staff.department,
        status: staff.status,
        is_on_duty: staff.is_on_duty,
        must_change_password: staff.must_change_password,
        last_login_at: staff.last_login_at,
        role: { code: staff.role_code, name: staff.role_name, rank: staff.role_rank },
        permissions: staff.role_permissions,
        effectivePermissions: expandPermissions(staff.role_permissions),
      },
    });
  })
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await query('UPDATE staff_sessions SET revoked_at = now() WHERE token_id = $1', [req.staff.tokenId]);
    await query('UPDATE staff SET is_on_duty = false WHERE id = $1', [req.staff.id]);
    await audit({
      req,
      action: 'logout',
      entityType: 'staff',
      entityId: req.staff.id,
      description: `${req.staff.full_name} signed out`,
    });
    publish('staff:signed_out', { staffId: req.staff.id });
    return ok(res, { signedOut: true });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Refresh presence so the "active doctors" widget is meaningful.
    await query('UPDATE staff SET last_seen_at = now() WHERE id = $1', [req.staff.id]);

    const unread = await one(
      `SELECT
         (SELECT count(*) FROM notifications WHERE staff_id = $1 AND read_at IS NULL) AS notifications,
         (SELECT count(*) FROM message_recipients WHERE staff_id = $1 AND read_at IS NULL) AS messages`,
      [req.staff.id]
    );

    return ok(res, { ...describeStaff(req.staff), unread });
  })
);

const profileSchema = z.object({
  full_name: text(120, 'Full name').optional(),
  display_title: z.string().max(40).optional().nullable(),
  email: z.string().email('Must be a valid email').max(160).optional().nullable(),
  sl_avatar_name: z.string().max(120).optional().nullable(),
});

router.patch(
  '/me',
  requireAuth,
  validate(profileSchema),
  asyncHandler(async (req, res) => {
    const { full_name, display_title, email, sl_avatar_name } = req.body;

    const updated = await one(
      `UPDATE staff
          SET full_name      = COALESCE($2, full_name),
              display_title  = COALESCE($3, display_title),
              email          = COALESCE($4, email),
              sl_avatar_name = COALESCE($5, sl_avatar_name)
        WHERE id = $1
        RETURNING id, staff_number, username, full_name, display_title, email, sl_avatar_name`,
      [req.staff.id, full_name ?? null, display_title ?? null, email ?? null, sl_avatar_name ?? null]
    );

    await audit({ req, action: 'update', entityType: 'staff', entityId: req.staff.id, description: 'Updated own profile' });
    return ok(res, updated);
  })
);

const passwordSchema = z
  .object({
    current_password: z.string().min(1, 'Current password is required'),
    new_password: z
      .string()
      .min(10, 'New password must be at least 10 characters')
      .max(200)
      .refine((v) => /[a-z]/i.test(v) && /\d/.test(v), 'Include at least one letter and one number'),
  })
  .refine((data) => data.current_password !== data.new_password, {
    message: 'New password must differ from the current one',
    path: ['new_password'],
  });

router.post(
  '/change-password',
  requireAuth,
  validate(passwordSchema),
  asyncHandler(async (req, res) => {
    const record = await one('SELECT password_hash FROM staff WHERE id = $1', [req.staff.id]);
    const matches = await bcrypt.compare(req.body.current_password, record.password_hash);
    if (!matches) throw badRequest('Current password is incorrect.');

    const hash = await bcrypt.hash(req.body.new_password, config.auth.bcryptRounds);
    await query('UPDATE staff SET password_hash = $2, must_change_password = false WHERE id = $1', [
      req.staff.id,
      hash,
    ]);

    // Every other session was issued against the old password: end them all.
    await query(
      'UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND token_id <> $2 AND revoked_at IS NULL',
      [req.staff.id, req.staff.tokenId]
    );

    await audit({
      req,
      action: 'change_password',
      entityType: 'staff',
      entityId: req.staff.id,
      description: 'Password changed; other sessions revoked',
    });

    return ok(res, { changed: true, otherSessionsRevoked: true });
  })
);

router.post(
  '/duty',
  requireAuth,
  validate(z.object({ on_duty: z.boolean() })),
  asyncHandler(async (req, res) => {
    const updated = await one(
      'UPDATE staff SET is_on_duty = $2, last_seen_at = now() WHERE id = $1 RETURNING id, full_name, is_on_duty',
      [req.staff.id, req.body.on_duty]
    );
    publish('staff:duty_changed', updated);
    return ok(res, updated);
  })
);

router.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const list = await rows(
      `SELECT id, issued_at, expires_at, ip_address, user_agent, source,
              (token_id = $2) AS is_current
         FROM staff_sessions
        WHERE staff_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY issued_at DESC`,
      [req.staff.id, req.staff.tokenId]
    );
    return ok(res, list);
  })
);

router.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = requireUuid(req.params.id, 'session id');
    const revoked = await one(
      'UPDATE staff_sessions SET revoked_at = now() WHERE id = $1 AND staff_id = $2 RETURNING id',
      [id, req.staff.id]
    );
    if (!revoked) throw notFound('Session');
    return ok(res, { revoked: true });
  })
);

export default router;
