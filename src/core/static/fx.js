// Hof — effects (ARCHITECTURE.md §6): the settings «Звуки и движение» of this device, sounds,
// music, and the guard against a form sent twice (§4.8). Without this file everything works the
// same: links and forms are ordinary, the court is still and silent.
//
// The top of the file decides: small functions without the page, tested by src/core/fx.test.ts.
// start() at the bottom joins them to the page; it runs only in a browser. A module runs once a
// page, so nothing here is set up twice.
//
// Kept in the browser, nothing else: `hof.fx` in localStorage — the settings of this device;
// `hof.music` in sessionStorage — the piece of music and the place in it.

export const SETTINGS_KEY = 'hof.fx';
export const MUSIC_KEY = 'hof.music';

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
export const SOUNDS = Object.freeze({ coins: 2 });

/** The pieces of music, played in this order from 1. */
export const PIECES = 20;

/** Music is 4 dB quieter while a sound plays. */
export const DUCK = 10 ** (-4 / 20);

/** @param {string} name @param {number} variant */
export function soundAddress(name, variant) {
  return `/static/sounds/${name}-${variant}.m4a`;
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
  /** @param {string} name */
  function playSound(name) {
    const count = SOUNDS[name];
    if (!settings.sound || count === undefined) return;
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

  // ---- a form goes once (§4.8). The first sending is not held or changed in any way.
  const guard = createGuard();
  document.addEventListener('submit', (event) => {
    if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
    if (!guard.allow(event.target)) event.preventDefault();
  });

  // ---- back from the back/forward cache: the page is as it was left, the world may not be.
  addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    guard.reset();
    settings = readSettings(local);
    showMotion();
    showSettings();
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
}

if (typeof document !== 'undefined') start();
