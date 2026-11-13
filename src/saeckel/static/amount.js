// Säckel — the groups of an amount (M13.4): while an amount is typed into a field of a form
// (`amount`, and `amount_<id>` of «Разложить»), its whole part is kept in groups of three,
// «1234567,89» → «1 234 567,89», and the caret stays after the same digit. Only how it looks: the
// server reads the grouped text exactly as the bare one (parseAmount, money.ts §4.7) and stays the
// one judge of the amount. Text that is not the shape of an amount is left as it is, for the
// person to mend and the server to answer. No number is made of the text, so nothing is rounded.
//
// Without this file the field is an ordinary text field, as before. The functions without the
// page are tested by src/saeckel/amount.test.ts; start() joins them to the page and runs only in
// a browser.

// As in parseAmount: at most this many characters, the separators of groups it knows.
const MAX_LENGTH = 20;
const SEPARATORS = /[ \u00A0\u202F]/g;
const SEPARATOR = /^[ \u00A0\u202F]$/;
// The shape of an amount without its separators, also unfinished: digits, a decimal mark, at most
// two digits after it.
const SHAPE = /^(\d+)(?:([.,])(\d{0,2}))?$/;

/**
 * The text of an amount with its whole part in groups of three, apart by U+00A0 as the server
 * fills a field (amountForField); the decimal mark and what follows it as typed, also an
 * unfinished «1 240,». parseAmount takes the separators out before it reads the digits, and the
 * text stays within its length either way: the server's answer to both texts is the same. Any
 * other text — empty, a minus, a sign of the currency, three decimals, leading zeros, too long —
 * comes back unchanged.
 * @param {string} text
 * @returns {string}
 */
export function groupAmount(text) {
  if ([...text].length > MAX_LENGTH) return text;
  const parts = SHAPE.exec(text.replace(SEPARATORS, ''));
  if (parts === null) return text;
  const [, whole = '', mark = '', fraction = ''] = parts;
  if (whole.length > 1 && whole.startsWith('0')) return text;
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, '\u00A0') + mark + fraction;
  return grouped.length > MAX_LENGTH ? text : grouped;
}

/** @typedef {{ value: string, caret: number }} Edit */

/**
 * A field after typing: its text grouped, the caret after as many characters other than
 * separators as stood before it. Null when the text stays as it is.
 * @param {string} value
 * @param {number} caret
 * @returns {Edit | null}
 */
export function regroup(value, caret) {
  const grouped = groupAmount(value);
  if (grouped === value) return null;
  let left = value.slice(0, caret).replace(SEPARATORS, '').length;
  let at = 0;
  while (at < grouped.length && left > 0) {
    if (!SEPARATOR.test(grouped[at] ?? '')) left -= 1;
    at += 1;
  }
  return { value: grouped, caret: at };
}

/**
 * Backspace just after a separator of a grouped amount, or Delete just before one: the digit
 * beyond the separator goes, not the separator alone, which the grouping would put back at once.
 * Null for anything else, which the browser does as usual.
 * @param {string} value
 * @param {number} caret
 * @param {boolean} backward
 * @returns {Edit | null}
 */
export function eraseAcross(value, caret, backward) {
  if (groupAmount(value) !== value || !SHAPE.test(value.replace(SEPARATORS, ''))) return null;
  let at = backward ? caret - 1 : caret;
  if (!SEPARATOR.test(value[at] ?? '')) return null;
  while (SEPARATOR.test(value[at] ?? '')) at += backward ? -1 : 1;
  if (at < 0 || at >= value.length) return null;
  const rest = value.slice(0, at) + value.slice(at + 1);
  const place = backward ? at : caret;
  return regroup(rest, place) ?? { value: rest, caret: place };
}

/** An amount field of a form of Säckel: the names the server reads amounts from. */
const AMOUNT_FIELD = 'input[name="amount"], input[name^="amount_"]';

function start() {
  /** @param {EventTarget | null} target */
  const amountField = (target) =>
    target instanceof HTMLInputElement && target.matches(AMOUNT_FIELD) ? target : null;
  /** @param {HTMLInputElement} field @param {Edit} edit */
  const put = (field, edit) => {
    field.value = edit.value;
    field.setSelectionRange(edit.caret, edit.caret);
  };
  document.addEventListener('beforeinput', (event) => {
    const field = amountField(event.target);
    const backward = event.inputType === 'deleteContentBackward';
    if (field === null || (!backward && event.inputType !== 'deleteContentForward')) return;
    const caret = field.selectionStart;
    if (caret === null || caret !== field.selectionEnd) return;
    const edit = eraseAcross(field.value, caret, backward);
    if (edit === null) return;
    event.preventDefault();
    put(field, edit);
  });
  document.addEventListener('input', (event) => {
    const field = amountField(event.target);
    // A word being composed is the input method's until it is done; a space typed by hand stays
    // until what follows shows whether it is an amount.
    if (field === null || event.isComposing || field.selectionEnd === null) return;
    if (event.inputType === 'insertText' && SEPARATOR.test(event.data ?? '')) return;
    const edit = regroup(field.value, field.selectionEnd);
    if (edit !== null) put(field, edit);
  });
}

if (typeof document !== 'undefined') start();
