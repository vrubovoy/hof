// The Säckel schema created by the real migrations, against hof_test as hof_saeckel
// (ARCHITECTURE.md §5.4). Constraints are the second line behind the application's checks.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { DatabaseError, escapeIdentifier, Pool } from 'pg';
import { migrate } from '../migrate.ts';

const password = process.env.HOF_SAECKEL_DB_PASSWORD;
assert.ok(password, 'HOF_SAECKEL_DB_PASSWORD is not set: create .env from .env.example');
const pool = new Pool({ database: 'hof_test', user: 'hof_saeckel', password });

before(async () => {
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'saeckel'",
  );
  for (const { tablename } of rows) {
    await pool.query(`DROP TABLE ${escapeIdentifier(tablename)} CASCADE`);
  }
  await migrate(pool, join(import.meta.dirname, 'migrations'));
});
beforeEach(() => pool.query('TRUNCATE pouches RESTART IDENTITY'));
after(() => pool.end());

async function insertPouch(userId: number, name: string, archived = false): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO pouches (user_id, name, is_archived) VALUES ($1, $2, $3) RETURNING id',
    [userId, name, archived],
  );
  return rows[0]!.id;
}

// The name of the constraint the statement broke, or a failure if it went through.
async function violated(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (error) {
    assert.ok(error instanceof DatabaseError, String(error));
    return error.constraint;
  }
  assert.fail('the statement went through');
}

test('the tables and their owner: schema saeckel, role hof_saeckel', async () => {
  const { rows } = await pool.query<{ tablename: string; tableowner: string }>(
    "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'saeckel' ORDER BY tablename",
  );
  assert.deepEqual(rows, [
    { tablename: 'pouches', tableowner: 'hof_saeckel' },
    { tablename: 'schema_migrations', tableowner: 'hof_saeckel' },
  ]);
  const applied = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  assert.deepEqual(
    applied.rows.map((row) => row.name),
    ['001_pouches.sql'],
  );
});

test('creates the columns and indexes of §5.4', async () => {
  const columns = await pool.query<Record<string, string>>(
    `SELECT column_name, data_type, is_nullable, coalesce(column_default, '') AS column_default, is_identity
       FROM information_schema.columns
      WHERE table_schema = 'saeckel' AND table_name = 'pouches'
      ORDER BY ordinal_position`,
  );
  assert.deepEqual(
    columns.rows.map((c) =>
      [c.column_name, c.data_type, c.is_nullable, c.column_default, c.is_identity].join(' '),
    ),
    [
      'id integer NO  YES',
      'user_id integer NO  NO',
      'name text NO  NO',
      "icon text NO 'pouch'::text NO",
      'is_archived boolean NO false NO',
    ],
  );
  const indexes = await pool.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'saeckel' AND tablename = 'pouches' ORDER BY indexname",
  );
  assert.deepEqual(
    indexes.rows.map((row) => row.indexdef),
    [
      'CREATE UNIQUE INDEX pouches_active_name ON saeckel.pouches USING btree (user_id, lower(name)) WHERE (NOT is_archived)',
      'CREATE UNIQUE INDEX pouches_id_user ON saeckel.pouches USING btree (id, user_id)',
      'CREATE UNIQUE INDEX pouches_pkey ON saeckel.pouches USING btree (id)',
    ],
  );
  // No foreign key to Core: user_id is a plain value.
  const keys = await pool.query(
    "SELECT 1 FROM pg_constraint WHERE conrelid = 'saeckel.pouches'::regclass AND contype = 'f'",
  );
  assert.equal(keys.rowCount, 0);
});

test('a name of 1–50 characters without spaces at the edges', async () => {
  assert.ok(await insertPouch(1, 'а'));
  assert.ok(await insertPouch(1, 'я'.repeat(50)));
  // Code points, as char_length counts them: 50 emoji are 100 UTF-16 units.
  assert.ok(await insertPouch(1, '🪙'.repeat(50)));
  for (const name of ['', 'я'.repeat(51), ' Продукты', 'Продукты ']) {
    assert.equal(await violated(insertPouch(1, name)), 'pouches_name_format', JSON.stringify(name));
  }
});

test('active names of one user are unique regardless of case, Cyrillic included', async () => {
  await insertPouch(1, 'Продукты');
  for (const name of ['Продукты', 'ПРОДУКТЫ', 'продукты']) {
    assert.equal(await violated(insertPouch(1, name)), 'pouches_active_name', name);
  }
  await insertPouch(1, 'Ёлка');
  assert.equal(await violated(insertPouch(1, 'ёЛКА')), 'pouches_active_name');
  // Another user, and the storeroom, may repeat a name.
  assert.ok(await insertPouch(2, 'Продукты'));
  assert.ok(await insertPouch(1, 'Продукты', true));
  assert.ok(await insertPouch(1, 'ПРОДУКТЫ', true));
  // Back from the storeroom, a pouch runs into the active one of its name.
  const archived = await insertPouch(1, 'Квартира', true);
  await insertPouch(1, 'квартира');
  assert.equal(
    await violated(pool.query('UPDATE pouches SET is_archived = false WHERE id = $1', [archived])),
    'pouches_active_name',
  );
});

test('a new pouch gets the default sign and is not in the storeroom', async () => {
  const id = await insertPouch(1, 'Продукты');
  const { rows } = await pool.query<{ icon: string; is_archived: boolean }>(
    'SELECT icon, is_archived FROM pouches WHERE id = $1',
    [id],
  );
  assert.deepEqual(rows[0], { icon: 'pouch', is_archived: false });
});
