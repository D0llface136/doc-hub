/**
 * Centralised environment configuration.
 *
 * Every value the app needs is read once, here, and validated at boot. If a
 * required secret is missing we fail immediately with a readable message
 * rather than throwing something cryptic on the first request.
 */
import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

/** Read an env var, falling back to a default. Empty strings count as unset. */
function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export const config = {
  env: str('NODE_ENV', 'development'),
  isProduction,
  port: int('PORT', 3000),
  publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),

  db: {
    url: str('DATABASE_URL', ''),
    // Supabase's pooler presents a certificate Node cannot chain to a system
    // root, so verification is disabled by default. The connection is still
    // encrypted; only the certificate check is skipped.
    rejectUnauthorized: bool('PGSSL_REJECT_UNAUTHORIZED', false),
    poolMax: int('PG_POOL_MAX', 10),
    idleTimeoutMs: int('PG_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMs: int('PG_CONNECTION_TIMEOUT_MS', 10_000),
  },

  auth: {
    jwtSecret: str('JWT_SECRET', ''),
    jwtExpiresIn: str('JWT_EXPIRES_IN', '12h'),
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
    maxFailedLogins: int('MAX_FAILED_LOGINS', 8),
    lockoutMinutes: int('LOCKOUT_MINUTES', 15),
  },

  lsl: {
    apiKey: str('LSL_API_KEY', ''),
  },

  corsOrigins: str('CORS_ORIGINS', '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  seed: {
    adminPassword: str('SEED_ADMIN_PASSWORD', 'ClinicTemp2026!'),
  },
};

/**
 * Validate configuration. Called from index.js before the server binds a port.
 * Throws with every problem listed at once, so a misconfigured deploy does not
 * require one restart per missing variable.
 */
export function assertConfigValid() {
  const problems = [];

  if (!config.db.url) {
    problems.push('DATABASE_URL is required (Supabase pooler connection string).');
  }

  if (!config.auth.jwtSecret) {
    problems.push('JWT_SECRET is required.');
  } else if (config.auth.jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters.');
  } else if (isProduction && config.auth.jwtSecret.includes('change-me')) {
    problems.push('JWT_SECRET is still the placeholder value from .env.example.');
  }

  if (isProduction && !config.lsl.apiKey) {
    problems.push('LSL_API_KEY is required in production for the in-world bridge.');
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid configuration:\n  - ${problems.join('\n  - ')}\n\n` +
        'See .env.example for the full list of settings.'
    );
  }
}
