// What the test files of Säckel share: the database of the tests, Säckel with a stand-in for
// who is signed in, requests, rows written straight into the tables, and the checks of locks.
// Database: hof_test as hof_saeckel. Nothing here registers a hook: each test file migrates,
// empties the tables before each test and closes both pools itself.

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { createSaeckelApp, type CurrentUser, type SaeckelUser } from './app.ts';

const password = process.env.HOF_SAECKEL_DB_PASSWORD;
assert.ok(password, 'HOF_SAECKEL_DB_PASSWORD is not set: create .env from .env.example');
export const pool = new Pool({ database: 'hof_test', user: 'hof_saeckel', password });

const FORM = 'application/x-www-form-urlencoded';

// The people of these tests. Who is signed in is told by a test header; there is no session.
const PEOPLE: Record<string, SaeckelUser> = {
  anna: { id: 1, username: 'anna' },
  boris: { id: 2, username: 'boris' },
};
export const signedIn: CurrentUser = (request) =>
  Promise.resolve(PEOPLE[request.headers.get('x-test-user') ?? ''] ?? null);

// The settings main.ts checks at startup.
export const SETTINGS = { currency: 'RUB', timeZone: 'Europe/Moscow' };
export const app = createSaeckelApp(pool, signedIn, SETTINGS);

// Nothing listens on port 1: any query through this pool fails, and the request with it.
export const deadPool = new Pool({ host: '127.0.0.1', port: 1 });
export const appWithoutDatabase = createSaeckelApp(deadPool, signedIn, SETTINGS);

export function get(path: string, who?: string, target = app) {
  return target.request(path, { headers: who === undefined ? {} : { 'x-test-user': who } });
}

// A form as a browser sends it. A field given as a list is sent once for each value.
export function post(
  path: string,
  fields: Record<string, string> | [string, string][],
  who?: string,
  target = app,
) {
  return target.request(path, {
    method: 'POST',
    headers: { 'content-type': FORM, ...(who === undefined ? {} : { 'x-test-user': who }) },
    body: new URLSearchParams(fields).toString(),
  });
}

export async function addPouch(userId: number, name: string, archived = false): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO pouches (user_id, name, is_archived) VALUES ($1, $2, $3) RETURNING id',
    [userId, name, archived],
  );
  return rows[0]!.id;
}

export async function pouches() {
  const { rows } = await pool.query<{
    id: number;
    user_id: number;
    name: string;
    icon: string;
    is_archived: boolean;
  }>('SELECT id, user_id, name, icon, is_archived FROM pouches ORDER BY id');
  return rows;
}

// A record written straight into the table, for the kinds a test has no form for yet.
export async function addOperation(
  userId: number,
  kind: 'income' | 'assign' | 'expense' | 'transfer',
  cents: number,
  pouches: { from?: number; to?: number } = {},
  date = '2026-10-05',
  note = '',
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO operations (user_id, kind, amount, currency, from_pouch_id, to_pouch_id, date, note)
     VALUES ($1, $2, $3, 'RUB', $4, $5, $6, $7) RETURNING id`,
    [userId, kind, cents, pouches.from ?? null, pouches.to ?? null, date, note],
  );
  return rows[0]!.id;
}

export async function operations() {
  const { rows } = await pool.query<{
    id: number;
    user_id: number;
    kind: string;
    amount: string;
    currency: string;
    from_pouch_id: number | null;
    to_pouch_id: number | null;
    date: string;
    note: string;
  }>(
    `SELECT id, user_id, kind, amount::text AS amount, currency, from_pouch_id, to_pouch_id,
            to_char(date, 'YYYY-MM-DD') AS date, note
       FROM operations ORDER BY id`,
  );
  return rows;
}

// A page with whitespace folded: money on the page is spaced with U+00A0.
export const fold = (page: string) => page.replace(/\s+/g, ' ');

// Мешки without the storeroom: the treasury and the active pouches only.
export function activeList(page: string): string {
  return page.split('<details')[0]!;
}

// The lines of the column of pouches as «<a href="…">name</a> · balance · what is said under the
// name», with whitespace folded: the link, its text and the two amounts of each row.
export function pouchLines(page: string): string[] {
  return [
    ...activeList(page).matchAll(/<a\s+class="pouch[^"]*"\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g),
  ].map(([, href, row]) => {
    const text = (name: string) =>
      fold(new RegExp(`<span class="${name}[^"]*">([^<]*)</span>`).exec(row!)?.[1] ?? '').trim();
    return `<a href="${href}">${text('name')}</a> · ${text('bal')} · ${text('sub')}`;
  });
}

// The sum of «Казна» in the column of a page of Мешки, with whitespace folded.
export function treasurySum(page: string): string | undefined {
  return /<h2 class="title t-3">Казна<\/h2> <p class="money[^"]*">([^<]*)<\/p>/.exec(
    fold(page),
  )?.[1];
}

// The way back on the band of a page below a tab, as «address text»; none on the tabs themselves.
export function wayBack(page: string): string | undefined {
  const back = /<a class="sk-gate sk-back" href="([^"]*)"\s*><span>([^<]*)<\/span><\/a\s*>/.exec(
    page,
  );
  return back === null ? undefined : `${back[1]} ${back[2]}`;
}

// The tab marked as the current one, by its text.
export function currentTab(page: string): string | undefined {
  return /<a class="tab" href="[^"]*" aria-current="page">([^<]*)<\/a>/.exec(page)?.[1];
}

// The balance of the open pouch on a page, as it is shown under «Остаток».
export function balanceOn(page: string): string | undefined {
  return /<p class="balance"> <span class="caps">Остаток<\/span> <span class="money[^"]*">([^<]*)<\/span>/.exec(
    fold(page),
  )?.[1];
}

// The movements of the open pouch on a page, as «ДД.ММ · kind · note · amount», the note left out
// when there is none; with `fresh`, only the one marked as just written.
export function movementLines(page: string, fresh = false): string[] {
  const list = /<ul class="moves">([\s\S]*?)<\/ul>/.exec(page)?.[1] ?? '';
  return [...list.matchAll(/<(span|mark) class="move[^"]*">([\s\S]*?)<\/\1>\s*<\/li>/g)]
    .filter(([, tag]) => !fresh || tag === 'mark')
    .map(([, , row]) =>
      [...row!.matchAll(/<span class="move-[a-z]+">([^<]*)<\/span>/g)]
        .map((cell) => fold(cell[1]!).trim())
        .filter((text) => text !== '')
        .join(' · '),
    );
}

// The text of a piece of a page without its tags, with whitespace folded: a sentence across
// the spans of its amounts.
export function textOf(page: string): string {
  return fold(page.replace(/<[^>]*>/g, '')).trim();
}

// The rows of «Разложить»: the name, the balance and what is in the field.
export function assignRows(page: string): string[][] {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(page)?.[1] ?? '';
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) => [
    textOf(/<span class="assign-name">([^<]*)<\/span>/.exec(row!)?.[1] ?? ''),
    textOf(/<td class="num money[^"]*">([^<]*)<\/td>/.exec(row!)?.[1] ?? ''),
    /value="([^"]*)"/.exec(row!)?.[1] ?? '',
  ]);
}

// The rows of «Летопись»: date, pouches, kind, note, amount — and the address of the record. The
// kind the phone shows after the pouches is left out of the pouches.
export function historyRows(page: string): string[][] {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(page)?.[1] ?? '';
  return [...body.matchAll(/<tr id="op-\d+">([\s\S]*?)<\/tr>/g)].map(([, row]) => {
    const cell = (name: string) =>
      new RegExp(`<td class="${name}[^"]*">([\\s\\S]*?)</td>`).exec(row!)?.[1] ?? '';
    const pouches = cell('h-pouch').replace(/<span class="h-kind-phone">[\s\S]*?<\/span>/, '');
    const href = /<a\s+class="link-plain"\s+href="([^"]*)"\s+aria-label="Открыть запись"/.exec(
      row!,
    )?.[1];
    return [
      textOf(cell('h-date')),
      textOf(pouches),
      textOf(cell('h-kind')),
      textOf(cell('h-note')),
      textOf(cell('h-sum')),
      href ?? '',
    ];
  });
}

// The page itself, without the shell and the column beside it.
export function mainPart(page: string): string {
  return page.split(/<main class="sk-main[^"]*">/)[1] ?? '';
}

// Resolves once `count` queries of hof_test wait for locks; returns them.
export async function waitingQueries(count: number): Promise<string[]> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query<{ query: string }>(
      "SELECT query FROM pg_stat_activity WHERE datname = 'hof_test' AND wait_event_type = 'Lock'",
    );
    if (rows.length >= count) return rows.map((row) => row.query);
    await sleep(10);
  }
  assert.fail(`${count} queries never waited for a lock`);
}

// After a request: every client is back in the pool, no connection was left inside a
// transaction, and nobody holds the row of the pouch. The pool hands out the client released
// last first: if that one was left inside a transaction, this check runs in it, and it shows
// as a transaction older than the check itself.
export async function assertNothingHeld(pouchId: number): Promise<void> {
  assert.equal(pool.totalCount - pool.idleCount, 0, 'a client was not released');
  const { rows } = await pool.query<{ open: number }>(
    `SELECT count(*)::int AS open FROM pg_stat_activity
      WHERE datname = 'hof_test'
        AND (state LIKE 'idle in transaction%' OR (pid = pg_backend_pid() AND xact_start < query_start))`,
  );
  assert.equal(rows[0]!.open, 0, 'a transaction was left open');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM pouches WHERE id = $1 FOR UPDATE NOWAIT', [pouchId]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// A trigger that fails, for the time of one test: on `event` of each row of `table` for which
// `when` holds — before the row is written or, deferred, at the COMMIT of the transaction.
// Returns the function that drops it.
export async function failingTrigger(
  table: 'pouches' | 'operations',
  event: 'INSERT' | 'UPDATE' | 'DELETE',
  { atCommit = false, when = 'true' } = {},
): Promise<() => Promise<void>> {
  await pool.query(
    "CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$",
  );
  await pool.query(
    atCommit
      ? `CREATE CONSTRAINT TRIGGER refuse_for_test AFTER ${event} ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION refuse_for_test()`
      : `CREATE TRIGGER refuse_for_test BEFORE ${event} ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION refuse_for_test()`,
  );
  return async () => {
    await pool.query(`DROP TRIGGER IF EXISTS refuse_for_test ON ${table}`);
    await pool.query('DROP FUNCTION IF EXISTS refuse_for_test()');
  };
}
