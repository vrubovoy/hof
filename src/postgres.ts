// Broken PostgreSQL connections must not end the process (ARCHITECTURE.md §4.10): a restart or
// an outage of the database ends every open connection, and in `pg` each of them reports it as
// an `error` event. An event with no listener throws, and that ends the Node process.
// Used by the server and the maintenance CLI, right after their pool is made.

import type { Pool } from 'pg';
import { describeError, log } from './log.ts';

export function handleConnectionErrors(pool: Pool): void {
  // An idle client breaks: the pool has already removed it, and the next connect() or query()
  // opens a new connection. Nobody else hears of this error, so it is written to the log.
  pool.on('error', (error) => {
    log('error', 'db_pool_error', { error: describeError(error) });
  });

  // A client handed out by pool.connect() breaks: while it is out, the pool keeps no listener on
  // it. This one stays on every client from its first connection. It writes nothing on purpose:
  // the query in progress, or the next one, fails with the same error, and the caller reports it
  // — the HTTP request through onError (500, unexpected_error), the CLI through its own message.
  // For an idle client the event above reports it once.
  pool.on('connect', (client) => {
    client.on('error', () => undefined);
  });
}
