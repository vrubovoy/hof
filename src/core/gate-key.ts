// First run (ARCHITECTURE.md §4.4): the gate key and whether the court is founded.
//
// While there is no administrator, every process start makes a new gate key and writes it to
// the log once; whoever deployed Hof reads it there. The key lives only in this process's
// memory: no table, no timer, no attempt counter. Founding the court destroys it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { log } from '../log.ts';

// Crockford base32: digits and Latin letters without I, L, O and U.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_SYMBOLS = 20; // 5 bits each: 100 bits
const RANDOM_BYTES = 13; // 104 bits, the last 4 are not used

// A new key: 20 symbols without hyphens. `bytes` are the random source; tests pass their own
// to check how the bits turn into symbols.
export function newGateKey(bytes: Buffer = randomBytes(RANDOM_BYTES)): string {
  if (bytes.length !== RANDOM_BYTES) throw new Error(`gate key needs ${RANDOM_BYTES} bytes`);
  // The first 100 of the 104 bits, as one number. Every 5 bits are one symbol: 32 = 2^5,
  // so each symbol is exactly as likely as any other — no modulo, no bias.
  let value = BigInt(`0x${bytes.toString('hex')}`) >> 4n;
  const symbols: string[] = [];
  for (let i = 0; i < KEY_SYMBOLS; i++) {
    symbols.unshift(ALPHABET[Number(value & 0b11111n)]!);
    value >>= 5n;
  }
  return symbols.join('');
}

// XXXXX-XXXXX-XXXXX-XXXXX, as the log shows it.
export function formatGateKey(key: string): string {
  return key.match(/.{5}/g)!.join('-');
}

// Typed input → the 20 symbols, or null if it cannot be a key (§4.7): spaces and hyphens
// are dropped, case does not matter, and what is left must be exactly 20 alphabet symbols.
export function normalizeGateKey(input: string): string | null {
  const key = input.replace(/[\s-]/g, '').toUpperCase();
  if (key.length !== KEY_SYMBOLS || ![...key].every((c) => ALPHABET.includes(c))) return null;
  return key;
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

async function administratorExists(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM users WHERE is_admin) AS exists',
  );
  return rows[0]?.exists === true;
}

export interface FirstRun {
  // Whether the court is founded. While the answer is "no", it is read from the database
  // every time; the first "yes" is remembered, because the administrator cannot be removed.
  isFounded(): Promise<boolean>;
  // Whether the typed input is the gate key. Always false once the court is founded.
  keyMatches(input: string): boolean;
  // The court is founded: remember it and destroy the key. Called only after the
  // founding transaction has committed.
  markFounded(): void;
}

// Startup step, after migrations and before the HTTP port opens. Without an administrator
// it makes the gate key and writes it to the log; that is the only place the key appears.
export async function startFirstRun(pool: Pool): Promise<FirstRun> {
  let founded = await administratorExists(pool);
  // Only the SHA-256 of the key stays in memory; the key itself goes to the log and is gone.
  let keyHash: Buffer | null = null;
  if (!founded) {
    const key = newGateKey();
    keyHash = sha256(key);
    log('info', 'gate_key', { key: formatGateKey(key) });
  }

  function markFounded(): void {
    founded = true;
    keyHash = null;
  }

  return {
    async isFounded() {
      if (!founded && (await administratorExists(pool))) markFounded();
      return founded;
    },
    keyMatches(input) {
      const key = normalizeGateKey(input);
      if (founded || keyHash === null || key === null) return false;
      // Both sides are SHA-256 digests: equal length for timingSafeEqual whatever was typed.
      return timingSafeEqual(sha256(key), keyHash);
    },
    markFounded,
  };
}
