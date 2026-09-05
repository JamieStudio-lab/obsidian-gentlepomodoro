import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// The real assets are .mp3 imports that @rollup/plugin-url turns into base64
// data URLs at build time; under vitest they resolve to plain paths, which
// playSound's base64 slice would choke on. Stub them with the shape the build
// actually produces so the function under test sees what ships.
vi.mock("../audioAssets", () => ({
  AUDIO_URLS: {
    "war-drum_short.mp3": "data:audio/mpeg;base64,QUFB",
    "singing_bell_short.mp3": "data:audio/mpeg;base64,QUFB",
    "ding-sound.mp3": "data:audio/mpeg;base64,QUFB",
  },
}));

import { TimerEngine } from "../TimerEngine";
import { DEFAULT_SETTINGS } from "../constants";

// ---------------------------------------------------------------------------
// playSound() — the plugin's ONE audio entry point, and until now the one piece
// of TimerEngine no test had ever executed: tests/timerEngine.test.ts replaces
// the whole method to record cue names. That left its gates unguarded, which a
// mutation run made visible — the volume-0 early return and the iOS
// "interrupted" resume both survived every other test in the suite.
// ---------------------------------------------------------------------------

interface FakeSource {
  buffer: unknown;
  connect: () => void;
  start: (n: number) => void;
}

class FakeAudioContext {
  static lastInstance: FakeAudioContext | null = null;
  state: string = "running";
  resumeCalls = 0;
  started: number[] = [];
  destination = {};

  constructor() {
    FakeAudioContext.lastInstance = this;
  }
  resume() {
    this.resumeCalls++;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  decodeAudioData(_bytes: ArrayBuffer) {
    return Promise.resolve({ duration: 2.5 } as unknown as AudioBuffer);
  }
  createBufferSource(): FakeSource {
    const self = this;
    return {
      buffer: null,
      connect: () => {},
      start: (n: number) => self.started.push(n),
    };
  }
  createGain() {
    return { gain: { value: 0 }, connect: () => {} };
  }
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = globalThis;
  if (typeof g.moment === "undefined") {
    g.moment = () => ({ format: () => "2025-05-18" });
  }
});

function makeStub(overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const ducks: number[] = [];
  const settings = { ...DEFAULT_SETTINGS, soundEnabled: true, soundVolume: 0.7, ...overrides };
  return {
    ducks,
    settings,
    plugin: {
      settings,
      logManager: {
        startSession: () => {},
        pauseSession: () => {},
        endSession: async () => {},
        updateTask: () => {},
      },
      app: { vault: { getAbstractFileByPath: () => null } },
      manifest: { dir: null },
      saveSettings: async () => {},
      duckMusicInOpenViews: (d: number) => ducks.push(d),
    },
  };
}

/** playSound is private; every caller goes through it, so the cast is the seam. */
const play = (timer: TimerEngine, file = "ding-sound.mp3") =>
  (timer as unknown as { playSound: (f: string) => Promise<void> }).playSound(file);

describe("playSound — the master gates", () => {
  beforeEach(() => {
    FakeAudioContext.lastInstance = null;
    (globalThis as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
  });

  it("plays and ducks the music at a normal volume", async () => {
    const stub = makeStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await play(new TimerEngine(stub.plugin as any));

    expect(FakeAudioContext.lastInstance?.started).toEqual([0]);
    // The duck is offered the clip's real length, so the dip matches the cue.
    expect(stub.ducks).toEqual([2.5]);
  });

  it("does nothing at all when Sound is off", async () => {
    const stub = makeStub({ soundEnabled: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await play(new TimerEngine(stub.plugin as any));

    // Not merely silent — inert. No context is even constructed, so a muted
    // crossing cannot touch the lofi player.
    expect(FakeAudioContext.lastInstance).toBe(null);
    expect(stub.ducks).toEqual([]);
  });

  it("does not dip the music for a cue at volume 0", async () => {
    // Volume 0 is reachable only from a hand-edited data.json, but playing
    // silence would still duck the lofi music for the length of the clip —
    // twice a session, for nothing anyone can hear.
    const stub = makeStub({ soundVolume: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await play(new TimerEngine(stub.plugin as any));

    expect(FakeAudioContext.lastInstance).toBe(null);
    expect(stub.ducks).toEqual([]);
  });

  it('resumes a context parked in iOS\'s "interrupted" state', async () => {
    // WebKit parks the context here on a phone call, Siri or a screen lock —
    // exactly the walked-away case the end-of-session chime exists for. It is
    // NOT "suspended", so a check for that alone leaves the cue inaudible with
    // no error anywhere.
    const stub = makeStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await play(timer); // first call builds the context
    const ctx = FakeAudioContext.lastInstance;
    expect(ctx).not.toBe(null);

    ctx!.state = "interrupted";
    ctx!.resumeCalls = 0;
    await play(timer);

    expect(ctx!.resumeCalls).toBe(1);
    expect(ctx!.started).toEqual([0, 0]);
  });

  it("resumes a suspended context and leaves a running one alone", async () => {
    const stub = makeStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await play(timer);
    const ctx = FakeAudioContext.lastInstance!;

    ctx.state = "suspended";
    ctx.resumeCalls = 0;
    await play(timer);
    expect(ctx.resumeCalls).toBe(1);

    ctx.state = "running";
    ctx.resumeCalls = 0;
    await play(timer);
    expect(ctx.resumeCalls).toBe(0);
  });

  it("reuses one context and decodes each clip once", async () => {
    // Chromium caps live AudioContexts, and the decode is the slow part of the
    // first cue; both are why the engine caches.
    const stub = makeStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const decode = vi.spyOn(FakeAudioContext.prototype, "decodeAudioData");

    await play(timer, "ding-sound.mp3");
    const first = FakeAudioContext.lastInstance;
    await play(timer, "ding-sound.mp3");
    await play(timer, "singing_bell_short.mp3");

    expect(FakeAudioContext.lastInstance).toBe(first);
    expect(decode).toHaveBeenCalledTimes(2); // once per distinct clip
    decode.mockRestore();
  });

  it("stays quiet, and does not throw, for a clip that is not bundled", async () => {
    const stub = makeStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await play(new TimerEngine(stub.plugin as any), "nope.mp3");

    expect(FakeAudioContext.lastInstance).toBe(null);
    expect(stub.ducks).toEqual([]);
  });
});
