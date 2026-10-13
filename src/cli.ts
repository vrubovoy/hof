// Maintenance commands, run on the server (ARCHITECTURE.md §4.3, §8). One for now:
//
//   docker compose exec hof node src/cli.ts reset-password <логин>
//   node --env-file=.env src/cli.ts reset-password <логин>      (development)
//
// The new password is typed twice in the terminal, without echo. It never comes from the command
// line, the environment or a pipe, and is never printed. Messages are for the operator, in Russian.

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import {
  hashPassword,
  newPasswordError,
  normalizePassword,
  PASSWORD_MIN_LENGTH,
} from './core/password.ts';
import { resetPassword } from './core/reset-password.ts';
import { parseUsername } from './core/username.ts';
import { describeError, log } from './log.ts';
import { CORE_DB_ROLE, DATABASE } from './main.ts';
import { handleConnectionErrors } from './postgres.ts';

const USAGE = 'Использование: node src/cli.ts reset-password <логин>';

// 128 + SIGINT, as a shell reports a command stopped with Ctrl+C.
const CANCELLED = 130;

// The two typed passwords, or null when the input ended first (Ctrl+C, Ctrl+D).
type AskNewPassword = () => Promise<[string, string] | null>;

// Reads the new password twice from the terminal without showing it.
//
// readline in terminal mode switches the terminal to raw mode (stdin.setRawMode), so the
// terminal itself echoes nothing, and edits the line on its own: Backspace, arrows, multi-byte
// characters. Its own echo goes to an output that discards everything. rl.close() switches raw
// mode off again. It sits in `finally`, so it runs on every way out: both lines read, an
// exception, or Ctrl+C and Ctrl+D, on which readline closes itself and the lines end. If the
// process is stopped by a signal instead, Node restores the terminal state it saved at startup.
async function askNewPassword(): Promise<[string, string] | null> {
  const discard = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({
    input: process.stdin,
    output: discard,
    terminal: true,
    historySize: 0,
  });
  // The iterator keeps lines that arrive before they are asked for, as in a pasted pair.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string) => {
    process.stdout.write(prompt);
    const line = await lines.next();
    // Enter is not echoed either.
    process.stdout.write('\n');
    return line.done === true ? null : line.value;
  };
  try {
    const password = await ask('Новый пароль: ');
    if (password === null) return null;
    const repeat = await ask('Ещё раз: ');
    if (repeat === null) return null;
    return [password, repeat];
  } finally {
    rl.close();
  }
}

// reset-password after the checks of the command line and the terminal: the user first, so
// nobody types a password for a login that does not exist, then the password, then the reset.
// Returns the exit code.
export async function resetPasswordCommand(
  pool: Pool,
  typedUsername: string,
  askPassword: AskNewPassword,
): Promise<number> {
  const username = parseUsername(typedUsername);
  const { rows } =
    username === null
      ? { rows: [] }
      : await pool.query<{ id: number; username: string }>(
          'SELECT id, username FROM users WHERE username = $1',
          [username],
        );
  const user = rows[0];
  if (user === undefined) {
    console.error(`Нет пользователя с логином «${typedUsername}».`);
    return 1;
  }

  console.log(
    `Новый пароль для ${user.username}: не короче ${PASSWORD_MIN_LENGTH} символов, дважды.`,
  );
  const typed = await askPassword();
  if (typed === null) {
    console.error('Отменено. Пароль не изменён.');
    return CANCELLED;
  }
  const [password, repeat] = typed;
  const passwordError = newPasswordError(password);
  if (passwordError !== null) {
    console.error(`${passwordError}. Пароль не изменён.`);
    return 1;
  }
  // Compared as one password, after NFKC: two Unicode forms of "й" are the same password.
  if (normalizePassword(password) !== normalizePassword(repeat)) {
    console.error('Пароли не совпадают. Пароль не изменён.');
    return 1;
  }

  // Argon2 runs before the transaction, so the row lock is held only for the two writes.
  const ended = await resetPassword(pool, user.id, await hashPassword(password));
  console.log(`Пароль ${user.username} сменён. Завершено сессий: ${ended}.`);
  log('info', 'password_reset', { user_id: user.id, username: user.username, by: 'cli' });
  return 0;
}

// The order: the command line, the database password, the terminal, and only then the database.
async function main(args: string[]): Promise<number> {
  const [command, typedUsername, ...rest] = args;
  if (command !== 'reset-password' || typedUsername === undefined || rest.length > 0) {
    console.error(USAGE);
    return 1;
  }
  const dbPassword = process.env.HOF_CORE_DB_PASSWORD;
  if (!dbPassword) {
    console.error('Не задан HOF_CORE_DB_PASSWORD (см. .env.example).');
    return 1;
  }
  // A pipe or a redirected file would carry the password in plain text past the terminal.
  if (process.stdin.isTTY !== true) {
    console.error(
      'Пароль вводится только с клавиатуры: stdin должен быть терминалом. Запустите команду в терминале, без перенаправления ввода и без docker compose exec -T.',
    );
    return 1;
  }

  const pool = new Pool({ database: DATABASE, user: CORE_DB_ROLE, password: dbPassword, max: 1 });
  // Before the first connection: the user lookup leaves one idle while the password is typed.
  handleConnectionErrors(pool);
  try {
    return await resetPasswordCommand(pool, typedUsername, askNewPassword);
  } catch (error) {
    console.error(`Ошибка: ${describeError(error)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
