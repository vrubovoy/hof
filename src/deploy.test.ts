// The update command (docs/OPERATIONS.md, section «Обновление»): what can be checked without
// Docker. hof-deploy-ssh runs in a Linux container where /usr/bin/sudo is a stub that prints its
// arguments. The update itself, with real Docker Compose and PostgreSQL, is checked on the stand of
// CI (src/deploy-stand.test.ts).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const DEPLOY = join(ROOT, 'deploy', 'hof-deploy.sh');
const SSH = join(ROOT, 'deploy', 'hof-deploy-ssh.sh');
const HEX = 'a'.repeat(64);

// Requests a caller might send; none of them is a valid one.
const WRONG = [
  '',
  'deploy',
  'deploy ',
  `deploy sha256:${HEX.toUpperCase()}`,
  `deploy sha256:${HEX.slice(1)}`,
  `deploy sha256:${HEX}0`,
  `deploy sha256:${HEX};id`,
  'deploy sha256:$(id)',
  `deploy sha256:${HEX}\n`,
  `deploy sha256:${HEX}\nid`,
  `deploy ${HEX}`,
  `deploy  sha256:${HEX}`,
  `deploy sha256:${HEX} extra`,
  'deploy ../../etc/passwd',
  'deploy latest',
  `DEPLOY sha256:${HEX}`,
  'status extra',
  'status\n',
  'STATUS',
  '--help',
  'id',
  'scp -t /tmp',
];

describe('hof-deploy: arguments', () => {
  for (const request of WRONG) {
    test(`refused before anything: ${JSON.stringify(request)}`, () => {
      const args = request === '' ? [] : request.split(' ');
      const result = spawnSync('/bin/bash', [DEPLOY, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Использование: hof-deploy status \| hof-deploy deploy sha256:/);
    });
  }
});

describe('hof-deploy: the state of the migrations after a failed start', () => {
  // The function of the script, on its own.
  const source = readFileSync(DEPLOY, 'utf8');
  const classify = source.slice(
    source.indexOf('classify() {'),
    source.indexOf('\n}\n', source.indexOf('classify() {')) + 3,
  );

  function state(before: string[], after: string[], image: string[]) {
    const list = (names: string[]) => `$'${names.join('\\n')}'`;
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        `export LC_ALL=C\n${classify}\nclassify ${list(before)} ${list(after)} ${list(image)}`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  const old = ['core/001_users.sql', 'saeckel/001_pouches.sql'];
  const image = [...old, 'saeckel/002_operations.sql', 'saeckel/003_more.sql'];

  for (const [title, after, expected] of [
    ['nothing applied', old, 'none'],
    ['one of two applied', [...old, 'saeckel/002_operations.sql'], 'partial'],
    ['everything applied', image, 'all'],
    ['a name the image does not know', [...old, 'saeckel/009_other.sql'], 'unknown'],
    ['an applied name gone', ['core/001_users.sql'], 'unknown'],
  ] as const) {
    test(`${title}: ${expected}`, () => {
      assert.equal(state(old, [...after], image), expected);
    });
  }

  test('an image without new migrations: nothing applied', () => {
    assert.equal(state(old, old, old), 'none');
  });
});

describe('hof-deploy: only allowed operations', () => {
  // The code without comments, with lines joined where they continue.
  const code = readFileSync(DEPLOY, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\s*\\\n\s*/g, ' ')
    // Messages are not commands: quoted text with Russian in it goes.
    .replace(/'[^'\n]*[а-яё][^'\n]*'|"[^"\n]*[а-яё][^"\n]*"/gi, "''");

  function all(pattern: RegExp): string[] {
    return [...code.matchAll(pattern)].map((match) => (match[1] ?? match[0]).trim());
  }

  test('no down, prune, volume, git, build, restore of the database', () => {
    for (const word of [
      /\bdown\b/,
      /\bprune\b/,
      /\bvolume (rm|create|prune)\b/,
      /\bnetwork rm\b/,
      /(^|[;&|(]|\$\(|\bthen|\bdo|\belse)\s*git\b/m,
      /\bpg_restore\b/,
      /\bdropdb\b/,
      /\bcreatedb\b/,
      /DROP DATABASE/i,
      /\bRENAME\b/i,
      /\brestart\b/,
      /--force-recreate/,
      /\brm (-f|--force) /,
      /docker (system|volume|network|kill|run|exec -i|build)\b/,
    ]) {
      assert.ok(!word.test(code), String(word));
    }
    assert.deepEqual(all(/[^\s'"]*\bbuild\b[^\s'"]*(?: !reset null)?/g), [
      'build: !reset null',
      '--no-build',
    ]);
  });

  test('Docker: hof and nginx are recreated with --no-deps, the copy comes before the stop', () => {
    assert.deepEqual(all(/docker compose ([\w-]+)/g), ['--project-directory', 'up']);
    assert.deepEqual(all(/staged (\w+)/g), ['config', 'config', 'pull']);
    assert.deepEqual(all(/docker compose up ([^;\n]*)/g), [
      '-d --no-build --no-deps --pull never --wait --wait-timeout 120 hof nginx',
    ]);
    assert.deepEqual(all(/docker stop ([^ >]*)/g), ['"$hof"', '"$hof_now"']);
    assert.deepEqual(all(/docker rm ([^ >]*)/g), ['"$extract"', '"$extract"']);
    assert.deepEqual(all(/docker image rm ([^ >]*)/g), ['"$image@$old_digest"']);
    assert.deepEqual(all(/rm -rf -- ([^\s;]*)/g), ['"$stage"', 'releases/.stage.*', '"$dir"']);
    assert.deepEqual(all(/docker exec (\S+)/g), ['"$1"']);
    assert.ok(
      code.includes(
        '--username=postgres --dbname=hof --no-psqlrc -At --set ON_ERROR_STOP=1 -c "SELECT ',
      ),
    );

    const order = [
      'hof-backup --pre-deploy --lock-held',
      'docker stop "$hof"',
      'mv -T .release.new release',
      'docker compose up',
    ].map((text) => code.indexOf(text));
    assert.ok(
      order.every((index) => index > 0),
      String(order),
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
  });

  test('a clean environment and the image from the file of root', () => {
    assert.match(
      code,
      /^if \[ "\$\{HOF_DEPLOY_CLEAN:-\}" != 1 \]; then\n {2}exec \/usr\/bin\/env -i /m,
    );
    assert.ok(code.indexOf('exec /usr/bin/env -i') < code.indexOf('if [ "$#" -eq 1 ]'));
    assert.match(code, /^IMAGE_FILE=\/etc\/hof-deploy\/image$/m);
    assert.match(code, /flock --wait 60 9/);
  });
});

describe('hof-deploy-ssh', () => {
  const NAME = `hof-deploy-ssh-test-${process.pid}`;

  function run(script: string, env: string[] = []) {
    return spawnSync(
      'docker',
      ['exec', ...env.flatMap((pair) => ['-e', pair]), NAME, 'bash', '-c', script],
      { encoding: 'utf8' },
    );
  }

  function ssh(request: string) {
    return run('/usr/local/sbin/hof-deploy-ssh', [`SSH_ORIGINAL_COMMAND=${request}`]);
  }

  before(() => {
    const started = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        NAME,
        '--entrypoint',
        'sleep',
        'postgres:18.6-trixie',
        'infinity',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(started.status, 0, started.stderr);
    assert.equal(
      spawnSync('docker', ['cp', SSH, `${NAME}:/usr/local/sbin/hof-deploy-ssh`]).status,
      0,
    );
    const stub = run(`printf '#!/bin/bash\\necho "sudo $*"\\n' > /usr/bin/sudo
                      chmod 755 /usr/bin/sudo /usr/local/sbin/hof-deploy-ssh`);
    assert.equal(stub.status, 0, stub.stderr);
  });

  after(() => {
    spawnSync('docker', ['rm', '-f', NAME]);
  });

  test('status and deploy go to sudo, with nothing else', () => {
    assert.equal(ssh('status').stdout, 'sudo -n /usr/local/sbin/hof-deploy status\n');
    assert.equal(
      ssh(`deploy sha256:${HEX}`).stdout,
      `sudo -n /usr/local/sbin/hof-deploy deploy sha256:${HEX}\n`,
    );
  });

  test('anything else is refused, and the request is not printed back', () => {
    for (const request of [...WRONG, 'status; id', 'bash -i', `deploy sha256:${HEX} && id`]) {
      const result = ssh(request);
      assert.equal(result.status, 2, JSON.stringify(request));
      assert.equal(result.stdout, '', JSON.stringify(request));
      assert.match(result.stderr, /^hof-deploy-ssh: команда не разрешена/);
      if (request.length > 8) assert.ok(!result.stderr.includes(request), JSON.stringify(request));
    }
    assert.equal(run('/usr/local/sbin/hof-deploy-ssh').status, 2);
  });
});
