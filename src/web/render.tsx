// Prototype B of M14: the tests of the views (src/saeckel/test-helpers.ts) draw a view to HTML on
// the server side with react-dom/server — the same components, the data of the shell — so that
// the tests of the pages of M13 read the markup of the React views. Not in the bundle of the
// browser: the tests bundle this file for Node with esbuild.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ViewData } from '../saeckel/data.ts';
import { viewQuery } from './queries.ts';
import { HistoryView, PouchesView, PouchView, type Pictures } from './saeckel.tsx';

export function renderView(url: string, data: ViewData, pictures: Pictures): string {
  const address = new URL(url, 'http://hof.test');
  const client = new QueryClient();
  const query = viewQuery(address.pathname, address.search);
  if (query !== null) client.setQueryData(query.key, data.data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[address.pathname + address.search + address.hash]}>
        <Routes>
          <Route path="/saeckel/" element={<PouchesView pictures={pictures} />} />
          <Route path="/saeckel/pouches/:id" element={<PouchView pictures={pictures} />} />
          <Route path="/saeckel/history" element={<HistoryView pictures={pictures} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
