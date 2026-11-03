// The check of the server (docs/OPERATIONS.md, section «Проверка сервера»).
//
// hof-check is written for the Linux of the server, so it runs in a container with a real
// PostgreSQL, real pg_isready, psql, openssl and bash. /usr/bin/docker there is a stub: `ps` and
// `inspect` answer from a table of made-up containers, Hof and those of another project among
// them, and `exec` runs the command right in that container. A stand-in on port 3000 answers the
// request of the healthcheck. free, df, journalctl and systemctl are stubs too. Real containers on
// a real Docker are checked in CI; the template of `docker inspect` of the script also runs here on
// the Docker of this machine, against containers with and without a healthcheck.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'deploy', 'hof-check.sh');
const STATUS = '/var/lib/hof-check/status.txt';
const BACKUPS = '/var/backups/hof';
const LAST_PULL = '/var/lib/hof-backup/state/last-pull';
const HEAD = /^(OK|WARN|FAIL) \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

// Columns of /tmp/containers: what `docker inspect` of the script reads, plus the project, the
// one-off label and the mounts that the stub filters and prints.
interface Container {
  id: string;
  project: string;
  oneoff: string;
  service: string;
  state: string;
  restarts: string;
  oom: string;
  health: string;
  started: string;
  logType: string;
  maxSize: string;
  maxFile: string;
  mounts: string;
}

const DOCKER_STUB = `#!/bin/bash
echo "$*" >> /tmp/docker-calls
if [ -f /tmp/docker-hangs ]; then exec sleep 600; fi
if [ -f /tmp/docker-down ]; then echo 'Cannot connect to the Docker daemon' >&2; exit 1; fi
row() { awk -F'|' -v id="$1" '$1 == id' /tmp/containers; }
case $1 in
ps)
  project='' oneoff=''
  for arg; do
    case $arg in
    label=com.docker.compose.project=*) project=\${arg#*project=} ;;
    label=com.docker.compose.oneoff=*) oneoff=\${arg#*oneoff=} ;;
    esac
  done
  awk -F'|' -v p="$project" -v o="$oneoff" '(p == "" || $2 == p) && (o == "" || $3 == o) { print $1 }' /tmp/containers
  ;;
inspect)
  format=$3
  shift 3
  for id; do
    line=$(row "$id")
    if [ -z "$line" ]; then echo "Error: No such object: $id" >&2; exit 1; fi
    if [[ $format == *Mounts* ]]; then
      printf '%s\\n' "$line" | awk -F'|' '{ print $13 }' | tr ',' '\\n'
    else
      printf '%s\\n' "$line" | awk -F'|' -v OFS='|' '{ print $4, $1, $5, $6, $7, $8, $9, $10, $11, $12 }'
    fi
  done
  ;;
info) echo /var/lib/docker ;;
exec)
  shift
  vars=()
  while [ "$1" = -e ]; do vars+=("$2"); shift 2; done
  service=$(row "$1" | awk -F'|' '{ print $4 }')
  shift
  case $service in
  postgres | hof) exec env "\${vars[@]}" "$@" ;;
  *) echo "exec in $service" >&2; exit 1 ;;
  esac
  ;;
*) echo "docker $1: not in the stub" >&2; exit 1 ;;
esac
`;

const STUBS: Record<string, string> = {
  free: 'cat /tmp/free',
  df: `echo 'Mounted on Avail'
       for path in "\${@:3}"; do echo "/ $(cat /tmp/avail)"; done`,
  journalctl: `echo "$*" >> /tmp/journalctl-calls
               case $* in
               *--disk-usage*) echo 'Archived and active journals take up 56.0M in the file system.' ;;
               *)
                 if [ -f /tmp/journal-fails ]; then exit 1; fi
                 cat /tmp/kernel-log
                 ;;
               esac`,
  systemctl: `echo "$*" >> /tmp/systemctl-calls
              state=$(cat /tmp/certbot-timer)
              echo "$state"
              [ "$state" = active ]`,
};

// A stand-in for Hof on port 3000: it answers 404 like an image without /healthz, or holds the
// connection without an answer.
const STAND_IN = `
use IO::Socket::INET;
my $server = IO::Socket::INET->new(LocalAddr => '127.0.0.1:3000', Listen => 5, ReuseAddr => 1) or die;
my @held;
while (my $client = $server->accept) {
  if ($ARGV[0] eq 'answer') {
    print $client "HTTP/1.1 404 Not Found\\r\\nConnection: close\\r\\n\\r\\n";
    close $client;
  } else {
    push @held, $client;
  }
}
`;

describe('server: hof-check', () => {
  const NAME = `hof-check-test-${process.pid}`;

  function docker(...args: string[]) {
    return spawnSync('docker', args, { encoding: 'utf8' });
  }

  function run(script: string, input?: string) {
    return spawnSync('docker', ['exec', '-i', NAME, 'bash', '-c', script], {
      encoding: 'utf8',
      input,
    });
  }

  function ok(script: string): string {
    const result = run(script);
    assert.equal(result.status, 0, `${script}\n${result.stderr}`);
    return result.stdout;
  }

  function put(path: string, text: string) {
    const result = run(`cat > ${path}`, text);
    assert.equal(result.status, 0, result.stderr);
  }

  function iso(hoursAgo: number, compact = false) {
    const time = new Date(Date.now() - hoursAgo * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    return compact ? time.replace(/[-:]/g, '') : time;
  }

  const FRESH: Container = {
    id: '',
    project: 'hof',
    oneoff: 'False',
    service: '',
    state: 'running',
    restarts: '0',
    oom: 'false',
    health: 'none',
    started: '',
    logType: 'json-file',
    maxSize: '10m',
    maxFile: '3',
    mounts: '',
  };

  function containers(changes: Record<string, Partial<Container>> = {}, extra: Container[] = []) {
    const started = iso(48);
    const rows: Record<string, Container> = {
      postgres: { ...FRESH, id: 'pg-id', service: 'postgres', health: 'healthy', started },
      hof: { ...FRESH, id: 'hof-id', service: 'hof', health: 'healthy', started },
      nginx: {
        ...FRESH,
        id: 'nginx-id',
        service: 'nginx',
        started,
        mounts:
          '/opt/hof/deploy/nginx.conf,/etc/letsencrypt/live/hof.test,/etc/letsencrypt/archive/hof.test',
      },
      // A one-off container of Hof, like `docker compose run hof …`, and the containers of another
      // project with the same service names.
      oneoff: { ...FRESH, id: 'run-id', oneoff: 'True', service: 'hof', started },
      neighbour: { ...FRESH, id: 'other-pg-id', project: 'other', service: 'postgres', started },
      neighbour2: { ...FRESH, id: 'other-nginx-id', project: 'other', service: 'nginx', started },
    };
    for (const [key, change] of Object.entries(changes)) {
      if (key in rows) rows[key] = { ...rows[key]!, ...change };
    }
    const lines = [...Object.values(rows), ...extra].filter((row) => row.id !== '');
    put(
      '/tmp/containers',
      lines
        .map((r) =>
          [
            r.id,
            r.project,
            r.oneoff,
            r.service,
            r.state,
            r.restarts,
            r.oom,
            r.health,
            r.started,
            r.logType,
            r.maxSize,
            r.maxFile,
            r.mounts,
          ].join('|'),
        )
        .join('\n') + '\n',
    );
  }

  function certificate(days: number) {
    ok(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /dev/null \
          -out /etc/letsencrypt/live/hof.test/cert.pem -days ${days} -subj /CN=hof.test 2>/dev/null`);
  }

  function copy(kind: string, hoursAgo: number) {
    const file = `${BACKUPS}/hof-${kind}-${iso(hoursAgo, true)}.dump`;
    ok(`echo копия > ${file}; echo sha256=x > ${file}.meta`);
    return file;
  }

  function standIn(mode: 'answer' | 'hold') {
    put('/tmp/stand-in.pl', STAND_IN);
    ok(`perl /tmp/stand-in.pl ${mode} >/dev/null 2>&1 </dev/null & echo $! > /tmp/stand-in.pid
        for i in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/3000) 2>/dev/null && exit 0; sleep 0.1; done
        exit 1`);
  }

  function check() {
    const result = run('hof-check');
    return { ...result, lines: result.stdout.split('\n').filter(Boolean) };
  }

  // The finding that starts with this text, with its level.
  function finding(lines: string[], start: string) {
    const line = lines.slice(1).find((l) => l.slice(5).startsWith(start));
    assert.ok(line, `no «${start}» in\n${lines.join('\n')}`);
    return line;
  }

  before(() => {
    const started = docker(
      'run',
      '-d',
      '--rm',
      '--name',
      NAME,
      '--entrypoint',
      'sleep',
      'postgres:18.6-trixie',
      'infinity',
    );
    assert.equal(started.status, 0, started.stderr);
    assert.equal(docker('cp', SCRIPT, `${NAME}:/usr/local/sbin/hof-check`).status, 0);
    put('/usr/bin/docker', DOCKER_STUB);
    for (const [name, body] of Object.entries(STUBS)) {
      put(`/usr/local/bin/${name}`, `#!/bin/bash\n${body}\n`);
    }
    ok(`chmod 755 /usr/bin/docker /usr/local/bin/* /usr/local/sbin/hof-check
        groupadd --system hof-backup
        install -d -m 2750 -g hof-backup /var/lib/hof-check ${BACKUPS}
        install -d -m 700 /var/lib/hof-backup/state /etc/letsencrypt/live/hof.test
        install -d -m 700 -o postgres -g postgres /tmp/pg
        gosu postgres initdb --auth=trust --pgdata=/tmp/pg >/dev/null
        gosu postgres pg_ctl --pgdata=/tmp/pg --log=/tmp/pg.log --wait start >/dev/null
        createdb --username=postgres hof`);
  });

  after(() => {
    // -v: the anonymous volume the image declares goes with the container.
    docker('rm', '-fv', NAME);
  });

  beforeEach(() => {
    ok(`rm -f /tmp/docker-* /tmp/journal* /tmp/systemctl-calls /run/hof-certbot-nginx-hof
        rm -rf ${BACKUPS}/* /var/lib/hof-check/* /var/lib/hof-check/.[!.]* ${LAST_PULL}
        if [ -f /tmp/stand-in.pid ]; then kill $(cat /tmp/stand-in.pid) 2>/dev/null; rm /tmp/stand-in.pid; fi
        : > /tmp/kernel-log
        echo active > /tmp/certbot-timer
        echo 3000 > /tmp/avail`);
    put(
      '/tmp/free',
      [
        '               total        used        free      shared  buff/cache   available',
        'Mem:             961         400         100          20         460         456',
        'Swap:           1023          94         929',
        '',
      ].join('\n'),
    );
    containers();
    certificate(80);
    copy('nightly', 31);
    copy('nightly', 7);
    put(`${BACKUPS}/backup-status.txt`, `OK ${iso(7)} hof-nightly-${iso(7, true)}.dump\n`);
    put(LAST_PULL, `${iso(6, true)}\n`);
  });

  test('all is well: OK, exit 0, the status is the report with the time of the check', () => {
    const before = iso(0);
    const { status, stdout, lines } = check();
    const after = iso(0);
    assert.equal(status, 0, stdout);
    assert.match(lines[0]!, HEAD);
    const time = lines[0]!.split(' ')[1]!;
    assert.ok(time >= before && time <= after, `${before} ≤ ${time} ≤ ${after}`);
    assert.deepEqual(
      lines.slice(1).filter((l) => !l.startsWith('OK   ')),
      [],
    );
    for (const start of [
      'контейнер postgres: running',
      'контейнер hof: running',
      'контейнер nginx: running',
      'живость hof: healthy',
      'база: pg_isready и SELECT 1 выполнены',
      'копии: ночных 2, предрелизных 0, новейшая hof-nightly-',
      'забор на Mac: 6 ч назад',
      'диск /: свободно 3000 МБ',
      'память: доступно 456 МБ',
      'swap: занято 94 из 1023 МБ',
      'OOM ядра за 7 дней: нет',
      'сертификат hof.test: осталось ',
      'certbot.timer: active',
      'логи: postgres json-file 10m × 3; hof json-file 10m × 3; nginx json-file 10m × 3',
      'journald: 56.0M, только показывается',
    ]) {
      finding(lines, start);
    }

    assert.equal(ok(`cat ${STATUS}`), stdout);
    assert.equal(ok(`stat -c '%a %G' ${STATUS}`), '640 hof-backup\n');
    assert.equal(ok('ls -A /var/lib/hof-check'), 'status.txt\n');
  });

  test('the status is replaced whole: a reader never sees a part of it', () => {
    check();
    const result = run(`
      (for i in $(seq 1 8); do hof-check > /dev/null; done) &
      writer=$!
      while kill -0 $writer 2>/dev/null; do
        tail -n 1 ${STATUS} | grep -q '^OK   journald: ' || { echo broken; cat ${STATUS}; }
      done
      wait $writer`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });

  test('the database is down while Hof answers: FAIL by the database, the process is alive', () => {
    ok('gosu postgres pg_ctl --pgdata=/tmp/pg --wait stop >/dev/null');
    try {
      const { status, lines } = check();
      assert.equal(status, 2);
      assert.match(lines[0]!, /^FAIL /);
      finding(lines, 'база: не отвечает, ни pg_isready, ни SELECT 1');
      assert.match(finding(lines, 'живость hof: healthy'), /^OK /);
      assert.match(finding(lines, 'контейнер postgres: running'), /^OK /);
    } finally {
      ok('gosu postgres pg_ctl --pgdata=/tmp/pg --log=/tmp/pg.log --wait start >/dev/null');
    }
  });

  test('the server answers, but the database of Hof does not: FAIL by SELECT 1', () => {
    ok('psql --username=postgres --dbname=postgres -q -c "ALTER DATABASE hof RENAME TO hof_away"');
    try {
      const { status, lines } = check();
      assert.equal(status, 2);
      assert.match(finding(lines, 'база: pg_isready отвечает, SELECT 1 не выполнен'), /^FAIL /);
    } finally {
      ok(
        'psql --username=postgres --dbname=postgres -q -c "ALTER DATABASE hof_away RENAME TO hof"',
      );
    }
  });

  for (const [title, changes, level, expected] of [
    ['unhealthy', { hof: { health: 'unhealthy' } }, 'FAIL', 'живость hof: unhealthy'],
    ['starting', { hof: { health: 'starting' } }, 'WARN', 'живость hof: starting'],
    ['exited', { hof: { state: 'exited' } }, 'FAIL', 'контейнер hof: exited'],
    ['restarting', { hof: { state: 'restarting' } }, 'FAIL', 'контейнер hof: restarting'],
    ['missing', { hof: { id: '' } }, 'FAIL', 'контейнер hof: не найден'],
    ['nginx stopped', { nginx: { state: 'exited' } }, 'FAIL', 'контейнер nginx: exited'],
    ['postgres stopped', { postgres: { state: 'exited' } }, 'FAIL', 'база: не проверена'],
    ['OOMKilled', { hof: { oom: 'true' } }, 'WARN', 'контейнер hof: прошлый раз завершён'],
    [
      'restarted an hour ago',
      { hof: { restarts: '3', started: iso(1) } },
      'WARN',
      'контейнер hof: Docker перезапускал его после сбоя 3 раз',
    ],
    [
      'restarted days ago',
      { hof: { restarts: '3', started: iso(72) } },
      'OK',
      'контейнер hof: перезапусков после сбоя 3, последний больше суток назад',
    ],
    [
      'logs without a limit',
      { hof: { maxSize: '<no value>', maxFile: '<no value>' } },
      'WARN',
      'логи hof: json-file без max-size',
    ],
  ] as const) {
    test(`a container of Hof ${title}: ${level}`, () => {
      containers(changes);
      const { status, lines } = check();
      assert.equal(status, { OK: 0, WARN: 1, FAIL: 2 }[level], lines.join('\n'));
      assert.ok(finding(lines, expected).startsWith(level), lines.join('\n'));
      if (title === 'unhealthy') {
        assert.match(finding(lines, 'база: pg_isready и SELECT 1 выполнены'), /^OK /);
      }
    });
  }

  test('two containers of one service: FAIL; a one-off container is not counted', () => {
    containers({}, [{ ...FRESH, id: 'hof2-id', service: 'hof', health: 'healthy' }]);
    const { status, lines } = check();
    assert.equal(status, 2);
    finding(lines, 'контейнер hof: их 2, ожидается один');
    finding(lines, 'живость hof: не проверена');
  });

  test('Docker does not answer: FAIL, and the rest of the server is still checked', () => {
    ok('touch /tmp/docker-down');
    const { status, lines } = check();
    assert.equal(status, 2);
    finding(lines, 'Docker не ответил');
    finding(lines, 'копии: ночных 2');
    finding(lines, 'диск /: свободно 3000 МБ');
  });

  test('a container without a healthcheck, made before M11.5: a clear transitional state', () => {
    // As on the server: postgres with a healthcheck, hof and nginx without one.
    containers({ hof: { health: 'none' } });

    standIn('answer');
    let { status, lines } = check();
    assert.equal(status, 1, lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('Docker не ответил')), lines.join('\n'));
    for (const service of ['postgres', 'hof', 'nginx']) {
      assert.equal(finding(lines, `контейнер ${service}:`), `OK   контейнер ${service}: running`);
    }
    assert.equal(
      finding(lines, 'живость hof:'),
      'WARN живость hof: процесс отвечает по HTTP; healthcheck в контейнере не настроен, контейнер создан до M11.5',
    );
    assert.ok(ok('cat /tmp/docker-calls').includes('exec hof-id bash -c'));
    ok('kill $(cat /tmp/stand-in.pid); rm /tmp/stand-in.pid');

    // Nothing listens on the port.
    ({ status, lines } = check());
    assert.equal(status, 2);
    assert.match(finding(lines, 'живость hof:'), /^FAIL живость hof: процесс не отвечает по HTTP/);

    // The process holds the connection and does not answer: FAIL after the 3 s of the request.
    standIn('hold');
    const started = Date.now();
    ({ status, lines } = check());
    const took = Date.now() - started;
    assert.equal(status, 2);
    assert.match(finding(lines, 'живость hof:'), /^FAIL /);
    assert.ok(took >= 3000 && took < 10_000, `${took} ms`);
  });

  test('space: WARN when the nightly copy would be refused, FAIL when almost nothing is left', () => {
    ok('echo 1000 > /tmp/avail');
    let { status, lines } = check();
    assert.equal(status, 1);
    assert.equal(
      finding(lines, 'диск /:'),
      'WARN диск /: свободно 1000 МБ, ночной копии нужно 1536 МБ',
    );

    ok('echo 300 > /tmp/avail');
    ({ status, lines } = check());
    assert.equal(status, 2);
    assert.equal(finding(lines, 'диск /:'), 'FAIL диск /: свободно 300 МБ');

    // The reserve grows with the last copy, as in hof-backup: 1536 + 2 × 1024.
    ok(`echo 3000 > /tmp/avail; truncate -s 1G ${copy('nightly', 1)}`);
    ({ status, lines } = check());
    assert.equal(
      finding(lines, 'диск /:'),
      'WARN диск /: свободно 3000 МБ, ночной копии нужно 3584 МБ',
    );
  });

  test('copies: none is FAIL, too old is FAIL, a failed attempt and an old pull are WARN', () => {
    ok(`rm ${BACKUPS}/hof-*`);
    let { status, lines } = check();
    assert.equal(status, 2);
    finding(lines, `копии: в ${BACKUPS} нет ни одной`);

    copy('nightly', 40);
    copy('predeploy', 39);
    ({ status, lines } = check());
    assert.equal(status, 2);
    assert.match(
      finding(lines, 'копии:'),
      /^FAIL копии: ночных 1, предрелизных 1, новейшая hof-predeploy-\S+, 39 ч назад: новых копий нет$/,
    );

    copy('nightly', 2);
    const attempted = iso(1);
    put(
      `${BACKUPS}/backup-status.txt`,
      `FAIL ${attempted} nightly: мало места: свободно 1024 КБ\n`,
    );
    ({ status, lines } = check());
    assert.equal(status, 1);
    assert.equal(
      finding(lines, 'копии: попытка'),
      `WARN копии: попытка ${attempted} не удалась: nightly: мало места: свободно 1024 КБ`,
    );

    ok(`rm ${BACKUPS}/backup-status.txt; echo ${iso(40, true)} > ${LAST_PULL}`);
    ({ lines } = check());
    finding(lines, 'копии: итога последней попытки нет');
    assert.equal(finding(lines, 'забор на Mac:'), 'WARN забор на Mac: последний 40 ч назад');

    ok(`rm ${LAST_PULL}`);
    ({ lines } = check());
    assert.match(finding(lines, 'забор на Mac:'), /^WARN забор на Mac: времени забора нет/);
  });

  test('memory, swap and the OOM of the kernel: WARN', () => {
    put(
      '/tmp/free',
      [
        '               total        used        free      shared  buff/cache   available',
        'Mem:             961         800          40          20         121          90',
        'Swap:           1023         980          43',
        '',
      ].join('\n'),
    );
    put(
      '/tmp/kernel-log',
      [
        'x invoked oom-killer: gfp_mask=0x140cca',
        'Out of memory: Killed process 1234 (a) total-vm:1kB',
        'Memory cgroup out of memory: Killed process 5678 (b) total-vm:1kB',
        'eth0: link up',
        '',
      ].join('\n'),
    );
    const first = check();
    assert.equal(first.status, 1);
    let { lines } = first;
    assert.equal(finding(lines, 'память:'), 'WARN память: доступно 90 МБ');
    assert.equal(finding(lines, 'swap:'), 'WARN swap: занято 980 из 1023 МБ, почти полон');
    assert.equal(
      finding(lines, 'OOM ядра'),
      'WARN OOM ядра за 7 дней: 2, подробности в journalctl -k',
    );
    // Kernel messages of every boot of the last 7 days, not of the current one only.
    assert.match(ok('cat /tmp/journalctl-calls'), /^_TRANSPORT=kernel --since=-7d /m);

    ok('touch /tmp/journal-fails');
    ({ lines } = check());
    assert.equal(finding(lines, 'OOM ядра'), 'WARN OOM ядра: журнал не прочитан');
  });

  test('the certificate, certbot.timer and the flag of the hook', () => {
    certificate(15);
    let { status, lines } = check();
    assert.equal(status, 1);
    // Whole days are left: 14, or 15 when the check runs in the same second as openssl.
    assert.match(
      finding(lines, 'сертификат hof.test:'),
      /^WARN сертификат hof\.test: осталось 1[45] дн\., продление не удаётся$/,
    );

    certificate(3);
    ({ status, lines } = check());
    assert.equal(status, 2);
    assert.match(
      finding(lines, 'сертификат hof.test:'),
      /^FAIL сертификат hof\.test: осталось [23] дн\.$/,
    );

    certificate(80);
    ok('echo inactive > /tmp/certbot-timer; touch /run/hof-certbot-nginx-hof');
    ({ status, lines } = check());
    assert.equal(status, 1);
    assert.equal(
      finding(lines, 'certbot.timer:'),
      'WARN certbot.timer: inactive, сертификат не продлится',
    );
    finding(lines, 'хук certbot: остался флаг /run/hof-certbot-nginx-hof');
    assert.equal(
      ok('cat /tmp/systemctl-calls'),
      'is-active certbot.timer\nis-active certbot.timer\nis-active certbot.timer\n',
    );

    containers({ nginx: { id: '' } });
    ({ lines } = check());
    assert.match(finding(lines, 'сертификат:'), /^WARN сертификат: не проверен/);
  });

  test('only the containers of Hof: the other project and the one-off container stay untouched', () => {
    check();
    const calls = ok('cat /tmp/docker-calls').trim().split('\n');
    assert.equal(
      calls[0],
      'ps --all --quiet --filter label=com.docker.compose.project=hof --filter label=com.docker.compose.oneoff=False',
    );
    for (const call of calls) {
      assert.ok(!/other-|run-id/.test(call), call);
      assert.match(call, /^(ps|inspect|info|exec) /, call);
    }
    assert.ok(calls.some((c) => c.startsWith('exec pg-id pg_isready ')));
    assert.ok(calls.some((c) => c.startsWith('exec -e PGCONNECT_TIMEOUT=5 pg-id psql ')));
  });

  test('a check that does not finish leaves FAIL with its own time, not the earlier OK', () => {
    assert.equal(check().status, 0);
    const earlier = ok(`cat ${STATUS}`);

    // A Docker that hangs, and the stop by systemd: TERM to every process of the check. timeout
    // runs in a process group of its own; systemd reaches it through the cgroup.
    ok('touch /tmp/docker-hangs');
    const started = Date.now();
    const result = run(`
      setsid hof-check > /tmp/out & pid=$!
      sleep 1
      kill -TERM -- -$pid
      pkill -TERM -x timeout
      wait $pid
      echo "code $?"`);
    assert.match(result.stdout, /code 2\n$/);
    assert.ok(Date.now() - started < 10_000);
    const status = ok(`cat ${STATUS}`);
    assert.notEqual(status, earlier);
    assert.match(status, /^FAIL \S+\n/);
    assert.match(status, /^FAIL hof-check: проверка не завершилась$/m);
  });

  test('the status cannot be written: the report is printed, exit code 3', () => {
    ok('mv /var/lib/hof-check /var/lib/hof-check.away');
    try {
      const { status, stdout, stderr } = run('hof-check');
      assert.equal(status, 3);
      assert.match(stdout, /^OK /);
      assert.ok(stderr.includes(`статус не записан в ${STATUS}`), stderr);
    } finally {
      ok('mv /var/lib/hof-check.away /var/lib/hof-check');
    }
  });

  test('a wrong argument: nothing runs, the status stays', () => {
    const result = run('hof-check --fix');
    assert.equal(result.status, 3);
    assert.equal(run('test -e /tmp/docker-calls').status, 1);
    assert.equal(run(`test -e ${STATUS}`).status, 1);
  });
});

describe('server: hof-check only reads', () => {
  // The text of the script without comments, with lines joined where they continue.
  const source = readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\s*\\\n\s*/g, ' ');

  function all(pattern: RegExp): string[] {
    return [...source.matchAll(pattern)].map((match) => match[1] ?? match[0]);
  }

  test('Docker: only ps, inspect, info and exec of the probes, through the one helper', () => {
    assert.deepEqual(all(/"\$DOCKER"/g), ['"$DOCKER"']);
    assert.deepEqual([...new Set(all(/run_docker (\w+)/g))].sort(), [
      'exec',
      'info',
      'inspect',
      'ps',
    ]);
    const execs = all(/run_docker exec ([^\n]*)/g);
    assert.equal(execs.length, 3);
    assert.match(execs[0]!, /^"\$\{id\[hof\]\}" bash -c "\$PROBE"/);
    assert.match(execs[1]!, /^"\$\{id\[postgres\]\}" pg_isready /);
    assert.match(execs[2]!, /^-e PGCONNECT_TIMEOUT=5 "\$\{id\[postgres\]\}" psql .* -c 'SELECT 1'/);
  });

  // A container without a healthcheck has no State.Health: Docker 29 fails the whole `inspect` on a
  // direct .State.Health, whatever the Docker of CI does.
  test('the health of a container is read only through index', () => {
    assert.ok(!/\.State\.Health/.test(source));
    assert.equal(all(/index \.State "Health"/g).length, 1);
    assert.ok(source.includes('{{with index .State "Health"}}{{.Status}}{{else}}none{{end}}'));
  });

  // As commands, not as words of a message.
  test('systemctl and journalctl only read', () => {
    assert.deepEqual(all(/(?:^|\$\(|\|)\s*systemctl ([^\n)]*)/gm), [
      'is-active certbot.timer 2>/dev/null',
    ]);
    assert.deepEqual(all(/(?:^|\$\(|\|)\s*journalctl ([^\n|]*)/gm), [
      '_TRANSPORT=kernel --since=-7d --no-pager --quiet --output=cat 2>/dev/null ',
      '--disk-usage 2>/dev/null ',
    ]);
  });

  test('the only files it changes are its temporary status and the status', () => {
    // Writes to files: to the temporary status and to /dev/null. Not redirections: the socket the
    // probe opens with <>, comparisons, and <no value> of Docker.
    const code = source.replace(/\(\([^)]*\)\)/g, '').replace(/\[\[.*?\]\]/g, '');
    const targets = [...code.matchAll(/(?<![<\w])\d?>(?!&)\s*("[^"]*"|[^\s;)]+)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual([...new Set(targets)].sort(), ['"$tmp"', '/dev/null']);
    assert.deepEqual(
      all(/\b(?:mv|rm|chmod|mktemp) [^\n;&]*/g).map((command) => command.trim()),
      [
        'mktemp "${STATUS%/*}/.status.XXXXXX" 2>/dev/null)',
        'chmod 640 "$tmp"',
        'mv -f "$tmp" "$STATUS"',
        'rm -f "$tmp"',
      ],
    );
    // No command that changes something, at the start of a command.
    for (const command of [
      'kill',
      'pkill',
      'truncate',
      'tee',
      'touch',
      'cp',
      'ln',
      'dd',
      'install',
      'mkdir',
      'rmdir',
      'chown',
      'chgrp',
      'sed -i',
      'docker',
    ]) {
      const start = `(^|[;|&(!]|\\b(then|do|else|if)\\b)\\s*${command}\\b`;
      assert.ok(!new RegExp(start, 'm').test(code), command);
    }
    // Nor such a subcommand or option of the commands it runs.
    for (const word of ['prune', 'restart', 'start', 'stop', 'vacuum', 'rotate', 'flush']) {
      assert.ok(!new RegExp(`\\b${word}\\b`).test(code), word);
    }
  });
});

describe('server: the template of docker inspect of hof-check on a real Docker', () => {
  const FORMAT = /run_docker inspect --format \\\n\s*'([^']*)'/.exec(
    readFileSync(SCRIPT, 'utf8'),
  )![1]!;
  const PROJECT = `hof-check-template-${process.pid}`;
  // Real containers of a made-up project: the healthcheck as on the server, or none.
  const CONTAINERS = {
    postgres: ['--health-cmd', 'true', '--health-interval', '1s', '--health-start-period', '0s'],
    hof: ['--no-healthcheck'],
    nginx: ['--no-healthcheck', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3'],
    sick: ['--health-cmd', 'false', '--health-interval', '1s', '--health-retries', '1'],
  };
  const ids: Record<string, string> = {};

  function docker(...args: string[]) {
    return spawnSync('docker', args, { encoding: 'utf8' });
  }

  function inspect(...names: string[]) {
    return docker('inspect', '--format', FORMAT, ...names.map((name) => ids[name] ?? name));
  }

  before(async () => {
    for (const [service, options] of Object.entries(CONTAINERS)) {
      const result = docker(
        'run',
        '-d',
        '--name',
        `${PROJECT}-${service}`,
        '--label',
        `com.docker.compose.project=${PROJECT}`,
        '--label',
        `com.docker.compose.service=${service}`,
        '--label',
        'com.docker.compose.oneoff=False',
        ...options,
        '--entrypoint',
        'sleep',
        'postgres:18.6-trixie',
        'infinity',
      );
      assert.equal(result.status, 0, result.stderr);
      ids[service] = result.stdout.trim();
    }
    // The healthchecks settle within seconds.
    for (let i = 0; i < 60; i++) {
      const health = docker(
        'inspect',
        '--format',
        '{{json .State.Health}}',
        ids.postgres!,
        ids.sick!,
      );
      if (/"Status":"healthy"[\s\S]*"Status":"unhealthy"/.test(health.stdout)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.fail('the healthchecks did not settle');
  });

  after(() => {
    docker('rm', '-fv', ...Object.keys(CONTAINERS).map((service) => `${PROJECT}-${service}`));
  });

  // The columns the script reads: service, ID, state, restarts, OOM, health, start, logs.
  function rows(output: string) {
    return output
      .trim()
      .split('\n')
      .map((line) => line.split('|'))
      .map(([service, id, state, restarts, oom, health, , logType, maxSize, maxFile]) => ({
        service,
        id,
        state,
        restarts,
        oom,
        health,
        logs: `${logType} ${maxSize} ${maxFile}`,
      }));
  }

  for (const [service, health] of [
    ['hof', 'none'],
    ['postgres', 'healthy'],
    ['sick', 'unhealthy'],
  ] as const) {
    test(`one container, ${health}: the call succeeds`, () => {
      const result = inspect(service);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(rows(result.stdout), [
        {
          service,
          id: ids[service],
          state: 'running',
          restarts: '0',
          oom: 'false',
          health,
          logs: 'json-file <no value> <no value>',
        },
      ]);
    });
  }

  test('the set of the server in one call: postgres with a healthcheck, hof and nginx without', () => {
    const result = inspect('postgres', 'hof', 'nginx', 'sick');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      rows(result.stdout).map((row) => `${row.service} ${row.health} ${row.logs}`),
      [
        'postgres healthy json-file <no value> <no value>',
        'hof none json-file <no value> <no value>',
        'nginx none json-file 10m 3',
        'sick unhealthy json-file <no value> <no value>',
      ],
    );
  });

  test('a real error of Docker still fails the call, so the script reports FAIL', () => {
    const result = inspect('postgres', 'hof', `${PROJECT}-missing`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no such object/i);
  });
});
