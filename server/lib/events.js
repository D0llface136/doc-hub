/**
 * Real-time event hub (Server-Sent Events).
 *
 * SSE rather than WebSockets: the Second Life MOAP browser handles EventSource
 * reliably, it survives Render's proxy without an upgrade handshake, and the
 * traffic here is one-directional anyway (server -> HUD).
 *
 * Subscribers are held in memory, so this is correct for a single instance. If
 * the service is ever scaled past one dyno, swap `publish()` for a Postgres
 * LISTEN/NOTIFY fan-out - the rest of the codebase does not need to change.
 */

/** @type {Map<string, {res: import('express').Response, staffId: string, roleCode: string}>} */
const subscribers = new Map();

const HEARTBEAT_MS = 25_000;

/**
 * Register an SSE connection.
 * @returns {() => void} unsubscribe function
 */
export function subscribe(id, res, staff) {
  subscribers.set(id, { res, staffId: staff.id, roleCode: staff.role.code });

  // Comment frames keep intermediaries from closing an idle connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      unsubscribe(id);
    }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    subscribers.delete(id);
  };

  return cleanup;
}

export function unsubscribe(id) {
  const entry = subscribers.get(id);
  if (entry) {
    try {
      entry.res.end();
    } catch {
      /* already closed */
    }
    subscribers.delete(id);
  }
}

function write(entry, event, payload) {
  try {
    entry.res.write(`event: ${event}\n`);
    entry.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // The socket died between our check and the write; drop the subscriber.
    for (const [id, candidate] of subscribers) {
      if (candidate === entry) subscribers.delete(id);
    }
  }
}

/**
 * Broadcast to every connected client.
 * @param {string} event  e.g. 'queue:updated', 'emergency:activated'
 * @param {unknown} payload JSON-serialisable
 */
export function publish(event, payload) {
  for (const entry of subscribers.values()) {
    write(entry, event, payload);
  }
}

/** Send to one staff member (all of their open tabs/HUDs). */
export function publishToStaff(staffId, event, payload) {
  for (const entry of subscribers.values()) {
    if (entry.staffId === staffId) write(entry, event, payload);
  }
}

/** Send to everyone holding a given role. */
export function publishToRole(roleCode, event, payload) {
  for (const entry of subscribers.values()) {
    if (entry.roleCode === roleCode) write(entry, event, payload);
  }
}

/** How many live connections, and who. Used by /api/health and the admin page. */
export function connectionStats() {
  const byRole = {};
  for (const entry of subscribers.values()) {
    byRole[entry.roleCode] = (byRole[entry.roleCode] ?? 0) + 1;
  }
  return { total: subscribers.size, byRole };
}
