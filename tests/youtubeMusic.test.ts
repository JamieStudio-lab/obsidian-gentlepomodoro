import { describe, it, expect } from "vitest";
import {
  YT_EMBED_ORIGIN,
  YT_ALLOWED_MESSAGE_ORIGINS,
  YT_STATE,
  parseYouTubeUrl,
  parseStartTime,
  validateMusicUrl,
  buildEmbedUrl,
  buildPlayerCommand,
  buildListeningMessage,
  parsePlayerMessage,
  musicVolumeTo100,
  buildVolumeRamp,
  buildFadeRamp,
  isResumablePosition,
  planResume,
  musicPositionAppliesToUrl,
  MUSIC_RESUME_MIN_SECONDS,
  MUSIC_RESUME_END_MARGIN_SECONDS,
  type MusicTarget,
  type MusicResumeState,
} from "../youtubeMusic";

// Lofi Girl's stream ID — a real-shaped 11-char ID for readable tests.
const ID = "jfKfPfyJRdk";
// A second real-shaped ID, for "the playlist moved on" / "the URL changed" cases.
const OTHER_ID = "5qap5aO4i9A";
// Two settings values, for "the user edited the music URL" cases. What matters
// is that the strings differ, not what they resolve to.
const URL_A = `https://www.youtube.com/watch?v=${ID}`;
const URL_B = `https://www.youtube.com/watch?v=${ID}&t=90`;

describe("parseYouTubeUrl", () => {
  it("parses a standard watch URL", () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}`)).toEqual({
      videoId: ID,
      playlistId: null,
      startSeconds: null,
    });
  });

  it("accepts bare, m., and music. hosts", () => {
    for (const host of ["youtube.com", "m.youtube.com", "music.youtube.com"]) {
      expect(parseYouTubeUrl(`https://${host}/watch?v=${ID}`)?.videoId).toBe(ID);
    }
  });

  it("ignores unrelated query params", () => {
    const url = `https://www.youtube.com/watch?v=${ID}&si=AbC&feature=share&pp=xyz`;
    expect(parseYouTubeUrl(url)?.videoId).toBe(ID);
  });

  it("parses youtu.be short links, with and without a timestamp", () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}`)).toEqual({
      videoId: ID,
      playlistId: null,
      startSeconds: null,
    });
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=90`)?.startSeconds).toBe(90);
  });

  it("parses /live/ URLs (live streams)", () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/live/${ID}`)?.videoId).toBe(ID);
  });

  it("parses /shorts/, /embed/, and legacy /v/ URLs", () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/shorts/${ID}`)?.videoId).toBe(ID);
    expect(parseYouTubeUrl(`https://www.youtube.com/embed/${ID}`)?.videoId).toBe(ID);
    expect(parseYouTubeUrl(`https://www.youtube.com/v/${ID}`)?.videoId).toBe(ID);
  });

  it("parses nocookie embed URLs", () => {
    expect(parseYouTubeUrl(`https://www.youtube-nocookie.com/embed/${ID}`)?.videoId).toBe(ID);
  });

  it("parses playlist-only URLs (no video ID)", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/playlist?list=PLabc123XYZ")).toEqual({
      videoId: null,
      playlistId: "PLabc123XYZ",
      startSeconds: null,
    });
  });

  it("parses a videoseries embed as a playlist target", () => {
    const target = parseYouTubeUrl(
      "https://www.youtube-nocookie.com/embed/videoseries?list=PLabc123XYZ"
    );
    expect(target).toEqual({ videoId: null, playlistId: "PLabc123XYZ", startSeconds: null });
  });

  it("captures list= alongside v= on watch URLs", () => {
    const target = parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PLabc123XYZ`);
    expect(target).toEqual({ videoId: ID, playlistId: "PLabc123XYZ", startSeconds: null });
  });

  it("tolerates scheme-less input", () => {
    expect(parseYouTubeUrl(`youtube.com/watch?v=${ID}`)?.videoId).toBe(ID);
    expect(parseYouTubeUrl(`youtu.be/${ID}`)?.videoId).toBe(ID);
  });

  it("rejects empty and whitespace input", () => {
    expect(parseYouTubeUrl("")).toBeNull();
    expect(parseYouTubeUrl("   ")).toBeNull();
  });

  it("rejects a bare video ID (not a URL)", () => {
    expect(parseYouTubeUrl(ID)).toBeNull();
  });

  it("rejects non-YouTube hosts", () => {
    expect(parseYouTubeUrl(`https://example.com/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeUrl("https://vimeo.com/12345678")).toBeNull();
    // Suffix spoofing must not pass the host allowlist.
    expect(parseYouTubeUrl(`https://notyoutube.com/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeUrl(`https://youtube.com.evil.example/watch?v=${ID}`)).toBeNull();
  });

  it("rejects channel-style live links (no resolvable ID)", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/@LofiGirl/live")).toBeNull();
    expect(
      parseYouTubeUrl("https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/live")
    ).toBeNull();
    expect(parseYouTubeUrl("https://www.youtube.com/c/LofiGirl/live")).toBeNull();
    expect(parseYouTubeUrl("https://www.youtube.com/user/LofiGirl/live")).toBeNull();
  });

  it("rejects malformed video IDs", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=shortID")).toBeNull(); // 7 chars
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=twelve_chars")).toBeNull(); // 12 chars
    expect(parseYouTubeUrl("https://www.youtube.com/watch")).toBeNull(); // no v=
  });

  it("rejects non-http(s) schemes", () => {
    expect(parseYouTubeUrl(`javascript://www.youtube.com/watch?v=${ID}`)).toBeNull();
  });
});

describe("parseStartTime", () => {
  it("parses plain seconds", () => {
    expect(parseStartTime("90")).toBe(90);
    expect(parseStartTime("0")).toBe(0);
  });

  it("parses suffixed forms", () => {
    expect(parseStartTime("90s")).toBe(90);
    expect(parseStartTime("2m")).toBe(120);
    expect(parseStartTime("1h2m3s")).toBe(3723);
    expect(parseStartTime("1h")).toBe(3600);
  });

  it("returns null for garbage", () => {
    expect(parseStartTime("")).toBeNull();
    expect(parseStartTime("abc")).toBeNull();
    expect(parseStartTime("1x2y")).toBeNull();
  });
});

describe("validateMusicUrl", () => {
  it("accepts empty input (feature unset)", () => {
    expect(validateMusicUrl("")).toBeUndefined();
    expect(validateMusicUrl("   ")).toBeUndefined();
  });

  it("accepts valid watch, live, and playlist URLs", () => {
    expect(validateMusicUrl(`https://www.youtube.com/watch?v=${ID}`)).toBeUndefined();
    expect(validateMusicUrl(`https://www.youtube.com/live/${ID}`)).toBeUndefined();
    expect(validateMusicUrl("https://www.youtube.com/playlist?list=PLabc123XYZ")).toBeUndefined();
  });

  it("gives channel-live links a targeted message", () => {
    const message = validateMusicUrl("https://www.youtube.com/@LofiGirl/live");
    expect(message).toContain("Channel /live links");
  });

  it("gives everything else generic guidance", () => {
    expect(validateMusicUrl("not a url")).toContain("Paste a YouTube");
    expect(validateMusicUrl("https://vimeo.com/12345678")).toContain("Paste a YouTube");
  });
});

describe("buildEmbedUrl", () => {
  it("builds a nocookie embed URL for a video", () => {
    expect(buildEmbedUrl({ videoId: ID, playlistId: null, startSeconds: null })).toBe(
      `${YT_EMBED_ORIGIN}/embed/${ID}?enablejsapi=1&playsinline=1&rel=0&controls=0`
    );
  });

  it("never emits start=, whatever offset the target carries", () => {
    // An embed loaded with start= stops responding to playVideo after a pause
    // (0.5.3). Every offset — remembered position or the URL's own t= — rides
    // as a seek instead, so this param must never come back.
    for (const startSeconds of [90, 0, null]) {
      const url = buildEmbedUrl({ videoId: ID, playlistId: null, startSeconds }, true);
      expect(url).not.toContain("start=");
    }
  });

  it("builds a videoseries embed for playlist-only targets", () => {
    expect(buildEmbedUrl({ videoId: null, playlistId: "PLabc123XYZ", startSeconds: null })).toBe(
      `${YT_EMBED_ORIGIN}/embed/videoseries?enablejsapi=1&playsinline=1&rel=0&controls=0&list=PLabc123XYZ`
    );
  });

  it("carries list= alongside a video ID", () => {
    const url = buildEmbedUrl({ videoId: ID, playlistId: "PLabc123XYZ", startSeconds: null });
    expect(url).toContain(`/embed/${ID}?`);
    expect(url).toContain("list=PLabc123XYZ");
  });

  it("loops a single video via loop=1 + playlist=<its own id>", () => {
    const url = buildEmbedUrl({ videoId: ID, playlistId: null, startSeconds: null }, true);
    expect(url).toContain("loop=1");
    expect(url).toContain(`playlist=${ID}`);
  });

  it("loops a playlist with loop=1 alone (list= already present)", () => {
    const url = buildEmbedUrl(
      { videoId: null, playlistId: "PLabc123XYZ", startSeconds: null },
      true
    );
    expect(url).toContain("loop=1");
    expect(url).toContain("list=PLabc123XYZ");
    expect(url).not.toContain("playlist=");
  });

  it("does not add playlist= when the video already has a list", () => {
    const url = buildEmbedUrl({ videoId: ID, playlistId: "PLabc123XYZ", startSeconds: null }, true);
    expect(url).toContain("loop=1");
    expect(url).not.toContain(`playlist=${ID}`);
  });

  it("omits loop params by default", () => {
    expect(buildEmbedUrl({ videoId: ID, playlistId: null, startSeconds: null })).not.toContain(
      "loop"
    );
  });
});

describe("player protocol messages", () => {
  it("serializes commands in the wire format", () => {
    expect(JSON.parse(buildPlayerCommand("playVideo"))).toEqual({
      event: "command",
      func: "playVideo",
      args: [],
    });
    expect(JSON.parse(buildPlayerCommand("setVolume", [70]))).toEqual({
      event: "command",
      func: "setVolume",
      args: [70],
    });
  });

  it("serializes the listening handshake", () => {
    expect(JSON.parse(buildListeningMessage())).toEqual({ event: "listening" });
  });

  it("exposes both embed origins for inbound validation", () => {
    expect(YT_ALLOWED_MESSAGE_ORIGINS).toContain(YT_EMBED_ORIGIN);
    expect(YT_ALLOWED_MESSAGE_ORIGINS).toContain("https://www.youtube.com");
  });
});

describe("parsePlayerMessage", () => {
  it("decodes onReady", () => {
    expect(parsePlayerMessage(JSON.stringify({ event: "onReady", id: 1 }))).toEqual({
      type: "ready",
    });
  });

  it("decodes onStateChange", () => {
    for (const state of [YT_STATE.PLAYING, YT_STATE.PAUSED, YT_STATE.ENDED]) {
      expect(parsePlayerMessage(JSON.stringify({ event: "onStateChange", info: state }))).toEqual({
        type: "state",
        state,
      });
    }
  });

  it("decodes infoDelivery playerState", () => {
    const data = JSON.stringify({ event: "infoDelivery", info: { playerState: 2 } });
    expect(parsePlayerMessage(data)).toEqual({
      type: "info",
      state: 2,
      currentTime: null,
      duration: null,
      videoId: null,
    });
  });

  it("decodes an infoDelivery carrying clock, duration and video metadata", () => {
    const data = JSON.stringify({
      event: "infoDelivery",
      info: {
        playerState: 1,
        currentTime: 1234.56,
        duration: 10800,
        loadedFraction: 0.4,
        videoData: { video_id: ID, title: "lofi" },
      },
    });
    expect(parsePlayerMessage(data)).toEqual({
      type: "info",
      state: 1,
      currentTime: 1234.56,
      duration: 10800,
      videoId: ID,
    });
  });

  it("decodes a clock-only infoDelivery (no player state)", () => {
    const data = JSON.stringify({ event: "infoDelivery", info: { currentTime: 12.3 } });
    expect(parsePlayerMessage(data)).toEqual({
      type: "info",
      state: null,
      currentTime: 12.3,
      duration: null,
      videoId: null,
    });
  });

  it("ignores a malformed video_id rather than trusting it as a key", () => {
    const data = JSON.stringify({
      event: "infoDelivery",
      info: { currentTime: 5, videoData: { video_id: "too-short" } },
    });
    expect(parsePlayerMessage(data)).toMatchObject({ videoId: null });
  });

  it("drops non-finite clock values", () => {
    // JSON has no Infinity/NaN, but a hostile or odd sender can pass a string.
    const data = JSON.stringify({
      event: "infoDelivery",
      info: { currentTime: "12.3", duration: null, playerState: 1 },
    });
    expect(parsePlayerMessage(data)).toMatchObject({ currentTime: null, duration: null, state: 1 });
  });

  it("decodes onError codes", () => {
    expect(parsePlayerMessage(JSON.stringify({ event: "onError", info: 150 }))).toEqual({
      type: "error",
      code: 150,
    });
    // Some embeds report the code as a string.
    expect(parsePlayerMessage(JSON.stringify({ event: "onError", info: "101" }))).toEqual({
      type: "error",
      code: 101,
    });
  });

  it("returns null for an infoDelivery carrying nothing we track", () => {
    const data = JSON.stringify({ event: "infoDelivery", info: { volume: 70, muted: false } });
    expect(parsePlayerMessage(data)).toBeNull();
  });

  it("returns null for foreign bus traffic", () => {
    expect(parsePlayerMessage({ event: "onReady" })).toBeNull(); // object, not string
    expect(parsePlayerMessage(42)).toBeNull();
    expect(parsePlayerMessage(null)).toBeNull();
    expect(parsePlayerMessage("not json {")).toBeNull();
    expect(parsePlayerMessage(JSON.stringify("just a string"))).toBeNull();
    expect(parsePlayerMessage(JSON.stringify({ noEvent: true }))).toBeNull();
    expect(parsePlayerMessage(JSON.stringify({ event: "somethingElse" }))).toBeNull();
  });
});

describe("musicVolumeTo100", () => {
  it("maps the 0-1 scale to 0-100", () => {
    expect(musicVolumeTo100(0)).toBe(0);
    expect(musicVolumeTo100(0.3)).toBe(30);
    expect(musicVolumeTo100(0.7)).toBe(70);
    expect(musicVolumeTo100(1)).toBe(100);
  });

  it("clamps out-of-range values", () => {
    expect(musicVolumeTo100(-1)).toBe(0);
    expect(musicVolumeTo100(2)).toBe(100);
  });
});

describe("buildVolumeRamp", () => {
  it("returns `steps` evenly spaced values ending exactly on the target", () => {
    const ramp = buildVolumeRamp(0.8, 0.2, 4);
    expect(ramp).toHaveLength(4);
    expect(ramp[ramp.length - 1]).toBe(0.2);
    expect(ramp[0]).toBeCloseTo(0.65, 10);
    expect(ramp[1]).toBeCloseTo(0.5, 10);
    expect(ramp[2]).toBeCloseTo(0.35, 10);
  });

  it("is monotonic in both directions", () => {
    const down = buildVolumeRamp(0.7, 0.245, 5);
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThan(down[i - 1]);
    const up = buildVolumeRamp(0.245, 0.7, 13);
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeGreaterThan(up[i - 1]);
  });

  it("floors steps to at least one and still lands on the target", () => {
    expect(buildVolumeRamp(0.7, 0.2, 0)).toEqual([0.2]);
    expect(buildVolumeRamp(0.7, 0.2, -3)).toEqual([0.2]);
    expect(buildVolumeRamp(0.7, 0.2, 1)).toEqual([0.2]);
  });

  it("clamps endpoints to the 0-1 volume range", () => {
    expect(buildVolumeRamp(2, -1, 2)).toEqual([0.5, 0]);
  });

  it("handles a zero-distance ramp (from === to)", () => {
    expect(buildVolumeRamp(0.5, 0.5, 3)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("buildFadeRamp", () => {
  it("lands exactly on the target — a fade-out must reach true silence", () => {
    expect(buildFadeRamp(0.7, 0, 9).at(-1)).toBe(0);
    expect(buildFadeRamp(0, 0.7, 16).at(-1)).toBe(0.7);
  });

  it("returns `steps` values and excludes the starting level", () => {
    const ramp = buildFadeRamp(0, 0.7, 4);
    expect(ramp).toHaveLength(4);
    expect(ramp[0]).not.toBe(0);
  });

  it("is monotonic in both directions", () => {
    const up = buildFadeRamp(0, 0.7, 16);
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeGreaterThan(up[i - 1]);
    const down = buildFadeRamp(0.7, 0, 9);
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThan(down[i - 1]);
  });

  it("weights the curve toward the quiet end — halfway is a quarter of the way up", () => {
    // This is the whole point of the curve: a linear ramp would sit at 0.35
    // here, spending half the fade inside the top 6 dB.
    expect(buildFadeRamp(0, 0.7, 4)[1]).toBeCloseTo(0.175, 10);
    expect(buildFadeRamp(0.7, 0, 4)[1]).toBeCloseTo(0.175, 10);
  });

  it("makes a fade-out the mirror image of the fade-in that undid it", () => {
    const up = buildFadeRamp(0, 0.7, 8);
    const down = buildFadeRamp(0.7, 0, 8);
    // up = [l1..l8] rising to 0.7; down = [l7..l1, 0] — the same levels reversed,
    // offset by one because both exclude their own starting level.
    for (let i = 0; i < 7; i++) expect(down[i]).toBeCloseTo(up[6 - i], 10);
  });

  it("stays inside the target range at every step", () => {
    for (const level of buildFadeRamp(0, 0.7, 16)) {
      expect(level).toBeGreaterThan(0);
      expect(level).toBeLessThanOrEqual(0.7);
    }
  });

  it("floors steps to at least one and still lands on the target", () => {
    expect(buildFadeRamp(0.7, 0, 0)).toEqual([0]);
    expect(buildFadeRamp(0.7, 0, -3)).toEqual([0]);
    expect(buildFadeRamp(0, 0.7, 1)).toEqual([0.7]);
  });

  it("clamps endpoints to the 0-1 volume range", () => {
    expect(buildFadeRamp(2, -1, 2)).toEqual([0.25, 0]);
  });

  it("handles a zero-distance fade (from === to)", () => {
    expect(buildFadeRamp(0.5, 0.5, 3)).toEqual([0.5, 0.5, 0.5]);
  });

  it("never posts a level a duck would have to undo — silence is exactly 0", () => {
    // musicVolumeTo100 rounds, so a near-zero float would still post as 0; the
    // exact landing is what guarantees the pause lands on true silence.
    expect(musicVolumeTo100(buildFadeRamp(0.7, 0, 9).at(-1) as number)).toBe(0);
  });
});

describe("isResumablePosition", () => {
  it("accepts an ordinary mid-track position", () => {
    expect(isResumablePosition(1500, 10800)).toBe(true);
  });

  it("accepts the opening seconds, so a restarted track overwrites a stale offset", () => {
    // The "too early to bother" floor is applied on the resume side, not here.
    expect(isResumablePosition(0, 10800)).toBe(true);
    expect(isResumablePosition(1, 10800)).toBe(true);
  });

  it("rejects a live stream, which reports no positive duration", () => {
    expect(isResumablePosition(1500, 0)).toBe(false);
    expect(isResumablePosition(1500, null)).toBe(false);
  });

  it("rejects the final seconds — a finished track opens at the top next time", () => {
    const duration = 600;
    expect(isResumablePosition(duration - MUSIC_RESUME_END_MARGIN_SECONDS, duration)).toBe(true);
    expect(isResumablePosition(duration - MUSIC_RESUME_END_MARGIN_SECONDS + 1, duration)).toBe(
      false
    );
    expect(isResumablePosition(duration, duration)).toBe(false);
  });

  it("rejects nonsense values", () => {
    expect(isResumablePosition(-5, 600)).toBe(false);
    expect(isResumablePosition(Number.NaN, 600)).toBe(false);
    expect(isResumablePosition(Number.POSITIVE_INFINITY, 600)).toBe(false);
    expect(isResumablePosition(100, Number.NaN)).toBe(false);
  });
});

describe("musicPositionAppliesToUrl", () => {
  it("matches only the exact setting the position was recorded under", () => {
    expect(musicPositionAppliesToUrl(URL_A, URL_A)).toBe(true);
    expect(musicPositionAppliesToUrl(URL_A, URL_B)).toBe(false);
  });

  it("ignores surrounding whitespace — data.json is hand-editable", () => {
    expect(musicPositionAppliesToUrl(`  ${URL_A}\n`, URL_A)).toBe(true);
  });

  it("retires a position stored before the stamp existed", () => {
    // Pre-0.5.6 data.json has no lastMusicUrl. Its provenance is unknown, and
    // guessing the current URL would guess wrong in exactly the case the stamp
    // was added for, so it is retired once instead.
    expect(musicPositionAppliesToUrl(null, URL_A)).toBe(false);
  });
});

describe("planResume", () => {
  const video: MusicTarget = { videoId: ID, playlistId: null, startSeconds: null };
  const inList: MusicTarget = { videoId: ID, playlistId: "PLabc123", startSeconds: null };
  const listOnly: MusicTarget = { videoId: null, playlistId: "PLabc123", startSeconds: null };
  // A position recorded under URL_A, i.e. the URL still configured unless a
  // test says otherwise.
  const saved = (over: Partial<MusicResumeState> = {}): MusicResumeState => ({
    videoId: ID,
    playlistId: null,
    seconds: 1500,
    url: URL_A,
    ...over,
  });

  it("plans a seek for the same standalone video, leaving the embed URL alone", () => {
    const plan = planResume(video, saved({ seconds: 1500.87 }), URL_A);
    expect(plan.seekSeconds).toBe(1500); // floored — seekTo takes whole seconds
    // Same object back: the embed built from it is byte-identical to a cold one.
    expect(plan.target).toBe(video);
  });

  it("never puts the offset in the embed URL", () => {
    // 0.5.3's first cut used start=, and an embed loaded that way stopped
    // responding to playVideo after a pause. The URL must stay untouched.
    const plan = planResume(video, saved(), URL_A);
    expect(plan.target.startSeconds).toBeNull();
    expect(buildEmbedUrl(plan.target, true)).not.toContain("start=");
  });

  it("plans nothing when there is nothing saved", () => {
    expect(planResume(video, null, URL_A)).toEqual({ target: video, seekSeconds: null });
  });

  it("never carries a position onto a different video", () => {
    const plan = planResume(video, saved({ videoId: OTHER_ID }), URL_A);
    expect(plan).toEqual({ target: video, seekSeconds: null });
  });

  it("never applies a position recorded under a different URL", () => {
    // Every other check passes — same video, same (absent) list, well past the
    // floor. Only the provenance differs, and that alone must retire it.
    expect(planResume(video, saved(), URL_B)).toEqual({ target: video, seekSeconds: null });
  });

  it("keeps the item an edited playlist URL names", () => {
    // The regression this rule exists for: the user edits the URL to start at a
    // different item of the SAME playlist. Under the old rule the stored item
    // won and the edit was silently ignored — stickily, since every later
    // rebuild re-planned from the same store.
    const plan = planResume(inList, saved({ videoId: OTHER_ID, playlistId: "PLabc123" }), URL_B);
    expect(plan.target.videoId).toBe(ID); // the pasted item, not the stored one
    expect(plan.seekSeconds).toBeNull();
  });

  it("lets an edited t= win over the position it replaces", () => {
    // Same video, new timestamp: the URL changed, so the stored offset is gone
    // and the pasted one is what plays.
    const withStart: MusicTarget = { videoId: ID, playlistId: null, startSeconds: 90 };
    const plan = planResume(withStart, saved({ seconds: 1500 }), URL_B);
    expect(plan.seekSeconds).toBe(90);
  });

  it("prefers a still-valid position over the same URL's t=", () => {
    // Unchanged URL: the user has listened past the pasted timestamp, so the
    // position they left off at is the better answer.
    const withStart: MusicTarget = { videoId: ID, playlistId: null, startSeconds: 90 };
    const plan = planResume(withStart, saved({ seconds: 1500 }), URL_A);
    expect(plan.target.startSeconds).toBe(90); // target untouched
    expect(plan.seekSeconds).toBe(1500);
  });

  it("falls back to the URL's own t= whenever no position applies", () => {
    const withStart = (startSeconds: number | null): MusicTarget => ({
      videoId: ID,
      playlistId: null,
      startSeconds,
    });
    expect(planResume(withStart(90), null, URL_A).seekSeconds).toBe(90);
    expect(planResume(withStart(90.9), null, URL_A).seekSeconds).toBe(90); // floored
    // No MUSIC_RESUME_MIN_SECONDS floor here: that floor stops a barely-started
    // track being "resumed", but a pasted t= is an explicit instruction.
    expect(planResume(withStart(2), null, URL_A).seekSeconds).toBe(2);
    // Nothing to seek to.
    for (const bad of [0, -30, Number.NaN, null]) {
      expect(planResume(withStart(bad), null, URL_A).seekSeconds).toBeNull();
    }
  });

  it("swaps in the playlist item the embed had reached", () => {
    // Seeking cannot cross playlist items, so the item still comes from the URL
    // — /embed/<id>?list=<list>, the shape a watch+list URL already produced.
    const plan = planResume(
      listOnly,
      saved({ videoId: OTHER_ID, playlistId: "PLabc123", seconds: 200 }),
      URL_A
    );
    expect(plan).toEqual({
      target: { videoId: OTHER_ID, playlistId: "PLabc123", startSeconds: null },
      seekSeconds: 200,
    });
  });

  it("lets the saved item win over the video a watch+list URL names", () => {
    // Unchanged URL, so the list has simply advanced past the video it names.
    const plan = planResume(
      inList,
      saved({ videoId: OTHER_ID, playlistId: "PLabc123", seconds: 200 }),
      URL_A
    );
    expect(plan.target.videoId).toBe(OTHER_ID);
    expect(plan.seekSeconds).toBe(200);
  });

  it("requires the playlist context to match", () => {
    const cases: [MusicTarget, string | null][] = [
      [listOnly, "PLother"],
      [inList, null], // played standalone before, now pasted inside a list
      [video, "PLabc123"], // and the reverse
    ];
    for (const [target, playlistId] of cases) {
      expect(planResume(target, saved({ playlistId, seconds: 200 }), URL_A)).toEqual({
        target,
        seekSeconds: null,
      });
    }
  });

  it("ignores a position too near the start to be worth resuming", () => {
    const at = (seconds: number) => planResume(video, saved({ seconds }), URL_A);
    expect(at(MUSIC_RESUME_MIN_SECONDS - 1).seekSeconds).toBeNull();
    expect(at(0).seekSeconds).toBeNull();
    expect(at(MUSIC_RESUME_MIN_SECONDS).seekSeconds).toBe(MUSIC_RESUME_MIN_SECONDS);
  });

  it("ignores corrupt saved state — data.json is hand-editable", () => {
    const bad: MusicResumeState[] = [
      saved({ videoId: null }),
      saved({ videoId: "nope" }),
      saved({ seconds: Number.NaN }),
      saved({ seconds: -20 }),
    ];
    for (const state of bad) expect(planResume(video, state, URL_A).seekSeconds).toBeNull();
  });
});
