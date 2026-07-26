/**
 * Server-Sent Events stream.
 *
 * GET /api/events/stream?token=<jwt>
 *
 * EventSource cannot set an Authorization header, so the token is passed as a
 * query parameter here. That is acceptable because the connection is HTTPS in
 * production and the token is short-lived - but it does mean the URL should
 * never be logged with query strings by an upstream proxy.
 *
 * Events emitted:
 *   notification            a durable notification for this staff member
 *   message                 a new internal message
 *   emergency:activated     a code was raised (payload.sound = true)
 *   emergency:acknowledged  a responder is on the way
 *   emergency:resolved      the code was stood down
 *   emergency:cleared       all codes cleared
 *   queue:updated           the waiting room changed
 *   pharmacy:updated        the pharmacy queue changed
 *   laboratory:updated      a lab order or result changed
 *   radiology:updated       an imaging order changed
 *   appointments:updated    the calendar changed
 *   staff:signed_in / staff:signed_out / staff:duty_changed
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { asyncHandler, ok } from '../lib/http.js';
import { unauthorized } from '../lib/errors.js';
import { resolveStaffFromToken, requireAuth } from '../middleware/auth.js';
import { subscribe, connectionStats } from '../lib/events.js';

const router = Router();

router.get(
  '/stream',
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : req.get('authorization')?.slice(7);
    if (!token) throw unauthorized('A token is required to open the event stream.');

    const staff = await resolveStaffFromToken(token);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Render and most reverse proxies buffer responses by default, which
      // would hold events until the connection closed. This disables it.
      'X-Accel-Buffering': 'no',
    });

    // Tell the client to wait 5s before reconnecting after a drop.
    res.write('retry: 5000\n\n');
    res.write(`event: connected\ndata: ${JSON.stringify({ staffId: staff.id, at: new Date().toISOString() })}\n\n`);

    const connectionId = crypto.randomUUID();
    const cleanup = subscribe(connectionId, res, staff);

    req.on('close', cleanup);
    req.on('error', cleanup);
  })
);

router.get(
  '/connections',
  requireAuth,
  asyncHandler(async (_req, res) => ok(res, connectionStats()))
);

export default router;
