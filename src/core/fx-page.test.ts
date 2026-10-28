// fx.js in a page made of only what it touches (ARCHITECTURE.md §6): fake <audio>, Web Audio and
// storage, and the events of «Звуки и движение». Music switched off and on again at once must not
// give a second piece; the ordinary off still stops and lets go of the player; a short sound lets
// go of its Web Audio nodes when it ends, fails or is refused.

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

type Listener = (event: { type: string; target?: unknown }) => void;

class FakeParam {
  value = 1;
  cancelScheduledValues() {}
  setValueAtTime(value: number) {
    this.value = value;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
  }
}

class FakeNode {
  connected = true;
  connect<T>(next: T): T {
    return next;
  }
  disconnect() {
    this.connected = false;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeAudio {
  static made: FakeAudio[] = [];
  // Set by a test: play() is refused, as by the autoplay rules of a browser.
  static refuse = false;
  paused = true;
  currentTime = 0;
  duration = 100;
  readyState = 1;
  volume = 1;
  listeners = new Map<string, Listener[]>();
  src: string;
  constructor(src: string) {
    this.src = src;
    FakeAudio.made.push(this);
  }
  play(): Promise<void> {
    if (FakeAudio.refuse) return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }
}

// One AudioContext of the page; every <audio> it plays through, with its source and gain node.
class FakeContext {
  static last: FakeContext | null = null;
  state = 'running';
  currentTime = 0;
  destination = new FakeNode();
  wires: { audio: FakeAudio; source: FakeNode; gain: FakeGain }[] = [];
  private nextGain: FakeGain | null = null;
  constructor() {
    FakeContext.last = this;
  }
  createGain() {
    this.nextGain = new FakeGain();
    return this.nextGain;
  }
  createMediaElementSource(audio: FakeAudio) {
    const source = new FakeNode();
    this.wires.push({ audio, source, gain: this.nextGain! });
    return source;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeInput {
  checked = false;
  value = '';
  parentElement = null;
  dataset: { setting: string };
  type: 'checkbox' | 'range';
  constructor(setting: string, type: 'checkbox' | 'range') {
    this.dataset = { setting };
    this.type = type;
  }
}

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

// A new page each time: its own storage, block and module instance of fx.js.
let pages = 0;
async function openChambers() {
  FakeAudio.made = [];
  FakeAudio.refuse = false;
  FakeContext.last = null;
  const inputs = {
    anim: new FakeInput('anim', 'checkbox'),
    sound: new FakeInput('sound', 'checkbox'),
    soundVol: new FakeInput('soundVol', 'range'),
    music: new FakeInput('music', 'checkbox'),
    musicVol: new FakeInput('musicVol', 'range'),
  };
  const blockListeners = new Map<string, Listener[]>();
  const block = {
    hidden: true,
    querySelectorAll: () => Object.values(inputs),
    addEventListener(type: string, listener: Listener) {
      blockListeners.set(type, [...(blockListeners.get(type) ?? []), listener]);
    },
  };
  Object.assign(globalThis, {
    window: { localStorage: memory(), sessionStorage: memory() },
    document: {
      hidden: false,
      documentElement: { classList: { toggle() {} } },
      getElementById: (id: string) => (id === 'fx-settings' ? block : null),
      addEventListener() {},
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    Audio: FakeAudio,
    AudioContext: FakeContext,
    HTMLInputElement: FakeInput,
    HTMLFormElement: class {},
    HTMLMediaElement: { HAVE_METADATA: 1 },
  });
  pages += 1;
  await import(`./static/fx.js?page=${pages}`);
  // A box changes by «change», a slider by «input» and, when let go, «change».
  const change = async (input: FakeInput, value: boolean | string) => {
    if (typeof value === 'boolean') input.checked = value;
    else input.value = value;
    const types = input.type === 'checkbox' ? ['change'] : ['input', 'change'];
    for (const type of types) {
      for (const listener of blockListeners.get(type) ?? []) listener({ type, target: input });
    }
    await settle();
  };
  return { inputs, change };
}

// Lets the promises of play() and resume() run.
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

const pieces = () => FakeAudio.made.filter((audio) => audio.src.includes('/music/'));
const playing = () => pieces().filter((audio) => !audio.paused);
const wiresOf = (audio: FakeAudio) => FakeContext.last!.wires.find((wire) => wire.audio === audio)!;

describe('fx.js in a page: music', () => {
  test('off and on at once: the same player comes back, never a second piece', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { inputs, change } = await openChambers();
    await change(inputs.music, true);
    assert.equal(pieces().length, 1);
    assert.equal(playing().length, 1);
    const [first] = pieces();

    await change(inputs.music, false);
    // Fading out: still heard.
    assert.equal(playing().length, 1);
    await change(inputs.music, true);
    assert.equal(pieces().length, 1, 'no second player');
    assert.deepEqual(playing(), [first]);
    assert.ok(wiresOf(first!).gain.gain.value > 0, 'faded in again');

    // The stop of the fade-out does not come later and silence the piece.
    t.mock.timers.tick(1000);
    await settle();
    assert.deepEqual(playing(), [first]);
    assert.ok(first!.src.includes('/music/'));
    assert.equal(wiresOf(first!).source.connected, true);
  });

  test('the ordinary off: faded out, stopped, its nodes let go; on again — one new piece', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { inputs, change } = await openChambers();
    await change(inputs.music, true);
    const [first] = pieces();
    await change(inputs.music, false);
    assert.equal(wiresOf(first!).gain.gain.value, 0);
    t.mock.timers.tick(450);
    await settle();
    assert.equal(first!.paused, true);
    assert.equal(first!.src, '');
    assert.equal(wiresOf(first!).source.connected, false);
    assert.equal(wiresOf(first!).gain.connected, false);

    await change(inputs.music, true);
    assert.equal(FakeAudio.made.length, 2, 'one new player');
    assert.equal(playing().length, 1);
    assert.notEqual(playing()[0], first);
  });
});

describe('fx.js in a page: a short sound lets go of its nodes', () => {
  for (const end of ['ended', 'error'] as const) {
    test(`after «${end}»`, async () => {
      const { inputs, change } = await openChambers();
      await change(inputs.sound, true);
      await change(inputs.soundVol, '70');
      const [coins] = FakeAudio.made;
      assert.match(coins!.src, /^\/static\/sounds\/coins-[12]\.m4a$/);
      assert.equal(wiresOf(coins!).source.connected, true);
      coins!.fire(end);
      assert.equal(wiresOf(coins!).source.connected, false);
      assert.equal(wiresOf(coins!).gain.connected, false);
    });
  }

  test('when the browser refuses to play it', async () => {
    const { inputs, change } = await openChambers();
    await change(inputs.sound, true);
    FakeAudio.refuse = true;
    await change(inputs.soundVol, '70');
    const [coins] = FakeAudio.made;
    assert.equal(wiresOf(coins!).source.connected, false);
    assert.equal(wiresOf(coins!).gain.connected, false);
  });
});
