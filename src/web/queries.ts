// Prototype B of M14: the data of the views — one QueryClient, by the rules for money of the plan
// of M14: nothing optimistic, nothing kept between visits (no persist), no retries, requests even
// when the browser thinks it is offline, and data always asked again before a view is shown.

import { QueryClient } from '@tanstack/react-query';
import type { HistoryData, PouchData, PouchesData } from '../saeckel/data.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, networkMode: 'always', staleTime: 0, refetchOnWindowFocus: false },
    mutations: { retry: false, networkMode: 'always' },
  },
});

// The session is over (401): what is in memory goes, and the browser loads the address itself —
// the server leads it to the sign-in.
export class SessionOver extends Error {}
export class NotFound extends Error {}
// The server serves another bundle than this page runs (a new version is out): the browser loads
// the next page whole, with the new bundle.
export class Outdated extends Error {}

const ownBundle = document
  .querySelector<HTMLScriptElement>('script[src*="/build/app.js"]')
  ?.getAttribute('src');

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const bundle = response.headers.get('Hof-Bundle');
  if (bundle !== null && bundle !== ownBundle) throw new Outdated();
  if (response.status === 401) throw new SessionOver();
  if (response.status === 404) throw new NotFound();
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as T;
}

// A view of the way and its data: the key in the cache and where the JSON comes from.
export type ViewQuery =
  | { view: 'pouches'; key: readonly unknown[]; url: string }
  | { view: 'pouch'; key: readonly unknown[]; url: string }
  | { view: 'history'; key: readonly unknown[]; url: string };

// The address of a page → the query of its view; null for an address the views do not have
// (the browser opens it itself).
export function viewQuery(pathname: string, search: string): ViewQuery | null {
  if (pathname === '/saeckel/')
    return { view: 'pouches', key: ['pouches'], url: '/saeckel/data/pouches' };
  const pouch = /^\/saeckel\/pouches\/(\d+)$/.exec(pathname);
  if (pouch) {
    return { view: 'pouch', key: ['pouch', pouch[1]], url: `/saeckel/data/pouches/${pouch[1]}` };
  }
  if (pathname === '/saeckel/history') {
    return { view: 'history', key: ['history', search], url: `/saeckel/data/history${search}` };
  }
  return null;
}

// Fresh data of a view, from the server, whatever the cache holds: fetchQuery with staleTime 0
// asks every time (ensureQueryData would give what is cached). The signal cancels it when the
// person goes elsewhere first.
export function freshView(query: ViewQuery, signal: AbortSignal) {
  return queryClient.fetchQuery({
    queryKey: query.key,
    queryFn: () => readJson<unknown>(query.url, signal),
    staleTime: 0,
  });
}

export type { HistoryData, PouchData, PouchesData };
