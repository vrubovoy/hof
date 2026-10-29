// Core routes (ARCHITECTURE.md §4.1): founding the court, signing in and out, the courtyard,
// my chambers, the change of one's own password and «Приближённые» of the administrator.
//
// Order inside Core, after the common checks and the first-run gate in main.ts:
//   1. /setup has its own rules before and after founding;
//   2. public paths (/login, /logout) need no session;
//   3. the known protected paths need a signed-in user, the known paths of the administrator
//      the administrator;
//   4. anything else is not a Core route and ends in the common 404.

import { Hono, type MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import { parse as parseCookies } from 'hono/utils/cookie';
import type { HtmlEscapedString } from 'hono/utils/html';
import { DatabaseError, type Pool } from 'pg';
import { log } from '../log.ts';
import type { FirstRun } from './gate-key.ts';
import {
  hashPassword,
  newPasswordError,
  normalizePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordLength,
  verifyPassword,
} from './password.ts';
import { resetPassword } from './reset-password.ts';
import {
  CLEARED_SESSION_COOKIE,
  createSession,
  currentUser,
  deleteSession,
  SESSION_COOKIE,
  sessionCookie,
  type CurrentUser,
} from './sessions.ts';
import { parseUsername } from './username.ts';

// One entry of «Службы двора»: the name, the address and the emblem, which the service keeps
// among its own static files.
export interface Service {
  name: string;
  path: string;
  emblem: string;
}

// The place of Hof a page belongs to, marked as the current one in the banner and the top bar.
type Place = 'courtyard' | 'users' | 'account';

// The order of the banner (§6): Двор, the services, Приближённые, Мои покои. With «Анимации» a
// link to a place further down slides the page away to the left, one back up — to the right
// (data-fx, read by fx.js); data-keep — the banner stays, for both pages have it. A link to the
// place of the page itself is an ordinary link. A key and its card are a page of the book turned
// (flip-fwd, flip-back), with the banner staying as well.
const ORDER = { courtyard: 0, service: 1, users: 2, account: 3 } as const;

function slide(here: Place, to: keyof typeof ORDER, keep = to !== 'service') {
  if (to === here) return '';
  const fx = ORDER[to] > ORDER[here] ? 'left' : 'right';
  return keep ? html`data-fx="${fx}" data-keep` : html`data-fx="${fx}"`;
}

// The door of «Покинуть двор»: the open frame lies over the closed one and shows only while the
// form goes (fx.js); without the script the door stays closed.
const DOOR = html`<span class="frames"
  ><img src="/static/img/emblem-door-closed-small.webp" alt="" /><img
    src="/static/img/emblem-door-small.webp"
    alt=""
/></span>`;

type CoreEnv = { Variables: { user: CurrentUser } };

// Core paths that need a signed-in user, for every method. /login and /logout are public and
// not here.
const PROTECTED_PATHS = ['/', '/account', '/account/password'];

// Core paths of the administrator, for every method. Only these: any other /admin/… address is
// not a route and ends in the common 404, for a guest, a user and the administrator alike. A
// path with a wrong :id is one of these: it gets the same checks, and the 404 only after them.
const ADMIN_PATHS = [
  '/admin/users',
  '/admin/users/:id',
  '/admin/users/:id/password',
  '/admin/users/:id/disable',
  '/admin/users/:id/enable',
];

// §4.7: the largest id of a PostgreSQL integer.
const MAX_ID = 2_147_483_647;

// The same text wherever a login is typed for a new user.
const USERNAME_ERROR =
  'Логин: латиница, цифры, точка, дефис и подчёркивание, до 32 символов, первый символ — буква или цифра.';

// SQLSTATE of a unique violation.
const UNIQUE_VIOLATION = '23505';

type SetupField = 'code' | 'username' | 'password' | 'password2';

interface SetupForm {
  username: string;
  error?: { field: SetupField; text: string };
}

type PasswordField = 'current' | 'password' | 'password2';

interface AccountForm {
  done: boolean;
  error?: { field: PasswordField; text: string };
}

interface LoginForm {
  username: string;
  next: string;
  failed: boolean;
}

// One person of the court, as «Приближённые» lists them.
interface Person {
  id: number;
  username: string;
  is_admin: boolean;
  is_disabled: boolean;
}

type NewUserField = 'username' | 'password';

interface NewUserForm {
  username: string;
  // The login of the user just accepted, for the message after the redirect.
  created?: string;
  error?: { field: NewUserField; text: string };
}

// A person other than the administrator, for their card; nobody has a card of the
// administrator.
type Member = Omit<Person, 'is_admin'>;

interface ResetForm {
  done: boolean;
  error?: string;
}

// Why a sign-in of an existing user was refused; written to the log only (§4.10).
type LoginFailure = 'wrong_password' | 'disabled' | 'password_changed';

interface LoginUser {
  id: number;
  password_hash: string;
  is_disabled: boolean;
}

// Every page of Core: the CSS of Hof (§6), the mark of Hof as the icon of the tab and the two
// scripts of the effects — without them every page works the same. `forget` — the sign-in page
// asks the browser to forget the pages it kept (/forget.css).
function page(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>, forget = false) {
  return html`<!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <link rel="stylesheet" href="/static/hof.css" />
        ${forget ? html`<link rel="stylesheet" href="/forget.css" />` : ''}
        <link rel="icon" href="/static/img/hof-mark.svg" type="image/svg+xml" />
        <script src="/static/fx-head.js"></script>
        <script type="module" src="/static/fx.js"></script>
      </head>
      <body>
        ${body}
      </body>
    </html>`;
}

// The three error pages of Hof (design/preview/Error403.html, States.html, Error500.html and
// ErrorMobile.html): the picture of the place, its title and text, the blots on the paper. The
// status of the response is the caller's.
const ERRORS = {
  403: {
    title: 'Сюда только хозяину',
    text: 'Это место двора открыто только хозяину. Если нужно, попросите его.',
    scene: 'error-403',
    alt: 'Тяжёлая дверь с висячим замком',
    blots: ['ink-drip', 'ink-ring'],
  },
  404: {
    title: 'Такой тропы во дворе нет',
    text: 'Возможно, ссылка устарела или в адресе опечатка.',
    scene: 'error-404',
    alt: 'Заросшая тропинка упирается в глухую стену, увитую плющом',
    blots: ['ink-blot-small', 'ink-splatter-b'],
  },
  500: {
    title: 'Во дворе что-то стряслось',
    text: 'Мы уже прибираемся. Попробуйте ещё раз через минуту — записанное раньше на месте.',
    scene: 'error-500',
    alt: 'Опрокинутая бочка, по двору раскатились яблоки, кот разглядывает беспорядок',
    blots: ['ink-blot-medium', 'ink-splatter-a'],
  },
} as const;

// An error page: on a computer the picture the whole window with the text on the paper to the
// right, on the phone the picture at the top; the mark leads to the courtyard. `retry` gives the
// 500 page «Попробовать ещё раз» as href="": the browser opens the same address again, and the
// page does not repeat it. Nothing from the request goes into the page.
export function errorPage(status: keyof typeof ERRORS, retry = false) {
  const error = ERRORS[status];
  return page(
    error.title,
    html`<main class="error error-${status}">
      <div class="error-scene">
        <img
          src="/static/img/${error.scene}.webp"
          srcset="/static/img/${error.scene}.webp 1536w, /static/img/${error.scene}@2x.webp 3072w"
          sizes="(max-width: 1023.98px) 164vw, 100vw"
          alt="${error.alt}"
        />
        ${status === 500 ? html`<span class="cat-frame">${cat('500')}</span>` : ''}
      </div>
      <div class="error-paper">
        <a class="logo" href="/" data-fx="right">
          <img src="/static/img/hof-mark.svg" width="40" height="40" alt="" />
          <span><b>Hof</b><small>Ваш личный двор</small></span>
        </a>
        <h1 class="title t-1">${error.title}</h1>
        <img class="sprig" src="/static/img/sprig-divider.webp" alt="" />
        <p class="muted">${error.text}</p>
        <div class="error-actions">
          ${
            retry
              ? html`<a class="btn btn-blue" href="">Попробовать ещё раз</a>
                  <a class="link" href="/" data-fx="right">Во двор</a>`
              : html`<a class="btn btn-blue" href="/" data-fx="right">Во двор</a>`
          }
        </div>
      </div>
      ${error.blots.map(
        (blot) =>
          html`<img
            class="blot blot-error-${blot}"
            src="/static/img/${blot}.webp"
            alt=""
            loading="lazy"
          />`,
      )}
    </main>`,
  );
}

const FORBIDDEN_PAGE = errorPage(403);

// The pages of a signed-in person (design/preview/Home.html, HomeMobile.html): on a computer the
// blue banner the whole height of the window — Двор, the services, Приближённые of the
// administrator, Мои покои and the way out; on the phone the bar at the top — the mark to the
// courtyard, the candle to Мои покои. CSS shows one of the two, so the hidden one takes no focus.
// «Покинуть двор» is a form: sign-out is POST only (§4.2); data-fx names the act for fx.js.
// The mark at the top of the banner is an ordinary link, as in the prototypes.
function shell(
  user: CurrentUser,
  services: readonly Service[],
  here: Place,
  title: string,
  main: { class: string; body: HtmlEscapedString | Promise<HtmlEscapedString> },
) {
  const current = (place: Place) => (place === here ? html`aria-current="page"` : '');
  return page(
    title,
    html`<div class="shell">
      <nav class="banner" aria-label="Hof">
        <a class="logo" href="/">
          <img src="/static/img/hof-mark-white.svg" width="44" height="44" alt="" />
          <span><b>Hof</b><small>Ваш личный двор</small></span>
        </a>
        <a class="nav" href="/" ${current('courtyard')} ${slide(here, 'courtyard')}>
          <img src="/static/img/emblem-fountain-small.webp" alt="" />Двор
        </a>
        ${
          services.length === 0
            ? ''
            : html`<div class="nav-label">Службы двора</div>
                ${services.map(
                  (service) =>
                    html`<a class="nav" href="${service.path}" ${slide(here, 'service')}>
                      <img src="${service.emblem}" alt="" />${service.name}
                    </a>`,
                )}`
        }
        ${
          user.isAdmin
            ? html`<div class="nav-label">Хозяйство</div>
                <a class="nav" href="/admin/users" ${current('users')} ${slide(here, 'users')}>
                  <img src="/static/img/emblem-keys-small.webp" alt="" />Приближённые
                </a>`
            : ''
        }
        <div class="banner-foot">
          <a class="nav" href="/account" ${current('account')} ${slide(here, 'account')}>
            <img src="/static/img/emblem-candle-small.webp" alt="" />
            <span class="nav-who">
              <span>Мои покои</span>
              <span class="small"
                >${user.isAdmin ? `${user.username} · хозяин` : user.username}</span
              >
            </span>
          </a>
          <form method="post" action="/logout" data-fx="logout">
            <button type="submit" class="nav">${DOOR}Покинуть двор</button>
          </form>
        </div>
      </nav>
      <header class="m-top">
        <a class="logo" href="/" ${slide(here, 'courtyard', false)}>
          <img src="/static/img/hof-mark.svg" width="32" height="32" alt="" /><b>Hof</b>
        </a>
        <a
          class="m-chambers"
          href="/account"
          aria-label="Мои покои"
          ${current('account')}
          ${slide(here, 'account', false)}
        >
          <img src="/static/img/emblem-candle-small.webp" width="34" height="34" alt="" />
        </a>
      </header>
      <main class="${main.class}">${main.body}</main>
    </div>`,
  );
}

// The mark of Hof with its caption; the picture says nothing the text does not.
const LOGO = html`<div class="logo">
  <img src="/static/img/hof-mark.svg" width="64" height="64" alt="" />
  <span><b>Hof</b><small>Ваш личный двор</small></span>
</div>`;

// Texts and pictures from design/preview/Setup.html and SetupMobile.html: the gate closed, its
// key in the lock. The phone and a low window of a computer get the shorter texts of SetupMobile
// (text-short): the key hint without the command, the hints of the login and the password
// (hint-full) only for a screen reader. The gate key and the passwords are never written back
// into the page; the login is, as typed.
function setupPage(form: SetupForm) {
  const describedBy = (field: SetupField, hint: string) =>
    form.error?.field === field
      ? html`aria-invalid="true" aria-describedby="${hint} ${field}-error"`
      : html`aria-describedby="${hint}"`;
  const fieldClass = (field: SetupField) => (form.error?.field === field ? 'field err' : 'field');
  const error = (field: SetupField) =>
    form.error?.field === field
      ? html`<p id="${field}-error" class="err-text">${form.error.text}</p>`
      : '';

  return page(
    'Hof — основание двора',
    html`<main class="gate gate-setup">
      <div class="gate-paper">
        <div class="gate-card framed">
          ${LOGO}
          <div class="gate-title">
            <h1 class="title t-2">Основание двора</h1>
            <p class="small muted">
              Станьте хозяином<span class="text-full"> двора</span>: вы принимаете приближённых и
              присматриваете за Hof.
            </p>
          </div>
          <form method="post" action="/setup" data-fx="setup">
            <div class="${fieldClass('code')}">
              <label for="code">Ключ от ворот</label>
              <input
                id="code"
                class="input input-key"
                name="code"
                type="text"
                autocomplete="off"
                required
                ${describedBy('code', 'code-hint')}
              />
              <p id="code-hint" class="hint">
                <span class="text-full"
                  >Одноразовый код из лога сервера: <code>docker compose logs hof</code></span
                ><span class="text-short">Код из лога сервера</span>
              </p>
              ${error('code')}
            </div>
            <div class="${fieldClass('username')}">
              <label for="username">Логин</label>
              <input
                id="username"
                class="input"
                name="username"
                type="text"
                autocomplete="username"
                autocapitalize="none"
                required
                value="${form.username}"
                ${describedBy('username', 'username-hint')}
              />
              <p id="username-hint" class="hint hint-full">
                Латиница, цифры, точка, дефис и подчёркивание, до 32 символов.
              </p>
              ${error('username')}
            </div>
            <div class="${fieldClass('password')}">
              <label for="password">Пароль</label>
              <input
                id="password"
                class="input"
                name="password"
                type="password"
                autocomplete="new-password"
                required
                ${describedBy('password', 'password-hint')}
              />
              <p id="password-hint" class="hint hint-full">
                Не короче ${PASSWORD_MIN_LENGTH} символов.
              </p>
              ${error('password')}
            </div>
            <div class="${fieldClass('password2')}">
              <label for="password2">Пароль ещё раз</label>
              <input
                id="password2"
                class="input"
                name="password2"
                type="password"
                autocomplete="new-password"
                required
                ${describedBy('password2', 'password-hint')}
              />
              ${error('password2')}
            </div>
            <button type="submit" class="btn btn-blue btn-wide">Основать двор</button>
          </form>
        </div>
      </div>
      <div class="gate-scene">
        <img
          src="/static/img/scene-setup.webp"
          srcset="/static/img/scene-setup.webp 1536w, /static/img/scene-setup@2x.webp 3072w"
          sizes="(max-width: 1023.98px) 195vw, 100vw"
          alt="Ворота замка закрыты, в замке ключ, кот ждёт у ворот"
        />
        <span class="cat-frame"
          ><span class="gate-open" aria-hidden="true"></span>${cat('setup')}</span
        >
      </div>
      <img
        class="blot blot-setup-medium"
        src="/static/img/ink-blot-medium.webp"
        alt=""
        loading="lazy"
      />
      <img class="blot blot-setup-ring" src="/static/img/ink-ring.webp" alt="" loading="lazy" />
    </main>`,
  );
}

// The cat of a picture (M10.4, design/preview/Main.html and the others): a transparent area over
// the cat drawn there — decor for a mouse and a touch only (§6, Ж4): no name, no role, no stop of
// Tab, outside links and forms. A press on it is a meow (in my chambers a purr) and, with
// «Анимации», another pose; fx.js does it by data-poke. Where it stands is in the CSS.
function cat(where: 'login' | 'setup' | 'map' | 'chambers' | '500') {
  const poke = where === 'chambers' ? 'purr' : 'meow';
  return html`<span class="cat cat-${where}" aria-hidden="true" data-poke="${poke}"></span>`;
}

// Texts and pictures from design/preview/Main.html and LoginMobile.html: the gate open, the cat
// looking into the courtyard; the phone has a picture of its own. One error for every refusal,
// so the page does not tell whether the login exists. The login is written back as typed, the
// password never. On the phone the heading is not drawn, but stays for a screen reader. Shown only
// to a person not signed in, it makes the browser forget the pages it kept (/forget.css).
function loginPage(form: LoginForm) {
  const describedBy = form.failed ? html`aria-describedby="login-error"` : '';
  return page(
    'Hof — вход',
    html`<main class="gate gate-login">
      <div class="gate-paper">
        <div class="gate-card framed">
          ${LOGO}
          <h1 class="title t-2 visually-hidden-phone">С возвращением во двор!</h1>
          <form method="post" action="/login" data-fx="login">
            ${
              form.failed
                ? html`<p id="login-error" class="note note-error">Неверный логин или пароль.</p>`
                : ''
            }
            <input type="hidden" name="next" value="${form.next}" />
            <div class="field">
              <label for="username">Логин</label>
              <input
                id="username"
                class="input"
                name="username"
                type="text"
                autocomplete="username"
                autocapitalize="none"
                required
                value="${form.username}"
                ${describedBy}
              />
            </div>
            <div class="field">
              <label for="password">Пароль</label>
              <input
                id="password"
                class="input"
                name="password"
                type="password"
                autocomplete="current-password"
                required
                ${describedBy}
              />
            </div>
            <button type="submit" class="btn btn-blue btn-wide">Войти во двор</button>
          </form>
          <p class="small muted gate-help">
            Нет ключа или забыли пароль? <span>Обратитесь к хозяину двора.</span>
          </p>
        </div>
      </div>
      <div class="gate-scene">
        <picture>
          <source
            media="(max-width: 1023.98px)"
            srcset="
              /static/img/login-mobile-v2@2x.webp  780w,
              /static/img/login-mobile-v2@3x.webp 1170w
            "
            sizes="100vw"
          />
          <img
            src="/static/img/login-desktop-v2.webp"
            srcset="
              /static/img/login-desktop-v2.webp    1536w,
              /static/img/login-desktop-v2@2x.webp 3072w
            "
            sizes="100vw"
            alt="Открытые ворота замка, кот смотрит во двор"
          />
        </picture>
        <span class="cat-frame">${cat('login')}</span>
      </div>
      <img
        class="blot blot-login-small"
        src="/static/img/ink-blot-small.webp"
        alt=""
        loading="lazy"
      />
      <img
        class="blot blot-login-splatter"
        src="/static/img/ink-splatter-b.webp"
        alt=""
        loading="lazy"
      />
      <img class="blot blot-login-drip" src="/static/img/ink-drip.webp" alt="" loading="lazy" />
    </main>`,
    true,
  );
}

// Texts and pictures from design/preview/Home.html and HomeMobile.html. On a computer the places
// are signs on the map: the first service of the list at the door of the treasury, Приближённые
// at the gatehouse (the administrator only), Мои покои at the tower. On the phone the same places
// are signs in a list under the map. «Добрый день!» is the one h1 of both. The note «Пока во
// дворе только вы» is for the administrator while nobody else belongs to the court.
//
// M10.3: the court lives (fx.js and the CSS, only with «Анимации» or «Звуки») — layers on the map
// without a name, a link or a stop of Tab. The door of a place opens when its sign is pressed: on
// a computer the sign and the door are one link, on the phone the sign under the map opens the
// door on it, and that door is a picture only.
function courtyardPage(user: CurrentUser, services: readonly Service[], alone: boolean) {
  const treasury = services[0];
  // The places with a door, in the order of the map: the gatehouse, the treasury, the tower.
  const places = [
    user.isAdmin ? { href: '/admin/users', name: 'Приближённые', at: 'gatehouse' } : null,
    treasury === undefined ? null : { href: treasury.path, name: treasury.name, at: 'treasury' },
    { href: '/account', name: 'Мои покои', at: 'tower' },
  ].filter((place) => place !== null);
  const door = (name: string) => html`<span class="door door-${name}" aria-hidden="true"></span>`;
  const sign = (href: string, name: string, at: string) =>
    html`<a class="sign sign-sm" href="${href}" data-fx="door" data-door="${at}"
      ><span>${name}</span></a
    >`;
  return shell(user, services, 'courtyard', 'Hof — двор', {
    class: 'court',
    body: html`<h1 class="ribbon court-title"><span>Добрый день!</span></h1>
      <div class="court-map">
        <div class="court-inner">
          <img
            src="/static/img/scene-courtyard-map.webp"
            srcset="
              /static/img/scene-courtyard-map.webp    1536w,
              /static/img/scene-courtyard-map@2x.webp 3072w
            "
            sizes="(max-width: 1023.98px) 100vw, calc(100vw - 288px)"
            alt="Двор замка: ворота со сторожкой, казначейская, башня с покоями, фонтан посередине"
          />
          <span class="fx fx-fountain" aria-hidden="true"></span>
          <span class="fx fx-banner fx-gate-l" aria-hidden="true"></span>
          <span class="fx fx-banner fx-gate-r" aria-hidden="true"></span>
          <span class="fx fx-banner fx-tower" aria-hidden="true"></span>
          <span class="fx fx-smoke" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="fx fx-leaves fx-olive" aria-hidden="true"></span>
          <span class="fx fx-leaves fx-bush-l" aria-hidden="true"></span>
          <span class="fx fx-leaves fx-bush-r" aria-hidden="true"></span>
          <span class="fx fx-leaves fx-tree" aria-hidden="true"></span>
          <span class="fx fx-birds" aria-hidden="true"><i></i><i></i><i></i></span>
          ${cat('map')}
          <span class="court-doors" aria-hidden="true">${places.map(({ at }) => door(at))}</span>
          ${places.map(
            ({ href, name, at }) =>
              html`<a class="place" href="${href}" data-fx="door" data-door="${at}"
                ><span class="sign at-${at}"><span>${name}</span></span
                >${door(at)}</a
              >`,
          )}
        </div>
      </div>
      <nav class="court-places" aria-label="Места двора">
        ${services.map((service, i) =>
          i === 0
            ? sign(service.path, service.name, 'treasury')
            : html`<a class="sign sign-sm" href="${service.path}"><span>${service.name}</span></a>`,
        )}
        ${user.isAdmin ? sign('/admin/users', 'Приближённые', 'gatehouse') : ''}
        ${sign('/account', 'Мои покои', 'tower')}
      </nav>
      <div class="court-below">
        <div class="court-note">
          <h2 class="title t-2">Ваш двор в порядке</h2>
          <img class="sprig" src="/static/img/sprig-divider.webp" alt="" />
          <p class="muted">
            Вывески на карте ведут в службы и комнаты. Те же места всегда есть в знамени слева.
          </p>
        </div>
        ${
          alone
            ? html`<aside class="court-alone framed">
                <h2 class="title t-3">Пока во дворе только вы</h2>
                <p class="small muted">
                  Примите приближённых: у каждого будет свой ключ и свои мешки.
                </p>
                <a class="btn" href="/admin/users" data-fx="left" data-keep>Принять ко двору</a>
              </aside>`
            : ''
        }
        <img class="blot blot-court-drip" src="/static/img/ink-drip.webp" alt="" loading="lazy" />
        <img
          class="blot blot-court-small"
          src="/static/img/ink-blot-small.webp"
          alt=""
          loading="lazy"
        />
        <img
          class="blot blot-court-splatter-b"
          src="/static/img/ink-splatter-b.webp"
          alt=""
          loading="lazy"
        />
        <img class="blot blot-court-ring" src="/static/img/ink-ring.webp" alt="" loading="lazy" />
      </div>
      <img
        class="blot blot-court-splatter-a"
        src="/static/img/ink-splatter-a.webp"
        alt=""
        loading="lazy"
      />`,
  });
}

// «Звуки и движение» (design/preview/Account.html, AccountMobile.html, §6): the settings of this
// device, kept by the browser, not by Hof — so not a form, it sends nothing. Hidden: fx.js shows it
// and sets the boxes and sliders; without the script there is nothing to set. The phone has the
// shorter texts of AccountMobile.
const FX_SETTINGS = html`<section id="fx-settings" class="framed fx-settings" hidden>
  <h2 class="title t-3">Звуки и движение</h2>
  <label class="check"
    ><input type="checkbox" data-setting="anim" /><span
      ><b>Анимации</b
      ><span class="small muted"
        >знамя, фонтан, ветер<span class="text-full"> в листве</span>, двери, переходы</span
      ></span
    ></label
  >
  <label class="check"
    ><input type="checkbox" data-setting="sound" /><span
      ><b>Звуки</b
      ><span class="small muted"
        >двери, сундук, монеты, кот, вода и ветер<span class="text-full"> во дворе</span></span
      ></span
    ></label
  >
  <div class="volume">
    <span class="small muted">громкость</span>
    <input
      type="range"
      min="0"
      max="100"
      step="5"
      value="80"
      data-setting="soundVol"
      aria-label="Громкость звуков"
    />
    <output>80&nbsp;%</output>
  </div>
  <label class="check"
    ><input type="checkbox" data-setting="music" /><span
      ><b>Музыка</b
      ><span class="small muted"
        >лютня и старинные напевы<span class="text-full"
          >, одна на всех экранах — играет дальше при переходах</span
        ></span
      ></span
    ></label
  >
  <div class="volume">
    <span class="small muted">громкость</span>
    <input
      type="range"
      min="0"
      max="100"
      step="5"
      value="50"
      data-setting="musicVol"
      aria-label="Громкость музыки"
    />
    <output>50&nbsp;%</output>
  </div>
  <p class="hint">
    Сначала всё выключено. Настройка этого устройства. Если браузер остановил музыку при переходе,
    она продолжится с первого нажатия на странице.
  </p>
</section>`;

// Texts and the picture from design/preview/Account.html and AccountMobile.html: who is signed
// in, the change of the password in a frame, «Звуки и движение», the way out. On a computer the
// picture of the chambers stands to the right the whole height of the window, on the phone it is
// a band at the top and the longer texts are not drawn (text-full). No password is ever written
// back into the page.
function accountPage(user: CurrentUser, services: readonly Service[], form: AccountForm) {
  const describedBy = (field: PasswordField, hint?: string) => {
    const ids = [hint, form.error?.field === field ? `${field}-error` : undefined].filter(Boolean);
    const invalid = form.error?.field === field ? html`aria-invalid="true"` : '';
    return ids.length > 0 ? html`${invalid} aria-describedby="${ids.join(' ')}"` : invalid;
  };
  const fieldClass = (field: PasswordField) =>
    form.error?.field === field ? 'field err' : 'field';
  const error = (field: PasswordField) =>
    form.error?.field === field
      ? html`<p id="${field}-error" class="err-text">${form.error.text}</p>`
      : '';

  return shell(user, services, 'account', 'Hof — мои покои', {
    class: 'chambers',
    body: html`<div class="chambers-main">
        <div class="chambers-head">
          <h1 class="ribbon ribbon-md"><span>Мои покои</span></h1>
          <span class="muted"
            >${user.isAdmin ? `${user.username} · хозяин двора` : user.username}</span
          >
        </div>
        ${form.done ? html`<p class="note">Пароль сменён.</p>` : ''}
        <form class="framed chambers-password" method="post" action="/account/password">
          <h2 class="title t-3">Сменить пароль</h2>
          <div class="chambers-fields">
            <div class="${fieldClass('current')}">
              <label for="current">Текущий пароль</label>
              <input
                id="current"
                class="input"
                name="current"
                type="password"
                autocomplete="current-password"
                required
                ${describedBy('current')}
              />
              ${error('current')}
            </div>
            <div class="${fieldClass('password')}">
              <label for="password">Новый пароль</label>
              <input
                id="password"
                class="input"
                name="password"
                type="password"
                autocomplete="new-password"
                required
                ${describedBy('password', 'password-hint')}
              />
              ${error('password')}
            </div>
            <div class="${fieldClass('password2')}">
              <label for="password2">Ещё раз</label>
              <input
                id="password2"
                class="input"
                name="password2"
                type="password"
                autocomplete="new-password"
                required
                ${describedBy('password2', 'password-hint')}
              />
              ${error('password2')}
            </div>
          </div>
          <p id="password-hint" class="hint">
            Не короче ${PASSWORD_MIN_LENGTH} символов. На других устройствах вы выйдете со двора.
          </p>
          <button type="submit" class="btn btn-blue">Сменить пароль</button>
        </form>
        ${FX_SETTINGS}
        <form class="chambers-out" method="post" action="/logout" data-fx="logout">
          <button type="submit" class="btn" aria-describedby="logout-hint">
            ${DOOR}Покинуть двор
          </button>
          <p id="logout-hint" class="small muted text-full">
            на этом устройстве; всё во дворе останется на месте
          </p>
        </form>
        <img
          class="blot blot-chambers-drip"
          src="/static/img/ink-drip.webp"
          alt=""
          loading="lazy"
        />
        <img
          class="blot blot-chambers-small"
          src="/static/img/ink-blot-small.webp"
          alt=""
          loading="lazy"
        />
        <img
          class="blot blot-chambers-splatter"
          src="/static/img/ink-splatter-a.webp"
          alt=""
          loading="lazy"
        />
      </div>
      <div class="chambers-scene room-scene">
        <img
          src="/static/img/scene-chambers-panel.webp"
          srcset="
            /static/img/scene-chambers-panel.webp     683w,
            /static/img/scene-chambers-panel@2x.webp 1366w
          "
          sizes="(max-width: 1023.98px) 100vw, 600px"
          alt="Покои: окно во двор, стол с пером и чернильницей, кот спит на стуле"
        />
        <span class="cat-frame">${cat('chambers')}</span>
      </div>`,
  });
}

// Texts and the picture from design/preview/Users.html, UsersMobile.html and UsersEmpty.html:
// the key board of the court — everybody, the administrator first, a key with its tag or an
// empty hook, and the way to the card of everybody else — or, while nobody else is in the court,
// the empty board; then the form for a new user. The keys say nothing the text under them does
// not. The initial password is shown while it is typed, so it can be passed on, but never written
// back into the page.
function usersPage(
  user: CurrentUser,
  services: readonly Service[],
  people: readonly Person[],
  form: NewUserForm,
) {
  const describedBy = (field: NewUserField, hint?: string) => {
    const ids = [hint, form.error?.field === field ? `${field}-error` : undefined].filter(Boolean);
    const invalid = form.error?.field === field ? html`aria-invalid="true"` : '';
    return ids.length > 0 ? html`${invalid} aria-describedby="${ids.join(' ')}"` : invalid;
  };
  const fieldClass = (field: NewUserField) => (form.error?.field === field ? 'field err' : 'field');
  const error = (field: NewUserField) =>
    form.error?.field === field
      ? html`<p id="${field}-error" class="err-text">${form.error.text}</p>`
      : '';
  const others = people.filter((person) => !person.is_admin);

  return shell(user, services, 'users', 'Hof — приближённые', {
    class: 'residents',
    body: html`<div class="residents-scene room-scene">
        <img
          src="/static/img/scene-residents-panel.webp"
          srcset="
            /static/img/scene-residents-panel.webp     520w,
            /static/img/scene-residents-panel@2x.webp 1040w
          "
          sizes="(max-width: 1023.98px) 100vw, 420px"
          alt="Сторожка у ворот: ключница с ключами на крюках"
        />
      </div>
      <div class="residents-main">
        <h1 class="ribbon ribbon-md"><span>Приближённые</span></h1>
        ${
          form.created === undefined
            ? ''
            : html`<p class="note">
                Ключ для ${form.created} готов. Передайте логин и начальный пароль лично.
              </p>`
        }
        ${
          others.length === 0
            ? html`<div class="residents-empty">
                <img class="vignette" src="/static/img/empty-residents.webp" alt="" />
                <div class="residents-empty-text">
                  <h2 class="title t-2">Пока у двора только хозяин</h2>
                  <img class="sprig" src="/static/img/sprig-divider.webp" alt="" />
                  <p class="muted">
                    На ключнице один ключ — ваш. Примите ко двору семью или друзей: у каждого будет
                    свой ключ и свои мешки.
                  </p>
                </div>
              </div>`
            : html`<ul class="keys" aria-label="Ключница">
                ${people.map(
                  (person) =>
                    html`<li class="key">
                      <img
                        src="/static/img/${person.is_disabled ? 'hook-empty' : 'key-tag'}.webp"
                        alt=""
                      />
                      <b>${person.username}</b>
                      <span class="small muted">${personStatus(person)}</span>
                      ${
                        person.is_admin
                          ? ''
                          : html`<a
                              class="link-plain small"
                              href="/admin/users/${person.id}"
                              data-fx="flip-fwd"
                              data-keep
                              >Открыть ›</a
                            >`
                      }
                    </li>`,
                )}
              </ul>`
        }
        <form class="framed residents-new" method="post" action="/admin/users">
          <h2 class="title t-3">Принять ко двору</h2>
          <div class="form-row">
            <div class="${fieldClass('username')}">
              <label for="username">Логин</label>
              <input
                id="username"
                class="input"
                name="username"
                type="text"
                autocomplete="off"
                autocapitalize="none"
                required
                value="${form.username}"
                ${describedBy('username')}
              />
              ${error('username')}
            </div>
            <div class="${fieldClass('password')}">
              <label for="password">Начальный пароль</label>
              <input
                id="password"
                class="input"
                name="password"
                type="text"
                autocomplete="off"
                required
                ${describedBy('password', 'password-hint')}
              />
              ${error('password')}
            </div>
            <button type="submit" class="btn btn-blue">Принять</button>
          </div>
          <p id="password-hint" class="hint">
            Пароль виден, чтобы его можно было передать.<span class="text-full">
              Человек сменит его в своих покоях.</span
            >
          </p>
        </form>
        ${
          others.length === 0
            ? html`<img
                class="blot blot-residents-splatter-a"
                src="/static/img/ink-splatter-a.webp"
                alt=""
                loading="lazy"
              />`
            : html`<img
                  class="blot blot-residents-splatter-b"
                  src="/static/img/ink-splatter-b.webp"
                  alt=""
                  loading="lazy"
                />
                <img
                  class="blot blot-residents-small"
                  src="/static/img/ink-blot-small.webp"
                  alt=""
                  loading="lazy"
                />`
        }
        <img
          class="blot blot-residents-ring"
          src="/static/img/ink-ring.webp"
          alt=""
          loading="lazy"
        />
      </div>`,
  });
}

// Texts from design/preview/User.html and UserMobile.html: the way back, the person with their
// key or the empty hook, and two frames of one height — the reset of the password and the key of
// the court. A person without the key is not drawn there: the empty hook, «Ключ взят» and the blue
// «Вернуть ключ» take the place of the key and the red «Забрать ключ». The phone gets the shorter
// texts of UserMobile (text-full). The new password is shown while it is typed, so it can be
// passed on, but never written back into the page.
function memberPage(
  user: CurrentUser,
  services: readonly Service[],
  member: Member,
  form: ResetForm,
) {
  const describedBy =
    form.error === undefined
      ? html`aria-describedby="password-hint"`
      : html`aria-invalid="true" aria-describedby="password-hint password-error"`;

  return shell(user, services, 'users', `Hof — ${member.username}`, {
    class: 'card',
    body: html`<a class="back" href="/admin/users" data-fx="flip-back" data-keep
        ><span>Приближённые</span></a
      >
      ${
        form.done
          ? html`<p class="note">
              Пароль для ${member.username} сброшен. Передайте новый пароль лично.
            </p>`
          : ''
      }
      <div class="card-grid">
        <div class="card-person">
          <span class="card-key"
            ><img src="/static/img/${member.is_disabled ? 'hook-empty' : 'key-tag'}.webp" alt=""
          /></span>
          <div class="card-name">
            <h1 class="title t-1">${member.username}</h1>
            <span class="badge">${keyStatus(member)}</span>
          </div>
        </div>
        <div class="card-frames">
          <form class="framed card-frame" method="post" action="/admin/users/${member.id}/password">
            <h2 class="title t-3">Сбросить пароль</h2>
            <div class="${form.error === undefined ? 'field' : 'field err'}">
              <label for="password">Новый начальный пароль</label>
              <input
                id="password"
                class="input"
                name="password"
                type="text"
                autocomplete="off"
                required
                ${describedBy}
              />
              ${
                form.error === undefined
                  ? ''
                  : html`<p id="password-error" class="err-text">${form.error}</p>`
              }
              <p id="password-hint" class="hint">
                ${member.username} выйдет со двора на всех устройствах.<span class="text-full">
                  Передайте новый пароль лично.</span
                >
              </p>
            </div>
            <button type="submit" class="btn btn-blue">Сбросить пароль</button>
          </form>
          ${
            member.is_disabled
              ? html`<form
                  class="framed card-frame"
                  method="post"
                  action="/admin/users/${member.id}/enable"
                >
                  <h2 class="title t-3">Ключ от двора</h2>
                  <p class="card-text">
                    Ключ у ${member.username} забран: вход закрыт, мешки и записи на месте. Если
                    вернуть ключ, ${member.username} войдёт со своим паролем.
                  </p>
                  <button type="submit" class="btn btn-blue">Вернуть ключ</button>
                </form>`
              : html`<form
                  class="framed card-frame"
                  method="post"
                  action="/admin/users/${member.id}/disable"
                  data-fx="key"
                >
                  <h2 class="title t-3">Ключ от двора</h2>
                  <p class="card-text">
                    <span class="text-full">У ${member.username} есть ключ от двора. </span>Если
                    забрать ключ, вход закроется сразу, а мешки и записи останутся. Вернуть<span
                      class="text-full"
                    >
                      ключ</span
                    >
                    можно в любой момент.
                  </p>
                  <button type="submit" class="btn btn-danger">Забрать ключ</button>
                </form>`
          }
        </div>
      </div>
      <img
        class="blot blot-card-medium"
        src="/static/img/ink-blot-medium.webp"
        alt=""
        loading="lazy"
      />
      <img
        class="blot blot-card-splatter"
        src="/static/img/ink-splatter-a.webp"
        alt=""
        loading="lazy"
      />
      <img class="blot blot-card-drip" src="/static/img/ink-drip.webp" alt="" loading="lazy" />
      <img
        class="blot blot-card-small"
        src="/static/img/ink-blot-small.webp"
        alt=""
        loading="lazy"
      />`,
  });
}

// Whether a person has the key of the court.
function keyStatus(person: { is_disabled: boolean }): string {
  return person.is_disabled ? 'Ключ взят' : 'С ключом';
}

// What the list says of a person; the administrator is the one reading it.
function personStatus(person: Person): string {
  return person.is_admin ? 'хозяин, это вы' : keyStatus(person);
}

// Everybody of the court for «Приближённые»: the administrator first, the others by login.
async function listPeople(pool: Pool): Promise<Person[]> {
  const { rows } = await pool.query<Person>(
    'SELECT id, username, is_admin, is_disabled FROM users ORDER BY is_admin DESC, username',
  );
  return rows;
}

// Whether anybody but the administrator belongs to the court, with the key or without it.
async function hasMembers(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ members: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM users WHERE NOT is_admin) AS members',
  );
  return rows[0]!.members;
}

// §4.7: an id from the path — digits without a leading zero, at most MAX_ID — or null.
function parseId(input: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(input)) return null;
  const id = Number(input);
  return id <= MAX_ID ? id : null;
}

// The person of the :id in the path, unless it is the administrator: no such person, a wrong
// id and the administrator all come back as null, and the caller answers 404.
async function findMember(pool: Pool, idInPath: string): Promise<Member | null> {
  const id = parseId(idInPath);
  if (id === null) return null;
  const { rows } = await pool.query<Member>(
    'SELECT id, username, is_disabled FROM users WHERE id = $1 AND NOT is_admin',
    [id],
  );
  return rows[0] ?? null;
}

// §4.6: the only addresses sign-in sends a person back to — a local path. "/" first; then not
// "/" or "\", so "//host" and "/\host" cannot become another site; then printable ASCII from
// "!" to "~" without "\" (\x5C), so no spaces or control characters a browser would strip;
// 512 characters at most. Anything else, or nothing, is "/". The one rule for GET and POST.
function safeNext(input: string | undefined): string {
  return input !== undefined && /^\/(?![/\\])[\x21-\x5B\x5D-\x7E]{0,511}$/.test(input)
    ? input
    : '/';
}

// §4.6: without a session, GET and HEAD come back to the same address after sign-in, any other
// method goes to /login without it. The address only travels URL-encoded inside the query;
// /login decides with safeNext whether it is a safe local path. Location is always relative.
function loginLocation(method: string, requestUrl: string): string {
  if (method !== 'GET' && method !== 'HEAD') return '/login';
  const url = new URL(requestUrl);
  return `/login?next=${encodeURIComponent(url.pathname + url.search)}`;
}

// The session cookie from the Cookie header, if there is one.
function sessionToken(cookieHeader: string | undefined): string | undefined {
  return cookieHeader === undefined ? undefined : parseCookies(cookieHeader)[SESSION_COOKIE];
}

// The signed-in user of a request, or null: what main.ts hands on to the applications of the
// court (ARCHITECTURE.md §2). The same session check as for the pages of Core.
export function requestUser(pool: Pool, request: Request): Promise<CurrentUser | null> {
  return currentUser(pool, sessionToken(request.headers.get('Cookie') ?? undefined));
}

// dummyPasswordHash: made at startup with the current profile from a password nobody knows;
// an unknown login is checked against it (§4.3).
export function createCoreApp(
  pool: Pool,
  firstRun: FirstRun,
  dummyPasswordHash: string,
  services: readonly Service[],
): Hono<CoreEnv> {
  const core = new Hono<CoreEnv>();

  // 1. Founding the court (§4.4). After founding, GET is a 404 and POST goes to the courtyard
  //    without looking at the form or writing anything.
  core.get('/setup', async (c) => {
    if (await firstRun.isFounded()) return c.notFound();
    return c.html(setupPage({ username: '' }));
  });

  core.post('/setup', async (c) => {
    if (await firstRun.isFounded()) return c.redirect('/', 303);

    const form = await c.req.parseBody();
    const text = (name: SetupField) => {
      const value = form[name];
      return typeof value === 'string' ? value : '';
    };
    const typedUsername = text('username');
    const refuse = (field: SetupField, message: string) =>
      c.html(setupPage({ username: typedUsername, error: { field, text: message } }), 400);

    // The key first: without it nothing else is looked at and Argon2 does not run.
    if (!firstRun.keyMatches(text('code'))) {
      // §4.10: no typed value in the log. The IP comes from X-Real-IP, which nginx always
      // overwrites; it is only written down, never used for a decision.
      log('warn', 'gate_key_rejected', { ip: c.req.header('X-Real-IP') ?? '-' });
      return refuse('code', 'Ключ от ворот не подходит.');
    }
    const username = parseUsername(typedUsername);
    if (username === null) return refuse('username', USERNAME_ERROR);
    const password = text('password');
    const passwordError = newPasswordError(password);
    if (passwordError !== null) return refuse('password', `${passwordError}.`);
    // Compared as one password, after NFKC: two Unicode forms of "й" are the same password.
    if (normalizePassword(password) !== normalizePassword(text('password2'))) {
      return refuse('password2', 'Пароли не совпадают.');
    }

    // Argon2 takes tens of milliseconds: it runs before the transaction, so no row lock
    // and no connection are held while it computes.
    const passwordHash = await hashPassword(password);

    // The administrator and the session in one transaction (§4.4, §4.8).
    let userId: number;
    let token: string;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: number }>(
        'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, true) RETURNING id',
        [username, passwordHash],
      );
      userId = rows[0]!.id;
      token = await createSession(client, userId);
      await client.query('COMMIT');
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      // Two submissions with the right key at once: the unique index on the administrator
      // lets one through. The other one is not an error, the court is simply founded.
      if (error instanceof DatabaseError && error.constraint === 'users_one_admin') {
        return c.redirect('/', 303);
      }
      throw error;
    } finally {
      client.release();
    }

    // Only after COMMIT: the court counts as founded and the key is destroyed. A failure
    // above leaves both as they were, so the same key can be tried again.
    firstRun.markFounded();
    c.header('Set-Cookie', sessionCookie(token));
    log('info', 'court_founded', {
      user_id: userId,
      username,
      ip: c.req.header('X-Real-IP') ?? '-',
    });
    return c.redirect('/', 303);
  });

  // 2. Public paths.

  // Sign-in page. With a live session there is nothing to sign in to: straight on to `next`.
  // The empty stylesheet of the sign-in page (§4.2). Its answer makes the browser forget what it
  // kept of this site — the HTTP cache and the pages kept for Back — but not its storage, where
  // the settings of «Звуки и движение» are. A page left by «Покинуть двор» goes into the
  // back/forward cache only when the next page comes, after the answer to the sign-out; and Chrome
  // restores the page the sign-in itself led to although the cookie is deleted (M10.6). So the
  // sign-in page asks once it has come: Back then goes to the server, which answers with /login.
  core.get('/forget.css', (c) => {
    c.header('Clear-Site-Data', '"cache"');
    c.header('Cache-Control', 'no-store');
    return c.body('', 200, { 'Content-Type': 'text/css; charset=utf-8' });
  });

  core.get('/login', async (c) => {
    const next = safeNext(c.req.query('next'));
    if ((await currentUser(pool, sessionToken(c.req.header('Cookie')))) !== null) {
      return c.redirect(next, 303);
    }
    return c.html(loginPage({ username: '', next, failed: false }));
  });

  // Sign-in (§4.2, §4.3, §4.8). Every refusal gets the same answer, and every refusal that
  // depends on the database costs exactly one Argon2: neither the page nor the time tells
  // whether the login exists.
  core.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const text = (name: 'username' | 'password' | 'next') => {
      const value = form[name];
      return typeof value === 'string' ? value : '';
    };
    const typedUsername = text('username');
    const password = text('password');
    const next = safeNext(text('next'));
    const ip = c.req.header('X-Real-IP') ?? '-';

    const refuse = () => c.html(loginPage({ username: typedUsername, next, failed: true }), 400);
    // §4.10: what was typed as the login of an unknown user is not written down — people
    // type their password into that field.
    const refuseUnknown = () => {
      log('warn', 'login_failed', { reason: 'unknown_user', ip });
      return refuse();
    };
    const refuseUser = (id: number, username: string, reason: LoginFailure) => {
      log('warn', 'login_failed', { user_id: id, username, ip, reason });
      return refuse();
    };

    // A login of the wrong form cannot exist. The refusal says nothing about real logins, so
    // neither the database nor Argon2 is asked.
    const username = parseUsername(typedUsername);
    if (username === null) return refuseUnknown();

    // Read without a lock: the lock is taken only after Argon2, inside the transaction.
    const { rows } = await pool.query<LoginUser>(
      'SELECT id, password_hash, is_disabled FROM users WHERE username = $1',
      [username],
    );
    const user = rows[0];

    // No stored password is longer than the maximum, so a longer one matches nothing.
    // Argon2 is skipped for known and unknown logins alike, so the time says nothing either.
    if (passwordLength(password) > PASSWORD_MAX_LENGTH) {
      return user === undefined ? refuseUnknown() : refuseUser(user.id, username, 'wrong_password');
    }

    if (user === undefined) {
      await verifyPassword(password, dummyPasswordHash);
      return refuseUnknown();
    }

    // Argon2 runs before the transaction, against the hash read above.
    const check = await verifyPassword(password, user.password_hash);
    if (check === 'unreadable') {
      // Not a 500: access comes back with a password reset (§4.3). The stored string was
      // rejected before Argon2 ran, so the dummy hash keeps the time of a real check.
      await verifyPassword(password, dummyPasswordHash);
      log('error', 'password_hash_unreadable', { user_id: user.id });
      return refuse();
    }
    if (check === 'wrong') return refuseUser(user.id, username, 'wrong_password');
    if (user.is_disabled) return refuseUser(user.id, username, 'disabled');

    // The checked password must still be the user's password, and the user still allowed in,
    // when the session is written. The row lock makes a reset or a disable either finish
    // before this check, or wait for this COMMIT and then delete the new session (§4.8).
    let token: string | null = null;
    let failure: LoginFailure = 'password_changed';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<Omit<LoginUser, 'id'>>(
        'SELECT password_hash, is_disabled FROM users WHERE id = $1 FOR UPDATE',
        [user.id],
      );
      // Users are never deleted (§5.2), so the row is there.
      const current = locked.rows[0]!;
      if (current.is_disabled || current.password_hash !== user.password_hash) {
        failure = current.is_disabled ? 'disabled' : 'password_changed';
        // Nothing has been written: no session is deleted or created.
        await client.query('ROLLBACK');
      } else {
        // Expired sessions of every user are deleted at each successful sign-in: no scheduler.
        await client.query('DELETE FROM sessions WHERE expires_at <= now()');
        // The session this browser had before is replaced, not kept beside the new one.
        await deleteSession(client, sessionToken(c.req.header('Cookie')));
        token = await createSession(client, user.id);
        await client.query('COMMIT');
      }
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (token === null) return refuseUser(user.id, username, failure);

    c.header('Set-Cookie', sessionCookie(token));
    log('info', 'login', { user_id: user.id, username, ip });
    return c.redirect(next, 303);
  });

  // Sign-out ends only the session of this browser (§4.2). It needs no live session: without
  // one there is nothing to delete, and the cookie is cleared all the same. Origin is checked
  // in main.ts as for every POST, so another site cannot sign a person out.
  core.post('/logout', async (c) => {
    await deleteSession(pool, sessionToken(c.req.header('Cookie')));
    c.header('Set-Cookie', CLEARED_SESSION_COOKIE);
    return c.redirect('/login', 303);
  });

  // 3. Protected paths: a signed-in user or the way to /login. The paths of the administrator
  //    need the role as well (§4.6): a signed-in user without it gets 403. Both run before the
  //    form, the path or any record is looked at, so a refusal costs no Argon2 and does not
  //    tell whether a record exists.
  const signedIn: MiddlewareHandler<CoreEnv> = async (c, next) => {
    const user = await currentUser(pool, sessionToken(c.req.header('Cookie')));
    if (user === null) return c.redirect(loginLocation(c.req.method, c.req.url), 303);
    c.set('user', user);
    await next();
  };
  const administratorOnly: MiddlewareHandler<CoreEnv> = async (c, next) => {
    if (!c.get('user').isAdmin) return c.html(FORBIDDEN_PAGE, 403);
    await next();
  };
  for (const path of PROTECTED_PATHS) core.use(path, signedIn);
  for (const path of ADMIN_PATHS) core.use(path, signedIn, administratorOnly);

  // The note «Пока во дворе только вы» costs one EXISTS, for the administrator only.
  core.get('/', async (c) => {
    const user = c.get('user');
    const alone = user.isAdmin && !(await hasMembers(pool));
    return c.html(courtyardPage(user, services, alone));
  });

  // Мои покои. `done` is a flag from a fixed list; anything else is ignored (§4.1).
  core.get('/account', (c) =>
    c.html(accountPage(c.get('user'), services, { done: c.req.query('done') === 'password' })),
  );

  // Change of one's own password (§4.2, §4.3, §4.8). Every Argon2 runs before the transaction;
  // inside it the new hash, the end of every old session and the new session of this browser
  // are written together or not at all.
  core.post('/account/password', async (c) => {
    const user = c.get('user');
    const form = await c.req.parseBody();
    const text = (name: PasswordField) => {
      const value = form[name];
      return typeof value === 'string' ? value : '';
    };
    const refuse = (field: PasswordField, message: string) =>
      c.html(accountPage(user, services, { done: false, error: { field, text: message } }), 400);
    const wrongCurrent = () => refuse('current', 'Текущий пароль не подходит.');

    // The form first, without Argon2. Like at sign-in, only the maximum applies to the current
    // password: no stored password is longer, so a longer one matches nothing.
    const current = text('current');
    if (passwordLength(current) > PASSWORD_MAX_LENGTH) return wrongCurrent();
    const password = text('password');
    const passwordError = newPasswordError(password);
    if (passwordError !== null) return refuse('password', `${passwordError}.`);
    // Compared as one password, after NFKC: two Unicode forms of "й" are the same password.
    if (normalizePassword(password) !== normalizePassword(text('password2'))) {
      return refuse('password2', 'Пароли не совпадают.');
    }

    // The current password is checked against the hash read here, without a lock.
    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    // Users are never deleted (§5.2), so the row is there.
    const checkedHash = rows[0]!.password_hash;
    const check = await verifyPassword(current, checkedHash);
    if (check === 'unreadable') {
      // Not a 500, and the hash itself is not logged; access comes back with a reset (§4.3).
      log('error', 'password_hash_unreadable', { user_id: user.id });
      return wrongCurrent();
    }
    if (check === 'wrong') return wrongCurrent();

    // Only after the current password is confirmed, and still before the transaction.
    const passwordHash = await hashPassword(password);

    // The checked hash must still be the user's hash, and the user still allowed in. A reset,
    // a disable or a change from another device in between has already ended this user's
    // sessions; it is not overwritten, and this request is left without a session.
    let token: string | null = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ password_hash: string; is_disabled: boolean }>(
        'SELECT password_hash, is_disabled FROM users WHERE id = $1 FOR UPDATE',
        [user.id],
      );
      const latest = locked.rows[0]!;
      if (latest.is_disabled || latest.password_hash !== checkedHash) {
        // Nothing has been written: the password, the sessions and the cookie stay as they are.
        await client.query('ROLLBACK');
      } else {
        // The hash first, then every session of the user — the one of this browser included —
        // then the new session of this browser.
        await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
          passwordHash,
          user.id,
        ]);
        await client.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
        token = await createSession(client, user.id);
        await client.query('COMMIT');
      }
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (token === null) return c.redirect('/login', 303);

    c.header('Set-Cookie', sessionCookie(token));
    log('info', 'password_changed', {
      user_id: user.id,
      username: user.username,
      ip: c.req.header('X-Real-IP') ?? '-',
    });
    return c.redirect('/account?done=password', 303);
  });

  // Приближённые. `created` is the id of the user just accepted (§4.1): the message shows only
  // for a user in the list just read, so no other query is needed. The ids there are integers,
  // and only the plain decimal form of one of them matches: "02", "2.0", "abc", a missing id or
  // the administrator's own show nothing.
  core.get('/admin/users', async (c) => {
    const people = await listPeople(pool);
    const createdId = c.req.query('created');
    const created = people.find((person) => !person.is_admin && String(person.id) === createdId);
    return c.html(
      usersPage(c.get('user'), services, people, { username: '', created: created?.username }),
    );
  });

  // «Принять ко двору» (§4.1, §4.3): a new user with the initial password the administrator
  // typed. No password is ever written back into the page.
  core.post('/admin/users', async (c) => {
    const administrator = c.get('user');
    const form = await c.req.parseBody();
    const text = (name: NewUserField) => {
      const value = form[name];
      return typeof value === 'string' ? value : '';
    };
    const typedUsername = text('username');
    const refuse = async (field: NewUserField, message: string) =>
      c.html(
        usersPage(administrator, services, await listPeople(pool), {
          username: typedUsername,
          error: { field, text: message },
        }),
        400,
      );

    // The form first, without Argon2.
    const username = parseUsername(typedUsername);
    if (username === null) return refuse('username', USERNAME_ERROR);
    const password = text('password');
    const passwordError = newPasswordError(password);
    if (passwordError !== null) return refuse('password', `${passwordError}.`);

    // Argon2 runs before the INSERT: no connection is held while it computes.
    const passwordHash = await hashPassword(password);

    // One statement, so no transaction of our own. Two submissions of one login at once are
    // settled by the unique index: the second INSERT waits for the first to commit and then
    // fails on users_username_key. That one violation is the expected «taken»; any other error,
    // another unique index included, is unexpected and goes to onError in main.ts (500).
    let userId: number;
    try {
      const { rows } = await pool.query<{ id: number }>(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
        [username, passwordHash],
      );
      userId = rows[0]!.id;
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.code === UNIQUE_VIOLATION &&
        error.constraint === 'users_username_key'
      ) {
        return refuse('username', 'Логин занят.');
      }
      throw error;
    }

    log('info', 'user_created', {
      user_id: userId,
      username,
      admin_id: administrator.id,
      ip: c.req.header('X-Real-IP') ?? '-',
    });
    return c.redirect(`/admin/users?created=${userId}`, 303);
  });

  // The card of a person. `done` is a flag from a fixed list; anything else is ignored (§4.1).
  core.get('/admin/users/:id', async (c) => {
    const member = await findMember(pool, c.req.param('id'));
    if (member === null) return c.notFound();
    return c.html(
      memberPage(c.get('user'), services, member, { done: c.req.query('done') === 'password' }),
    );
  });

  // The reset of a person's password by the administrator (§4.2, §4.3, §4.8): the person first,
  // then the form, then Argon2, and only then the transaction, which ends every session of the
  // person. No password is ever written back into the page.
  core.post('/admin/users/:id/password', async (c) => {
    const administrator = c.get('user');
    const member = await findMember(pool, c.req.param('id'));
    if (member === null) return c.notFound();

    const form = await c.req.parseBody();
    const password = typeof form.password === 'string' ? form.password : '';
    const passwordError = newPasswordError(password);
    if (passwordError !== null) {
      return c.html(
        memberPage(administrator, services, member, { done: false, error: `${passwordError}.` }),
        400,
      );
    }

    // Argon2 runs before the transaction, so the row lock is held only for the two writes.
    // The person found above is still there and still not the administrator when the reset
    // writes: users are never deleted, and is_admin never changes.
    await resetPassword(pool, member.id, await hashPassword(password));

    log('info', 'password_reset', {
      user_id: member.id,
      username: member.username,
      by: 'admin',
      admin_id: administrator.id,
      ip: c.req.header('X-Real-IP') ?? '-',
    });
    return c.redirect(`/admin/users/${member.id}?done=password`, 303);
  });

  // «Забрать ключ» (§4.2, §4.8): the person loses access at once. The flag first, then every
  // session of the person, in one transaction. UPDATE takes the row lock of the person; a
  // sign-in holds that lock with FOR UPDATE from its check to its COMMIT, so it either commits
  // first and its new session is deleted here, or waits and then finds the person disabled.
  // The other way round, DELETE would not see the session of a sign-in that has not committed
  // yet. A person already disabled goes through the same steps: the sessions are deleted all
  // the same, so a disabled person never keeps one.
  core.post('/admin/users/:id/disable', async (c) => {
    const administrator = c.get('user');
    const id = parseId(c.req.param('id'));
    if (id === null) return c.notFound();

    let username: string | undefined;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ username: string }>(
        'UPDATE users SET is_disabled = true WHERE id = $1 AND NOT is_admin RETURNING username',
        [id],
      );
      username = rows[0]?.username;
      if (username === undefined) {
        // Nobody, or the administrator: nothing was written.
        await client.query('ROLLBACK');
      } else {
        await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
        await client.query('COMMIT');
      }
    } catch (error) {
      // The connection may already be broken; the original error matters more.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (username === undefined) return c.notFound();

    log('info', 'user_disabled', {
      user_id: id,
      username,
      admin_id: administrator.id,
      ip: c.req.header('X-Real-IP') ?? '-',
    });
    return c.redirect(`/admin/users/${id}`, 303);
  });

  // «Вернуть ключ»: the person may sign in again with their own password. One statement, so no
  // transaction of our own. Sessions are not touched: a disabled person has none, and none is
  // made here.
  core.post('/admin/users/:id/enable', async (c) => {
    const administrator = c.get('user');
    const id = parseId(c.req.param('id'));
    if (id === null) return c.notFound();

    const { rows } = await pool.query<{ username: string }>(
      'UPDATE users SET is_disabled = false WHERE id = $1 AND NOT is_admin RETURNING username',
      [id],
    );
    const username = rows[0]?.username;
    // Nobody, or the administrator.
    if (username === undefined) return c.notFound();

    log('info', 'user_enabled', {
      user_id: id,
      username,
      admin_id: administrator.id,
      ip: c.req.header('X-Real-IP') ?? '-',
    });
    return c.redirect(`/admin/users/${id}`, 303);
  });

  return core;
}
