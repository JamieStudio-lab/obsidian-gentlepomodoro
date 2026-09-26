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
  /** When stop() was asked for, in context time; null while it plays on. */
  stoppedAt: number | null;
  stop: (when?: number) => void;
  onended: (() => void) | null;
}

/**
 * What the fake decoder returns for bytes read from a (fake) vault file. The
 * bundled clips never pass through here, so they decode to the default.
 */
const vaultDecodes = new WeakMap<ArrayBuffer, number | "bad">();

class FakeAudioContext {
  static lastInstance: FakeAudioContext | null = null;
  static instances = 0;
  /** When set, every decode waits on it — to catch what lands mid-decode. */
  static decodeGate: Promise<void> | null = null;
  state: string = "running";
  resumeCalls = 0;
  started: number[] = [];
  /** The `tag` of each buffer started, in order: "bundled" or a vault path. */
  startedTags: string[] = [];
  /** Every source started, in order, so a test can stop or end one. */
  sources: FakeSource[] = [];
  currentTime = 10;
  destination = {};

  constructor() {
    FakeAudioContext.lastInstance = this;
    FakeAudioContext.instances++;
  }
  resume() {
    this.resumeCalls++;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  async decodeAudioData(bytes: ArrayBuffer) {
    if (FakeAudioContext.decodeGate) await FakeAudioContext.decodeGate;
    return this.decodeNow(bytes);
  }
  decodeNow(bytes: ArrayBuffer) {
    const fromVault = vaultDecodes.get(bytes);
    if (fromVault === "bad") return Promise.reject(new Error("EncodingError"));
    if (fromVault !== undefined) {
      const tag = (bytes as unknown as { tag: string }).tag;
      return Promise.resolve({ duration: fromVault, tag } as unknown as AudioBuffer);
    }
    return Promise.resolve({ duration: 2.5, tag: "bundled" } as unknown as AudioBuffer);
  }
  createBufferSource(): FakeSource {
    const self = this;
    const source: FakeSource = {
      buffer: null,
      connect: () => {},
      start: (n: number) => {
        self.started.push(n);
        self.startedTags.push((source.buffer as { tag: string }).tag);
        self.sources.push(source);
      },
      stoppedAt: null,
      stop: (when = 0) => {
        source.stoppedAt = when;
      },
      onended: null,
    };
    return source;
  }
  createGain() {
    const ramps: [number, number][] = [];
    return {
      gain: {
        value: 0,
        ramps,
        setValueAtTime: () => {},
        linearRampToValueAtTime: (v: number, t: number) => ramps.push([v, t]),
      },
      connect: () => {},
    };
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
  const shortened: number[] = [];
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
      shortenMusicDuckInOpenViews: (owed: number) => shortened.push(owed),
    },
    shortened,
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

// ---------------------------------------------------------------------------
// The user's own end-of-session sounds (0.6.7, issue #5). Everything here runs
// the REAL playSound — the engine tests replace it with a recorder, so the
// fallback that keeps cueIsAudible honest can only be seen from this file.
// ---------------------------------------------------------------------------

interface FakeVaultFile {
  path: string;
  stat: { mtime: number; size: number };
  /** Decoded length in seconds, or "bad" for a file the decoder rejects. */
  seconds: number | "bad";
}

/** A vault whose reads can be held open, to catch a cue that waits on one. */
function fakeVault(files: FakeVaultFile[]) {
  const reads: string[] = [];
  const failNextRead = new Set<string>();
  let hold: Promise<void> | null = null;
  let release: () => void = () => {};
  return {
    files,
    reads,
    /** The next read of this path throws, as a file iCloud is still fetching does. */
    failNextRead,
    holdReads() {
      hold = new Promise<void>((r) => {
        release = r;
      });
    },
    releaseReads() {
      release();
      hold = null;
    },
    getAbstractFileByPath: () => null,
    getFileByPath: (path: string) => files.find((f) => f.path === path) ?? null,
    readBinary: async (file: FakeVaultFile) => {
      reads.push(file.path);
      if (hold) await hold;
      if (failNextRead.delete(file.path)) throw new Error("EDEADLK: resource deadlock avoided");
      const bytes = new ArrayBuffer(8);
      (bytes as unknown as { tag: string }).tag = file.path;
      vaultDecodes.set(bytes, file.seconds);
      return bytes;
    },
  };
}

type Vault = ReturnType<typeof fakeVault>;

function makeCueStub(vault: Vault, overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const stub = makeStub(overrides);
  (stub.plugin.app as unknown as { vault: Vault }).vault = vault;
  return stub;
}

interface CueSeams {
  playSound: (file: string, path?: string | null) => Promise<string | null>;
  maybeChimeAtCrossing: () => void;
  endCueSounded: boolean;
}
const seams = (timer: TimerEngine) => timer as unknown as CueSeams;

/** Let every settled promise's continuations run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const GONG: FakeVaultFile = {
  path: "Sounds/gong.mp3",
  stat: { mtime: 1, size: 40_000 },
  seconds: 12,
};
const file = (over: Partial<FakeVaultFile>): FakeVaultFile => ({
  ...GONG,
  stat: { ...GONG.stat },
  ...over,
});

describe("the user's own sounds", () => {
  beforeEach(() => {
    FakeAudioContext.lastInstance = null;
    FakeAudioContext.instances = 0;
    (globalThis as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
  });

  it("plays a loaded file instead of the built-in, and dips the music for its length", async () => {
    const vault = fakeVault([file({})]);
    const stub = makeCueStub(vault, { focusEndSound: `file:${GONG.path}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    expect((await timer.loadCustomCue(GONG.path)).ok).toBe(true);
    const played = await seams(timer).playSound("singing_bell_short.mp3", GONG.path);

    expect(played).toBe(GONG.path);
    expect(FakeAudioContext.lastInstance?.startedTags.at(-1)).toBe(GONG.path);
    expect(stub.ducks.at(-1)).toBe(12);
  });

  it("never waits on the vault: a file still loading plays the built-in", async () => {
    // A read from iCloud or a syncing phone can take seconds; a cue that
    // waited would land on top of whatever the user did next.
    const vault = fakeVault([file({})]);
    vault.holdReads();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(
      makeCueStub(vault, { focusEndSound: `file:${GONG.path}` }).plugin as any
    );

    const played = await seams(timer).playSound("singing_bell_short.mp3", GONG.path);
    expect(played).toBe("singing_bell_short.mp3");
    expect(FakeAudioContext.lastInstance?.startedTags).toEqual(["bundled"]);
    // ...and it started loading the file for next time.
    expect(vault.reads).toEqual([GONG.path]);

    vault.releaseReads();
    await flush();
    expect(await seams(timer).playSound("singing_bell_short.mp3", GONG.path)).toBe(GONG.path);
  });

  it("keeps a stamped crossing audible when the chosen file is missing", async () => {
    // The whole reason the fallback lives INSIDE playSound: cueIsAudible
    // mirrors playSound's two gates, so a crossing is stamped as heard — and a
    // file that returned silence here would make the following Stop silent too.
    const vault = fakeVault([]);
    const stub = makeCueStub(vault, {
      focusEndSoundEnabled: true,
      focusEndSound: "file:Sounds/gone.mp3",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    seams(timer).maybeChimeAtCrossing();
    await flush();

    expect(seams(timer).endCueSounded).toBe(true);
    expect(FakeAudioContext.lastInstance?.startedTags).toEqual(["bundled"]);
  });

  it("plays the built-in when the file cannot be decoded, and remembers that", async () => {
    const vault = fakeVault([file({ seconds: "bad" })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(
      makeCueStub(vault, { breakEndSound: `file:${GONG.path}` }).plugin as any
    );

    expect(await timer.loadCustomCue(GONG.path)).toEqual({ ok: false, problem: "undecodable" });
    expect(await seams(timer).playSound("ding-sound.mp3", GONG.path)).toBe("ding-sound.mp3");
    expect(await seams(timer).playSound("ding-sound.mp3", GONG.path)).toBe("ding-sound.mp3");
    // A bad file is read once, not on every cue.
    expect(vault.reads).toEqual([GONG.path]);
  });

  it("refuses an oversize file without reading it", async () => {
    const vault = fakeVault([file({ stat: { mtime: 1, size: 3 * 1024 * 1024 } })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault).plugin as any);

    expect(await timer.loadCustomCue(GONG.path)).toEqual({ ok: false, problem: "too-large" });
    expect(vault.reads).toEqual([]);
  });

  it("refuses a sound longer than 30 seconds", async () => {
    const vault = fakeVault([
      file({ seconds: 45 }),
      file({ path: "Sounds/ok.wav", seconds: 30.2 }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault).plugin as any);

    expect(await timer.loadCustomCue(GONG.path)).toEqual({ ok: false, problem: "too-long" });
    expect((await timer.loadCustomCue("Sounds/ok.wav")).ok).toBe(true);
  });

  it("reports a missing file without remembering it, so a synced-in file is found", async () => {
    const vault = fakeVault([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault).plugin as any);

    expect(await timer.loadCustomCue(GONG.path)).toEqual({ ok: false, problem: "missing" });
    vault.files.push(file({}));
    expect((await timer.loadCustomCue(GONG.path)).ok).toBe(true);
  });

  it("reads the file again once it has been edited", async () => {
    const edited = file({});
    const vault = fakeVault([edited]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(
      makeCueStub(vault, { focusEndSound: `file:${GONG.path}` }).plugin as any
    );
    await timer.loadCustomCue(GONG.path);

    edited.stat.mtime = 2;
    // The old decode no longer matches the file on disk, so the built-in
    // plays while the new version loads — never the stale sound.
    expect(await seams(timer).playSound("singing_bell_short.mp3", GONG.path)).toBe(
      "singing_bell_short.mp3"
    );
    await flush();
    expect(vault.reads).toEqual([GONG.path, GONG.path]);
    expect(await seams(timer).playSound("singing_bell_short.mp3", GONG.path)).toBe(GONG.path);
  });

  it("reads a file once when two callers ask for it at the same time", async () => {
    const vault = fakeVault([file({})]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault).plugin as any);

    await Promise.all([timer.loadCustomCue(GONG.path), timer.loadCustomCue(GONG.path)]);
    expect(vault.reads).toEqual([GONG.path]);
  });

  it("keeps only the chosen files, plus the one being checked", async () => {
    // A decoded 30-second sound is about 11 MB; picking through a folder of
    // them must not keep every one.
    const vault = fakeVault([
      file({ path: "chosen.mp3" }),
      file({ path: "tried-1.mp3" }),
      file({ path: "tried-2.mp3" }),
    ]);
    const stub = makeCueStub(vault, { focusEndSound: "file:chosen.mp3" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    // The tried files are picks being checked — held until their pick decides,
    // so it is the sweep on the NEXT load that has to let go of them.
    await timer.loadCustomCue("chosen.mp3");
    await timer.loadCustomCue("tried-1.mp3", true);
    await timer.loadCustomCue("tried-2.mp3", true); // evicts tried-1, never the chosen one
    await timer.loadCustomCue("tried-1.mp3", true);
    await timer.loadCustomCue("chosen.mp3");

    expect(vault.reads.filter((p) => p === "tried-1.mp3")).toHaveLength(2);
    expect(vault.reads.filter((p) => p === "chosen.mp3")).toHaveLength(1);
  });

  it("prepares nothing on the default sounds — no read, no audio context", () => {
    const vault = fakeVault([file({})]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault).plugin as any);

    timer.prepareEndCues();
    expect(vault.reads).toEqual([]);
    expect(FakeAudioContext.instances).toBe(0);
  });

  it("prepares a chosen file ahead of time, so the first cue is the user's own", async () => {
    const vault = fakeVault([file({})]);
    const stub = makeCueStub(vault, { breakEndSound: `file:${GONG.path}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.prepareEndCues();
    await flush();
    expect(await seams(timer).playSound("ding-sound.mp3", GONG.path)).toBe(GONG.path);
  });

  it("decodes a chosen file again as soon as it is edited, not at the next cue", async () => {
    // Obsidian Sync or an editor rewrote the file: without this, the next cue
    // would find the old decode stale and play the built-in once.
    const edited = file({});
    const vault = fakeVault([edited, file({ path: "Projects/notes.mp3" })]);
    const stub = makeCueStub(vault, { focusEndSound: `file:${GONG.path}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.onFileModify({ path: "Projects/notes.mp3" } as never);
    expect(vault.reads).toEqual([]); // not a chosen sound: left alone
    edited.stat.mtime = 5;
    await timer.onFileModify({ path: GONG.path } as never);
    await flush();
    expect(vault.reads).toEqual([GONG.path]);
    expect(await seams(timer).playSound("singing_bell_short.mp3", GONG.path)).toBe(GONG.path);
  });

  it("reads a file again after a read that failed, though the file never changed", async () => {
    // iCloud still downloading an offloaded file, or OneDrive holding it: the
    // read fails, but mtime and size are the same once it is readable. Cached,
    // the file was refused until it was edited or Obsidian restarted.
    const vault = fakeVault([file({})]);
    vault.failNextRead.add(GONG.path);
    // Named by a setting, so only the read-failure rule can let it go.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(
      makeCueStub(vault, { focusEndSound: `file:${GONG.path}` }).plugin as any
    );

    expect(await timer.loadCustomCue(GONG.path)).toEqual({ ok: false, problem: "unreadable" });
    await flush();
    expect((await timer.loadCustomCue(GONG.path)).ok).toBe(true);
    expect(vault.reads).toEqual([GONG.path, GONG.path]);
  });

  it("keeps a file that is still loading when another is checked", async () => {
    // Two quick picks, one on each row: sweeping the first while it loads
    // made each pick read and decode its file twice.
    const vault = fakeVault([file({ path: "a.mp3" }), file({ path: "c.mp3" })]);
    vault.holdReads();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault).plugin as any);

    // Two picks: neither file is named by a setting until its pick saves.
    const a = timer.loadCustomCue("a.mp3", true);
    const c = timer.loadCustomCue("c.mp3", true);
    vault.releaseReads();
    await Promise.all([a, c]);
    await timer.loadCustomCue("a.mp3", true);
    await timer.loadCustomCue("c.mp3", true);
    expect(vault.reads).toEqual(["a.mp3", "c.mp3"]);
  });

  it("lets go of a file the settings no longer name when asked to", async () => {
    // Switching a row back to a built-in sweeps nothing on its own — only a
    // load does — so the tab releases after every saved pick.
    const vault = fakeVault([file({ path: "old.mp3" })]);
    const stub = makeCueStub(vault, { focusEndSound: "file:old.mp3" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await timer.loadCustomCue("old.mp3");

    timer.releaseUnchosenCues();
    await timer.loadCustomCue("old.mp3");
    expect(vault.reads).toEqual(["old.mp3"]); // still chosen: kept

    stub.settings.focusEndSound = "ding";
    timer.releaseUnchosenCues();
    await timer.loadCustomCue("old.mp3");
    expect(vault.reads).toEqual(["old.mp3", "old.mp3"]);
  });

  it("lets go of a file the row moved away from while it was decoding", async () => {
    // Decoded at startup (or after an edit) for a row that is switched to a
    // built-in before the read lands: nothing else would ever sweep it once
    // both rows are on built-ins, so it would stay decoded all session.
    const vault = fakeVault([file({})]);
    vault.holdReads();
    const stub = makeCueStub(vault, { focusEndSound: `file:${GONG.path}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    timer.prepareEndCues();
    stub.settings.focusEndSound = "drum";
    timer.releaseUnchosenCues(); // what the tab does after the save: keeps it, still loading
    vault.releaseReads();
    await flush();

    stub.settings.focusEndSound = `file:${GONG.path}`;
    await timer.loadCustomCue(GONG.path);
    expect(vault.reads).toEqual([GONG.path, GONG.path]); // it was let go
  });

  it("keeps a PICK's file after it loads, though no setting names it yet", async () => {
    // Otherwise every pick would read its file twice: once to check it, and
    // again for the preview right after it is saved.
    const vault = fakeVault([file({})]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault).plugin as any);
    await timer.loadCustomCue(GONG.path, true);
    await flush();
    await timer.loadCustomCue(GONG.path, true);
    expect(vault.reads).toEqual([GONG.path]);
  });

  it("starts a fresh read when one has hung, instead of joining it forever", async () => {
    // A stalled iCloud read never settles; joining it made a later pick of
    // that file do nothing at all — no sound, no refusal, no status.
    const vault = fakeVault([file({})]);
    vault.holdReads();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault).plugin as any);
    const realNow = Date.now;
    let now = realNow();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      void timer.loadCustomCue(GONG.path, true);
      now += 5_000;
      void timer.loadCustomCue(GONG.path, true); // still young: joined
      expect(vault.reads).toEqual([GONG.path]);
      now += 11_000;
      void timer.loadCustomCue(GONG.path, true); // 16 s and nothing: retried
      await flush();
      expect(vault.reads).toEqual([GONG.path, GONG.path]);
    } finally {
      clock.mockRestore();
      vault.releaseReads();
    }
  });

  it("opens no audio context for a file read that lands after unload", async () => {
    const vault = fakeVault([file({})]);
    vault.holdReads();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault).plugin as any);

    const load = timer.loadCustomCue(GONG.path);
    await flush();
    timer.dispose();
    vault.releaseReads();

    expect((await load).ok).toBe(false);
    expect(FakeAudioContext.instances).toBe(0);
  });
});

// Each of these rules walks BOTH edges; a version that forgot one edge kept
// the whole suite green when each was tested on one edge only.
describe.each([
  ["focus", "focusEndSound", "breakEndSound"],
  ["break", "breakEndSound", "focusEndSound"],
] as const)("the %s edge's file", (_edge, key, otherKey) => {
  beforeEach(() => {
    FakeAudioContext.lastInstance = null;
    FakeAudioContext.instances = 0;
    (globalThis as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
  });

  it("is decoded ahead of time", async () => {
    const vault = fakeVault([file({})]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault, { [key]: `file:${GONG.path}` }).plugin as any);
    timer.prepareEndCues();
    await flush();
    expect(vault.reads).toEqual([GONG.path]);
  });

  it("is decoded again when it is edited", async () => {
    const edited = file({});
    const vault = fakeVault([edited]);
    const stub = makeCueStub(vault, { [key]: `file:${GONG.path}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    edited.stat.mtime = 9;
    await timer.onFileModify({ path: GONG.path } as never);
    await flush();
    expect(vault.reads).toEqual([GONG.path]);
  });

  it("survives the sweep when an unrelated file is checked", async () => {
    const vault = fakeVault([
      file({}),
      file({ path: "other-row.mp3" }),
      file({ path: "tried.mp3" }),
    ]);
    const stub = makeCueStub(vault, {
      [key]: `file:${GONG.path}`,
      [otherKey]: "file:other-row.mp3",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await timer.loadCustomCue(GONG.path);
    await timer.loadCustomCue("other-row.mp3");
    await timer.loadCustomCue("tried.mp3");
    timer.releaseUnchosenCues();
    await timer.loadCustomCue(GONG.path);
    await timer.loadCustomCue("other-row.mp3");
    expect(vault.reads).toEqual([GONG.path, "other-row.mp3", "tried.mp3"]);
  });
});

describe("wakeAudio — inside the click", () => {
  beforeEach(() => {
    FakeAudioContext.lastInstance = null;
    FakeAudioContext.instances = 0;
    (globalThis as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
  });

  it("creates the context synchronously, so iOS counts the gesture", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(fakeVault([])).plugin as any);
    timer.wakeAudio();
    expect(FakeAudioContext.instances).toBe(1);
  });

  it.each(["suspended", "interrupted"])("resumes a %s context synchronously", (state) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(fakeVault([])).plugin as any);
    timer.wakeAudio();
    const ctx = FakeAudioContext.lastInstance!;
    ctx.state = state;
    ctx.resumeCalls = 0;
    timer.wakeAudio();
    expect(ctx.resumeCalls).toBe(1);
  });

  it("creates nothing once disposed", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(fakeVault([])).plugin as any);
    timer.dispose();
    timer.wakeAudio();
    expect(FakeAudioContext.instances).toBe(0);
  });
});

describe("previewEndCue — the settings tab's ▶", () => {
  beforeEach(() => {
    FakeAudioContext.lastInstance = null;
    FakeAudioContext.instances = 0;
    (globalThis as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
  });

  it("stays silent while Timer sounds is off, and says so", async () => {
    // The master switch promises "every sound the timer makes".
    const vault = fakeVault([file({})]);
    const stub = makeCueStub(vault, { soundEnabled: false, focusEndSound: `file:${GONG.path}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    expect(await timer.previewEndCue("focus")).toBe("muted");
    expect(FakeAudioContext.instances).toBe(0);
    expect(vault.reads).toEqual([]);
  });

  it("waits for the chosen file, so a new pick is heard as itself", async () => {
    const vault = fakeVault([file({})]);
    const stub = makeCueStub(vault, { breakEndSound: `file:${GONG.path}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    expect(await timer.previewEndCue("break")).toBe("played");
    expect(FakeAudioContext.lastInstance?.startedTags).toEqual([GONG.path]);
  });

  it("plays the EDGE it was asked for", async () => {
    const vault = fakeVault([file({})]);
    const stub = makeCueStub(vault, { focusEndSound: `file:${GONG.path}`, breakEndSound: "drum" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.previewEndCue("break");
    expect(FakeAudioContext.lastInstance?.startedTags).toEqual(["bundled"]);
    expect(vault.reads).toEqual([]);
  });

  it("plays nothing when the choice changed while its file loaded", async () => {
    // A pick made while ▶ waited plays its own sound; the old one after it
    // would sound as if the pick had not been saved.
    const vault = fakeVault([file({})]);
    vault.holdReads();
    const stub = makeCueStub(vault, { focusEndSound: `file:${GONG.path}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    const preview = timer.previewEndCue("focus");
    await flush();
    stub.settings.focusEndSound = "drum";
    vault.releaseReads();
    expect(await preview).toBe("stale");
    expect(FakeAudioContext.lastInstance?.started ?? []).toEqual([]);
  });

  it("is not the end of a session: the next overtime Stop still rings", async () => {
    const vault = fakeVault([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(makeCueStub(vault).plugin as any);

    await timer.previewEndCue("focus");
    expect(seams(timer).endCueSounded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stopping a preview (0.6.7, from the maintainer's own try-out): a preview was
// fire-and-forget like every cue, so ▶ on a 30-second file could not be
// stopped, and picking another sound played the new one on top of the old.
// Real cues stay fire-and-forget; only the preview is held and stoppable.
// ---------------------------------------------------------------------------
describe("stopping a preview", () => {
  beforeEach(() => {
    FakeAudioContext.lastInstance = null;
    FakeAudioContext.instances = 0;
    (globalThis as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
  });

  it("stops the playing preview, with a short fade rather than a click", async () => {
    const stub = makeCueStub(fakeVault([]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await timer.previewEndCue("focus");
    expect(timer.previewingEdge()).toBe("focus");

    timer.stopPreview();
    const ctx = FakeAudioContext.lastInstance!;
    const stopped = ctx.sources[0];
    expect(timer.previewingEdge()).toBe(null);
    // Stopped a moment AFTER now, once the gain has ramped to zero.
    expect(stopped.stoppedAt).toBeGreaterThan(ctx.currentTime);
    expect(stopped.stoppedAt).toBeLessThan(ctx.currentTime + 0.2);
  });

  it("lets only one preview play: a new one stops the last at once", async () => {
    const stub = makeCueStub(fakeVault([]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await timer.previewEndCue("focus");
    await timer.previewEndCue("break");

    const [first, second] = FakeAudioContext.lastInstance!.sources;
    expect(first.stoppedAt).not.toBe(null);
    expect(second.stoppedAt).toBe(null);
    expect(timer.previewingEdge()).toBe("break");
  });

  it("stops the old one BEFORE the new file has loaded", async () => {
    // Reading a file can take a moment; the old sound must not play through it.
    const vault = fakeVault([file({})]);
    const stub = makeCueStub(vault, { breakEndSound: `file:${GONG.path}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await timer.previewEndCue("focus");
    vault.holdReads();

    const next = timer.previewEndCue("break");
    expect(FakeAudioContext.lastInstance!.sources[0].stoppedAt).not.toBe(null);
    vault.releaseReads();
    await next;
  });

  it("never starts a preview that was stopped while its file loaded", async () => {
    // Closing the settings, or pressing another row's ▶, during the read.
    const vault = fakeVault([file({})]);
    vault.holdReads();
    const stub = makeCueStub(vault, { focusEndSound: `file:${GONG.path}` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    const pending = timer.previewEndCue("focus");
    await flush();
    timer.stopPreview();
    vault.releaseReads();

    expect(await pending).toBe("stale");
    expect(FakeAudioContext.lastInstance?.sources ?? []).toEqual([]);
    expect(timer.previewingEdge()).toBe(null);
  });

  it("never starts a built-in preview stopped while it was being decoded", async () => {
    // The first play of a bundled sound decodes it; ■ or another row's ▶ can
    // land inside that await, after previewEndCue's own checks have passed.
    let open: () => void = () => {};
    FakeAudioContext.decodeGate = new Promise<void>((r) => {
      open = r;
    });
    try {
      const stub = makeCueStub(fakeVault([]));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timer = new TimerEngine(stub.plugin as any);
      const pending = timer.previewEndCue("focus");
      await flush();
      timer.stopPreview();
      open();

      expect(await pending).toBe("stale");
      expect(FakeAudioContext.lastInstance?.sources).toEqual([]);
      expect(timer.previewingEdge()).toBe(null);
      expect(stub.ducks).toEqual([]); // nor dips the music for a sound it never plays
    } finally {
      FakeAudioContext.decodeGate = null;
    }
  });

  it("tells the settings tab when a preview starts, ends on its own, or is stopped", async () => {
    const stub = makeCueStub(fakeVault([]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const seen: (string | null)[] = [];
    timer.setPreviewListener(() => seen.push(timer.previewingEdge()));

    await timer.previewEndCue("focus");
    FakeAudioContext.lastInstance!.sources[0].onended?.(); // played to the end
    await timer.previewEndCue("break");
    timer.stopPreview();

    expect(seen).toEqual(["focus", null, "break", null]);
  });

  it("ignores the `ended` of a preview it already replaced", async () => {
    const stub = makeCueStub(fakeVault([]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await timer.previewEndCue("focus");
    await timer.previewEndCue("break");

    FakeAudioContext.lastInstance!.sources[0].onended?.(); // the stopped one ends
    expect(timer.previewingEdge()).toBe("break");
  });

  it("never stops a real cue", async () => {
    // Real cues stay fire-and-forget: two may overlap, as they always have.
    const stub = makeCueStub(fakeVault([]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await seams(timer).playSound("ding-sound.mp3");
    await timer.previewEndCue("focus");
    timer.stopPreview();

    const [real, preview] = FakeAudioContext.lastInstance!.sources;
    expect(real.stoppedAt).toBe(null);
    expect(preview.stoppedAt).not.toBe(null);
  });

  it("hands the music back once the real cues still ringing are done", async () => {
    // A 30-second preview stopped after two seconds would otherwise keep the
    // music down for the other 28.
    const stub = makeCueStub(fakeVault([]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await timer.previewEndCue("focus");
    timer.stopPreview();
    expect(stub.shortened).toEqual([0]); // nothing real is ringing

    await seams(timer).playSound("ding-sound.mp3"); // a real cue, 2.5 s here
    await timer.previewEndCue("break");
    timer.stopPreview();
    expect(stub.shortened[1]).toBeGreaterThan(2);
    expect(stub.shortened[1]).toBeLessThanOrEqual(2.5);
  });

  it("does nothing, and moves no music, when no preview is playing", () => {
    const stub = makeCueStub(fakeVault([]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    timer.stopPreview();
    expect(stub.shortened).toEqual([]);
  });
});
