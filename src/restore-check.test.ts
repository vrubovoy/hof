// deploy/hof-restore-check.sh (docs/OPERATIONS.md, section «Проверить копию»), with a real Docker
// and made-up data only. A Compose project of the same compose.yaml holds the seeded databases the
// test copies come from, and stays running beside the check as the other Hof it must not touch.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'deploy', 'hof-restore-check.sh');
const SOURCE = `hof-restore-src-${process.pid}`;
// Only what Docker needs: no real setting of the shell reaches the script.
const ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

const SEED = `
  INSERT INTO core.users (username, password_hash, is_admin)
    VALUES ('owner', 'fake-hash', true), ('anna', 'fake-hash', false);
  INSERT INTO core.sessions (token_hash, user_id, expires_at)
    VALUES (sha256('token'::bytea), 2, '2030-01-01 00:00:00+00');
  INSERT INTO saeckel.pouches (id, user_id, name) OVERRIDING SYSTEM VALUE
    VALUES (1, 2, 'Еда и «ёж»'), (2, 2, 'Жильё');
  INSERT INTO saeckel.operations
    (user_id, kind, amount, currency, from_pouch_id, to_pouch_id, date, note) VALUES
    (2, 'income', 100000000000, 'RUB', NULL, NULL, '2026-01-15', 'самая большая сумма'),
    (2, 'assign', 12345, 'RUB', NULL, 1, '2026-02-01', ''),
    (2, 'expense', 1, 'RUB', 1, NULL, '2026-03-02', E'Кириллица «ёж»\nвторая строка\tи табуляция'),
    (2, 'transfer', 99999, 'RUB', 1, 2, '2026-03-04', 'it''s a quote');
`;

// The same digest as in the script, on the seeded database.
const FINGERPRINT = `SELECT md5(string_agg(digest, '' ORDER BY n)) FROM (
    SELECT 1 AS n, md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), '')) AS digest FROM core.users t
    UNION ALL SELECT 2, md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), '')) FROM core.sessions t
    UNION ALL SELECT 3, md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), '')) FROM saeckel.pouches t
    UNION ALL SELECT 4, md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), '')) FROM saeckel.operations t) d`;

let dir: string;
let envFile: string;

function source(...args: string[]) {
  return [
    'compose',
    '--project-name',
    SOURCE,
    '--project-directory',
    ROOT,
    '--env-file',
    envFile,
    '--file',
    join(ROOT, 'compose.yaml'),
    ...args,
  ];
}

function docker(args: string[], input?: string) {
  const result = spawnSync('docker', args, { env: ENV, encoding: 'utf8', input });
  assert.equal(result.status, 0, `docker ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

function psql(database: string, sql: string, user = 'postgres') {
  return docker(
    source(
      'exec',
      '-T',
      'postgres',
      'psql',
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-At',
      `--username=${user}`,
      `--dbname=${database}`,
    ),
    sql,
  );
}

// A copy of a database with its .meta, as hof-backup leaves them.
function writeCopy(name: string, database: string) {
  const file = join(dir, `${name}.dump`);
  const fd = openSync(file, 'w');
  const dump = spawnSync(
    'docker',
    source(
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '--username=postgres',
      `--dbname=${database}`,
      '--format=custom',
    ),
    { env: ENV, stdio: ['ignore', fd, 'pipe'] },
  );
  closeSync(fd);
  assert.equal(dump.status, 0, String(dump.stderr));
  writeMeta(file);
  return file;
}

function writeMeta(file: string) {
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(`${file}.meta`, `created=x\nsize=1\nsha256=${sha}\nimage=-\n`);
}

// A copy of the seeded database changed by `sql`, which runs as the superuser.
function writeVariant(name: string, sql: string) {
  psql('postgres', `CREATE DATABASE ${name} TEMPLATE hof`);
  psql(name, sql);
  const file = writeCopy(name, name);
  psql('postgres', `DROP DATABASE ${name}`);
  return file;
}

function check(file: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, file], { env: { ...ENV, ...env }, encoding: 'utf8' });
}

// Everything named after a run of the check: the name is the only thing they have in common.
function drillResources() {
  const lists = [
    ['ps', '--all', '--format', '{{.Names}}'],
    ['volume', 'ls', '--format', '{{.Name}}'],
    ['network', 'ls', '--format', '{{.Name}}'],
    ['image', 'ls', '--format', '{{.Repository}}'],
  ];
  return lists.flatMap((args) =>
    docker(args)
      .split('\n')
      .filter((name) => name.includes('hof-drill-')),
  );
}

function neighbour() {
  const id = docker(source('ps', '--quiet', 'postgres')).trim();
  return {
    container: docker(['inspect', '--format', '{{.Id}} {{.State.StartedAt}}', id]),
    volume: docker(['volume', 'inspect', '--format', '{{.CreatedAt}}', `${SOURCE}_pgdata`]),
  };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'hof-restore-check-'));
  envFile = join(dir, 'fake.env');
  writeFileSync(
    envFile,
    [
      'POSTGRES_PASSWORD=fake-superuser',
      'HOF_CORE_DB_PASSWORD=fake-core',
      'HOF_SAECKEL_DB_PASSWORD=fake-saeckel',
      'CURRENCY=RUB',
      'TZ=UTC',
      '',
    ].join('\n'),
  );
  docker(source('up', '--detach', '--wait', '--wait-timeout', '120', 'postgres'));
  for (const [user, module, migrations] of [
    ['hof_core', 'core', ['001_users', '002_sessions']],
    ['hof_saeckel', 'saeckel', ['001_pouches', '002_operations']],
  ] as const) {
    for (const name of migrations) {
      const sql = readFileSync(join(ROOT, 'src', module, 'migrations', `${name}.sql`), 'utf8');
      psql(
        'hof',
        `${sql}; CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY);
        INSERT INTO schema_migrations (name) VALUES ('${name}.sql');`,
        user,
      );
    }
  }
  psql('hof', SEED);
});

after(() => {
  spawnSync('docker', source('down', '--timeout', '5'), { env: ENV });
  spawnSync('docker', ['volume', 'rm', `${SOURCE}_pgdata`], { env: ENV });
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  assert.deepEqual(drillResources(), []);
});

test('a seeded copy restores whole and Hof starts on it, beside another Hof', () => {
  const file = writeCopy('good', 'hof');
  const expected = psql('hof', FINGERPRINT).trim();
  const before = neighbour();

  // Settings of the shell must not win over the temporary .env: this currency would stop Hof.
  const result = check(file, { CURRENCY: 'EUR', TZ: 'Not/AZone' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = result.stdout;
  assert.ok(report.includes('Копия прошла проверку.'), report);
  assert.ok(report.includes('записи: пользователи 2, сессии 1, мешки 2, операции 4'), report);
  assert.ok(report.includes('новейшая операция: 2026-03-04'), report);
  // The digest covers every value of the seed: amounts, Cyrillic, line breaks, tabs, quotes.
  assert.ok(report.includes(`отпечаток записей: ${expected}`), report);
  assert.ok(
    report.includes(
      'миграции в копии: core/001_users.sql, core/002_sessions.sql, saeckel/001_pouches.sql, saeckel/002_operations.sql',
    ),
    report,
  );
  assert.ok(report.includes('новые миграции этого кода: none'), report);

  for (const secret of ['Кириллица', 'Еда', 'anna', 'fake-hash', '12345', '100000000000']) {
    assert.ok(!(report + result.stderr).includes(secret), secret);
  }
  assert.deepEqual(neighbour(), before);
});

test('the digest changes when a single value changes', () => {
  const original = psql('hof', FINGERPRINT);
  psql('postgres', 'CREATE DATABASE changed TEMPLATE hof');
  psql('changed', "UPDATE saeckel.operations SET amount = amount + 1 WHERE kind = 'expense'");
  const changed = psql('changed', FINGERPRINT);
  psql('postgres', 'DROP DATABASE changed');
  assert.notEqual(changed, original);
});

test('a wrong SHA-256 or no .meta: refused before Docker starts anything', () => {
  const file = writeCopy('checksum', 'hof');
  writeFileSync(`${file}.meta`, `sha256=${'0'.repeat(64)}\n`);
  const wrong = check(file);
  assert.equal(wrong.status, 1);
  assert.ok(wrong.stderr.includes('SHA-256 архива не совпала'), wrong.stderr);

  rmSync(`${file}.meta`);
  const missing = check(file);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes('контрольную сумму не с чем сверить'), missing.stderr);
});

test('a cut archive with a matching SHA-256: it does not read in full', () => {
  const file = writeCopy('cut', 'hof');
  truncateSync(file, readFileSync(file).length - 200);
  writeMeta(file);
  const result = check(file);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('архив не читается целиком'), result.stderr);
  assert.ok(!result.stdout.includes('восстановлен'), result.stdout);
});

test('a restore that fails: no partial data, no record in the output', () => {
  // The archive reads, but the role of this table does not exist in a new cluster.
  const file = writeVariant(
    'foreign_owner',
    `DO $$ BEGIN CREATE ROLE stranger; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
     CREATE TABLE saeckel.extra (id integer); ALTER TABLE saeckel.extra OWNER TO stranger;`,
  );
  const result = check(file);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('восстановление завершилось ошибкой'), result.stderr);
  assert.ok(result.stderr.includes('stranger'), result.stderr);
  assert.ok(!(result.stdout + result.stderr).includes('Кириллица'));
});

test('a copy without the administrator fails', () => {
  const file = writeVariant(
    'no_admin',
    `DELETE FROM core.sessions; UPDATE core.users SET is_admin = false;`,
  );
  const result = check(file);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('Хозяев в копии: 0'), result.stderr);
});

test('a broken structure fails and names what is missing', () => {
  const file = writeVariant(
    'broken',
    `ALTER TABLE core.sessions OWNER TO postgres;
     DROP INDEX core.users_one_admin;
     ALTER TABLE saeckel.operations DROP CONSTRAINT operations_from_pouch_id_user_id_fkey;`,
  );
  const result = check(file);
  assert.equal(result.status, 1);
  for (const missing of [
    'core.sessions:hof_core',
    'index users_one_admin true',
    'operations foreign keys 2',
  ]) {
    assert.ok(result.stderr.includes(missing), result.stderr);
  }
});

test('a copy Hof cannot start on fails with the reason from its log', () => {
  // Hof takes the first migration for a new one, and its table already exists.
  const file = writeVariant(
    'no_start',
    `DELETE FROM saeckel.schema_migrations WHERE name = '001_pouches.sql';`,
  );
  const result = check(file);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('Hof не запустился'), result.stderr);
  assert.ok(result.stderr.includes('startup_failed'), result.stderr);
  assert.ok(result.stderr.includes('001_pouches.sql'), result.stderr);
});

test('an interrupted run removes what it made', async () => {
  const file = writeCopy('interrupted', 'hof');
  const child = spawn('bash', [SCRIPT, file], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const code = new Promise((resolve) => child.on('close', resolve));
  for (let i = 0; i < 300 && drillResources().length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.notDeepEqual(drillResources(), []);

  child.kill('SIGINT');
  assert.equal(await code, 130);
  assert.ok(stderr.includes('прервано'), stderr);
});

test('a Docker that is not local: refused, nothing starts', () => {
  const file = join(dir, 'unused.dump');
  writeFileSync(file, 'x');
  for (const host of ['ssh://root@example.invalid', 'tcp://127.0.0.1:1']) {
    const result = check(file, { DOCKER_HOST: host });
    assert.equal(result.status, 2, host);
    assert.ok(result.stderr.includes('не на локальный Docker'), result.stderr);
  }
});

test('wrong arguments: refused', () => {
  const none = spawnSync('bash', [SCRIPT], { env: ENV, encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.equal(check(join(dir, 'no-such-file.dump')).status, 2);
});
