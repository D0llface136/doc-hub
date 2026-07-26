/**
 * Application state.
 *
 * Small and deliberate: the signed-in staff member, clinic settings, unread
 * counts and any active emergency. Views subscribe to what they care about
 * instead of polling.
 */

const listeners = new Map();

export const store = {
  staff: null,
  settings: {},
  unread: { notifications: 0, messages: 0, emergencies: 0 },
  emergencies: [],
  connected: false,
};

/**
 * Subscribe to a key.
 * @param {string} key one of the store's top-level keys, or '*' for any change
 * @returns {() => void} unsubscribe
 */
export function subscribe(key, handler) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(handler);
  return () => listeners.get(key)?.delete(handler);
}

function emit(key, value) {
  listeners.get(key)?.forEach((handler) => {
    try {
      handler(value);
    } catch (err) {
      console.error(`[store] listener for "${key}" threw:`, err);
    }
  });
  listeners.get('*')?.forEach((handler) => handler(key, value));
}

export function setState(key, value) {
  store[key] = value;
  emit(key, value);
}

/** Merge into an object-valued key. */
export function patchState(key, partial) {
  store[key] = { ...store[key], ...partial };
  emit(key, store[key]);
}

// --- Convenience accessors -------------------------------------------------

/**
 * Does the signed-in staff member hold a permission?
 * Mirrors the server's wildcard rules so the UI hides what the API would refuse.
 */
export function can(permission) {
  const granted = store.staff?.permissions;
  if (!Array.isArray(granted)) return false;
  if (granted.includes('*')) return true;
  if (granted.includes(permission)) return true;

  const [resource] = permission.split(':');
  return granted.includes(`${resource}:*`);
}

/** True when the staff member holds at least one of the given permissions. */
export function canAny(...permissions) {
  return permissions.some(can);
}

export function setting(key, fallback) {
  const value = store.settings[key];
  return value === undefined || value === null ? fallback : value;
}

export const isSignedIn = () => Boolean(store.staff);
