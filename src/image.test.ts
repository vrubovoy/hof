// The image of Hof (docs/OPERATIONS.md, section «Образ в реестре»): what goes into it, the release
// configuration in /app/release and the labels, and the workflow that publishes it. The image is
// built from this working tree under a name of its own and removed at the end; nothing is
// published. That it starts and becomes healthy is checked in CI, on the very image published.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const IMAGE = `hof-image-test-${process.pid}`;
const CONTAINER = `hof-image-test-${process.pid}-release`;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

// Every file under a folder, as paths relative to it.
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

describe('the image of Hof', () => {
  const revision = run('git', ['rev-parse', 'HEAD']).trim();

  before(() => {
    run('docker', [
      'build',
      '--quiet',
      '--tag',
      IMAGE,
      '--build-arg',
      `HOF_REVISION=${revision}`,
      '.',
    ]);
  });

  after(() => {
    spawnSync('docker', ['rm', '--force', CONTAINER]);
    spawnSync('docker', ['image', 'rm', '--force', IMAGE]);
  });

  test('the labels name the repository and the commit', () => {
    const labels = JSON.parse(
      run('docker', ['inspect', '--format', '{{json .Config.Labels}}', IMAGE]),
    ) as Record<string, string>;
    assert.equal(labels['org.opencontainers.image.source'], 'https://github.com/vrubovoy/hof');
    assert.equal(labels['org.opencontainers.image.revision'], revision);
  });

  test('/app/release: compose.yaml and deploy/ of the commit, taken out without starting it', () => {
    run('docker', ['create', '--name', CONTAINER, IMAGE]);
    const dir = mkdtempSync(join(tmpdir(), 'hof-release-'));
    try {
      run('docker', ['cp', `${CONTAINER}:/app/release`, dir]);
      assert.equal(
        run('docker', ['inspect', '--format', '{{.State.Status}} {{.State.StartedAt}}', CONTAINER]),
        'created 0001-01-01T00:00:00Z\n',
      );

      // The files Git tracks, with their modes: 100755 or 100644.
      const tracked = new Map(
        run('git', ['ls-files', '--stage', 'compose.yaml', 'deploy'])
          .trim()
          .split('\n')
          .map((line) => {
            const [info, path] = line.split('\t');
            return [path!, info!.split(' ')[0]!.slice(3)];
          }),
      );
      const release = join(dir, 'release');
      assert.deepEqual(files(release), [...tracked.keys()].sort());
      for (const [path, mode] of tracked) {
        const file = join(release, path);
        assert.ok(readFileSync(file).equals(readFileSync(join(ROOT, path))), path);
        assert.equal((statSync(file).mode & 0o777).toString(8), mode, path);
      }
      assert.equal(tracked.get('deploy/postgres-init.sh'), '755');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      spawnSync('docker', ['rm', '--force', CONTAINER]);
    }
  });

  test('no secrets and nothing of development: only the code, its dependencies and the release', () => {
    const dev = Object.keys(
      (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { devDependencies: object })
        .devDependencies,
    );
    // A shell of the image, not Hof: the top of /app, every path outside node_modules, and the
    // dependencies of development that are there.
    const listing = run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      `cd /app && ls -A && echo -- && find . -path ./node_modules -prune -o -print && echo --
       for name in ${dev.join(' ')}; do if [ -e "node_modules/$name" ]; then echo "$name"; fi; done`,
    ]);
    const [top, paths, present] = listing.split('--\n').map((part) => part.trim());
    assert.deepEqual(top!.split('\n'), [
      'node_modules',
      'package-lock.json',
      'package.json',
      'release',
      'src',
    ]);
    for (const path of paths!.split('\n')) {
      assert.ok(
        !/\.test\.ts$|(^|\/)\.env|(^|\/)(design|\.git|\.github|_reserve|_discard)(\/|$)/.test(path),
        path,
      );
    }
    assert.ok(paths!.includes('./release/deploy/postgres-init.sh'));
    assert.equal(present, '');
  });
});

describe('the workflow publishes only from main', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobs = Object.fromEntries(
    workflow
      .split(/^jobs:\n/m)[1]!
      .split(/^(?= {2}[\w-]+:$)/m)
      .map((block) => [block.match(/^ {2}([\w-]+):/)![1]!, block]),
  );
  const fromMain = "if: github.event_name == 'push' && github.ref == 'refs/heads/main'";

  test('pull requests run the checks; a push to main after them publishes', () => {
    assert.match(workflow, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n/m);
    assert.deepEqual(Object.keys(jobs), ['check', 'publish']);
    assert.match(jobs.publish!, /^ {4}needs: check$/m);
    assert.ok(jobs.publish!.includes(`    ${fromMain}\n`));
    // The image goes to the publish job only from a push to main.
    assert.equal(jobs.check!.split(fromMain).length - 1, 2);
    assert.ok(/name: hof-image/.test(jobs.check!) && /name: hof-image/.test(jobs.publish!));
  });

  test('packages: write in the publish job only, every other job reads the repository', () => {
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
    assert.equal(workflow.split('packages: write').length - 1, 1);
    assert.match(jobs.publish!, /^ {4}permissions:\n {6}packages: write\n {4}env:/m);
    assert.ok(!/permissions/.test(jobs.check!));
  });

  test('one tag, the full SHA of the commit; the digest goes to the summary', () => {
    assert.ok(!/latest/.test(workflow));
    const images = [...workflow.matchAll(/ghcr\.io\/\S+/g)].map((match) => match[0]);
    assert.ok(images.length > 0);
    for (const image of images) assert.ok(image.startsWith('ghcr.io/vrubovoy/hof:sha-'), image);
    assert.ok(jobs.publish!.includes('IMAGE: ghcr.io/vrubovoy/hof:sha-${{ github.sha }}'));
    assert.ok(jobs.publish!.includes('test "$revision" = "$GITHUB_SHA"'));
    assert.match(jobs.publish!, /digest=.*RepoDigests.*\n[\s\S]*>> "\$GITHUB_STEP_SUMMARY"/);
  });
});
