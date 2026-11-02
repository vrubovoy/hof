// Forward-only SQL migrations of one module (ARCHITECTURE.md §5, §5.7).
//
// The module's migrations folder holds files named NNN_name.sql. They are applied in name order,
// each in its own transaction, through the module's pool, so under the module's database role.
// The names of applied files are recorded in schema_migrations, an unqualified table name that
// the role's search_path places in the module's own schema.
//
// A migration file contains plain SQL statements without BEGIN or COMMIT: the transaction
// around the file is opened and closed here. There is no rollback of migrations and no transaction
// around the whole set: a failure undoes only the failed file (docs/OPERATIONS.md).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

const FILE_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

// Refuses a database with applied migrations that the folder does not hold: this code has never
// seen such a schema. Compares names only, so it says nothing about compatibility (§5.7). Changes
// nothing: on a clean database schema_migrations does not exist yet and the set is empty.
export async function checkApplied(pool: Pool, dir: string): Promise<void> {
  const { rows: tables } = await pool.query<{ found: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS found",
  );
  if (!tables[0]!.found) return;
  const { rows } = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  const files = new Set(await readdir(dir));
  const unknown = rows.map((row) => row.name).filter((name) => !files.has(name));
  if (unknown.length > 0) {
    throw new Error(`applied migrations missing from ${dir}: ${unknown.join(', ')}`);
  }
}

// Applies the migrations not yet recorded and returns their file names, in order.
// Throws on the first failure; the failed file leaves no trace, earlier files stay applied.
export async function migrate(pool: Pool, dir: string): Promise<string[]> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)');
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const alreadyApplied = new Set(rows.map((row) => row.name));

  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (!FILE_NAME.test(file)) {
      throw new Error(`migration file name must look like 001_name.sql: ${file}`);
    }
    if (alreadyApplied.has(file)) continue;

    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${file} failed: ${reason}`, { cause: error });
    } finally {
      client.release();
    }
    applied.push(file);
  }
  return applied;
}
