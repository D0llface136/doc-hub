/**
 * Central error handling and 404 fallback.
 *
 * Must be registered last, after every route.
 */
import { ApiError, translatePgError, notFound } from '../lib/errors.js';
import { config } from '../config/env.js';

/** Turn an unmatched /api/* path into a proper JSON 404. */
export function apiNotFound(req, _res, next) {
  next(notFound(`Endpoint ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(err, req, res, _next) {
  // A rejected JSON body parse arrives as a SyntaxError from body-parser.
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON.' },
    });
  }

  const apiError = err instanceof ApiError ? err : translatePgError(err);

  if (apiError) {
    // Expected errors are logged at info level only when they are server-side.
    if (apiError.status >= 500) {
      console.error(`[error] ${apiError.code}: ${err.message}`, err.sql ?? '');
    }

    return res.status(apiError.status).json({
      success: false,
      error: {
        code: apiError.code,
        message: apiError.message,
        ...(apiError.details ? { details: apiError.details } : {}),
      },
    });
  }

  // Genuinely unexpected: log everything, tell the client nothing specific.
  console.error('[error] unhandled:', {
    method: req.method,
    path: req.originalUrl,
    staff: req.staff?.username ?? null,
    message: err.message,
    sql: err.sql ?? undefined,
    stack: err.stack,
  });

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our end. The incident has been logged.',
      ...(config.isProduction ? {} : { debug: err.message, stack: err.stack?.split('\n').slice(0, 5) }),
    },
  });
}
