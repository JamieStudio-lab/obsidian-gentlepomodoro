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
