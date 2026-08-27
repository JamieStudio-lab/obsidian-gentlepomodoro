import { describe, it, expect, beforeEach } from "vitest";
import { MusicController, type MusicHost } from "../MusicController";
import { YT_STATE, YT_EMBED_ORIGIN, type MusicResumeState, type ResumePlan } from "../youtubeMusic";
import {
  MUSIC_FADE_IN_MS,
  MUSIC_FADE_OUT_MS,
  MUSIC_FADE_ARM_TIMEOUT_MS,
  MUSIC_FADE_HOLD_MAX_MS,
  MUSIC_DUCK_DOWN_MS,
  MUSIC_DUCK_FACTOR,
  MUSIC_LISTENING_DELAY_MS,
  MUSIC_HANDSHAKE_RETRY_MS,
  MUSIC_HANDSHAKE_MAX_ATTEMPTS,
  MUSIC_ENDED_NOTICE_DELAY_MS,
  MUSIC_STALL_NOTICE_DELAY_MS,
  MUSIC_STALL_RENOTIFY_MS,
  MUSIC_ADVANCE_NOTICE_GRACE_MS,
} from "../constants";

const BOUNCED_ORIGIN = "https://www.youtube.com";

/**
 * A controllable clock. Timers fire in time order as `advance` walks forward,
 * and an interval reschedules itself — which is what makes a stepped volume
 * ramp observable one post at a time.
 */
class FakeClock {
  now = 1_700_000_000_000;
  private seq = 1;
  private timers = new Map<number, { at: number; every: number | null; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): number {
    const id = this.seq++;
    this.timers.set(id, { at: this.now + ms, every: null, fn });
    return id;
  }
  setInterval(fn: () => void, ms: number): number {
    const id = this.seq++;
    this.timers.set(id, { at: this.now + ms, every: ms, fn });
    return id;
  }
  clear(id: number): void {
    this.timers.delete(id);
  }
  get pending(): number {
    return this.timers.size;
  }
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const t = this.timers.get(nextId);
      if (!t) break;
      this.now = t.at;
      if (t.every === null) this.timers.delete(nextId);
      else t.at = this.now + t.every;
      t.fn();
    }
    this.now = target;
  }
}

interface Post {
  func: string;
  args: (number | string | boolean)[];
  origin: string;
}

/** The whole outside world, recorded. */
class Harness implements MusicHost {
  clock = new FakeClock();
  posts: Post[] = [];
  broadcasts: { payload: string; origins: readonly string[] }[] = [];
  notices: string[] = [];
  volume = 1;
  mountedSrc: string | null = null;
  mountCount = 0;
  unmountCount = 0;
  private onLoad: (() => void) | null = null;
  recorded: MusicResumeState[] = [];
  cleared: (string | null)[] = [];
  flushes = 0;
  /** Every value setTransportPlaying was called with, in order. */
  transport: boolean[] = [];
  /** What the controller reported about itself from *inside* that callback —
   *  the view's caption reads exactly this, so the two must already agree. */
  transportSelfReport: boolean[] = [];
  trackChanges = 0;
  ios = false;

  readonly controller: MusicController;

  constructor() {
    this.controller = new MusicController(this);
  }

  /* --- MusicHost --- */
  now(): number {
    return this.clock.now;
  }
  setTimeout(fn: () => void, ms: number): number {
    return this.clock.setTimeout(fn, ms);
  }
  clearTimeout(id: number): void {
    this.clock.clear(id);
  }
  setInterval(fn: () => void, ms: number): number {
    return this.clock.setInterval(fn, ms);
  }
  clearInterval(id: number): void {
    this.clock.clear(id);
  }
  mountPlayer(src: string, onLoad: () => void): void {
    this.mountedSrc = src;
    this.mountCount++;
    this.onLoad = onLoad;
  }
  unmountPlayer(): void {
    if (this.mountedSrc !== null) this.unmountCount++;
    this.mountedSrc = null;
    this.onLoad = null;
  }
  postToPlayer(payload: string, origin: string): void {
    // Mirrors `iframe?.contentWindow?.postMessage` — a command sent with no
    // frame mounted goes nowhere, silently.
    if (this.mountedSrc === null) return;
    const parsed = JSON.parse(payload) as { func: string; args: (number | string | boolean)[] };
    this.posts.push({ func: parsed.func, args: parsed.args, origin });
  }
  broadcastToPlayer(payload: string, origins: readonly string[]): void {
    if (this.mountedSrc === null) return;
    this.broadcasts.push({ payload, origins });
  }
  musicVolume(): number {
    return this.volume;
  }
  recordPosition(position: MusicResumeState): void {
    this.recorded.push({ ...position });
  }
  clearPosition(url: string | null): void {
    this.cleared.push(url);
  }
  flushPosition(): void {
    this.flushes++;
  }
  setTransportPlaying(playing: boolean): void {
    this.transport.push(playing);
    this.transportSelfReport.push(this.controller.showingAsPlaying);
  }
  onTrackChanged(): void {
    this.trackChanges++;
  }
  notice(message: string): void {
    this.notices.push(message);
  }
  isIosApp(): boolean {
    return this.ios;
  }

  /* --- driving the fake embed --- */
  fireLoad(): void {
    this.onLoad?.();
  }
  send(data: unknown, origin = YT_EMBED_ORIGIN): void {
    this.controller.handleFrameMessage(
      origin,
      typeof data === "string" ? data : JSON.stringify(data)
    );
  }
  ready(origin = YT_EMBED_ORIGIN): void {
    this.send({ event: "onReady" }, origin);
  }
  state(info: number, origin = YT_EMBED_ORIGIN): void {
    this.send({ event: "onStateChange", info }, origin);
  }
  info(fields: Record<string, unknown>, origin = YT_EMBED_ORIGIN): void {
    this.send({ event: "infoDelivery", info: fields }, origin);
  }

  /* --- queries --- */
  funcs(): string[] {
    return this.posts.map((p) => p.func);
  }
  volumes(): number[] {
    return this.posts.filter((p) => p.func === "setVolume").map((p) => Number(p.args[0]));
  }
  lastVolume(): number | undefined {
    return this.volumes().at(-1);
  }
  reset(): void {
    this.posts = [];
    this.broadcasts = [];
    this.notices = [];
    this.transport = [];
    this.transportSelfReport = [];
  }
}

const PLAN: ResumePlan = {
  target: { videoId: "abcdefghijk", playlistId: null, startSeconds: null },
  seekSeconds: null,
};
const LIST_PLAN: ResumePlan = {
  target: { videoId: "abcdefghijk", playlistId: "PL123456", startSeconds: null },
  seekSeconds: null,
};
const URL_A = "https://youtu.be/abcdefghijk";
const URL_B = "https://youtu.be/zyxwvutsrqp";

/** Build, hand over the load event and the handshake, and report ready. */
function boot(h: Harness, plan: ResumePlan = PLAN, url = URL_A): void {
  h.controller.build("https://www.youtube-nocookie.com/embed/abcdefghijk", plan, url);
  h.fireLoad();
  h.clock.advance(MUSIC_LISTENING_DELAY_MS);
  h.ready();
}

/** Boot and get all the way to audible playback with the fade-in finished. */
function bootPlaying(h: Harness, plan: ResumePlan = PLAN, url = URL_A): void {
  boot(h, plan, url);
  h.controller.pressPlay();
  h.state(YT_STATE.PLAYING);
  h.clock.advance(MUSIC_FADE_IN_MS + MUSIC_FADE_IN_MS);
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

describe("handshake", () => {
  it("announces itself after the load delay and keeps retrying until the embed answers", () => {
    h.controller.build("https://embed", PLAN, URL_A);
    h.fireLoad();
    expect(h.broadcasts).toHaveLength(0); // not until the delay has passed
    h.clock.advance(MUSIC_LISTENING_DELAY_MS);
    expect(h.broadcasts).toHaveLength(1);
    // Broadcast, not addressed: there is no learned origin yet, and a
    // nocookie-addressed handshake is dropped outright once the frame bounced.
    expect(h.broadcasts[0]?.origins.length).toBeGreaterThan(1);
    h.clock.advance(MUSIC_HANDSHAKE_RETRY_MS * 3);
    expect(h.broadcasts).toHaveLength(4);
  });

  it("stops retrying on the first message of any kind — even one the parser discards", () => {
    h.controller.build("https://embed", PLAN, URL_A);
    h.fireLoad();
    h.clock.advance(MUSIC_LISTENING_DELAY_MS + MUSIC_HANDSHAKE_RETRY_MS);
    expect(h.broadcasts).toHaveLength(2);
    h.send("not json at all");
    h.clock.advance(MUSIC_HANDSHAKE_RETRY_MS * 5);
    expect(h.broadcasts).toHaveLength(2);
  });

  it("gives up after MUSIC_HANDSHAKE_MAX_ATTEMPTS rather than retrying forever", () => {
    h.controller.build("https://embed", PLAN, URL_A);
    h.fireLoad();
    h.clock.advance(MUSIC_LISTENING_DELAY_MS);
    h.clock.advance(MUSIC_HANDSHAKE_RETRY_MS * (MUSIC_HANDSHAKE_MAX_ATTEMPTS + 5));
    expect(h.broadcasts.length).toBeLessThanOrEqual(MUSIC_HANDSHAKE_MAX_ATTEMPTS + 1);
  });

  it("addresses later commands to the origin the player actually spoke from", () => {
    boot(h, PLAN, URL_A);
    h.reset();
    // The embed bounces to www.youtube.com for some videos. Pinning commands to
    // the origin we loaded means the browser drops every one of them.
    h.state(YT_STATE.PAUSED, BOUNCED_ORIGIN);
    h.controller.pressPlay();
    expect(h.posts.every((p) => p.origin === BOUNCED_ORIGIN)).toBe(true);
  });

  it("ignores messages from an origin outside the allowlist", () => {
    boot(h, PLAN, URL_A);
    h.reset();
    h.state(YT_STATE.PLAYING, "https://evil.example");
    expect(h.transport).toEqual([]);
  });

  it("answers ▶️ before the handshake with an explanation, not a dropped command", () => {
    h.controller.build("https://embed", PLAN, URL_A);
    h.controller.pressPlay();
    expect(h.funcs()).toEqual([]);
    expect(h.notices[0]).toContain("hasn't loaded yet");
  });
});

describe("fade-in", () => {
  it("parks the player at silence and does not ramp until audio actually starts", () => {
    boot(h);
    h.reset();
    h.controller.pressPlay();
    expect(h.volumes()).toEqual([0]);
    expect(h.funcs()).toContain("playVideo");
    // The buffering gap has no audio in it; a fade spent there is a fade nobody hears.
    h.state(YT_STATE.BUFFERING);
    h.clock.advance(MUSIC_FADE_IN_MS);
    expect(h.volumes()).toEqual([0]);
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_IN_MS);
    expect(h.volumes().length).toBeGreaterThan(2);
    expect(h.lastVolume()).toBe(100);
  });

  it("holds the ramp while the player rebuffers instead of running through the silence", () => {
    boot(h);
    h.controller.pressPlay();
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_IN_MS / 4);
    h.reset();
    h.state(YT_STATE.BUFFERING); // a resumed track rebuffers right here
    h.clock.advance(MUSIC_FADE_IN_MS);
    expect(h.volumes()).toEqual([]); // held, not climbing through the gap
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_IN_MS);
    expect(h.lastVolume()).toBe(100);
  });

  it("bounds the hold, so a player that never comes back cannot strand the ramp", () => {
    boot(h);
    h.controller.pressPlay();
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_IN_MS / 4);
    h.state(YT_STATE.BUFFERING);
    h.clock.advance(MUSIC_FADE_HOLD_MAX_MS + MUSIC_FADE_IN_MS * 2);
    expect(h.lastVolume()).toBe(100);
  });

  it("stands the arm down when playback never starts, handing the volume control back", () => {
    // Trap 2: a dropped playVideo (iOS refusing a first play, a dead video)
    // must not leave the volume parked at 0 with postVolume locked out.
    boot(h);
    h.controller.pressPlay();
    h.reset();
    h.clock.advance(MUSIC_FADE_ARM_TIMEOUT_MS + 10);
    expect(h.lastVolume()).toBe(100);
  });

  it("hands a slowly-buffering player to the ramp rather than cancelling at the backstop", () => {
    boot(h);
    h.controller.pressPlay();
    h.state(YT_STATE.BUFFERING);
    h.reset();
    h.clock.advance(MUSIC_FADE_ARM_TIMEOUT_MS + 10);
    // Still buffering, so the ramp holds — cancelling here would make a slow
    // connection snap in at full volume once it finally plays.
    expect(h.volumes()).toEqual([]);
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_IN_MS);
    expect(h.volumes().length).toBeGreaterThan(1);
    expect(h.lastVolume()).toBe(100);
  });

  it("does not stand down on the transient UNSTARTED/CUED states on the way to playing", () => {
    boot(h);
    h.controller.pressPlay();
    h.reset();
    h.state(YT_STATE.UNSTARTED);
    h.state(YT_STATE.CUED);
    expect(h.volumes()).toEqual([]); // still armed, not reset to the user volume
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_IN_MS);
    expect(h.lastVolume()).toBe(100);
  });
});

describe("fade-out", () => {
  it("posts pauseVideo on the landing, not up front", () => {
    bootPlaying(h);
    h.reset();
    h.controller.pressPause();
    expect(h.funcs()).not.toContain("pauseVideo"); // cutting it dead leaves nothing to fade
    expect(h.transport).toEqual([false]); // but the button flips at once
    expect(h.transportSelfReport).toEqual([false]);
    h.clock.advance(MUSIC_FADE_OUT_MS);
    expect(h.funcs()).toContain("pauseVideo");
    expect(h.volumes().at(-1)).toBe(0); // silence reached before the command
    expect(h.funcs().at(-1)).toBe("pauseVideo");
  });

  it("▶️ inside the fade-out cancels the pause and eases back up (trap 1)", () => {
    bootPlaying(h);
    h.reset();
    h.controller.pressPause();
    h.clock.advance(MUSIC_FADE_OUT_MS / 3);
    h.controller.pressPlay();
    h.clock.advance(MUSIC_FADE_OUT_MS + MUSIC_FADE_IN_MS);
    // The player never stopped, so playVideo is a no-op and no state change
    // follows. An armed fade would wait forever with the volume at 0.
    expect(h.funcs()).not.toContain("pauseVideo");
    expect(h.lastVolume()).toBe(100);
    expect(h.transport.at(-1)).toBe(true);
  });

  it("a rebuffer landing mid-fade cannot put the pause button back", () => {
    bootPlaying(h);
    h.controller.pressPause();
    h.reset();
    h.state(YT_STATE.BUFFERING);
    expect(h.transport).toEqual([false]);
  });

  it("⏹ on an idle player still forgets the position instantly", () => {
    boot(h);
    h.controller.pressStop();
    expect(h.cleared).toEqual([URL_A]);
  });
});

describe("⏹ stop is atomic (trap 5)", () => {
  it("▶️ inside the fade cancels the whole stop, not just the command", () => {
    bootPlaying(h, PLAN, URL_A);
    h.info({ duration: 600, videoData: { video_id: "abcdefghijk" } });
    h.reset();
    h.controller.pressStop();
    h.clock.advance(MUSIC_FADE_OUT_MS / 3);
    h.controller.pressPlay();
    h.clock.advance(MUSIC_FADE_OUT_MS + MUSIC_FADE_IN_MS);
    expect(h.funcs()).not.toContain("stopVideo");
    expect(h.cleared).toEqual([]);
    // The aborted stop must leave currentDuration intact: a nulled duration
    // reads as "live stream" and kills position recording for the whole track.
    h.info({ currentTime: 120 });
    expect(h.recorded.at(-1)?.seconds).toBe(120);
  });

  it("blocks the straggler seconds the fade still plays, then settles on the halt", () => {
    bootPlaying(h, PLAN, URL_A);
    h.info({ duration: 600, videoData: { video_id: "abcdefghijk" } });
    h.controller.pressStop();
    h.recorded = [];
    h.info({ currentTime: 300 }); // audio is still running through the fade
    expect(h.recorded).toEqual([]);
    h.clock.advance(MUSIC_FADE_OUT_MS);
    expect(h.cleared).toEqual([URL_A]);
    // Settled on the reported halt, or position recording stays dead through a
    // later media-key resume, which never passes through ▶️.
    h.state(YT_STATE.PAUSED);
    h.state(YT_STATE.PLAYING);
    h.info({ duration: 600, currentTime: 90 });
    expect(h.recorded.at(-1)?.seconds).toBe(90);
  });
});

describe("ducking", () => {
  it("dips under a cue and eases back to the user volume", () => {
    bootPlaying(h);
    h.reset();
    h.controller.duck(1);
    h.clock.advance(MUSIC_DUCK_DOWN_MS);
    expect(h.lastVolume()).toBe(Math.round(MUSIC_DUCK_FACTOR * 100));
    h.clock.advance(2000);
    expect(h.lastVolume()).toBe(100);
  });

  it("takes a fade-in over rather than letting the cue play under a rising track (trap 4)", () => {
    boot(h);
    h.controller.pressPlay();
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_IN_MS / 4);
    h.reset();
    h.controller.duck(0.5);
    h.clock.advance(MUSIC_DUCK_DOWN_MS);
    expect(h.lastVolume()).toBe(Math.round(MUSIC_DUCK_FACTOR * 100));
    h.clock.advance(3000);
    expect(h.lastVolume()).toBe(100); // the restore ramp finishes the rise
  });

  it("stands down during a fade-out — the player is about to pause anyway", () => {
    bootPlaying(h);
    h.controller.pressPause();
    h.reset();
    h.controller.duck(1);
    h.clock.advance(MUSIC_DUCK_DOWN_MS);
    // Only the fade-out's own descending posts; no dip target.
    expect(h.volumes().every((v) => v <= 100)).toBe(true);
    h.clock.advance(MUSIC_FADE_OUT_MS);
    expect(h.funcs()).toContain("pauseVideo");
  });

  it("is a no-op when nothing is playing", () => {
    boot(h);
    h.reset();
    h.controller.duck(1);
    h.clock.advance(MUSIC_DUCK_DOWN_MS * 4);
    expect(h.volumes()).toEqual([]);
  });
});

describe("volume", () => {
  it("re-aims a running fade-in immediately rather than climbing to the old target (trap 6)", () => {
    boot(h);
    h.controller.pressPlay();
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_IN_MS / 2);
    h.volume = 0.4;
    h.controller.applyVolume();
    h.clock.advance(MUSIC_FADE_IN_MS * 2);
    expect(h.lastVolume()).toBe(40);
  });

  it("does not rebuild the ramp on every convergence tick while a fade runs", () => {
    boot(h);
    h.controller.pressPlay();
    h.state(YT_STATE.PLAYING);
    h.volume = 0.4;
    h.controller.applyVolume();
    h.reset();
    // The ~20Hz reconcile: a stale stamp here restarts the ramp faster than a
    // single step can fire, and the fade never lands.
    for (let i = 0; i < 40; i++) {
      h.controller.syncVolume();
      h.clock.advance(25);
    }
    expect(h.lastVolume()).toBe(40);
  });

  it("an explicit set wins over an in-flight duck", () => {
    bootPlaying(h);
    h.controller.duck(5);
    h.clock.advance(MUSIC_DUCK_DOWN_MS);
    h.volume = 0.5;
    h.controller.applyVolume();
    h.clock.advance(3000);
    expect(h.lastVolume()).toBe(50);
  });

  it("syncVolume is a no-op once applied", () => {
    bootPlaying(h);
    h.reset();
    h.controller.syncVolume();
    h.controller.syncVolume();
    expect(h.volumes()).toEqual([]);
  });
});

describe("orphaned park (trap 7)", () => {
  it("fades up when a media key resumes a player parked at silence by a landed ⏸", () => {
    bootPlaying(h);
    h.controller.pressPause();
    h.clock.advance(MUSIC_FADE_OUT_MS);
    h.state(YT_STATE.PAUSED);
    h.reset();
    // Hardware media keys drive the embed directly — no ▶️ involved. Silent
    // playback with ⏸ showing would be the regression.
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_IN_MS);
    expect(h.lastVolume()).toBe(100);
    expect(h.transport.at(-1)).toBe(true);
  });

  it("re-arms instead of fading when the resume edge is BUFFERING", () => {
    bootPlaying(h);
    h.controller.pressPause();
    h.clock.advance(MUSIC_FADE_OUT_MS);
    h.state(YT_STATE.PAUSED);
    h.reset();
    h.state(YT_STATE.BUFFERING);
    expect(h.volumes()).toEqual([]); // not spent on the silence
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_IN_MS);
    expect(h.lastVolume()).toBe(100);
  });

  it("is not triggered by stragglers that race the just-posted pause", () => {
    bootPlaying(h);
    h.controller.pressPause();
    h.clock.advance(MUSIC_FADE_OUT_MS);
    h.reset();
    // The embed keeps reporting for a beat after pauseVideo. These arrive from
    // a still-audible previous state, so they are stragglers, not a resume —
    // requiring the previous state to be halted is what tells them apart, and
    // fading up here would answer ⏸ with sound.
    h.state(YT_STATE.BUFFERING);
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_FADE_ARM_TIMEOUT_MS + MUSIC_FADE_IN_MS * 2);
    expect(h.volumes()).toEqual([]);
  });
});

describe("playlist transport", () => {
  it("rides the fade rather than cutting the track dead", () => {
    bootPlaying(h, LIST_PLAN);
    h.reset();
    h.controller.stepPlaylist("nextVideo");
    expect(h.funcs()).not.toContain("nextVideo");
    // A skip is not a pause: flashing ▶️ for a fade-length reads as a stumble.
    expect(h.transport).toEqual([]);
    h.clock.advance(MUSIC_FADE_OUT_MS);
    expect(h.funcs()).toContain("nextVideo");
    h.clock.advance(MUSIC_FADE_IN_MS);
    expect(h.lastVolume()).toBe(100);
  });

  it("a ⏸ landing inside the skip's fade cancels the advance and wins", () => {
    bootPlaying(h, LIST_PLAN);
    h.controller.stepPlaylist("nextVideo");
    h.clock.advance(MUSIC_FADE_OUT_MS / 3);
    h.reset();
    h.controller.pressPause();
    h.clock.advance(MUSIC_FADE_OUT_MS + MUSIC_FADE_IN_MS);
    expect(h.funcs()).not.toContain("nextVideo");
    expect(h.funcs()).toContain("pauseVideo");
  });

  it("hands an in-flight duck its dip back across the skip (fade trap 4, skip path)", () => {
    bootPlaying(h, LIST_PLAN);
    h.controller.duck(4); // a long cue
    h.clock.advance(MUSIC_DUCK_DOWN_MS);
    h.controller.stepPlaylist("nextVideo");
    h.clock.advance(MUSIC_FADE_OUT_MS);
    h.reset();
    // The skip cleared duckRestoreTimeout — the only thing holding the dip.
    // Without the re-offer the music swells to full under a ringing cue.
    h.clock.advance(MUSIC_FADE_IN_MS);
    expect(h.lastVolume()).toBeLessThan(100);
    h.clock.advance(4000);
    expect(h.lastVolume()).toBe(100);
  });

  it("clears a pending resume seek on the landing, not on the click", () => {
    boot(h, { target: LIST_PLAN.target, seekSeconds: 120 });
    h.controller.pressPlay();
    h.controller.stepPlaylist("nextVideo");
    // Cancelled before the landing: the outgoing item's bookkeeping is untouched.
    h.controller.pressPause();
    h.clock.advance(MUSIC_FADE_OUT_MS);
    h.reset();
    h.state(YT_STATE.PLAYING);
    expect(h.funcs()).toContain("seekTo");
  });

  it("keeps the duration across an advance that turns out to be a no-op", () => {
    // duration rides only the fuller state-change payloads, and a no-op advance
    // (last item, no loop) produces no state change at all — so a nulled
    // duration would never be restored, and isResumablePosition reads null as
    // "live stream" and stops recording for the rest of the track.
    bootPlaying(h, LIST_PLAN);
    h.info({ duration: 600, videoData: { video_id: "abcdefghijk" } });
    h.controller.stepPlaylist("nextVideo");
    h.clock.advance(MUSIC_FADE_OUT_MS + MUSIC_FADE_IN_MS);
    h.recorded = [];
    h.info({ currentTime: 200 });
    expect(h.recorded.at(-1)?.seconds).toBe(200);
  });

  it("refuses when nothing is playing, with an explanation rather than silence", () => {
    boot(h, LIST_PLAN);
    h.reset();
    h.controller.stepPlaylist("nextVideo");
    expect(h.funcs()).toEqual([]);
    expect(h.notices[0]).toContain("press ▶️ first");
  });
});

describe("⏭ station hand-off", () => {
  it("does not hand over when no rebuild happened", () => {
    bootPlaying(h);
    const snap = h.controller.snapshotHandOff();
    // Two slots holding identical URLs: the embed key never moves, nothing is
    // torn down and the music never stopped — handing over there would drop it
    // to silence and swell it back for no reason.
    h.controller.armHandOff(snap);
    expect(h.controller.handOffPending).toBe(false);
  });

  it("does not hand over when the switch tore the player down and built nothing", () => {
    bootPlaying(h);
    const snap = h.controller.snapshotHandOff();
    h.controller.destroy(); // e.g. the new slot's URL does not parse
    h.controller.armHandOff(snap);
    expect(h.controller.handOffPending).toBe(false);
  });

  it("carries playback across a real switch", () => {
    bootPlaying(h);
    const snap = h.controller.snapshotHandOff();
    h.controller.destroy();
    h.controller.build("https://embed2", PLAN, URL_B);
    h.controller.armHandOff(snap);
    expect(h.controller.handOffPending).toBe(true);
    h.fireLoad();
    h.clock.advance(MUSIC_LISTENING_DELAY_MS);
    h.reset();
    h.ready();
    expect(h.funcs()).toContain("playVideo");
  });

  it("a ⏸ landing inside the settings write cancels the hand-off", () => {
    bootPlaying(h);
    const snap = h.controller.snapshotHandOff();
    h.controller.pressPause(); // lands while saveSettings is still out
    h.controller.destroy();
    h.controller.build("https://embed2", PLAN, URL_B);
    h.controller.armHandOff(snap);
    expect(h.controller.handOffPending).toBe(false);
  });

  it("a ⏸/⏹ during the load gap clears an already-armed hand-off", () => {
    bootPlaying(h);
    const snap = h.controller.snapshotHandOff();
    h.controller.destroy();
    h.controller.build("https://embed2", PLAN, URL_B);
    h.controller.armHandOff(snap);
    // The player is not ready, so fadeOut's early return destroys nothing —
    // clearing the flag has to happen there, or Stop is answered with sound.
    h.controller.pressStop();
    h.fireLoad();
    h.clock.advance(MUSIC_LISTENING_DELAY_MS);
    h.reset();
    h.ready();
    expect(h.funcs()).not.toContain("playVideo");
  });

  it("refuses a hand-off addressed to a station the rebuilt frame is not on", () => {
    bootPlaying(h);
    const snap = h.controller.snapshotHandOff();
    h.controller.destroy();
    h.controller.build("https://embed2", PLAN, URL_B);
    h.controller.armHandOff(snap); // stamped URL_B
    h.controller.destroy();
    h.controller.build("https://embed3", PLAN, URL_A); // a third switch
    h.fireLoad();
    h.clock.advance(MUSIC_LISTENING_DELAY_MS);
    h.reset();
    h.ready();
    expect(h.funcs()).not.toContain("playVideo");
  });

  it("reports playing for the user only while the transport says so", () => {
    bootPlaying(h);
    expect(h.controller.isPlayingForUser()).toBe(true);
    h.controller.pressPause();
    // A landed ⏸ nulls the fade phase while playerState is still PLAYING; a
    // predicate re-derived from the phase would answer a pause with sound.
    h.clock.advance(MUSIC_FADE_OUT_MS);
    expect(h.controller.isPlayingForUser()).toBe(false);
  });

  it("still reports playing during a ⏩ skip's fade", () => {
    bootPlaying(h, LIST_PLAN);
    h.controller.stepPlaylist("nextVideo");
    // "out" now covers a skip too — reading it as stopped made ⏭ inside a skip
    // hand over nothing, and the new station loaded silent.
    expect(h.controller.isPlayingForUser()).toBe(true);
  });
});

describe("teardown", () => {
  it("leaves the play button showing after a teardown while playing", () => {
    // The 0.5.7 round-1 regression, locked: resetting playerState separately
    // above the closing updateButtons call puts the ▶️/⏸ swap behind its own
    // early return, and the panel keeps ⏸ with no play button — killing the
    // release's headline gesture and never recovering within the session.
    bootPlaying(h);
    h.reset();
    h.controller.destroy();
    expect(h.transport.at(-1)).toBe(false);
    // The caption reads showingAsPlaying from inside this very callback, so the
    // field must already be assigned when the host is told.
    expect(h.transportSelfReport).toEqual(h.transport);
  });

  it("banks the outgoing position, unless a ⏹ is pending", () => {
    bootPlaying(h);
    h.controller.destroy();
    expect(h.flushes).toBeGreaterThan(0);
    expect(h.cleared).toEqual([]);

    const g = new Harness();
    bootPlaying(g);
    g.controller.pressStop();
    g.controller.destroy(); // the fade never landed
    expect(g.cleared).toEqual([URL_A]);
    expect(g.flushes).toBe(0);
  });

  it("drops the track name and re-renders before the caption can name the wrong item", () => {
    bootPlaying(h, LIST_PLAN);
    h.info({ videoData: { video_id: "abcdefghijk", title: "Track one" } });
    expect(h.controller.videoTitle).toBe("Track one");
    h.controller.destroy();
    expect(h.controller.videoTitle).toBeNull();
    expect(h.controller.playlistId).toBeNull();
  });

  it("forgets the learned origin, which belonged to the frame that taught it", () => {
    boot(h);
    h.state(YT_STATE.PAUSED, BOUNCED_ORIGIN);
    h.controller.destroy();
    boot(h, PLAN, URL_B);
    h.reset();
    h.controller.pressPlay();
    expect(h.posts.every((p) => p.origin === YT_EMBED_ORIGIN)).toBe(true);
  });
});

describe("resume position", () => {
  it("posts the seek on the first audible state, never in the embed URL", () => {
    boot(h, { target: PLAN.target, seekSeconds: 90 });
    h.reset();
    h.controller.pressPlay();
    h.state(YT_STATE.BUFFERING); // usually first, so the jump lands before audio
    const seek = h.posts.find((p) => p.func === "seekTo");
    expect(seek?.args).toEqual([90, true]);
  });

  it("never seeks from a cued player — that would start playback nobody asked for", () => {
    boot(h, { target: PLAN.target, seekSeconds: 90 });
    h.reset();
    // No ▶️ press. Restore must never auto-play: Obsidian starting up must not
    // burst into music, and seekTo from a *cued* player begins playback.
    h.state(YT_STATE.CUED);
    h.state(YT_STATE.UNSTARTED);
    expect(h.funcs()).not.toContain("seekTo");
    expect(h.funcs()).not.toContain("playVideo");
  });

  it("consumes but does not post an offset for a live stream", () => {
    boot(h, { target: PLAN.target, seekSeconds: 90 });
    h.info({ duration: 0 }); // how the embed reports a live stream
    h.reset();
    h.controller.pressPlay();
    h.state(YT_STATE.PLAYING);
    expect(h.funcs()).not.toContain("seekTo");
    h.state(YT_STATE.BUFFERING);
    h.state(YT_STATE.PLAYING);
    expect(h.funcs()).not.toContain("seekTo"); // consumed: never fires later either
  });

  it("ignores clock readings below the landing, so the pre-seek 0 cannot overwrite it", () => {
    boot(h, { target: PLAN.target, seekSeconds: 300 });
    h.controller.pressPlay();
    h.state(YT_STATE.PLAYING);
    h.info({ duration: 600, currentTime: 0.4 }); // the old clock, still streaming
    expect(h.recorded).toEqual([]);
    h.info({ duration: 600, currentTime: 301 });
    expect(h.recorded.at(-1)?.seconds).toBe(301);
  });

  it("stamps every position with the URL the frame was built for, not the live setting", () => {
    // 0.5.6's whole point: both settings paths assign then await, and the
    // outgoing frame keeps streaming across that await.
    bootPlaying(h, PLAN, URL_A);
    h.info({ duration: 600, currentTime: 120 });
    expect(h.recorded.at(-1)?.url).toBe(URL_A);
    h.controller.destroy();
    bootPlaying(h, PLAN, URL_B);
    h.info({ duration: 600, currentTime: 45 });
    expect(h.recorded.at(-1)?.url).toBe(URL_B);
  });

  it("records nothing from a cued or paused player", () => {
    boot(h);
    h.info({ duration: 600, currentTime: 200 });
    expect(h.recorded).toEqual([]);
  });

  it("scopes a pending ⏹ to the station it was pressed on", () => {
    bootPlaying(h, PLAN, URL_A);
    h.controller.pressStop();
    expect(h.controller.stopSuppressesResumeFor(URL_A)).toBe(true);
    // A switch inside the fade window must not plan the INCOMING station
    // against an empty store — that opened it from the top and then overwrote
    // the position it should have resumed.
    expect(h.controller.stopSuppressesResumeFor(URL_B)).toBe(false);
  });

  it("clears the position on ENDED, scoped to the frame's own station", () => {
    bootPlaying(h, PLAN, URL_A);
    h.state(YT_STATE.ENDED);
    expect(h.cleared).toEqual([URL_A]);
  });

  it("flushes on PAUSED — the boundary that has to reach disk", () => {
    bootPlaying(h);
    const before = h.flushes;
    h.state(YT_STATE.PAUSED);
    expect(h.flushes).toBe(before + 1);
  });
});

describe("notices", () => {
  it("reports a lasting stall, once per episode", () => {
    bootPlaying(h);
    h.state(YT_STATE.BUFFERING);
    h.clock.advance(MUSIC_STALL_NOTICE_DELAY_MS + 10);
    expect(h.notices.filter((n) => n.includes("buffering"))).toHaveLength(1);
    // The ~4Hz info stream repeats the state; those repeats must not re-arm it
    // within the same episode. Stepped past MUSIC_STALL_RENOTIFY_MS as well, or
    // the rate limit alone would hide a re-arm.
    for (let i = 0; i < 20; i++) {
      h.info({ playerState: YT_STATE.BUFFERING });
      h.clock.advance(MUSIC_STALL_RENOTIFY_MS / 4);
    }
    h.clock.advance(MUSIC_STALL_RENOTIFY_MS * 2);
    expect(h.notices.filter((n) => n.includes("buffering"))).toHaveLength(1);
  });

  it("does not fire for a brief rebuffer", () => {
    bootPlaying(h);
    h.state(YT_STATE.BUFFERING);
    h.clock.advance(MUSIC_STALL_NOTICE_DELAY_MS / 2);
    h.state(YT_STATE.PLAYING);
    h.clock.advance(MUSIC_STALL_NOTICE_DELAY_MS * 2);
    expect(h.notices).toEqual([]);
  });

  it("reports a lasting ENDED but not a playlist advance passing through it", () => {
    bootPlaying(h);
    h.state(YT_STATE.ENDED);
    h.clock.advance(MUSIC_ENDED_NOTICE_DELAY_MS / 2);
    h.state(YT_STATE.PLAYING); // auto-advance resumed within a second
    h.clock.advance(MUSIC_ENDED_NOTICE_DELAY_MS * 2);
    expect(h.notices).toEqual([]);

    h.state(YT_STATE.ENDED);
    h.clock.advance(MUSIC_ENDED_NOTICE_DELAY_MS + 10);
    expect(h.notices.filter((n) => n.includes("music ended"))).toHaveLength(1);
  });

  it("stays quiet when a track ends inside a ⏸ fade-out", () => {
    // "The music ended — paste a new link" is the wrong answer to a button the
    // user just pressed for silence.
    bootPlaying(h);
    h.controller.pressPause();
    h.state(YT_STATE.ENDED);
    h.clock.advance(MUSIC_ENDED_NOTICE_DELAY_MS * 2);
    expect(h.notices).toEqual([]);
  });

  it("stays quiet when a manual ⏩ runs off the end of a playlist", () => {
    bootPlaying(h, LIST_PLAN);
    h.controller.stepPlaylist("nextVideo");
    h.clock.advance(MUSIC_FADE_OUT_MS);
    h.state(YT_STATE.ENDED);
    h.clock.advance(MUSIC_ENDED_NOTICE_DELAY_MS + 10);
    expect(h.notices).toEqual([]);
  });

  it("resumes reporting the end once the ⏩ grace window has passed", () => {
    bootPlaying(h, LIST_PLAN);
    h.controller.stepPlaylist("nextVideo");
    h.clock.advance(MUSIC_FADE_OUT_MS + MUSIC_ADVANCE_NOTICE_GRACE_MS + 10);
    h.state(YT_STATE.PLAYING);
    h.state(YT_STATE.ENDED);
    h.clock.advance(MUSIC_ENDED_NOTICE_DELAY_MS + 10);
    expect(h.notices.filter((n) => n.includes("music ended"))).toHaveLength(1);
  });

  it("reports an embed error once per build, and names iOS as a platform limit", () => {
    h.ios = true;
    boot(h);
    h.send({ event: "onError", info: 153 });
    h.send({ event: "onError", info: 153 });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("iPhone");
    // No message may claim a different link would help — it would not.
    expect(h.notices[0]).not.toContain("another link");
  });
});
