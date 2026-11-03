// Deployment from GitHub (docs/OPERATIONS.md, section «Развёртывание из GitHub»): the text of
// .github/workflows/deploy.yml, and its scripts taken out of it and run as the runner runs them,
// with stubs of ssh, gh and docker and with git on a repository made here. The scripts also run on
// the stand of CI against the real hof-deploy over SSH (src/deploy-stand.test.ts).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const jobs = Object.fromEntries(
  workflow
    .split(/^jobs:\n/m)[1]!
    .split(/^(?= {2}[\w-]+:$)/m)
    // A comment before the first job is a block of its own.
    .filter((block) => /^ {2}[\w-]+:$/m.test(block))
    .map((block) => [block.match(/^ {2}([\w-]+):$/m)![1]!, block]),
);

// The script of a step, as the runner gets it: the block of `run: |` without its indentation.
function script(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`      - name: ${name}`);
  const run = lines.indexOf('        run: |', start);
  assert.ok(start > 0 && run > start, name);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const RUNS = ['hof-deploy status', 'The image and its new migrations', 'hof-deploy deploy'];
const HEX = (char: string) => char.repeat(64);

describe('deploy.yml: by hand, with approval, without rights', () => {
  test('only workflow_dispatch: no push, pull request, schedule or call starts it', () => {
    assert.match(
      workflow,
      /^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}command:\n[\s\S]*?\n {6}target:\n/m,
    );
    assert.match(workflow, /options: \[status, deploy\]\n {8}default: status\n/);
    const triggers = workflow.split(/^on:\n/m)[1]!.split(/^\S/m)[0]!;
    assert.deepEqual(
      [...triggers.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]),
      ['workflow_dispatch'],
    );
    for (const event of [
      'push',
      'pull_request',
      'pull_request_target',
      'schedule',
      'workflow_run',
      'workflow_call',
      'repository_dispatch',
    ]) {
      assert.ok(!new RegExp(`^\\s*${event}:`, 'm').test(workflow), event);
    }
  });

  test('server, image, production; the environment only for the two jobs that reach the server', () => {
    assert.deepEqual(Object.keys(jobs), ['server', 'image', 'production']);
    assert.match(jobs.server!, /^ {4}environment: production$/m);
    assert.match(jobs.production!, /^ {4}environment: production$/m);
    assert.ok(!/environment/.test(jobs.image!));
    assert.match(
      jobs.image!,
      /^ {4}needs: server\n {4}if: inputs\.command == 'deploy' \|\| inputs\.target != ''$/m,
    );
    assert.match(
      jobs.production!,
      /^ {4}needs: \[server, image\]\n {4}if: inputs\.command == 'deploy'$/m,
    );
    // No status function in the conditions: a failed job before stops the next one.
    assert.ok(!/always\(\)|failure\(\)|cancelled\(\)|continue-on-error/.test(workflow));
  });

  test('secrets: three, in the environment jobs only, in the env of their one step', () => {
    for (const name of ['server', 'production'] as const) {
      const secrets = [...jobs[name]!.matchAll(/\$\{\{ secrets\.(\w+) \}\}/g)].map((m) => m[1]);
      assert.deepEqual(secrets, [
        'HOF_DEPLOY_SSH_KEY',
        'HOF_DEPLOY_KNOWN_HOSTS',
        'HOF_DEPLOY_HOST',
      ]);
      assert.equal(jobs[name]!.match(/^ {6}- /gm)!.length, 1, `${name}: one step`);
      assert.ok(!/uses:/.test(jobs[name]!), `${name}: no actions`);
    }
    assert.ok(!/secrets\./.test(jobs.image!));
    assert.equal(workflow.split('secrets.').length - 1, 6);
  });

  test('rights: read the repository, read CI runs for the image; nothing writes', () => {
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
    assert.match(jobs.server!, /^ {4}permissions: \{\}$/m);
    assert.match(jobs.production!, /^ {4}permissions: \{\}$/m);
    assert.match(jobs.image!, /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n/m);
    assert.ok(!/: write/.test(workflow));
  });

  test('one run at a time, nothing running is cancelled', () => {
    assert.match(
      workflow,
      /^concurrency:\n {2}group: production\n {2}cancel-in-progress: false\n/m,
    );
  });

  test('the scripts get every input through env, and the actions are pinned', () => {
    for (const name of RUNS) assert.ok(!script(name).includes('${{'), name);
    assert.match(workflow, /^defaults:\n {2}run:\n {4}shell: bash\n/m);
    const actions = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]!);
    assert.deepEqual(actions, ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1']);
    assert.ok(!/latest/.test(workflow));
    assert.deepEqual(
      [...new Set([...workflow.matchAll(/ghcr\.io\/\S+/g)].map((match) => match[0]))],
      ['ghcr.io/vrubovoy/hof'],
    );
  });

  test('the server gets status or deploy with the checked digest, nothing else', () => {
    for (const name of ['hof-deploy status', 'hof-deploy deploy']) {
      const calls = [...script(name).matchAll(/^\s*.*\bremote (.*)$/gm)].map((m) => m[1]!.trim());
      const ssh = script(name).match(/remote\(\) \{\n([\s\S]*?)\n\}/)![1]!;
      assert.equal(ssh, script('hof-deploy status').match(/remote\(\) \{\n([\s\S]*?)\n\}/)![1]!);
      assert.match(ssh, /"ssh:\/\/hof-deploy@\$HOST" "\$1"$/);
      const read = /\n(read_status\(\) \{\n[\s\S]*?\n\})/;
      assert.equal(script(name).match(read)![1], script('hof-deploy status').match(read)![1]);
      if (name === 'hof-deploy status') {
        assert.deepEqual(calls, ['status 2>&1 | tee "$out" || code=$?']);
      } else {
        assert.deepEqual(calls, [
          'status > "$out" 2>&1 || code=$?',
          '"deploy $DIGEST" 2>&1 | tee "$out" || code=$?',
        ]);
      }
    }
  });
});

describe('deploy.yml: the steps that reach the server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hof-deploy-workflow-'));
  const stub = join(dir, 'stub');
  const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nstand-in\n-----END OPENSSH PRIVATE KEY-----';
  const KNOWN = '[hof.test]:2222 ssh-ed25519 AAAAstand-in';
  const NOW = `sha256:${HEX('1')}`;
  const NEXT = `sha256:${HEX('2')}`;

  after(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => {
    rmSync(stub, { recursive: true, force: true });
    mkdirSync(join(stub, 'bin'), { recursive: true });
    mkdirSync(join(stub, 'temp'));
    // ssh: the arguments of each call on one line, the files it was given, a canned answer.
    writeFileSync(
      join(stub, 'bin', 'ssh'),
      `#!/bin/bash
echo "$*" >> "$STUB/calls"
while [ "$#" -gt 1 ]; do
  case $1 in
  -i) cp "$2" "$STUB/key" ;;
  UserKnownHostsFile=*) cp "\${1#*=}" "$STUB/known" ;;
  esac
  shift
done
case $1 in
status) name=status ;;
deploy\\ *) name=deploy ;;
*) name=other ;;
esac
cat "$STUB/$name.out" 2> /dev/null
exit "$(cat "$STUB/$name.code" 2> /dev/null || echo 0)"
`,
    );
    chmodSync(join(stub, 'bin', 'ssh'), 0o755);
    answer(
      'status',
      0,
      `Выпуск: ${NOW}\nОбновление: не идёт\npostgres: running, healthy, запущен 2026-11-01T00:00:00Z\n`,
    );
  });

  const GIT = 'Выпуск: образ собран из Git, hof-deploy ещё не запускался\nОбновление: не идёт\n';

  function answer(command: string, code: number, out: string) {
    writeFileSync(join(stub, `${command}.out`), out);
    writeFileSync(join(stub, `${command}.code`), String(code));
  }

  function run(name: string, env: Record<string, string> = {}) {
    const file = join(stub, 'step.sh');
    writeFileSync(file, script(name));
    for (const output of ['output', 'summary']) writeFileSync(join(stub, output), '');
    rmSync(join(stub, 'calls'), { force: true });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      encoding: 'utf8',
      env: {
        PATH: `${join(stub, 'bin')}:${process.env.PATH}`,
        STUB: stub,
        RUNNER_TEMP: join(stub, 'temp'),
        GITHUB_OUTPUT: join(stub, 'output'),
        GITHUB_STEP_SUMMARY: join(stub, 'summary'),
        GITHUB_REF: 'refs/heads/main',
        SSH_KEY: KEY,
        KNOWN_HOSTS: KNOWN,
        HOST: 'hof.test:2222',
        ...env,
      },
    });
    const read = (file: string) =>
      existsSync(join(stub, file)) ? readFileSync(join(stub, file), 'utf8') : '';
    return {
      ...result,
      calls: read('calls').split('\n').filter(Boolean),
      output: read('output'),
      summary: read('summary'),
      left: readdirSync(join(stub, 'temp')),
    };
  }

  const OPTIONS =
    '-F /dev/null -T -i TEMP/hof-deploy.KEY -o IdentitiesOnly=yes -o BatchMode=yes ' +
    '-o StrictHostKeyChecking=yes -o UserKnownHostsFile=TEMP/hof-deploy.KNOWN ' +
    '-o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=30 -o ServerAliveInterval=30 ' +
    '-o ServerAliveCountMax=10 ssh://hof-deploy@hof.test:2222';

  // A call with the temporary files named the same in every run.
  function shape(call: string) {
    return call
      .replaceAll(join(stub, 'temp'), 'TEMP')
      .replace(/(-i TEMP\/hof-deploy\.)\S+/, '$1KEY')
      .replace(/(UserKnownHostsFile=TEMP\/hof-deploy\.)\S+/, '$1KNOWN');
  }

  test('status: the key and host key as given, the release in the output, nothing left', () => {
    const result = run('hof-deploy status');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(shape), [`${OPTIONS} status`]);
    assert.equal(readFileSync(join(stub, 'key'), 'utf8'), `${KEY}\n`);
    assert.equal(readFileSync(join(stub, 'known'), 'utf8'), `${KNOWN}\n`);
    assert.equal(result.output, `current=${NOW}\n`);
    assert.ok(result.summary.includes(`Работает: \`${NOW}\``));
    assert.match(result.stdout, /postgres: running, healthy/);
    assert.deepEqual(result.left, []);
  });

  test('status of a server still built from Git: said so, not guessed', () => {
    answer('status', 0, GIT);
    const result = run('hof-deploy status');
    assert.equal(result.status, 0);
    assert.equal(result.output, 'current=git\n');
    assert.ok(result.summary.includes('- Работает: образ, собранный из Git'));
  });

  test('status while an update runs: shown, not refused', () => {
    answer('status', 0, `Выпуск: ${NOW}\nОбновление: идёт; ход — journalctl -u hof-deploy-run\n`);
    const result = run('hof-deploy status');
    assert.equal(result.status, 0);
    assert.equal(result.output, `current=${NOW}\n`);
    assert.ok(result.summary.includes('- Обновление: идёт'));
  });

  // An answer that is not the one of status: nothing is passed on, the deployment does not start.
  for (const [title, out] of [
    ['empty', ''],
    ['no release', 'Обновление: не идёт\n'],
    ['no line of the update: cut short', `Выпуск: ${NOW}\n`],
    ['an empty release', 'Выпуск: \nОбновление: не идёт\n'],
    ['a short digest', `Выпуск: sha256:${HEX('1').slice(1)}\nОбновление: не идёт\n`],
    ['a cut message of Git', 'Выпуск: образ собран из Git\nОбновление: не идёт\n'],
    ['two releases', `Выпуск: ${NOW}\nВыпуск: ${NEXT}\nОбновление: не идёт\n`],
    ['two lines of the update', `Выпуск: ${NOW}\nОбновление: не идёт\nОбновление: идёт; x\n`],
    ['an unknown state', `Выпуск: ${NOW}\nОбновление: может быть\n`],
  ] as const) {
    test(`an answer of status not recognised: ${title}`, () => {
      answer('status', 0, out);
      const result = run('hof-deploy status');
      assert.equal(result.status, 1);
      assert.match(result.stdout, /::error::Ответ hof-deploy status не распознан/);
      assert.equal(result.output, '');

      const deploying = deploy();
      assert.equal(deploying.status, 1);
      assert.equal(deploying.calls.length, 1, 'no deploy after status');
      assert.match(deploying.summary, /не запускалось: status не выполнен или не распознан/);
    });
  }

  test('SSH fails: the job fails and says so', () => {
    answer('status', 255, 'Host key verification failed.\n');
    const result = run('hof-deploy status');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /status не выполнен, код 255 \(255 — SSH не удался\)/);
    assert.equal(result.output, '');
    assert.deepEqual(result.left, []);
  });

  for (const [title, env] of [
    ['not from main', { GITHUB_REF: 'refs/heads/feature' }],
    ['no key', { SSH_KEY: '' }],
    ['no host key', { KNOWN_HOSTS: '' }],
    ['no address', { HOST: '' }],
    ['an option for an address', { HOST: '-oProxyCommand=id' }],
    ['a command in the address', { HOST: 'hof.test;id' }],
    ['a user in the address', { HOST: 'root@hof.test' }],
  ] as const) {
    test(`refused before SSH: ${title}`, () => {
      for (const name of ['hof-deploy status', 'hof-deploy deploy']) {
        const result = run(name, { DIGEST: NEXT, CURRENT: NOW, ...env });
        assert.equal(result.status, 1, name);
        assert.deepEqual(result.calls, [], name);
      }
    });
  }

  for (const digest of [
    '',
    'latest',
    `sha256:${HEX('2').slice(1)}`,
    `sha256:${HEX('A')}`,
    `sha256:${HEX('2')};id`,
    `sha256:${HEX('2')} status`,
    `sha256:${HEX('2')}\nid`,
  ]) {
    test(`deploy: no SSH without a checked digest: ${JSON.stringify(digest)}`, () => {
      const result = run('hof-deploy deploy', {
        DIGEST: digest,
        CURRENT: NOW,
        SHA: 'a'.repeat(40),
      });
      assert.equal(result.status, 1);
      assert.deepEqual(result.calls, []);
      assert.match(result.stdout, /Нет проверенного digest образа; сервер не затрагивался/);
    });
  }

  const deploy = (env: Record<string, string> = {}) =>
    run('hof-deploy deploy', { DIGEST: NEXT, CURRENT: NOW, SHA: 'b'.repeat(40), ...env });

  test('deploy: status first, then deploy with that digest only; updated', () => {
    answer(
      'deploy',
      0,
      `Новых миграций нет\nитог: обновлено ${NOW} -> ${NEXT}; копия hof-predeploy-x.dump; снимок x; остановка x; готов x\n`,
    );
    const result = deploy();
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.calls.map(shape), [`${OPTIONS} status`, `${OPTIONS} deploy ${NEXT}`]);
    assert.match(result.summary, /- Результат: обновлено\n/);
    assert.ok(result.summary.includes(`- Сервер: итог: обновлено ${NOW} -> ${NEXT};`));
    assert.match(result.stdout, /Новых миграций нет/);
    assert.deepEqual(result.left, []);
  });

  test('deploy: the release changed after the check — nothing runs', () => {
    answer('status', 0, `Выпуск: sha256:${HEX('3')}\nОбновление: не идёт\n`);
    const result = deploy();
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls.map(shape), [`${OPTIONS} status`]);
    assert.match(result.summary, /не запускалось: .*выпуск сменился после проверки/);
  });

  test('deploy: another update runs — nothing runs', () => {
    answer('status', 0, `Выпуск: ${NOW}\nОбновление: идёт; ход — journalctl -u hof-deploy-run\n`);
    const result = deploy();
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 1);
    assert.match(result.summary, /не запускалось: .*идёт другое обновление/);
  });

  test('deploy: status fails — nothing runs', () => {
    answer('status', 255, '');
    const result = deploy();
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 1);
  });

  test('deploy on a server built from Git: the release said so before and now', () => {
    answer('status', 0, GIT);
    answer('deploy', 0, `итог: обновлено образ из Git -> ${NEXT}; копия x\n`);
    const result = deploy({ CURRENT: 'git' });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.calls.length, 2);
    assert.ok(result.summary.includes('- Было: образ, собранный из Git'));

    // A server that says Git now, while a digest was shown before: nothing runs.
    assert.equal(deploy({ CURRENT: NOW }).calls.length, 1);
  });

  for (const [title, code, out, result, next] of [
    [
      'exit 0 without the summary of the update',
      0,
      'Новых миграций нет\n',
      'результат неизвестен: код 0 без итога обновления',
      'ничего не повторять, не откатывать и не восстанавливать',
    ],
    [
      'exit 0 with the summary of another digest',
      0,
      `итог: обновлено ${NOW} -> sha256:${HEX('4')}; копия x\n`,
      'результат неизвестен: код 0 без итога обновления',
      'ничего не повторять, не откатывать и не восстанавливать',
    ],
    [
      'exit 1 without a summary',
      1,
      'Загрузка ghcr.io/vrubovoy/hof@x\n',
      'результат неизвестен: код 1 без итога обновления',
      'дождаться «Обновление: не идёт» и прочитать итог',
    ],
    [
      'a refusal before the stop',
      1,
      'ОТКАЗ: мало места\nитог: отказ, Hof не останавливался, конфигурация не менялась\n',
      'отказ до остановки: Hof не останавливался, конфигурация не менялась',
      'устранить причину из строки ОТКАЗ выше',
    ],
    [
      'a failure after the stop',
      1,
      'СБОЙ: Hof не стал healthy\nСостояние: миграции не применялись\nитог: сбой, Hof остановлен, данные не трогались; копия x\n',
      'сбой после остановки Hof',
      'ничего не повторять',
    ],
    [
      'a stop not confirmed',
      1,
      'СБОЙ: остановка Hof не подтверждена; выпуск не переключён, миграции не запускались\nитог: сбой, нужно ручное вмешательство: x\n',
      'сбой после остановки Hof',
      'ничего не повторять',
    ],
    ['the request refused', 2, '', 'сервер отклонил запрос', 'сервер ничего не менял'],
    [
      'nothing began',
      3,
      'hof-deploy: обновление уже идёт, его ход и итог — hof-deploy status; ничего не менялось\n',
      'обновление не начиналось: занята блокировка, идёт другое обновление или systemd его не запустил',
      'сервер ничего не менял',
    ],
    [
      'SSH breaks off',
      255,
      'Загрузка ghcr.io/vrubovoy/hof@x\n',
      'результат неизвестен: соединение SSH потеряно',
      'на сервере обновление могло начаться и идёт без SSH',
    ],
    [
      'SSH breaks off after the summary',
      255,
      `итог: обновлено ${NOW} -> ${NEXT}; копия x\n`,
      'результат неизвестен: соединение SSH потеряно',
      'ничего не повторять, не откатывать и не восстанавливать',
    ],
  ] as const) {
    test(`deploy: ${title} — the job fails and names the next step`, () => {
      answer('deploy', code, out);
      const run = deploy();
      assert.equal(run.status, 1);
      assert.equal(run.calls.length, 2);
      assert.ok(run.summary.includes(`- Результат: ${result}\n`), run.summary);
      assert.ok(run.summary.includes(next), run.summary);
      assert.ok(!run.summary.includes('Результат: обновлено'));
      assert.ok(run.stdout.includes(`::error::Hof не обновлён: ${result}`));
      assert.deepEqual(run.left, []);
    });
  }
});

describe('deploy.yml: the image of a checked commit of main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hof-deploy-image-'));
  const repo = join(dir, 'repo');
  const stub = join(dir, 'stub');
  const IMAGE = 'ghcr.io/vrubovoy/hof';
  const shas: Record<string, string> = {};

  function git(...args: string[]) {
    const result = spawnSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'stand',
          GIT_AUTHOR_EMAIL: 'stand@hof.test',
          GIT_COMMITTER_NAME: 'stand',
          GIT_COMMITTER_EMAIL: 'stand@hof.test',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  function commit(name: string, files: string[]) {
    for (const file of files) {
      mkdirSync(join(repo, file, '..'), { recursive: true });
      writeFileSync(join(repo, file), `-- ${file}\n`);
    }
    git('add', '.');
    git('commit', '--quiet', '-m', `feat: ${name}`);
    shas[name] = git('rev-parse', 'HEAD');
  }

  // The repository: first with two migrations and the tag m1, then main with a third; a branch
  // beside main has a commit of its own.
  mkdirSync(repo);
  git('init', '--quiet', '--initial-branch=main');
  commit('first', ['src/core/migrations/001_users.sql', 'src/saeckel/migrations/001_pouches.sql']);
  git('tag', 'm1');
  git('switch', '--quiet', '-c', 'side');
  commit('side', ['src/saeckel/migrations/009_side.sql']);
  git('switch', '--quiet', 'main');
  commit('second', ['src/saeckel/migrations/002_operations.sql', 'src/core/notes.ts']);

  after(() => rmSync(dir, { recursive: true, force: true }));

  // The CI run of a commit and its jobs, as GitHub gives them.
  function ci(sha: string, jobs: Record<string, string> | null) {
    const runs = jobs ? [{ id: 77, head_sha: sha, conclusion: 'success' }] : [];
    writeFileSync(
      join(stub, 'runs.json'),
      JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
    );
    writeFileSync(
      join(stub, 'jobs.json'),
      JSON.stringify({
        jobs: Object.entries(jobs ?? {}).map(([name, conclusion]) => ({ name, conclusion })),
      }),
    );
  }
  const PASSED = { check: 'success', 'deploy-stand': 'success', publish: 'success' };

  // An image in the registry: its digest and its label of the commit.
  function image(ref: string, digest: string, revision: string) {
    writeFileSync(join(stub, 'images', ref.replace(/[/:@]/g, '_')), `${digest}\n${revision}\n`);
  }

  beforeEach(() => {
    rmSync(stub, { recursive: true, force: true });
    mkdirSync(join(stub, 'bin'), { recursive: true });
    mkdirSync(join(stub, 'images'));
    // gh api URL --jq FILTER: the canned answer of that address through jq.
    writeFileSync(
      join(stub, 'bin', 'gh'),
      `#!/bin/bash
echo "$*" >> "$STUB/gh-calls"
[ "$1" = api ] && [ "$3" = --jq ] || exit 2
case $2 in
repos/vrubovoy/hof/actions/workflows/ci.yml/runs\\?*) file=runs ;;
repos/vrubovoy/hof/actions/runs/77/jobs) file=jobs ;;
*) exit 1 ;;
esac
jq -r "$4" < "$STUB/$file.json"
`,
    );
    // docker pull REF and docker image inspect --format FORMAT REF, from the canned images.
    writeFileSync(
      join(stub, 'bin', 'docker'),
      `#!/bin/bash
echo "$*" >> "$STUB/docker-calls"
ref=\${@: -1}
file=$STUB/images/$(printf '%s' "$ref" | tr '/:@' '___')
[ -f "$file" ] || exit 1
case "$1 $2" in
'pull --quiet') echo "$ref" ;;
'image inspect')
  case $4 in
  *RepoDigests*) sed -n 1p "$file" ;;
  *revision*) sed -n 2p "$file" ;;
  *) exit 2 ;;
  esac
  ;;
*) exit 2 ;;
esac
`,
    );
    for (const tool of ['gh', 'docker']) chmodSync(join(stub, 'bin', tool), 0o755);
    ci(shas.second!, PASSED);
    image(`${IMAGE}:sha-${shas.second}`, `${IMAGE}@sha256:${HEX('2')}`, shas.second!);
    image(`${IMAGE}:sha-${shas.first}`, `${IMAGE}@sha256:${HEX('1')}`, shas.first!);
    image(`${IMAGE}@sha256:${HEX('1')}`, `${IMAGE}@sha256:${HEX('1')}`, shas.first!);
    image(`${IMAGE}@sha256:${HEX('2')}`, `${IMAGE}@sha256:${HEX('2')}`, shas.second!);
  });

  function run(target: string, env: Record<string, string> = {}) {
    const file = join(stub, 'step.sh');
    writeFileSync(file, script('The image and its new migrations'));
    for (const output of ['output', 'summary']) writeFileSync(join(stub, output), '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: `${join(stub, 'bin')}:${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: '/dev/null',
        STUB: stub,
        GITHUB_OUTPUT: join(stub, 'output'),
        GITHUB_STEP_SUMMARY: join(stub, 'summary'),
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: shas.second!,
        REPOSITORY: 'vrubovoy/hof',
        GH_TOKEN: 'stand-in',
        IMAGE,
        TARGET: target,
        CURRENT: `sha256:${HEX('1')}`,
        ...env,
      },
    });
    const read = (file: string) =>
      existsSync(join(stub, file)) ? readFileSync(join(stub, file), 'utf8') : '';
    return {
      ...result,
      output: read('output'),
      summary: read('summary'),
      gh: read('gh-calls'),
      docker: read('docker-calls'),
    };
  }

  test('a commit of main checked and published: its digest, its new migrations', () => {
    const result = run(shas.second!);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.output, `sha=${shas.second}\ndigest=sha256:${HEX('2')}\n`);
    assert.equal(
      result.gh,
      `api repos/vrubovoy/hof/actions/workflows/ci.yml/runs?head_sha=${shas.second}&event=push&branch=main&status=success&per_page=1 --jq .workflow_runs[0].id // empty\n` +
        'api repos/vrubovoy/hof/actions/runs/77/jobs --jq .jobs[] | "\\(.name) \\(.conclusion)"\n',
    );
    assert.ok(result.summary.includes('https://github.com/vrubovoy/hof/actions/runs/77'));
    assert.ok(result.summary.includes(`- Образ: \`${IMAGE}@sha256:${HEX('2')}\``));
    assert.ok(result.summary.includes('«feat: second»'));
    assert.ok(
      result.summary.includes(
        '- Новые миграции: saeckel/002_operations.sql — после них прежний digest не запустится',
      ),
      result.summary,
    );
  });

  test('a tag: the commit it names; the same migrations as the release that runs', () => {
    ci(shas.first!, PASSED);
    const result = run('m1');
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.output, `sha=${shas.first}\ndigest=sha256:${HEX('1')}\n`);
    assert.ok(result.summary.includes('- Новые миграции: нет: прежний digest можно вернуть'));
  });

  test('back to a release without a migration that runs: hof-deploy will refuse', () => {
    ci(shas.first!, PASSED);
    const result = run(shas.first!, { CURRENT: `sha256:${HEX('2')}` });
    assert.equal(result.status, 0);
    assert.ok(
      result.summary.includes(
        'в работающем выпуске есть миграции, которых нет в образе: saeckel/002_operations.sql — hof-deploy откажет',
      ),
    );
  });

  test('a server built from Git, or a running image outside main: the migrations are left to hof-deploy', () => {
    let result = run(shas.second!, { CURRENT: 'git' });
    assert.equal(result.status, 0);
    assert.ok(result.summary.includes('не определены: на сервере образ, собранный из Git'));

    image(`${IMAGE}@sha256:${HEX('9')}`, `${IMAGE}@sha256:${HEX('9')}`, shas.side!);
    result = run(shas.second!, { CURRENT: `sha256:${HEX('9')}` });
    assert.equal(result.status, 0);
    assert.ok(result.summary.includes('не определены: коммит работающего образа не найден в main'));
  });

  test('refused: no answer of status from the job server', () => {
    const result = run(shas.second!, { CURRENT: '' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /работающий выпуск неизвестен/);
  });

  for (const target of ['', '$(id)', 'm1;id', 'm1 m2', '-m1', '../m1', 'refs/tags/m1', 'm1\nid']) {
    test(`refused before GitHub and the registry: ${JSON.stringify(target)}`, () => {
      const result = run(target);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /^::error::цель — полный SHA коммита/m);
      assert.equal(result.gh + result.docker, '');
      assert.equal(result.output, '');
    });
  }

  for (const [title, target, message] of [
    [
      'a commit not in the repository',
      'c'.repeat(40),
      `коммита ${'c'.repeat(40)} нет в репозитории`,
    ],
    ['a tag not in the repository', 'm9', 'тега m9 нет в репозитории'],
    ['a branch name', 'side', 'тега side нет в репозитории'],
    // Anything but a full SHA is looked for as a tag only.
    ['a short SHA', 'abc1234', 'тега abc1234 нет в репозитории'],
    ['a SHA in capitals', 'A'.repeat(40), `тега ${'A'.repeat(40)} нет в репозитории`],
    ['a SHA one short', 'a'.repeat(39), `тега ${'a'.repeat(39)} нет в репозитории`],
    ['a commit beside main', 'SIDE', 'не входит в main'],
  ] as const) {
    test(`refused: ${title}`, () => {
      const result = run(target === 'SIDE' ? shas.side! : target);
      assert.equal(result.status, 1);
      assert.ok(result.stdout.includes(message), result.stdout);
      assert.equal(result.gh + result.docker, '');
    });
  }

  test('refused: started from another branch', () => {
    const result = run(shas.second!, { GITHUB_REF: 'refs/heads/side' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /развёртывание запускается только из main/);
    assert.equal(result.gh + result.docker, '');
  });

  for (const [title, jobs, message] of [
    ['no successful CI run of a push to main', null, 'нет успешного запуска CI на push в main'],
    [
      'the stand did not pass',
      { check: 'success', 'deploy-stand': 'failure', publish: 'success' },
      'нет успешного задания deploy-stand',
    ],
    [
      'the image was not published',
      { check: 'success', 'deploy-stand': 'success', publish: 'skipped' },
      'нет успешного задания publish',
    ],
    [
      'a run before the stand',
      { check: 'success', publish: 'success' },
      'нет успешного задания deploy-stand',
    ],
  ] as const) {
    test(`refused: ${title}`, () => {
      ci(shas.second!, jobs);
      const result = run(shas.second!);
      assert.equal(result.status, 1);
      assert.ok(result.stdout.includes(message), result.stdout);
      assert.equal(result.docker, '');
      assert.equal(result.output, '');
    });
  }

  test('refused: GitHub does not answer', () => {
    rmSync(join(stub, 'runs.json'));
    const result = run(shas.second!);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /GitHub API не ответил/);
  });

  test('refused: no image of the commit in the registry', () => {
    rmSync(join(stub, 'images', `${IMAGE}:sha-${shas.second}`.replace(/[/:@]/g, '_')));
    const result = run(shas.second!);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes(`образа ${IMAGE}:sha-${shas.second} нет в реестре`));
    assert.equal(result.output, '');
  });

  test('refused: the label names another commit', () => {
    image(`${IMAGE}:sha-${shas.second}`, `${IMAGE}@sha256:${HEX('2')}`, shas.first!);
    const result = run(shas.second!);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /метка revision образа .* — не коммит/);
    assert.equal(result.output, '');
  });

  test('refused: no digest in the repository of the image', () => {
    image(`${IMAGE}:sha-${shas.second}`, `example.org/other@sha256:${HEX('2')}`, shas.second!);
    const result = run(shas.second!);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /нет digest в ghcr\.io\/vrubovoy\/hof/);
    assert.equal(result.output, '');
  });
});
