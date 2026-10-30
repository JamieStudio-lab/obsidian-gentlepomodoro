/**
 * The settings tab's pages (0.7.0). On Obsidian 1.13+ the tab's top level is
 * a short list of these, each opening a page that holds the groups it names;
 * Obsidian 1.7–1.12 has no pages, and shows the same groups one after another
 * as before. The names, the one-line descriptions under them and the value
 * shown on the right of each row live here; GentlePomoSettingTab.ts says which
 * groups each page holds.
 *
 * Pure: settings in, text out. A value is worked out each time the list is
 * drawn (Obsidian reads the definitions once, at load, so a fixed string would
 * show the value the plugin loaded with), and it must never throw: Obsidian
 * calls it without a try, and a throw would take the whole list down.
 */

import { THEMES, resolveTheme } from "./themes";
import { cueLabel } from "./timerCues";
import { TASK_SOURCE_LABELS, resolveTaskSource } from "./taskScope";
import { QUERY_RANGES, resolveQueryColumns, resolveQueryRange } from "./logQueries";
import { validateMusicUrl } from "./youtubeMusic";
import type { GentlePomoSettings } from "./types";

export const TIMER_PAGE = "Timer";
export const STATUS_BAR_PAGE = "Status bar";
/** "Sounds" on a phone or tablet, which has no Notifications group. */
export const SOUNDS_PAGE = "Sounds and notifications";
export const SOUNDS_PAGE_MOBILE = "Sounds";
export const MUSIC_PAGE = "Music";
export const LOG_PAGE = "Daily log";
/** The page and its group share the name: "what tables of the log". */
export const LOG_TABLES_PAGE = "Log tables";
export const TASKS_PAGE = "Tasks";

export const TIMER_PAGE_DESC = "Theme, long breaks, the daily goal, opening at startup.";
export const STATUS_BAR_PAGE_DESC = "What the status bar at the bottom of the window shows.";
export const SOUNDS_PAGE_DESC = "What plays, and what starts, when a session ends.";
export const MUSIC_PAGE_DESC = "Up to three links, and how they play.";
export const LOG_PAGE_DESC = "Where sessions are written, and tools to check, fix and export them.";
export const LOG_TABLES_PAGE_DESC =
  "Code for the Dataview plugin that shows your sessions as a table in any note.";
export const TASKS_PAGE_DESC = "Where the task picker looks, and the 🍅 count on tasks.";

const MUSIC_URL_KEYS = ["musicUrl", "musicUrl2", "musicUrl3"] as const;

type PageSettings = Pick<
  GentlePomoSettings,
  | "theme"
  | "showInStatusBar"
  | "soundEnabled"
  | "focusEndSound"
  | "breakEndSound"
  | "showMusicPlayer"
  | "musicUrl"
  | "musicUrl2"
  | "musicUrl3"
  | "logFolderPath"
  | "queryColumns"
  | "queryRange"
  | "showTaskSelector"
  | "taskSource"
>;

/** The theme: the one choice on the page that changes how the timer looks. */
export function timerPageValue(s: PageSettings): string {
  return THEMES[resolveTheme(s.theme)];
}

/** "On" or "Off": the page's first switch. */
export function statusBarPageValue(s: PageSettings): string {
  return s.showInStatusBar === true ? "On" : "Off";
}

/** The two end sounds, or that the timer is muted. */
export function soundsPageValue(s: PageSettings): string {
  if (s.soundEnabled === false) return "Timer sounds off";
  return `${cueLabel(s.focusEndSound, "focus")} · ${cueLabel(s.breakEndSound, "break")}`;
}

function filledMusicUrls(s: PageSettings): string[] {
  return MUSIC_URL_KEYS.map((key) => s[key]).filter(
    (url): url is string => typeof url === "string" && url.trim() !== ""
  );
}

/** How many links are set, or that the player is off. */
export function musicPageValue(s: PageSettings): string {
  if (s.showMusicPlayer === false) return "Off";
  const count = filledMusicUrls(s).length;
  if (count === 0) return "No link";
  return count === 1 ? "1 link" : `${String(count)} links`;
}

/**
 * A link that is not a YouTube link the player can load. Only the syntax:
 * whether YouTube has the video is asked on the page, and the answer is not
 * kept past the session.
 */
export function musicPageWarning(s: PageSettings): boolean {
  return filledMusicUrls(s).some((url) => validateMusicUrl(url) !== undefined);
}

/** The folder the log is written to, or that it is off. */
export function logPageValue(s: PageSettings): string {
  const folder = typeof s.logFolderPath === "string" ? s.logFolderPath.trim() : "";
  return folder === "" ? "Off" : folder;
}

/** How many columns the sessions table has, and which days the tables show. */
export function logTablesPageValue(s: PageSettings): string {
  const count = resolveQueryColumns(s.queryColumns).filter((c) => c.on).length;
  const range = resolveQueryRange(s.queryRange);
  const label = QUERY_RANGES.find((r) => r.value === range)?.label ?? "";
  return `${String(count)} ${count === 1 ? "column" : "columns"} · ${label}`;
}

/** Where the picker looks, or that it is off. */
export function tasksPageValue(s: PageSettings): string {
  if (s.showTaskSelector === false) return "Picker off";
  return TASK_SOURCE_LABELS[resolveTaskSource(s.taskSource)];
}

/** A value, or "" when working it out throws: Obsidian calls it without a try. */
export function safePageValue(value: () => string): string {
  try {
    const text = value();
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

/** "warning" while `warning` holds; null when it does not, or throws. */
export function safePageStatus(warning: () => boolean): "warning" | null {
  try {
    return warning() === true ? "warning" : null;
  } catch {
    return null;
  }
}
