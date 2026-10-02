import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import type { TaskItem } from "./types";
import type { TaskScope } from "./taskScope";
import type { MomentFactory } from "./momentTypes";

declare const moment: MomentFactory;

export interface TaskGroup {
  label: string;
  items: TaskItem[];
}

/** The linked task, so it can be shown even when the scope would hide it. */
export interface TaskPin {
  path: string;
  /**
   * TimerEngine's `currentTaskLineText` — the linked line's raw text, 🍅 count
   * included. Compared through taskLineKey (count left out).
   */
  lineText: string;
  /** The linked task's 🆔, when it has one: then the pin is matched by it. */
  taskId?: string;
}

export interface TaskLoadOptions {
  scope: TaskScope;
  limitDays?: number; // default 3
  /**
   * Admit tasks carrying neither ⏳ nor 📅. Only the note scopes pass this:
   * inside one note (or your open tabs) the scope is already narrow, so a date
   * filter on top of it mostly yields an empty list, which is precisely the
   * complaint issue #4 opens with. A folder scan is wide and still needs the
   * date to stay readable, so it never sets this and its list is unchanged.
   */
  includeUndated?: boolean;
  /**
   * The task the timer is linked to. Its file is read even when out of scope,
   * and the task itself bypasses the date window — changing the scope must
   * never make a live link look dropped (issue #4, the maintainer's second
   * requirement). Marked `pinned` only when the normal filters would have
   * dropped it, so a linked task already in view is not listed twice.
   */
  pin?: TaskPin | null;
}

// Tasks-plugin checkbox line, on any bullet Obsidian's list syntax allows:
// `-`, `*`, `+`, or a numbered `1.` / `1)`. The Tasks plugin treats all of
// them as tasks, so a `* [ ]` line renders as a normal task in Obsidian —
// hardcoding `-` here made such tasks silently invisible to the picker, the
// ID lookup, and the 🍅 marker walkers. Group 1 is the status char, group 2
// the text; exported so TimerEngine matches task lines identically.
export const TASK_LINE_REGEX = /^\s*(?:[-*+]|\d+[.)])\s*\[( |x)\]\s+(.*)$/i;
const SCHEDULED_REGEX = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const DUE_REGEX = /📅\s*(\d{4}-\d{2}-\d{2})/;
const TASK_ID_REGEX = /🆔\s*([A-Za-z0-9_-]+)/;
// Pomodoro count marker. The optional `(YYYY-MM-DD)` group reads the today-only
// format of a build from before 0.1.0 (`🍅 N (2026-05-18)`), so such markers
// are still found — the date is dropped on the next write. A DATE only, not
// any `(…)`: that build wrote nothing else, and a note in brackets the user
// typed after a `🍅 N` ("Call mum 🍅 2 (Sunday)") is their text — taken as part
// of the marker, it made that 🍅 the counter and the next write deleted it.
// A line can carry more than one `🍅 N` — the counter's and one the user typed
// — so no reader takes the first `🍅 N` on the line; see isCounterMarker and
// counterMarkers.
const POMO_MARKER_REGEX = /🍅\s*(\d+)(?:\s*\(\d{4}-\d{2}-\d{2}\))?/gu;
// The field emoji: the counter writes its marker in front of the first of
// these on a line. The Tasks plugin only recognizes its emoji fields at the
// end of the line, so any text placed after them silently demotes every field
// to plain description text (GitHub issue #2). Tasks 8.3's own symbols, read
// out of its bundle: dates 🛫 ➕ ⏳ ⌛ 📅 📆 🗓 ✅ ❌ (⌛ is its other "scheduled",
// 📆 and 🗓 its other "due"), priorities 🔺 ⏫ 🔼 🔽 ⏬, 🔁 recurrence,
// 🏁 on-completion, ⛔ depends-on, 🆔 id — plus 🔥, which is not a Tasks field
// but has always been on this list: dropping it would make every marker
// already written in front of one look like the user's text.
const FIELD_EMOJI = "⏳⌛📅📆🗓🛫➕✅❌⛔🏁🔺🔽🔥⏫⏬🔼🔁🆔";
const TASKS_METADATA_TOKEN_REGEX = new RegExp(`[${FIELD_EMOJI}]`, "u");
// The same list as 0.5.1–0.6.8 had it, before ⌛ 📆 🗓 joined: those versions
// wrote their marker in front of the first of THESE, i.e. sometimes after an
// ⌛ 📆 or 🗓 — and a marker they wrote must still be recognised.
const LEGACY_FIELD_EMOJI_REGEX = /[⏳📅🛫➕✅❌⛔🏁🔺🔽🔥⏫⏬🔼🔁🆔]/u;
// Trailing Obsidian block reference (`^block-id`) — must stay at the very end.
const BLOCK_ID_REGEX = /\s+\^[A-Za-z0-9-]+\s*$/;

// What may stand behind the counter's marker. A tag is exactly what the Tasks
// plugin's own tag pattern takes (`#[^ !@#$%^&*(),.?":{}|<>]+`: only a plain
// space ends one, and emoji are allowed, so `#🍅` and `#✅done` are tags and
// `#paper📅 2026-10-01` is a tag and a date by backtracking); a field is a
// whole Tasks 8.3 field, symbol and value, as its parser takes it off the end
// of the line; another marker is transparent, so two counter markers on one
// line are both seen.
const MARKER_TAG = '#[^ !@#$%^&*(),.?":{}|<>]+';
const MARKER_FIELD =
  "(?:[🔺⏫🔼🔽⏬]\\uFE0F?" +
  "|[🛫➕⏳⌛📅📆🗓✅❌]\\uFE0F?\\s*\\d{4}-\\d{2}-\\d{2}" +
  "|🔁\\uFE0F?\\s*[a-zA-Z0-9, !]+" +
  "|🏁\\uFE0F?\\s*[a-zA-Z]+" +
  "|⛔\\uFE0F?\\s*[a-zA-Z0-9_-]+(?:\\s*,\\s*[a-zA-Z0-9_-]+)*" +
  "|🆔\\uFE0F?\\s*[a-zA-Z0-9_-]+)";
const OTHER_MARKER = POMO_MARKER_REGEX.source.replace("(\\d+)", "\\d+");
// Where a marker the plugin wrote can sit, as the text BEHIND it:
// - MARKER_TAIL_REGEX: nothing but tags, Tasks fields and other markers, then
//   a block reference (after a space, as Obsidian and Tasks require) or the
//   end of the line. That is every place the ≤0.5.0 append bug left a marker
//   and every place Tasks moves one when it rewrites the line.
// - CANONICAL_TAIL_REGEX: tags or markers, then a space and a field emoji —
//   the spot the counter writes to, in front of the line's FIRST field emoji.
//   Only when no field emoji stands before the marker — on the 0.6.8 list,
//   which is where the counter wrote until now (isCounterMarker): that emoji
//   may be one in the task text ("Add 🔺 watchlist"), where a genuine field
//   cannot be required behind it, but a `🍅 N` typed after an emoji in the
//   text ("Fix ❌ login, then 🍅 2 ✅ tests") must not pass on the emoji alone.
//   The space is load-bearing: the counter always writes one, and without it
//   a tag such as `#work🔥` gave up its 🔥 as "the field emoji". Other
//   markers are passed over, so taking one out never turns a `🍅 N` beside it
//   into a count. One shape is lost: a `🍅 2` typed glued onto a field emoji
//   (`🍅 2🔁`) is the user's, until the counter writes in front of that emoji
//   — the space it adds makes theirs a count.
const MARKER_TAIL_REGEX = new RegExp(
  `^(?:\\s+${MARKER_TAG}|\\s*${MARKER_FIELD}|\\s+${OTHER_MARKER})*(?:\\s+\\^[A-Za-z0-9-]+)?\\s*$`,
  "u"
);
const CANONICAL_TAIL_REGEX = new RegExp(
  `^(?:\\s+${MARKER_TAG}|\\s+${OTHER_MARKER})*\\s+[${FIELD_EMOJI}]`,
  "u"
);

// The Tasks plugin's own reading of a task's text — 8.3's deserializer, read
// out of its bundle. Up to 21 passes over the END of the text; each pass tries
// these in this order, taking each off the end and trimming; a pass that takes
// nothing ends it. A tag is kept (and put back after the description), a field
// is not. The order matters: a tag is tried before 🆔 and ⛔, so `#x⛔y` at the
// end is a tag, while a date is tried before a tag, so `#paper📅 2026-09-30` is
// a tag and a date.
const TASKS_READING_STEPS: { tag: boolean; at: RegExp }[] = [
  { tag: false, at: /(?:🔺|⏫|🔼|🔽|⏬)\uFE0F?$/u },
  { tag: false, at: /✅\uFE0F? *\d{4}-\d{2}-\d{2}$/u },
  { tag: false, at: /❌\uFE0F? *\d{4}-\d{2}-\d{2}$/u },
  { tag: false, at: /(?:📅|📆|🗓)\uFE0F? *\d{4}-\d{2}-\d{2}$/u },
  { tag: false, at: /(?:⏳|⌛)\uFE0F? *\d{4}-\d{2}-\d{2}$/u },
  { tag: false, at: /🛫\uFE0F? *\d{4}-\d{2}-\d{2}$/u },
  { tag: false, at: /➕\uFE0F? *\d{4}-\d{2}-\d{2}$/u },
  { tag: false, at: /🔁\uFE0F? *[a-zA-Z0-9, !]+$/u },
  { tag: false, at: /🏁\uFE0F? *[a-zA-Z]+$/u },
  { tag: true, at: /(?:^|\s)#[^ !@#$%^&*(),.?":{}|<>]+$/u },
  { tag: false, at: /🆔\uFE0F? *[a-zA-Z0-9_-]+$/u },
  { tag: false, at: /⛔\uFE0F? *[a-zA-Z0-9_-]+(?: *, *[a-zA-Z0-9_-]+ *)*$/u },
];
// Tasks takes a block link off first.
const TASKS_BLOCK_LINK_REGEX = /\s\^[A-Za-z0-9-]+\s*$/u;

interface TasksReading {
  /** What is left once the fields and tags are taken off the end. */
  description: string;
  /** The tags taken, in the order they stand on the line. */
  tags: string[];
  /** Where each field taken off begins, as an index into the text read. */
  fieldStarts: number[];
}

/** How the Tasks plugin reads `text` (see TASKS_READING_STEPS). */
function tasksReading(text: string): TasksReading {
  const block = TASKS_BLOCK_LINK_REGEX.exec(text);
  // Every step cuts from the end, so `rest` is always a prefix of `text` and
  // an index into it is an index into `text`.
  let rest = (block ? text.slice(0, block.index) : text).trimEnd();
  const tags: string[] = [];
  const fieldStarts: number[] = [];
  for (let pass = 0; pass <= 20; pass++) {
    let took = false;
    for (const step of TASKS_READING_STEPS) {
      const found = step.at.exec(rest);
      if (!found) continue;
      if (step.tag) tags.unshift(found[0].trim());
      else fieldStarts.push(found.index);
      rest = rest.slice(0, found.index).trimEnd();
      took = true;
    }
    if (!took) break;
  }
  return { description: rest, tags, fieldStarts };
}

/**
 * Index of the first match of `fieldEmoji` in `text` that is not part of a
 * tag, or -1. A field emoji inside a tag (`#✅done`, `#⏫`, `#x⛔y`) is the
 * tag's — writing the marker in front of it split the tag, and could hand the
 * task a priority, an ID or a dependency it did not have — unless the Tasks
 * plugin itself reads a field starting there: `#paper📅 2026-09-30` is a tag
 * and a date to it, and the marker belongs before the date.
 */
function firstFieldEmoji(text: string, fieldEmoji: RegExp): number {
  let reading: TasksReading | undefined;
  for (const match of text.matchAll(new RegExp(fieldEmoji.source, "gu"))) {
    const index = match.index ?? 0;
    const word = /\S*$/u.exec(text.slice(0, index))?.[0] ?? "";
    if (!word.startsWith("#")) return index;
    reading ??= tasksReading(text);
    if (reading.fieldStarts.includes(index)) return index;
  }
  return -1;
}
const PRIORITY_REGEX = /[🔺🔽🔥⏫⏬🔼]\uFE0F?/gu;
const VARIATION_SELECTOR_REGEX = /\uFE0F/gu;

// Dates + priorities + recurrence + ID (for canonical task matching)
const CLEANUP_REGEX =
  /[⏳📅🛫➕✅]\s*\d{4}-\d{2}-\d{2}|[🔺🔽🔥⏫⏬🔼]\uFE0F?\s*\w*|🔁\s*[a-zA-Z0-9\s]+|🆔\s*[A-Za-z0-9_-]+/gu;

// Dates + recurrence + ID + dependencies + on-completion + tags (for display,
// keep priority icons only). Display only: the ⛔ and 🏁 alternatives are NOT
// in CLEANUP_REGEX, because that one builds the logged name, and widening it
// would rename every linked task that carries them in the daily log.
// A tag stops at a Tasks field emoji — `#paper📅 2026-09-30`, written with no
// space, would otherwise swallow the 📅 and leave the bare date behind.
const DISPLAY_CLEANUP_REGEX =
  /[⏳📅🛫➕✅❌]\s*\d{4}-\d{2}-\d{2}|🔁\s*[a-zA-Z0-9\s]+|🆔\s*[A-Za-z0-9_-]+|⛔\s*[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*|🏁\s*[a-zA-Z]+|#[^\s⏳📅🛫➕✅❌⛔🏁🔺🔽🔥⏫⏬🔼🔁🆔]+/gu;

// shared normalization for task text
export function normalizeTaskText(text: string): string {
  return text.replace(CLEANUP_REGEX, "").trim();
}

/**
 * The form a task line is compared in when a task with no 🆔 is matched by its
 * text — TimerEngine's `currentTaskLineText` against a note's lines. Takes the
 * line's RAW text (after the checkbox), never the logged name, and is
 * comparison only.
 *
 * It is the Tasks plugin's own reading of the line (tasksReading): fields
 * come off the END, tags among them are kept and put back after the rest.
 * That is what survives Tasks rewriting the line — when it ticks it, edits it
 * or starts the next recurrence it moves those tags in front of the fields,
 * writes the fields in its own order and 🗓 back as 📅 — while text that only
 * looks like a field inside the user's words ("Fix ⛔ login page", "Refund ❌
 * 2026-09-30 order") stays, so two different tasks are not made one. Keyed on
 * the logged name instead, the first rewrite lost the line (no count, no
 * unlink, no tick): that name has already lost text wherever a field emoji
 * stood (a priority takes the word after it, a recurrence stops at a comma).
 */
export function taskMatchKey(lineText: string): string {
  const { description, tags } = tasksReading(lineText);
  return [description, ...tags]
    .join(" ")
    .replace(VARIATION_SELECTOR_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * taskMatchKey without the counter's markers: the same for every count of a
 * line, so a task is still found when the text the timer holds for it is
 * older or newer than the line — a picker list opened before a count, a count
 * removed by hand or by Remove all, a pick while a session was being logged.
 * The timer tries the exact key first and this second; the picker's tick and
 * pin use this. A `🍅 N` the user typed is not the counter's and stays in it,
 * so "Buy 🍅 2 kg" and "Buy kg" are still two tasks.
 */
export function taskLineKey(lineText: string): string {
  return taskMatchKey(removeAnyPomodoroMarker(lineText));
}

export function normalizeTaskTextForDisplay(text: string): string {
  const priorityMatch = text.match(PRIORITY_REGEX);
  let cleaned = text.replace(DISPLAY_CLEANUP_REGEX, "");
  cleaned = cleaned.replace(PRIORITY_REGEX, "");
  cleaned = cleaned.replace(VARIATION_SELECTOR_REGEX, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (priorityMatch && priorityMatch.length > 0) {
    const priorityIcon = priorityMatch[0].replace(VARIATION_SELECTOR_REGEX, "");
    cleaned = `${cleaned} ${priorityIcon}`.trim();
  }

  return cleaned;
}

/**
 * The name the "Current task" button shows for the linked task.
 *
 * The timer names a task by its normalizeTaskText form, and that form keeps
 * `#tags` on purpose: it is the name written into the daily log, where a
 * Dataview query may read a tag straight off the line, and the name the 🆔
 * rename rule compares. (Finding the task's line is another matter: by its
 * 🆔, or by its raw line text through taskMatchKey and taskLineKey.) So the
 * button derives a display form here rather than the timer storing a
 * different name. It is the cleanup the picker's rows get, so
 * the two read alike; only the row adds a priority icon, which the timer's
 * name has already lost. One more difference it cannot undo: a priority emoji
 * typed mid-description takes the word after it out of the timer's name
 * (CLEANUP_REGEX's `\s*\w*`), and the button only ever sees that name. A name
 * that is nothing but tags falls back to itself, as the rows do.
 */
export function linkedTaskDisplayName(cleanText: string): string {
  return normalizeTaskTextForDisplay(cleanText) || cleanText;
}

/** Every `🍅 N` on a line, in order, each with its index. */
function pomodoroMarkers(line: string): RegExpMatchArray[] {
  return [...line.matchAll(POMO_MARKER_REGEX)];
}

/**
 * Is this `🍅 N` one the plugin wrote? It always wrote a space in front of the
 * marker, so one glued to the text before it (`#pomo🍅2`, `复习🍅2`, a URL) is
 * the user's. Behind it: nothing but tags, Tasks fields and other markers up
 * to a block reference or the end of the line (MARKER_TAIL_REGEX), or — when
 * no field emoji stands before it — tags, then the field emoji the counter
 * writes in front of (CANONICAL_TAIL_REGEX). Anything else behind it means the
 * user typed it ("Buy 🍅 2 kg"), and it is their text: never read as a count,
 * moved or deleted. What this cannot tell apart, both ways: a `🍅 N` the user
 * typed with only fields after it counts as the plugin's; and the plugin's
 * own marker with words the user added after it (Edit Task puts them there)
 * counts as text — it stays, and the count starts again at 1 beside it.
 */
function isCounterMarker(line: string, match: RegExpMatchArray): boolean {
  const index = match.index ?? 0;
  if (index > 0 && !/\s/u.test(line[index - 1])) return false;
  const tail = line.slice(index + match[0].length);
  if (MARKER_TAIL_REGEX.test(tail)) return true;
  // Read on the whole line: whether an emoji inside a tag is a field depends
  // on what follows it.
  const firstField = firstFieldEmoji(line, LEGACY_FIELD_EMOJI_REGEX);
  return (firstField === -1 || firstField > index) && CANONICAL_TAIL_REGEX.test(tail);
}

/**
 * The counter's markers on a line, in order — usually one. Every reader works
 * from this one list: the count is the first one's; the counter folds them all
 * into one marker, and so does Repair when one is misplaced; Remove deletes
 * the misplaced ones and Remove all every one. Taking the first `🍅 N` made the counter count from
 * the user's number and rewrite their text ("Buy 🍅 2 kg" → "Buy kg 🍅 3"), and
 * readers that each picked their own marker disagreed on a line with two.
 */
function counterMarkers(line: string): RegExpMatchArray[] {
  return pomodoroMarkers(line).filter((match) => isCounterMarker(line, match));
}

/** Remove markers from the line, collapsing the space each leaves. */
function removePomodoroMarkers(line: string, markers: RegExpMatchArray[]): string {
  // Right to left, so each index still points into the unchanged part.
  return [...markers].reverse().reduce((text, match) => {
    const index = match.index ?? 0;
    return text.slice(0, index).trimEnd() + text.slice(index + match[0].length);
  }, line);
}

/**
 * The counter's markers in a *harmful* position: where they stop the Tasks
 * plugin reading the line's fields — inside or after the fields it reads once
 * the markers are taken out (the ≤0.5.0 append bug, which hides every field;
 * also where 0.5.1–0.6.8 left a marker behind an ⌛ 📆 or 🗓 date) — or after a
 * trailing `^block-id` (which breaks the block reference). A field emoji that
 * is only text ("🗓️ Plan …", "Add 🔺 watchlist …"), or one inside a tag, does
 * not start the fields, because Tasks does not read it as one.
 *
 * Deliberately conservative: only the counter's markers (isCounterMarker) can
 * be misplaced, so a `🍅 N` the user typed is never moved or deleted — not one
 * on a line with no fields, not one after an emoji in the task text ("Fix ❌
 * login, then 🍅 2 tests"). Moving such a `🍅` would rewrite their text and
 * could not fix the line for the Tasks plugin, which stops at the words.
 */
function misplacedCounterMarkers(line: string, markers: RegExpMatchArray[]): RegExpMatchArray[] {
  const stripped = removePomodoroMarkers(line, markers);
  const fieldStarts = tasksReading(stripped).fieldStarts;
  const fieldsAt = fieldStarts.length > 0 ? Math.min(...fieldStarts) : -1;
  const block = stripped.match(BLOCK_ID_REGEX);
  const blockAt = block ? line.lastIndexOf(block[0].trim()) : -1;
  return markers.filter((match, i) => {
    const index = match.index ?? 0;
    // Where the marker stands once the markers are out, in `stripped`.
    const at = removePomodoroMarkers(line.slice(0, index), markers.slice(0, i)).trimEnd().length;
    return (fieldsAt !== -1 && at > fieldsAt) || (blockAt !== -1 && index > blockAt);
  });
}

/**
 * Read the lifetime pomodoro count from a task line — the counter's marker
 * only, so a line whose only `🍅 N` the user typed reads 0. Tolerates the
 * legacy `🍅 N (YYYY-MM-DD)` format of a build from before 0.1.0 — the date is
 * ignored, N is returned.
 */
export function parsePomodoroCount(line: string): number {
  const [first] = counterMarkers(line);
  return first ? parseInt(first[1], 10) : 0;
}

/**
 * Returns the line with the lifetime pomodoro count incremented by 1.
 *
 * The marker is written at the end of the task *description* — before the
 * first Tasks-plugin field emoji (⏳ 📅 🆔 priority …) — never after the
 * fields: the Tasks plugin only parses its emoji fields off the end of the
 * line, so a trailing marker turns every field into plain description text
 * and the task's dates vanish from queries and Edit Task (GitHub issue #2).
 *
 * - If the counter's marker exists (with or without a legacy date): increment
 *   N and re-insert at the correct position — lines written by ≤0.5.0 (marker
 *   trailing the fields) heal on their next increment. A legacy date is
 *   dropped on write, so `🍅 N (YYYY-MM-DD)` markers migrate to plain `🍅 N`.
 *   A second counter marker on the line is folded in (the count is the
 *   first one's).
 * - If not: insert ` 🍅 1` before the first field emoji, keeping a trailing
 *   block reference (`^block-id`) at the very end of the line.
 *
 * A `🍅 N` the user typed is not the counter's marker (isCounterMarker) and
 * stays byte-for-byte as it is: "Buy 🍅 2 kg ⏳ …" becomes
 * "Buy 🍅 2 kg 🍅 1 ⏳ …", and later sessions count the second one.
 */
export function incrementPomodoroCount(line: string): string {
  const markers = counterMarkers(line);
  if (markers.length === 0) return placePomodoroMarker(line, 1);
  const next = parseInt(markers[0][1], 10) + 1;
  return placePomodoroMarker(removePomodoroMarkers(line, markers), next);
}

/**
 * Insert `🍅 count` at the canonical position in a line without the counter's
 * marker (a `🍅 N` the user typed may still be in it; it is text).
 */
function placePomodoroMarker(stripped: string, count: number): string {
  return placeMarkerText(stripped, `🍅 ${count}`, TASKS_METADATA_TOKEN_REGEX);
}

/**
 * placePomodoroMarker for any marker text, in front of the first match of
 * `fieldEmoji` — LEGACY_FIELD_EMOJI_REGEX rebuilds where 0.5.1–0.6.8 wrote it.
 */
function placeMarkerText(stripped: string, marker: string, fieldEmoji: RegExp): string {
  const at = firstFieldEmoji(stripped, fieldEmoji);
  if (at !== -1) {
    const head = stripped.slice(0, at).trimEnd();
    return `${head} ${marker} ${stripped.slice(at)}`;
  }

  const blockMatch = stripped.match(BLOCK_ID_REGEX);
  if (blockMatch && blockMatch.index !== undefined) {
    const head = stripped.slice(0, blockMatch.index).trimEnd();
    return `${head} ${marker}${stripped.slice(blockMatch.index)}`;
  }

  return `${stripped.trimEnd()} ${marker}`;
}

/**
 * Repair a task line whose counter marker is misplaced (see
 * {@link misplacedCounterMarkers}): re-insert it at the canonical position.
 * The count, as {@link parsePomodoroCount} reads it, is kept; a second counter
 * marker on the line is folded in; anything else is left byte-for-byte
 * untouched.
 */
export function repairPomodoroMarkerPlacement(line: string): string {
  const markers = counterMarkers(line);
  if (misplacedCounterMarkers(line, markers).length === 0) return line;
  const count = parseInt(markers[0][1], 10);
  return placePomodoroMarker(removePomodoroMarkers(line, markers), count);
}

/**
 * Delete misplaced counter markers outright instead of relocating them.
 * Because the ≤0.5.0 bug only ever *appended* the marker, removal restores the
 * line to exactly its pre-bug form (the lifetime count is lost). Correctly
 * placed or harmless markers and marker-less lines are left byte-for-byte
 * untouched.
 */
export function removeMisplacedPomodoroMarker(line: string): string {
  const misplaced = misplacedCounterMarkers(line, counterMarkers(line));
  return misplaced.length === 0 ? line : removePomodoroMarkers(line, misplaced);
}

/**
 * Delete the counter's markers whether correctly placed or misplaced — the
 * "uninstall" for the counter's data. Only the counter's markers are removed
 * (isCounterMarker); a `🍅 N` the user typed mid-description is left
 * byte-for-byte untouched, including one in front of the counter, which used
 * to hide the counter from here.
 */
export function removeAnyPomodoroMarker(line: string): string {
  const markers = counterMarkers(line);
  return markers.length === 0 ? line : removePomodoroMarkers(line, markers);
}

export interface PomodoroMarkerContentResult {
  content: string;
  linesChanged: number;
  /** The 🍅 markers the action acted on in those lines — what the dialogs count. */
  markersChanged: number;
}

/**
 * A marker action: what it does to a line, and how many of the line's markers
 * that is. Lines and markers differ on a line with two counter markers, which
 * Remove and Remove all now settle in one run — so the dialogs, which promise
 * a number of markers, count markers.
 */
interface MarkerAction {
  transform: (line: string) => string;
  markers: (line: string) => number;
}

const misplacedCount = (line: string) => misplacedCounterMarkers(line, counterMarkers(line)).length;
const REPAIR: MarkerAction = { transform: repairPomodoroMarkerPlacement, markers: misplacedCount };
const REMOVE_MISPLACED: MarkerAction = {
  transform: removeMisplacedPomodoroMarker,
  markers: misplacedCount,
};
const REMOVE_ALL: MarkerAction = {
  transform: removeAnyPomodoroMarker,
  markers: (line) => counterMarkers(line).length,
};

// Any task line, whatever its status — open, done, cancelled `[-]`, in
// progress `[/]` or a custom one. The sweeps are the counter's uninstall and
// repair, so they must reach a task Tasks has cancelled; the picker and the
// counter itself keep TASK_LINE_REGEX (open or done).
const ANY_TASK_LINE_REGEX = /^\s*(?:[-*+]|\d+[.)])\s*\[[^\]]\]\s+(.*)$/;

/** Apply a line transform to every task line (any status) in a note. */
function transformTaskLines(content: string, action: MarkerAction): PomodoroMarkerContentResult {
  const lines = content.split("\n");
  let linesChanged = 0;
  let markersChanged = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!ANY_TASK_LINE_REGEX.test(lines[i])) continue;
    const next = action.transform(lines[i]);
    if (next !== lines[i]) {
      markersChanged += action.markers(lines[i]);
      lines[i] = next;
      linesChanged++;
    }
  }

  return { content: lines.join("\n"), linesChanged, markersChanged };
}

/** Run {@link repairPomodoroMarkerPlacement} over every task line. */
export function repairPomodoroMarkersInContent(content: string): PomodoroMarkerContentResult {
  return transformTaskLines(content, REPAIR);
}

/** Run {@link removeMisplacedPomodoroMarker} over every task line. */
export function removeMisplacedPomodoroMarkersInContent(
  content: string
): PomodoroMarkerContentResult {
  return transformTaskLines(content, REMOVE_MISPLACED);
}

/** Run {@link removeAnyPomodoroMarker} over every task line. */
export function removeAllPomodoroMarkersInContent(content: string): PomodoroMarkerContentResult {
  return transformTaskLines(content, REMOVE_ALL);
}

export interface PomodoroMarkerVaultResult {
  filesScanned: number;
  filesAffected: number;
  linesAffected: number;
  /** The 🍅 markers in those lines the action acts on — what the dialogs count. */
  markersAffected: number;
  /** Per-file breakdown, for logging so users can inspect before acting. */
  affected: { path: string; lines: number }[];
}

/**
 * Walk EVERY markdown note applying a marker transform. With `write: false`
 * this is a pure dry run. With `write: true`, files that need no change are
 * never written; changed files are rewritten atomically via `Vault.process`.
 *
 * Deliberately not scoped to the tasks folder, and it takes no path at all so
 * that no caller can narrow it by accident. Until 0.6.4 the folder WAS the
 * right scope, because the picker could only link a task inside it, so the
 * counter could only write inside it. The note scopes broke that: a task
 * linked from any note gets its 🍅 marker written there, and a folder-scoped
 * sweep could not see it — which would have made "Remove all", documented as
 * the counter's full uninstall, silently partial. The `includes("🍅")`
 * pre-filter below is what keeps a whole-vault sweep cheap.
 */
async function processPomodoroMarkersInVault(
  app: App,
  action: MarkerAction,
  write: boolean
): Promise<PomodoroMarkerVaultResult> {
  const files = app.vault.getFiles().filter((f) => f.extension === "md");

  let filesAffected = 0;
  let linesAffected = 0;
  let markersAffected = 0;
  const affected: { path: string; lines: number }[] = [];

  for (const file of files) {
    const content = await app.vault.cachedRead(file);
    if (!content.includes("🍅")) continue;
    const probe = transformTaskLines(content, action);
    if (probe.linesChanged === 0) continue;

    if (write) {
      await app.vault.process(file, (data) => transformTaskLines(data, action).content);
    }
    filesAffected++;
    linesAffected += probe.linesChanged;
    markersAffected += probe.markersChanged;
    affected.push({ path: file.path, lines: probe.linesChanged });
  }

  return { filesScanned: files.length, filesAffected, linesAffected, markersAffected, affected };
}

/** Dry run: count misplaced 🍅 markers without changing any file. */
export function scanMisplacedPomodoroMarkersInVault(app: App): Promise<PomodoroMarkerVaultResult> {
  return processPomodoroMarkersInVault(app, REPAIR, false);
}

/** Relocate misplaced 🍅 markers in front of the Tasks fields (counts kept). */
export function repairPomodoroMarkersInVault(app: App): Promise<PomodoroMarkerVaultResult> {
  return processPomodoroMarkersInVault(app, REPAIR, true);
}

/** Delete misplaced 🍅 markers, restoring affected lines to their pre-bug form. */
export function removeMisplacedPomodoroMarkersInVault(
  app: App
): Promise<PomodoroMarkerVaultResult> {
  return processPomodoroMarkersInVault(app, REMOVE_MISPLACED, true);
}

/** Dry run: count every plugin-written 🍅 marker without changing any file. */
export function scanAllPomodoroMarkersInVault(app: App): Promise<PomodoroMarkerVaultResult> {
  return processPomodoroMarkersInVault(app, REMOVE_ALL, false);
}

/** Delete every plugin-written 🍅 marker, correctly placed or misplaced. */
export function removeAllPomodoroMarkersInVault(app: App): Promise<PomodoroMarkerVaultResult> {
  return processPomodoroMarkersInVault(app, REMOVE_ALL, true);
}

/**
 * The files a folder setting means — the path itself when it names a file,
 * otherwise everything below that folder, subfolders included, and never a
 * sibling that only starts with the same letters (`Logs-old` for `Logs`) —
 * found by walking that one folder. Until 0.6.8 this was a filter over every
 * file in the vault (`isPathInFolder`); tests/fileAccess.test.ts keeps that
 * filter, verbatim, as the oracle this walk must agree with, order included.
 *
 * The same files in the same order, and that follows from what Obsidian does
 * rather than from care taken here (read out of app.js, 1.7.7 and 1.13.7):
 *
 * - every vault path is already `normalizePath`'d, so the files the old filter
 *   accepted are exactly the subtree of the one folder the setting names;
 * - `Vault.getFiles()` IS `Vault.recurseChildren` from the root, a stack walk
 *   that visits each folder's subtree in one unbroken run — so walking the
 *   folder alone yields that run exactly as the full list held it.
 *
 * `"/"` finds nothing, as the filter did: it keys to `""`, and the vault keys
 * its root as `"/"`. An EMPTY `folderPath` is the caller's to decide — the old
 * filter read it as the whole vault and this returns nothing — so neither
 * caller passes one: loadTasks lists the vault itself, the logs return early.
 */
export function filesInFolder(app: App, folderPath: string): TFile[] {
  const key = normalizePath(folderPath).replace(/\/+$/, "");
  // The one key the lookup cannot see. Obsidian's file map is a plain object,
  // and assigning it "__proto__" replaces the object's prototype instead of
  // adding a key — yet the folder is still in the tree, so getFiles() found it.
  const target =
    key === "__proto__"
      ? (app.vault.getRoot().children.find((item) => item.path === key) ?? null)
      : app.vault.getAbstractFileByPath(key);
  if (target instanceof TFile) return [target];
  if (!(target instanceof TFolder)) return [];

  const files: TFile[] = [];
  Vault.recurseChildren(target, (item) => {
    if (item instanceof TFile) files.push(item);
  });
  return files;
}

/** The markdown file at exactly this vault path, if there is one. */
function markdownFileAt(app: App, path: string): TFile | undefined {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile && file.extension === "md" ? file : undefined;
}

/**
 * Which of two files `Vault.getFiles()` lists first, worked out from where they
 * sit instead of by listing the vault. That walk pushes a folder's children in
 * order and pops them from the END, so where the two paths part ways, the one
 * further down that folder's children comes first.
 *
 * Only a tie in loadTasks' sort can see this order: `localeCompare` returns 0
 * for distinct paths that differ by an invisible character (a zero-width
 * space, a soft hyphen, an emoji's variation selector), and the stable sort
 * then keeps the order the files were read in.
 */
function compareVaultOrder(a: TAbstractFile, b: TAbstractFile): number {
  const lineage = (file: TAbstractFile) => {
    const chain: TAbstractFile[] = [];
    for (let at: TAbstractFile | null = file; at; at = at.parent) chain.unshift(at);
    return chain;
  };
  const left = lineage(a);
  const right = lineage(b);

  let split = 0;
  while (split < left.length && split < right.length && left[split] === right[split]) split++;
  const folder = left[split - 1];
  if (split === left.length || split === right.length || !(folder instanceof TFolder)) return 0;

  return folder.children.indexOf(right[split]) - folder.children.indexOf(left[split]);
}

/**
 * The named notes that exist and are markdown, each once, in the order
 * `Vault.getFiles()` would have listed them. Looked up by path, one at a time.
 */
function markdownNotesAt(app: App, paths: string[]): TFile[] {
  const found: TFile[] = [];
  for (const path of new Set(paths)) {
    const file = markdownFileAt(app, path);
    if (file) found.push(file);
  }
  return found.sort(compareVaultOrder);
}

/** The text of the task line carrying this 🆔 (after the checkbox), or null. */
export function findTaskTextByIdInContent(content: string, taskId: string): string | null {
  if (!taskId) return null;

  const lines = content.split("\n");
  for (const line of lines) {
    const lineMatch = line.match(TASK_LINE_REGEX);
    if (!lineMatch) continue;

    const idMatch = line.match(TASK_ID_REGEX);
    if (!idMatch || idMatch[1] !== taskId) continue;

    return lineMatch[2];
  }

  return null;
}

export async function findTaskTextById(
  app: App,
  filePath: string,
  taskId: string
): Promise<string | null> {
  if (!filePath || !taskId) return null;

  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return null;

  const content = await app.vault.read(file);
  return findTaskTextByIdInContent(content, taskId);
}

/** A task line's name: what the picker links it by, and what is logged for it. */
export function taskLineName(text: string): string {
  return normalizeTaskText(text) || "Untitled Task";
}

/**
 * The name a task with a 🆔 goes by once its line reads `text`: the line's
 * name, unless all that changed since `previous` is the 🍅 counter's count —
 * then `previous`, kept as it is.
 *
 * A 🆔 task's name is read again from its line when its note changes, when a
 * session's log line is written, and by "Refresh log task names by ID", so
 * that a rename reaches the daily log. The count is on that line too, and up
 * to 0.6.8 each count was taken for a rename: every session renamed the task
 * and rewrote every log line it ever had to the new number. A task with no 🆔
 * keeps the name it was linked by (0.6.9); this is the same rule.
 *
 * Decided on the LINE, where the Tasks fields still mark the counter's place
 * (`removeAnyPomodoroMarker` takes only the counter's marker off it): the line
 * is put back with `previous`'s count in that place, and if it then reads as
 * `previous`, only the count changed. So a `🍅 2` typed into the description
 * is text, and changing it is a rename. `previous` is a name, whose fields are
 * gone, so which of its `🍅 N` was the count cannot be told — and the counter
 * test reads text after the fields as typed — so each one is tried, and all
 * of them as one run (the counter folds a line's counter markers into one),
 * each in this version's place and in 0.5.1–0.6.8's; one that puts the line
 * back exactly is a count. Spacing is ignored only when a count
 * is involved, since putting one back respaces the line; with none on either
 * side, any change is a rename, as it always was.
 */
export function taskNameAfterEdit(previous: string, text: string): string {
  const name = taskLineName(text);
  const uncounted = removeAnyPomodoroMarker(text);
  const counts = pomodoroMarkers(previous).map((match) => `🍅 ${parseInt(match[1], 10)}`);
  if (name === previous || (uncounted === text && counts.length === 0)) return name;

  // Each of previous's `🍅 N`, and all of them together — the counter folds a
  // line's counter markers into one, so two of them can become one count —
  // each where this version writes the count and where 0.5.1–0.6.8 wrote it
  // (they put it after an ⌛ 📆 or 🗓, which the name keeps).
  const runs = counts.length > 1 ? [...counts, counts.join(" ")] : counts;
  const before = [
    uncounted,
    ...runs.flatMap((run) => [
      placeMarkerText(uncounted, run, TASKS_METADATA_TOKEN_REGEX),
      placeMarkerText(uncounted, run, LEGACY_FIELD_EMOJI_REGEX),
    ]),
  ];
  return before.some((line) => sameWords(taskLineName(line), previous)) ? previous : name;
}

function sameWords(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

export async function loadTasks(app: App, options: TaskLoadOptions): Promise<TaskItem[]> {
  const { scope, limitDays = 3, includeUndated = false, pin = null } = options;
  const tasks: TaskItem[] = [];

  // Only what the scope names is listed. An EMPTY tasks path is the one case
  // that lists the whole vault, because that is what it means: it is the
  // documented way to have the picker look everywhere.
  const inScope =
    scope.kind === "notes"
      ? markdownNotesAt(app, scope.paths)
      : (scope.tasksPath ? filesInFolder(app, scope.tasksPath) : app.vault.getFiles()).filter(
          (f) => f.extension === "md"
        );

  // The pin's own note is read even when the scope excludes it — but ONLY the
  // pinned line is taken from it, or choosing "Current note" would quietly drag
  // in every other task from wherever the linked one happens to live.
  const files = [...inScope];
  const pinFile =
    pin && !inScope.some((f) => f.path === pin.path) ? markdownFileAt(app, pin.path) : undefined;
  if (pinFile) files.push(pinFile);
  const pinKey = pin ? taskLineKey(pin.lineText) : null;

  const limitDate = moment().add(limitDays, "days").endOf("day");

  for (const file of files) {
    const pinOnly = file === pinFile;
    const content = await app.vault.cachedRead(file);
    const lines = content.split("\n");

    for (const line of lines) {
      const match = line.match(TASK_LINE_REGEX);
      if (!match || match[1] !== " ") continue;

      const originalText = match[2];
      const scheduledMatch = originalText.match(SCHEDULED_REGEX);
      const dueMatch = originalText.match(DUE_REGEX);

      const scheduled = scheduledMatch ? scheduledMatch[1] : null;
      const due = dueMatch ? dueMatch[1] : null;

      const effectiveDateStr = scheduled || due;
      const cleanText = taskLineName(originalText);
      const taskId = originalText.match(TASK_ID_REGEX)?.[1];
      // A 🆔 task by its ID: another task whose text differs only by fields
      // (or matches it outright) is another task.
      const isPin =
        pin !== null &&
        file.path === pin.path &&
        (pin.taskId ? taskId === pin.taskId : taskLineKey(originalText) === pinKey);

      if (pinOnly && !isPin) continue;

      // What the scope alone would have done with this line. BOTH halves
      // matter: the file may be out of scope entirely (pinOnly), and a file
      // that is in scope may still filter the line out by date. Reading only
      // the date half leaves a linked task from another note unflagged
      // whenever it happens to fall inside the window — which is most of them.
      const passesFilters =
        !pinOnly &&
        (effectiveDateStr ? moment(effectiveDateStr).isSameOrBefore(limitDate) : includeUndated);
      if (!passesFilters && !isPin) continue;

      const displayText = normalizeTaskTextForDisplay(originalText);

      tasks.push({
        text: originalText,
        cleanText,
        displayText: displayText || cleanText,
        status: "todo",
        path: file.path,
        scheduled,
        due,
        effectiveDateStr,
        taskId,
        pinned: isPin && !passesFilters,
      });
    }
  }

  tasks.sort((a, b) => {
    // Undated tasks sort last as a block, which is what lets groupTasksByDate
    // close the list with a single trailing "No date" group without a special
    // case of its own.
    if (a.effectiveDateStr === null || b.effectiveDateStr === null) {
      if (a.effectiveDateStr !== b.effectiveDateStr) return a.effectiveDateStr === null ? 1 : -1;
    } else if (a.effectiveDateStr !== b.effectiveDateStr) {
      return a.effectiveDateStr.localeCompare(b.effectiveDateStr);
    }
    return a.path.localeCompare(b.path);
  });

  return tasks;
}

export function groupTasksByDate(tasks: TaskItem[]): TaskGroup[] {
  const today = moment().startOf("day");
  const groups: TaskGroup[] = [];
  let currentLabel = "";
  let currentItems: TaskItem[] = [];

  const pushGroup = () => {
    if (!currentLabel || currentItems.length === 0) return;
    groups.push({ label: currentLabel, items: currentItems });
    currentItems = [];
  };

  // The linked task first, and only when the scope would otherwise have hidden
  // it. Its own heading rather than a row inside "Overdue": it is there because
  // it is linked, not because of its date, and saying so is the whole point —
  // the picker must never read as though switching scope dropped the link.
  const pinned = tasks.filter((t) => t.pinned);
  if (pinned.length > 0) groups.push({ label: "Linked task", items: pinned });

  for (const task of tasks) {
    if (task.pinned) continue;
    let label = "";

    if (task.effectiveDateStr === null) {
      // Never build a moment from this: `moment(undefined)` is NOW, so reading
      // a missing date through the branch below would file every undated task
      // under "Today".
      label = "No date";
    } else {
      const dateObj = moment(task.effectiveDateStr);
      if (dateObj.isBefore(today)) {
        label = "Overdue";
      } else if (dateObj.isSame(today, "day")) {
        label = "Today";
      } else if (dateObj.isSame(moment().add(1, "day"), "day")) {
        label = "Tomorrow";
      } else {
        label = dateObj.format("dddd, MMM D");
      }
    }

    if (label !== currentLabel) {
      pushGroup();
      currentLabel = label;
    }
    currentItems.push(task);
  }

  pushGroup();
  return groups;
}
