// Server-side sessions (ARCHITECTURE.md §4.2, §5.3).
//
// The browser keeps a random token in the cookie; the database keeps only the SHA-256 of that
// cookie string. A session is valid while its row exists, has not expired and its user is
// not disabled — checked on every request by one query in currentUser.

import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export const SESSION_COOKIE = '__Host-hof';

// 30 days from sign-in, absolute: the same number for the cookie and for the database row.
const SESSION_SECONDS = 30 * 24 * 60 * 60;

// 32 random bytes in base64url without padding are exactly 43 of these characters.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export interface CurrentUser {
  id: number;
  username: string;
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

// The hash of the cookie string itself — the exact text the browser sends back.
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

// Value of the Set-Cookie header for a new session.
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

// Value of the Set-Cookie header that removes the session cookie: the same name and attributes,
// an empty value and Max-Age=0.
export const CLEARED_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

// Creates a session row inside the caller's open transaction and returns the cookie token.
// No BEGIN or COMMIT here: the caller commits the session together with the rest of its work.
export async function createSession(client: PoolClient, userId: number): Promise<string> {
  const token = newSessionToken();
  await client.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 second')",
    [hashSessionToken(token), userId, SESSION_SECONDS],
  );
  return token;
}

// Deletes the session of this cookie value, if there is one: on sign-out, and inside the sign-in
// transaction for the session the browser had before. A value of the wrong form is no session
// at all: the database is not asked.
export async function deleteSession(
  db: Pool | PoolClient,
  token: string | undefined,
): Promise<void> {
  if (token === undefined || !TOKEN_FORMAT.test(token)) return;
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)]);
}

// The user of the session cookie, or null. `token` is the cookie value, if the request has one.
// A value of the wrong form is no session at all: the database is not asked.
export async function currentUser(
  pool: Pool,
  token: string | undefined,
): Promise<CurrentUser | null> {
  if (token === undefined || !TOKEN_FORMAT.test(token)) return null;
  const { rows } = await pool.query<CurrentUser>(
    `SELECT users.id, users.username
       FROM sessions
       JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = $1
        AND sessions.expires_at > now()
        AND NOT users.is_disabled`,
    [hashSessionToken(token)],
  );
  return rows[0] ?? null;
}
