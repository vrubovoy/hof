// Hof — the way between the views in one document, prototype A of M14 (Issue #165): Turbo Drive
// (vendor/turbo-8.0.23.js, the file of the release as it is) and only the glue it needs. Never
// merged into main: the comparison of M14.6 decides.
//
// Turbo follows a link to one of the views of DRIVEN (Двор, Мешки, a pouch, Летопись) in this
// document: it asks the server for the page, as the browser would, and puts its <body> in place of
// this one. Any other address — the pages not moved yet, the sign-in and the way out — is opened by
// the browser itself, as before. Forms are the browser's too (M14.3 moves them). The music, the
// AudioContext and every script stay alive between the views; fx.js keeps the effects of a view
// to its view (turbo:render) and asks for the render to wait for the animation of the way away.
//
// The glue (the journal of Turbo in docs/OPERATIONS.md, «Прототип A»):
// - the views of DRIVEN only: turbo:click of any other address is let go to the browser, and a
//   response that ends on one (a redirect to the sign-in when the session is over) is loaded by
//   the browser;
// - the stylesheet of a module (hof.css, saeckel.css) changes with the <body> that names it: they
//   share class names and both style <html> and <body>, so the two never apply at once. Turbo puts
//   the stylesheet of the next page into <head> before it lets the page hold the render; here it
//   waits switched off (media) and is switched on in the same task as the <body> is put in place;
//   the other one goes;
// - the render of a view waits for the animation of the way away when fx.js asks (hold): Turbo
//   asks the server at once, the page is put in place when both are over. A render held while
//   another visit starts (a second press, Back) is let go at once and puts nothing in place: Turbo
//   renders one page after another, and the next would wait for it;
// - a view put in place says so: performance.mark('hof:view') (src/measure.ts);
// - a page of a view back from the back/forward cache shows what it showed before: it is hidden as
//   it is put away and asked for again when it comes back.
// Turbo settings: no form, no progress bar (its <style> is inline, which the CSP refuses), no
// prefetch (meta turbo-prefetch), no snapshot cache (meta turbo-cache-control): Back and Forward
// always ask the server.

/**
 * The views Turbo opens in this document: their paths. A query (Летопись, its pages) is the
 * view's own.
 */
export const DRIVEN = Object.freeze([
  /^\/$/,
  /^\/saeckel\/$/,
  /^\/saeckel\/pouches\/[1-9]\d*$/,
  /^\/saeckel\/history$/,
]);

/**
 * Whether Turbo opens an address in this document: one of DRIVEN on this origin.
 * @param {string} href
 * @param {string} origin the origin of this page
 */
export function drives(href, origin) {
  let url;
  try {
    url = new URL(href, origin);
  } catch {
    return false;
  }
  return url.origin === origin && DRIVEN.some((path) => path.test(url.pathname));
}

/**
 * What changes in <head> when a view whose page names the stylesheet `wanted` is put in place:
 * which stylesheet is switched on and which go. Without `wanted` (a page that names none) nothing
 * changes.
 * @param {readonly string[]} sheets the href of every stylesheet in <head>
 * @param {string | undefined} wanted
 * @returns {{ on: string | null, off: string[] }}
 */
export function sheetSwap(sheets, wanted) {
  if (wanted === undefined || !sheets.includes(wanted)) return { on: null, off: [] };
  return { on: wanted, off: sheets.filter((href) => href !== wanted) };
}

/** Longer than any visit: Turbo's progress bar is never shown. */
const NEVER_MS = 2_147_483_647;

function start() {
  const Turbo = /** @type {any} */ (window).Turbo;
  if (Turbo === undefined) return;
  Turbo.config.forms.mode = 'off';
  Turbo.config.drive.progressBarDelay = NEVER_MS;
  /** @param {string} href */
  const driven = (href) => drives(href, location.origin);
  // The render of the next visit waits until then (fx.js: the way away by a link).
  let holdUntil = 0;
  /** A render that waits now. @type {{ resume: () => void, timer: ReturnType<typeof setTimeout> } | null} */
  let held = null;
  // Renders let go for a visit no longer wanted: they put nothing in place, and their turbo:render
  // reaches nobody.
  let skips = 0;
  let muted = false;
  /** @type {any} */ (window).hofDrive = Object.freeze({
    drives: driven,
    /** @param {number} ms */
    hold: (ms) => {
      holdUntil = Date.now() + ms;
    },
  });
  document.addEventListener('turbo:visit', () => {
    if (held === null) return;
    clearTimeout(held.timer);
    const { resume } = held;
    held = null;
    skips += 1;
    resume();
  });

  document.addEventListener('turbo:click', (event) => {
    if (!driven(/** @type {CustomEvent} */ (event).detail.url)) event.preventDefault();
  });
  document.addEventListener('turbo:before-fetch-response', (event) => {
    const response = /** @type {CustomEvent} */ (event).detail.fetchResponse;
    const where = String(response.location);
    if (driven(where)) return;
    event.preventDefault();
    location.assign(where);
  });

  // A stylesheet Turbo puts into <head> waits switched off until its <body> comes.
  const sheets = () =>
    /** @type {HTMLLinkElement[]} */ ([
      ...document.head.querySelectorAll('link[rel="stylesheet"]'),
    ]);
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLLinkElement && node.rel === 'stylesheet') node.media = 'not all';
      }
    }
  }).observe(document.head, { childList: true });
  document.addEventListener('turbo:before-render', (event) => {
    const detail = /** @type {CustomEvent} */ (event).detail;
    const wanted = /** @type {HTMLBodyElement} */ (detail.newBody).dataset.css;
    const render = detail.render;
    detail.render = (/** @type {Element} */ current, /** @type {Element} */ next) => {
      if (skips > 0) {
        skips -= 1;
        muted = true;
        return;
      }
      const all = sheets();
      const { on, off } = sheetSwap(
        all.map((link) => link.getAttribute('href') ?? ''),
        wanted,
      );
      for (const link of all) {
        const href = link.getAttribute('href');
        if (href === on) link.removeAttribute('media');
        else if (off.includes(href ?? '')) link.remove();
      }
      return render(current, next);
    };
    const wait = holdUntil - Date.now();
    holdUntil = 0;
    if (wait <= 0) return;
    event.preventDefault();
    held = {
      resume: detail.resume,
      timer: setTimeout(() => {
        held = null;
        detail.resume();
      }, wait),
    };
  });

  // Before anybody else hears it: a render that put nothing in place is not a view.
  addEventListener(
    'turbo:render',
    (event) => {
      if (muted) {
        muted = false;
        event.stopImmediatePropagation();
        return;
      }
      performance.mark('hof:view');
    },
    true,
  );

  addEventListener('pagehide', (event) => {
    if (event.persisted && driven(location.href)) document.body.style.visibility = 'hidden';
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted && driven(location.href)) Turbo.visit(location.href, { action: 'replace' });
  });
}

if (typeof document !== 'undefined') start();
