// The login rule (ARCHITECTURE.md §4.7, §5.2), for the forms of Core and the maintenance CLI.

// Trimmed and lower-cased; a letter or digit first, then letters, digits, ".", "_", "-"; at most
// 32 characters. The same rule as the CHECK on users.username.
export function parseUsername(input: string): string | null {
  const username = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(username) ? username : null;
}
