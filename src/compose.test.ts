// compose.yaml (ARCHITECTURE.md §9) and deploy/compose.limits.yaml: what each container gets and
// publishes, how it restarts, stops and logs, and that the limits for a small server change
// nothing but memory. `docker compose config` resolves the files the way `docker compose up`
// would, without the Docker daemon. It reads a file of fake values instead of .env, and its
// process gets only PATH and HOME, so no real setting reaches the test or its output.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

// Every variable compose.yaml needs, with values no installation has.
const FAKE_ENV: Record<string, string> = {
  POSTGRES_PASSWORD: 'fake-superuser-password',
  HOF_CORE_DB_PASSWORD: 'fake-core-password',
  HOF_SAECKEL_DB_PASSWORD: 'fake-saeckel-password',
  CURRENCY: 'RUB',
  TZ: 'Europe/Moscow',
};

// The part of the resolved configuration the tests look at.
interface Service {
  environment?: Record<string, string>;
  ports?: unknown[];
  restart?: string;
  init?: boolean;
  logging?: unknown;
  mem_limit?: string;
  memswap_limit?: string;
  volumes?: { type: string; source: string; target: string }[];
}

interface ComposeConfig {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
}

// The configuration of the given compose files, as `docker compose up` would see it.
function composeConfig(...files: string[]): ComposeConfig {
  const dir = mkdtempSync(join(tmpdir(), 'hof-compose-test-'));
  try {
    const envFile = join(dir, 'fake.env');
    const lines = Object.entries(FAKE_ENV).map(([name, value]) => `${name}=${value}\n`);
    writeFileSync(envFile, lines.join(''));
    const fileArgs = files.flatMap((file) => ['--file', join(ROOT, file)]);
    const args = ['compose', '--project-directory', ROOT, '--env-file', envFile, ...fileArgs];
    const result = spawnSync('docker', [...args, 'config', '--format', 'json'], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return JSON.parse(result.stdout) as ComposeConfig;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function service(config: ComposeConfig, name: string): Service {
  const found = config.services[name];
  assert.ok(found, `no service ${name}`);
  return found;
}

const STANDARD = composeConfig('compose.yaml');
const LIMITED = composeConfig('compose.yaml', 'deploy/compose.limits.yaml');

test('the values come from the fake env file, not from .env', () => {
  for (const [name, { environment = {} }] of Object.entries(STANDARD.services)) {
    for (const [variable, value] of Object.entries(environment)) {
      if (!(variable in FAKE_ENV)) continue;
      // assert.ok, not assert.equal: a real value must not get into the failure message.
      assert.ok(value === FAKE_ENV[variable], `${name}: ${variable} is not the fake value`);
    }
  }
});

test('postgres and hof, neither of them publishes a port', () => {
  assert.deepEqual(Object.keys(STANDARD.services).sort(), ['hof', 'postgres']);
  for (const name of ['hof', 'postgres']) {
    assert.equal(service(STANDARD, name).ports, undefined, `${name} publishes a port`);
  }
});

test('hof gets the passwords of the two module roles and the settings, nothing else', () => {
  const variables = Object.keys(service(STANDARD, 'hof').environment ?? {}).sort();
  assert.deepEqual(variables, [
    'CURRENCY',
    'HOF_CORE_DB_PASSWORD',
    'HOF_SAECKEL_DB_PASSWORD',
    'PGHOST',
    'TZ',
  ]);
  for (const [name, { environment = {} }] of Object.entries(STANDARD.services)) {
    if (name === 'postgres') continue;
    assert.ok(!('POSTGRES_PASSWORD' in environment), `${name} gets the superuser password`);
  }
});

test('every service comes back by itself and keeps three log files of 10 MB at most', () => {
  for (const [name, { restart, logging }] of Object.entries(STANDARD.services)) {
    assert.equal(restart, 'unless-stopped', name);
    assert.deepEqual(
      logging,
      { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      name,
    );
  }
});

test('hof runs under the init of Docker, which passes SIGTERM on to Node', () => {
  assert.equal(service(STANDARD, 'hof').init, true);
});

test('the data live in the named volume hof_pgdata', () => {
  assert.deepEqual(STANDARD.volumes, { pgdata: { name: 'hof_pgdata' } });
  const mounts = service(STANDARD, 'postgres').volumes ?? [];
  assert.ok(
    mounts.some(
      (m) => m.type === 'volume' && m.source === 'pgdata' && m.target === '/var/lib/postgresql',
    ),
    'postgres does not keep its data in pgdata',
  );
});

test('a standard installation has no memory limits', () => {
  for (const [name, s] of Object.entries(STANDARD.services)) {
    assert.equal(s.mem_limit, undefined, name);
    assert.equal(s.memswap_limit, undefined, name);
  }
});

test('compose.limits.yaml: every service gets a limit and no swap, nothing else changes', () => {
  for (const name of Object.keys(STANDARD.services)) {
    const { mem_limit, memswap_limit } = service(LIMITED, name);
    assert.ok(Number(mem_limit) > 0, `${name}: no mem_limit`);
    // Equal to mem_limit, swap adds nothing to it; without it Docker gives as much swap again.
    assert.equal(memswap_limit, mem_limit, `${name}: memswap_limit is not mem_limit`);
  }
  const withoutLimits = structuredClone(LIMITED);
  for (const s of Object.values(withoutLimits.services)) {
    delete s.mem_limit;
    delete s.memswap_limit;
  }
  assert.deepEqual(withoutLimits, STANDARD);
});
