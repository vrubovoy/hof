// The update command on a stand (docs/OPERATIONS.md, section «Обновление»). It runs only in CI
// (HOF_DEPLOY_STAND=1): it needs root, /opt/hof, ports 80 and 443 and an SSH server of its own.
//
// The stand is a server as it is before the first update: compose.yaml and deploy/ as plain files in
// /opt/hof, COMPOSE_FILE with the memory limits in .env, the stack of project hof with nginx and a
// self-signed certificate, the real hof-backup, made-up records, and containers of another project.
// The images of the releases go to a local registry: the image of this repository and images made
// from it that fail at start, apply a part of two migrations, fix the second one or change the
// service postgres.

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const REGISTRY = 'localhost:5000/hof';
const STAND = process.env.HOF_DEPLOY_STAND === '1';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

// A command as root.
function sh(script: string): Result {
  return spawnSync('sudo', ['bash', '-c', script], { cwd: ROOT, encoding: 'utf8' });
}

function ok(script: string): string {
  const result = sh(script);
  assert.equal(result.status, 0, `${script}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function deploy(digest: string): Result {
  const result = sh(`/usr/local/sbin/hof-deploy deploy ${digest}`);
  console.log(result.stdout + result.stderr);
  return result;
}

function psql(sql: string): string {
  return ok(`docker exec hof-postgres-1 psql --username=postgres --dbname=hof -qAt -c "${sql}"`);
}

// ID and start time of a container.
function identity(name: string): string {
  return ok(`docker inspect --format '{{.Id}} {{.State.StartedAt}}' ${name}`);
}

function release(): string {
  return sh('readlink /opt/hof/release').stdout.trim();
}

function copies(): string {
  return ok('ls /var/backups/hof | grep "^hof-predeploy-.*\\.dump$" || true');
}

describe('hof-deploy on the stand', { skip: !STAND && 'only on the stand of CI' }, () => {
  const digests: Record<string, string> = {};
  let postgres = '';
  let neighbours = '';

  // A release made from the image of the repository: a Dockerfile and its files.
  function variant(name: string, dockerfile: string, files: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), `hof-stand-${name}-`));
    writeFileSync(join(dir, 'Dockerfile'), dockerfile);
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    publish(name, dir);
  }

  function publish(name: string, context: string, args: string[] = []) {
    ok(`docker build --quiet ${args.join(' ')} --tag ${REGISTRY}:${name} ${context} > /dev/null
        docker push --quiet ${REGISTRY}:${name} > /dev/null`);
    digests[name] = ok(
      `docker inspect --format '{{index .RepoDigests 0}}' ${REGISTRY}:${name}`,
    ).split('@')[1]!;
  }

  before(() => {
    ok(`docker run -d --name hof-stand-registry -p 127.0.0.1:5000:5000 registry:2.8.3 > /dev/null
        for i in $(seq 1 30); do curl -fs http://127.0.0.1:5000/v2/ > /dev/null && exit 0; sleep 1; done
        exit 1`);

    publish('base', ROOT, ['--build-arg', 'HOF_REVISION=stand-base']);
    const from = `FROM ${REGISTRY}:base\n`;
    variant('next', `${from}LABEL hof.stand=next\n`);
    variant('broken', `${from}CMD ["node", "-e", "process.exit(1)"]\n`);
    const third = 'CREATE TABLE stand_third (id integer PRIMARY KEY);\n';
    variant('partial', `${from}COPY 003_stand.sql 004_stand.sql /app/src/saeckel/migrations/\n`, {
      '003_stand.sql': third,
      '004_stand.sql': 'CREATE TABLE stand_fourth (id integer);\nSELECT 1 / 0;\n',
    });
    variant('fixed', `${from}COPY 003_stand.sql 004_stand.sql /app/src/saeckel/migrations/\n`, {
      '003_stand.sql': third,
      '004_stand.sql': 'CREATE TABLE stand_fourth (id integer);\n',
    });
    variant('later', `FROM ${REGISTRY}:fixed\nLABEL hof.stand=later\n`);
    // A release whose PostgreSQL would be recreated: its healthcheck is checked every 3 s.
    const compose = ok('cat compose.yaml').replace('      interval: 2s\n', '      interval: 3s\n');
    assert.ok(compose.includes('interval: 3s'));
    variant('postgres', `${from}COPY compose.yaml /app/release/compose.yaml\n`, {
      'compose.yaml': `${compose}\n`,
    });

    // The server before the first update, with a certificate the system trusts.
    ok(`set -e
        mkdir -p /opt/hof /etc/letsencrypt/live/hof.test /etc/letsencrypt/archive/hof.test /etc/hof-deploy
        cp compose.yaml /opt/hof/ && cp -r deploy /opt/hof/
        cd /opt/hof
        {
          for name in POSTGRES_PASSWORD HOF_CORE_DB_PASSWORD HOF_SAECKEL_DB_PASSWORD; do
            echo "$name=$(openssl rand -hex 24)"
          done
          echo CURRENCY=RUB
          echo TZ=Europe/Moscow
          echo HOF_DOMAIN=hof.test
          echo COMPOSE_FILE=compose.yaml:deploy/compose.limits.yaml:release.yaml
        } > .env
        chmod 600 .env
        openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=hof.test \
          -addext subjectAltName=DNS:hof.test 2> /dev/null \
          -keyout /etc/letsencrypt/live/hof.test/privkey.pem -out /etc/letsencrypt/live/hof.test/fullchain.pem
        cp /etc/letsencrypt/live/hof.test/fullchain.pem /usr/local/share/ca-certificates/hof-stand.crt
        update-ca-certificates > /dev/null
        printf 'services:\\n  hof:\\n    image: ${REGISTRY}@${digests.base}\\n    build: !reset null\\n' > /tmp/stand-start.yaml
        docker compose -f compose.yaml -f deploy/compose.limits.yaml -f /tmp/stand-start.yaml up -d --wait --wait-timeout 180

        groupadd --system hof-backup
        install -d -m 2750 -g hof-backup /var/backups/hof
        install -m 755 ${ROOT}/deploy/hof-backup.sh /usr/local/sbin/hof-backup
        install -m 755 ${ROOT}/deploy/hof-deploy.sh /usr/local/sbin/hof-deploy
        install -m 755 ${ROOT}/deploy/hof-deploy-ssh.sh /usr/local/sbin/hof-deploy-ssh
        echo ${REGISTRY} > /etc/hof-deploy/image

        docker run -d --name hof-stand-other --label com.docker.compose.project=other \
          --label com.docker.compose.service=postgres registry:2.8.3 > /dev/null`);
    psql(
      "INSERT INTO core.users (username, password_hash, is_admin) VALUES ('stand-owner', 'fake-hash', true); " +
        "INSERT INTO saeckel.pouches (user_id, name) VALUES (1, 'Еда'); " +
        "INSERT INTO saeckel.operations (user_id, kind, amount, currency, date, note) SELECT 1, 'income', n, 'RUB', '2026-11-01', 'seed' FROM generate_series(1, 500) n",
    );
    postgres = identity('hof-postgres-1');
    neighbours = `${identity('hof-stand-registry')}\n${identity('hof-stand-other')}`;
  });

  after(() => {
    sh('pkill -f stand-writer; pkill -f "sshd -f /etc/hof-stand-sshd"');
  });

  // What must never change: PostgreSQL with its volume, the containers of others.
  function untouched() {
    assert.equal(identity('hof-postgres-1'), postgres);
    assert.equal(
      ok(
        `docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}' hof-postgres-1`,
      ),
      'hof_pgdata',
    );
    assert.equal(`${identity('hof-stand-registry')}\n${identity('hof-stand-other')}`, neighbours);
  }

  test('a digest the registry does not have: refused, nothing changed', () => {
    const hof = identity('hof-hof-1');
    const result = deploy(`sha256:${'0'.repeat(64)}`);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ОТКАЗ: образ .* не загружен/);
    assert.equal(identity('hof-hof-1'), hof);
    assert.equal(release(), '');
    assert.equal(copies(), '');
    untouched();
  });

  test('the lock is taken: after 60 s a clear message, nothing done', () => {
    const holder = spawn('sudo', [
      'bash',
      '-c',
      'exec 9>>/run/lock/hof-ops.lock; flock 9; echo "hof-backup nightly, pid 42" > /run/lock/hof-ops.lock; sleep 75',
    ]);
    spawnSync('sleep', ['1']);
    const hof = identity('hof-hof-1');
    const log = sh('wc -l < /var/log/hof-deploy.log').stdout;
    const started = Date.now();
    const result = deploy(digests.next!);
    holder.kill();
    sh('pkill -f "sleep 75"');
    assert.equal(result.status, 3);
    assert.ok(Date.now() - started >= 59_000);
    assert.match(
      result.stderr,
      /блокировка занята дольше 60 с .*hof-backup nightly, pid 42.*ничего не менялось/,
    );
    assert.equal(sh('wc -l < /var/log/hof-deploy.log').stdout, log);
    assert.equal(identity('hof-hof-1'), hof);
    assert.equal(release(), '');
  });

  test('an update under writes: every confirmed record stays, PostgreSQL and others untouched', async () => {
    const nginx = identity('hof-nginx-1');
    const writer: ChildProcess = spawn('sudo', [
      'bash',
      '-c',
      `# stand-writer
       rm -f /tmp/stand-writes /tmp/stand-stop
       n=0
       until [ -f /tmp/stand-stop ]; do
         n=$((n + 1))
         id=$(docker exec hof-postgres-1 psql --username=postgres --dbname=hof -qAt -c \\
           "INSERT INTO saeckel.operations (user_id, kind, amount, currency, date, note) VALUES (1, 'income', $n, 'RUB', '2026-11-02', 'writer') RETURNING id") &&
           echo "$(date -u +%Y%m%dT%H%M%SZ) $id" >> /tmp/stand-writes
         sleep 0.2
       done`,
    ]);
    const done = new Promise((resolve) => writer.on('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const result = deploy(digests.next!);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    sh('touch /tmp/stand-stop');
    await done;

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes(`итог: обновлено образ из Git -> ${digests.next}`));
    const snapshot = /снимок (\d{8}T\d{6}Z)/.exec(result.stdout)![1]!;
    // The downtime: from the stop of Hof until it is healthy and answers through nginx.
    const [, stopped, ready] = /остановка (\S+); готов (\S+)/.exec(result.stdout)!;
    const downtime = (Date.parse(ready!) - Date.parse(stopped!)) / 1000;
    console.log(`downtime: ${downtime} s`);
    assert.ok(downtime < 60, `downtime ${downtime} s`);
    const writes = ok('cat /tmp/stand-writes').split('\n');
    const ids = writes.map((line) => line.split(' ')[1]);
    assert.ok(
      writes.filter((line) => line.split(' ')[0]! > snapshot).length > 0,
      'no writes after the snapshot',
    );
    assert.equal(
      psql(
        `SELECT count(*) FROM saeckel.operations WHERE note = 'writer' AND id IN (${ids.join(',')})`,
      ),
      String(ids.length),
    );
    assert.equal(psql("SELECT count(*) FROM saeckel.operations WHERE note = 'seed'"), '500');

    untouched();
    assert.notEqual(identity('hof-nginx-1'), nginx);
    assert.equal(
      ok("docker inspect --format '{{.Config.Image}} {{.State.Health.Status}}' hof-hof-1"),
      `${REGISTRY}@${digests.next} healthy`,
    );
    assert.equal(ok('curl -fsS --resolve hof.test:443:127.0.0.1 https://hof.test/healthz'), 'ok');
    assert.equal(
      ok('cd /opt/hof && readlink compose.yaml deploy release.yaml && ls releases/git'),
      'release/compose.yaml\nrelease/deploy\nrelease/release.yaml\ncompose.yaml\ndeploy',
    );
    assert.match(release(), new RegExp(`^releases/\\d{8}T\\d{6}Z-${digests.next!.slice(7, 19)}$`));
    assert.equal(copies().split('\n').length, 1);
    // Commands by hand in /opt/hof see the release.
    assert.match(
      ok('cd /opt/hof && docker compose ps --format "{{.Service}} {{.Image}}" hof'),
      new RegExp(`hof ${REGISTRY}@`),
    );
    const status = ok('/usr/local/sbin/hof-deploy status');
    assert.ok(status.includes(`Выпуск: ${digests.next}`), status);
    assert.match(status, /hof: running, healthy/);
  });

  test('a new image fails at start, no migrations: Hof stopped, the previous digest brings it back', () => {
    const before = psql('SELECT count(*) FROM saeckel.operations');
    const result = deploy(digests.broken!);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Состояние: миграции не применялись/);
    assert.ok(result.stdout.includes(`hof-deploy deploy ${digests.next}`));
    assert.equal(ok("docker inspect --format '{{.State.Status}}' hof-hof-1"), 'exited');
    assert.equal(psql('SELECT count(*) FROM saeckel.operations'), before);
    untouched();

    assert.equal(deploy(digests.next!).status, 0);
    assert.equal(ok("docker inspect --format '{{.State.Health.Status}}' hof-hof-1"), 'healthy');
    untouched();
  });

  test('a part of two migrations: Hof stopped, the old digest refused, the fixed image finishes', () => {
    const before = psql('SELECT count(*) FROM saeckel.operations');
    let result = deploy(digests.partial!);
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /Состояние: набор применён частично; применены saeckel\/003_stand\.sql, не применены saeckel\/004_stand\.sql, ошибка: migration 004_stand\.sql failed/,
    );
    assert.equal(ok("docker inspect --format '{{.State.Status}}' hof-hof-1"), 'exited');
    assert.equal(
      psql(
        "SELECT to_regclass('saeckel.stand_third') IS NOT NULL, to_regclass('saeckel.stand_fourth') IS NULL",
      ),
      't|t',
    );
    const switched = release();

    result = deploy(digests.next!);
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /ОТКАЗ: в базе есть миграции, которых нет в образе: saeckel\/003_stand\.sql/,
    );
    assert.equal(release(), switched);
    assert.equal(ok("docker inspect --format '{{.State.Status}}' hof-hof-1"), 'exited');

    result = deploy(digests.fixed!);
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /Миграции применены: saeckel\/003_stand\.sql saeckel\/004_stand\.sql|Новые миграции: saeckel\/004_stand\.sql/,
    );
    assert.equal(psql("SELECT to_regclass('saeckel.stand_fourth') IS NOT NULL"), 't');
    assert.equal(psql('SELECT count(*) FROM saeckel.operations'), before);
    untouched();
  });

  test('a release that changes postgres: refused before any downtime', () => {
    const hof = identity('hof-hof-1');
    const current = release();
    const made = copies();
    const result = deploy(digests.postgres!);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ОТКАЗ: выпуск меняет сервис postgres/);
    assert.equal(identity('hof-hof-1'), hof);
    assert.equal(release(), current);
    assert.equal(copies(), made);
    untouched();
  });

  test('the copy fails: Hof keeps running, the configuration stays', () => {
    const hof = identity('hof-hof-1');
    const current = release();
    ok('mv /var/backups/hof /var/backups/hof.away');
    try {
      const result = deploy(digests.later!);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /ОТКАЗ: предрелизная копия не создана/);
      assert.match(result.stdout, /итог: отказ, Hof не останавливался, конфигурация не менялась/);
    } finally {
      ok('mv /var/backups/hof.away /var/backups/hof');
    }
    assert.equal(identity('hof-hof-1'), hof);
    assert.equal(release(), current);
    assert.equal(ok("docker inspect --format '{{.State.Health.Status}}' hof-hof-1"), 'healthy');
    untouched();
  });

  test('SSH: the key runs status and deploy only, sudo allows nothing else', () => {
    ok(`set -e
        useradd --system --home-dir /var/lib/hof-deploy --no-create-home --shell /bin/sh hof-deploy
        usermod --password '*' hof-deploy
        install -d -m 755 /var/lib/hof-deploy /var/lib/hof-deploy/.ssh
        ssh-keygen -q -t ed25519 -N '' -f /tmp/stand-key && chown "$SUDO_USER" /tmp/stand-key && chmod 600 /tmp/stand-key
        printf 'restrict,command="/usr/local/sbin/hof-deploy-ssh" %s\\n' "$(cat /tmp/stand-key.pub)" > /var/lib/hof-deploy/.ssh/authorized_keys
        chmod 644 /var/lib/hof-deploy/.ssh/authorized_keys
        cp ${ROOT}/deploy/hof-deploy.sudoers /etc/sudoers.d/hof-deploy
        chmod 440 /etc/sudoers.d/hof-deploy
        visudo -cf /etc/sudoers.d/hof-deploy > /dev/null
        ssh-keygen -q -t ed25519 -N '' -f /etc/hof-stand-host-key
        printf 'Port 2222\\nListenAddress 127.0.0.1\\nHostKey /etc/hof-stand-host-key\\nPasswordAuthentication no\\nPidFile /run/hof-stand-sshd.pid\\n' > /etc/hof-stand-sshd
        mkdir -p /run/sshd
        /usr/sbin/sshd -f /etc/hof-stand-sshd`);
    const ssh = (args: string[]) =>
      spawnSync(
        'ssh',
        [
          '-p',
          '2222',
          '-i',
          '/tmp/stand-key',
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          ...args,
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );
    const as = (script: string) => sh(`sudo -u hof-deploy bash -c '${script}'`);

    assert.match(ssh(['hof-deploy@127.0.0.1', 'status']).stdout, /^Выпуск: sha256:/);
    for (const request of [
      'id',
      'bash -i',
      'status; id',
      `deploy sha256:${'a'.repeat(63)}`,
      'deploy latest',
    ]) {
      const result = ssh(['hof-deploy@127.0.0.1', request]);
      assert.equal(result.status, 2, request);
      assert.ok(!/uid=/.test(result.stdout), request);
    }
    // No terminal, no copy of files, no forwarding.
    assert.notEqual(ssh(['-tt', 'hof-deploy@127.0.0.1']).status, 0);
    assert.notEqual(
      spawnSync(
        'scp',
        [
          '-P',
          '2222',
          '-i',
          '/tmp/stand-key',
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '/etc/hostname',
          'hof-deploy@127.0.0.1:/tmp/x',
        ],
        { encoding: 'utf8' },
      ).status,
      0,
    );
    assert.notEqual(
      ssh([
        '-o',
        'ExitOnForwardFailure=yes',
        '-N',
        '-R',
        '15000:127.0.0.1:5000',
        'hof-deploy@127.0.0.1',
      ]).status,
      0,
    );
    const local = spawn('ssh', [
      '-p',
      '2222',
      '-i',
      '/tmp/stand-key',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-N',
      '-L',
      '15001:127.0.0.1:5000',
      'hof-deploy@127.0.0.1',
    ]);
    spawnSync('sleep', ['2']);
    const through = spawnSync('curl', ['-fsS', '--max-time', '3', 'http://127.0.0.1:15001/v2/'], {
      encoding: 'utf8',
    });
    local.kill();
    assert.notEqual(through.status, 0, 'a forwarded port reached the registry');
    assert.equal(sh('test -e /tmp/x').status, 1);

    // sudo: the script with these arguments only; the user is not in the docker group.
    assert.equal(as('sudo -n /usr/local/sbin/hof-deploy status > /dev/null').status, 0);
    for (const command of [
      `/usr/local/sbin/hof-deploy deploy sha256:${'a'.repeat(63)}`,
      `/usr/local/sbin/hof-deploy deploy sha256:${'a'.repeat(64)} x`,
      '/usr/local/sbin/hof-deploy status x',
      '/bin/bash',
      '/usr/bin/docker ps',
    ]) {
      assert.notEqual(as(`sudo -n ${command}`).status, 0, command);
    }
    assert.notEqual(as('docker ps').status, 0);

    // A whole update through the key.
    const result = ssh(['hof-deploy@127.0.0.1', `deploy ${digests.later}`]);
    console.log(result.stdout + result.stderr);
    assert.equal(result.status, 0);
    assert.equal(
      ok("docker inspect --format '{{.Config.Image}}' hof-hof-1"),
      `${REGISTRY}@${digests.later}`,
    );
    untouched();
  });
});
