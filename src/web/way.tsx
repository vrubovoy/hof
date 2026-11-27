// Prototype B of M14: the way between the views. The address changes at once (a link or Back); the
// view shown stays until the data of the next one has come from the server and, after a link with
// data-fx, the page has turned away (SLIDE_MS) — the request and the animation run together.
// Then the next view comes in, sliding from the side the page turned to. One mechanism for links,
// Back and Forward; a newer move cancels the request of an older one. An error of the data:
// 401 → the session is over, a full load leads to the sign-in; anything else → the browser loads
// the address itself and draws the page of the server.
//
// The classes are those of M13 (hof.css, saeckel.css): go-left/go-right while the page turns away,
// from-right/from-left while the next one comes in; fx-head.js ends them with the veil
// (animationend veil-out). Only with «Анимации» (fx-on on <html>, set by fx-head.js and fx.js).

import { useEffect, useState, type ReactNode } from 'react';
import { NavigationType, useLocation, useNavigationType, type Location } from 'react-router';
import { freshView, queryClient, SessionOver, viewQuery } from './queries.ts';

// As SLIDE_MS of fx.js: how long the page turns away.
const SLIDE_MS = 500;
const AWAY = { 'flip-fwd': 'go-left', 'flip-back': 'go-right' } as const;
const ARRIVE = { 'go-left': 'from-right', 'go-right': 'from-left' } as const;
const phone = matchMedia('(max-width: 1023.98px)');

// The data-fx of the link pressed last, read when the address it leads to comes: a plain press on
// a link of the views, caught before React Router takes it.
let pressed: { fx: string | undefined; at: number } | null = null;
document.addEventListener(
  'click',
  (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link instanceof HTMLAnchorElement && event.button === 0) {
      pressed = { fx: link.dataset.fx, at: performance.now() };
    }
  },
  { capture: true },
);

function awayClass(): 'go-left' | 'go-right' | null {
  const press = pressed;
  pressed = null;
  if (press === null || performance.now() - press.at > 1000) return null;
  if (!document.documentElement.classList.contains('fx-on')) return null;
  const fx = press.fx === 'flip-fwd-phone' ? (phone.matches ? 'flip-fwd' : undefined) : press.fx;
  return fx === 'flip-fwd' || fx === 'flip-back' ? AWAY[fx] : null;
}

function loadByBrowser(location: Location) {
  window.location.assign(location.pathname + location.search + location.hash);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useShownLocation(): Location {
  const location = useLocation();
  const type = useNavigationType();
  const [shown, setShown] = useState(location);

  useEffect(() => {
    if (location.key === shown.key) return;
    const query = viewQuery(location.pathname, location.search);
    if (query === null) {
      loadByBrowser(location);
      return;
    }
    const root = document.documentElement;
    const away = type === NavigationType.Push ? awayClass() : null;
    if (away !== null) root.classList.add(away);
    const cancel = new AbortController();
    Promise.all([freshView(query, cancel.signal), away === null ? null : sleep(SLIDE_MS)]).then(
      () => {
        if (cancel.signal.aborted) return;
        if (away !== null) root.classList.replace(away, ARRIVE[away]);
        setShown(location);
      },
      (error: unknown) => {
        if (cancel.signal.aborted) return;
        if (error instanceof SessionOver) {
          void queryClient.cancelQueries();
          queryClient.clear();
        }
        loadByBrowser(location);
      },
    );
    return () => {
      cancel.abort();
      if (away !== null) root.classList.remove(away);
    };
  }, [location, type, shown.key]);

  return shown;
}

// The title, the scroll and the focus of a view that has just been put in place; the mark
// hof:view of the measurement, taken away at once so that marks do not pile up in one document
// (M14.2, the journal of Turbo, item 16).
export function ViewPlace({ title, children }: { title: string; children: ReactNode }) {
  const location = useLocation();
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => {
    if (location.hash === '') window.scrollTo(0, 0);
    else document.getElementById(location.hash.slice(1))?.scrollIntoView();
    performance.mark('hof:view');
    performance.clearMarks('hof:view');
  }, [location.key, location.hash]);
  return children;
}
