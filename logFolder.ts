import { TFile, TFolder, normalizePath, type App } from "obsidian";
import { filesInFolder } from "./taskLoader";
import { LOG_FILE_SUFFIX, dailyLogFileName } from "./logLine";

/**
 * The "Pomodoro logs folder" setting, checked as it is typed (0.6.9, F37, F61).
 * Until then it was stored as typed, and three ordinary entries split the
 * history without a word:
 *
 * - A space at either end. normalizePath trims slashes, not spaces, so
 *   " Pomodoro_logs" was a second folder on macOS, and on Windows a trailing
 *   space failed every write.
 * - "/", the vault's top level: the lines were written there, but Refresh,
 *   renames and Check list a folder's files, and the top level is none.
 * - Another capitalisation of an existing folder. macOS, iOS and Windows find
 *   files ignoring case; Obsidian's index does not. "pomodoro_logs" beside a
 *   real "Pomodoro_logs" wrote every line into the real folder, while today's
 *   total, Refresh and renames looked for the typed one and found nothing.
 */
export type LogFolderInput =
  /** Store `value`; `adopted` is set when it is an existing folder's own
   *  spelling rather than what was typed. */
  | { kind: "ok"; value: string; adopted: string | null }
  /** Not stored: the vault's top level. */
  | { kind: "root" };

/** The part of the vault the check reads. */
export type FolderLookup = Pick<App["vault"], "getRoot" | "getAbstractFileByPath">;

/** What a typed value means — see LogFolderInput. Empty is allowed: no log is kept. */
export function resolveLogFolderInput(input: string, vault: FolderLookup): LogFolderInput {
  const value = input.trim();
  if (value === "") return { kind: "ok", value: "", adopted: null };
  const path = normalizePath(value);
  if (path === "/") return { kind: "root" };
  if (vault.getAbstractFileByPath(path) instanceof TFolder) {
    return { kind: "ok", value, adopted: null };
  }
  const real = folderIgnoringCase(vault.getRoot(), path);
  if (real !== null && real.path !== path)
    return { kind: "ok", value: real.path, adopted: real.path };
  return { kind: "ok", value, adopted: null };
}

/**
 * The folder at `path` with case ignored, walked one level at a time from the
 * root — the folders on the way, never the whole vault (0.6.8). At each level
 * an exact name is tried before another capitalisation, which matters only
 * where the file system tells them apart.
 */
export function folderIgnoringCase(root: TFolder, path: string): TFolder | null {
  const names = path.split("/");
  const nameOf = (folder: TFolder) => folder.path.slice(folder.path.lastIndexOf("/") + 1);
  const walk = (at: TFolder, depth: number): TFolder | null => {
    if (depth === names.length) return at;
    const name = names[depth];
    const folders = at.children.filter((child): child is TFolder => child instanceof TFolder);
    const exact = folders.filter((folder) => nameOf(folder) === name);
    const other = folders.filter(
      (folder) => nameOf(folder) !== name && nameOf(folder).toLowerCase() === name.toLowerCase()
    );
    for (const next of [...exact, ...other]) {
      const found = walk(next, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(root, 0);
}

/**
 * What is wrong with a STORED folder (F29): the two entries above that the
 * box refuses or corrects as they are typed, but that a value saved before
 * 0.6.9 (or by hand in data.json) can still hold. The timer writes to both —
 * at the top level, or through the disk into the folder of the other spelling
 * — while the log's commands list the folder the setting names and find
 * nothing there. A folder that exists as stored is never one, spaces and all.
 */
export type LogFolderProblem = { kind: "root" } | { kind: "case"; real: string };

export function logFolderProblem(stored: string, vault: FolderLookup): LogFolderProblem | null {
  const result = resolveLogFolderInput(stored, vault);
  if (result.kind === "root") return { kind: "root" };
  if (result.adopted === null) return null;
  // Spaces kept, as the timer writes it (a stored value is not trimmed).
  if (vault.getAbstractFileByPath(normalizePath(stored)) instanceof TFolder) return null;
  return { kind: "case", real: result.adopted };
}

/** Under the folder row when the tab opens on a stored problem. */
export function logFolderProblemNote(problem: LogFolderProblem): string {
  return problem.kind === "root"
    ? "This is the vault's top level. Logs are written there, but Check log, Convert and Refresh can't list them. Pick a folder inside the vault."
    : `The vault spells this folder "${problem.real}". Type it that way: until then, today's total and the log's commands can't find these logs.`;
}

/** The log's commands, when the folder they would list is a stored problem. */
export function logFolderProblemNotice(stored: string, problem: LogFolderProblem): string {
  return problem.kind === "root"
    ? "Gentle pomodoro: the log folder is set to the vault's top level, whose files can't be listed. Choose a folder inside the vault under Daily log in the plugin's settings."
    : `Gentle pomodoro: the log folder is set to "${stored.trim()}", but the vault spells it "${problem.real}". Type it that way under Daily log in the plugin's settings.`;
}

/** Two settings that name one folder; empty names none. */
export function sameLogFolder(a: string, b: string): boolean {
  const key = (value: string) => (value.trim() === "" ? "" : normalizePath(value.trim()));
  return key(a) === key(b);
}

/**
 * The path of the daily log for `date` (a logicalDate) in the folder the
 * setting names. The one place it is put together, for the timer's writes,
 * today's total, Open today's log and the session dialog alike.
 */
export function dailyLogPath(folder: string, date: string): string {
  return normalizePath(`${normalizePath(folder)}/${dailyLogFileName(date)}`);
}

/**
 * The daily log files in `folder`, as the log's commands list them: one
 * folder walked (filesInFolder), and only files named like a daily log — a
 * note the user keeps there, an index or a dashboard quoting a line, is not
 * one. Check log, Convert and the notice after upgrading (logFormatNotice.ts)
 * all read this list, so the notice speaks of exactly the files Convert would.
 */
export function dailyLogFiles(app: App, folder: string): TFile[] {
  return filesInFolder(app, folder).filter(
    (f) => f.extension === "md" && f.path.endsWith(LOG_FILE_SUFFIX)
  );
}

/** A stored folder that means the vault's top level (F29). */
const isTopLevel = (folder: string) => normalizePath(folder.trim()) === "/";

/** Whether `folder` holds a daily log file, so moving away from it leaves some behind. */
export function holdsLogs(app: App, folder: string): boolean {
  if (folder.trim() === "") return false;
  // The top level is no folder filesInFolder lists, yet a "/" stored before
  // 0.6.9 wrote its logs there, straight into it (F29).
  const files = isTopLevel(folder)
    ? app.vault.getRoot().children.filter((item): item is TFile => item instanceof TFile)
    : filesInFolder(app, folder.trim());
  return files.some((file) => file.path.endsWith(LOG_FILE_SUFFIX));
}

export const LOG_FOLDER_NAME = "Pomodoro logs folder";
export const LOG_FOLDER_DESC =
  "Folder for the daily log files. Leave it empty to keep no log; the daily goal then counts only the session that is running.";

/**
 * "/" typed, and refused: says what stays in effect, which is not always the
 * folder the tab opened on — each keystroke saves, so an emptied box has
 * already turned the log off (F32).
 */
export function logFolderRootMessage(stored: string): string {
  const inEffect =
    stored.trim() === ""
      ? "no log is kept"
      : isTopLevel(stored)
        ? "logs still go to the vault's top level"
        : `logs still go to "${stored.trim()}"`;
  return `Pick a folder inside the vault, not its top level. Not saved — ${inEffect}.`;
}

export function logFolderAdoptedMessage(path: string): string {
  return `Using the existing folder "${path}".`;
}

/** Shown once the folder changes away from one that holds logs — nothing moves them (F61). */
export function logFolderLeftMessage(oldFolder: string): string {
  const where = isTopLevel(oldFolder) ? "at the vault's top level" : `in "${oldFolder.trim()}"`;
  return `Logs already ${where} stay there. Move them yourself if you want them in the new folder.`;
}
