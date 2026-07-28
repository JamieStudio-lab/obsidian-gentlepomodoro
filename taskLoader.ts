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

const TASK_REGEX = /^\s*-\s*\[ \]\s+(.*)$/;
const TASK_LINE_REGEX = /^\s*-\s*\[( |x)\]\s+(.*)$/i;
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
  let next = 1;
  let stripped = line;
  if (match && match.index !== undefined) {
    next = parseInt(match[1], 10) + 1;
    stripped = line.slice(0, match.index).trimEnd() + line.slice(match.index + match[0].length);
  }

  const marker = `🍅 ${next}`;

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
      const match = line.match(TASK_REGEX);
      if (!match) continue;

      const originalText = match[1];
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
