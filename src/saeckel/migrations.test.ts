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
beforeEach(() => pool.query('TRUNCATE operations, pouches RESTART IDENTITY'));
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
    { tablename: 'operations', tableowner: 'hof_saeckel' },
    { tablename: 'pouches', tableowner: 'hof_saeckel' },
    { tablename: 'schema_migrations', tableowner: 'hof_saeckel' },
  ]);
  const applied = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  assert.deepEqual(
    applied.rows.map((row) => row.name),
    ['001_pouches.sql', '002_operations.sql'],
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

// operations (§5.5): a record of one kind, with the pouches that kind needs, of its own user.
async function insertOperation(
  fields: {
    userId?: number;
    kind?: string;
    amount?: number | string;
    currency?: string;
    from?: number | null;
    to?: number | null;
    date?: string;
    note?: string;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO operations (user_id, kind, amount, currency, from_pouch_id, to_pouch_id, date, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      fields.userId ?? 1,
      fields.kind ?? 'income',
      fields.amount ?? 100,
      fields.currency ?? 'RUB',
      fields.from ?? null,
      fields.to ?? null,
      fields.date ?? '2026-10-05',
      fields.note ?? '',
    ],
  );
  return rows[0]!.id;
}

test('operations: the columns, the index, keys only to pouches', async () => {
  const columns = await pool.query<Record<string, string>>(
    `SELECT column_name, data_type, is_nullable, coalesce(column_default, '') AS column_default, is_identity
       FROM information_schema.columns
      WHERE table_schema = 'saeckel' AND table_name = 'operations'
      ORDER BY ordinal_position`,
  );
  assert.deepEqual(
    columns.rows.map((c) =>
      [c.column_name, c.data_type, c.is_nullable, c.column_default, c.is_identity].join(' '),
    ),
    [
      'id integer NO  YES',
      'user_id integer NO  NO',
      'kind text NO  NO',
      'amount bigint NO  NO',
      'currency text NO  NO',
      'from_pouch_id integer YES  NO',
      'to_pouch_id integer YES  NO',
      'date date NO  NO',
      "note text NO ''::text NO",
    ],
  );
  const indexes = await pool.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'saeckel' AND tablename = 'operations' ORDER BY indexname",
  );
  assert.deepEqual(
    indexes.rows.map((row) => row.indexdef),
    [
      'CREATE UNIQUE INDEX operations_pkey ON saeckel.operations USING btree (id)',
      'CREATE INDEX operations_user_date ON saeckel.operations USING btree (user_id, date, id)',
    ],
  );
  const keys = await pool.query<{ definition: string }>(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'saeckel.operations'::regclass AND contype = 'f' ORDER BY 1",
  );
  assert.deepEqual(
    keys.rows.map((row) => row.definition),
    [
      'FOREIGN KEY (from_pouch_id, user_id) REFERENCES pouches(id, user_id)',
      'FOREIGN KEY (to_pouch_id, user_id) REFERENCES pouches(id, user_id)',
    ],
  );
});

test('operations: each kind with the pouches it needs, and no other way', async () => {
  const one = await insertPouch(1, 'Продукты');
  const two = await insertPouch(1, 'Квартира');
  // Allowed.
  assert.ok(await insertOperation({ kind: 'income' }));
  assert.ok(await insertOperation({ kind: 'assign', to: one }));
  assert.ok(await insertOperation({ kind: 'expense', from: one }));
  assert.ok(await insertOperation({ kind: 'transfer', from: one, to: two }));
  // Every other combination.
  const wrong: Parameters<typeof insertOperation>[0][] = [
    { kind: 'income', from: one },
    { kind: 'income', to: one },
    { kind: 'assign' },
    { kind: 'assign', from: one },
    { kind: 'assign', from: one, to: two },
    { kind: 'expense' },
    { kind: 'expense', to: one },
    { kind: 'expense', from: one, to: two },
    { kind: 'transfer', from: one },
    { kind: 'transfer', to: two },
    { kind: 'transfer', from: one, to: one },
  ];
  for (const fields of wrong) {
    assert.equal(
      await violated(insertOperation(fields)),
      'operations_pouches_by_kind',
      JSON.stringify(fields),
    );
  }
});

test('operations: kind, amount, currency and note are checked', async () => {
  const constraintOf = async (fields: Parameters<typeof insertOperation>[0]) =>
    (await violated(insertOperation(fields)))?.replace(/^operations_|_check$/g, '');
  assert.equal(await constraintOf({ kind: 'gift' }), 'kind');
  assert.ok(await insertOperation({ amount: 1 }));
  assert.ok(await insertOperation({ amount: 100_000_000_000 }));
  for (const amount of [0, -1, 100_000_000_001]) {
    assert.equal(await constraintOf({ amount }), 'amount', String(amount));
  }
  for (const currency of ['rub', 'RU', 'RUBL', 'R1B', '']) {
    assert.equal(await constraintOf({ currency }), 'currency', currency);
  }
  assert.ok(await insertOperation({ note: 'я'.repeat(200) }));
  assert.equal(await constraintOf({ note: 'я'.repeat(201) }), 'note');
});

test('operations: a record cannot point to a pouch of another user', async () => {
  const hers = await insertPouch(1, 'Продукты');
  const his = await insertPouch(2, 'Продукты');
  // The pouch exists, but not for this user: the composite foreign key refuses it.
  for (const fields of [
    { userId: 2, kind: 'expense', from: hers },
    { userId: 2, kind: 'assign', to: hers },
    { userId: 1, kind: 'transfer', from: hers, to: his },
    { userId: 1, kind: 'expense', from: 999 },
  ]) {
    await assert.rejects(
      insertOperation(fields),
      /violates foreign key constraint/,
      JSON.stringify(fields),
    );
  }
  assert.ok(await insertOperation({ userId: 2, kind: 'expense', from: his }));
});

test('operations: a date stays the same calendar date through the database', async () => {
  for (const date of ['2000-01-01', '2024-02-29', '2026-12-31']) {
    const id = await insertOperation({ date });
    const { rows } = await pool.query<{ date: string }>(
      "SELECT to_char(date, 'YYYY-MM-DD') AS date FROM operations WHERE id = $1",
      [id],
    );
    assert.equal(rows[0]!.date, date);
  }
});
