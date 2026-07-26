/**
 * MOAP Clinic HUD - application entry point.
 *
 * Boots the Express app, mounts every API router, serves the SPA, and shuts
 * down cleanly when Render sends SIGTERM during a deploy.
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config, assertConfigValid } from './config/env.js';
import { checkConnection, closePool } from './db/pool.js';
import { validateDefaultRoles } from './lib/permissions.js';
import { connectionStats } from './lib/events.js';
import { errorHandler, apiNotFound } from './middleware/error-handler.js';

import authRoutes from './routes/auth.js';
import staffRoutes from './routes/staff.js';
import patientRoutes from './routes/patients.js';
import visitRoutes from './routes/visits.js';
import queueRoutes from './routes/queue.js';
import appointmentRoutes from './routes/appointments.js';
import prescriptionRoutes from './routes/prescriptions.js';
import pharmacyRoutes from './routes/pharmacy.js';
import laboratoryRoutes from './routes/laboratory.js';
import radiologyRoutes from './routes/radiology.js';
import surgeryRoutes from './routes/surgery.js';
import billingRoutes from './routes/billing.js';
import insuranceRoutes from './routes/insurance.js';
import messagingRoutes from './routes/messaging.js';
import notificationRoutes from './routes/notifications.js';
import emergencyRoutes from './routes/emergency.js';
import certificateRoutes from './routes/certificates.js';
import catalogRoutes from './routes/catalog.js';
import statsRoutes from './routes/stats.js';
import settingsRoutes from './routes/settings.js';
import eventRoutes from './routes/events.js';
import lslRoutes from './routes/lsl.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

assertConfigValid();

const roleProblems = validateDefaultRoles();
if (roleProblems.length > 0) {
  throw new Error(`Permission catalogue is inconsistent:\n  - ${roleProblems.join('\n  - ')}`);
}

const app = express();

// Render terminates TLS at its edge, so req.ip and rate limiting need to read
// the forwarded header. `1` = trust exactly one proxy hop.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Style attributes are used for dynamic widths on gauges and charts,
        // which cannot be expressed in a static stylesheet.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Lab and radiology images are hosted wherever the clinic keeps them.
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    // The Second Life browser is an older Chromium build; cross-origin
    // isolation headers make it refuse to load the page at all.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header at all: same-origin navigation, curl, or an LSL
      // llHTTPRequest. The Second Life browser sends "null" for MOAP pages.
      if (!origin || origin === 'null') return callback(null, true);
      if (config.corsOrigins.length === 0) return callback(null, true);
      if (config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed`));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Clinic-Key', 'X-Staff-Token',
                     'X-SL-Object-Key', 'X-SL-Object-Name', 'X-SL-Owner-Key', 'X-SL-Region'],
  })
);

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(
  morgan(config.isProduction ? 'combined' : 'dev', {
    // Health checks every few seconds would drown the log.
    skip: (req) => req.path === '/api/health',
  })
);

// Blanket limit. Individual routes (login, the LSL bridge) set stricter ones.
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    // SSE connections are long-lived, not repeated requests.
    skip: (req) => req.path === '/events/stream',
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down a moment.' } },
  })
);

// --- Health ---------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  try {
    const db = await checkConnection();
    res.json({
      success: true,
      data: {
        status: 'ok',
        environment: config.env,
        database: { connected: true, server_time: db.server_time },
        realtime: connectionStats(),
        uptime_seconds: Math.round(process.uptime()),
      },
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Database is not reachable.' },
      data: { status: 'degraded', database: { connected: false } },
    });
  }
});

// --- API ------------------------------------------------------------------

app.use('/api/auth', authRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/visits', visitRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/prescriptions', prescriptionRoutes);
app.use('/api/pharmacy', pharmacyRoutes);
app.use('/api/laboratory', laboratoryRoutes);
app.use('/api/radiology', radiologyRoutes);
app.use('/api/surgery', surgeryRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/insurance', insuranceRoutes);
app.use('/api/messages', messagingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/emergency', emergencyRoutes);
app.use('/api/certificates', certificateRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/lsl', lslRoutes);

app.use('/api', apiNotFound);

// --- SPA ------------------------------------------------------------------

app.use(
  express.static(publicDir, {
    // The SPA shell must not be cached or a deploy leaves stale JS behind;
    // fingerprint-free assets get a short cache instead.
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  })
);

// Any non-API path falls through to the SPA shell, so deep links work.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(join(publicDir, 'index.html'));
});

app.use(errorHandler);

// --- Boot -----------------------------------------------------------------

const server = app.listen(config.port, () => {
  console.log(`[server] MOAP Clinic HUD listening on port ${config.port} (${config.env})`);
  checkConnection()
    .then((db) => console.log(`[server] database connected - ${db.version.split(',')[0]}`))
    .catch((err) => console.error('[server] DATABASE UNREACHABLE:', err.message));
});

// SSE connections hold the socket open; without a timeout the process would
// wait for them forever during a deploy.
const SHUTDOWN_GRACE_MS = 10_000;

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);

  const forceExit = setTimeout(() => {
    console.warn('[server] grace period expired, forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  server.close(async () => {
    try {
      await closePool();
      console.log('[server] closed cleanly');
      process.exit(0);
    } catch (err) {
      console.error('[server] error during shutdown:', err.message);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled promise rejection:', reason);
});

export default app;
