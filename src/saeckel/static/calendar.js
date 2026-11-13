// Säckel — the calendar of a date field (M13.5). Beside the field «Дата» of a form a button opens
// a card of one month: the weeks from Monday, the months turned by «‹» and «›», today on the ochre
// box, the chosen day ringed by pen, the days a form does not take pale. A day pressed is written
// into the field as ДД.ММ.ГГГГ, as one would type it; the field stays a text field that takes a
// date typed by hand, and the server checks whatever is sent.
//
// Today and the first and the last date a form takes come from the server, in the time zone of
// the installation (data-today, data-earliest, data-latest on the field): the clock of the browser
// is never asked. Dates are ISO text, YYYY-MM-DD; a Date is made only in UTC, to learn the length
// of a month and the day of the week.
//
// Without this file the field is as before and there is no button. The functions without the page
// are tested by src/saeckel/calendar.test.ts; start() joins them to the page and runs only in a
// browser.

const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];
const OF_MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
/** The days of the week from Monday: short and in full. */
const WEEK = [
  ['Пн', 'понедельник'],
  ['Вт', 'вторник'],
  ['Ср', 'среда'],
  ['Чт', 'четверг'],
  ['Пт', 'пятница'],
  ['Сб', 'суббота'],
  ['Вс', 'воскресенье'],
];

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/**
 * The parts of an ISO date as numbers.
 * @param {string} date
 * @returns {[number, number, number]}
 */
function parts(date) {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return [year, month, day];
}

/** @param {number} year @param {number} month 1–12 @param {number} day */
function iso(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** Days in a month. @param {number} year @param {number} month 1–12 */
export function daysIn(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The date of a field, as the server takes it: ДД.ММ.ГГГГ or ГГГГ-ММ-ДД, a day that exists.
 * Anything else, also nothing, is null.
 * @param {string} text
 * @returns {string | null}
 */
export function dateOfField(text) {
  const value = text.trim();
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  const dashed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const [year, month, day] = dotted
    ? [Number(dotted[3]), Number(dotted[2]), Number(dotted[1])]
    : dashed
      ? [Number(dashed[1]), Number(dashed[2]), Number(dashed[3])]
      : [0, 0, 0];
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  return iso(year, month, day);
}

/** An ISO date as the field shows it: ДД.ММ.ГГГГ. @param {string} date */
export function fieldOfDate(date) {
  const [year, month, day] = parts(date);
  return `${pad(day)}.${pad(month)}.${String(year).padStart(4, '0')}`;
}

/** A date some days later, or earlier. @param {string} date @param {number} days */
export function addDays(date, days) {
  const [year, month, day] = parts(date);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return iso(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/**
 * The same day some months later, or earlier; the last day where that month is shorter:
 * 31 January and a month is 28 or 29 February.
 * @param {string} date
 * @param {number} months
 */
export function addMonths(date, months) {
  const [year, month, day] = parts(date);
  const index = year * 12 + (month - 1) + months;
  const toYear = Math.floor(index / 12);
  const toMonth = (index % 12) + 1;
  return iso(toYear, toMonth, Math.min(day, daysIn(toYear, toMonth)));
}

/** Monday 0 … Sunday 6. @param {string} date */
export function weekday(date) {
  const [year, month, day] = parts(date);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/**
 * The weeks of the month of a date, from Monday; null before the first day and after the last.
 * @param {string} date
 * @returns {(string | null)[][]}
 */
export function monthWeeks(date) {
  const [year, month] = parts(date);
  const cells = /** @type {(string | null)[]} */ (Array(weekday(iso(year, month, 1))).fill(null));
  for (let day = 1; day <= daysIn(year, month); day += 1) cells.push(iso(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let at = 0; at < cells.length; at += 7) weeks.push(cells.slice(at, at + 7));
  return weeks;
}

/** «Ноябрь 2026». @param {string} date */
export function monthTitle(date) {
  const [year, month] = parts(date);
  return `${MONTHS[month - 1]} ${year}`;
}

/** «13 ноября». @param {string} date */
export function dayAndMonth(date) {
  const [, month, day] = parts(date);
  return `${day} ${OF_MONTHS[month - 1]}`;
}

/** What a day says to a screen reader: «5 ноября 2026, четверг». @param {string} date */
export function dayLabel(date) {
  return `${dayAndMonth(date)} ${parts(date)[0]}, ${WEEK[weekday(date)]?.[1]}`;
}

/**
 * Where a key moves the active day of the grid: a day or a week by the arrows, to Monday or to
 * Sunday by Home and End, a month by Page Up and Page Down, a year with Shift. Never before the
 * first date or after the last a form takes. Null for any other key.
 * @param {string} date
 * @param {string} key
 * @param {boolean} shift
 * @param {string} earliest
 * @param {string} latest
 * @returns {string | null}
 */
export function moveByKey(date, key, shift, earliest, latest) {
  const moves = {
    ArrowLeft: () => addDays(date, -1),
    ArrowRight: () => addDays(date, 1),
    ArrowUp: () => addDays(date, -7),
    ArrowDown: () => addDays(date, 7),
    Home: () => addDays(date, -weekday(date)),
    End: () => addDays(date, 6 - weekday(date)),
    PageUp: () => addMonths(date, shift ? -12 : -1),
    PageDown: () => addMonths(date, shift ? 12 : 1),
  };
  const move = moves[/** @type {keyof typeof moves} */ (key)];
  if (move === undefined) return null;
  const to = move();
  return to < earliest ? earliest : to > latest ? latest : to;
}

/** A date field of a form that the server gave its dates. */
const DATE_FIELD = 'input[name="date"][data-today][data-earliest][data-latest]';

/** @param {HTMLInputElement} input */
function attach(input) {
  const today = input.dataset.today ?? '';
  const earliest = input.dataset.earliest ?? '';
  const latest = input.dataset.latest ?? '';
  const id = `${input.id || 'date'}-calendar`;
  const taken = (/** @type {string} */ date) => date >= earliest && date <= latest;

  // The field and its button in one box: the button inside the field at its right edge.
  const box = document.createElement('span');
  box.className = 'date-box';
  input.before(box);
  box.append(input);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'date-open';
  button.setAttribute('aria-label', 'Выбрать дату в календаре');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', id);
  button.setAttribute('aria-expanded', 'false');
  box.append(button);

  /** @type {HTMLElement | null} */
  let card = null;
  // The day the keyboard is on; the month shown is its month.
  let active = today;
  let chosen = /** @type {string | null} */ (null);
  // How far the page went before the card was there: the card hangs below the page, not in it.
  let pageEnd = 0;

  const draw = () => {
    if (card === null) return;
    const weeks = monthWeeks(active)
      .map(
        (week) =>
          `<tr>${week
            .map((date) => {
              if (date === null) return '<td></td>';
              const marks = [
                date === chosen ? 'class="cal-day chosen"' : 'class="cal-day"',
                date === today ? 'aria-current="date"' : '',
                taken(date) ? '' : 'aria-disabled="true"',
                date === active ? 'tabindex="0"' : 'tabindex="-1"',
              ].join(' ');
              const label = `${dayLabel(date)}${date === chosen ? ', выбрано' : ''}`;
              return `<td><button type="button" ${marks} data-date="${date}" aria-label="${label}">${parts(date)[2]}</button></td>`;
            })
            .join('')}</tr>`,
      )
      .join('');
    const first = `${active.slice(0, 7)}-01`;
    card.innerHTML = `<div class="cal-head">
        <button type="button" class="cal-prev" aria-label="Предыдущий месяц"
          ${first <= earliest ? 'disabled' : ''}></button>
        <p class="cal-month" id="${id}-title" aria-live="polite">${monthTitle(active)}</p>
        <button type="button" class="cal-next" aria-label="Следующий месяц"
          ${addMonths(first, 1) > latest ? 'disabled' : ''}></button>
      </div>
      <table class="cal-grid">
        <thead><tr>${WEEK.map(([short, full]) => `<th scope="col" abbr="${full}">${short}</th>`).join('')}</tr></thead>
        <tbody>${weeks}</tbody>
      </table>
      <p class="cal-foot"><button type="button" class="cal-today">Сегодня, ${dayAndMonth(today)}</button></p>`;
  };

  /** @param {boolean} focus */
  const activeDay = (focus) => {
    const day = card?.querySelector(`.cal-day[data-date="${active}"]`);
    if (focus && day instanceof HTMLElement) day.focus();
  };

  // Below the field, from its left edge, within the window across; on a narrow window in the
  // middle. Where the window ends first, the page moves up just enough; only where the page itself
  // ends below the field, the card stands above it, if it has the room there.
  const place = () => {
    if (card === null) return;
    const room = document.documentElement.clientWidth;
    const field = box.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    let left = field.left;
    if (width + 24 >= room) left = (room - width) / 2;
    else if (left + width > room - 12) left = room - 12 - width;
    let top = field.bottom + 6;
    const fits = top + height <= window.innerHeight;
    const pageLeft = pageEnd - (window.scrollY + field.bottom);
    const above = !fits && pageLeft < height + 18 && field.top - 6 - height >= 0;
    if (above) top = field.top - 6 - height;
    card.style.left = `${left + window.scrollX}px`;
    card.style.top = `${top + window.scrollY}px`;
    if (!fits && !above) card.scrollIntoView({ block: 'nearest' });
  };

  const close = (/** @type {boolean} */ focusButton) => {
    if (card === null) return;
    card.remove();
    card = null;
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  };

  const choose = (/** @type {string} */ date) => {
    if (!taken(date)) return;
    input.value = fieldOfDate(date);
    close(true);
  };

  const open = () => {
    const typed = dateOfField(input.value);
    chosen = typed !== null && taken(typed) ? typed : null;
    active = chosen ?? today;
    pageEnd = document.documentElement.scrollHeight;
    card = document.createElement('div');
    card.className = 'cal';
    card.id = id;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', `${id}-title`);
    // On <body>: the frame of a page of Säckel clips what goes beyond it.
    document.body.append(card);
    draw();
    button.setAttribute('aria-expanded', 'true');
    place();
    activeDay(true);

    card.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const day = target?.closest('.cal-day');
      if (day instanceof HTMLElement && day.dataset.date) choose(day.dataset.date);
      else if (target?.closest('.cal-today')) choose(today);
      else if (target?.closest('.cal-prev, .cal-next')) {
        const later = target.closest('.cal-next') !== null;
        active =
          moveByKey(active, later ? 'PageDown' : 'PageUp', false, earliest, latest) ?? active;
        // A month of other weeks makes the card taller or lower: it is placed again.
        draw();
        place();
        // The button pressed stays where it was, and so does the focus, unless the month shown is
        // now the last one that way: then the focus goes to the day.
        const again = card?.querySelector(later ? '.cal-next' : '.cal-prev');
        if (again instanceof HTMLButtonElement && !again.disabled) again.focus();
        else activeDay(true);
      }
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
        return;
      }
      // Tab goes round the card, as in a dialog: the arrows of the months, the day, «Сегодня».
      if (event.key === 'Tab' && card !== null) {
        const stops = [...card.querySelectorAll('button')].filter(
          (stop) => stop instanceof HTMLButtonElement && !stop.disabled && stop.tabIndex >= 0,
        );
        const at = stops.indexOf(/** @type {HTMLButtonElement} */ (event.target));
        const next = stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
        event.preventDefault();
        next?.focus();
        return;
      }
      if (!(event.target instanceof Element) || !event.target.matches('.cal-day')) return;
      const to = moveByKey(active, event.key, event.shiftKey, earliest, latest);
      if (to === null) return;
      event.preventDefault();
      const redraw = to.slice(0, 7) !== active.slice(0, 7);
      active = to;
      if (redraw) {
        draw();
        place();
      } else {
        card?.querySelectorAll('.cal-day').forEach((day) => day.setAttribute('tabindex', '-1'));
        card?.querySelector(`.cal-day[data-date="${active}"]`)?.setAttribute('tabindex', '0');
      }
      activeDay(true);
    });
  };

  button.addEventListener('click', () => (card === null ? open() : close(true)));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && card !== null) close(true);
  });
  // A press or the focus on the page beyond the card and its button: the card is no longer wanted.
  const away = (/** @type {Event} */ event) => {
    const target = event.target;
    if (card !== null && target instanceof Node && !card.contains(target) && target !== button) {
      close(false);
    }
  };
  document.addEventListener('pointerdown', away);
  document.addEventListener('focusin', away);
  window.addEventListener('resize', place);
}

function start() {
  document.querySelectorAll(DATE_FIELD).forEach((input) => {
    if (input instanceof HTMLInputElement) attach(input);
  });
}

if (typeof document !== 'undefined') start();
