/**
 * Request validation built on zod.
 *
 * Handlers declare a schema; `validate()` parses and *replaces* the request
 * property with the parsed result, so downstream code works with coerced,
 * trimmed, known-shaped data instead of raw strings.
 */
import { z } from 'zod';
import { unprocessable } from './errors.js';

export { z };

/**
 * Middleware factory.
 * @param {import('zod').ZodTypeAny} schema
 * @param {'body'|'query'|'params'} source
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
        code: issue.code,
      }));
      return next(unprocessable('Some fields need attention.', details));
    }

    // req.query is a getter-only property on Express 5; assigning to a plain
    // key on req avoids that while keeping one access pattern.
    if (source === 'query') req.validatedQuery = result.data;
    else req[source] = result.data;

    return next();
  };
}

// --- Reusable field schemas ------------------------------------------------

export const uuid = z.string().uuid('Must be a valid UUID');

/** Trimmed, non-empty string with a length bound. */
export const text = (max = 255, label = 'Value') =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} must be ${max} characters or fewer`);

/** Optional free text: empty string and null both become undefined. */
export const optionalText = (max = 2000) =>
  z
    .union([z.string().max(max), z.null()])
    .optional()
    .transform((v) => (v === null || v === '' ? undefined : v?.trim()));

/** ISO date "YYYY-MM-DD". */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a real date');

export const optionalIsoDate = isoDate.optional().nullable();

/** ISO 8601 timestamp. */
export const isoDateTime = z
  .string()
  .datetime({ offset: true, message: 'Must be an ISO 8601 timestamp' });

/** Numbers arriving as query-string text. */
export const numeric = (min, max) =>
  z.coerce.number().refine(
    (v) => (min === undefined || v >= min) && (max === undefined || v <= max),
    `Must be between ${min ?? '-inf'} and ${max ?? 'inf'}`
  );

export const optionalNumeric = (min, max) =>
  z
    .union([z.coerce.number(), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v === '' || v === null ? undefined : v))
    .refine(
      (v) => v === undefined || ((min === undefined || v >= min) && (max === undefined || v <= max)),
      `Must be between ${min ?? '-inf'} and ${max ?? 'inf'}`
    );

export const money = z.coerce.number().min(0, 'Amount cannot be negative').max(99_999_999);

/** Booleans from query strings ("true"/"1") or JSON bodies. */
export const flexibleBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/** Common list-endpoint query parameters. */
export const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.string().max(40).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
