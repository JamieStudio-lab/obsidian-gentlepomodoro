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
  isResumablePosition,
  resumeTarget,
  MUSIC_RESUME_MIN_SECONDS,
  MUSIC_RESUME_END_MARGIN_SECONDS,
  type MusicTarget,
} from "../youtubeMusic";

// Lofi Girl's stream ID — a real-shaped 11-char ID for readable tests.
const ID = "jfKfPfyJRdk";
// A second real-shaped ID, for "the playlist moved on" / "the URL changed" cases.
const OTHER_ID = "5qap5aO4i9A";

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

  it("appends start= for a positive offset and omits it otherwise", () => {
    expect(buildEmbedUrl({ videoId: ID, playlistId: null, startSeconds: 90 })).toContain(
      "&start=90"
    );
    expect(buildEmbedUrl({ videoId: ID, playlistId: null, startSeconds: 0 })).not.toContain(
      "start="
    );
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

describe("resumeTarget", () => {
  const video: MusicTarget = { videoId: ID, playlistId: null, startSeconds: null };
  const inList: MusicTarget = { videoId: ID, playlistId: "PLabc123", startSeconds: null };
  const listOnly: MusicTarget = { videoId: null, playlistId: "PLabc123", startSeconds: null };

  it("applies a saved position to the same standalone video", () => {
    const saved = { videoId: ID, playlistId: null, seconds: 1500.87 };
    expect(resumeTarget(video, saved)).toEqual({
      videoId: ID,
      playlistId: null,
      startSeconds: 1500, // floored — the embed's start= is whole seconds
    });
  });

  it("returns the target untouched when there is nothing saved", () => {
    expect(resumeTarget(video, null)).toBe(video);
  });

  it("never carries a position onto a different video", () => {
    const saved = { videoId: OTHER_ID, playlistId: null, seconds: 1500 };
    expect(resumeTarget(video, saved)).toBe(video);
  });

  it("keeps a URL's own t= offset when the saved state doesn't apply", () => {
    const withStart: MusicTarget = { videoId: ID, playlistId: null, startSeconds: 90 };
    const saved = { videoId: OTHER_ID, playlistId: null, seconds: 1500 };
    expect(resumeTarget(withStart, saved)).toEqual(withStart);
  });

  it("resumes the playlist on the item the embed had reached", () => {
    // A playlist-only URL embeds as /embed/videoseries; resuming by video ID
    // reopens the right item and survives the playlist being reordered.
    const saved = { videoId: OTHER_ID, playlistId: "PLabc123", seconds: 200 };
    expect(resumeTarget(listOnly, saved)).toEqual({
      videoId: OTHER_ID,
      playlistId: "PLabc123",
      startSeconds: 200,
    });
  });

  it("lets the saved item win over the video a watch+list URL names", () => {
    const saved = { videoId: OTHER_ID, playlistId: "PLabc123", seconds: 200 };
    expect(resumeTarget(inList, saved)).toEqual({
      videoId: OTHER_ID,
      playlistId: "PLabc123",
      startSeconds: 200,
    });
  });

  it("requires the playlist context to match", () => {
    expect(resumeTarget(listOnly, { videoId: ID, playlistId: "PLother", seconds: 200 })).toBe(
      listOnly
    );
    // Played standalone before, now pasted inside a list (and the reverse).
    expect(resumeTarget(inList, { videoId: ID, playlistId: null, seconds: 200 })).toBe(inList);
    expect(resumeTarget(video, { videoId: ID, playlistId: "PLabc123", seconds: 200 })).toBe(video);
  });

  it("ignores a position too near the start to be worth resuming", () => {
    const at = (seconds: number) => resumeTarget(video, { videoId: ID, playlistId: null, seconds });
    expect(at(MUSIC_RESUME_MIN_SECONDS - 1)).toBe(video);
    expect(at(0)).toBe(video);
    expect(at(MUSIC_RESUME_MIN_SECONDS)).toMatchObject({
      startSeconds: MUSIC_RESUME_MIN_SECONDS,
    });
  });

  it("ignores corrupt saved state — data.json is hand-editable", () => {
    expect(resumeTarget(video, { videoId: null, playlistId: null, seconds: 1500 })).toBe(video);
    expect(resumeTarget(video, { videoId: "nope", playlistId: null, seconds: 1500 })).toBe(video);
    expect(resumeTarget(video, { videoId: ID, playlistId: null, seconds: Number.NaN })).toBe(video);
    expect(resumeTarget(video, { videoId: ID, playlistId: null, seconds: -20 })).toBe(video);
  });

  it("round-trips through buildEmbedUrl as a start= param", () => {
    const saved = { videoId: ID, playlistId: null, seconds: 1500 };
    const url = buildEmbedUrl(resumeTarget(video, saved));
    expect(url).toContain(`/embed/${ID}?`);
    expect(url).toContain("start=1500");
  });
});
