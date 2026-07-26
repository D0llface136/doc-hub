/**
 * Typed application errors.
 *
 * Route handlers throw these; the central error middleware turns them into the
 * standard JSON envelope. Anything that is *not* an ApiError is treated as an
 * unexpected fault and its message is hidden from the client in production.
 */

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code   stable machine-readable code, e.g. 'NOT_FOUND'
   * @param {string} message human-readable message, safe to show a user
   * @param {unknown} [details] optional structured detail (validation issues)
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
  }
}

export const badRequest = (message = 'Bad request', details) =>
  new ApiError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have permission to do that') =>
  new ApiError(403, 'FORBIDDEN', message);

export const notFound = (what = 'Resource') =>
  new ApiError(404, 'NOT_FOUND', `${what} not found`);

export const conflict = (message = 'Conflicts with existing data') =>
  new ApiError(409, 'CONFLICT', message);

export const unprocessable = (message = 'Validation failed', details) =>
  new ApiError(422, 'VALIDATION_ERROR', message, details);

export const tooManyRequests = (message = 'Too many requests') =>
  new ApiError(429, 'RATE_LIMITED', message);

/**
 * Map a PostgreSQL driver error onto an ApiError where the cause is something
 * the caller can act on. Returns null when the error is genuinely unexpected.
 *
 * @param {any} err
 * @returns {ApiError | null}
 */
export function translatePgError(err) {
  switch (err.code) {
    case '23505': // unique_violation
      return conflict(
        err.detail?.includes('already exists')
          ? 'A record with those details already exists.'
          : 'That value is already in use.'
      );
    case '23503': // foreign_key_violation
      return badRequest('Referenced record does not exist, or is still in use.');
    case '23502': // not_null_violation
      return badRequest(`Missing required field: ${err.column ?? 'unknown'}`);
    case '23514': // check_violation
      return badRequest(`Value is not allowed for this field (${err.constraint ?? 'check'}).`);
    case '22P02': // invalid_text_representation - usually a malformed UUID
      return badRequest('Malformed identifier or value.');
    case '22001': // string_data_right_truncation
      return badRequest('A value is too long for its field.');
    case '40001': // serialization_failure
      return new ApiError(503, 'RETRY', 'Conflicting update, please retry.');
    case '57014': // query_canceled
      return new ApiError(504, 'TIMEOUT', 'The database took too long to respond.');
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
      return new ApiError(503, 'DB_UNAVAILABLE', 'Database is unreachable.');
    default:
      return null;
  }
}
