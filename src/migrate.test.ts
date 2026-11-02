// migrate.ts against hof_test as hof_core, with migration files from a temporary folder:
// order, a repeated run, a failed file, owner and schema of the created tables. Then the check of
// applied migrations in both modules, each under its own role, and a set that stops halfway.

import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { escapeIdentifier, Pool } from 'pg';
import { migrateModules } from './main.ts';
import { checkApplied, migrate } from './migrate.ts';

const password = process.env.HOF_CORE_DB_PASSWORD;
assert.ok(password, 'HOF_CORE_DB_PASSWORD is not set: create .env from .env.example');
const pool = new Pool({ database: 'hof_test', user: 'hof_core', password });
const saeckelPassword = process.env.HOF_SAECKEL_DB_PASSWORD;
assert.ok(saeckelPassword, 'HOF_SAECKEL_DB_PASSWORD is not set: create .env from .env.example');
const saeckelPool = new Pool({
  database: 'hof_test',
  user: 'hof_saeckel',
  password: saeckelPassword,
});

const REAL_CORE = join(import.meta.dirname, 'core', 'migrations');
const REAL_SAECKEL = join(import.meta.dirname, 'saeckel', 'migrations');

let dir = '';
let saeckelDir = '';

async function dropTables(owner: Pool, schema: string): Promise<void> {
  const { rows } = await owner.query<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE schemaname = $1',
    [schema],
  );
  for (const { tablename } of rows) {
    await owner.query(`DROP TABLE ${escapeIdentifier(tablename)} CASCADE`);
  }
}

async function dropAllTables(): Promise<void> {
  await dropTables(pool, 'core');
  await dropTables(saeckelPool, 'saeckel');
}

beforeEach(async () => {
  await dropAllTables();
  dir = await mkdtemp(join(tmpdir(), 'hof-migrate-'));
  saeckelDir = await mkdtemp(join(tmpdir(), 'hof-migrate-saeckel-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(saeckelDir, { recursive: true, force: true });
});
after(async () => {
  await dropAllTables();
  await Promise.all([pool.end(), saeckelPool.end()]);
});

async function writeFiles(files: Record<string, string>, folder = dir): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(folder, name), content);
  }
}

async function recorded(owner = pool): Promise<string[]> {
  const { rows } = await owner.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  return rows.map((row) => row.name);
}

// Every table of both modules: what a refused start must leave as it was.
async function tables(): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    "SELECT schemaname || '.' || tablename AS name FROM pg_tables WHERE schemaname IN ('core', 'saeckel') ORDER BY 1",
  );
  return rows.map((row) => row.name);
}

const CREATE_A = 'CREATE TABLE a (id integer PRIMARY KEY);';
const CREATE_B = 'CREATE TABLE b (a_id integer REFERENCES a (id));';

test('applies files in name order and records each one', async () => {
  // 002 refers to the table from 001, so it fails if the order is wrong.
  await writeFiles({ '002_b.sql': CREATE_B, '001_a.sql': CREATE_A, 'notes.txt': 'not SQL' });
  assert.deepEqual(await migrate(pool, dir), ['001_a.sql', '002_b.sql']);
  assert.deepEqual(await recorded(), ['001_a.sql', '002_b.sql']);
});

test('a repeated run applies nothing; a new file is applied alone', async () => {
  await writeFiles({ '001_a.sql': CREATE_A });
  assert.deepEqual(await migrate(pool, dir), ['001_a.sql']);
  assert.deepEqual(await migrate(pool, dir), []);
  await writeFiles({ '002_b.sql': CREATE_B });
  assert.deepEqual(await migrate(pool, dir), ['002_b.sql']);
  assert.deepEqual(await recorded(), ['001_a.sql', '002_b.sql']);
});

test('a failed migration is rolled back completely and not recorded', async () => {
  await writeFiles({
    '001_a.sql': CREATE_A,
    '002_broken.sql': 'CREATE TABLE half_done (id integer);\nSELECT 1 / 0;',
  });
  await assert.rejects(migrate(pool, dir), {
    message: 'migration 002_broken.sql failed: division by zero',
  });
  assert.deepEqual(await recorded(), ['001_a.sql']);
  const { rows } = await pool.query<{ a: string | null; half_done: string | null }>(
    "SELECT to_regclass('core.a')::text AS a, to_regclass('core.half_done')::text AS half_done",
  );
  assert.deepEqual(rows, [{ a: 'a', half_done: null }]);
});

test('tables belong to hof_core and live in schema core', async () => {
  await writeFiles({ '001_a.sql': CREATE_A });
  await migrate(pool, dir);
  // The tables of hof_core, wherever they are; Säckel has a schema_migrations of its own.
  const { rows } = await pool.query<{ tablename: string; schemaname: string; tableowner: string }>(
    "SELECT tablename, schemaname, tableowner FROM pg_tables WHERE tablename IN ('a', 'schema_migrations') AND tableowner = 'hof_core' ORDER BY tablename",
  );
  assert.deepEqual(rows, [
    { tablename: 'a', schemaname: 'core', tableowner: 'hof_core' },
    { tablename: 'schema_migrations', schemaname: 'core', tableowner: 'hof_core' },
  ]);
});

test('rejects a file name without the NNN_ prefix', async () => {
  await writeFiles({ '1_a.sql': CREATE_A });
  await assert.rejects(migrate(pool, dir), {
    message: 'migration file name must look like 001_name.sql: 1_a.sql',
  });
});

test('a clean database passes the check and nothing is created', async () => {
  await writeFiles({ '001_a.sql': CREATE_A });
  await checkApplied(pool, dir);
  await checkApplied(saeckelPool, saeckelDir);
  assert.deepEqual(await tables(), []);
});

test('the real set: a clean database gets all of it, a repeated start nothing', async () => {
  assert.deepEqual(await migrateModules(pool, REAL_CORE, saeckelPool, REAL_SAECKEL), [
    'core/001_users.sql',
    'core/002_sessions.sql',
    'saeckel/001_pouches.sql',
    'saeckel/002_operations.sql',
  ]);
  assert.deepEqual(await migrateModules(pool, REAL_CORE, saeckelPool, REAL_SAECKEL), []);
});

test('a database of an earlier milestone gets the missing migrations as before', async () => {
  // The real files in the order they were released: M1, M2, M3, M4.
  const states = [
    { core: ['001_users.sql'], saeckel: [] },
    { core: ['001_users.sql', '002_sessions.sql'], saeckel: [] },
    { core: ['001_users.sql', '002_sessions.sql'], saeckel: ['001_pouches.sql'] },
    {
      core: ['001_users.sql', '002_sessions.sql'],
      saeckel: ['001_pouches.sql', '002_operations.sql'],
    },
  ];
  const all = [
    'core/001_users.sql',
    'core/002_sessions.sql',
    'saeckel/001_pouches.sql',
    'saeckel/002_operations.sql',
  ];
  for (const state of states) {
    await dropAllTables();
    const coreOld = await mkdtemp(join(dir, 'core-'));
    const saeckelOld = await mkdtemp(join(dir, 'saeckel-'));
    for (const file of state.core) await copyFile(join(REAL_CORE, file), join(coreOld, file));
    for (const file of state.saeckel) {
      await copyFile(join(REAL_SAECKEL, file), join(saeckelOld, file));
    }
    const before = await migrateModules(pool, coreOld, saeckelPool, saeckelOld);
    const rest = await migrateModules(pool, REAL_CORE, saeckelPool, REAL_SAECKEL);
    assert.deepEqual([...before, ...rest], all);
  }
});

test('an unknown name in Säckel stops the start before the waiting migration of Core', async () => {
  await writeFiles({ '001_s.sql': CREATE_A, '002_gone.sql': CREATE_B }, saeckelDir);
  await migrate(saeckelPool, saeckelDir);
  await rm(join(saeckelDir, '002_gone.sql'));
  await writeFiles({ '001_waiting.sql': 'CREATE TABLE waiting (id integer);' });
  const before = await tables();
  await assert.rejects(migrateModules(pool, dir, saeckelPool, saeckelDir), {
    message: `applied migrations missing from ${saeckelDir}: 002_gone.sql`,
  });
  assert.deepEqual(await tables(), before);
  assert.deepEqual(await recorded(saeckelPool), ['001_s.sql', '002_gone.sql']);
});

test('an unknown name in Core stops the start before the waiting migration of Säckel', async () => {
  await writeFiles({
    '001_a.sql': CREATE_A,
    '002_gone.sql': CREATE_B,
    '003_gone.sql': 'SELECT 1;',
  });
  await migrate(pool, dir);
  await rm(join(dir, '002_gone.sql'));
  await rm(join(dir, '003_gone.sql'));
  await writeFiles({ '001_waiting.sql': 'CREATE TABLE waiting (id integer);' }, saeckelDir);
  const before = await tables();
  // Every unknown name is in the message.
  await assert.rejects(migrateModules(pool, dir, saeckelPool, saeckelDir), {
    message: `applied migrations missing from ${dir}: 002_gone.sql, 003_gone.sql`,
  });
  assert.deepEqual(await tables(), before);
});

test('the same names in two modules do not mix', async () => {
  // The same number and even the same file name, with a table of its own in each module.
  await writeFiles({ '001_same.sql': CREATE_A, '002_core_only.sql': CREATE_B });
  await writeFiles({ '001_same.sql': 'CREATE TABLE s (id integer);' }, saeckelDir);
  assert.deepEqual(await migrateModules(pool, dir, saeckelPool, saeckelDir), [
    'core/001_same.sql',
    'core/002_core_only.sql',
    'saeckel/001_same.sql',
  ]);
  assert.deepEqual(await recorded(pool), ['001_same.sql', '002_core_only.sql']);
  assert.deepEqual(await recorded(saeckelPool), ['001_same.sql']);
  // A file of Säckel does not answer for Core: each module has only its own folder.
  await rm(join(dir, '001_same.sql'));
  await assert.rejects(migrateModules(pool, dir, saeckelPool, saeckelDir), {
    message: `applied migrations missing from ${dir}: 001_same.sql`,
  });
  // The other way round: a file only Core has is no concern of Säckel.
  await writeFiles({ '001_same.sql': CREATE_A });
  await rm(join(saeckelDir, '001_same.sql'));
  await assert.rejects(migrateModules(pool, dir, saeckelPool, saeckelDir), {
    message: `applied migrations missing from ${saeckelDir}: 001_same.sql`,
  });
});

test('a set that stops halfway: the earlier files stay, the code that lost them is refused, the fixed set finishes', async () => {
  const first = await mkdtemp(join(dir, 'first-'));
  await writeFiles({ '001_a.sql': CREATE_A }, first);
  await writeFiles({
    '001_a.sql': CREATE_A,
    '002_b.sql': CREATE_B,
    '003_c.sql': 'CREATE TABLE half_done (id integer);\nSELECT 1 / 0;',
  });
  await assert.rejects(migrate(pool, dir), {
    message: 'migration 003_c.sql failed: division by zero',
  });
  assert.deepEqual(await recorded(), ['001_a.sql', '002_b.sql']);
  assert.deepEqual(await tables(), ['core.a', 'core.b', 'core.schema_migrations']);
  // Records may arrive only after a full set; here they prove that nothing below touches the tables.
  await pool.query('INSERT INTO a (id) VALUES (1)');
  await pool.query('INSERT INTO b (a_id) VALUES (1)');

  // Code that holds the first file only does not know the second one.
  await writeFiles({ '001_waiting.sql': 'CREATE TABLE waiting (id integer);' }, saeckelDir);
  await assert.rejects(migrateModules(pool, first, saeckelPool, saeckelDir), {
    message: `applied migrations missing from ${first}: 002_b.sql`,
  });
  assert.deepEqual(await recorded(), ['001_a.sql', '002_b.sql']);
  assert.deepEqual(await tables(), ['core.a', 'core.b', 'core.schema_migrations']);

  // The failed file was applied nowhere, so it may be corrected under the same name.
  await writeFiles({ '003_c.sql': 'CREATE TABLE c (id integer);' });
  assert.deepEqual(await migrate(pool, dir), ['003_c.sql']);
  assert.deepEqual(await recorded(), ['001_a.sql', '002_b.sql', '003_c.sql']);
  assert.deepEqual(await tables(), ['core.a', 'core.b', 'core.c', 'core.schema_migrations']);
  const { rows } = await pool.query(
    'SELECT (SELECT count(*) FROM a)::int AS a, (SELECT count(*) FROM b)::int AS b',
  );
  assert.deepEqual(rows, [{ a: 1, b: 1 }]);
});

test('a failure in Säckel leaves the migrations of Core applied', async () => {
  await writeFiles({ '001_a.sql': CREATE_A });
  await writeFiles(
    { '001_s.sql': 'CREATE TABLE s (id integer);', '002_broken.sql': 'SELECT 1 / 0;' },
    saeckelDir,
  );
  await assert.rejects(migrateModules(pool, dir, saeckelPool, saeckelDir), {
    message: 'migration 002_broken.sql failed: division by zero',
  });
  assert.deepEqual(await recorded(pool), ['001_a.sql']);
  assert.deepEqual(await recorded(saeckelPool), ['001_s.sql']);
});
