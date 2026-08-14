import { TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";
import type { TaskItem } from "./types";
import type { MomentFactory } from "./momentTypes";

declare const moment: MomentFactory;

export interface TaskGroup {
  label: string;
  items: TaskItem[];
}

export interface TaskLoadOptions {
  tasksPath: string;
  limitDays?: number; // default 3
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
// Pomodoro count marker. The optional `(...)` group tolerates the legacy
// 0.1.0 today-only format (`🍅 N (YYYY-MM-DD)`) so existing markers are still
// readable — the parens (and any content) get stripped on the next write.
const POMO_MARKER_REGEX = /🍅\s*(\d+)(?:\s*\([^)]*\))?/;
// First Tasks-plugin metadata token on a line (dates, priorities, recurrence,
// ID, plus the Tasks 8.x field emojis this plugin doesn't otherwise read:
// ❌ cancelled, ⛔ depends-on, 🏁 on-completion). The 🍅 marker must be
// inserted BEFORE the first of these: the Tasks plugin only recognizes its
// emoji fields at the end of the line, so any text placed after them silently
// demotes every field to plain description text (GitHub issue #2).
const TASKS_METADATA_TOKEN_REGEX = /[⏳📅🛫➕✅❌⛔🏁🔺🔽🔥⏫⏬🔼🔁🆔]/u;
// Trailing Obsidian block reference (`^block-id`) — must stay at the very end.
const BLOCK_ID_REGEX = /\s+\^[A-Za-z0-9-]+\s*$/;
// Everything that may legitimately follow a plugin-written 🍅 marker: the end
// of the line, a Tasks metadata token, or a trailing block reference. Used to
// tell plugin-written markers (removable) from a `🍅 N` the user typed
// mid-description (kept — ordinary text after the marker rules the plugin out).
const MARKER_TAIL_REGEX = /^\s*(?:$|[⏳📅🛫➕✅❌⛔🏁🔺🔽🔥⏫⏬🔼🔁🆔]|\^[A-Za-z0-9-]+\s*$)/u;
const PRIORITY_REGEX = /[🔺🔽🔥⏫⏬🔼]\uFE0F?/gu;
const VARIATION_SELECTOR_REGEX = /\uFE0F/gu;

// Dates + priorities + recurrence + ID (for canonical task matching)
const CLEANUP_REGEX =
  /[⏳📅🛫➕✅]\s*\d{4}-\d{2}-\d{2}|[🔺🔽🔥⏫⏬🔼]\uFE0F?\s*\w*|🔁\s*[a-zA-Z0-9\s]+|🆔\s*[A-Za-z0-9_-]+/gu;

// Dates + recurrence + ID + tags (for display, keep priority icons only)
const DISPLAY_CLEANUP_REGEX =
  /[⏳📅🛫➕✅]\s*\d{4}-\d{2}-\d{2}|🔁\s*[a-zA-Z0-9\s]+|🆔\s*[A-Za-z0-9_-]+|#\S+/gu;

// shared normalization for task text
export function normalizeTaskText(text: string): string {
  return text.replace(CLEANUP_REGEX, "").trim();
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
 * Read the lifetime pomodoro count from a task line. Tolerates the legacy
 * `🍅 N (YYYY-MM-DD)` format from 0.1.0 — the date is ignored, N is returned.
 */
export function parsePomodoroCount(line: string): number {
  const match = line.match(POMO_MARKER_REGEX);
  if (!match) return 0;
  return parseInt(match[1], 10);
}

/**
 * Returns the line with the lifetime pomodoro count incremented by 1.
 *
 * The marker is written at the end of the task *description* — before the
 * first Tasks-plugin metadata token (⏳ 📅 🆔 priority …) — never after the
 * fields: the Tasks plugin only parses its emoji fields off the end of the
 * line, so a trailing marker turns every field into plain description text
 * and the task's dates vanish from queries and Edit Task (GitHub issue #2).
 *
 * - If marker exists (with or without legacy parens): increment N and
 *   re-insert at the correct position — lines written by ≤0.5.0 (marker
 *   trailing the fields) heal on their next increment. Legacy parens are
 *   stripped on write, so `🍅 N (date)` markers migrate to plain `🍅 N`.
 * - If no marker: insert ` 🍅 1` before the first metadata token, keeping a
 *   trailing block reference (`^block-id`) at the very end of the line.
 */
export function incrementPomodoroCount(line: string): string {
  const match = line.match(POMO_MARKER_REGEX);
  if (match && match.index !== undefined) {
    const next = parseInt(match[1], 10) + 1;
    return placePomodoroMarker(removePomodoroMarker(line, match), next);
  }
  return placePomodoroMarker(line, 1);
}

/** Remove a matched 🍅 marker from the line, collapsing the space it leaves. */
function removePomodoroMarker(line: string, match: RegExpMatchArray): string {
  const index = match.index ?? 0;
  return line.slice(0, index).trimEnd() + line.slice(index + match[0].length);
}

/** Insert `🍅 count` at the canonical position in a marker-free line. */
function placePomodoroMarker(stripped: string, count: number): string {
  const marker = `🍅 ${count}`;

  const metaMatch = stripped.match(TASKS_METADATA_TOKEN_REGEX);
  if (metaMatch && metaMatch.index !== undefined) {
    const head = stripped.slice(0, metaMatch.index).trimEnd();
    return `${head} ${marker} ${stripped.slice(metaMatch.index)}`;
  }

  const blockMatch = stripped.match(BLOCK_ID_REGEX);
  if (blockMatch && blockMatch.index !== undefined) {
    const head = stripped.slice(0, blockMatch.index).trimEnd();
    return `${head} ${marker}${stripped.slice(blockMatch.index)}`;
  }

  return `${stripped.trimEnd()} ${marker}`;
}

/**
 * Locate a 🍅 marker in a *harmful* position — after the first Tasks metadata
 * token (the ≤0.5.0 append bug, which hides every field from the Tasks
 * plugin) or after a trailing `^block-id` (which breaks the block reference).
 *
 * Deliberately conservative: a marker that is merely unusual but harmless
 * (e.g. `🍅 2` mid-description on a line with no Tasks fields) does not
 * count, nor does a line without a marker — both return null.
 */
function findMisplacedPomodoroMarker(line: string): { count: number; stripped: string } | null {
  const match = line.match(POMO_MARKER_REGEX);
  if (!match || match.index === undefined) return null;

  const meta = line.match(TASKS_METADATA_TOKEN_REGEX);
  const afterFields = meta?.index !== undefined && match.index > meta.index;

  const stripped = removePomodoroMarker(line, match);
  let afterBlockRef = false;
  if (!afterFields) {
    const block = stripped.match(BLOCK_ID_REGEX);
    if (block?.index !== undefined) {
      const token = block[0].trim();
      afterBlockRef = match.index > line.lastIndexOf(token);
    }
  }

  if (!afterFields && !afterBlockRef) return null;
  return { count: parseInt(match[1], 10), stripped };
}

/**
 * Repair a task line whose 🍅 marker is misplaced (see
 * {@link findMisplacedPomodoroMarker}): re-insert it at the canonical
 * position. The count is preserved; anything else is left byte-for-byte
 * untouched.
 */
export function repairPomodoroMarkerPlacement(line: string): string {
  const misplaced = findMisplacedPomodoroMarker(line);
  if (!misplaced) return line;
  return placePomodoroMarker(misplaced.stripped, misplaced.count);
}

/**
 * Delete a misplaced 🍅 marker outright instead of relocating it. Because the
 * ≤0.5.0 bug only ever *appended* the marker, removal restores the line to
 * exactly its pre-bug form (the lifetime count is lost). Correctly placed or
 * harmless markers and marker-less lines are left byte-for-byte untouched.
 */
export function removeMisplacedPomodoroMarker(line: string): string {
  const misplaced = findMisplacedPomodoroMarker(line);
  if (!misplaced) return line;
  return misplaced.stripped;
}

/**
 * Delete a 🍅 marker whether it is correctly placed or misplaced — the
 * "uninstall" for the counter's data. Only markers in a position the plugin
 * itself writes (followed by nothing but Tasks fields, a block reference, or
 * the end of the line — see MARKER_TAIL_REGEX) are removed; a `🍅 N` the
 * user typed mid-description is left byte-for-byte untouched.
 */
export function removeAnyPomodoroMarker(line: string): string {
  const match = line.match(POMO_MARKER_REGEX);
  if (!match || match.index === undefined) return line;
  if (!MARKER_TAIL_REGEX.test(line.slice(match.index + match[0].length))) return line;
  return removePomodoroMarker(line, match);
}

export interface PomodoroMarkerContentResult {
  content: string;
  linesChanged: number;
}

/** Apply a line transform to every task line (open or completed) in a note. */
function transformTaskLines(
  content: string,
  transform: (line: string) => string
): PomodoroMarkerContentResult {
  const lines = content.split("\n");
  let linesChanged = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!TASK_LINE_REGEX.test(lines[i])) continue;
    const next = transform(lines[i]);
    if (next !== lines[i]) {
      lines[i] = next;
      linesChanged++;
    }
  }

  return { content: lines.join("\n"), linesChanged };
}

/** Run {@link repairPomodoroMarkerPlacement} over every task line. */
export function repairPomodoroMarkersInContent(content: string): PomodoroMarkerContentResult {
  return transformTaskLines(content, repairPomodoroMarkerPlacement);
}

/** Run {@link removeMisplacedPomodoroMarker} over every task line. */
export function removeMisplacedPomodoroMarkersInContent(
  content: string
): PomodoroMarkerContentResult {
  return transformTaskLines(content, removeMisplacedPomodoroMarker);
}

/** Run {@link removeAnyPomodoroMarker} over every task line. */
export function removeAllPomodoroMarkersInContent(content: string): PomodoroMarkerContentResult {
  return transformTaskLines(content, removeAnyPomodoroMarker);
}

export interface PomodoroMarkerVaultResult {
  filesScanned: number;
  filesAffected: number;
  linesAffected: number;
  /** Per-file breakdown, for logging so users can inspect before acting. */
  affected: { path: string; lines: number }[];
}

/**
 * Walk the tasks folder (whole vault when the path is empty — same scope the
 * task picker scans) applying a marker transform. With `write: false` this is
 * a pure dry run. With `write: true`, files that need no change are never
 * written; changed files are rewritten atomically via `Vault.process`.
 */
async function processPomodoroMarkersInVault(
  app: App,
  tasksPath: string,
  transform: (line: string) => string,
  write: boolean
): Promise<PomodoroMarkerVaultResult> {
  const files = app.vault
    .getFiles()
    .filter((f) => isPathInFolder(f.path, tasksPath) && f.extension === "md");

  let filesAffected = 0;
  let linesAffected = 0;
  const affected: { path: string; lines: number }[] = [];

  for (const file of files) {
    const content = await app.vault.cachedRead(file);
    if (!content.includes("🍅")) continue;
    const probe = transformTaskLines(content, transform);
    if (probe.linesChanged === 0) continue;

    if (write) {
      await app.vault.process(file, (data) => transformTaskLines(data, transform).content);
    }
    filesAffected++;
    linesAffected += probe.linesChanged;
    affected.push({ path: file.path, lines: probe.linesChanged });
  }

  return { filesScanned: files.length, filesAffected, linesAffected, affected };
}

/** Dry run: count misplaced 🍅 markers without changing any file. */
export function scanMisplacedPomodoroMarkersInVault(
  app: App,
  tasksPath: string
): Promise<PomodoroMarkerVaultResult> {
  return processPomodoroMarkersInVault(app, tasksPath, repairPomodoroMarkerPlacement, false);
}

/** Relocate misplaced 🍅 markers in front of the Tasks fields (counts kept). */
export function repairPomodoroMarkersInVault(
  app: App,
  tasksPath: string
): Promise<PomodoroMarkerVaultResult> {
  return processPomodoroMarkersInVault(app, tasksPath, repairPomodoroMarkerPlacement, true);
}

/** Delete misplaced 🍅 markers, restoring affected lines to their pre-bug form. */
export function removeMisplacedPomodoroMarkersInVault(
  app: App,
  tasksPath: string
): Promise<PomodoroMarkerVaultResult> {
  return processPomodoroMarkersInVault(app, tasksPath, removeMisplacedPomodoroMarker, true);
}

/** Dry run: count every plugin-written 🍅 marker without changing any file. */
export function scanAllPomodoroMarkersInVault(
  app: App,
  tasksPath: string
): Promise<PomodoroMarkerVaultResult> {
  return processPomodoroMarkersInVault(app, tasksPath, removeAnyPomodoroMarker, false);
}

/** Delete every plugin-written 🍅 marker, correctly placed or misplaced. */
export function removeAllPomodoroMarkersInVault(
  app: App,
  tasksPath: string
): Promise<PomodoroMarkerVaultResult> {
  return processPomodoroMarkersInVault(app, tasksPath, removeAnyPomodoroMarker, true);
}

export function isPathInFolder(filePath: string, folderPath: string): boolean {
  if (!folderPath) return true;

  const normalizedFolder = normalizePath(folderPath).replace(/\/+$/, "");
  const normalizedPath = normalizePath(filePath);

  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}

export function findTaskNameByIdInContent(content: string, taskId: string): string | null {
  if (!taskId) return null;

  const lines = content.split("\n");
  for (const line of lines) {
    const lineMatch = line.match(TASK_LINE_REGEX);
    if (!lineMatch) continue;

    const idMatch = line.match(TASK_ID_REGEX);
    if (!idMatch || idMatch[1] !== taskId) continue;

    const cleanText = normalizeTaskText(lineMatch[2]);
    return cleanText || "Untitled Task";
  }

  return null;
}

export async function findTaskNameById(
  app: App,
  filePath: string,
  taskId: string
): Promise<string | null> {
  if (!filePath || !taskId) return null;

  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return null;

  const content = await app.vault.read(file);
  return findTaskNameByIdInContent(content, taskId);
}

export async function loadTasks(app: App, options: TaskLoadOptions): Promise<TaskItem[]> {
  const { tasksPath, limitDays = 3 } = options;
  const tasks: TaskItem[] = [];

  const files = app.vault
    .getFiles()
    .filter((f) => isPathInFolder(f.path, tasksPath) && f.extension === "md");

  const limitDate = moment().add(limitDays, "days").endOf("day");

  for (const file of files) {
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
      if (!effectiveDateStr) continue;

      const dateObj = moment(effectiveDateStr);
      if (!dateObj.isSameOrBefore(limitDate)) continue;

      const cleanText = normalizeTaskText(originalText);
      const displayText = normalizeTaskTextForDisplay(originalText);

      const idMatch = originalText.match(TASK_ID_REGEX);
      const taskId = idMatch ? idMatch[1] : undefined;

      tasks.push({
        text: originalText,
        cleanText: cleanText || "Untitled Task",
        displayText: displayText || cleanText || "Untitled Task",
        status: "todo",
        path: file.path,
        scheduled,
        due,
        effectiveDateStr,
        taskId,
      });
    }
  }

  tasks.sort((a, b) => {
    if (a.effectiveDateStr !== b.effectiveDateStr) {
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

  for (const task of tasks) {
    const dateObj = moment(task.effectiveDateStr);
    let label = "";

    if (dateObj.isBefore(today)) {
      label = "Overdue";
    } else if (dateObj.isSame(today, "day")) {
      label = "Today";
    } else if (dateObj.isSame(moment().add(1, "day"), "day")) {
      label = "Tomorrow";
    } else {
      label = dateObj.format("dddd, MMM D");
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
