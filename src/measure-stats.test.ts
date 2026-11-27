import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  arrivedAt,
  beyondNoise,
  documentFate,
  freshId,
  isMark,
  isTestCourt,
  markIds,
  nginxGzips,
  notWorse,
  tolerance,
  type HistoryRow,
  formatChange,
  formatSummary,
  layoutShift,
  powerShort,
  longFrames,
  normalizeText,
  playingNow,
  quantile,
  requestStats,
  seedExpenses,
  silence,
  slowestInput,
  summarize,
  type NetRequest,
  type Probe,
} from './measure-stats.ts';
import { fateOf, report } from './measure-report.ts';
import { WAY, wayOf, type Series, type StepRead } from './measure.ts';

const event = (kind: string, at: number, fields: Record<string, unknown> = {}): Probe => ({
  kind,
  at,
  doc: 'a',
  path: '/',
  ...fields,
});

test('quantile interpolates between the nearest ranks', () => {
  const sorted = [1, 2, 3, 4];
  assert.equal(quantile(sorted, 0), 1);
  assert.equal(quantile(sorted, 1), 4);
  assert.equal(quantile(sorted, 0.5), 2.5);
  assert.equal(quantile(sorted, 0.25), 1.75);
  assert.equal(quantile([7], 0.75), 7);
  assert.throws(() => quantile([], 0.5));
});

test('summarize skips runs without a number and sorts the rest', () => {
  const summary = summarize([30, null, 10, NaN, 20, 40, Infinity]);
  assert.deepEqual(summary, { n: 4, median: 25, q1: 17.5, q3: 32.5, min: 10, max: 40 });
  assert.equal(summarize([null, NaN]), null);
});

test('formatSummary shows the median, the quartiles and the extremes', () => {
  assert.equal(formatSummary(summarize([10, 20, 30, 40, 50])), '30 [20–40] (10–50)');
  assert.equal(formatSummary(summarize([0.25]), 2), '0,25');
  assert.equal(formatSummary(null), '—');
});

test('a change within the interquartile range of either series is noise', () => {
  const base = summarize([100, 104, 108, 112, 116])!; // median 108, IQR 104–112
  const near = summarize([110, 114, 116, 118, 120])!; // median 116: 8 apart, IQR 8
  const far = summarize([130, 131, 132, 133, 134])!;
  assert.equal(beyondNoise(base, near), false);
  assert.equal(formatChange(base, near), '≈');
  assert.equal(beyondNoise(base, far), true);
  assert.equal(formatChange(base, far), '+22 %');
  assert.equal(formatChange(far, base), '-18 %');
  assert.equal(formatChange(summarize([0, 0, 0]), summarize([2, 2, 2])), '+2');
  assert.equal(formatChange(null, far), '—');
  const tight = summarize([502, 502, 502])!;
  assert.equal(formatChange(summarize([503, 503, 503]), tight), '-0,2 %');
});

test('long frames count only frames of 50 ms or more that touch the window', () => {
  const events = [
    event('loaf', 90, { dur: 60 }), // ends at 150, inside
    event('loaf', 120, { dur: 49 }), // too short
    event('loaf', 200, { dur: 80 }),
    event('loaf', 400, { dur: 70 }), // starts after the window
    event('paint', 150),
  ];
  assert.deepEqual(longFrames(events, { from: 100, to: 300 }), { count: 2, max: 80, total: 140 });
  assert.deepEqual(longFrames([], { from: 0, to: 1 }), { count: 0, max: 0, total: 0 });
});

test('the slowest input counts interactions only, and none is null', () => {
  const events = [
    event('input', 100, { dur: 40, id: 1 }),
    event('input', 110, { dur: 90, id: 1 }),
    event('input', 120, { dur: 200, id: 0 }), // not an interaction (a hover)
    event('input', 900, { dur: 300, id: 2 }), // outside
  ];
  assert.equal(slowestInput(events, { from: 50, to: 500 }), 90);
  assert.equal(slowestInput(events, { from: 500, to: 600 }), null);
});

test('layout shift adds shifts without a recent input', () => {
  const events = [
    event('shift', 10, { value: 0.05, input: false }),
    event('shift', 20, { value: 0.5, input: true }),
    event('shift', 30, { value: 0.01, input: false }),
  ];
  assert.ok(Math.abs(layoutShift(events, { from: 0, to: 100 }) - 0.06) < 1e-9);
});

test('silence of a new document: from its hide to the next playing, then the fade-in', () => {
  const events = [
    { ...event('media', 0, { type: 'playing', el: 'a:1' }), doc: 'a' },
    { ...event('hide', 1000), doc: 'a' },
    { ...event('media', 1600, { type: 'playing', el: 'b:1' }), doc: 'b' },
    { ...event('gain', 1610, { target: 0.25, seconds: 0.4 }), doc: 'b' },
  ];
  assert.deepEqual(silence(events, { from: 500, to: 3000 }), {
    longest: 600,
    toLevel: 1610 + 400 - 1000,
    starts: 1,
  });
});

test('a new document committed ends the music of the one before', () => {
  const events = [
    { ...event('media', 0, { type: 'playing', el: 'a:1' }), doc: 'a' },
    { ...event('commit', 300), doc: '' },
    { ...event('media', 650, { type: 'playing', el: 'b:1' }), doc: 'b' },
  ];
  assert.equal(silence(events, { from: 100, to: 1000 }).longest, 350);
  assert.equal(playingNow(events.slice(0, 2)), false);
  assert.equal(playingNow(events), true);
});

test('music that keeps playing has no silence and no new player', () => {
  const events = [event('media', 0, { type: 'playing', el: 'a:1' })];
  assert.deepEqual(silence(events, { from: 100, to: 2000 }), {
    longest: 0,
    toLevel: null,
    starts: 0,
  });
  assert.equal(playingNow(events), true);
});

test('a pause ends playing, and the longest of several gaps counts', () => {
  const events = [
    event('media', 0, { type: 'playing', el: 'a:1' }),
    event('media', 200, { type: 'pause', el: 'a:1' }),
    event('media', 300, { type: 'playing', el: 'a:1' }),
    event('media', 400, { type: 'waiting', el: 'a:1' }),
    event('media', 900, { type: 'playing', el: 'a:1' }),
  ];
  const result = silence(events, { from: 100, to: 1000 });
  assert.equal(result.longest, 500);
  assert.equal(result.starts, 0);
  assert.equal(playingNow(events.slice(0, 4)), false);
});

test('no music at all is silence for the whole window', () => {
  assert.deepEqual(silence([], { from: 0, to: 1500 }), { longest: 1500, toLevel: null, starts: 0 });
  assert.equal(playingNow([]), false);
  assert.equal(
    playingNow([
      { ...event('media', 0, { type: 'playing', el: 'a:1' }), doc: 'a' },
      { ...event('hide', 10), doc: 'a' },
    ]),
    false,
  );
});

test('request stats find repeated, cancelled and failed requests and the POSTs', () => {
  const r = (fields: Partial<NetRequest>): NetRequest => ({
    method: 'GET',
    url: 'http://localhost:3000/',
    type: 'Document',
    at: 100,
    status: 200,
    bytes: 1024,
    canceled: false,
    failed: false,
    ...fields,
  });
  const stats = requestStats(
    [
      r({ method: 'POST', url: 'http://localhost:3000/saeckel/pouches/1/expense', status: 303 }),
      r({ url: 'http://localhost:3000/saeckel/pouches/1' }),
      r({ url: 'http://localhost:3000/saeckel/pouches/1', canceled: true, failed: true }),
      r({ url: 'http://localhost:3000/static/a.css', status: 304, bytes: 0 }),
      r({ url: 'http://localhost:3000/x', failed: true }),
      r({ at: 5000 }),
    ],
    { from: 0, to: 1000 },
  );
  assert.deepEqual(stats, {
    total: 5,
    kb: 4,
    repeated: 1,
    replaced: 0,
    canceled: 1,
    failed: 1,
    posts: 1,
    notModified: 1,
    data: 1,
  });
});

test('a request sent again after its cancel is a replacement, after an answer a needless repeat', () => {
  const r = (at: number, fields: Partial<NetRequest> = {}): NetRequest => ({
    method: 'GET',
    url: 'http://localhost:3000/login',
    type: 'Document',
    at,
    status: 200,
    bytes: 0,
    canceled: false,
    failed: false,
    ...fields,
  });
  // As at the sign-out of M13: the document asked for, cancelled by the navigation that followed.
  const signOut = requestStats([r(20), r(10, { canceled: true, failed: true, status: 0 })], {
    from: 0,
    to: 100,
  });
  assert.equal(signOut.replaced, 1);
  assert.equal(signOut.repeated, 0);
  assert.equal(signOut.data, 1);
  const twice = requestStats([r(10), r(20, { type: 'Fetch' }), r(30, { type: 'Fetch' })], {
    from: 0,
    to: 100,
  });
  assert.equal(twice.repeated, 2);
  // A page back from the cache asks for nothing; an image is not data.
  assert.equal(requestStats([r(10, { type: 'Image' })], { from: 0, to: 100 }).data, 0);
  assert.equal(requestStats([r(10, { status: 304 })], { from: 0, to: 100 }).data, 0);
});

const mark = { pouch: 'Еда', kind: 'Трата', note: 'Замер', amount: '123,45' };
const row = (id: number, fields: Partial<HistoryRow> = {}): HistoryRow => ({
  id,
  pouch: ' Еда ',
  kind: 'Трата',
  note: 'Замер',
  sum: '\n −123,45\u00a0₽ ',
  ...fields,
});

test('a record is that of a run only when every cell is the mark, the note whole', () => {
  assert.equal(isMark(row(1), mark), true);
  assert.equal(isMark(row(2, { note: 'Замер на кухне' }), mark), false);
  assert.equal(isMark(row(3, { note: 'Замерить' }), mark), false);
  assert.equal(isMark(row(4, { pouch: 'Дом' }), mark), false);
  assert.equal(isMark(row(5, { kind: 'Доход', sum: '+123,45 ₽' }), mark), false);
  assert.equal(isMark(row(6, { sum: '−1 123,45 ₽' }), mark), false);
  assert.equal(isMark(row(7, { kind: 'Расход' }), mark), false);
  assert.deepEqual(markIds([row(8), row(9, { note: 'Запись 1' }), row(10)], mark), [8, 10]);
  assert.equal(normalizeText('  a \n\t b  '), 'a b');
});

test('the test court is proved by its seeded records before anything is deleted', () => {
  const seeded = [row(1, { note: 'Жалованье', kind: 'Доход' }), row(2, { note: 'Запись 1' })];
  const notes = ['Жалованье', 'Запись 1'];
  assert.equal(isTestCourt(seeded, mark, 2, notes), true);
  // Leftovers of the mark do not count.
  assert.equal(isTestCourt([...seeded, row(3), row(4)], mark, 2, notes), true);
  // A record of a person, a missing or a doubled seeded record: not the test court.
  assert.equal(isTestCourt([...seeded, row(5, { note: 'Хлеб' })], mark, 2, notes), false);
  assert.equal(isTestCourt([seeded[0]!, row(6, { note: 'Хлеб' })], mark, 2, notes), false);
  assert.equal(isTestCourt([seeded[0]!, seeded[0]!], mark, 2, notes), false);
});

test('the record written is known by the address the form led to', () => {
  assert.equal(freshId('/saeckel/pouches/1?fresh=123'), 123);
  assert.equal(freshId('/saeckel/pouches/1'), null);
  assert.equal(freshId('/saeckel/pouches/1?fresh=0'), null);
  assert.equal(freshId('/saeckel/pouches/1?fresh=1e3'), null);
});

test('the document of a step: new, the same one, or back from the cache', () => {
  const seen = new Set(['a', 'b']);
  assert.equal(documentFate({ doc: 'c' }, 'b', seen), 'new');
  assert.equal(documentFate({ doc: 'b' }, 'b', seen), 'same');
  assert.equal(documentFate({ doc: 'a' }, 'b', seen), 'restored');
  assert.equal(documentFate({ doc: 'b', restored: true }, 'b', seen), 'restored');
});

test('not worse than M13 allows the largest of the spread, 5 % and 15 ms', () => {
  const base = summarize([200, 200, 200])!;
  assert.equal(tolerance(base, summarize([210, 210, 210])!), 15);
  assert.equal(notWorse(base, summarize([215, 215, 215])!), true);
  assert.equal(notWorse(base, summarize([216, 216, 216])!), false);
  const slow = summarize([1000, 1000, 1000])!;
  assert.equal(tolerance(slow, slow), 50);
  const wide = summarize([100, 200, 300, 400, 500])!; // IQR 200
  assert.equal(notWorse(summarize([300, 300, 300])!, wide), true);
});

test('the navigation scenario is the way without the steps that send a form', () => {
  const names = wayOf('navigation').map((def) => def.name);
  assert.deepEqual(wayOf('full'), WAY);
  assert.equal(names.length, WAY.length - 2);
  assert.ok(!names.some((name) => name.startsWith('Трата')));
  assert.ok(names.includes('Назад браузера') && names.includes('Мешки → Летопись'));
  assert.ok(wayOf('navigation').every((def) => def.check !== 'written'));
});

test('the test budget is fixed: the same expenses every time, valid amounts and dates', () => {
  const list = seedExpenses(56, 4);
  assert.deepEqual(list, seedExpenses(56, 4));
  assert.equal(list.length, 56);
  assert.deepEqual(list[0], { pouch: 1, amount: '150,00', date: '2026-10-02', note: 'Запись 1' });
  assert.deepEqual(list.at(-1)!.date, '2026-10-29');
  for (const { amount, pouch } of list) {
    assert.match(amount, /^[1-9]\d{2},\d{2}$/);
    assert.ok(pouch >= 1 && pouch <= 4);
  }
  // Every pouch spends less than the 25 000 laid out into it.
  for (let pouch = 1; pouch <= 4; pouch += 1) {
    const spent = list
      .filter((e) => e.pouch === pouch)
      .reduce((sum, e) => sum + Number(e.amount.replace(',', '.')), 0);
    assert.ok(spent < 25_000, String(spent));
  }
});

test('a view arrives on its path; a query must match whole', () => {
  assert.equal(arrivedAt('/saeckel/pouches/1?fresh=5', ['/saeckel/pouches/1']), true);
  assert.equal(arrivedAt('/saeckel/pouches/1/expense', ['/saeckel/pouches/1']), false);
  assert.equal(arrivedAt('/saeckel/history?page=2', ['/saeckel/history?page=2']), true);
  assert.equal(arrivedAt('/saeckel/history', ['/saeckel/history?page=2']), false);
  assert.equal(arrivedAt('/saeckel/history?page=3', ['/saeckel/history?page=2']), false);
});

test('the report compares series and names the noise', () => {
  const step = (toView: number) => ({
    name: 'Двор → Мешки',
    toRequest: 1,
    toView,
    toSettled: toView + 500,
    toLcp: null,
    document: 'new' as const,
    loaf: { count: 0, max: 0, total: 0 },
    input: 20,
    shift: 0,
    requests: {
      total: 3,
      kb: 10,
      repeated: 0,
      replaced: 0,
      canceled: 0,
      failed: 0,
      posts: 0,
      notModified: 0,
      data: 1,
    },
    blots: [
      { file: 'ink.webp', place: 'blot-x', box: [1, 2, 3, 4] as [number, number, number, number] },
    ],
  });
  const series = (label: string, views: number[]): Series => ({
    label,
    date: '2026-11-25T12:00:00.000Z',
    product: 'HeadlessChrome/158',
    flags: [],
    node: 'v24',
    power: { start: 'AC', end: 'AC' },
    build: [],
    fingerprint: 'Казна',
    runs: views.length,
    loads: [],
    chain: views.map((v, i) => ({ profile: 'Телефон', anim: false, run: i + 1, steps: [step(v)] })),
    music: [],
    memory: [],
  });
  const text = report([
    series('M13', [200, 210, 220]),
    series('M13 повтор', [205, 212, 225]),
    { ...series('A', [100, 101, 102]), transport: 'gzip' },
  ]);
  // The series of M14.1 were not compressed; --gzip says so in the table of series.
  assert.match(text, /\| M13 \| полный \| нет \|/);
  assert.match(text, /\| A \| полный \| gzip, как nginx \|/);
  assert.match(text, /\| Телефон \| выкл \| Двор → Мешки \| 210 \[205–215\] \(200–220\) \|/);
  assert.match(text, /\| ≈ \| -52 % \|/);
  assert.match(text, /\| M13 повтор \| \d+ из \d+ \|/);
  assert.match(text, /ink\.webp 1,2,3,4 \| да \|/);
});

test('the power of the Mac is shown short', () => {
  const ac = "Now drawing from 'AC Power' -InternalBattery-0 (id=1) 32%; charging; present: true";
  assert.equal(powerShort(ac), 'сеть 32 %');
  assert.equal(
    powerShort("Now drawing from 'Battery Power' -InternalBattery-0 80%;"),
    'батарея 80 %',
  );
  assert.equal(powerShort(''), '');
});

test('Back is not compared with a page from the cache but with the way forward to its view', () => {
  const requests = (data?: number) => ({
    total: 1,
    kb: 1,
    repeated: 0,
    canceled: 0,
    failed: 0,
    posts: 0,
    notModified: 0,
    ...(data === undefined ? {} : { replaced: 0, data }),
  });
  const read = (name: string, toView: number, fields: Record<string, unknown>): StepRead =>
    ({
      name,
      toRequest: 1,
      toView,
      toSettled: toView,
      toLcp: null,
      loaf: { count: 0, max: 0, total: 0 },
      input: null,
      shift: 0,
      ...fields,
    }) as unknown as StepRead;
  const series = (label: string, back: StepRead, forward: StepRead): Series => ({
    label,
    date: '2026-11-26T12:00:00.000Z',
    product: 'HeadlessChrome/158',
    flags: [],
    node: 'v24',
    power: { start: 'сеть 100 %', end: 'сеть 100 %' },
    build: [],
    fingerprint: 'Казна',
    runs: 3,
    loads: [],
    chain: [1, 2, 3].map((run) => ({
      profile: 'Телефон',
      anim: false,
      run,
      steps: [forward, back],
    })),
    music: [],
    memory: [],
  });
  // A series of M14.1: `newDocument`, requests without the replaced and the data.
  const old = series(
    'M13',
    read('Назад браузера', 11, { newDocument: false, requests: requests() }),
    read('Мешки → Летопись', 207, { newDocument: true, requests: requests() }),
  );
  assert.equal(fateOf(old.chain[0]!.steps[1]!), 'restored');
  assert.equal(fateOf(old.chain[0]!.steps[0]!), 'new');
  const fresh = (toView: number) =>
    series(
      `A ${toView}`,
      read('Назад браузера', toView, { document: 'same', requests: requests(1) }),
      read('Мешки → Летопись', 200, { document: 'same', requests: requests(1) }),
    );
  const text = report([old, fresh(150), fresh(230)]);
  // In the tables Back of the prototype is not compared with the cache of M13.
  assert.match(
    text,
    /\| Назад браузера \| 11 \[[^|]+\| 150 \[[^|]+\| 230 \[[^|]+\| ≠ \(bfcache \/ тот же\) \|/,
  );
  // A new document against a view in the same one is compared.
  assert.match(
    text,
    /\| Мешки → Летопись \| 207 \[[^|]+\| 200 \[[^|]+\| 200 \[[^|]+\| -3 % \| -3 % \|/,
  );
  assert.match(text, /\| 1; 0\*\/—\/0\/0\/0\/— \| 0\/0\/3 \|/);
  // Its threshold: 207 + 15 ms.
  assert.match(text, /\| Телефон \| выкл \| M13 \| 11 \[[^|]+\| 0\/0\/3 \| —,—,— \| 222 \| нет \|/);
  assert.match(
    text,
    /\| Телефон \| выкл \| A 150 \| 150 \[[^|]+\| 0\/3\/0 \| 1,1,1 \| 222 \| да \|/,
  );
  assert.match(
    text,
    /\| Телефон \| выкл \| A 230 \| 230 \[[^|]+\| 0\/3\/0 \| 1,1,1 \| 222 \| нет \|/,
  );
});

test('--gzip compresses what nginx of production compresses, and nothing else', () => {
  const js = {
    path: '/static/vendor/turbo-8.0.23.js',
    status: 200,
    type: 'text/javascript; charset=utf-8',
    length: 203_701,
    encoding: undefined,
    accept: 'gzip, deflate, br, zstd',
  };
  assert.equal(nginxGzips(js), true);
  assert.equal(nginxGzips({ ...js, path: '/saeckel/static/saeckel.css', type: 'text/css' }), true);
  assert.equal(
    nginxGzips({ ...js, path: '/static/img/hof-mark.svg', type: 'image/svg+xml' }),
    true,
  );
  assert.equal(nginxGzips({ ...js, status: 404 }), true);
  assert.equal(nginxGzips({ ...js, length: null }), true);
  // Pages, pictures and sounds, other answers, tiny or compressed bodies, a browser without gzip.
  assert.equal(nginxGzips({ ...js, path: '/saeckel/', type: 'text/html; charset=utf-8' }), false);
  assert.equal(nginxGzips({ ...js, path: '/login', type: 'text/javascript' }), false);
  assert.equal(nginxGzips({ ...js, path: '/static/img/a.webp', type: 'image/webp' }), false);
  assert.equal(nginxGzips({ ...js, path: '/static/music-1.mp3', type: 'audio/mpeg' }), false);
  assert.equal(nginxGzips({ ...js, status: 304 }), false);
  assert.equal(nginxGzips({ ...js, length: 19 }), false);
  assert.equal(nginxGzips({ ...js, encoding: 'br' }), false);
  assert.equal(nginxGzips({ ...js, accept: 'br, zstd' }), false);
  assert.equal(nginxGzips({ ...js, accept: '' }), false);
});
