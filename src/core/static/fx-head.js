// Hof — before the first paint (ARCHITECTURE.md §6). An ordinary script in <head>: what it puts
// on <html> is there before the browser draws the page. Without this file, or without the
// storage, the court stays still and every page simply appears.
//
// The class `fx-on` turns the animations of the CSS on. It is set only when «Анимации» are on on
// this device and the system does not ask for less motion.
//
// How this page arrives after the last one (M10.2). fx.js of the last page leaves one of two flags
// in sessionStorage; both are read here once and are gone:
// - `hof.arrive = {fx, to, at, keep}` — a link with data-fx was pressed. It counts only for a new
//   navigation (not a reload, not Back or Forward) to the address the link named, within 30 s.
// - `hof.after = {act, action, at}` — a form with data-fx was sent. It counts only within 30 s,
//   for a new navigation that came by a redirect, to an address the act leads to — never the
//   address of the form itself, where 400, 403 and 500 are drawn — and on a page that shows what
//   the act shows. A redirect alone proves nothing; without it, or where the browser does not say,
//   the page comes without an effect.
// What arrived is left for fx.js in `data-arrived` (the sound of a page is its own); the classes
// of the arrival go when its animation ends.
//
// Through a door of the courtyard (M10.3) a page comes out of the dark (from-door). After the
// sign-in and the founding (M10.4) the courtyard comes out of the dark and the banner unrolls
// (unroll); after «Забрать ключ» the key fades into the empty hook (key-off). After an expense of
// Säckel (M10.5) its record is written in and the sign of the pouch squeezed (spent); an income,
// laying out and a transfer only ring.
//
// A page of the book (flip-fwd, flip-back) comes as a slide the same way, in every browser: with
// View Transitions between documents Chrome turns a blank sheet instead of a page sent with
// `Cache-Control: no-store` (§4.9), so Hof does not use them.
(() => {
  const root = document.documentElement;
  const FRESH = 30_000;
  // The acts of forms: the address of the form (a pattern), the addresses it leads to and what
  // that page shows — both may depend on the address of the form — and the way the page arrives:
  // as fx of a link (fx) or classes of its own (arrive). A page with nothing to show has no marker
  // (null): only the redirect and the address count.
  /** @type {Record<string, { action: RegExp, leads: (path: string, match: RegExpExecArray) => boolean, marker: (match: RegExpExecArray) => string | null, fx?: string, arrive?: string }>} */
  const AFTER = {
    logout: {
      action: /^\/logout$/,
      leads: (path) => path === '/login',
      marker: () => 'form[action="/login"]',
      fx: 'right',
    },
    // Signed in, or the court founded: the banner is drawn only for a person signed in, so a way
    // on to a page without it (`next` of Säckel) comes without an effect.
    login: {
      action: /^\/login$/,
      leads: (path) => path !== '/login' && path !== '/setup',
      marker: () => '.banner',
      arrive: 'from-door unroll',
    },
    setup: {
      action: /^\/setup$/,
      leads: (path) => path === '/',
      marker: () => '.banner',
      arrive: 'from-door unroll',
    },
    // «Забрать ключ»: the card of the same person, now with «Вернуть ключ».
    key: {
      action: /^\/admin\/users\/(\d+)\/disable$/,
      leads: (path, [, id]) => path === `/admin/users/${id}`,
      marker: ([, id]) => `form[action="/admin/users/${id}/enable"]`,
      arrive: 'key-off',
    },
    // Money of Säckel written (M10.5). An expense: the page of the same pouch with the record just
    // written marked (`?fresh`, only a record shown is marked). An income: «Разложить» with the
    // note of that income. Laying out and a transfer: Мешки — the server answers so only after
    // their records are committed; «В кладовую», the other way there, is a form of its own and
    // takes the flag away.
    expense: {
      action: /^\/saeckel\/pouches\/(\d+)\/expense$/,
      leads: (path, [, id]) => path === `/saeckel/pouches/${id}`,
      marker: () => 'mark.move',
      arrive: 'spent',
    },
    income: {
      action: /^\/saeckel\/income$/,
      leads: (path) => path === '/saeckel/assign',
      marker: () => '.note-income',
    },
    assign: {
      action: /^\/saeckel\/assign$/,
      leads: (path) => path === '/saeckel/',
      marker: () => null,
    },
    transfer: {
      action: /^\/saeckel\/transfer$/,
      leads: (path) => path === '/saeckel/',
      marker: () => null,
    },
  };
  // fx of the last page → the class of the arrival; the rustle of a page has none.
  const ARRIVE = {
    left: 'from-right',
    right: 'from-left',
    'flip-fwd': 'from-right',
    'flip-back': 'from-left',
    page: null,
    door: 'from-door',
  };

  let move = false;
  try {
    const settings = JSON.parse(localStorage.getItem('hof.fx') ?? 'null');
    move = settings?.anim === true && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // No storage (a private window) or a broken value: no animations.
  }
  if (move) root.classList.add('fx-on');

  /** @param {string} key */
  const take = (key) => {
    try {
      const value = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      return JSON.parse(value ?? 'null');
    } catch {
      return null;
    }
  };
  const link = take('hof.arrive');
  const form = take('hof.after');
  let entry;
  try {
    entry = performance.getEntriesByType('navigation')[0];
  } catch {
    entry = undefined;
  }
  const navigated = entry?.type === 'navigate';
  /** @param {unknown} at */
  const fresh = (at) => typeof at === 'number' && Date.now() - at >= 0 && Date.now() - at <= FRESH;

  /** @type {string | null} */
  let arrived = null;
  /** @type {string | null} */
  let fx = null;
  /** The classes of the arrival of a form. @type {string | null} */
  let arrive = null;
  let keep = false;
  /** @type {string | null} */
  let marker = null;
  if (
    navigated &&
    Object.hasOwn(ARRIVE, link?.fx) &&
    fresh(link.at) &&
    link.to === location.origin + location.pathname + location.search
  ) {
    arrived = fx = link.fx;
    keep = link.keep === true;
  }
  const row = Object.hasOwn(AFTER, form?.act) ? AFTER[form.act] : null;
  const match =
    row !== null && typeof form.action === 'string' ? row.action.exec(form.action) : null;
  if (
    row !== null &&
    match !== null &&
    navigated &&
    (entry?.redirectCount ?? 0) >= 1 &&
    fresh(form.at) &&
    location.pathname !== form.action &&
    row.leads(location.pathname, match)
  ) {
    arrived = form.act;
    fx = row.fx ?? null;
    arrive = row.arrive ?? null;
    keep = false;
    marker = row.marker(match);
  }

  const ARRIVALS = [
    'from-left',
    'from-right',
    'from-door',
    'keep-banner',
    'unroll',
    'key-off',
    'spent',
  ];
  /** @param {string[]} names */
  const end = (names) => root.classList.remove(...names);
  if (arrived !== null) {
    root.dataset.arrived = arrived;
    const cls = !move ? null : fx !== null ? ARRIVE[fx] : arrive;
    if (cls !== null) root.classList.add(...cls.split(' '));
    if (cls !== null && keep) root.classList.add('keep-banner');
  }
  // What the act shows is checked when the page is parsed, or at its first frame if the browser
  // draws it sooner: not there yet — no effect.
  if (marker !== null) {
    let checked = false;
    const check = () => {
      if (checked) return;
      checked = true;
      if (document.querySelector(marker) !== null) return;
      end(ARRIVALS);
      delete root.dataset.arrived;
    };
    document.addEventListener('readystatechange', check, { once: true });
    requestAnimationFrame(check);
  }
  // The slide in and the way out of the dark end with their veil (both CSS files name the
  // animation so); the banner unrolled ends with its last swing — on the phone, without the
  // banner, with the veil; the key with its fading; an expense with the pen mark of its record,
  // which comes when the last cell is written.
  document.addEventListener('animationend', (event) => {
    if (event.animationName === 'veil-out') {
      end(['from-left', 'from-right', 'from-door', 'keep-banner']);
      if (!document.querySelector('.banner')?.getClientRects().length) end(['unroll']);
    }
    if (event.animationName === 'fx-settle') end(['unroll']);
    if (event.animationName === 'key-off') end(['key-off']);
    if (event.animationName === 'fx-mark') end(['spent']);
  });
})();
