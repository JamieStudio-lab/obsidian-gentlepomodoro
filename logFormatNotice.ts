/**
 * The one notice after upgrading to 0.6.9 (the maintainer's call). From
 * 0.6.9 the timer writes its log lines in a format Dataview can read, and the
 * lines written before stay in the old one until "Convert old log lines"
 * rewrites them — which nothing would tell an upgrading user. So once, and
 * only for a log that holds old lines, a Notice says where Convert is.
 *
 * Once per data.json, through `logFormatNoticePending` in it: loadSettings
 * sets it the one time it reads a data.json that has no such field, or none
 * at all (deriveLogFormatNotice), and the look clears it once it has had a
 * daily log file to read, old lines found or not. It only reads: nothing is
 * written to the log. A plugin unloaded while
 * it reads stops there, as LogManager does (F19): the reloaded one looks for
 * itself.
 */
import type { App } from "obsidian";
import { LOG_FORMAT_NOTICE_MS } from "./constants";
import { dailyLogFiles, logFolderProblem } from "./logFolder";
import { convertLogContent } from "./logConvert";
import { logger } from "./logger";
import type { GentlePomoSettings } from "./types";

/**
 * What the notice says. The names are the settings tab's own — the group
 * heading and the two buttons' rows (tests/logFormatNotice.test.ts holds them
 * together) — in the words the plugin's other notices use for the tab.
 */
export const LOG_FORMAT_NOTICE =
  'Gentle pomodoro: new log lines are written in a format Dataview can read, and your log still has lines in the old one. "Convert old log lines" under Daily log in the plugin\'s settings rewrites them; "Check log" there counts them first and changes nothing.';

/**
 * The flag's value for a data.json that has none, or undefined when it has
 * one (the caller writes only what this derived, like deriveStatusBarTime).
 * Read off the load, because DEFAULT_SETTINGS is the merge base for an
 * upgrading user too and would hide that the field was missing.
 *
 * Always true: look once. What the load was says nothing about the log, which
 * lives in the vault, not in the plugin's folder:
 *
 * - a data.json from before 0.6.9 ("ok" without the field): an upgrade.
 * - no data.json at all ("fresh"): a first install — or a reinstall, as
 *   uninstalling deletes the plugin's folder, data.json in it (app.js 1.13.7),
 *   and leaves the logs; or a damaged data.json deleted, as the plugin's own
 *   notice about it says to (settingsStore.ts). It was false here once, "a
 *   first install has no old lines", and those two never looked at a log
 *   full of them.
 * - a damaged data.json: whatever it held cannot be read. loadSettings saves
 *   nothing over it, but the run's first ordinary save — a setting changed,
 *   the long-break counter — writes the whole object, this flag with it, so
 *   false here was decided on disk by that save.
 *
 * True costs at most one look at a log that has no old lines — a true first
 * install's, once a folder is set; until then it waits (offerLogFormatNotice),
 * and so the look saves nothing over a damaged file either: that run's folder
 * is the default, which is none.
 */
export function deriveLogFormatNotice(
  loaded: { logFormatNoticePending?: unknown } | null
): boolean | undefined {
  if (loaded && loaded.logFormatNoticePending !== undefined) return undefined;
  return true;
}

/**
 * Whether a log file holds a session line in the old format (version 1,
 * `| Key:: value`) that Convert rewrites — counted as Check log counts them
 * (convertLogContent), the file's properties skipped as every reader of the
 * log skips them. An old line Convert leaves as it is ("inexact": a `]` in
 * its link's path, say) does not count: the notice says Convert rewrites
 * them, and Check log lists that one as a line it can't read, not as old.
 */
export function hasOldLogLine(content: string): boolean {
  return convertLogContent(content).counts.converted > 0;
}

/** What the look needs from the plugin. */
export interface LogFormatNoticeHost {
  app: App;
  /** A call, not a reference: loadSettings() replaces the object wholesale. */
  settings(): GentlePomoSettings;
  /** Persist the settings, the cleared flag with them. */
  save(): Promise<void>;
  notice(message: string, durationMs: number): void;
  /** Whether the plugin has been unloaded since: it then says, saves and reads no more. */
  unloaded(): boolean;
}

/** What happened, for the tests: the look skipped, put off, made, or cut short by an unload. */
export type LogFormatNoticeOutcome =
  | "not-pending"
  | "no-folder"
  | "no-logs"
  | "shown"
  | "none"
  | "unloaded";

/**
 * At layout-ready, never awaited by it: when the flag is pending and the log
 * has a folder the log's commands can list, look through its daily log files
 * for an old line, say so once if there is one, and clear the flag either way.
 *
 * With no such folder the flag stays pending, and nothing is read or written.
 * No folder set means no log is kept, so there is nothing to look at yet;
 * and a stored folder Check log and Convert cannot list (the vault's top
 * level, or another capitalisation of a real folder — logFolderProblem, F29)
 * has its files out of their reach too. Clearing the flag there would spend
 * the one notice on a folder Convert cannot read: once the user sets or
 * fixes the folder — perhaps to one full of old logs, a log turned off and
 * on again — the next start looks at it. While there is no such folder, a
 * start costs a lookup and no read. Convert stays in the settings beside the
 * folder row in any case.
 *
 * A folder with no daily log file in it leaves the flag pending too ("no-logs"),
 * for the same reason: data.json syncs, and the logs may not have reached this
 * device yet — still downloading, or a folder this device leaves out of its
 * sync. Its look would read nothing and spend the one notice another device,
 * the one with the old lines, needed. Until a log file is there, a start costs
 * a walk of the folder and no read.
 *
 * Unloaded while it reads — a disable and enable, an update — it stops: no
 * further read, no notice, no save, the flag left pending on disk. The
 * reloaded plugin reads that flag and looks for itself, so the old one's
 * notice would be the second; and its save would put its own settings object
 * — stale by then — over what the reloaded one has saved since (F19's shape,
 * which LogManager's writes guard against too).
 */
export async function offerLogFormatNotice(
  host: LogFormatNoticeHost
): Promise<LogFormatNoticeOutcome> {
  if (!host.settings().logFormatNoticePending) return "not-pending";
  const folder = host.settings().logFolderPath;
  if (folder.trim() === "" || logFolderProblem(folder, host.app.vault) !== null) {
    return "no-folder";
  }
  let found: boolean | null = false;
  try {
    found = await findOldLogLine(host, folder);
  } catch (e) {
    // Nothing here should throw; if it does, the look is over all the same,
    // or it would throw again at every start.
    logger.warn("Could not look for old log lines", e);
  }
  if (found === null) return "no-logs";
  // The last moment before anything is said or saved.
  if (host.unloaded()) return "unloaded";
  host.settings().logFormatNoticePending = false;
  if (found) host.notice(LOG_FORMAT_NOTICE, LOG_FORMAT_NOTICE_MS);
  await host.save();
  return found ? "shown" : "none";
}

/**
 * Whether any daily log in `folder` holds an old line — null when the folder
 * has no daily log file at all, before anything is read. The files Check log
 * and Convert list (dailyLogFiles), each through cachedRead, stopping at the
 * first old line.
 *
 * A file that cannot be read is passed over, and the look still ends — the
 * flag is cleared. A file unreadable now (offloaded to iCloud, held by a sync
 * client) may be unreadable at every start, and a flag left pending for it
 * would read the whole folder again at each one, for a notice that might
 * never come. One missed notice costs less: Check log reports a file it
 * cannot open, and Convert is in the settings.
 *
 * Stops, finding nothing, once the plugin is unloaded: what it would find is
 * no longer this plugin's to say (offerLogFormatNotice).
 */
async function findOldLogLine(host: LogFormatNoticeHost, folder: string): Promise<boolean | null> {
  const app = host.app;
  const files = dailyLogFiles(app, folder);
  if (files.length === 0) return null;
  for (const file of files) {
    if (host.unloaded()) return false;
    let content: string;
    try {
      content = await app.vault.cachedRead(file);
    } catch (e) {
      logger.warn(`Could not read "${file.path}" to look for old log lines`, e);
      continue;
    }
    if (hasOldLogLine(content)) return true;
  }
  return false;
}
