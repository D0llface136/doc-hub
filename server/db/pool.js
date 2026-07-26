/**
 * PostgreSQL connection pool and query helpers.
 *
 * Everything that touches the database goes through here so we get one place
 * for pooling, SSL configuration, slow-query logging and transactions.
 */
import pg from 'pg';
import { config } from '../config/env.js';

const { Pool, types } = pg;

// node-postgres returns DATE (OID 1082) as a JS Date in the server's local
// timezone, which silently shifts a date of birth by a day. Keep it as the
// plain "YYYY-MM-DD" string the database actually stores.
types.setTypeParser(1082, (value) => value);

// NUMERIC (OID 1700) arrives as a string to preserve precision. Money stays a
// string on the way out; callers that need arithmetic parse explicitly.
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

// BIGINT (OID 20) - counts from COUNT(*) are always small here, so returning a
// number is safe and avoids "1" vs 1 comparisons leaking into the API.
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

export const pool = new Pool({
  connectionString: config.db.url,
  ssl: { rejectUnauthorized: config.db.rejectUnauthorized },
  max: config.db.poolMax,
  idleTimeoutMillis: config.db.idleTimeoutMs,
  connectionTimeoutMillis: config.db.connectionTimeoutMs,
  // Supabase's pooler drops idle sessions; keepalive stops us handing a dead
  // socket to the next request.
  keepAlive: true,
});

pool.on('error', (err) => {
  // An idle client erroring out is not fatal - the pool replaces it - but we
  // want it in the logs rather than as an unhandled 'error' event.
  console.error('[db] idle client error:', err.message);
});

const SLOW_QUERY_MS = 500;

/**
 * Run a parameterised query.
 * @param {string} text SQL with $1, $2 ... placeholders. Never interpolate.
 * @param {unknown[]} params
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(text, params = []) {
  const startedAt = Date.now();
  try {
    const result = await pool.query(text, params);
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_QUERY_MS) {
      console.warn(`[db] slow query (${elapsed}ms): ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
    return result;
  } catch (err) {
    // Attach the statement so the error handler can log something actionable,
    // without ever logging the parameter values (they contain patient data).
    err.sql = text.slice(0, 300);
    throw err;
  }
}

/** Return every row. */
export async function rows(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

/** Return the first row, or null. */
export async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction on a dedicated client.
 * Commits on success, rolls back on any throw, and always releases the client.
 *
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Verify the database is reachable. Used by /api/health and at boot. */
export async function checkConnection() {
  const result = await pool.query('SELECT now() AS server_time, version() AS version');
  return result.rows[0];
}

export async function closePool() {
  await pool.end();
}
