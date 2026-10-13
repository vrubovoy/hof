// The password reset (ARCHITECTURE.md §4.2, §4.8): one transaction shared by the maintenance CLI
// and «Приближённые». The caller has already found the user, checked the new password and made
// its hash; this function only writes, and decides nothing.

import type { Pool } from 'pg';

// The new hash first, then the end of every session of the user, in one transaction. UPDATE
// takes the row lock of the user. A sign-in or a change of one's own password holds that lock
// with FOR UPDATE from its check to its COMMIT, so the reset either waits for it and then
// deletes the session it made, or goes first and makes it fail its check. The other way round,
// DELETE would not see the session of a sign-in that has not committed yet. Another reset
// waits on the same lock. Returns how many sessions were ended.
export async function resetPassword(
  pool: Pool,
  userId: number,
  passwordHash: string,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    const ended = await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await client.query('COMMIT');
    return ended.rowCount ?? 0;
  } catch (error) {
    // The connection may already be broken; the original error matters more.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
