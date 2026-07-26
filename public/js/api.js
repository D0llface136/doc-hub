/**
 * API client.
 *
 * One place for the base URL, the auth header, the response envelope and
 * error handling. Every call returns the `data` payload directly, or throws an
 * ApiError carrying the server's code and message.
 */

const TOKEN_KEY = 'clinic.token';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Validation issues as "field: message" lines, for showing under a form. */
  get fieldErrors() {
    if (!Array.isArray(this.details)) return {};
    return this.details.reduce((acc, issue) => {
      acc[issue.field] = issue.message;
      return acc;
    }, {});
  }
}

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (value) => localStorage.setItem(TOKEN_KEY, value),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** Called when a request comes back 401, so the app can bounce to the login screen. */
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/** Build a query string, dropping empty values so URLs stay readable. */
export function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

async function request(method, path, body, options = {}) {
  const headers = { Accept: 'application/json' };

  const authToken = token.get();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // The Second Life browser can hang on a dead connection indefinitely; abort
  // so the UI can show a real error instead of a permanent spinner.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 30_000);

  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond.');
    }
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  clearTimeout(timeout);

  if (response.status === 204) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(response.status, 'BAD_RESPONSE', 'The server sent something unreadable.');
  }

  if (!response.ok || payload.success === false) {
    const error = payload.error ?? {};
    const apiError = new ApiError(
      response.status,
      error.code ?? 'ERROR',
      error.message ?? `Request failed (${response.status})`,
      error.details
    );

    // A 401 means the session is gone - clear it once, centrally, rather than
    // in every caller.
    if (response.status === 401) {
      token.clear();
      onUnauthorized(apiError);
    }

    throw apiError;
  }

  // List endpoints carry pagination in `meta`; attach it to the array so a
  // caller can read `result.pagination` without a second shape to handle.
  if (Array.isArray(payload.data) && payload.meta?.pagination) {
    Object.defineProperty(payload.data, 'pagination', {
      value: payload.meta.pagination,
      enumerable: false,
    });
  }

  return payload.data;
}

export const api = {
  get: (path, params) => request('GET', `${path}${qs(params)}`),
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  delete: (path) => request('DELETE', path),

  // --- Named helpers for the endpoints used across several views ----------

  login: (username, password) => request('POST', '/auth/login', { username, password }),
  logout: () => request('POST', '/auth/logout', {}),
  me: () => request('GET', '/auth/me'),

  dashboard: () => request('GET', '/stats/dashboard'),
  queue: (params) => request('GET', `/queue${qs(params)}`),
  publicSettings: () => request('GET', '/settings/public'),
};
