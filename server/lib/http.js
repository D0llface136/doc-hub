/**
 * Response helpers and request parsing.
 *
 * Every endpoint returns the same envelope so the SPA has exactly one shape to
 * handle:
 *
 *   success: { "success": true, "data": ..., "meta": { ... } }
 *   failure: { "success": false, "error": { "code", "message", "details" } }
 */
import { badRequest } from './errors.js';

/** Send a success envelope. */
export function ok(res, data, meta) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.json(body);
}

/** Send a 201 with the created resource. */
export function created(res, data, meta) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(201).json(body);
}

/** Send a paginated collection. */
export function paginated(res, items, { page, limit, total }) {
  return res.json({
    success: true,
    data: items,
    meta: {
      pagination: {
        page,
        limit,
        total,
        pages: limit > 0 ? Math.ceil(total / limit) : 0,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    },
  });
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

/**
 * Read `?page` and `?limit` with sane bounds.
 * @returns {{page: number, limit: number, offset: number}}
 */
export function readPagination(req, defaultLimit = DEFAULT_LIMIT) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const requested = Number.parseInt(req.query.limit, 10) || defaultLimit;
  const limit = Math.min(Math.max(1, requested), MAX_LIMIT);
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * Read `?sort=field` / `?order=asc|desc` against an allow-list.
 *
 * The allow-list is what makes this safe: the resulting column name is
 * interpolated into SQL (you cannot parameterise an ORDER BY column), so it
 * must never come straight from user input.
 *
 * @param {import('express').Request} req
 * @param {Record<string,string>} allowed map of API field name -> SQL expression
 * @param {string} fallback key in `allowed` to use when none/invalid is given
 */
export function readSort(req, allowed, fallback) {
  const requested = String(req.query.sort ?? '');
  const key = Object.prototype.hasOwnProperty.call(allowed, requested) ? requested : fallback;
  const direction = String(req.query.order ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `${allowed[key]} ${direction}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

/** Assert a route parameter is a UUID before it reaches the database. */
export function requireUuid(value, label = 'id') {
  if (!isUuid(value)) throw badRequest(`Invalid ${label}: expected a UUID.`);
  return value;
}

/**
 * Wrap an async route handler so a rejected promise reaches Express's error
 * middleware. Express 4 does not do this for you.
 *
 * @param {(req, res, next) => Promise<unknown>} handler
 */
export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Build a partial-UPDATE statement from a whitelist of columns.
 * Only keys present in `body` are touched, so a PATCH never clears a field the
 * client did not mention.
 *
 * @param {Record<string, unknown>} body
 * @param {string[]} allowedColumns
 * @param {number} startIndex first placeholder number to use
 * @returns {{ setSql: string, values: unknown[], nextIndex: number }}
 */
export function buildUpdate(body, allowedColumns, startIndex = 1) {
  const fragments = [];
  const values = [];
  let index = startIndex;

  for (const column of allowedColumns) {
    if (Object.prototype.hasOwnProperty.call(body, column) && body[column] !== undefined) {
      fragments.push(`${column} = $${index}`);
      values.push(body[column]);
      index += 1;
    }
  }

  return { setSql: fragments.join(', '), values, nextIndex: index };
}
