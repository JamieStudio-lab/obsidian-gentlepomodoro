import { describe, it, expect, beforeEach } from "vitest";
import { MusicStationStore } from "../musicStationStore";
import { DEFAULT_SETTINGS } from "../constants";
import type { GentlePomoSettings } from "../types";
import { MUSIC_STATION_LIMIT, type MusicResumeState } from "../youtubeMusic";

const A = "https://youtu.be/aaaaaaaaaaa";
const B = "https://youtu.be/bbbbbbbbbbb";
const C = "https://www.youtube.com/watch?v=ccccccccccc";

function position(url: string, seconds = 100, videoId = "aaaaaaaaaaa"): MusicResumeState {
  return { videoId, playlistId: null, seconds, url };
}

function make(overrides: Partial<GentlePomoSettings> = {}) {
  const settings: GentlePomoSettings = {
    ...DEFAULT_SETTINGS,
    musicPositions: [],
    ...overrides,
  };
  let saves = 0;
  const store = new MusicStationStore({
    settings: () => settings,
    save: () => {
      saves++;
    },
  });
  return { store, settings, saves: () => saves };
}

let ctx: ReturnType<typeof make>;
beforeEach(() => {
  ctx = make({ musicUrl: A, musicUrl2: B, musicUrl3: "" });
});

describe("slots", () => {
  it("reads the three slots in order", () => {
    expect(ctx.store.stationUrls()).toEqual([A, B, ""]);
  });

  it("plays the selected slot", () => {
    ctx.settings.musicStationIndex = 1;
    expect(ctx.store.activeUrl()).toBe(B);
  });

  it("falls back to the first filled slot when the stored index points at an empty one", () => {
    ctx.settings.musicStationIndex = 2;
    expect(ctx.store.activeUrl()).toBe(A);
  });

  it("returns empty when every slot is empty", () => {
    const empty = make({ musicUrl: "", musicUrl2: "", musicUrl3: "" });
    expect(empty.store.activeUrl()).toBe("");
  });
});

describe("reconcile", () => {
  it("heals a stored index that points at an empty slot", () => {
    // Without this the stored index can name an empty slot while playback runs
    // on the fallback — and then filling that slot silently moves playback onto
    // it, because the fallback stops applying.
    ctx.settings.musicStationIndex = 2;
    ctx.store.reconcile();
    expect(ctx.settings.musicStationIndex).toBe(0);
    expect(ctx.saves()).toBe(1);
  });

  it("costs nothing when there is nothing to heal", () => {
    ctx.store.reconcile();
    ctx.store.reconcile();
    expect(ctx.saves()).toBe(0);
  });

  it("retires a position no slot holds any more", () => {
    ctx.settings.musicPositions = [position(A), position(C)];
    ctx.store.reconcile();
    expect(ctx.settings.musicPositions.map((p) => p.url)).toEqual([A]);
    expect(ctx.saves()).toBe(1);
  });

  it("keeps every position while some slot still holds its link", () => {
    ctx.settings.musicPositions = [position(A), position(B)];
    ctx.store.reconcile();
    expect(ctx.settings.musicPositions).toHaveLength(2);
    expect(ctx.saves()).toBe(0);
  });

  it("treats a station switch as no event at all", () => {
    // A→B→A must resume A. Every slot's URL is still there, so nothing retires
    // — which is the whole point of a picker.
    ctx.settings.musicPositions = [position(A), position(B)];
    ctx.settings.musicStationIndex = 1;
    ctx.store.reconcile();
    ctx.settings.musicStationIndex = 0;
    ctx.store.reconcile();
    expect(ctx.store.resumeState(A)?.seconds).toBe(100);
    expect(ctx.store.resumeState(B)?.seconds).toBe(100);
  });

  it("retires the orphan when a slot is edited, and when one is cleared", () => {
    ctx.settings.musicPositions = [position(A), position(B)];
    ctx.settings.musicUrl = C; // edited
    ctx.settings.musicUrl2 = ""; // cleared
    ctx.store.reconcile();
    expect(ctx.settings.musicPositions).toEqual([]);
  });

  it("refuses to sweep while a slot holds a half-typed URL", () => {
    // Both settings paths commit on every keystroke, and this erase is
    // immediate and destructive — so a URL arriving one character at a time
    // must not cost the position on the way through.
    ctx.settings.musicPositions = [position(A), position(B)];
    ctx.settings.musicUrl2 = "https://you";
    ctx.store.reconcile();
    expect(ctx.settings.musicPositions).toHaveLength(2);
    // ...and resumes sweeping once the typing settles.
    ctx.settings.musicUrl2 = C;
    ctx.store.reconcile();
    expect(ctx.settings.musicPositions.map((p) => p.url)).toEqual([A]);
  });

  it("saves once for a heal and a retire together", () => {
    ctx.settings.musicStationIndex = 2;
    ctx.settings.musicPositions = [position(C)];
    ctx.store.reconcile();
    expect(ctx.saves()).toBe(1);
  });
});

describe("record", () => {
  it("stores a position under the URL it was stamped with", () => {
    ctx.store.record(position(A, 42));
    expect(ctx.settings.musicPositions).toEqual([
      { videoId: "aaaaaaaaaaa", playlistId: null, seconds: 42, url: A },
    ]);
  });

  it("keeps whole seconds, so the ~4Hz stream collapses to about one a second", () => {
    ctx.store.record(position(A, 42.1));
    ctx.store.record(position(A, 42.4));
    ctx.store.record(position(A, 42.9));
    expect(ctx.settings.musicPositions[0]?.seconds).toBe(42);
    ctx.store.flush();
    expect(ctx.saves()).toBe(1);
  });

  it("does not mark anything dirty when the whole second has not moved", () => {
    ctx.store.record(position(A, 42));
    ctx.store.flush();
    ctx.store.record(position(A, 42.5));
    ctx.store.flush();
    expect(ctx.saves()).toBe(1); // the second flush had nothing to write
  });

  it("re-stamps an entry whose URL changed, rather than trusting the old stamp", () => {
    ctx.store.record(position(A, 42));
    ctx.store.record({ ...position(A, 42), videoId: "zzzzzzzzzzz" });
    expect(ctx.settings.musicPositions[0]?.videoId).toBe("zzzzzzzzzzz");
  });

  it("rewrites a stale URL stamp instead of leaving it", () => {
    // findPositionForUrl is trim-tolerant (data.json is hand-editable), so a
    // whitespace-padded stamp still matches. Without the URL in the dedupe
    // check the entry compares equal on every other field and the stale stamp
    // is never corrected.
    ctx.settings.musicPositions = [position(` ${A} `, 42)];
    ctx.store.record(position(A, 42));
    expect(ctx.settings.musicPositions[0]?.url).toBe(A);
  });

  it("refuses a position with no provenance", () => {
    // Provenance travels with the position, from the frame that produced it.
    // Nothing to attribute it to means nothing to store.
    ctx.store.record({ ...position(A), url: null });
    ctx.store.record({ ...position(A), url: "   " });
    expect(ctx.settings.musicPositions).toEqual([]);
  });

  it("records nothing while the resume feature is off", () => {
    const off = make({ musicUrl: A, musicResume: false });
    off.store.record(position(A, 42));
    expect(off.settings.musicPositions).toEqual([]);
  });

  it("keeps one entry per URL", () => {
    ctx.store.record(position(A, 10));
    ctx.store.record(position(B, 20));
    ctx.store.record(position(A, 30));
    expect(ctx.settings.musicPositions).toHaveLength(2);
    expect(ctx.store.resumeState(A)?.seconds).toBe(30);
  });

  it("evicts an orphan, never a station still in use, when the list is full", () => {
    // Reachable whenever the retire sweep is frozen: one unparseable slot holds
    // it false indefinitely and orphans pile up. Dropping index 0 would take
    // the user's main station, which is typically the oldest entry.
    const full = make({ musicUrl: A, musicUrl2: B, musicUrl3: "" });
    full.settings.musicPositions = [
      position(A),
      position("https://youtu.be/oldoldoldo"),
      position(B),
    ];
    expect(full.settings.musicPositions).toHaveLength(MUSIC_STATION_LIMIT);
    full.store.record(position(C, 5));
    expect(full.settings.musicPositions.map((p) => p.url)).toEqual([A, B, C]);
  });

  it("falls back to the oldest only when every entry is still live", () => {
    const full = make({ musicUrl: A, musicUrl2: B, musicUrl3: C });
    full.settings.musicPositions = [position(A), position(B), position(C)];
    full.store.record(position("https://youtu.be/ddddddddddd", 5));
    expect(full.settings.musicPositions.map((p) => p.url)).toEqual([
      B,
      C,
      "https://youtu.be/ddddddddddd",
    ]);
  });
});

describe("resumeState", () => {
  it("answers nothing while the feature is off, without forgetting anything", () => {
    ctx.settings.musicPositions = [position(A, 90)];
    ctx.settings.musicResume = false;
    expect(ctx.store.resumeState(A)).toBeNull();
    ctx.settings.musicResume = true;
    expect(ctx.store.resumeState(A)?.seconds).toBe(90);
  });

  it("is trim-tolerant, because data.json is hand-editable", () => {
    ctx.settings.musicPositions = [position(` ${A} `, 90)];
    expect(ctx.store.resumeState(A)?.seconds).toBe(90);
  });

  it("never hands one station's position to another", () => {
    ctx.settings.musicPositions = [position(A, 90)];
    expect(ctx.store.resumeState(B)).toBeNull();
  });
});

describe("clear and flush", () => {
  it("forgets one station at once, leaving the others", () => {
    ctx.settings.musicPositions = [position(A), position(B)];
    ctx.store.clear(A);
    expect(ctx.settings.musicPositions.map((p) => p.url)).toEqual([B]);
    expect(ctx.saves()).toBe(1);
  });

  it("drops a pending position even when there was nothing stored to remove", () => {
    // ⏹ during the first seconds of a track: nothing is banked yet, but the
    // sample in flight must not land after the stop.
    ctx.store.record(position(A, 30));
    ctx.settings.musicPositions = [];
    ctx.store.clear(A);
    ctx.store.flush();
    expect(ctx.saves()).toBe(0);
  });

  it("clear(null) forgets nothing but still drops the pending write", () => {
    ctx.settings.musicPositions = [position(A)];
    ctx.store.record(position(A, 55));
    ctx.store.clear(null);
    ctx.store.flush();
    expect(ctx.settings.musicPositions).toHaveLength(1);
    expect(ctx.saves()).toBe(0);
  });

  it("clearAll empties the list once and then costs nothing", () => {
    ctx.settings.musicPositions = [position(A), position(B)];
    ctx.store.clearAll();
    expect(ctx.settings.musicPositions).toEqual([]);
    ctx.store.clearAll();
    expect(ctx.saves()).toBe(1);
  });

  it("flush writes only when a position has actually moved", () => {
    ctx.store.flush();
    expect(ctx.saves()).toBe(0);
    ctx.store.record(position(A, 12));
    ctx.store.flush();
    ctx.store.flush();
    expect(ctx.saves()).toBe(1);
  });

  it("a retire sweep drops the pending write it just invalidated", () => {
    ctx.store.record(position(A, 12));
    ctx.settings.musicUrl = C; // the link the pending position belongs to is gone
    ctx.store.reconcile();
    const after = ctx.saves();
    ctx.store.flush();
    expect(ctx.saves()).toBe(after);
  });
});
