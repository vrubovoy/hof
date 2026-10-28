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
// Through a door of the courtyard (M10.3) a page comes out of the dark (from-door).
//
// A page of the book (flip-fwd, flip-back) comes as a slide the same way, in every browser: with
// View Transitions between documents Chrome turns a blank sheet instead of a page sent with
// `Cache-Control: no-store` (§4.9), so Hof does not use them.
(() => {
  const root = document.documentElement;
  const FRESH = 30_000;
  // The acts of forms: the address of the form, where it leads, what that page shows, and the way
  // the page arrives (as fx of a link). M10.4 and M10.5 add theirs.
  const AFTER = {
    logout: {
      action: '/logout',
      results: ['/login'],
      marker: 'form[action="/login"]',
      fx: 'right',
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
  if (
    row !== null &&
    navigated &&
    (entry?.redirectCount ?? 0) >= 1 &&
    fresh(form.at) &&
    form.action === row.action &&
    location.pathname !== row.action &&
    row.results.includes(location.pathname)
  ) {
    arrived = form.act;
    fx = row.fx;
    keep = false;
    marker = row.marker;
  }

  const end = () => root.classList.remove('from-left', 'from-right', 'from-door', 'keep-banner');
  if (arrived !== null) {
    root.dataset.arrived = arrived;
    const cls = move && fx !== null ? ARRIVE[fx] : null;
    if (cls !== null) root.classList.add(cls);
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
      end();
      delete root.dataset.arrived;
    };
    document.addEventListener('readystatechange', check, { once: true });
    requestAnimationFrame(check);
  }
  // The slide in and the way out of the dark end with their veil (both CSS files name the
  // animation so).
  document.addEventListener('animationend', (event) => {
    if (event.animationName === 'veil-out') end();
  });
})();
