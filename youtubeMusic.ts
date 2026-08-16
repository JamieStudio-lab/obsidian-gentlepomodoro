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

// A remembered playback position, persisted across app restarts so the next
// iframe can be built pre-seeked. `videoId` is the video the offset belongs to
// (the one the embed reported playing, which inside a playlist is not
// necessarily the one the pasted URL named); `playlistId` is the list context
// it was played in, or null. `url` is the music-URL *setting* it was recorded
// under — the position belongs to that setting, not just to the video (see
// musicPositionAppliesToUrl).
export interface MusicResumeState {
  videoId: string | null;
  playlistId: string | null;
  seconds: number;
  url: string | null;
}

/**
 * Whether a stored position still belongs to the URL now configured.
 *
 * The video and playlist checks in planResume are not enough on their own: a
 * user who edits the URL to a *different item of the same playlist* would
 * otherwise have their edit overridden by the stored item, and one who edits
 * the URL's own `t=` would have it overridden by the stored offset — in both
 * cases stickily, since every later rebuild re-plans from the same store.
 * Scoping the position to the exact setting string it was recorded under makes
 * any edit to that setting retire it, while leaving an unchanged URL (the
 * playlist advancing through items under a fixed URL, a reopened panel) to
 * resume as before.
 *
 * A position stored before 0.5.6 has no URL stamp and is therefore retired
 * once, on the first plan after the upgrade: its provenance is unknown, and
 * guessing the current URL would guess wrong in exactly the case above.
 */
export function musicPositionAppliesToUrl(savedUrl: string | null, currentUrl: string): boolean {
  return savedUrl !== null && savedUrl.trim() === currentUrl.trim();
}

// Positions below this are not worth resuming — the user effectively just
// started the track, and `start=1` only adds noise to the embed URL.
export const MUSIC_RESUME_MIN_SECONDS = 5;

// Don't remember a position this close to the end: the track is finished for
// all practical purposes, so the next session should open it from the top.
export const MUSIC_RESUME_END_MARGIN_SECONDS = 10;

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
 * scheme-less input, with a timestamp from `start=`, `t=`, or a legacy `#t=`
 * fragment — and returns null for anything that can't be resolved to
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
  // Offset, in the three places YouTube has put one. The legacy fragment form
  // (youtu.be/<id>#t=1m30s) is read last and only for `t`: a query param is the
  // modern share format, so an explicit one wins. Parsing the hash as a query
  // string also covers `#t=90&…`; a fragment that isn't key=value yields null.
  const rawStart =
    url.searchParams.get("start") ??
    url.searchParams.get("t") ??
    new URLSearchParams(url.hash.replace(/^#/, "")).get("t");
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
  // Deliberately NO `start=`, for any offset from any source. An embed loaded
  // with it — alongside the loop feature's `loop=1&playlist=<self>` — stops
  // responding to `playVideo` after a `pauseVideo`, recovering only on
  // `stopVideo`: press ♪, ⏸, ♪ and the music is simply gone. 0.5.3 found this
  // with the resume offset and moved that to a seek; until 0.5.6 a URL the user
  // pasted with its own `t=` still walked straight into it. Both now ride as a
  // one-shot seekTo posted once playback starts (planResume → ResumePlan).
  if (loop) {
    params.set("loop", "1");
    if (target.playlistId === null && target.videoId !== null) {
      params.set("playlist", target.videoId);
    }
  }
  const path = target.videoId !== null ? `/embed/${target.videoId}` : "/embed/videoseries";
  return `${YT_EMBED_ORIGIN}${path}?${params.toString()}`;
}

/**
 * Whether a reported playback position is worth *recording*. Rejects the last
 * few seconds of a track (it's finished — the next session should open it at
 * the top) and anything whose duration is not positive, which is how the embed
 * reports a live stream: a DVR offset means nothing on a stream, and `start=`
 * is ignored for one anyway.
 *
 * Note there is no floor here — the "too near the start to bother resuming"
 * rule belongs to planResume, on the apply side. Recording the opening
 * seconds is what lets a restarted or looped track immediately overwrite a
 * stale offset instead of leaving it standing for the first few seconds.
 */
export function isResumablePosition(seconds: number, duration: number | null): boolean {
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return false;
  return seconds <= duration - MUSIC_RESUME_END_MARGIN_SECONDS;
}

// How a remembered position is applied to a fresh embed.
export interface ResumePlan {
  // The target to embed. Identical to the input except inside a playlist, where
  // the saved *item* replaces the one the URL names.
  target: MusicTarget;
  // Seconds to seek to once playback starts, or null for "start normally".
  seekSeconds: number | null;
}

/**
 * Work out where to open `target`: at the position remembered for the
 * currently-configured URL, or failing that at the URL's own `t=` offset.
 *
 * Neither offset is folded into the embed URL as `start=`.
 * That was 0.5.3's first cut and it broke playback: an embed loaded with
 * `start=` (alongside the loop feature's `loop=1&playlist=<self>`) stops
 * responding to `playVideo` after a pause — the player only recovers on
 * `stopVideo`. Keeping the URL byte-identical to what 0.5.2 built means
 * playback, looping, stop and close-the-panel all behave exactly as before,
 * and resume becomes purely additive: one `seekTo` once the player is running,
 * which is also the only state YouTube documents as safe to seek from.
 *
 * The playlist *item* still has to come from the URL, since seeking cannot
 * cross items — but `/embed/<id>?list=<list>` is the same shape a watch+list
 * URL already produced in 0.5.0, so it is not new ground. Resume is keyed by
 * video ID rather than playlist index: the ID still identifies the right item
 * after the playlist is reordered, and it avoids `index=` being 1-based while
 * the embed reports `playlistIndex` 0-based.
 *
 * `currentUrl` is the music-URL setting as it stands now. A stored position
 * that was recorded under a different one is not applied — see
 * musicPositionAppliesToUrl for why the video/playlist checks alone are not
 * enough — which is what lets an edited URL be honoured exactly as pasted.
 */
export function planResume(
  target: MusicTarget,
  saved: MusicResumeState | null,
  currentUrl: string
): ResumePlan {
  // The fallback plan is the URL's own t=, which since 0.5.6 rides as a seek
  // for the same reason the remembered position does — see buildEmbedUrl. No
  // MUSIC_RESUME_MIN_SECONDS floor on this path: that floor exists to stop a
  // barely-started track from being "resumed", while a pasted t= is an
  // explicit instruction, however small.
  const startSeconds = target.startSeconds;
  const fromUrl: ResumePlan = {
    target,
    seekSeconds:
      startSeconds !== null && Number.isFinite(startSeconds) && startSeconds > 0
        ? Math.floor(startSeconds)
        : null,
  };
  if (saved === null) return fromUrl;
  const { videoId, seconds } = saved;
  // A position belongs to the URL setting it was recorded under; editing that
  // setting retires it, so the pasted URL is honoured exactly as written.
  if (!musicPositionAppliesToUrl(saved.url, currentUrl)) return fromUrl;
  // Defensive: data.json is user-editable and survives across versions.
  if (videoId === null || !VIDEO_ID_REGEX.test(videoId)) return fromUrl;
  if (!Number.isFinite(seconds) || seconds < MUSIC_RESUME_MIN_SECONDS) return fromUrl;
  // The playlist context must match exactly — both standalone, or the same list.
  if (saved.playlistId !== target.playlistId) return fromUrl;
  // Outside a playlist the saved video must be the one the URL names. Inside
  // one the saved video wins: the list has advanced past the URL's own video.
  // Safe only because the URL check above has already passed — an *edited*
  // playlist URL names an item the user chose, and this rule would override it.
  if (target.playlistId === null && target.videoId !== videoId) return fromUrl;

  const seekSeconds = Math.floor(seconds);
  // Same video: hand back the very same target object, so callers can use an
  // identity check to see whether the embed URL itself changed.
  if (target.videoId === videoId) return { target, seekSeconds };
  return { target: { ...target, videoId }, seekSeconds };
}

// Commands the plugin sends. Same names as the documented IFrame API funcs.
// seekTo takes [seconds, allowSeekAhead].
export type PlayerCommandFunc = "playVideo" | "pauseVideo" | "stopVideo" | "setVolume" | "seekTo";

/**
 * Serialize a player command. The embed expects a JSON *string*, not an
 * object: {"event":"command","func":"playVideo","args":[]}.
 */
export function buildPlayerCommand(
  func: PlayerCommandFunc,
  args?: (number | string | boolean)[]
): string {
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
//
// "info" is the infoDelivery stream (~4Hz while playing). Its payload varies
// message to message — some carry a player state, some the clock, some the
// loaded video's metadata, some a combination — so every field is nullable and
// the view merges them into its own running picture.
export type PlayerMessage =
  | { type: "ready" }
  | { type: "state"; state: number } // a YT_STATE value
  | {
      type: "info";
      state: number | null; // YT_STATE value when this message carried one
      currentTime: number | null; // seconds into the current video
      duration: number | null; // total seconds; 0 or absent for a live stream
      videoId: string | null; // the video actually loaded (playlists advance)
    }
  | { type: "error"; code: number }; // 2 invalid, 5 html5, 100 unavailable, 101/150 embed-disabled, 153 config

/** Read a finite number field off an infoDelivery payload, else null. */
function numberField(fields: Record<string, unknown>, key: string): number | null {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
      // The workhorse event: fires continuously with {info:{playerState,
      // currentTime, duration, videoData:{video_id}, …}} — never all at once.
      const info = msg.info;
      if (typeof info !== "object" || info === null) return null;
      const fields = info as Record<string, unknown>;
      const state = numberField(fields, "playerState");
      const currentTime = numberField(fields, "currentTime");
      const duration = numberField(fields, "duration");

      let videoId: string | null = null;
      const videoData = fields.videoData;
      if (typeof videoData === "object" && videoData !== null) {
        const id = (videoData as Record<string, unknown>).video_id;
        if (typeof id === "string" && VIDEO_ID_REGEX.test(id)) videoId = id;
      }

      // Nothing we track — a volume/quality/loadedFraction-only delivery.
      if (state === null && currentTime === null && duration === null && videoId === null) {
        return null;
      }
      return { type: "info", state, currentTime, duration, videoId };
    }
    default:
      return null;
  }
}

/**
 * User-facing explanation for a YouTube onError code, without the plugin's
 * Notice prefix.
 *
 * The numeric code is carried through for everything except the embedding
 * refusal, which speaks for itself. There is no visible player to show
 * YouTube's own error screen, so this Notice is the only thing a user ever
 * sees — and one generic sentence covering codes 2, 5 and 100 made a real
 * report ("plays on my Mac, not on my iPad") impossible to triage: 5 is the
 * device's player refusing the video, 100 is the video being gone, and they
 * lead opposite ways. Codes are quoted so a bug report can name one.
 */
export function describeMusicError(code: number): string {
  switch (code) {
    case 101:
    case 150:
      return "this video doesn't allow embedding — try another URL.";
    case 100:
      return "that video is unavailable — it may be private or removed (YouTube error 100).";
    case 5:
      // Error 5 is the one that differs by platform: the same link can play in
      // a desktop embed and be refused inside a mobile webview.
      return "this device's player can't play this video — it may be restricted on mobile. Try another URL (YouTube error 5).";
    case 2:
      return "YouTube rejected this video link — try copying it again (YouTube error 2).";
    default:
      return `the music video can't be played (YouTube error ${String(code)}).`;
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

/**
 * Volume levels for a *fade* between two 0–1 volumes. Same contract as
 * buildVolumeRamp — `steps` values excluding `from01`, landing exactly on
 * `to01` — but eased instead of linear.
 *
 * A fade runs all the way to or from silence, and loudness is perceived
 * roughly logarithmically: a linear amplitude ramp spends half its time inside
 * the top 6 dB, so it sounds like the music snaps in and then hangs there. The
 * curve is therefore weighted quadratically toward the *quiet* end — halfway
 * through, the level sits a quarter of the way up from it — which spreads the
 * audible change evenly across the fade. A fade-out is the exact mirror of the
 * fade-in that undoes it, since progress is always measured from the quiet end.
 *
 * Ducking deliberately keeps the linear buildVolumeRamp: it moves between two
 * audible levels, where this curve would only make the dip feel late.
 */
export function buildFadeRamp(from01: number, to01: number, steps: number): number[] {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const from = clamp(from01);
  const to = clamp(to01);
  const count = Math.max(1, Math.floor(steps));
  const rising = to >= from;
  const quiet = rising ? from : to;
  const loud = rising ? to : from;
  const levels: number[] = [];
  for (let i = 1; i < count; i++) {
    // Distance from the quiet end, in normalized time, squared.
    const t = i / count;
    const progress = rising ? t : 1 - t;
    levels.push(quiet + (loud - quiet) * progress * progress);
  }
  levels.push(to); // exact landing — a fade-out must reach true silence
  return levels;
}
