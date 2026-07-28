// Pure helpers for the lofi-music feature: YouTube URL parsing, embed-URL
// construction, and the postMessage protocol spoken to a YouTube embed.
//
// The embed is controlled WITHOUT loading YouTube's remote iframe_api script
// (remote code in the plugin context is the one thing Obsidian review hard-bans).
// Instead we speak the same wire protocol that script wraps: an iframe loaded
// with `enablejsapi=1`, a one-time `{"event":"listening"}` handshake after the
// iframe's load event, then `{"event":"command","func":...,"args":[...]}`
// strings via contentWindow.postMessage. The embed streams back onReady /
// onStateChange / infoDelivery / onError messages. This is the exact approach
// Vidstack (and therefore Media Extended) ships to thousands of Obsidian users.
//
// No `obsidian` or DOM imports — everything here is unit-testable under
// vitest's node environment (URL/URLSearchParams are Node globals).

// Embeds use the nocookie domain: same protocol, no cookies until playback
// starts, and fewer "error 153" rejections (it's also Obsidian core's default
// for markdown-embedded YouTube since 1.10.2).
export const YT_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

// Origins the embed may legitimately message us from. Depending on the video,
// the player can bounce through www.youtube.com even on a nocookie embed.
export const YT_ALLOWED_MESSAGE_ORIGINS: readonly string[] = [
  YT_EMBED_ORIGIN,
  "https://www.youtube.com",
];

// Player states reported by the embed (the IFrame API's YT.PlayerState values).
export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

// What a pasted URL resolves to. Exactly one of videoId/playlistId may be null:
// a playlist-only URL has no videoId (embedded via /embed/videoseries), and a
// plain video has no playlistId. A watch URL with both plays the video within
// its playlist context.
export interface MusicTarget {
  videoId: string | null; // 11-char [A-Za-z0-9_-]{11}
  playlistId: string | null; // list= param when present
  startSeconds: number | null; // normalized t=/start= offset (ignored by live streams)
}

// Video IDs are exactly 11 chars from this alphabet.
const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
// Playlist IDs vary in length (PL/RD/UU/OL prefixes); validate loosely.
const PLAYLIST_ID_REGEX = /^[A-Za-z0-9_-]{2,}$/;
// t=/start= values: plain seconds ("90"), or 1h2m3s-style components.
const CLOCK_TIME_REGEX = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/;

// Hostnames we accept, after stripping a leading "www." / "m.".
const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

// Channel-page path heads that *look* like stream links but carry no video ID
// (client-side resolution would need the Data API). Rejected with a specific
// validation message pointing users at the watch/live URL instead.
const CHANNEL_PATH_HEADS = new Set(["channel", "c", "user"]);

/**
 * Normalize a t=/start= value to whole seconds. Accepts plain seconds ("90"),
 * an "s" suffix ("90s"), and clock components ("2m", "1h2m3s"). Returns null
 * for anything unparsable so callers can just drop the offset.
 */
export function parseStartTime(raw: string): number | null {
  const value = raw.trim();
  if (value === "") return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  const match = value.match(CLOCK_TIME_REGEX);
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    return null;
  }
  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const seconds = match[3] ? parseInt(match[3], 10) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Extract an embeddable target from a user-pasted YouTube URL. Handles all the
 * shapes people actually paste — watch?v=, youtu.be/, /live/ (live streams),
 * /shorts/, /embed/, legacy /v/, playlist?list=, music.youtube.com, m., and
 * scheme-less input — and returns null for anything that can't be resolved to
 * a video or playlist ID client-side (non-YouTube hosts, channel /live pages,
 * malformed IDs).
 */
export function parseYouTubeUrl(raw: string): MusicTarget | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    // Tolerate scheme-less pastes ("youtube.com/watch?v=…").
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
  if (!ALLOWED_HOSTS.has(host)) return null;

  const segments = url.pathname.split("/").filter((s) => s !== "");
  const rawStart = url.searchParams.get("start") ?? url.searchParams.get("t");
  const startSeconds = rawStart !== null ? parseStartTime(rawStart) : null;
  const rawList = url.searchParams.get("list");
  const playlistId = rawList !== null && PLAYLIST_ID_REGEX.test(rawList) ? rawList : null;

  const asTarget = (videoId: string | undefined): MusicTarget | null => {
    if (videoId === undefined || !VIDEO_ID_REGEX.test(videoId)) return null;
    return { videoId, playlistId, startSeconds };
  };

  // Short links: the ID is the first path segment.
  if (host === "youtu.be") return asTarget(segments[0]);

  const head = segments[0];
  switch (head) {
    case "watch":
      return asTarget(url.searchParams.get("v") ?? undefined);
    case "live":
    case "shorts":
    case "v":
      return asTarget(segments[1]);
    case "embed":
      // An already-built playlist embed is accepted as a playlist target.
      if (segments[1] === "videoseries") {
        return playlistId !== null ? { videoId: null, playlistId, startSeconds } : null;
      }
      return asTarget(segments[1]);
    case "playlist":
      return playlistId !== null ? { videoId: null, playlistId, startSeconds } : null;
    default:
      // @handle/live, /channel/…/live, /c/…, /user/… — no resolvable ID.
      return null;
  }
}

/**
 * Settings-tab validation for the music URL. Empty is valid (feature unset —
 * this also runs against the seeded value on mount, which must not error).
 * Channel-style links get a targeted hint; everything else unparsable gets
 * generic guidance.
 */
export function validateMusicUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (parseYouTubeUrl(trimmed) !== null) return undefined;

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
    const segments = url.pathname.split("/").filter((s) => s !== "");
    const head = segments[0] ?? "";
    if (ALLOWED_HOSTS.has(host) && (head.startsWith("@") || CHANNEL_PATH_HEADS.has(head))) {
      return "Channel /live links can't be embedded — open the stream and copy its watch URL instead.";
    }
  } catch {
    // Fall through to the generic message.
  }
  return "Paste a YouTube video, live stream, or playlist link, e.g. https://www.youtube.com/watch?v=…";
}

/**
 * Build the hidden-embed URL for a parsed target. `controls=0` because the
 * player is never visible; `playsinline=1` keeps iOS from going fullscreen;
 * no `origin=` param — Obsidian's page origin (app://obsidian.md) isn't a
 * valid https origin, and the param is optional hardening (Vidstack omits it).
 *
 * `loop` replays the video/playlist when it ends. YouTube's documented quirk:
 * `loop=1` only works when a `playlist` param is present, so a single video
 * loops via `playlist=<its own id>`. Live streams ignore it (nothing to loop).
 */
export function buildEmbedUrl(target: MusicTarget, loop = false): string {
  const params = new URLSearchParams({
    enablejsapi: "1",
    playsinline: "1",
    rel: "0",
    controls: "0",
  });
  if (target.playlistId !== null) params.set("list", target.playlistId);
  if (target.startSeconds !== null && target.startSeconds > 0) {
    params.set("start", String(Math.floor(target.startSeconds)));
  }
  if (loop) {
    params.set("loop", "1");
    if (target.playlistId === null && target.videoId !== null) {
      params.set("playlist", target.videoId);
    }
  }
  const path = target.videoId !== null ? `/embed/${target.videoId}` : "/embed/videoseries";
  return `${YT_EMBED_ORIGIN}${path}?${params.toString()}`;
}

// Commands the plugin sends. Same names as the documented IFrame API funcs.
export type PlayerCommandFunc = "playVideo" | "pauseVideo" | "stopVideo" | "setVolume";

/**
 * Serialize a player command. The embed expects a JSON *string*, not an
 * object: {"event":"command","func":"playVideo","args":[]}.
 */
export function buildPlayerCommand(func: PlayerCommandFunc, args?: (number | string)[]): string {
  return JSON.stringify({ event: "command", func, args: args ?? [] });
}

/**
 * The one-time handshake posted after the iframe loads; without it the embed
 * never starts streaming events back.
 */
export function buildListeningMessage(): string {
  return JSON.stringify({ event: "listening" });
}

// Decoded inbound message, reduced to what the view cares about.
export type PlayerMessage =
  | { type: "ready" }
  | { type: "state"; state: number } // a YT_STATE value
  | { type: "error"; code: number }; // 2 invalid, 5 html5, 100 unavailable, 101/150 embed-disabled, 153 config

/**
 * Decode a `message` event payload from the embed. Anything that isn't a JSON
 * string in one of the known shapes returns null — window message traffic is
 * a shared bus, so this must never throw on foreign data. (Callers should
 * already have checked event.source/event.origin before parsing.)
 */
export function parsePlayerMessage(data: unknown): PlayerMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;

  switch (msg.event) {
    case "onReady":
      return { type: "ready" };
    case "onStateChange":
      return typeof msg.info === "number" ? { type: "state", state: msg.info } : null;
    case "onError": {
      const code = typeof msg.info === "number" ? msg.info : Number(msg.info);
      return Number.isFinite(code) ? { type: "error", code } : null;
    }
    case "infoDelivery": {
      // The workhorse event: fires continuously with {info:{playerState,…}}.
      const info = msg.info;
      if (typeof info !== "object" || info === null) return null;
      const playerState = (info as Record<string, unknown>).playerState;
      return typeof playerState === "number" ? { type: "state", state: playerState } : null;
    }
    default:
      return null;
  }
}

/**
 * Map the stored 0–1 music volume onto the embed's 0–100 setVolume scale.
 */
export function musicVolumeTo100(volume01: number): number {
  return Math.round(Math.min(1, Math.max(0, volume01)) * 100);
}

/**
 * Volume levels for a stepped ramp between two 0–1 volumes: `steps` evenly
 * spaced values that exclude `from01` and land exactly on `to01`. The embed's
 * setVolume has no native fade, so the ducking ramps post one of these per
 * step interval. Inputs are clamped to [0, 1]; `steps` is floored to ≥ 1.
 */
export function buildVolumeRamp(from01: number, to01: number, steps: number): number[] {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const from = clamp(from01);
  const to = clamp(to01);
  const count = Math.max(1, Math.floor(steps));
  const levels: number[] = [];
  for (let i = 1; i < count; i++) {
    levels.push(from + ((to - from) * i) / count);
  }
  levels.push(to); // exact landing — no float drift on the final value
  return levels;
}
