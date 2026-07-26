/**
 * Audit trail.
 *
 * Every state-changing action should leave a row in audit_logs. Writes are
 * fire-and-forget: an audit failure must never fail the clinical action that
 * triggered it, but it must be loud in the logs.
 */
import { query } from '../db/pool.js';

/** Fields that must never be written into the audit trail. */
const REDACTED_FIELDS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'new_password',
  'current_password',
  'token',
  'jwt',
  'api_key',
]);

/**
 * Reduce an update to just what changed, as { field: { from, to } }.
 * Unchanged and redacted fields are dropped, which keeps the log readable and
 * stops secrets being copied into it.
 *
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 */
export function diffChanges(before = {}, after = {}) {
  const changes = {};

  for (const key of Object.keys(after)) {
    if (REDACTED_FIELDS.has(key)) continue;

    const from = before?.[key];
    const to = after[key];
    // Compare serialised values so Dates and numerics do not look "changed"
    // purely because of object identity.
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) {
      changes[key] = { from: from ?? null, to: to ?? null };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Record an audited action.
 *
 * @param {object} entry
 * @param {import('express').Request} [entry.req] request, for actor and IP
 * @param {string} entry.action 'create' | 'update' | 'delete' | 'view' | 'login' | ...
 * @param {string} entry.entityType table or module name
 * @param {string} [entry.entityId] UUID of the affected row
 * @param {object} [entry.changes] output of diffChanges, or an arbitrary object
 * @param {string} [entry.description] human-readable summary
 */
export async function audit({ req, action, entityType, entityId, changes, description }) {
  const actor = req?.staff ?? null;

  try {
    await query(
      `INSERT INTO audit_logs
         (staff_id, staff_name, action, entity_type, entity_id,
          changes, description, ip_address, user_agent, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        actor?.id ?? null,
        actor?.full_name ?? (req?.lslClient ? 'In-world object' : 'system'),
        action,
        entityType,
        entityId ?? null,
        changes ? JSON.stringify(changes) : null,
        description ?? null,
        clientIp(req),
        req?.get?.('user-agent')?.slice(0, 300) ?? null,
        req?.lslClient ? 'lsl' : req ? 'web' : 'system',
      ]
    );
  } catch (err) {
    console.error(`[audit] failed to record ${action} on ${entityType}:`, err.message);
  }
}

/** Best-effort client IP, honouring Render's proxy header. */
export function clientIp(req) {
  if (!req) return null;
  const forwarded = req.get?.('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 60);
  return (req.ip ?? '').slice(0, 60) || null;
}
