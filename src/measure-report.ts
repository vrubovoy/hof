// Markdown tables of the series of src/measure.ts (docs/OPERATIONS.md, «Замер скорости страниц»).
// The first series is the base: every other one gets a column of its change against it, «≈» where
// the medians are closer than the interquartile range of either (measure-stats.ts).

import {
  BACK_REFERENCE,
  BACK_STEP,
  formatChange,
  formatSummary,
  notWorse,
  powerShort,
  summarize,
  tolerance,
  type DocumentFate,
  type Summary,
} from './measure-stats.ts';
import type { ChainRecord, LoadRead, Series, StepRead } from './measure.ts';

const yes = (anim: boolean) => (anim ? 'вкл' : 'выкл');

function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

// Series of M14.1 were written before `document`: their `newDocument` false is a page back from
// the back/forward cache — M13 draws no view without a new document (it never marks hof:view), so
// a view came only from pageshow of a persisted page.
export function fateOf(step: StepRead): DocumentFate {
  const stored = step as Partial<StepRead> & { newDocument?: boolean };
  return stored.document ?? (stored.newDocument === true ? 'new' : 'restored');
}

const FATES: Record<DocumentFate, string> = { new: 'новый', same: 'тот же', restored: 'bfcache' };

// The fate of the document most runs of a step had.
function usualFate(steps: readonly StepRead[]): DocumentFate | null {
  const counts = new Map<DocumentFate, number>();
  for (const step of steps) counts.set(fateOf(step), (counts.get(fateOf(step)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

interface Row {
  key: string[];
  pick: (s: Series) => (number | null)[];
  // The usual document of the step in a series: a page from the back/forward cache on one side
  // only is not compared (what it showed before against current data).
  fate?: (s: Series) => DocumentFate | null;
}

function apart(row: Row, base: Series, other: Series): string | null {
  if (row.fate === undefined) return null;
  const a = row.fate(base);
  const b = row.fate(other);
  // A new document and a view drawn in the same one both show current data and are compared.
  return a !== null && b !== null && a !== b && (a === 'restored' || b === 'restored')
    ? `≠ (${FATES[a]} / ${FATES[b]})`
    : null;
}

// One row of a metric: the cell of every series, then the change of every other one.
function compared(all: readonly Series[], row: Row, digits = 0) {
  const summaries = all.map((s) => summarize(row.pick(s)));
  return [
    ...summaries.map((summary) => formatSummary(summary, digits)),
    ...summaries
      .slice(1)
      .map(
        (summary, i) => apart(row, all[0]!, all[i + 1]!) ?? formatChange(summaries[0]!, summary),
      ),
  ];
}

function head(all: readonly Series[], first: readonly string[]) {
  return [...first, ...all.map((s) => s.label), ...all.slice(1).map((s) => `Δ ${s.label}`)];
}

// The rows of «Уровень шума»: for every other series, how many rows of the tables above were
// within the noise and the largest change beyond it.
const changes = new Map<string, { within: number; total: number; largest: number }>();
function note(base: Summary | null, other: Summary | null, label: string) {
  if (base === null || other === null) return;
  const entry = changes.get(label) ?? { within: 0, total: 0, largest: 0 };
  entry.total += 1;
  const range = Math.max(base.q3 - base.q1, other.q3 - other.q1);
  if (Math.abs(other.median - base.median) <= range) entry.within += 1;
  else if (base.median !== 0) {
    entry.largest = Math.max(entry.largest, Math.abs((other.median - base.median) / base.median));
  }
  changes.set(label, entry);
}

function metric(all: readonly Series[], rows: Row[], first: string[], digits = 0) {
  for (const row of rows) {
    const summaries = all.map((s) => summarize(row.pick(s)));
    all.slice(1).forEach((s, i) => {
      if (apart(row, all[0]!, s) === null) note(summaries[0]!, summaries[i + 1]!, s.label);
    });
  }
  return table(
    head(all, first),
    rows.map((row) => [...row.key, ...compared(all, row, digits)]),
  );
}

const median = (values: number[]) => summarize(values)?.median ?? NaN;
const round = (value: number) => (Number.isFinite(value) ? String(Math.round(value)) : '—');

function loads(all: readonly Series[]) {
  const base = all[0]!;
  const keys = [...new Set(base.loads.map((l) => `${l.profile}|${l.anim}|${l.path}`))];
  const pick =
    (key: string, when: 'cold' | 'warm', field: keyof Omit<LoadRead, 'what' | 'loaf'>) =>
    (s: Series) =>
      s.loads.filter((l) => `${l.profile}|${l.anim}|${l.path}` === key).map((l) => l[when][field]);
  const label = (key: string) => {
    const [profile, anim, path] = key.split('|');
    return [profile!, yes(anim === 'true'), path!];
  };
  const out: string[] = [];
  for (const [title, when, field] of [
    ['Холодная загрузка: LCP, мс', 'cold', 'lcp'],
    ['Холодная загрузка: FCP, мс', 'cold', 'fcp'],
    ['Тёплая загрузка (тот же адрес ещё раз): LCP, мс', 'warm', 'lcp'],
  ] as const) {
    out.push(
      '',
      `#### ${title}`,
      '',
      ...metric(
        all,
        keys.map((key) => ({ key: label(key), pick: pick(key, when, field) })),
        ['Профиль', 'Анимации', 'Страница'],
      ),
    );
  }
  out.push(
    '',
    '#### Холодная загрузка: вес и запросы (медианы)',
    '',
    'КБ — всё по сети до конца анимаций + 1 с; JS и CSS — тела, сжатые gzip уровня 1, как nginx',
    'production; запросов — холодно / повторно (из них 304); LCP — элемент последнего прогона; LoAF —',
    'медиана числа кадров от 50 мс / самый длинный за все прогоны; сдвиги — медиана суммы сдвигов',
    'без недавнего ввода до конца загрузки + 1 с (не CLS всей жизни документа).',
    '',
  );
  const rows: string[][] = [];
  for (const key of keys) {
    for (const s of all) {
      const list = s.loads.filter((l) => `${l.profile}|${l.anim}|${l.path}` === key);
      if (list.length === 0) continue;
      const cold = list.map((l) => l.cold);
      const warm = list.map((l) => l.warm);
      rows.push([
        ...label(key),
        s.label,
        round(median(cold.map((l) => l.kb))),
        round(median(cold.map((l) => l.imageKb))),
        median(cold.map((l) => l.jsGzipKb))
          .toFixed(1)
          .replace('.', ','),
        median(cold.map((l) => l.cssGzipKb))
          .toFixed(1)
          .replace('.', ','),
        `${round(median(cold.map((l) => l.requests)))} / ${round(median(warm.map((l) => l.requests)))} (${round(median(warm.map((l) => l.notModified)))})`,
        cold.at(-1)!.what,
        `${round(median(cold.map((l) => l.loaf.count)))} / ${round(Math.max(...cold.map((l) => l.loaf.max)))}`,
        median(cold.map((l) => l.shift))
          .toFixed(3)
          .replace('.', ','),
      ]);
    }
  }
  out.push(
    ...table(
      [
        'Профиль',
        'Анимации',
        'Страница',
        'Серия',
        'КБ',
        'Картинки, КБ',
        'JS gzip, КБ',
        'CSS gzip, КБ',
        'Запросов',
        'Элемент LCP',
        'LoAF',
        'Сдвиги',
      ],
      rows,
    ),
  );
  return out;
}

function stepsOf(records: readonly ChainRecord[], key: string, name: string): StepRead[] {
  return records
    .filter((r) => `${r.profile}|${r.anim}` === key)
    .flatMap((r) => r.steps.filter((s) => s.name === name));
}

function chain(all: readonly Series[]) {
  const base = all[0]!;
  const configs = [...new Set(base.chain.map((r) => `${r.profile}|${r.anim}`))];
  const names = base.chain[0]?.steps.map((s) => s.name) ?? [];
  const label = (config: string, name: string) => {
    const [profile, anim] = config.split('|');
    return [profile!, yes(anim === 'true'), name];
  };
  const rows = (field: 'toView' | 'toSettled' | 'toRequest' | 'toLcp') =>
    configs.flatMap((config) =>
      names.map((name) => ({
        key: label(config, name),
        pick: (s: Series) => stepsOf(s.chain, config, name).map((step) => step[field]),
        fate: (s: Series) => usualFate(stepsOf(s.chain, config, name)),
      })),
    );
  const out: string[] = [];
  for (const [title, field] of [
    ['Нажатие → первый кадр нового вида, мс', 'toView'],
    ['Нажатие → конец анимаций, мс', 'toSettled'],
    ['Нажатие → запрос следующего вида, мс', 'toRequest'],
    ['Нажатие → LCP нового документа, мс (только шаги с новым документом)', 'toLcp'],
  ] as const) {
    out.push('', `#### ${title}`, '', ...metric(all, rows(field), ['Профиль', 'Анимации', 'Шаг']));
  }
  out.push(
    '',
    '#### Длинные кадры, отклик, сдвиги и запросы шага',
    '',
    'LoAF — доля прогонов с кадром от 50 мс, медиана их числа, самый длинный за все прогоны, мс;',
    'отклик — самое долгое нажатие в окне шага (Event Timing или следующий кадр), медиана /',
    'наибольшее, мс; это не INP документа, «—» — показания нет, это не ноль; сдвиги — сумма',
    'сдвигов без недавнего ввода в окне шага, медиана / наибольшая, это не CLS документа; запросы —',
    'медиана числа, затем наибольшее за прогоны: лишние повторы (тот же метод и адрес после ответа),',
    'повторы после отмены, отменённые, неудачные, POST, данные с сервера (документ, fetch или XHR с',
    'ответом 200); документ — прогонов с новым документом / тем же / из back/forward cache. «*» —',
    'серия M14.1, записанная до разделения повторов: любой повтор того же адреса.',
    '',
  );
  const lines: string[][] = [];
  for (const config of configs) {
    for (const name of names) {
      for (const s of all) {
        const list = stepsOf(s.chain, config, name);
        if (list.length === 0) continue;
        const inputs = list.map((step) => step.input).filter((v): v is number => v !== null);
        const share = (count: number) => `${count}/${list.length}`;
        lines.push([
          ...label(config, name),
          s.label,
          `${share(list.filter((step) => step.loaf.count > 0).length)}; ${round(median(list.map((step) => step.loaf.count)))}; ${round(Math.max(...list.map((step) => step.loaf.max)))}`,
          inputs.length === 0 ? '—' : `${round(median(inputs))} / ${round(Math.max(...inputs))}`,
          `${median(list.map((step) => step.shift))
            .toFixed(3)
            .replace('.', ',')} / ${Math.max(...list.map((step) => step.shift))
            .toFixed(3)
            .replace('.', ',')}`,
          requestCell(list),
          (['new', 'same', 'restored'] as const)
            .map((fate) => list.filter((step) => fateOf(step) === fate).length)
            .join('/'),
        ]);
      }
    }
  }
  out.push(
    ...table(
      [
        'Профиль',
        'Анимации',
        'Шаг',
        'Серия',
        'LoAF',
        'Отклик',
        'Сдвиги',
        'Запросы; повт./после отмены/отм./неуд./POST/данные',
        'Документ: новый/тот же/bfcache',
      ],
      lines,
    ),
  );
  return out;
}

function requestCell(list: readonly StepRead[]) {
  const most = (pick: (r: StepRead['requests']) => number | undefined) => {
    const values = list.map((step) => pick(step.requests));
    return values.some((v) => v === undefined) ? '—' : String(Math.max(...values.map((v) => v!)));
  };
  const old = list.some((step) => step.requests.replaced === undefined);
  return [
    `${round(median(list.map((step) => step.requests.total)))}; `,
    `${most((r) => r.repeated)}${old ? '*' : ''}/${most((r) => r.replaced)}/`,
    `${most((r) => r.canceled)}/${most((r) => r.failed)}/${most((r) => r.posts)}/`,
    most((r) => r.data),
  ].join('');
}

// Back to the first page of Летопись, against the way forward to the same view without animations
// in the base: a page back from the back/forward cache of M13 shows what it showed before, a
// prototype must show current data (docs/OPERATIONS.md, «Пороги приёмки M14»).
function back(all: readonly Series[]) {
  const base = all[0]!;
  const configs = [...new Set(base.chain.map((r) => `${r.profile}|${r.anim}`))];
  const rows: string[][] = [];
  for (const config of configs) {
    const [profile, anim] = config.split('|');
    const reference = summarize(
      stepsOf(base.chain, `${profile}|false`, BACK_REFERENCE).map((step) => step.toView),
    );
    for (const s of all) {
      const list = stepsOf(s.chain, config, BACK_STEP);
      if (list.length === 0) continue;
      const view = summarize(list.map((step) => step.toView));
      const fresh = list.every(
        (step) => fateOf(step) !== 'restored' && (step.requests.data ?? 0) > 0,
      );
      const verdict =
        view === null || reference === null || view.n < list.length
          ? 'не проверено'
          : fresh && notWorse(reference, view)
            ? 'да'
            : 'нет';
      rows.push([
        profile!,
        yes(anim === 'true'),
        s.label,
        formatSummary(view),
        (['new', 'same', 'restored'] as const)
          .map((fate) => list.filter((step) => fateOf(step) === fate).length)
          .join('/'),
        list.map((step) => step.requests.data ?? '—').join(','),
        reference === null || view === null
          ? '—'
          : String(Math.round(reference.median + tolerance(reference, view))),
        verdict,
      ]);
    }
  }
  if (rows.length === 0) return [];
  return [
    '',
    `#### «${BACK_STEP}»: первый кадр против «${BACK_REFERENCE}» без анимаций у базы`,
    '',
    'Порог — медиана базы на пути вперёд к тому же виду без анимаций плюс допуск; проходит шаг, у',
    'которого во всех прогонах есть свежие данные с сервера и нет страницы из back/forward cache.',
    '',
    ...table(
      [
        'Профиль',
        'Анимации',
        'Серия',
        'Первый кадр, мс',
        'Документ: новый/тот же/bfcache',
        'Данных с сервера по прогонам',
        'Порог, мс',
        'Проходит',
      ],
      rows,
    ),
  ];
}

function music(all: readonly Series[]) {
  const base = all[0]!;
  if (base.music.length === 0) return [];
  const profiles = [...new Set(base.music.map((r) => r.profile))];
  const names = (base.music[0]?.steps ?? [])
    .map((s) => s.name)
    .filter((name) => !name.includes('(документ)'));
  const rows = (field: 'longest' | 'toLevel' | 'starts') =>
    profiles.flatMap((profile) =>
      names.map((name) => ({
        key: [profile, name],
        pick: (s: Series) =>
          stepsOf(s.music, `${profile}|true`, name).map((step) =>
            step.silence === undefined ? null : step.silence[field],
          ),
      })),
    );
  const out: string[] = [];
  for (const [title, field] of [
    ['Музыка: самая длинная тишина шага по событиям media, мс', 'longest'],
    ['Музыка: тишина до полной громкости после неё (усиление fx.js), мс', 'toLevel'],
    ['Музыка: новых плееров за шаг', 'starts'],
  ] as const) {
    out.push('', `#### ${title}`, '', ...metric(all, rows(field), ['Профиль', 'Шаг']));
  }
  return out;
}

function memory(all: readonly Series[]) {
  const rows: string[][] = [];
  for (const s of all) {
    for (const m of s.memory) {
      rows.push([
        s.label,
        String(m.cycle),
        String(m.documents),
        String(m.nodes),
        String(m.listeners),
        round(m.heapKb),
      ]);
    }
  }
  if (rows.length === 0) return [];
  return [
    '',
    '#### Память после кругов пути (компьютер, анимации вкл, после сборки мусора)',
    '',
    ...table(['Серия', 'Круг', 'Документов', 'Узлов', 'Обработчиков', 'Куча JS, КБ'], rows),
  ];
}

function blots(all: readonly Series[]) {
  const rows: string[][] = [];
  for (const s of all) {
    const configs = [...new Set(s.chain.map((r) => r.profile))];
    for (const profile of configs) {
      const records = s.chain.filter((r) => r.profile === profile);
      for (const name of records[0]?.steps.map((step) => step.name) ?? []) {
        const seen = records.flatMap((r) =>
          r.steps.filter((step) => step.name === name && step.blots !== undefined),
        );
        if (seen.length === 0) continue;
        const shapes = new Set(seen.map((step) => JSON.stringify(step.blots)));
        const first = seen[0]!.blots!;
        rows.push([
          s.label,
          profile,
          name,
          first.map((b) => `${b.file} ${b.box.join(',')}`).join('; ') || 'нет',
          shapes.size === 1 ? 'да' : `нет (${shapes.size} вариантов)`,
        ]);
      }
    }
  }
  if (rows.length === 0) return [];
  return [
    '',
    '#### Кляксы: где стоят на виде (x, y, ширина, высота в CSS px документа)',
    '',
    ...table(['Серия', 'Профиль', 'Вид после шага', 'Кляксы', 'Одинаково во всех прогонах'], rows),
  ];
}

export function report(all: readonly Series[]): string {
  changes.clear();
  const base = all[0]!;
  const out = [
    '### Серии',
    '',
    ...table(
      [
        'Серия',
        'Сценарий',
        'Сжатие статики',
        'Дата, UTC',
        'Chrome',
        'Node',
        'Прогонов',
        'Питание',
        'Данные как у базы',
      ],
      all.map((s) => [
        s.label,
        (s.scenario ?? 'full') === 'full' ? 'полный' : 'навигация',
        s.transport === 'gzip' ? 'gzip, как nginx' : 'нет',
        s.date.slice(0, 16).replace('T', ' '),
        s.product,
        s.node,
        String(s.runs),
        [powerShort(s.power.start), powerShort(s.power.end)]
          .filter((text, i, both) => i === 0 || text !== both[0])
          .join(' → '),
        s.fingerprint === base.fingerprint ? 'да' : 'НЕТ',
      ]),
    ),
    '',
    'Ячейка — медиана [Q1–Q3] (минимум–максимум) по прогонам; Δ — изменение медианы против первой',
    'серии, «≈» — медианы ближе межквартильного размаха любой из двух.',
    '',
    '### Загрузка документа',
    ...loads(all),
    '',
    '### Путь по двору: внутренняя навигация',
    ...chain(all),
    ...back(all),
    ...music(all),
    ...memory(all),
    ...blots(all),
  ];
  if (all.length > 1) {
    out.push(
      '',
      '### Уровень шума: строки таблиц выше',
      '',
      ...table(
        ['Серия против первой', 'В пределах шума', 'Наибольшее изменение сверх шума'],
        all.slice(1).map((s) => {
          const entry = changes.get(s.label) ?? { within: 0, total: 0, largest: 0 };
          return [
            s.label,
            `${entry.within} из ${entry.total}`,
            `${Math.round(entry.largest * 100)} %`,
          ];
        }),
      ),
    );
  }
  return `${out.join('\n')}\n`;
}
