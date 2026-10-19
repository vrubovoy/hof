// cli.ts reset-password (ARCHITECTURE.md §4.3, §4.8): the checks before the database as a separate
// process, the command against hof_test. Its transaction is the shared one of
// core/reset-password.ts and is tested there. The hidden input needs a real terminal and is
// checked by hand (docs/OPERATIONS.md, «Восстановление доступа»).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { resetPasswordCommand } from './cli.ts';
import { hashPassword, verifyPassword } from './core/password.ts';
import { hashSessionToken, newSessionToken } from './core/sessions.ts';
import { migrate } from './migrate.ts';

const password = process.env.HOF_CORE_DB_PASSWORD;
assert.ok(password, 'HOF_CORE_DB_PASSWORD is not set: create .env from .env.example');
const pool = new Pool({ database: 'hof_test', user: 'hof_core', password });

before(() => migrate(pool, join(import.meta.dirname, 'core', 'migrations')));
beforeEach(() => pool.query('TRUNCATE sessions, users RESTART IDENTITY'));
after(() => pool.end());

const OLD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new password for the court';
const OLD_HASH = await hashPassword(OLD_PASSWORD);

describe('before the database', () => {
  // The command as a separate process with only the given environment. Its stdin is a pipe that
  // carries a password, as a careless script would send it.
  function run(args: string[], env: Record<string, string>) {
    return spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
      input: `${NEW_PASSWORD}\n${NEW_PASSWORD}\n`,
      encoding: 'utf8',
      timeout: 10_000,
    });
  }
  // A database that cannot be reached: had the command connected, the error would say so.
  const nowhere = { HOF_CORE_DB_PASSWORD: 'x', PGHOST: '127.0.0.1', PGPORT: '1' };
  const USAGE = 'Использование: node src/cli.ts reset-password <логин>\n';

  for (const args of [[], ['reset'], ['reset-password'], ['reset-password', 'anna', 'extra']]) {
    test(`command line ${JSON.stringify(args)}: usage, exit 1`, () => {
      const result = run(args, nowhere);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, USAGE);
      assert.equal(result.stdout, '');
    });
  }

  test('without HOF_CORE_DB_PASSWORD: exit 1, the variable named', () => {
    const result = run(['reset-password', 'anna'], { PGHOST: '127.0.0.1', PGPORT: '1' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'Не задан HOF_CORE_DB_PASSWORD (см. .env.example).\n');
  });

  test('stdin is not a terminal: exit 1 before the database and before any prompt', () => {
    const result = run(['reset-password', 'anna'], nowhere);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^Пароль вводится только с клавиатуры: stdin должен быть терминалом/,
    );
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|Ошибка/);
    assert.equal(result.stdout, '');
  });
});

// Silences the output of the command during the test and returns what was written.
function captureOutput(t: TestContext): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  t.mock.method(console, 'log', (line: string) => stdout.push(line));
  t.mock.method(console, 'error', (line: string) => stderr.push(line));
  return { stdout, stderr };
}

async function addUser(username: string, disabled = false): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO users (username, password_hash, is_disabled) VALUES ($1, $2, $3) RETURNING id',
    [username, OLD_HASH, disabled],
  );
  return rows[0]!.id;
}

async function addSession(userId: number): Promise<string> {
  const token = newSessionToken();
  await pool.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
    [hashSessionToken(token), userId],
  );
  return token;
}

async function sessionsOf(userId: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1',
    [userId],
  );
  return rows[0]!.n;
}

async function userRow(userId: number) {
  const { rows } = await pool.query<{ password_hash: string; is_disabled: boolean }>(
    'SELECT password_hash, is_disabled FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]!;
}

// The typed passwords for resetPasswordCommand, in place of the terminal; counts the asks.
function typing(typed: [string, string] | null) {
  const asked = { times: 0 };
  const ask = () => {
    asked.times += 1;
    return Promise.resolve(typed);
  };
  return { asked, ask };
}

describe('reset-password', () => {
  test('new password works, the old does not, every session of the user ended', async (t) => {
    const out = captureOutput(t);
    const owner = await addUser('owner');
    const anna = await addUser('anna');
    await addSession(anna);
    await addSession(anna);
    await addSession(owner);
    const { asked, ask } = typing([NEW_PASSWORD, NEW_PASSWORD]);

    assert.equal(await resetPasswordCommand(pool, ' Anna ', ask), 0);
    assert.equal(asked.times, 1);
    const { password_hash } = await userRow(anna);
    assert.equal(await verifyPassword(NEW_PASSWORD, password_hash), 'valid');
    assert.equal(await verifyPassword(OLD_PASSWORD, password_hash), 'wrong');
    assert.equal(await sessionsOf(anna), 0);
    assert.equal(await sessionsOf(owner), 1);
    assert.equal(await verifyPassword(OLD_PASSWORD, (await userRow(owner)).password_hash), 'valid');
    assert.deepEqual(out.stdout, [
      'Новый пароль для anna: не короче 15 символов, дважды.',
      'Пароль anna сменён. Завершено сессий: 2.',
      'info password_reset user_id=2 username=anna by=cli',
    ]);
    assert.deepEqual(out.stderr, []);
  });

  test('a disabled user gets the new password and stays disabled', async (t) => {
    captureOutput(t);
    const bors = await addUser('bors', true);
    await addSession(bors);
    assert.equal(
      await resetPasswordCommand(pool, 'bors', typing([NEW_PASSWORD, NEW_PASSWORD]).ask),
      0,
    );
    const row = await userRow(bors);
    assert.equal(row.is_disabled, true);
    assert.equal(await verifyPassword(NEW_PASSWORD, row.password_hash), 'valid');
    assert.equal(await sessionsOf(bors), 0);
  });

  test('a repeat typed in another Unicode form is the same password', async (t) => {
    captureOutput(t);
    const anna = await addUser('anna');
    const nfc = 'новый пароль: ёлка, йогурт и чай'.normalize('NFC');
    const ask = typing([nfc, nfc.normalize('NFD')]).ask;
    assert.equal(await resetPasswordCommand(pool, 'anna', ask), 0);
    assert.equal(await verifyPassword(nfc, (await userRow(anna)).password_hash), 'valid');
  });

  for (const typed of ['nemo', '-anna', '']) {
    test(`unknown login ${JSON.stringify(typed)}: exit 1, no password asked`, async (t) => {
      const out = captureOutput(t);
      await addUser('anna');
      const { asked, ask } = typing([NEW_PASSWORD, NEW_PASSWORD]);
      assert.equal(await resetPasswordCommand(pool, typed, ask), 1);
      assert.equal(asked.times, 0);
      assert.deepEqual(out.stderr, [`Нет пользователя с логином «${typed}».`]);
      assert.deepEqual(out.stdout, []);
    });
  }

  const refusals: [string, [string, string] | null, number, string][] = [
    ['shorter than 15', ['a'.repeat(14), 'a'.repeat(14)], 1, 'Пароль — от 15 до 256 символов.'],
    ['longer than 256', ['a'.repeat(257), 'a'.repeat(257)], 1, 'Пароль — от 15 до 256 символов.'],
    ['repeat does not match', [NEW_PASSWORD, NEW_PASSWORD + '!'], 1, 'Пароли не совпадают.'],
    ['input ended (Ctrl+C, Ctrl+D)', null, 130, 'Отменено.'],
  ];
  for (const [name, typed, code, message] of refusals) {
    test(`${name}: exit ${code}, nothing changed`, async (t) => {
      const out = captureOutput(t);
      const anna = await addUser('anna');
      await addSession(anna);
      assert.equal(await resetPasswordCommand(pool, 'anna', typing(typed).ask), code);
      assert.deepEqual(out.stderr, [`${message} Пароль не изменён.`]);
      assert.deepEqual(await userRow(anna), { password_hash: OLD_HASH, is_disabled: false });
      assert.equal(await sessionsOf(anna), 1);
    });
  }

  test('no typed password in the output', async (t) => {
    const out = captureOutput(t);
    await addUser('anna');
    for (const typed of [
      ['a'.repeat(14), 'a'.repeat(14)],
      [NEW_PASSWORD, 'a different repeat!!'],
      [NEW_PASSWORD, NEW_PASSWORD],
    ] as [string, string][]) {
      await resetPasswordCommand(pool, 'anna', typing(typed).ask);
    }
    const written = [...out.stdout, ...out.stderr].join('\n');
    for (const secret of ['a'.repeat(14), NEW_PASSWORD, 'a different repeat', '$argon2id']) {
      assert.ok(!written.includes(secret), `output contains ${secret}`);
    }
  });

  // The transaction is the shared one of src/core/reset-password.ts, tested there; here only what
  // the command makes of its failure. main() prints the error and exits with 1.
  test('the database fails during the reset: the error comes out, nothing changed', async (t) => {
    const out = captureOutput(t);
    const anna = await addUser('anna');
    await addSession(anna);
    // UPDATE users goes through, DELETE FROM sessions finds no table and fails before COMMIT.
    await pool.query('ALTER TABLE sessions RENAME TO sessions_away');
    try {
      await assert.rejects(
        resetPasswordCommand(pool, 'anna', typing([NEW_PASSWORD, NEW_PASSWORD]).ask),
        /relation "sessions" does not exist/,
      );
    } finally {
      await pool.query('ALTER TABLE IF EXISTS sessions_away RENAME TO sessions');
    }
    assert.deepEqual(await userRow(anna), { password_hash: OLD_HASH, is_disabled: false });
    assert.equal(await sessionsOf(anna), 1);
    // Neither «сменён» nor the log line: only the prompt was written.
    assert.deepEqual(out.stdout, ['Новый пароль для anna: не короче 15 символов, дважды.']);
  });
});
