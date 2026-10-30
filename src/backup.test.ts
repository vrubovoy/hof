// Backups (docs/OPERATIONS.md, section «Автоматические копии»).
//
// hof-backup and hof-backup-send are written for Linux (flock, GNU coreutils), so they run in a
// container with a real PostgreSQL, pg_dump and pg_restore. /usr/bin/docker there is a stub: it
// runs `docker exec` right in that container and breaks pg_dump on a file in /tmp.
// hof-backup-pull is written for the Mac and runs on this machine with stubs of ssh and of the
// commands of macOS.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const DIR = '/var/backups/hof';
const LOCK = '/run/lock/hof-ops.lock';

describe('server: hof-backup and hof-backup-send', () => {
  const NAME = `hof-backup-test-${process.pid}`;

  const DOCKER_STUB = `#!/bin/bash
echo "$*" >> /tmp/docker-calls
case $1 in
ps)
  case $* in
  *service=postgres*) echo postgres-id ;;
  *service=hof*) echo ghcr.io/vrubovoy/hof@sha256:test ;;
  esac
  ;;
exec)
  shift
  [ "$1" = -i ] && shift
  shift
  if [ "$1" = pg_dump ] && [ -f /tmp/fail-dump ]; then echo 'сбой' >&2; exit 1; fi
  if [ "$1" = pg_dump ] && [ -f /tmp/cut-dump ]; then "$@" | head -c 3000; exit 0; fi
  exec "$@"
  ;;
esac
`;

  function docker(...args: string[]) {
    return spawnSync('docker', args, { encoding: 'utf8' });
  }

  // A command in the container; extraArgs go to `docker exec`, an environment variable for one.
  function run(script: string, extraArgs: string[] = []) {
    return docker('exec', ...extraArgs, NAME, 'bash', '-c', script);
  }

  function ok(script: string): string {
    const result = run(script);
    assert.equal(result.status, 0, `${script}\n${result.stderr}`);
    return result.stdout;
  }

  // The folder of copies: visible files only, in the order of their names.
  function copies(): string[] {
    return ok(`ls -1 ${DIR}`).split('\n').filter(Boolean);
  }

  // The name of the one new copy.
  function onlyDump(): string {
    const dumps = copies().filter((name) => name.endsWith('.dump'));
    assert.equal(dumps.length, 1);
    return dumps[0]!;
  }

  function status(): string {
    return ok(`cat ${DIR}/backup-status.txt`);
  }

  // Ready copies for the retention tests: day n of January as the time in the name.
  function seed(kind: string, days: number[]) {
    for (const day of days) {
      const file = `${DIR}/hof-${kind}-202601${String(day).padStart(2, '0')}T000000Z.dump`;
      ok(`touch -d 2026-01-01 ${file} ${file}.meta`);
    }
  }

  function send(request: string) {
    return run('hof-backup-send', ['-e', `SSH_ORIGINAL_COMMAND=${request}`]);
  }

  before(async () => {
    const started = docker(
      'run',
      '-d',
      '--rm',
      '--name',
      NAME,
      '-e',
      'POSTGRES_DB=hof',
      '-e',
      'POSTGRES_PASSWORD=fake',
      'postgres:18.6-trixie',
    );
    assert.equal(started.status, 0, started.stderr);
    for (let i = 0; i < 60; i++) {
      if (run('pg_isready --host=127.0.0.1 --username=postgres --dbname=hof').status === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const [from, to] of [
      ['hof-backup.sh', 'hof-backup'],
      ['hof-backup-send.sh', 'hof-backup-send'],
    ] as const) {
      assert.equal(
        docker('cp', join(ROOT, 'deploy', from), `${NAME}:/usr/local/sbin/${to}`).status,
        0,
      );
    }
    const stub = spawnSync('docker', ['exec', '-i', NAME, 'tee', '/usr/bin/docker'], {
      input: DOCKER_STUB,
      encoding: 'utf8',
    });
    assert.equal(stub.status, 0, stub.stderr);
    ok(`chmod 755 /usr/bin/docker /usr/local/sbin/hof-backup /usr/local/sbin/hof-backup-send
        mkdir -p ${DIR} /var/lib/hof-backup/state /run/lock /tmp/stub
        groupadd --system hof-backup
        chgrp hof-backup ${DIR}
        chmod 2750 ${DIR}
        psql --username=postgres --dbname=hof -q -c "
          CREATE TABLE operations (id serial PRIMARY KEY, note text);
          INSERT INTO operations (note) SELECT repeat('запись ', 5) FROM generate_series(1, 20000)"`);
  });

  after(() => {
    docker('rm', '-f', NAME);
  });

  beforeEach(() => {
    ok(`rm -rf ${DIR}/* ${DIR}/.[!.]* /tmp/fail-dump /tmp/cut-dump /tmp/docker-calls /tmp/stub/*
        rm -f ${LOCK} /var/lib/hof-backup/state/last-pull`);
  });

  test('a ready copy: the archive reads, .meta matches, mode 640, status OK', () => {
    assert.match(ok('hof-backup'), /копия готова: hof-nightly-\d{8}T\d{6}Z\.dump/);
    const name = onlyDump();
    const meta = `${name}.meta`;
    assert.deepEqual(copies(), ['backup-status.txt', name, meta]);
    assert.match(status(), new RegExp(`^OK \\S+ ${name}\\n$`));

    const fields = ok(`cat ${DIR}/${meta}`);
    assert.match(fields, /^created=\S+\nsize=\d+\nsha256=[0-9a-f]{64}\nimage=\S+\n$/);
    assert.match(fields, /image=ghcr\.io\/vrubovoy\/hof@sha256:test/);
    const sha = ok(`sha256sum ${DIR}/${name}`).split(' ')[0];
    assert.ok(sha && fields.includes(`sha256=${sha}`));
    assert.equal(
      ok(`stat -c '%a %G' ${DIR}/${name} ${DIR}/${meta} ${DIR}/backup-status.txt`),
      '640 hof-backup\n640 hof-backup\n640 hof-backup\n',
    );

    // A second database of the same server: a whole restore, not only reading the contents.
    ok(`createdb --username=postgres check_restore
        pg_restore --username=postgres --dbname=check_restore --single-transaction ${DIR}/${name}`);
    const rows = ok(
      'psql --username=postgres --dbname=check_restore -At -c "SELECT count(*) FROM operations"',
    );
    ok('dropdb --username=postgres check_restore');
    assert.ok(Number(rows) >= 20000);
  });

  test('a copy made during writes is created and reads in full', () => {
    const copy = run(`
      (for i in $(seq 1 200); do
         psql --username=postgres --dbname=hof -q -c "INSERT INTO operations (note) VALUES ('новая')"
       done) &
      writer=$!
      hof-backup
      code=$?
      wait $writer
      exit $code`);
    assert.equal(copy.status, 0, copy.stderr);
    ok(`pg_restore --file=/dev/null ${DIR}/${onlyDump()}`);
  });

  for (const [title, flag, reason] of [
    ['pg_dump fails', '/tmp/fail-dump', 'pg_dump завершился с ошибкой'],
    ['the archive is cut', '/tmp/cut-dump', 'архив не читается целиком'],
  ] as const) {
    test(`${title}: no working name, no cleanup, status FAIL`, () => {
      const days = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      seed('nightly', days);
      const earlier = copies();
      ok(`touch ${flag}`);
      const result = run('hof-backup');
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(reason), result.stderr);
      assert.deepEqual(copies(), [...earlier, 'backup-status.txt'].sort());
      assert.match(status(), new RegExp(`^FAIL \\S+ nightly: ${reason}\\n$`));
      assert.equal(ok(`ls -A ${DIR} | grep -c '\\.part\\.' || true`), '0\n');
    });
  }

  test('not enough space: an error, status FAIL, earlier copies in place, no pg_dump', () => {
    seed('nightly', [1, 2, 3]);
    const earlier = copies();
    ok(`printf '#!/bin/bash\\necho Avail\\necho 1024\\n' > /tmp/stub/df; chmod 755 /tmp/stub/df`);
    const result = run('PATH=/tmp/stub:$PATH hof-backup');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('мало места'), result.stderr);
    assert.deepEqual(copies(), [...earlier, 'backup-status.txt'].sort());
    assert.match(status(), /^FAIL \S+ nightly: мало места: свободно 1024 КБ/);
    assert.ok(!ok('cat /tmp/docker-calls').includes('pg_dump'));
  });

  test('the reserve depends on the size of the last copy', () => {
    // A copy of 1 GiB with 3 GiB free: 1.5 + 2 GiB are needed, so it refuses.
    ok(`truncate -s 1G ${DIR}/hof-nightly-20260101T000000Z.dump
        printf '#!/bin/bash\\necho Avail\\necho ${3 * 1024 * 1024}\\n' > /tmp/stub/df
        chmod 755 /tmp/stub/df`);
    assert.equal(run('PATH=/tmp/stub:$PATH hof-backup').status, 1);
    assert.ok(copies().includes('hof-nightly-20260101T000000Z.dump'));
  });

  test('cleanup: only after a new copy, only of its kind, other files stay', () => {
    seed('nightly', [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    seed('predeploy', [1, 2, 3, 4, 5]);
    ok(`touch ${DIR}/hof-nightly-старая.dump ${DIR}/manual.dump`);

    ok('hof-backup');
    let names = copies();
    const nightly = names.filter((n) => /^hof-nightly-\d.*\.dump$/.test(n));
    assert.equal(nightly.length, 7);
    assert.ok(!nightly.includes('hof-nightly-20260103T000000Z.dump'));
    assert.ok(nightly.includes('hof-nightly-20260104T000000Z.dump'));
    assert.ok(!names.includes('hof-nightly-20260103T000000Z.dump.meta'));
    assert.equal(names.filter((n) => /^hof-predeploy-.*\.dump$/.test(n)).length, 5);
    assert.ok(names.includes('hof-nightly-старая.dump'));
    assert.ok(names.includes('manual.dump'));

    ok('hof-backup --pre-deploy');
    names = copies();
    assert.equal(names.filter((n) => /^hof-predeploy-.*\.dump$/.test(n)).length, 3);
    assert.equal(names.filter((n) => /^hof-nightly-\d.*\.dump$/.test(n)).length, 7);
  });

  test('a failed publication: files of the attempt go, same-named files and earlier copies stay', () => {
    seed('nightly', [1]);
    const name = 'hof-nightly-20260301T000000Z.dump';
    ok(`cat > /tmp/stub/date <<'E'
#!/bin/bash
if [ "$*" = '-u +%Y%m%dT%H%M%SZ' ]; then echo 20260301T000000Z; else exec /usr/bin/date "$@"; fi
E
        chmod 755 /tmp/stub/date
        echo 'прежний архив' > ${DIR}/${name}`);

    // The name of the archive is taken: the .meta came first and must go, the archive stays.
    const second = run('PATH=/tmp/stub:$PATH hof-backup');
    assert.equal(second.status, 1);
    assert.ok(second.stderr.includes(`не удалось опубликовать ${name}`), second.stderr);
    assert.equal(ok(`cat ${DIR}/${name}`), 'прежний архив\n');
    assert.equal(run(`test -e ${DIR}/${name}.meta`).status, 1);
    assert.match(status(), /^FAIL /);
    assert.equal(ok(`ls -A ${DIR} | grep -c '\\.part\\.' || true`), '0\n');

    // The name of the .meta is taken: that file is neither replaced nor deleted.
    ok(`rm ${DIR}/${name}; echo 'прежние сведения' > ${DIR}/${name}.meta`);
    assert.equal(run('PATH=/tmp/stub:$PATH hof-backup').status, 1);
    assert.equal(ok(`cat ${DIR}/${name}.meta`), 'прежние сведения\n');
    assert.equal(run(`test -e ${DIR}/${name}`).status, 1);

    assert.ok(copies().includes('hof-nightly-20260101T000000Z.dump'));
    assert.ok(copies().includes('hof-nightly-20260101T000000Z.dump.meta'));
  });

  test('the lock is taken: a bounded wait, the message names the holder, no file changes', () => {
    seed('nightly', [1]);
    const earlier = copies();
    ok(`printf '#!/bin/bash\\necho "$*" >> /tmp/flock-calls\\nexit 1\\n' > /tmp/stub/flock
        chmod 755 /tmp/stub/flock
        rm -f /tmp/flock-calls
        echo 'hof-deploy, pid 42' > ${LOCK}`);

    const manual = run('PATH=/tmp/stub:$PATH hof-backup');
    assert.equal(manual.status, 3);
    assert.ok(manual.stderr.includes('hof-deploy, pid 42'), manual.stderr);
    const timer = run('PATH=/tmp/stub:$PATH hof-backup --timer');
    assert.equal(timer.status, 3);

    assert.deepEqual(copies(), earlier);
    assert.equal(ok('cat /tmp/flock-calls'), '--wait 60 9\n--wait 600 9\n');
    assert.equal(run('test -e /tmp/docker-calls').status, 1);
  });

  test('the lock is held: a second run waits instead of interfering', () => {
    const result = run(`
      flock ${LOCK} sleep 2 &
      sleep 0.3
      start=$(date +%s%N)
      hof-backup
      code=$?
      echo "$(( ($(date +%s%N) - start) / 1000000 ))"
      wait
      exit $code`);
    assert.equal(result.status, 0, result.stderr);
    const waited = Number(result.stdout.trim().split('\n').at(-1));
    assert.ok(waited > 1000, `waited ${waited} ms`);
  });

  test('the lock is free after the run and records who took it', () => {
    ok('hof-backup');
    assert.match(ok(`cat ${LOCK}`), /^hof-backup nightly, pid \d+/);
    ok(`flock --nonblock ${LOCK} true`);
  });

  test('--lock-held: leaves the lock alone and makes the copy', () => {
    ok(`printf '#!/bin/bash\\ntouch /tmp/flock-called\\nexit 1\\n' > /tmp/stub/flock
        chmod 755 /tmp/stub/flock
        rm -f /tmp/flock-called`);
    assert.equal(run('PATH=/tmp/stub:$PATH hof-backup --pre-deploy --lock-held').status, 0);
    assert.equal(run('test -e /tmp/flock-called').status, 1);
    assert.ok(copies().some((n) => /^hof-predeploy-.*\.dump$/.test(n)));
  });

  test('a wrong argument: nothing runs', () => {
    assert.equal(run('hof-backup --all').status, 2);
    assert.equal(run('test -e /tmp/docker-calls').status, 1);
  });

  test('the next run removes what a killed process left', () => {
    ok(`touch ${DIR}/.hof-nightly-20260101T000000Z.dump.part.abc`);
    ok('hof-backup');
    assert.equal(ok(`ls -A ${DIR} | grep -c '\\.part\\.' || true`), '0\n');
  });

  test('hof-backup-send: list shows ready copies only', () => {
    seed('nightly', [1]);
    seed('predeploy', [2]);
    ok(`touch ${DIR}/.hof-nightly-20260103T000000Z.dump.part.x ${DIR}/manual.dump
        echo 'OK now x' > ${DIR}/backup-status.txt`);
    const result = send('list');
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      'hof-nightly-20260101T000000Z.dump\nhof-predeploy-20260102T000000Z.dump\n',
    );
  });

  test('hof-backup-send: fetch sends the file intact and records the time of the pull', () => {
    ok('hof-backup');
    const name = onlyDump();
    const dump = run(
      `SSH_ORIGINAL_COMMAND='fetch ${name}' hof-backup-send | sha256sum; sha256sum < ${DIR}/${name}`,
    );
    const [sent, stored] = dump.stdout.trim().split('\n');
    assert.equal(sent, stored);
    assert.match(ok('cat /var/lib/hof-backup/state/last-pull'), /^\d{8}T\d{6}Z\n$/);

    ok('rm /var/lib/hof-backup/state/last-pull');
    assert.equal(send(`fetch ${name}.meta`).status, 0);
    assert.equal(run('test -e /var/lib/hof-backup/state/last-pull').status, 1);
  });

  test('hof-backup-send: status shows the result of the last attempt', () => {
    assert.equal(send('status').stdout, 'NONE\n');
    ok('hof-backup');
    assert.match(send('status').stdout, /^OK /);
  });

  test('hof-backup-send: anything else is refused with no data', () => {
    seed('nightly', [1]);
    const good = 'hof-nightly-20260101T000000Z.dump';
    ok(`echo secret > ${DIR}/../outside.dump`);
    for (const request of [
      '',
      'ls',
      'list extra',
      'status extra',
      'fetch',
      'fetch ',
      'fetch ../x',
      'fetch ../outside.dump',
      'fetch /etc/passwd',
      `fetch ${good} extra`,
      `fetch ${good};id`,
      `fetch $(id)`,
      `fetch ${good}\n`,
      `fetch  ${good}`,
      `FETCH ${good}`,
      'fetch backup-status.txt',
      'fetch hof-nightly-20260101.dump',
      'fetch .hof-nightly-20260101T000000Z.dump.part.x',
    ]) {
      const result = send(request);
      assert.equal(result.status, 2, JSON.stringify(request));
      assert.equal(result.stdout, '', JSON.stringify(request));
    }
    assert.equal(send('fetch hof-nightly-20260102T000000Z.dump').status, 1);
  });
});

describe('Mac: hof-backup-pull', () => {
  const SCRIPT = join(ROOT, 'deploy', 'hof-backup-pull.sh');
  let base: string;
  let copiesDir: string;
  let server: string;

  // The time in the name of a copy: hoursAgo hours ago.
  function stamp(hoursAgo: number) {
    return new Date(Date.now() - hoursAgo * 3600_000)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
  }

  function metaOf(body: string) {
    const sha = createHash('sha256').update(body).digest('hex');
    return `created=x\nsize=${Buffer.byteLength(body)}\nsha256=${sha}\nimage=-\n`;
  }

  function serverCopy(name: string, body = `данные ${name}`) {
    writeFileSync(join(server, name), body);
    writeFileSync(join(server, `${name}.meta`), metaOf(body));
  }

  function localCopy(name: string, body = 'старая копия') {
    writeFileSync(join(copiesDir, name), body);
    writeFileSync(join(copiesDir, `${name}.meta`), metaOf(body));
  }

  function pull() {
    return spawnSync('/bin/bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        HOME: join(base, 'home'),
        PATH: `${join(base, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
        BASE: base,
      },
    });
  }

  function notifications(): string {
    const file = join(base, 'notified');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  function working(): string[] {
    return readdirSync(copiesDir)
      .filter((name) => name.startsWith('hof-'))
      .sort();
  }

  function hidden(): string[] {
    return readdirSync(copiesDir).filter((name) => name.includes('.part'));
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hof-backup-pull-'));
    server = join(base, 'server');
    copiesDir = join(base, 'home', 'hof-backups');
    mkdirSync(server);
    mkdirSync(copiesDir, { recursive: true });
    mkdirSync(join(base, 'bin'));
    writeFileSync(join(base, 'server-status'), 'OK now x\n');
    writeFileSync(join(base, 'filevault'), 'FileVault is On.\n');
    const stubs: Record<string, string> = {
      // Drops the -o options and the host; behaves like hof-backup-send on the server.
      ssh: `while [ "$1" = -o ]; do shift 2; done
            echo "$1" >> "$BASE/ssh-hosts"
            shift
            echo "$*" >> "$BASE/ssh-calls"
            [ -f "$BASE/ssh-down" ] && exit 255
            case $1 in
            list)
              ls "$BASE/server" | grep '\\.dump$'
              if [ -f "$BASE/list-extra" ]; then cat "$BASE/list-extra"; fi
              ;;
            status) cat "$BASE/server-status" ;;
            fetch)
              if [ -f "$BASE/cut-$2" ]; then head -c 3 "$BASE/server/$2"; exit 255; fi
              cat "$BASE/server/$2" ;;
            esac`,
      fdesetup: 'cat "$BASE/filevault"',
      tmutil: `echo "$*" >> "$BASE/tmutil"
               if [ -f "$BASE/tmutil-fail" ]; then echo 'tmutil: отказ' >&2; exit 1; fi`,
      osascript: `echo "$*" >> "$BASE/notify-attempts"
                  if [ -f "$BASE/osascript-fail" ]; then echo 'osascript: отказ' >&2; exit 1; fi
                  echo "$*" >> "$BASE/notified"`,
    };
    for (const [name, body] of Object.entries(stubs)) {
      const path = join(base, 'bin', name);
      writeFileSync(path, `#!/bin/bash\n${body}\n`);
      chmodSync(path, 0o755);
    }
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('pulls every missing copy, modes 700 and 600, the folder is closed to indexing', () => {
    const names = [`hof-nightly-${stamp(30)}.dump`, `hof-nightly-${stamp(6)}.dump`];
    for (const name of names) serverCopy(name);
    const result = pull();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(working(), [...names, ...names.map((n) => `${n}.meta`)].sort());
    assert.equal(statSync(copiesDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(copiesDir, names[0]!)).mode & 0o777, 0o600);
    assert.ok(existsSync(join(copiesDir, '.metadata_never_index')));
    assert.ok(readFileSync(join(base, 'tmutil'), 'utf8').includes(`addexclusion ${copiesDir}`));
    assert.ok(readFileSync(join(base, 'ssh-hosts'), 'utf8').startsWith('hof-backup\n'));
    assert.equal(notifications(), '');
    assert.ok(!result.stdout.includes('данные'));
  });

  test('FileVault is off: a warning, no copies are pulled', () => {
    serverCopy(`hof-nightly-${stamp(1)}.dump`);
    writeFileSync(join(base, 'filevault'), 'FileVault is Off.\n');
    assert.equal(pull().status, 1);
    assert.deepEqual(working(), []);
    assert.ok(notifications().includes('FileVault выключен'));
    assert.ok(!existsSync(join(base, 'ssh-hosts')));
  });

  test('Time Machine: no exclusion, no pull, unless it is set up or the owner decides', () => {
    const name = `hof-nightly-${stamp(1)}.dump`;
    serverCopy(name);
    writeFileSync(join(base, 'tmutil-fail'), '');
    const refused = pull();
    assert.equal(refused.status, 1);
    assert.deepEqual(working(), []);
    assert.ok(!existsSync(join(base, 'ssh-hosts')));
    assert.ok(notifications().includes('не исключён из Time Machine'));
    assert.ok(refused.stderr.includes('tmutil: отказ'));

    // A separate decision of the owner: a file in the folder of copies.
    writeFileSync(join(copiesDir, '.time-machine-allowed'), '');
    assert.equal(pull().status, 0);
    assert.ok(working().includes(name));
    rmSync(join(copiesDir, '.time-machine-allowed'));
    rmSync(join(copiesDir, name));
    rmSync(join(copiesDir, `${name}.meta`));

    // The exclusion works again: the pull needs no decision of the owner.
    rmSync(join(base, 'tmutil-fail'));
    assert.equal(pull().status, 0);
    assert.ok(working().includes(name));
  });

  test('an incomplete copy: replaced only by a verified one, stays on failure; a complete one is not read', () => {
    const name = `hof-nightly-${stamp(1)}.dump`;
    const damaged = 'архив без сведений';
    serverCopy(name);
    writeFileSync(join(copiesDir, name), damaged);

    // The server sent a wrong archive: the earlier file stays, the notifications come.
    writeFileSync(join(server, name), 'испорчено');
    assert.equal(pull().status, 1);
    assert.equal(readFileSync(join(copiesDir, name), 'utf8'), damaged);
    assert.ok(!existsSync(join(copiesDir, `${name}.meta`)));
    assert.ok(notifications().includes('не совпала по SHA-256'));
    assert.ok(notifications().includes('не считается полной'));
    assert.ok(notifications().includes('На Mac нет копии моложе 36 часов'));

    // A pull cut short: it stays as well.
    serverCopy(name);
    writeFileSync(join(base, `cut-${name}`), '');
    assert.equal(pull().status, 1);
    assert.equal(readFileSync(join(copiesDir, name), 'utf8'), damaged);
    assert.deepEqual(hidden(), []);

    // The pull went through: replaced by a verified copy, with its .meta.
    rmSync(join(base, `cut-${name}`));
    assert.equal(pull().status, 0);
    assert.equal(readFileSync(join(copiesDir, name), 'utf8'), `данные ${name}`);
    assert.equal(readFileSync(join(copiesDir, `${name}.meta`), 'utf8'), metaOf(`данные ${name}`));

    // Now the copy is complete: it is not read every hour or pulled again.
    rmSync(join(base, 'ssh-calls'));
    assert.equal(pull().status, 0);
    assert.ok(!readFileSync(join(base, 'ssh-calls'), 'utf8').includes('fetch'));

    // The size differs from the one written down: pulled again.
    writeFileSync(join(copiesDir, name), 'обрезано');
    assert.equal(pull().status, 0);
    assert.equal(readFileSync(join(copiesDir, name), 'utf8'), `данные ${name}`);
  });

  test('an incomplete copy the server no longer has: kept, not counted as fresh', () => {
    const name = `hof-nightly-${stamp(1)}.dump`;
    writeFileSync(join(copiesDir, name), 'единственный архив');
    serverCopy(`hof-nightly-${stamp(2)}.dump`);
    assert.equal(pull().status, 0);
    assert.equal(readFileSync(join(copiesDir, name), 'utf8'), 'единственный архив');
    assert.ok(notifications().includes('не считается полной'));
  });

  test('a notification not shown: the error is logged, no mark, the next run tries again', () => {
    writeFileSync(join(base, 'filevault'), 'FileVault is Off.\n');
    writeFileSync(join(base, 'osascript-fail'), '');
    const flag = join(copiesDir, '.notified-filevault');
    const attempts = () => readFileSync(join(base, 'notify-attempts'), 'utf8').trim().split('\n');

    const failed = pull();
    assert.ok(failed.stdout.includes('уведомление не показано'));
    assert.ok(failed.stderr.includes('osascript: отказ'));
    assert.ok(!existsSync(flag));
    pull();
    assert.equal(attempts().length, 2);

    rmSync(join(base, 'osascript-fail'));
    pull();
    assert.equal(attempts().length, 3);
    assert.ok(existsSync(flag));
    pull();
    assert.equal(attempts().length, 3);
  });

  test('a pull cut short leaves no working file, the next run pulls what is missing', () => {
    const first = `hof-nightly-${stamp(30)}.dump`;
    const second = `hof-nightly-${stamp(6)}.dump`;
    serverCopy(first);
    serverCopy(second);
    writeFileSync(join(base, `cut-${second}`), '');

    assert.equal(pull().status, 1);
    assert.deepEqual(working(), [first, `${first}.meta`]);
    assert.deepEqual(hidden(), []);

    rmSync(join(base, `cut-${second}`));
    assert.equal(pull().status, 0);
    assert.deepEqual(working(), [first, `${first}.meta`, second, `${second}.meta`].sort());
    assert.equal(readFileSync(join(copiesDir, second), 'utf8'), `данные ${second}`);
  });

  test('SHA-256 differs: the copy is not kept, a notification comes', () => {
    const name = `hof-nightly-${stamp(1)}.dump`;
    serverCopy(name);
    writeFileSync(join(server, name), 'испорчено');
    assert.equal(pull().status, 1);
    assert.deepEqual(working(), []);
    assert.deepEqual(hidden(), []);
    assert.ok(notifications().includes('не совпала по SHA-256'));
  });

  test('garbage from the server: such names are not pulled', () => {
    serverCopy(`hof-nightly-${stamp(1)}.dump`);
    writeFileSync(join(base, 'list-extra'), '../../x.dump\nevil;id.dump\nhof-nightly-1.dump\n');
    assert.equal(pull().status, 0);
    assert.equal(working().filter((n) => n.endsWith('.dump')).length, 1);
  });

  test('the oldest copy on the server is newer than the local one: a gap signal, the newest is pulled', () => {
    localCopy(`hof-nightly-${stamp(24 * 20)}.dump`);
    const oldest = `hof-nightly-${stamp(24 * 3)}.dump`;
    const newest = `hof-nightly-${stamp(2)}.dump`;
    serverCopy(oldest);
    serverCopy(newest);
    assert.equal(pull().status, 0);
    assert.ok(notifications().includes('возможен разрыв'));
    assert.ok(working().includes(newest));
  });

  test('no gap while the server still has the local copy', () => {
    const shared = `hof-nightly-${stamp(30)}.dump`;
    localCopy(shared);
    serverCopy(shared);
    serverCopy(`hof-nightly-${stamp(6)}.dump`);
    pull();
    assert.ok(!notifications().includes('разрыв'));
  });

  test('copies older than 36 hours: notifications, at most once in 12 hours', () => {
    const old = `hof-nightly-${stamp(40)}.dump`;
    localCopy(old);
    serverCopy(old);
    assert.equal(pull().status, 0);
    assert.ok(notifications().includes('На сервере нет копии моложе 36 часов'));
    assert.ok(notifications().includes('На Mac нет копии моложе 36 часов'));

    const shown = notifications();
    pull();
    assert.equal(notifications(), shown);

    const longAgo = new Date(Date.now() - 13 * 3600_000);
    utimesSync(join(copiesDir, '.notified-stale-local'), longAgo, longAgo);
    pull();
    assert.equal(
      notifications()
        .split('\n')
        .filter((l) => l.includes('На Mac')).length,
      2,
    );
  });

  test('the server is down: no notification at first, one after a day, the Mac retries', () => {
    localCopy(`hof-nightly-${stamp(2)}.dump`);
    writeFileSync(join(base, 'ssh-down'), '');
    assert.equal(pull().status, 1);
    assert.equal(notifications(), '');

    const longAgo = new Date(Date.now() - 25 * 3600_000);
    utimesSync(join(copiesDir, '.last-contact'), longAgo, longAgo);
    assert.equal(pull().status, 1);
    assert.ok(notifications().includes('Сервер недоступен больше суток'));

    rmSync(join(base, 'ssh-down'));
    const fresh = `hof-nightly-${stamp(1)}.dump`;
    serverCopy(fresh);
    assert.equal(pull().status, 0);
    assert.ok(working().includes(fresh));
  });

  test('the server reports a failure: a notification without the text of the server', () => {
    serverCopy(`hof-nightly-${stamp(1)}.dump`);
    writeFileSync(join(base, 'server-status'), 'FAIL now "; do shell script "id"\n');
    assert.equal(pull().status, 0);
    assert.ok(notifications().includes('Последняя копия на сервере не создана'));
    assert.ok(!notifications().includes('shell script'));
  });

  test('retention: 30 nightly, one a month for 12 months, 5 before updates', () => {
    // Four copies a month for 15 months: 60 nightly.
    const nightly: string[] = [];
    for (let m = 0; m < 15; m++) {
      const year = 2025 + Math.floor(m / 12);
      const month = String((m % 12) + 1).padStart(2, '0');
      for (const day of ['01', '08', '15', '22']) {
        nightly.push(`hof-nightly-${year}${month}${day}T033000Z.dump`);
      }
    }
    for (const name of nightly) localCopy(name);
    const predeploy = [1, 2, 3, 4, 5, 6, 7].map((d) => `hof-predeploy-2026020${d}T033000Z.dump`);
    for (const name of predeploy) localCopy(name);
    writeFileSync(join(copiesDir, 'hof-2026-01-01-000000-abc.dump'), 'ручная копия');

    // No new copy, no cleanup.
    serverCopy(nightly.at(-1)!);
    pull();
    assert.equal(working().filter((n) => n.endsWith('.dump')).length, nightly.length + 8);

    const fresh = `hof-nightly-${stamp(1)}.dump`;
    serverCopy(fresh);
    assert.equal(pull().status, 0);
    const kept = working().filter((n) => n.endsWith('.dump'));

    assert.ok(kept.includes(fresh));
    assert.ok(kept.includes('hof-2026-01-01-000000-abc.dump'));
    assert.deepEqual(
      kept.filter((n) => n.startsWith('hof-predeploy-')),
      predeploy.slice(-5),
    );
    const keptNightly = kept.filter((n) => n.startsWith('hof-nightly-'));
    for (const name of [...nightly.slice(-29), fresh]) assert.ok(keptNightly.includes(name), name);
    // The start of each of the last 12 months stays, older months go.
    assert.ok(keptNightly.includes('hof-nightly-20250601T033000Z.dump'));
    assert.ok(!keptNightly.includes('hof-nightly-20250508T033000Z.dump'));
    assert.ok(!kept.some((n) => n === 'hof-nightly-20250101T033000Z.dump'));
    assert.ok(!existsSync(join(copiesDir, 'hof-nightly-20250101T033000Z.dump.meta')));
  });
});
