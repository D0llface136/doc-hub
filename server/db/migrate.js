/**
 * Schema migration runner.
 *
 *   npm run db:migrate           apply schema.sql (idempotent)
 *   npm run db:migrate -- --drop drop every table first, then apply
 *
 * schema.sql is written to be safely re-runnable, so "migrating" is simply
 * executing it. --drop is destructive and exists for rebuilding a dev database.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, closePool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

async function dropEverything(client) {
  console.warn('[migrate] --drop: dropping the public schema');
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
  // Supabase expects these grants on a fresh public schema.
  await client.query('GRANT ALL ON SCHEMA public TO public');
}

async function main() {
  const shouldDrop = process.argv.includes('--drop');

  if (shouldDrop && process.env.NODE_ENV === 'production') {
    console.error('[migrate] refusing to run --drop with NODE_ENV=production');
    process.exit(1);
  }

  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  const client = await pool.connect();

  try {
    if (shouldDrop) await dropEverything(client);

    console.log('[migrate] applying schema.sql ...');
    await client.query(sql);

    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    console.log(`[migrate] done - ${rows[0].n} tables present`);
  } catch (err) {
    console.error('[migrate] FAILED:', err.message);
    if (err.position) {
      // Point at the offending statement, which is far more useful than a
      // character offset into a 900-line file.
      const offset = Number(err.position);
      const context = sql.slice(Math.max(0, offset - 200), offset + 200);
      console.error('[migrate] near:\n---\n' + context + '\n---');
    }
    process.exitCode = 1;
  } finally {
    client.release();
    await closePool();
  }
}

main();
