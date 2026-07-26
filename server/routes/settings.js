/**
 * Clinic settings.
 *
 * GET   /api/settings/public   branding readable without a login (for the
 *                              sign-in screen)
 * GET   /api/settings          every setting            (any signed-in staff)
 * PUT   /api/settings/:key     update one               (settings:manage)
 * PUT   /api/settings          bulk update              (settings:manage)
 *
 * Values are stored as jsonb, so a setting can be a string, number, boolean or
 * a nested object without a schema change.
 */
import { Router } from 'express';
import { one, rows, transaction } from '../db/pool.js';
import { asyncHandler, ok } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { validate, z } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = Router();

router.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const list = await rows('SELECT key, value FROM clinic_settings WHERE is_public = true ORDER BY key');
    return ok(res, Object.fromEntries(list.map((row) => [row.key, row.value])));
  })
);

router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const list = await rows(
      `SELECT s.key, s.value, s.category, s.label, s.description, s.is_public,
              s.updated_at, staff.full_name AS updated_by_name
         FROM clinic_settings s
         LEFT JOIN staff ON staff.id = s.updated_by
        ORDER BY s.category, s.key`
    );

    // Grouped by category, which is how the settings screen renders them.
    const grouped = list.reduce((acc, row) => {
      (acc[row.category] ??= []).push(row);
      return acc;
    }, {});

    return ok(res, { settings: list, grouped });
  })
);

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

router.put(
  '/:key',
  requirePermission('settings:manage'),
  validate(z.object({ value: z.any() })),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    if (!KEY_PATTERN.test(key)) throw badRequest('Setting keys look like "clinic.name".');

    const existing = await one('SELECT * FROM clinic_settings WHERE key = $1', [key]);
    if (!existing) throw notFound(`Setting "${key}"`);

    const updated = await one(
      'UPDATE clinic_settings SET value = $2, updated_by = $3 WHERE key = $1 RETURNING *',
      [key, JSON.stringify(req.body.value), req.staff.id]
    );

    await audit({
      req, action: 'update', entityType: 'clinic_settings', entityId: null,
      changes: { [key]: { from: existing.value, to: updated.value } },
      description: `Changed setting "${key}"`,
    });

    return ok(res, updated);
  })
);

router.put(
  '/',
  requirePermission('settings:manage'),
  validate(z.object({ settings: z.record(z.any()) })),
  asyncHandler(async (req, res) => {
    const entries = Object.entries(req.body.settings);
    if (entries.length === 0) throw badRequest('No settings supplied.');

    const invalid = entries.map(([key]) => key).filter((key) => !KEY_PATTERN.test(key));
    if (invalid.length > 0) throw badRequest(`Invalid setting key(s): ${invalid.join(', ')}`);

    const updated = await transaction(async (client) => {
      const results = [];
      for (const [key, value] of entries) {
        const { rows: r } = await client.query(
          `UPDATE clinic_settings SET value = $2, updated_by = $3 WHERE key = $1 RETURNING key, value`,
          [key, JSON.stringify(value), req.staff.id]
        );
        // Silently skipping unknown keys would hide typos; report them instead.
        if (r.length === 0) throw notFound(`Setting "${key}"`);
        results.push(r[0]);
      }
      return results;
    });

    await audit({
      req, action: 'update', entityType: 'clinic_settings',
      description: `Updated ${updated.length} setting(s): ${updated.map((s) => s.key).join(', ')}`,
    });

    return ok(res, updated);
  })
);

export default router;
