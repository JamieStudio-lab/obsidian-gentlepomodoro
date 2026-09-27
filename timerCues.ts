/**
 * Which sound marks the end of each session (0.6.7, GitHub issue #5's second
 * half: "choose the sounds we want played when each timer expires").
 *
 * Two choices, one per ending edge, each either one of the three bundled
 * sounds or an mp3 / m4a / wav file from the vault. The start drum is NOT
 * choosable: the issue is about timers ending, and a start slot would bring a
 * "No sound" option with it, which is new policy.
 *
 * Pure on purpose — no `obsidian` import, no DOM, no audio. The edge→setting
 * mapping lives here rather than in the engine or the settings tab for the
 * reason sessionEndSummary.ts gives: in either of those it is untestable, and a
 * crossed mapping is exactly the kind of bug that reads fine.
 *
 * A stored value is `"bell" | "ding" | "drum"` or `"file:<vault path>"`. The
 * prefix says which kind a value is, so resolveCue never infers it from the
 * text — and a built-in id added later can never be read as a path.
 */

export type CueEdge = "focus" | "break";

export const BUILTIN_CUES = {
  bell: { file: "singing_bell_short.mp3", label: "Singing bell" },
  ding: { file: "ding-sound.mp3", label: "Ding" },
  drum: { file: "war-drum_short.mp3", label: "War drum" },
} as const;

export type BuiltinCueId = keyof typeof BUILTIN_CUES;

/** The order the picker lists them in. */
export const BUILTIN_CUE_ORDER: readonly BuiltinCueId[] = ["bell", "ding", "drum"];

/** Today's sounds — which is what makes the upgrade change nobody's. */
export const DEFAULT_END_CUE: Readonly<Record<CueEdge, BuiltinCueId>> = {
  focus: "bell",
  break: "ding",
};

/** The setting each edge reads. The FOCUS edge is the sound when focus ends. */
export const CUE_SETTING_KEY = {
  focus: "focusEndSound",
  break: "breakEndSound",
} as const;

export const CUE_FILE_PREFIX = "file:";

/**
 * The formats every platform the plugin runs on can decode. The choice syncs
 * with data.json, so a format one device plays and another does not would
 * quietly change the sound on a phone: Ogg, Opus and WebM are uncertain in
 * iOS's web view, FLAC likewise, and Apple Lossless (.m4a too) fails on the
 * desktop app. AAC in .m4a, mp3 and plain PCM .wav are safe everywhere.
 */
export const CUE_FILE_EXTENSIONS = ["mp3", "m4a", "wav"] as const;

/**
 * The longest sound a user may pick. A cue cannot be stopped once it starts —
 * Stop, Pause and the mute do not reach a sound already playing — so a long
 * file would play on into the next session, which is the interruption this
 * plugin exists to avoid; and the lofi music stays ducked for its whole length.
 */
export const CUE_MAX_SECONDS = 30;

/** Encoder padding: a "30 second" mp3 can decode a little long. */
const CUE_DURATION_SLACK_SECONDS = 0.5;

/**
 * The largest file that will be READ, checked before the read. This is the
 * memory guard, not the length check: the whole file is decoded to raw audio
 * before its length is known (about 23 MB a minute at 48 kHz stereo), so a
 * long file at a low bitrate could cost a phone far more than its size
 * suggests. 2 MB holds 30 seconds of mp3 at 320 kbps (1.2 MB) and of AAC at
 * 512 kbps (1.9 MB). An uncompressed .wav decodes to about its own size or
 * twice it, so it can be larger: 30.5 seconds of stereo at 44.1 or 48 kHz is
 * 5.4 / 5.9 MB at 16-bit, 8.1 / 8.8 MB at 24-bit and 10.8 / 11.7 MB as 32-bit
 * float — all under 12 MiB. A higher sample rate (88.2 or 96 kHz) at 24-bit
 * or more reaches the cap before 30 seconds and is refused as too large.
 */
const CUE_MAX_BYTES_COMPRESSED = 2 * 1024 * 1024;
const CUE_MAX_BYTES_WAV = 12 * 1024 * 1024;

export type CueFileExtension = (typeof CUE_FILE_EXTENSIONS)[number];

/** What to play for an edge: the bundled file, and a vault file to prefer. */
export interface ResolvedCue {
  /** A key of AUDIO_URLS — the chosen built-in, or this edge's default. */
  file: string;
  /** The user's own file, or null. When it cannot play, `file` does. */
  path: string | null;
}

/** Why a user's file did not (or will not) play. */
export type CueProblem = "missing" | "too-large" | "unreadable" | "undecodable" | "too-long";

function isBuiltinId(value: string): value is BuiltinCueId {
  // Tested against the id LIST, never with `in`: `in` walks the prototype
  // chain, so "toString" would count as a sound — resolveTheme shipped
  // exactly that bug.
  return (BUILTIN_CUE_ORDER as readonly string[]).includes(value);
}

/** The lower-cased extension of a path when it is one the cue accepts, else null. */
export function cueExtension(path: string): CueFileExtension | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return (CUE_FILE_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as CueFileExtension)
    : null;
}

/** The value stored for a vault file. */
export function cueFileValue(path: string): string {
  return CUE_FILE_PREFIX + path;
}

/**
 * Read a stored value. coerceToDefaults keeps ANY string for a string field,
 * so a hand-edited data.json, an id from a newer build or a path to a format
 * this one cannot play all reach here and land on the edge's default.
 */
export function resolveCue(value: unknown, edge: CueEdge): ResolvedCue {
  const fallback = BUILTIN_CUES[DEFAULT_END_CUE[edge]].file;
  if (typeof value !== "string") return { file: fallback, path: null };
  if (isBuiltinId(value)) return { file: BUILTIN_CUES[value].file, path: null };
  if (value.startsWith(CUE_FILE_PREFIX)) {
    const path = value.slice(CUE_FILE_PREFIX.length);
    if (path !== "" && cueExtension(path) !== null) return { file: fallback, path };
  }
  return { file: fallback, path: null };
}

/** The built-in the edge plays when its file cannot — the name the status line gives. */
export function fallbackCueLabel(edge: CueEdge): string {
  return BUILTIN_CUES[DEFAULT_END_CUE[edge]].label;
}

const LABEL_MAX = 40;

/**
 * What the chooser button says: a built-in's name, or the file's own name.
 * Display only. A long file name keeps its extension, so it is still clear
 * which kind of file it is.
 */
export function cueLabel(value: unknown, edge: CueEdge): string {
  const cue = resolveCue(value, edge);
  if (cue.path === null) {
    const id = BUILTIN_CUE_ORDER.find((k) => BUILTIN_CUES[k].file === cue.file);
    return id === undefined ? fallbackCueLabel(edge) : BUILTIN_CUES[id].label;
  }
  const name = cue.path.slice(cue.path.lastIndexOf("/") + 1);
  if (name.length <= LABEL_MAX) return name;
  const dot = name.lastIndexOf(".");
  const ext = name.slice(dot);
  return name.slice(0, LABEL_MAX - ext.length - 1) + "…" + ext;
}

/** The size above which a file of this kind is refused without being read. */
export function cueMaxBytes(ext: CueFileExtension): number {
  return ext === "wav" ? CUE_MAX_BYTES_WAV : CUE_MAX_BYTES_COMPRESSED;
}

/** The problem with a file of this size, before reading it, or null. */
export function checkCueFileSize(path: string, bytes: number): CueProblem | null {
  const ext = cueExtension(path);
  if (ext === null) return "undecodable";
  return bytes > cueMaxBytes(ext) ? "too-large" : null;
}

/** The problem with a decoded sound of this length, or null. */
export function checkCueDuration(seconds: number): CueProblem | null {
  return seconds > CUE_MAX_SECONDS + CUE_DURATION_SLACK_SECONDS ? "too-long" : null;
}

function sizeLimitText(path: string): string {
  const ext = cueExtension(path);
  const bytes = ext === null ? CUE_MAX_BYTES_COMPRESSED : cueMaxBytes(ext);
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * The line under the row when the SAVED file cannot play here. Always names
 * what plays instead, so the row answers "what will I hear?" — never a Notice
 * at the moment the cue plays, which is the one moment the plugin protects.
 */
export function describeCueFallback(problem: CueProblem, path: string, edge: CueEdge): string {
  const instead = `${fallbackCueLabel(edge)} plays instead.`;
  switch (problem) {
    case "missing":
      return `Not found on this device. ${instead}`;
    case "too-large":
      return `Larger than ${sizeLimitText(path)}. ${instead}`;
    case "unreadable":
      return `Can't read this file on this device. ${instead}`;
    case "undecodable":
      return `Can't play this file on this device. ${instead}`;
    case "too-long":
      return `Longer than ${String(CUE_MAX_SECONDS)} seconds. ${instead}`;
  }
}

/** The line under the row when a file is refused as it is PICKED — nothing is saved. */
export function describeCueRefusal(problem: CueProblem, path: string): string {
  switch (problem) {
    case "missing":
      return "That file is no longer in the vault.";
    case "too-large":
      return `Larger than ${sizeLimitText(path)}. Pick a smaller file.`;
    case "unreadable":
      return "Couldn't read that file. Pick another one.";
    case "undecodable":
      return "Can't play that file on this device. Try an mp3.";
    case "too-long":
      return `Longer than ${String(CUE_MAX_SECONDS)} seconds. Pick a shorter sound.`;
  }
}

/** One row of the picker: a bundled sound, or a vault file. */
export type CueChoice = { kind: "builtin"; id: BuiltinCueId } | { kind: "file"; path: string };

/**
 * What the picker offers: the three built-ins first, then every vault file in
 * a format the cue accepts, sorted by path. Too-large and too-long files are
 * listed rather than hidden, and refused with a reason when picked — a file
 * that silently fails to appear gives the user nothing to go on.
 */
export function cueChoices(files: readonly { path: string }[]): CueChoice[] {
  const builtins = BUILTIN_CUE_ORDER.map((id): CueChoice => ({ kind: "builtin", id }));
  const own = files
    .map((f) => f.path)
    .filter((path) => cueExtension(path) !== null)
    .sort((a, b) => a.localeCompare(b))
    .map((path): CueChoice => ({ kind: "file", path }));
  return [...builtins, ...own];
}

/** A picker row's text — also what the fuzzy search matches against. */
export function cueChoiceText(choice: CueChoice): string {
  return choice.kind === "builtin" ? `${BUILTIN_CUES[choice.id].label} (built-in)` : choice.path;
}

/** The value a choice is stored as. */
export function cueChoiceValue(choice: CueChoice): string {
  return choice.kind === "builtin" ? choice.id : cueFileValue(choice.path);
}
