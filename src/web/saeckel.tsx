// Prototype B of M14: the views of Säckel on the way — the frame, Мешки, a pouch and Летопись — as
// React components drawing the markup of the HTML pages of src/saeckel/app.ts, on saeckel.css.
// Forms are still the browser's (M14.5): they post as before and the page of the server comes.

import { useSuspenseQuery } from '@tanstack/react-query';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { useHref, useLinkClickHandler, useParams, useSearchParams } from 'react-router';
import type {
  ColumnData,
  HistoryData,
  PouchData,
  PouchesData,
  PouchPaneData,
} from '../saeckel/data.ts';
import { viewQuery } from './queries.ts';
import { ViewPlace } from './way.tsx';

// The pictures of Säckel the views name: their addresses with versions come from the shell.
export interface Pictures {
  scene: string;
  scene2x: string;
  mark: string;
  chest: string;
  emptySaeckel: string;
  emptyHistory: string;
  sprig: string;
  corner: string;
  signs: { key: string; word: string; src: string; chosen: boolean }[];
  blots: Record<string, string>;
}

// A link of the views: the markup of M13 (class, href, then the rest), followed by React Router.
// Link of React Router puts href after the other attributes; the pages keep their order.
function Link({
  to,
  className,
  children,
  ...rest
}: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement> & Record<`data-${string}`, string>) {
  const href = useHref(to);
  const follow = useLinkClickHandler(to);
  return (
    <a className={className} href={href} {...rest} onClick={follow}>
      {children}
    </a>
  );
}

// The data of a view: the way has put it in the cache before the view is shown.
function useView<T>(pathname: string, search = ''): T {
  const query = viewQuery(pathname, search)!;
  return useSuspenseQuery<T>({
    queryKey: query.key,
    queryFn: () => Promise.reject(new Error('not loaded')),
  }).data;
}

function Blot({ pictures, file, place }: { pictures: Pictures; file: string; place: string }) {
  return (
    <img
      className={`blot ${place}`}
      src={pictures.blots[file]}
      alt=""
      draggable="false"
      loading="lazy"
    />
  );
}

interface FrameProps {
  pictures: Pictures;
  tab: 'pouches' | 'history';
  back?: { href: string; text: string };
  column?: ReactNode;
  children: ReactNode;
}

// The frame of every page of Säckel (saeckelPage in src/saeckel/app.ts).
function Frame({ pictures, tab, back, column, children }: FrameProps) {
  const below = back !== undefined;
  const tabLink = (to: string, name: 'pouches' | 'history', text: string) =>
    name === tab ? (
      <Link className="tab" to={to} aria-current="page">
        {text}
      </Link>
    ) : (
      <Link className="tab" to={to} data-fx={name === 'history' ? 'flip-fwd' : 'flip-back'}>
        {text}
      </Link>
    );
  let layout;
  if (column === undefined) layout = <main className="sk-main sk-wide">{children}</main>;
  else if (below) {
    layout = (
      <div className="sk-body">
        <aside className="sk-list" aria-label="Казна и мешки">
          {column}
        </aside>
        <main className="sk-main">{children}</main>
      </div>
    );
  } else {
    layout = (
      <main className="sk-body sk-pouches">
        <div className="sk-list">{column}</div>
        {children}
      </main>
    );
  }
  return (
    <div className={below ? 'sk sk-below' : 'sk'} data-session="">
      <header className="sk-head">
        <img
          className="sk-scene"
          data-reveal=""
          src={pictures.scene}
          srcSet={`${pictures.scene} 1536w, ${pictures.scene2x} 3072w`}
          sizes="100vw"
          alt="Казначейская: стол с весами, монетами, книгой, мешками и сундуком"
          draggable="false"
          fetchPriority="high"
        />
        <a className="sk-gate sk-court" href="/" data-fx="door">
          <img src={pictures.mark} width="22" height="22" alt="" draggable="false" />
          Двор
        </a>
        {below && (
          <Link className="sk-gate sk-back" to={back.href} data-fx="flip-back">
            <span>{back.text}</span>
          </Link>
        )}
      </header>
      <div className="sk-nav">
        {below ? (
          <p className="ribbon ribbon-md">
            <span>Säckel</span>
          </p>
        ) : (
          <h1 className="ribbon ribbon-md">
            <span>Säckel</span>
          </h1>
        )}
        <nav className="tabs" aria-label="Säckel">
          {tabLink('/saeckel/', 'pouches', 'Мешки')}
          {tabLink('/saeckel/history', 'history', 'Летопись')}
        </nav>
        <p className="caps sk-motto">Бюджет по мешкам</p>
      </div>
      {layout}
    </div>
  );
}

// The column of Мешки (pouchColumn): the treasury, the pouches, the storeroom.
function Column({
  pictures,
  column,
  open,
  current,
}: {
  pictures: Pictures;
  column: ColumnData;
  open?: number;
  current?: number;
}) {
  const classes = [
    'money',
    ...(column.treasuryDebt ? ['neg'] : []),
    ...(column.treasury.length > 14 ? ['long'] : []),
  ];
  const storeroom =
    column.stored.length === 0 ? null : (
      <details className="storeroom">
        <summary>Кладовая ({column.stored.length})</summary>
        <ul>
          {column.stored.map((pouch) => (
            <li key={pouch.id}>
              <Link className="stored" to={`/saeckel/pouches/${pouch.id}`}>
                <img src={pouch.sign} alt="" draggable="false" />
                <span>{pouch.name}</span>
              </Link>
              <form method="post" action={`/saeckel/pouches/${pouch.id}/restore`}>
                <button type="submit" className="btn">
                  Вернуть
                </button>
              </form>
            </li>
          ))}
        </ul>
      </details>
    );
  return (
    <>
      <div className="framed treasury">
        <span className="chest-box" aria-hidden="true" data-poke="chest">
          <img className="chest" src={pictures.chest} alt="" draggable="false" />
        </span>
        <h2 className="title t-3">Казна</h2>
        <p className={classes.join(' ')}>{column.treasury}</p>
        <p className="treasury-actions">
          <a className="btn btn-ochre" href="/saeckel/assign" data-fx="flip-fwd-phone">
            Разложить
          </a>
          <a className="btn" href="/saeckel/income" data-fx="flip-fwd-phone">
            + Доход
          </a>
        </p>
      </div>
      {column.pouches.length > 0 && (
        <ul className="pouches">
          {column.pouches.map((pouch) => (
            <li key={pouch.id} id={`pouch-${pouch.id}`}>
              <Link
                className={pouch.id === open ? 'pouch open' : 'pouch'}
                to={`/saeckel/pouches/${pouch.id}`}
                {...(pouch.id === current
                  ? { 'aria-current': 'page' as const }
                  : { 'data-fx': 'flip-fwd-phone' })}
              >
                <img src={pouch.sign} alt="" draggable="false" />
                <span className="pouch-text">
                  <span className="name">{pouch.name}</span>
                  <span className={pouch.debt ? 'sub neg' : 'sub'}>{pouch.note}</span>
                </span>
                <span className={pouch.debt ? 'bal neg' : 'bal'}>{pouch.balance}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {(column.pouches.length > 0 || storeroom !== null) && (
        <div className="list-foot">
          {column.pouches.length > 0 && (
            <a className="link-plain" href="/saeckel/pouches/new">
              + Новый мешок
            </a>
          )}
          {storeroom}
        </div>
      )}
    </>
  );
}

// The open pouch (pouchPane): name, links, balance, «Записать трату», the last records.
function PouchPane({ pane, heading }: { pane: PouchPaneData; heading: 1 | 2 }) {
  const { pouch, form } = pane;
  const [params] = useSearchParams();
  const fresh = params.get('fresh');
  const Name = heading === 1 ? 'h1' : 'h2';
  const Form = heading === 1 ? 'h2' : 'h3';
  const transfer = `/saeckel/transfer?from=${pouch.id}${heading === 1 ? `&back=${pouch.id}` : ''}`;
  return (
    <div className="pouch-pane">
      <div className="pouch-head">
        <img src={pouch.sign} alt="" draggable="false" />{' '}
        <Name className="title t-1">{pouch.name}</Name>
        {!pouch.archived && (
          <p className="pouch-links">
            <a className="link" href={transfer}>
              Переложить
            </a>{' '}
            <a className="link" href={`/saeckel/pouches/${pouch.id}/edit`} data-fx="flip-fwd-phone">
              Изменить
            </a>
          </p>
        )}
      </div>
      <p className="balance">
        <span className="caps">Остаток</span>
        <span className={pane.debt ? 'money neg' : 'money'}>{pane.balance}</span>
      </p>
      {pane.cover !== null && (
        <p className="cover">
          <a className="link" href={pane.cover}>
            Покрыть из другого мешка
          </a>
        </p>
      )}
      {pouch.archived ? (
        <form className="restore" method="post" action={`/saeckel/pouches/${pouch.id}/restore`}>
          <button type="submit" className="btn btn-ochre">
            Вернуть
          </button>
        </form>
      ) : (
        <form
          className="expense"
          method="post"
          action={`/saeckel/pouches/${pouch.id}/expense`}
          data-fx="expense"
        >
          <Form className="title t-3 visually-hidden-phone">Записать трату</Form>
          <div className="expense-row">
            <div className="field field-amount">
              <label htmlFor="amount">Сумма, {form.symbol}</label>
              <input
                id="amount"
                className="input big"
                name="amount"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                required
                defaultValue=""
              />
            </div>
            <div className="field field-date">
              <label htmlFor="date">Дата</label>
              <input
                id="date"
                className="input"
                name="date"
                type="text"
                data-today={form.today}
                data-earliest={form.earliest}
                data-latest={form.latest}
                defaultValue={form.date}
              />
            </div>
            <div className="field field-note">
              <label htmlFor="note">Заметка</label>
              <input id="note" className="input" name="note" type="text" defaultValue="" />
            </div>
            <button type="submit" className="btn btn-ochre">
              Записать трату
            </button>
          </div>
        </form>
      )}
      {pane.movements.length > 0 && (
        <ul className="moves">
          {pane.movements.map((movement) => {
            const row = movement.expense ? 'move move-expense' : 'move';
            const cells = (
              <>
                <span className="move-date">{movement.date}</span>
                <span className="move-kind">{movement.kind}</span>
                <span className="move-note">{movement.note}</span>
                <span className="move-sum">{movement.amount}</span>
              </>
            );
            // The record just written (?fresh=<id> after «Записать трату»), marked as in M13.
            return (
              <li key={movement.id}>
                {String(movement.id) === fresh ? (
                  <mark className={row}>{cells}</mark>
                ) : (
                  <span className={row}>{cells}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const POUCH_BLOTS = [
  ['ink-blot-medium', 'blot-pouches-medium'],
  ['ink-splatter-a', 'blot-pouches-splatter'],
  ['ink-drip', 'blot-pouches-drip'],
] as const;

export function PouchesView({ pictures }: { pictures: Pictures }) {
  const data = useView<PouchesData>('/saeckel/');
  return (
    <ViewPlace title="Säckel — мешки">
      <Frame
        pictures={pictures}
        tab="pouches"
        column={<Column pictures={pictures} column={data.column} open={data.first?.pouch.id} />}
      >
        {data.first === null ? (
          <EmptyPouches pictures={pictures} />
        ) : (
          <>
            <div className="sk-main sk-first">
              <PouchPane pane={data.first} heading={2} />
            </div>
            {POUCH_BLOTS.map(([file, place]) => (
              <Blot key={place} pictures={pictures} file={file} place={place} />
            ))}
            <Blot pictures={pictures} file="ink-blot-small" place="blot-pouches-small" />
          </>
        )}
      </Frame>
    </ViewPlace>
  );
}

export function PouchView({ pictures }: { pictures: Pictures }) {
  const { id = '' } = useParams();
  const data = useView<PouchData>(`/saeckel/pouches/${id}`);
  const { pouch } = data.pane;
  return (
    <ViewPlace title={`Säckel — ${pouch.name}`}>
      <Frame
        pictures={pictures}
        tab="pouches"
        back={{ href: pouch.archived ? '/saeckel/' : `/saeckel/#pouch-${pouch.id}`, text: 'Мешки' }}
        column={<Column pictures={pictures} column={data.column} current={pouch.id} />}
      >
        <PouchPane pane={data.pane} heading={1} />
        {POUCH_BLOTS.map(([file, place]) => (
          <Blot key={place} pictures={pictures} file={file} place={place} />
        ))}
        <Blot pictures={pictures} file="ink-splatter-b" place="blot-pouch-splatter" />
      </Frame>
    </ViewPlace>
  );
}

export function HistoryView({ pictures }: { pictures: Pictures }) {
  const [params] = useSearchParams();
  const search = params.size === 0 ? '' : `?${params.toString()}`;
  const data = useView<HistoryData>('/saeckel/history', search);
  return (
    <ViewPlace title="Säckel — летопись">
      <Frame pictures={pictures} tab="history">
        {data.empty ? <EmptyHistory pictures={pictures} /> : <HistoryTable data={data} />}
        {!data.empty && (
          <>
            <Blot pictures={pictures} file="ink-blot-medium" place="blot-history-medium" />
            <Blot pictures={pictures} file="ink-splatter-b" place="blot-history-splatter" />
          </>
        )}
      </Frame>
    </ViewPlace>
  );
}

function HistoryTable({ data }: { data: HistoryData }) {
  return (
    <>
      <div className="history-head">
        <h2 className="title t-2 visually-hidden-phone">Летопись</h2>
        <form className="history-filter" method="get" action="/saeckel/history">
          <div className="field">
            <label htmlFor="pouch">Мешок</label>
            <span className="select">
              <select
                id="pouch"
                name="pouch"
                className="input slim"
                defaultValue={data.pouch ?? ''}
              >
                <option value="">Все мешки</option>
                {data.pouches.map((pouch) => (
                  <option key={pouch.id} value={pouch.id}>
                    {pouch.label}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <button type="submit" className="btn">
            Показать
          </button>
        </form>
      </div>
      {data.rows.length > 0 ? (
        <table className="table history">
          <thead>
            <tr>
              <th className="h-date">Дата</th>
              <th className="h-pouch">Мешок</th>
              <th className="h-kind">Запись</th>
              <th className="h-note">Заметка</th>
              <th className="h-sum">Сумма</th>
              <th className="h-go"></th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.id} id={`op-${row.id}`}>
                <td className="h-date">{row.date}</td>
                <td className="h-pouch">
                  {row.pouches}
                  <span className="h-kind-phone"> · {row.phoneKind}</span>
                </td>
                <td className="h-kind">{row.kind}</td>
                <td className="h-note">{row.note}</td>
                <td className={row.expense ? 'h-sum neg' : 'h-sum'}>{row.sum}</td>
                <td className="h-go">
                  <a
                    className="link-plain"
                    href={row.href}
                    aria-label="Открыть запись"
                    aria-describedby={`op-${row.id}`}
                  >
                    ›
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted history-none">{data.none}</p>
      )}
      {(data.previous !== null || data.next !== null) && (
        <nav className="pages" aria-label="Страницы летописи">
          {data.previous !== null && (
            <Link className="btn" to={data.previous} data-fx="page">
              Назад
            </Link>
          )}
          {data.next !== null && (
            <Link className="btn" to={data.next} data-fx="page">
              Следующие 50
            </Link>
          )}
        </nav>
      )}
    </>
  );
}

// Мешки without an active pouch (pouchesPage of M13): the picture with the cat, the text and the
// form of the first pouch, sent by the browser (M14.5).
function EmptyPouches({ pictures }: { pictures: Pictures }) {
  return (
    <>
      <div className="sk-main sk-empty">
        <span className="vignette sniff" aria-hidden="true">
          <img src={pictures.emptySaeckel} alt="" draggable="false" />
          <span className="cat" data-poke="sniff"></span>
        </span>
        <div className="sk-empty-text">
          <h2 className="title">Мешков пока нет</h2>
          <img className="sprig" src={pictures.sprig} alt="" draggable="false" />
          <p className="muted">
            Заведите первый мешок: «Продукты», «Квартира», «Транспорт». Траты берутся из мешка, а
            остаток переходит дальше сам.
          </p>
          <form className="new-pouch" method="post" action="/saeckel/pouches/new">
            <div className="field">
              <label htmlFor="name">Название</label>
              <input id="name" className="input" name="name" type="text" required defaultValue="" />
            </div>
            <fieldset className="signs">
              <legend>Знак мешка</legend>
              <div className="icons">
                {pictures.signs.map((sign) => (
                  <label key={sign.key} className="icon-pick">
                    <input type="radio" name="icon" value={sign.key} defaultChecked={sign.chosen} />
                    <img src={sign.src} alt="" draggable="false" /> {sign.word}
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" className="btn btn-ochre">
              Завести мешок
            </button>
          </form>
        </div>
      </div>
      <img className="sk-corner" src={pictures.corner} alt="" draggable="false" loading="lazy" />
      <Blot pictures={pictures} file="ink-blot-medium" place="blot-empty-medium" />
    </>
  );
}

// Летопись without a record (historyPage of M13): the closed book and the ways to begin.
function EmptyHistory({ pictures }: { pictures: Pictures }) {
  return (
    <>
      <div className="sk-empty history-empty">
        <img className="vignette" src={pictures.emptyHistory} alt="" draggable="false" />
        <div className="sk-empty-text">
          <h2 className="title">Летопись пока пуста</h2>
          <img className="sprig" src={pictures.sprig} alt="" draggable="false" />
          <p className="muted">
            Сюда ляжет каждый доход, трата и перекладывание — по порядку, с датой и заметкой.
          </p>
          <p className="empty-actions">
            <a className="btn btn-ochre" href="/saeckel/income">
              Записать доход
            </a>{' '}
            <Link className="link" to="/saeckel/">
              К мешкам
            </Link>
          </p>
        </div>
      </div>
      <img className="sk-corner" src={pictures.corner} alt="" draggable="false" loading="lazy" />
      <Blot pictures={pictures} file="ink-blot-small" place="blot-history-empty" />
    </>
  );
}
