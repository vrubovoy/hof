// Säckel — the groups of an amount (M13.4): when the focus leaves an amount field of a form
// (`amount`, and `amount_<id>` of «Разложить»), an amount the server would take is shown with its
// whole part in groups of three, «1234567,89» → «1 234 567,89». Only how it looks: the server
// reads both the same (parseAmount, money.ts §4.7) and stays the one judge of the amount.
// Anything the server would refuse, or not read as typed, is left as it is, for the person to
// mend and the server to answer. No number is made of the text, so nothing is rounded.
//
// Without this file the field is an ordinary text field, as before. groupAmount() is tested by
// src/saeckel/amount.test.ts; start() joins it to the page and runs only in a browser.

// As in parseAmount: at most this many characters, the separators of groups it knows.
const MAX_LENGTH = 20;
const SEPARATORS = /[   ]/g;
// 1 000 000 000,00 as whole hundredths, ten digits and two: compared as text of one length.
const MAX_CENTS = '100000000000';
const ZERO_CENTS = '000000000000';

/**
 * The text of an amount with its whole part in groups of three, apart by U+00A0 as the server
 * fills a field (amountForField); the decimal mark and the digits after it as typed. Any other
 * text — empty, unfinished like «1240,», a minus, a sign of the currency, leading zeros, zero,
 * too long, too big — comes back unchanged.
 * @param {string} text
 * @returns {string}
 */
export function groupAmount(text) {
  if ([...text].length > MAX_LENGTH) return text;
  const parts = /^(\d+)(?:([.,])(\d{1,2}))?$/.exec(text.replace(SEPARATORS, ''));
  if (parts === null) return text;
  const [, whole = '', mark = '', fraction = ''] = parts;
  if (whole.length > 10 || (whole.length > 1 && whole.startsWith('0'))) return text;
  const cents = whole.padStart(10, '0') + fraction.padEnd(2, '0');
  if (cents === ZERO_CENTS || cents > MAX_CENTS) return text;
  return whole.replace(/\B(?=(\d{3})+$)/g, ' ') + mark + fraction;
}

/** An amount field of a form of Säckel: the names the server reads amounts from. */
const AMOUNT_FIELD = 'input[name="amount"], input[name^="amount_"]';

function start() {
  // focusout, unlike blur, comes up to the document from every field, those of «Разложить» too.
  document.addEventListener('focusout', (event) => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || !field.matches(AMOUNT_FIELD)) return;
    const grouped = groupAmount(field.value);
    if (grouped !== field.value) field.value = grouped;
  });
}

if (typeof document !== 'undefined') start();
