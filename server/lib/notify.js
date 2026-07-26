/**
 * Notification creation.
 *
 * Writes a durable row in `notifications` (so it survives a HUD reload) and
 * pushes it over SSE (so it appears immediately). Both are best-effort with
 * respect to the caller: a notification failure never rolls back the clinical
 * action that prompted it.
 */
import { rows, query } from '../db/pool.js';
import { publish, publishToStaff, publishToRole } from './events.js';

/**
 * Notify one staff member.
 * @param {object} opts
 * @param {string} opts.staffId
 * @param {string} opts.type  'info'|'warning'|'emergency'|'lab_result'|...
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {string} [opts.link] deep link into the SPA, e.g. '#/patients/<id>'
 * @param {string} [opts.entityType]
 * @param {string} [opts.entityId]
 */
export async function notifyStaff({ staffId, type = 'info', title, body, link, entityType, entityId }) {
  try {
    const [row] = await rows(
      `INSERT INTO notifications (staff_id, type, title, body, link, entity_type, entity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [staffId, type, title, body ?? null, link ?? null, entityType ?? null, entityId ?? null]
    );
    publishToStaff(staffId, 'notification', row);
    return row;
  } catch (err) {
    console.error('[notify] staff notification failed:', err.message);
    return null;
  }
}

/**
 * Notify every member of a role (e.g. every pharmacist when a script arrives).
 * One row per staff member, so read state is per-person.
 */
export async function notifyRole({ roleCode, type = 'info', title, body, link, entityType, entityId }) {
  try {
    const inserted = await rows(
      `INSERT INTO notifications (staff_id, role_code, type, title, body, link, entity_type, entity_id)
       SELECT s.id, $1, $2, $3, $4, $5, $6, $7
         FROM staff s
         JOIN staff_roles r ON r.id = s.role_id
        WHERE r.code = $1 AND s.deleted_at IS NULL AND s.status = 'active'
       RETURNING *`,
      [roleCode, type, title, body ?? null, link ?? null, entityType ?? null, entityId ?? null]
    );
    publishToRole(roleCode, 'notification', { type, title, body, link, entityType, entityId });
    return inserted;
  } catch (err) {
    console.error('[notify] role notification failed:', err.message);
    return [];
  }
}

/**
 * Notify all active staff. Used for emergency codes and clinic-wide alerts.
 */
export async function notifyAll({ type = 'info', title, body, link, entityType, entityId, excludeStaffId }) {
  try {
    await query(
      `INSERT INTO notifications (staff_id, type, title, body, link, entity_type, entity_id)
       SELECT s.id, $1, $2, $3, $4, $5, $6
         FROM staff s
        WHERE s.deleted_at IS NULL AND s.status = 'active'
          AND ($7::uuid IS NULL OR s.id <> $7)`,
      [type, title, body ?? null, link ?? null, entityType ?? null, entityId ?? null, excludeStaffId ?? null]
    );
    publish('notification', { type, title, body, link, entityType, entityId });
  } catch (err) {
    console.error('[notify] broadcast failed:', err.message);
  }
}

/**
 * Push a live data-change hint without storing a notification row. The SPA
 * uses these to refresh the affected screen rather than to show a toast.
 *
 * @param {string} channel 'queue' | 'pharmacy' | 'laboratory' | 'radiology' | 'stats'
 * @param {unknown} [payload]
 */
export function broadcastChange(channel, payload = {}) {
  publish(`${channel}:updated`, { channel, at: new Date().toISOString(), ...payload });
}
