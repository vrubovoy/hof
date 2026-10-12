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

function formatLogValue(value: string | number): string {
  const text = String(value);
  return /^[!-~]+$/.test(text) && !text.includes('"') ? text : JSON.stringify(text);
}
