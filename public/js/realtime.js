/**
 * Live updates over Server-Sent Events, with a polling fallback.
 *
 * EventSource cannot send an Authorization header, so the token goes in the
 * query string. Some Second Life viewer builds do not expose EventSource at
 * all; when that happens (or after repeated connection failures) we fall back
 * to polling, which is slower but keeps the HUD usable.
 */
import { token } from './api.js';
import { setState } from './store.js';

let source = null;
let reconnectTimer = null;
let attempts = 0;
let pollTimer = null;

const handlers = new Map();

/**
 * Register a handler for a server event name, e.g. 'queue:updated'.
 * @returns {() => void} unsubscribe
 */
export function onEvent(name, handler) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(handler);

  // Attach to a live connection immediately; otherwise connect() picks it up.
  if (source) attachListener(name);

  return () => handlers.get(name)?.delete(handler);
}

const attached = new Set();

function attachListener(name) {
  if (!source || attached.has(name)) return;
  attached.add(name);

  source.addEventListener(name, (event) => {
    let payload = {};
    try {
      payload = JSON.parse(event.data);
    } catch {
      payload = { raw: event.data };
    }
    handlers.get(name)?.forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[realtime] handler for "${name}" threw:`, err);
      }
    });
  });
}

const MAX_ATTEMPTS = 6;

export function connect() {
  const authToken = token.get();
  if (!authToken) return;

  disconnect();

  if (typeof EventSource === 'undefined') {
    console.warn('[realtime] EventSource unavailable, falling back to polling');
    startPolling();
    return;
  }

  source = new EventSource(`/api/events/stream?token=${encodeURIComponent(authToken)}`);
  attached.clear();

  source.addEventListener('connected', () => {
    attempts = 0;
    stopPolling();
    setState('connected', true);
  });

  source.onerror = () => {
    setState('connected', false);

    // EventSource retries on its own, but a token that has expired will loop
    // forever. Give up after a few tries and poll instead.
    if (source && source.readyState === EventSource.CLOSED) {
      attempts += 1;
      if (attempts >= MAX_ATTEMPTS) {
        console.warn('[realtime] giving up on SSE, polling instead');
        disconnect();
        startPolling();
        return;
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** attempts, 30_000));
    }
  };

  // Re-attach every handler registered before the connection existed.
  for (const name of handlers.keys()) attachListener(name);
}

export function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (source) {
    source.close();
    source = null;
  }
  attached.clear();
  setState('connected', false);
}

// --- Polling fallback ------------------------------------------------------

const POLL_INTERVAL_MS = 20_000;

/**
 * Without SSE we cannot know *what* changed, so we fire the broad channel
 * events on a timer and let each view decide whether to refresh.
 */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    for (const name of ['queue:updated', 'pharmacy:updated', 'laboratory:updated', 'poll']) {
      handlers.get(name)?.forEach((handler) => handler({ polled: true }));
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function shutdown() {
  disconnect();
  stopPolling();
  handlers.clear();
}
