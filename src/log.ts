// Server log (ARCHITECTURE.md §4.10): one line per event on stdout, `level event key=value ...`.
// A value with spaces, quotes or non-ASCII characters is written as a JSON string,
// so no value can break the line.

type LogLevel = 'info' | 'warn' | 'error';

export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, string | number> = {},
): void {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${formatLogValue(value)}`);
  console.log([level, event, ...pairs].join(' '));
}

// The message of an error for a log line or an operator, without the rest of the object: a
// DatabaseError keeps detail, where and the connected client beside the message. A refused
// connection to every address of `localhost` (::1 and 127.0.0.1) arrives as an AggregateError
// with an empty message; its inner errors say what happened.
export function describeError(error: unknown): string {
  if (error instanceof AggregateError && !error.message) {
    return error.errors.map((inner: unknown) => describeError(inner)).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function formatLogValue(value: string | number): string {
  const text = String(value);
  return /^[!-~]+$/.test(text) && !text.includes('"') ? text : JSON.stringify(text);
}
