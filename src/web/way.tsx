// Prototype B of M14: the way between the views. The address changes at once (a link or Back), the
// view shown stays until the data of the next one has come from the server, then both change
// together. One mechanism for links, Back and Forward; a newer move cancels the request of an
// older one. An error of the data: 401 → the session is over, a full load leads to the sign-in;
// anything else → the browser loads the address itself and draws the page of the server.

import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, type Location } from 'react-router';
import { freshView, queryClient, SessionOver, viewQuery } from './queries.ts';

function loadByBrowser(location: Location) {
  window.location.assign(location.pathname + location.search + location.hash);
}

export function useShownLocation(): Location {
  const location = useLocation();
  const [shown, setShown] = useState(location);

  useEffect(() => {
    if (location.key === shown.key) return;
    const query = viewQuery(location.pathname, location.search);
    if (query === null) {
      loadByBrowser(location);
      return;
    }
    const cancel = new AbortController();
    freshView(query, cancel.signal).then(
      () => setShown(location),
      (error: unknown) => {
        if (cancel.signal.aborted) return;
        if (error instanceof SessionOver) {
          void queryClient.cancelQueries();
          queryClient.clear();
        }
        loadByBrowser(location);
      },
    );
    return () => cancel.abort();
  }, [location, shown.key]);

  return shown;
}

// The title, the scroll and the focus of a view that has just been put in place.
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
