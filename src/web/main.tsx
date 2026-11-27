// Prototype B of M14 (Issue #167): the React views of the way through Säckel in one document —
// React 19, React Router 7 in its declarative mode, TanStack Query 5, bundled by src/build.ts.
// The server draws the shell of a view address with the data of that view embedded
// (src/saeckel/data.ts); from then on the views ask the JSON reads of Säckel. Any other address —
// the courtyard, forms, records, the sign-in — the browser opens itself.

import { QueryClientProvider } from '@tanstack/react-query';
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import type { ViewData } from '../saeckel/data.ts';
import { queryClient, viewQuery } from './queries.ts';
import { HistoryView, PouchesView, PouchView, type Pictures } from './saeckel.tsx';
import { listenForPresses, useShownLocation } from './way.tsx';

function embedded<T>(id: string): T {
  return JSON.parse(document.getElementById(id)!.textContent) as T;
}

// A view that fails to draw: the browser loads the address itself, and the server draws its page
// or its error page (500 «Попробовать ещё раз»). Nothing half drawn stays.
class FullLoadOnError extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    window.location.reload();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Views({ pictures }: { pictures: Pictures }) {
  const shown = useShownLocation();
  return (
    <Routes location={shown}>
      <Route path="/saeckel/" element={<PouchesView pictures={pictures} />} />
      <Route path="/saeckel/pouches/:id" element={<PouchView pictures={pictures} />} />
      <Route path="/saeckel/history" element={<HistoryView pictures={pictures} />} />
    </Routes>
  );
}

listenForPresses();
const first = embedded<ViewData>('hof-data');
const query = viewQuery(location.pathname, location.search);
if (query !== null) queryClient.setQueryData(query.key, first.data);

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <FullLoadOnError>
          <Views pictures={embedded<Pictures>('hof-pictures')} />
        </FullLoadOnError>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
