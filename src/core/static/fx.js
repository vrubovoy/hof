// Hof — effects (ARCHITECTURE.md §6): the settings «Звуки и движение» of this device, sounds,
// music, the guard against a form sent twice (§4.8) and the way a page leaves for the next one.
// Without this file everything works the same: links and forms are ordinary, the court is still
// and silent.
//
// The top of the file decides: small functions without the page, tested by src/core/fx.test.ts.
// start() at the bottom joins them to the page; it runs only in a browser. A module runs once a
// page, so nothing here is set up twice.
//
// Kept in the browser, nothing else: in localStorage `hof.fx` — the settings of this device, and
// `hof.fountain` — which loop of the fountain the next visit of the courtyard plays; in
// sessionStorage `hof.music` — the piece of music and the place in it, and the two flags of a way
// to the next page, `hof.arrive` (a link) and `hof.after` (a form), which fx-head.js of that page
// reads once.

export const SETTINGS_KEY = 'hof.fx';
export const MUSIC_KEY = 'hof.music';
export const ARRIVE_KEY = 'hof.arrive';
export const AFTER_KEY = 'hof.after';
export const FOUNTAIN_KEY = 'hof.fountain';

/** @typedef {{ anim: boolean, sound: boolean, soundVol: number, music: boolean, musicVol: number }} Settings */
/** @typedef {{ piece: number, time: number, at: number }} MusicPlace */

/** A new device: everything off; the volumes in per cent. @type {Readonly<Settings>} */
export const DEFAULTS = Object.freeze({
  anim: false,
  sound: false,
  soundVol: 80,
  music: false,
  musicVol: 50,
});

/** The sets of sounds and how many variants each has. @type {Readonly<Record<string, number>>} */
export const SOUNDS = Object.freeze({
  coins: 2,
  door: 6,
  page: 2,
  wind: 6,
  meow: 9,
  purr: 1,
  banner: 4,
  chest: 3,
  sniff: 3,
});

/** The loops of the fountain on the courtyard. */
export const FOUNTAINS = 3;

/** The pieces of music, played in this order from 1. */
export const PIECES = 20;

/** Music is 4 dB quieter while a sound plays. */
export const DUCK = 10 ** (-4 / 20);

/** @param {string} name @param {number} variant */
export function soundAddress(name, variant) {
  return `/static/sounds/${name}-${variant}.m4a`;
}

/** @param {number} loop */
export function fountainAddress(loop) {
  return `/static/sounds/fountain-${loop}.m4a`;
}

/** @param {number} piece */
export function pieceAddress(piece) {
  return `/static/sounds/music/music-${piece}.m4a`;
}

/** Every address this file may ask for. @returns {string[]} */
export function soundFiles() {
  const files = [];
  for (const [name, count] of Object.entries(SOUNDS)) {
    for (let variant = 1; variant <= count; variant += 1) files.push(soundAddress(name, variant));
  }
  for (let loop = 1; loop <= FOUNTAINS; loop += 1) files.push(fountainAddress(loop));
  for (let piece = 1; piece <= PIECES; piece += 1) files.push(pieceAddress(piece));
  return files;
}

/**
 * The settings of this device, field by field: a missing or wrong field, broken JSON, no storage
 * or a storage that throws give the default.
 * @param {Pick<Storage, 'getItem'> | null} storage
 * @returns {Settings}
 */
export function readSettings(storage) {
  /** @type {unknown} */
  let stored = null;
  try {
    stored = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  const settings = { ...DEFAULTS };
  if (typeof stored !== 'object' || stored === null) return settings;
  const fields = /** @type {Record<string, unknown>} */ (stored);
  for (const key of /** @type {const} */ (['anim', 'sound', 'music'])) {
    if (typeof fields[key] === 'boolean') settings[key] = fields[key];
  }
  for (const key of /** @type {const} */ (['soundVol', 'musicVol'])) {
    const value = fields[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100) {
      settings[key] = value;
    }
  }
  return settings;
}

/**
 * Keeps the settings on this device; without storage they last for this page only.
 * @param {Pick<Storage, 'setItem'> | null} storage
 * @param {Settings} settings
 */
export function writeSettings(storage, settings) {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A private window or a full storage: the settings stay for this page.
  }
}

/**
 * Animations play only when they are on and the system does not ask for less motion.
 * @param {Settings} settings
 * @param {boolean} reducedMotion
 */
export function canMove(settings, reducedMotion) {
  return settings.anim && !reducedMotion;
}

/** A volume in per cent as a gain from 0 to 1. @param {number} percent */
export function level(percent) {
  return Math.min(1, Math.max(0, percent / 100));
}

/**
 * A variant of a set from 1 to `count`, never the one played last time when there is a choice.
 * @param {number} count
 * @param {number | undefined} last
 * @param {() => number} random a number from 0 up to 1, not 1
 */
export function pickVariant(count, last, random = Math.random) {
  if (count <= 1) return 1;
  const known = last !== undefined && last >= 1 && last <= count;
  const variant = 1 + Math.floor(random() * (known ? count - 1 : count));
  return known && variant >= last ? variant + 1 : variant;
}

/**
 * Where the music of this tab stopped: a piece from 1 to `pieces` and a time in seconds, or null
 * for nothing kept or something broken.
 * @param {Pick<Storage, 'getItem'> | null} storage
 * @param {number} pieces
 * @returns {MusicPlace | null}
 */
export function readMusic(storage, pieces = PIECES) {
  /** @type {unknown} */
  let stored = null;
  try {
    stored = JSON.parse(storage?.getItem(MUSIC_KEY) ?? 'null');
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null) return null;
  const { piece, time, at } = /** @type {Record<string, unknown>} */ (stored);
  if (typeof piece !== 'number' || !Number.isInteger(piece) || piece < 1 || piece > pieces) {
    return null;
  }
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { piece, time, at };
}

/**
 * @param {Pick<Storage, 'setItem'> | null} storage
 * @param {MusicPlace} place
 */
export function writeMusic(storage, place) {
  try {
    storage?.setItem(MUSIC_KEY, JSON.stringify(place));
  } catch {
    // No storage: the next page starts a piece of its own.
  }
}

/** The piece after this one, round the list. @param {number} piece @param {number} pieces */
export function nextPiece(piece, pieces = PIECES) {
  return piece >= pieces ? 1 : piece + 1;
}

/** A new visit starts with a piece at random. @param {() => number} random */
export function firstPiece(random = Math.random, pieces = PIECES) {
  return 1 + Math.floor(random() * pieces);
}

/**
 * After a piece failed to load: try the next one while not every piece has failed in a row.
 * @param {number} failures pieces failed one after another, this one included
 */
export function tryNextPiece(failures, pieces = PIECES) {
  return failures < pieces;
}

/**
 * The loop of the fountain for this visit of the courtyard: the loops go round from 1, the next
 * visit plays the next one. Nothing kept or something broken starts with the first; without
 * storage every visit plays the first.
 * @param {Pick<Storage, 'getItem' | 'setItem'> | null} storage
 */
export function nextFountain(storage) {
  /** @type {unknown} */
  let kept = 0;
  try {
    kept = JSON.parse(storage?.getItem(FOUNTAIN_KEY) ?? '0');
  } catch {
    kept = 0;
  }
  const loop = Number.isInteger(kept) && Number(kept) >= 0 ? (Number(kept) % FOUNTAINS) + 1 : 1;
  try {
    storage?.setItem(FOUNTAIN_KEY, JSON.stringify(loop % FOUNTAINS));
  } catch {
    // No storage: the next visit plays the first again.
  }
  return loop;
}

/**
 * The rare events of the courtyard, in ms: a gust of wind in one of the crowns (2 s, with its
 * sound) and a flock of birds over the roofs (15 s) — the first after `first`, then one every
 * `every`, each time at random within the bounds.
 * @typedef {{ first: readonly [number, number], every: readonly [number, number] }} Times
 */
/** @type {Readonly<Times>} */
export const GUST = Object.freeze({ first: [14_000, 40_000], every: [14_000, 40_000] });
/** @type {Readonly<Times>} */
export const FLOCK = Object.freeze({ first: [4_000, 10_000], every: [20_000, 70_000] });

/**
 * @param {readonly [number, number]} bounds
 * @param {() => number} random a number from 0 up to 1, not 1
 */
export function between([min, max], random = Math.random) {
  return min + random() * (max - min);
}

/**
 * A chain of rare events on one timer at most. It runs only while resumed — the page resumes it
 * while the tab is seen and the event has anything to show or sound: pause() keeps the time left,
 * resume() goes on from there. A second resume() or pause() changes nothing.
 * @param {() => void} fire
 * @param {Times} times
 * @param {{ set: (go: () => void, ms: number) => unknown, clear: (timer: unknown) => void, now: () => number }} clock
 * @param {() => number} random
 */
export function createChain(fire, times, clock, random = Math.random) {
  let left = between(times.first, random);
  /** @type {unknown} */
  let timer = null;
  let due = 0;
  const resume = () => {
    if (timer !== null) return;
    due = clock.now() + left;
    timer = clock.set(() => {
      timer = null;
      left = between(times.every, random);
      resume();
      fire();
    }, left);
  };
  return {
    resume,
    pause() {
      if (timer === null) return;
      clock.clear(timer);
      timer = null;
      left = Math.max(0, due - clock.now());
    },
  };
}

/**
 * The effects of a link (data-fx, M10.2): a slide to the left or the right (the order of the
 * banner), a page of the book turned forward or back, one turned forward on the phone only, and
 * the sound of a page alone. A page turned slides the same way and rustles on the next page.
 * M10.3: the door of a place on the courtyard map (data-door names it).
 */
export const LINK_FX = Object.freeze([
  'left',
  'right',
  'flip-fwd',
  'flip-back',
  'flip-fwd-phone',
  'page',
  'door',
]);

/** A page waits this long for its slide away before it follows the link. */
export const SLIDE_MS = 500;

/**
 * Through a door: the door opens at once, from 0,55 s the scene zooms into it and from 1,15 s it
 * goes dark; the page follows the link at 1,7 s by its timer. A door not seen goes dark at once,
 * 0,5 s: there is nothing to look at.
 */
export const DOOR_MS = 1700;
export const DARK_MS = 500;

/**
 * How a page leaves through a door: into it while the middle of the door is seen — in the window
 * and in the map (the map of the phone shows only its top part) — otherwise into the dark.
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Box
 * @param {Box | null} door
 * @param {Box | null} map
 * @param {{ width: number, height: number }} view
 * @returns {{ away: 'go-door' | 'go-dark', ms: number }}
 */
export function doorWay(door, map, view) {
  if (door !== null && map !== null && door.right > door.left && door.bottom > door.top) {
    const x = (door.left + door.right) / 2;
    const y = (door.top + door.bottom) / 2;
    const across = x >= Math.max(0, map.left) && x <= Math.min(view.width, map.right);
    const down = y >= Math.max(0, map.top) && y <= Math.min(view.height, map.bottom);
    if (across && down) return { away: 'go-door', ms: DOOR_MS };
  }
  return { away: 'go-dark', ms: DARK_MS };
}

/**
 * A press that opens a link the ordinary way: the main button, no key held, no other window and
 * no download. Any other press is the browser's own, without effects.
 * @param {{ button: number, metaKey: boolean, ctrlKey: boolean, shiftKey: boolean, altKey: boolean }} event
 * @param {{ target: string, hasAttribute: (name: string) => boolean }} link
 */
export function plainPress(event, link) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (link.target === '' || link.target === '_self') &&
    !link.hasAttribute('download')
  );
}

/**
 * What a plain press on a link with data-fx does, or null: the browser follows the link as always.
 * `fx` is what the next page reads from hof.arrive; `away` the class of this page while it slides
 * away or goes through a door — only these wait, and only with «Анимации». Without them a page
 * turned or rustled and a door still have their sound on the next page.
 * @param {string | undefined} fx data-fx of the link
 * @param {{ move: boolean, sound: boolean, phone: boolean }} now
 * @returns {{ fx: string, away: 'go-left' | 'go-right' | 'go-door' | null } | null}
 */
export function leaving(fx, { move, sound, phone }) {
  if (fx === undefined || !LINK_FX.includes(fx)) return null;
  if (fx === 'flip-fwd-phone') {
    if (!phone) return null;
    fx = 'flip-fwd';
  }
  const slides = fx === 'left' || fx === 'right';
  if (!move && !(sound && !slides)) return null;
  if (!move || fx === 'page') return { fx, away: null };
  if (fx === 'door') return { fx, away: 'go-door' };
  return { fx, away: fx === 'left' || fx === 'flip-fwd' ? 'go-left' : 'go-right' };
}

/**
 * Leaves a flag for the next page, or takes it away (null).
 * @param {Pick<Storage, 'setItem' | 'removeItem'> | null} storage
 * @param {string} key
 * @param {object | null} value
 */
export function writeFlag(storage, key, value) {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // No storage: the next page comes without an effect.
  }
}

/**
 * Decor (M10.4, Ж4): what a thing with data-poke does when a pointer presses it — the set of its
 * sound. The cats meow; the cat of my chambers purrs. In Säckel (M10.5) the chest of the treasury
 * creaks and the cat at the empty pouches sniffs.
 */
export const POKES = Object.freeze({ meow: 'meow', purr: 'purr', chest: 'chest', sniff: 'sniff' });

/** The cat at the empty pouches sniffs for 3 s, at 0 and 1,5 s. */
export const SNIFFS = Object.freeze([0, 1500]);

/** The acts of Säckel that write money (M10.5): the next page rings with coins. */
export const MONEY = Object.freeze(['expense', 'income', 'assign', 'transfer']);

/** A press on these is the press of a control, also inside a thing with data-poke. */
const CONTROLS = 'a[href], button, input, select, textarea, label, summary, [tabindex]';

/**
 * The thing a press of a pointer pokes, or null: the nearest element with data-poke that fx.js
 * knows — never when the press is on a control.
 * @param {Element} target
 * @returns {HTMLElement | null}
 */
export function poked(target) {
  if (target.closest(CONTROLS) !== null) return null;
  const thing = /** @type {HTMLElement | null} */ (target.closest('[data-poke]'));
  return thing !== null && Object.hasOwn(POKES, thing.dataset.poke ?? '') ? thing : null;
}

/**
 * How long a cat keeps its other pose, in seconds: as long as its sound, at least 0,9 s; 1,2 s
 * without a sound or while its length is not known.
 * @param {number | null} sound the length of the sound in seconds
 */
export function poseTime(sound) {
  if (sound === null || !Number.isFinite(sound) || sound <= 0) return 1.2;
  return Math.max(0.9, sound);
}

/**
 * The guard against a form sent twice (§4.8): in this page a POST form goes once, until a new
 * page comes or this one comes back from the back/forward cache. Not idempotency: another tab, a
 * repeat of the network or a page without this script can still send twice.
 */
export function createGuard() {
  let sent = new WeakSet();
  return {
    /**
     * Whether this sending of the form goes. A GET form is never held.
     * @param {object & { method: string }} form
     */
    allow(form) {
      if (form.method !== 'post') return true;
      if (sent.has(form)) return false;
      sent.add(form);
      return true;
    },
    /** This page came back from the back/forward cache: every form may go again. */
    reset() {
      sent = new WeakSet();
    },
  };
}

// ---------- the page ----------

function start() {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  /** @param {'localStorage' | 'sessionStorage'} name */
  const storage = (name) => {
    try {
      return window[name];
    } catch {
      return null;
    }
  };
  const local = storage('localStorage');
  const session = storage('sessionStorage');
  let settings = readSettings(local);

  const showMotion = () => root.classList.toggle('fx-on', canMove(settings, reduced.matches));
  showMotion();
  reduced.addEventListener('change', showMotion);

  // ---- sound: <audio> through a GainNode — on iPhone a script cannot change the volume of
  // <audio> itself. Without Web Audio the element's own volume is used.
  /** @type {AudioContext | null} */
  let context = null;
  /**
   * @param {HTMLAudioElement} audio
   * @param {number} gain
   * @returns {{ gain: AudioParam | null, release: () => void }}
   */
  function output(audio, gain) {
    try {
      context ??= new AudioContext();
      const node = context.createGain();
      node.gain.value = gain;
      const source = context.createMediaElementSource(audio);
      source.connect(node).connect(context.destination);
      // Connected nodes stay alive with the context: a sound done with lets them go.
      let connected = true;
      const release = () => {
        if (!connected) return;
        connected = false;
        source.disconnect();
        node.disconnect();
      };
      return { gain: node.gain, release };
    } catch {
      audio.volume = gain;
      return { gain: null, release: () => {} };
    }
  }
  /**
   * @param {{ audio: HTMLAudioElement, gain: AudioParam | null }} sound
   * @param {number} target
   * @param {number} seconds
   */
  function setGain(sound, target, seconds) {
    if (sound.gain === null || context === null) {
      sound.audio.volume = target;
      return;
    }
    const now = context.currentTime;
    sound.gain.cancelScheduledValues(now);
    sound.gain.setValueAtTime(sound.gain.value, now);
    sound.gain.linearRampToValueAtTime(target, now + seconds);
  }
  // Sound can start only when the page may play it: a suspended context plays nothing.
  const audible = () => context === null || context.state === 'running';
  /** @param {number} ms */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Browsers let sound start only after an action of the person on the page (autoplay). What
  // could not start waits for the next press of a pointer or a key here (ARCHITECTURE §6, Ж3).
  /** @type {Set<() => void>} */
  const waiting = new Set();
  const onAction = () => {
    if (waiting.size === 0 && audible()) return;
    void context?.resume();
    const ready = [...waiting];
    waiting.clear();
    for (const go of ready) go();
  };
  for (const type of ['keydown', 'pointerdown', 'pointerup', 'touchend']) {
    addEventListener(type, onAction, { capture: true });
  }

  /** @type {Record<string, number>} */
  const lastVariant = {};
  /**
   * @param {string} name
   * @returns {HTMLAudioElement | null} the sound now played, for its length
   */
  function playSound(name) {
    const count = SOUNDS[name];
    if (!settings.sound || count === undefined) return null;
    const variant = pickVariant(count, lastVariant[name]);
    lastVariant[name] = variant;
    const audio = new Audio(soundAddress(name, variant));
    const { release } = output(audio, level(settings.soundVol));
    audio.addEventListener('ended', release, { once: true });
    audio.addEventListener('error', release, { once: true });
    void context?.resume();
    // Not allowed or not loaded: silence, and nothing tries again.
    audio.play().catch(release);
    duck();
    return audio;
  }

  // ---- music: one player in this page; the piece and the place are kept for the next one.
  /** @typedef {{ audio: HTMLAudioElement, gain: AudioParam | null, release: () => void, piece: number, from: number }} Track */
  /** @type {Track | null} */
  let track = null;
  /** The player switched off a moment ago while it fades out, and the timer that stops it. */
  /** @type {{ t: Track, timer: ReturnType<typeof setTimeout> } | null} */
  let fading = null;
  let failures = 0;
  let savedAt = 0;
  let duckTimer = 0;
  const musicGain = () => level(settings.musicVol) * (duckTimer === 0 ? 1 : DUCK);

  function duck() {
    if (track === null) return;
    clearTimeout(duckTimer);
    duckTimer = setTimeout(() => {
      duckTimer = 0;
      if (track !== null) setGain(track, musicGain(), 0.6);
    }, 900);
    setGain(track, musicGain(), 0.12);
  }

  /** @param {number} piece @param {number} from seconds */
  function open(piece, from) {
    const audio = new Audio(pieceAddress(piece));
    const t = { audio, ...output(audio, 0), piece, from };
    track = t;
    // A jump needs the server to answer ranges; where it cannot, the piece plays from its start.
    audio.addEventListener(
      'loadedmetadata',
      () => {
        if (from > 0 && from < audio.duration) audio.currentTime = from;
      },
      { once: true },
    );
    // The place is kept while the piece plays, not only when the page goes: Chrome shows a page
    // back from the back/forward cache before the page left has written its last place.
    audio.addEventListener('timeupdate', () => {
      if (track === t && Date.now() - savedAt >= 1000) savePlace();
    });
    audio.addEventListener('ended', () => {
      if (track !== t) return;
      close(t, 0);
      open(nextPiece(piece), 0);
    });
    audio.addEventListener('error', () => {
      if (track !== t) return;
      close(t, 0);
      failures += 1;
      if (tryNextPiece(failures)) open(nextPiece(piece), 0);
    });
    begin(t);
  }

  /** @param {NonNullable<typeof track>} t */
  function begin(t) {
    if (track !== t || !settings.music) return;
    // Resumed in the same action as play(); Firefox may finish play() first.
    const resumed = context?.resume();
    t.audio.play().then(
      async () => {
        if (track !== t) return;
        if (!audible() && resumed) await Promise.race([resumed, sleep(500)]).catch(() => {});
        if (track !== t) return;
        // Playing into a suspended context is silence: it waits as if refused.
        if (!audible()) return wait(t);
        failures = 0;
        setGain(t, musicGain(), 0.4);
      },
      () => {
        if (track === t) wait(t);
      },
    );
  }

  /** @param {NonNullable<typeof track>} t */
  function wait(t) {
    t.audio.pause();
    waiting.add(() => begin(t));
  }

  /** @param {NonNullable<typeof track>} t @param {number} seconds */
  function close(t, seconds) {
    if (track === t) track = null;
    const stop = () => {
      if (fading?.t === t) fading = null;
      t.audio.pause();
      t.audio.removeAttribute('src');
      t.audio.load();
      t.release();
    };
    if (seconds === 0) return stop();
    // Still heard while it fades out: switched on again by then, this player comes back.
    setGain(t, 0, seconds);
    fading = { t, timer: setTimeout(stop, seconds * 1000 + 50) };
  }

  /** «Музыка» on again while the piece switched off still fades out: the same player, no second one. */
  function comeBack() {
    if (fading === null || track !== null) return false;
    clearTimeout(fading.timer);
    track = fading.t;
    fading = null;
    begin(track);
    return true;
  }

  function startMusic() {
    if (!settings.music || track !== null) return;
    const place = readMusic(session);
    open(place?.piece ?? firstPiece(), place?.time ?? 0);
  }

  function savePlace() {
    if (track === null) return;
    const { audio } = track;
    // Not loaded yet: the place it was to start from.
    const time =
      audio.readyState >= HTMLMediaElement.HAVE_METADATA ? audio.currentTime : track.from;
    savedAt = Date.now();
    writeMusic(session, { piece: track.piece, time, at: savedAt });
  }
  addEventListener('pagehide', savePlace);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) savePlace();
  });

  // ---- «Звуки и движение» in «Мои покои»: hidden without this file.
  const block = document.getElementById('fx-settings');
  function showSettings() {
    if (block === null) return;
    block.hidden = false;
    for (const input of block.querySelectorAll('input[data-setting]')) {
      const key = /** @type {keyof Settings} */ (input.dataset.setting);
      if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
      else input.value = String(settings[key]);
      const shown = input.parentElement?.querySelector('output');
      if (shown) shown.value = `${input.value}\u00a0%`;
    }
  }
  /** @param {Event} event */
  function changeSetting(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.dataset.setting === undefined) return;
    // A box changes once (change), a slider while it moves (input).
    if ((input.type === 'checkbox') !== (event.type === 'change')) return;
    const key = /** @type {keyof Settings} */ (input.dataset.setting);
    settings = {
      ...settings,
      [key]: input.type === 'checkbox' ? input.checked : Number(input.value),
    };
    writeSettings(local, settings);
    showSettings();
    if (key === 'anim') showMotion();
    if (key === 'music') {
      if (settings.music) {
        if (!comeBack()) startMusic();
      } else if (track !== null) close(track, 0.4);
    }
    if (key === 'musicVol' && track !== null) setGain(track, musicGain(), 0.1);
  }
  if (block !== null) {
    showSettings();
    block.addEventListener('change', changeSetting);
    block.addEventListener('input', changeSetting);
    // The volume of sounds is tried when the slider is let go.
    block.addEventListener('change', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.dataset.setting === 'soundVol') {
        playSound('coins');
      }
    });
  }

  // ---- the way to the next page (M10.2). A link with data-fx: a slide away waits SLIDE_MS, a
  // door DOOR_MS or DARK_MS (M10.3), and then follows the link; a press on a link meanwhile goes
  // at once.
  const phone = matchMedia('(max-width: 1023.98px)');
  const LEAVING = ['go-left', 'go-right', 'keep-banner', 'go-door', 'go-dark'];
  /** The timer of the slide away or the door now on. @type {ReturnType<typeof setTimeout> | undefined} */
  let sliding;
  const stopSliding = () => {
    clearTimeout(sliding);
    sliding = undefined;
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement) || !plainPress(event, link)) return;
    // A second press while the page slides away: the browser follows the link pressed now.
    const second = sliding !== undefined;
    stopSliding();
    const move = canMove(settings, reduced.matches);
    const effect = leaving(link.dataset.fx, {
      move,
      sound: settings.sound,
      phone: phone.matches,
    });
    if (effect === null) return;
    const keep = link.dataset.keep !== undefined;
    writeFlag(session, ARRIVE_KEY, {
      fx: effect.fx,
      to: link.origin + link.pathname + link.search,
      at: Date.now(),
      keep,
    });
    if (effect.away === null || second) return;
    event.preventDefault();
    let away = effect.away;
    let ms = SLIDE_MS;
    if (away === 'go-door') {
      // The door of the place on the map — the one drawn now: in the link on a computer, on the
      // map of the phone for a sign under it. The creak comes in the same frame.
      const door = [...document.getElementsByClassName(`door-${link.dataset.door}`)].find(
        (element) => element.getClientRects().length > 0,
      );
      const inner = door?.closest('.court-inner');
      const map = door?.closest('.court-map');
      ({ away, ms } = doorWay(
        door?.getBoundingClientRect() ?? null,
        map?.getBoundingClientRect() ?? null,
        { width: innerWidth, height: innerHeight },
      ));
      if (away === 'go-door' && door !== undefined && inner instanceof HTMLElement) {
        // The zoom goes into the middle of the door, in per cent of the map.
        const d = door.getBoundingClientRect();
        const r = inner.getBoundingClientRect();
        const x = ((d.left + d.width / 2 - r.left) / r.width) * 100;
        const y = ((d.top + d.height / 2 - r.top) / r.height) * 100;
        inner.style.transformOrigin = `${x}% ${y}%`;
        door.classList.add('open');
      }
      setTimeout(() => playSound('door'), 0);
    }
    root.classList.add(away);
    if (keep) root.classList.add('keep-banner');
    sliding = setTimeout(() => {
      sliding = undefined;
      location.assign(link.href);
    }, ms);
  });

  // A page put away while it slides (Back pressed at once) does not follow the link when it
  // comes back, and the next page does not come as if it had.
  addEventListener('pagehide', () => {
    if (sliding !== undefined) writeFlag(session, ARRIVE_KEY, null);
    stopSliding();
  });

  // ---- a form goes once (§4.8). The first sending is not held or changed in any way: what comes
  // with it — the flag of its act for the next page, the door — is beside it, never before it.
  const guard = createGuard();
  document.addEventListener('submit', (event) => {
    if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
    const form = event.target;
    if (!guard.allow(form)) return event.preventDefault();
    stopSliding();
    const move = canMove(settings, reduced.matches);
    // Any other form takes the flag of the last one away.
    const act = form.dataset.fx;
    writeFlag(
      session,
      AFTER_KEY,
      act !== undefined && (move || settings.sound)
        ? { act, action: new URL(form.action).pathname, at: Date.now() }
        : null,
    );
    if (act === 'logout') {
      // The open door lies over the closed one (0,75 s in the CSS) while the form goes. The creak
      // comes after the sending has begun: the first sound of a page may take the browser a while.
      if (move) form.querySelector('.frames')?.classList.add('open');
      setTimeout(() => playSound('door'), 0);
    }
    // The gate of the founding opens as the form goes (M10.4); the form does not wait for it.
    if (act === 'setup' && move) document.querySelector('.gate-open')?.classList.add('open');
  });

  // ---- decor (M10.4): a thing with data-poke answers a press of a pointer on itself — never one
  // on a control — and changes no way, tells and keeps nothing. A cat sounds and, with
  // «Анимации», takes its other pose for as long as the sound. The chest of Säckel (M10.5) creaks
  // and, with «Анимации», opens; the next press closes it. The cat at the empty pouches sniffs
  // twice and, with «Анимации», sniffs at them in its frames; a press meanwhile starts it again.
  /** The second sniff of the cat now sniffing. @type {ReturnType<typeof setTimeout> | undefined} */
  let sniffing;
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const thing = poked(event.target);
    if (thing === null) return;
    const poke = /** @type {keyof typeof POKES} */ (thing.dataset.poke);
    const move = canMove(settings, reduced.matches);
    if (poke === 'chest') {
      playSound('chest');
      if (move) thing.classList.toggle('open');
      return;
    }
    if (poke === 'sniff') {
      clearTimeout(sniffing);
      playSound('sniff');
      sniffing = setTimeout(() => playSound('sniff'), SNIFFS[1]);
      if (move) replay(thing, 'sniffing');
      return;
    }
    const audio = playSound(POKES[poke]);
    if (!move) return;
    /** @param {number | null} seconds */
    const hold = (seconds) => thing.style.setProperty('--pose', `${poseTime(seconds)}s`);
    hold(
      audio !== null && audio.readyState >= HTMLMediaElement.HAVE_METADATA ? audio.duration : null,
    );
    audio?.addEventListener('loadedmetadata', () => hold(audio.duration), { once: true });
    replay(thing, 'meow');
  });
  /** Starts the animation of a class again. @param {HTMLElement} thing @param {string} name */
  function replay(thing, name) {
    thing.classList.remove(name);
    void thing.offsetWidth;
    thing.classList.add(name);
  }
  document.addEventListener('animationend', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.animationName === 'pose') event.target.classList.remove('meow');
    if (event.animationName === 'sniff-b') event.target.classList.remove('sniffing');
  });

  // ---- back from the back/forward cache: the page is as it was left, the world may not be.
  addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    guard.reset();
    // As before it left: light, in its place, the doors closed.
    stopSliding();
    root.classList.remove(
      ...LEAVING,
      'from-left',
      'from-right',
      'from-door',
      'unroll',
      'key-off',
      'spent',
    );
    for (const open of document.querySelectorAll(
      '.frames.open, .door.open, .gate-open.open, [data-poke="chest"].open',
    )) {
      open.classList.remove('open');
    }
    for (const cat of document.querySelectorAll('.cat.meow')) cat.classList.remove('meow');
    clearTimeout(sniffing);
    for (const cat of document.querySelectorAll('.sniffing')) cat.classList.remove('sniffing');
    for (const inner of document.querySelectorAll('.court-inner')) {
      if (inner instanceof HTMLElement) inner.style.removeProperty('transform-origin');
    }
    settings = readSettings(local);
    showMotion();
    showSettings();
    courtBack();
    // A piece put away while fading out ends now: the place to go on from is decided below.
    if (fading !== null) {
      clearTimeout(fading.timer);
      close(fading.t, 0);
    }
    if (!settings.music) {
      if (track !== null) close(track, 0);
      return;
    }
    // Another page played on since this one was put away: go on from its place, not from here.
    const place = readMusic(session);
    if (track !== null && place !== null && place.at > savedAt) close(track, 0);
    if (track === null) startMusic();
    else begin(track);
  });

  startMusic();

  // The page arrived by a page of the book turned or by «Назад» and «Следующие 50» of Летопись:
  // the sound of a page, the music a little quieter under it (fx-head.js has checked the flag).
  // Through a door without «Анимации» the creak comes here; with them it came at the press.
  const arrived = root.dataset.arrived;
  delete root.dataset.arrived;
  if (arrived === 'flip-fwd' || arrived === 'flip-back' || arrived === 'page') playSound('page');
  if (arrived === 'door' && !canMove(settings, reduced.matches)) playSound('door');
  // Signed in or founded (M10.4): two rustles of cloth while the banner unrolls, at 0 and 0,6 s —
  // where the banner is drawn: the phone has none.
  if (
    (arrived === 'login' || arrived === 'setup') &&
    document.querySelector('.banner')?.getClientRects().length
  ) {
    playSound('banner');
    setTimeout(() => playSound('banner'), 600);
  }
  // Money of Säckel written (M10.5): the coins, also without «Анимации».
  if (arrived !== undefined && MONEY.includes(arrived)) playSound('coins');

  // ---- the living courtyard (M10.3): the fountain, the wind in the crowns, the birds. The
  // frames turning round (water, banners, smoke) are the CSS alone.
  const fountain = document.querySelector('.fx-fountain');
  const leaves = [...document.querySelectorAll('.fx-leaves')];
  const flock = document.querySelector('.fx-birds');

  // The fountain: a quiet loop while «Звуки» are on, the next of the loops on each visit, 2 s to
  // come up. It waits for an action of the person as music does.
  /** @type {{ audio: HTMLAudioElement, gain: AudioParam | null, release: () => void } | null} */
  let water = null;
  /** @param {NonNullable<typeof water>} w */
  function flow(w) {
    if (water !== w) return;
    const resumed = context?.resume();
    w.audio.play().then(
      async () => {
        if (water !== w) return;
        if (!audible() && resumed) await Promise.race([resumed, sleep(500)]).catch(() => {});
        if (water !== w) return;
        if (!audible()) {
          w.audio.pause();
          waiting.add(() => flow(w));
          return;
        }
        setGain(w, level(settings.soundVol), 2);
      },
      () => {
        if (water === w) waiting.add(() => flow(w));
      },
    );
  }
  // Before the first action of the person on this page no sound may start, and a context made
  // then only makes Chrome warn: the fountain waits for the action, a gust is silent.
  const allowed = () => navigator.userActivation?.hasBeenActive !== false;
  function startFountain() {
    if (fountain === null || !settings.sound || water !== null) return;
    if (!allowed()) {
      waiting.add(startFountain);
      return;
    }
    const audio = new Audio(fountainAddress(nextFountain(local)));
    audio.loop = true;
    // Not there or not playable: silence, nothing tries again.
    audio.addEventListener('error', () => {
      if (water?.audio === audio) stopFountain();
    });
    water = { audio, ...output(audio, 0) };
    flow(water);
  }
  function stopFountain() {
    if (water === null) return;
    const w = water;
    water = null;
    w.audio.pause();
    w.audio.removeAttribute('src');
    w.audio.load();
    w.release();
  }

  // The leaves: their frames are large and wait until the page has loaded; a crown gusts only
  // with its frames loaded. The address is the one the CSS gives the crown once it is awake.
  /** @type {Set<Element>} */
  const ready = new Set();
  function wake() {
    if (!canMove(settings, reduced.matches)) return;
    for (const layer of leaves) {
      if (layer.classList.contains('wake')) continue;
      layer.classList.add('wake');
      const address = /url\("?([^")]+)"?\)/.exec(getComputedStyle(layer).backgroundImage)?.[1];
      if (address === undefined) continue;
      const image = new Image();
      image.src = address;
      image.decode().then(
        () => ready.add(layer),
        () => {},
      );
    }
  }
  function gust() {
    if (canMove(settings, reduced.matches)) {
      wake();
      const crowns = [...ready];
      const crown = crowns[Math.floor(Math.random() * crowns.length)];
      if (crown !== undefined) {
        crown.classList.remove('gust');
        void (/** @type {HTMLElement} */ (crown).offsetWidth);
        crown.classList.add('gust');
      }
    }
    if (allowed()) playSound('wind');
  }
  function fly() {
    if (flock === null || !canMove(settings, reduced.matches)) return;
    flock.classList.remove('fly');
    void (/** @type {HTMLElement} */ (flock).offsetWidth);
    flock.classList.add('fly');
  }
  for (const layer of [...leaves, flock]) {
    layer?.addEventListener('animationend', (event) => {
      if (event.target === layer) layer.classList.remove('gust', 'fly');
    });
  }

  // One chain of timers for the wind and one for the birds, and only while the tab is seen and
  // the chain has anything to show or sound: the wind while «Анимации» or «Звуки» are on, the
  // birds with «Анимации».
  const clock = {
    set: (/** @type {() => void} */ go, /** @type {number} */ ms) => setTimeout(go, ms),
    clear: (/** @type {unknown} */ timer) =>
      clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer)),
    now: () => Date.now(),
  };
  const wind = leaves.length > 0 ? createChain(gust, GUST, clock) : null;
  const birds = flock !== null ? createChain(fly, FLOCK, clock) : null;
  function live() {
    const seen = !document.hidden;
    const move = canMove(settings, reduced.matches);
    if (seen && (move || settings.sound)) wind?.resume();
    else wind?.pause();
    if (seen && move) birds?.resume();
    else birds?.pause();
  }
  document.addEventListener('visibilitychange', live);
  // Motion allowed again: the crowns that have not woken yet wake now, not at the next gust.
  reduced.addEventListener('change', () => {
    live();
    wake();
  });
  addEventListener('pagehide', () => {
    wind?.pause();
    birds?.pause();
  });
  live();
  startFountain();
  if (document.readyState === 'complete') wake();
  else addEventListener('load', wake, { once: true });

  /** Back from the back/forward cache: the settings may have changed meanwhile. */
  function courtBack() {
    live();
    wake();
    if (!settings.sound) stopFountain();
    else if (water === null) startFountain();
    else {
      setGain(water, 0, 0);
      flow(water);
    }
  }
}

if (typeof document !== 'undefined') start();
