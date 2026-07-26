/**
 * Authentication and authorisation middleware.
 *
 * Two ways in:
 *
 *   1. Staff JWT      - `Authorization: Bearer <token>`, used by the SPA.
 *   2. In-world key   - `X-Clinic-Key: <LSL_API_KEY>`, used by LSL objects that
 *                       cannot hold a login session. Key-only requests are
 *                       restricted to the /api/lsl/* surface; when the object
 *                       also sends X-Staff-Token it acts as that staff member.
 *
 * Permissions are re-read from the database on every request rather than
 * trusted from the token, so revoking a role takes effect immediately instead
 * of when the token happens to expire.
 */
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { one } from '../db/pool.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { hasPermission, hasAnyPermission, expandPermissions } from '../lib/permissions.js';

/**
 * Issue a JWT and persist its jti so the session can be revoked.
 * @param {{id: string, username: string}} staff
 * @param {object} [meta] ip / userAgent / source, recorded on the session row
 */
export function signToken(staff, meta = {}) {
  const tokenId = crypto.randomUUID();
  const token = jwt.sign(
    { sub: staff.id, username: staff.username, jti: tokenId },
    config.auth.jwtSecret,
    { expiresIn: config.auth.jwtExpiresIn }
  );

  const { exp } = jwt.decode(token);
  return { token, tokenId, expiresAt: new Date(exp * 1000), meta };
}

function readBearer(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  // The SL MOAP browser cannot always set headers on a navigation, so a token
  // may arrive as a query parameter for printable/public document routes.
  if (typeof req.query.token === 'string' && req.query.token) return req.query.token;
  return null;
}

/**
 * Resolve a token into a staff record, or throw.
 * Exported so the SSE endpoint can authenticate a token from the query string.
 */
export async function resolveStaffFromToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw unauthorized('Session expired, please sign in again.');
    throw unauthorized('Invalid session token.');
  }

  const staff = await one(
    `SELECT s.id, s.staff_number, s.username, s.full_name, s.display_title,
            s.department, s.status, s.is_on_duty, s.sl_avatar_key, s.sl_avatar_name,
            s.must_change_password, s.last_login_at,
            r.code AS role_code, r.name AS role_name, r.rank AS role_rank,
            r.permissions AS role_permissions,
            sess.revoked_at
       FROM staff s
       JOIN staff_roles r ON r.id = s.role_id
       LEFT JOIN staff_sessions sess ON sess.token_id = $2
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [payload.sub, payload.jti]
  );

  if (!staff) throw unauthorized('Account no longer exists.');
  if (staff.revoked_at) throw unauthorized('Session was signed out.');
  if (staff.status === 'suspended') throw forbidden('This account is suspended.');
  if (staff.status === 'inactive') throw forbidden('This account is inactive.');

  return {
    id: staff.id,
    staff_number: staff.staff_number,
    username: staff.username,
    full_name: staff.full_name,
    display_title: staff.display_title,
    department: staff.department,
    status: staff.status,
    is_on_duty: staff.is_on_duty,
    sl_avatar_key: staff.sl_avatar_key,
    sl_avatar_name: staff.sl_avatar_name,
    must_change_password: staff.must_change_password,
    last_login_at: staff.last_login_at,
    role: {
      code: staff.role_code,
      name: staff.role_name,
      rank: staff.role_rank,
    },
    permissions: Array.isArray(staff.role_permissions) ? staff.role_permissions : [],
    tokenId: payload.jti,
  };
}

/** Require a signed-in staff member. Populates `req.staff`. */
export function requireAuth(req, _res, next) {
  const token = readBearer(req);
  if (!token) return next(unauthorized('Sign in to continue.'));

  resolveStaffFromToken(token)
    .then((staff) => {
      req.staff = staff;
      next();
    })
    .catch(next);
}

/**
 * Populate `req.staff` when a valid token is present, but do not require one.
 * Used by endpoints that behave differently for signed-in staff.
 */
export function optionalAuth(req, _res, next) {
  const token = readBearer(req);
  if (!token) return next();

  resolveStaffFromToken(token)
    .then((staff) => {
      req.staff = staff;
      next();
    })
    .catch(() => next()); // an invalid optional token is simply ignored
}

/**
 * Require a specific permission. Must run after requireAuth.
 * @param {string} permission e.g. 'prescriptions:write'
 */
export function requirePermission(permission) {
  return (req, _res, next) => {
    if (!req.staff) return next(unauthorized('Sign in to continue.'));
    if (!hasPermission(req.staff.permissions, permission)) {
      return next(
        forbidden(`Your role (${req.staff.role.name}) cannot perform this action.`)
      );
    }
    return next();
  };
}

/** Require at least one of several permissions. */
export function requireAnyPermission(...permissions) {
  return (req, _res, next) => {
    if (!req.staff) return next(unauthorized('Sign in to continue.'));
    if (!hasAnyPermission(req.staff.permissions, permissions)) {
      return next(
        forbidden(`Your role (${req.staff.role.name}) cannot perform this action.`)
      );
    }
    return next();
  };
}

/** Convenience for administrator-only routes. */
export const requireAdmin = requirePermission('settings:manage');

/**
 * Verify the shared in-world key using a timing-safe comparison.
 * Populates `req.lslClient` with whatever the object told us about itself.
 */
export function requireLslKey(req, _res, next) {
  const provided = req.get('x-clinic-key') ?? '';
  const expected = config.lsl.apiKey;

  if (!expected) return next(forbidden('In-world bridge is not configured.'));

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!matches) return next(unauthorized('Invalid in-world key.'));

  req.lslClient = {
    objectKey: req.get('x-sl-object-key') ?? null,
    objectName: req.get('x-sl-object-name') ?? null,
    ownerKey: req.get('x-sl-owner-key') ?? null,
    region: req.get('x-sl-region') ?? null,
  };

  return next();
}

/**
 * For LSL routes that also carry a staff token: authenticate the key first,
 * then attach the staff member if `X-Staff-Token` was supplied.
 */
export function attachLslStaff(req, _res, next) {
  const token = req.get('x-staff-token');
  if (!token) return next();

  resolveStaffFromToken(token)
    .then((staff) => {
      req.staff = staff;
      next();
    })
    .catch(next);
}

/** Attach the permission catalogue expansion for the /me response. */
export function describeStaff(staff) {
  return {
    ...staff,
    effectivePermissions: expandPermissions(staff.permissions),
  };
}
