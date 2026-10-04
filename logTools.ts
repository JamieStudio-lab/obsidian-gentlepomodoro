/**
 * The daily log's own commands (0.6.9): Open today's log, Check log, Convert
 * old log lines, Add a session and Fix a logged session. The rules are pure
 * and live elsewhere — logConvert.ts decides what a line becomes and what
 * looks wrong, logEditor.ts what a session line says and where it goes —
 * this reads and writes the files, asks first, and says what happened.
 *
 * Every write to an existing log goes through Vault.process, which reads and
 * writes in one step, so a session the timer appends meanwhile is never lost.
 */
import { Notice, TFile, normalizePath, type App } from "obsidian";
import type { ConfirmOptions } from "./confirmModal";
import {
  LOG_CONVERSION_KINDS,
  addConversionCounts,
  asciiLogFileName,
  convertLogContent,
  countAnomalies,
  emptyConversionCounts,
  logLineCount,
  mergeLogContent,
  scanLogAnomalies,
  unmergeLogContent,
  type LogAnomaly,
  type LogAnomalyKind,
  type LogConversionCounts,
  type LogConversionKind,
  type UnconvertedLine,
} from "./logConvert";
import {
  describeLoggedLine,
  editedLine,
  formFromLine,
  insertSessionLine,
  loggedLines,
  newSessionForm,
  replaceSessionLine,
  sessionFromForm,
  type LoggedLine,
  type SessionForm,
} from "./logEditor";
import { dailyLogPath, logFolderProblem, logFolderProblemNotice } from "./logFolder";
import { LOG_FILE_SUFFIX, formatLogLine, logicalDate, type SessionLog } from "./logLine";
import { ensureLogFolder, type DuplicateTaskId } from "./logManager";
import { logger } from "./logger";
import type { MomentFactory } from "./momentTypes";
import {
  PickSessionModal,
  askSessionForm,
  type SessionFormAnswer,
  type SessionFormOptions,
  type SessionTaskChoice,
} from "./sessionModals";
import { filesInFolder, loadTasks } from "./taskLoader";
import { resolveTaskScope, resolveTaskSource } from "./taskScope";
import type { GentlePomoSettings } from "./types";

declare const moment: MomentFactory;

export const NO_LOG_FOLDER_NOTICE =
  "Gentle pomodoro: no log folder is set, so no log is kept. Choose one under Daily log in the plugin's settings.";
export const NO_LOG_TODAY_NOTICE = "Gentle pomodoro: no sessions logged today yet.";
export const NO_LOG_FILES_NOTICE = "Gentle pomodoro: no log files found.";
export const LINE_CHANGED_NOTICE =
  "Gentle pomodoro: that session's line changed after you opened it, so nothing was written. Open it again to fix it.";

/** What the log tools need from the plugin. */
export interface LogToolsHost {
  app: App;
  /** A call, not a reference: loadSettings() replaces the object wholesale. */
  settings(): GentlePomoSettings;
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** 🆔s the log names that are on task lines it cannot tell apart (Check log, F2). */
  duplicateTaskIds(): Promise<DuplicateTaskId[]>;
  /** A log file was written: today's total must be read again. */
  logChanged(): void;
  /** The session dialog (sessionModals.ts) — a seam, so the flow can be driven in a test. */
  askSessionForm?: (options: SessionFormOptions) => Promise<SessionFormAnswer>;
}

/** What Check log found, for its Notice. */
export interface LogCheckSummary {
  files: number;
  unreadableFiles: number;
  counts: LogConversionCounts;
  /** Files holding lines to convert. */
  convertFiles: number;
  /** Files named in another script's digits that can take the 0-9 name. */
  renames: number;
  /** Such files whose day has a 0-9 file already, to be merged into it (F4). */
  merges: number;
  /** The lines those files hold. */
  mergeLines: number;
  /** Such files whose 0-9 name something other than a file holds (a folder). */
  renamesBlocked: number;
  anomalies: Record<LogAnomalyKind, number>;
  duplicateIds: number;
}

const ANOMALY_PHRASES: Record<LogAnomalyKind, (n: number) => string> = {
  total: (n) => `${String(n)} Total(s) that don't match their start, end and pauses`,
  overlap: (n) => `${String(n)} overlapping session(s)`,
  long: (n) => `${String(n)} session(s) longer than 12 hours`,
  endBeforeStart: (n) => `${String(n)} session(s) that end before they start`,
  idNames: (n) => `${String(n)} task ID(s) logged under different names`,
};

/** Check log's Notice: what it counted, and only what is there. */
export function checkLogMessage(s: LogCheckSummary): string {
  const parts = [`Gentle pomodoro: checked ${String(s.files)} log file(s) and changed nothing.`];
  if (s.counts.converted > 0) {
    parts.push(
      `${String(s.counts.converted)} line(s) in ${String(s.convertFiles)} file(s) are in the old format; "Convert old log lines" rewrites them.`
    );
  }
  if (s.renames > 0) {
    parts.push(`${String(s.renames)} file name(s) use other digits and can be renamed.`);
  }
  if (s.merges > 0) {
    parts.push(
      `${String(s.merges)} file(s) named with other digits can be merged into the 0-9 file of the same day (${String(s.mergeLines)} line(s)).`
    );
  }
  const looks: string[] = [];
  for (const kind of Object.keys(ANOMALY_PHRASES) as LogAnomalyKind[]) {
    if (s.anomalies[kind] > 0) looks.push(ANOMALY_PHRASES[kind](s.anomalies[kind]));
  }
  if (s.duplicateIds > 0) {
    looks.push(`${String(s.duplicateIds)} task ID(s) on task lines that can't be told apart`);
  }
  if (looks.length > 0) parts.push(`Worth a look: ${looks.join(", ")}.`);
  const left: string[] = [];
  if (s.counts.unrecognised > 0) {
    left.push(`${String(s.counts.unrecognised)} line(s) that can't be read`);
  }
  if (s.renamesBlocked > 0) {
    left.push(`${String(s.renamesBlocked)} file name(s) whose 0-9 name is taken`);
  }
  if (s.unreadableFiles > 0)
    left.push(`${String(s.unreadableFiles)} file(s) that couldn't be opened`);
  if (left.length > 0) parts.push(`Left as they are: ${left.join(", ")}.`);
  if (parts.length === 1) {
    return `Gentle pomodoro: checked ${String(s.files)} log file(s). Every line is in the current format and nothing looks wrong.`;
  }
  parts.push("Details are in the developer console.");
  return parts.join(" ");
}

const CLEANUP_PHRASES: Partial<Record<LogConversionKind, (n: number) => string>> = {
  checkbox: (n) => `${String(n)} checkbox(es) in front of a session removed`,
  fffd: (n) => `${String(n)} stray "�" removed from task names`,
  priority: (n) => `${String(n)} priority emoji removed from task names`,
  idMoved: (n) => `${String(n)} 🆔 moved from a task name to the ID field`,
  digits: (n) => `${String(n)} line(s) with dates in other digits written with 0-9`,
  sanitized: (n) => `${String(n)} task name(s) tidied of brackets or "::"`,
};

/** A merge the dry run plans: the old file's name, the 0-9 file's, and its lines (F4). */
export interface PlannedMerge {
  from: string;
  into: string;
  lines: number;
}

/** One merge as the dialog and Check's console list it. */
export function mergeListItem(merge: PlannedMerge): string {
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  return `Merge "${name(merge.from)}" into "${name(merge.into)}": ${String(merge.lines)} line(s)`;
}

/**
 * Convert's question, with the exact counts the dry run found. It says what
 * is kept and lists, under the body, the clean-ups — the only other changes
 * to a line, so the body must not promise "every value" above them (F31) —
 * and then each merge, with its lines (F4).
 */
export function convertConfirmOptions(plan: {
  counts: LogConversionCounts;
  convertFiles: number;
  renames: number;
  merges?: readonly PlannedMerge[];
  unreadableFiles?: number;
}): ConfirmOptions {
  const { counts, convertFiles, renames } = plan;
  const merges = plan.merges ?? [];
  const unreadableFiles = plan.unreadableFiles ?? 0;
  const list: string[] = [];
  for (const kind of LOG_CONVERSION_KINDS) {
    const phrase = CLEANUP_PHRASES[kind];
    if (phrase && counts[kind] > 0) list.push(phrase(counts[kind]));
  }
  for (const merge of merges) list.push(mergeListItem(merge));
  const body: string[] = [];
  if (counts.converted > 0) {
    const kept =
      list.length > 0
        ? "Every start, end and total is kept; the tidy-ups below are the only other changes."
        : "Every start, end and total is kept.";
    body.push(
      `${String(counts.converted)} line(s) in ${String(convertFiles)} file(s) will be rewritten in the format Dataview reads. ${kept}`
    );
  }
  if (renames > 0) {
    body.push(`${String(renames)} file(s) will be renamed to write their date with 0-9.`);
  }
  if (merges.length > 0) {
    body.push(
      `${String(merges.length)} file(s) named with other digits will be merged into the 0-9 file of the same day, in start order, and then moved to the trash.`
    );
  }
  if (counts.unrecognised > 0) {
    body.push(`${String(counts.unrecognised)} line(s) that can't be read stay as they are.`);
  }
  if (unreadableFiles > 0) {
    body.push(`${String(unreadableFiles)} file(s) that couldn't be opened stay as they are.`);
  }
  return {
    title: "Convert old log lines?",
    body: body.join(" "),
    list,
    ctaText:
      counts.converted > 0
        ? `Convert ${String(counts.converted)} line(s)`
        : renames > 0
          ? `Rename ${String(renames)} file(s)`
          : `Merge ${String(merges.length)} file(s)`,
  };
}

/** What Convert did. */
export interface LogConvertResult {
  lines: number;
  files: number;
  renamed: number;
  /** Files merged into their day's 0-9 file and moved to the trash (F4), and their lines. */
  merged: number;
  mergedLines: number;
  unrecognised: number;
  renamesBlocked: number;
  /** Files the dry run could not read, so never converted (F9). */
  unreadableFiles: number;
  failed: number;
  /** Merges that wrote nothing, or were taken back out: both files as they were. */
  mergesFailed: number;
  /** Merged, but neither moved to the trash nor taken back out: in both files now. */
  mergesStuck: number;
}

export function convertResultMessage(r: LogConvertResult): string {
  const parts = [
    `Gentle pomodoro: converted ${String(r.lines)} line(s) in ${String(r.files)} file(s).`,
  ];
  if (r.renamed > 0) parts.push(`Renamed ${String(r.renamed)} file(s).`);
  if (r.merged > 0) {
    parts.push(
      `Merged ${String(r.merged)} file(s) (${String(r.mergedLines)} line(s)) into the 0-9 file of the same day.`
    );
  }
  if (r.mergesStuck > 0) {
    parts.push(
      `${String(r.mergesStuck)} file(s) merged but not moved to the trash: delete them before converting again, or their lines are merged twice — see the developer console.`
    );
  }
  const left: string[] = [];
  if (r.unrecognised > 0) left.push(`${String(r.unrecognised)} line(s) that can't be read`);
  if (r.renamesBlocked > 0) {
    left.push(`${String(r.renamesBlocked)} file name(s) whose 0-9 name is taken`);
  }
  if (r.mergesFailed > 0) left.push(`${String(r.mergesFailed)} file(s) that couldn't be merged`);
  if (r.unreadableFiles > 0) {
    left.push(`${String(r.unreadableFiles)} file(s) that couldn't be opened`);
  }
  if (r.failed > 0) left.push(`${String(r.failed)} file(s) that couldn't be written`);
  if (left.length > 0) {
    parts.push(`Left as they are: ${left.join(", ")} — see the developer console.`);
  }
  return parts.join(" ");
}

/**
 * Convert's Notice when the dry run found nothing to rewrite or rename. A file
 * it could not open was not looked at, so it is never an all-clear for the
 * folder — and with none opened, it says only that (F9).
 */
export function convertNothingMessage(s: {
  files: number;
  unreadableFiles: number;
  unrecognised: number;
}): string {
  if (s.unreadableFiles > 0 && s.unreadableFiles >= s.files) {
    return `Gentle pomodoro: couldn't open any of the ${String(s.files)} log file(s), so nothing was converted — see the developer console.`;
  }
  const left: string[] = [];
  if (s.unrecognised > 0) left.push(`${String(s.unrecognised)} line(s) that can't be read`);
  if (s.unreadableFiles > 0) {
    left.push(`${String(s.unreadableFiles)} file(s) that couldn't be opened`);
  }
  const head =
    s.unreadableFiles > 0
      ? "Gentle pomodoro: no old log lines to convert in the files that could be opened."
      : "Gentle pomodoro: no old log lines to convert.";
  return left.length > 0
    ? `${head} Left as they are: ${left.join(", ")} — see the developer console.`
    : head;
}

/** The dry run both commands start from. */
interface LogPlan {
  files: TFile[];
  contents: Map<TFile, string>;
  unreadableFiles: number;
  counts: LogConversionCounts;
  changing: TFile[];
  unrecognised: { path: string; lines: UnconvertedLine[] }[];
  renames: { file: TFile; target: string }[];
  /**
   * Files named in other digits whose day has a 0-9 file: on disk, or the one
   * this run renames to that name first (F4). Merged after the renames.
   */
  merges: { file: TFile; target: string; lines: number }[];
  /** Such files whose 0-9 name something other than a file holds (a folder). */
  renamesBlocked: { file: TFile; target: string }[];
}

/** The plan's merges, as the dialog and the console name them. */
function plannedMerges(plan: LogPlan): PlannedMerge[] {
  return plan.merges.map(({ file, target, lines }) => ({ from: file.path, into: target, lines }));
}

export class LogTools {
  // Check and Convert run one at a time: a second press while the first is
  // reading or asking would plan against files the first is about to write.
  private busy = false;

  constructor(private readonly host: LogToolsHost) {}

  /** Today as the log counts days ("Day starts at" applied). */
  today(): string {
    return logicalDate(moment(), this.host.settings().dayStartHour);
  }

  /** The daily log file for `date`, or null when there is none (or no folder). */
  logFile(date: string): TFile | null {
    const folder = this.host.settings().logFolderPath;
    if (!folder) return null;
    const file = this.host.app.vault.getAbstractFileByPath(dailyLogPath(folder, date));
    return file instanceof TFile ? file : null;
  }

  /**
   * Open today's log (F56). Never creates it: an empty file made only to be
   * looked at would be one more file in the folder, and the first session
   * writes it anyway.
   */
  async openToday(): Promise<void> {
    if (!this.host.settings().logFolderPath) {
      new Notice(NO_LOG_FOLDER_NOTICE);
      return;
    }
    const file = this.logFile(this.today());
    if (file === null) {
      // A folder stored in another capitalisation is written through the
      // disk into the real one, where this path does not look (F29). The top
      // level needs nothing: its files are found by path.
      const folder = this.host.settings().logFolderPath;
      const problem = logFolderProblem(folder, this.host.app.vault);
      new Notice(
        problem?.kind === "case" ? logFolderProblemNotice(folder, problem) : NO_LOG_TODAY_NOTICE
      );
      return;
    }
    await this.host.app.workspace.getLeaf(false).openFile(file);
  }

  /** "Check log": the conversion's dry run and everything that looks wrong. Writes nothing. */
  async check(): Promise<void> {
    await this.exclusive("check the log", async () => {
      const plan = await this.plan();
      if (plan === null) return;
      this.reportLeftAlone(plan);
      const files = [...plan.contents].map(([file, content]) => ({ path: file.path, content }));
      const anomalies = scanLogAnomalies(files);
      reportAnomalies(anomalies);
      if (plan.merges.length > 0) {
        logger.warn(
          `Check log: files named with other digits, whose day has a 0-9 file:\n${plannedMerges(
            plan
          )
            .map((merge) => `  ${mergeListItem(merge)}`)
            .join("\n")}`
        );
      }
      const duplicates = await this.host.duplicateTaskIds();
      for (const { taskId, path } of duplicates) {
        logger.warn(
          `Check log: 🆔 ${taskId} is on more than one task line in "${path}", and not on exactly one open one, so its sessions are never renamed.`
        );
      }
      new Notice(
        checkLogMessage({
          files: plan.files.length,
          unreadableFiles: plan.unreadableFiles,
          counts: plan.counts,
          convertFiles: plan.changing.length,
          renames: plan.renames.length,
          merges: plan.merges.length,
          mergeLines: plan.merges.reduce((sum, merge) => sum + merge.lines, 0),
          renamesBlocked: plan.renamesBlocked.length,
          anomalies: countAnomalies(anomalies),
          duplicateIds: duplicates.length,
        })
      );
    });
  }

  /**
   * "Convert old log lines": the dry run, a dialog with its exact counts, then
   * the writes — only files that change, each through Vault.process and
   * converted again on what it holds then, so the counts are the file's own;
   * then the renames, then the merges (mergeInto). Running it twice changes
   * nothing the second time: a merged file is in the trash.
   */
  async convert(): Promise<void> {
    await this.exclusive("convert the log", async () => {
      const plan = await this.plan();
      if (plan === null) return;
      this.reportLeftAlone(plan);
      if (plan.counts.converted === 0 && plan.renames.length === 0 && plan.merges.length === 0) {
        new Notice(
          convertNothingMessage({
            files: plan.files.length,
            unreadableFiles: plan.unreadableFiles,
            unrecognised: plan.counts.unrecognised,
          })
        );
        return;
      }
      const confirmed = await this.host.confirm(
        convertConfirmOptions({
          counts: plan.counts,
          convertFiles: plan.changing.length,
          renames: plan.renames.length,
          merges: plannedMerges(plan),
          unreadableFiles: plan.unreadableFiles,
        })
      );
      if (!confirmed) return;

      const vault = this.host.app.vault;
      const result: LogConvertResult = {
        lines: 0,
        files: 0,
        renamed: 0,
        merged: 0,
        mergedLines: 0,
        unrecognised: plan.counts.unrecognised,
        renamesBlocked: plan.renamesBlocked.length,
        unreadableFiles: plan.unreadableFiles,
        failed: 0,
        mergesFailed: 0,
        mergesStuck: 0,
      };
      for (const file of plan.changing) {
        let lines = 0;
        try {
          await vault.process(file, (data) => {
            const converted = convertLogContent(data);
            lines = converted.counts.converted;
            return converted.content;
          });
        } catch (e) {
          result.failed++;
          logger.warn(`Could not convert "${file.path}"`, e);
          continue;
        }
        result.lines += lines;
        if (lines > 0) result.files++;
      }
      for (const { file, target } of plan.renames) {
        // Asked again: the name may have been taken since the dry run. Then
        // the file is left as it is — the dialog asked about a rename, not a
        // merge — and the next Convert offers to merge it.
        if (vault.getAbstractFileByPath(target) !== null) {
          result.renamesBlocked++;
          logger.warn(`Did not rename "${file.path}": "${target}" already exists.`);
          continue;
        }
        try {
          await this.host.app.fileManager.renameFile(file, target);
          result.renamed++;
        } catch (e) {
          result.failed++;
          logger.warn(`Could not rename "${file.path}" to "${target}"`, e);
        }
      }
      // After the renames: a second log of one date merges into the file the
      // first was renamed to.
      for (const { file, target } of plan.merges) {
        const merged = await this.mergeInto(file, target);
        if (merged.kind === "merged") {
          result.merged++;
          result.mergedLines += merged.lines;
        } else if (merged.kind === "stuck") {
          result.mergesStuck++;
        } else {
          result.mergesFailed++;
        }
      }
      if (result.lines > 0 || result.renamed > 0 || result.merged > 0 || result.mergesStuck > 0) {
        this.host.logChanged();
      }
      new Notice(convertResultMessage(result));
    });
  }

  /**
   * Merge a file named in other digits into its day's 0-9 file (F4): its lines
   * into `target` in one Vault.process (mergeLogContent), and only once that
   * write has landed, the file to the trash — the user's own choice of trash,
   * through fileManager.trashFile. A merge that cannot write leaves both files
   * as they were. One whose file cannot be moved to the trash takes its lines
   * back out of `target`: left in both, the next Convert would merge them a
   * second time. "stuck" is that undo failing too, and is said in the Notice.
   */
  private async mergeInto(
    file: TFile,
    target: string
  ): Promise<{ kind: "merged"; lines: number } | { kind: "failed" | "stuck" }> {
    const app = this.host.app;
    const into = app.vault.getAbstractFileByPath(target);
    if (!(into instanceof TFile) || into === file) {
      logger.warn(`Did not merge "${file.path}": "${target}" is not there.`);
      return { kind: "failed" };
    }
    let source = "";
    let before = "";
    let after = "";
    let lines = 0;
    let dropped: string[] = [];
    try {
      source = await app.vault.read(file);
      await app.vault.process(into, (data) => {
        const merged = mergeLogContent(data, source);
        before = data;
        after = merged.content;
        lines = merged.lines;
        dropped = merged.droppedProperties;
        return merged.content;
      });
    } catch (e) {
      logger.warn(`Could not merge "${file.path}" into "${target}"; both are as they were`, e);
      return { kind: "failed" };
    }
    try {
      await app.fileManager.trashFile(file);
    } catch (e) {
      try {
        await app.vault.process(into, (data) =>
          data === after ? before : unmergeLogContent(data, source)
        );
        logger.warn(
          `Could not move "${file.path}" to the trash, so its lines were taken back out of "${target}"`,
          e
        );
        return { kind: "failed" };
      } catch (undo) {
        logger.error(
          `Merged "${file.path}" into "${target}", but could neither move it to the trash nor take its lines back out. Delete "${file.path}" before converting again, or its ${String(logLineCount(source))} line(s) are merged twice.`,
          undo
        );
        return { kind: "stuck" };
      }
    }
    if (dropped.length > 0) {
      logger.warn(
        `Merged "${file.path}" into "${target}", which keeps its own head; the old file's properties stay with it in the trash:\n${dropped.join("\n")}`
      );
    }
    return { kind: "merged", lines };
  }

  /** One at a time, failures said rather than thrown. */
  private async exclusive(label: string, action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await action();
    } catch (e) {
      logger.error(`Failed to ${label}`, e);
      new Notice(`Gentle pomodoro: couldn't ${label} — see the developer console for details.`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Read every daily log in the folder and work out what Convert would do.
   * Only files named like a daily log: a note the user keeps in the folder —
   * an index, a dashboard quoting a line — is not one, and is never touched.
   */
  private async plan(): Promise<LogPlan | null> {
    const folder = this.host.settings().logFolderPath;
    if (!folder) {
      new Notice(NO_LOG_FOLDER_NOTICE);
      return null;
    }
    const app = this.host.app;
    const files = filesInFolder(app, folder).filter(
      (f) => f.extension === "md" && f.path.endsWith(LOG_FILE_SUFFIX)
    );
    if (files.length === 0) {
      // The top level, or a stored capitalisation the vault does not have:
      // the timer still writes the logs, so "none found" would be wrong (F29).
      const problem = logFolderProblem(folder, app.vault);
      new Notice(problem ? logFolderProblemNotice(folder, problem) : NO_LOG_FILES_NOTICE);
      return null;
    }
    const plan: LogPlan = {
      files,
      contents: new Map(),
      unreadableFiles: 0,
      counts: emptyConversionCounts(),
      changing: [],
      unrecognised: [],
      renames: [],
      merges: [],
      renamesBlocked: [],
    };
    for (const file of files) {
      let content: string;
      try {
        content = await app.vault.read(file);
      } catch (e) {
        plan.unreadableFiles++;
        logger.warn(`Could not read "${file.path}"`, e);
        continue;
      }
      plan.contents.set(file, content);
      const converted = convertLogContent(content);
      addConversionCounts(plan.counts, converted.counts);
      if (converted.counts.converted > 0) plan.changing.push(file);
      if (converted.unrecognised.length > 0) {
        plan.unrecognised.push({ path: file.path, lines: converted.unrecognised });
      }
      const cut = file.path.lastIndexOf("/");
      const ascii = asciiLogFileName(file.path.slice(cut + 1));
      if (ascii !== null) {
        const target = normalizePath(cut === -1 ? ascii : `${file.path.slice(0, cut)}/${ascii}`);
        const existing = app.vault.getAbstractFileByPath(target);
        // The day has a 0-9 file: its lines go into it (F4). So do a second
        // log of one date in other digits (Arabic and Persian): the first
        // planned takes the name, and the dialog's counts are the renames and
        // merges that can happen (F39).
        if (existing instanceof TFile || plan.renames.some((r) => r.target === target)) {
          plan.merges.push({ file, target, lines: logLineCount(content) });
        } else if (existing !== null) {
          plan.renamesBlocked.push({ file, target });
        } else {
          plan.renames.push({ file, target });
        }
      }
    }
    return plan;
  }

  /** The lines and names the tools leave as they are, listed for the console. */
  private reportLeftAlone(plan: LogPlan): void {
    for (const { path, lines } of plan.unrecognised) {
      const listed = lines
        .map(
          (l) =>
            `  line ${String(l.line)} (${l.reason === "unreadable" ? "can't be read" : "would not read back the same"}): ${l.text}`
        )
        .join("\n");
      logger.warn(`Left as it is in "${path}":\n${listed}`);
    }
    for (const { file, target } of plan.renamesBlocked) {
      logger.warn(`"${file.path}" keeps its name: "${target}" already exists and is not a file.`);
    }
  }

  /* ===== Adding and fixing a session (C6) ===== */

  /** The session lines of `date`'s log, and the file they are in; null when it has none. */
  async sessionsOn(date: string): Promise<{ file: TFile; lines: LoggedLine[] } | null> {
    const file = this.logFile(date);
    if (file === null) return null;
    return { file, lines: loggedLines(await this.host.app.vault.read(file)) };
  }

  /**
   * Write a session typed in by hand into its day's log, at its place by start
   * time. The first session of a day creates the file; every later one goes
   * through Vault.process.
   */
  async addSessionLine(session: SessionLog): Promise<boolean> {
    const settings = this.host.settings();
    const folder = settings.logFolderPath;
    if (!folder) {
      new Notice(NO_LOG_FOLDER_NOTICE);
      return false;
    }
    const app = this.host.app;
    const date = logicalDate(session.startTime, settings.dayStartHour);
    const path = dailyLogPath(folder, date);
    const line = formatLogLine(session);
    try {
      await ensureLogFolder(app, normalizePath(folder));
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await app.vault.process(existing, (data) => insertSessionLine(data, line));
      } else {
        await app.vault.create(path, insertSessionLine("", line));
      }
    } catch (e) {
      logger.error(`Could not add the session to "${path}":\n${line}`, e);
      new Notice("Gentle pomodoro: couldn't add the session — see the developer console.");
      return false;
    }
    this.host.logChanged();
    new Notice(`Gentle pomodoro: session added to the log for ${date}.`);
    return true;
  }

  /**
   * Replace one session line — or delete it, for `null` — through
   * Vault.process, and only if it still reads as it did when it was picked.
   */
  async rewriteSessionLine(
    file: TFile,
    target: LoggedLine,
    replacement: string | null
  ): Promise<"done" | "changed" | "failed"> {
    let changed = false;
    try {
      await this.host.app.vault.process(file, (data) => {
        const next = replaceSessionLine(data, target, replacement);
        if (next === null) {
          changed = true;
          return data;
        }
        return next;
      });
    } catch (e) {
      logger.error(`Could not update "${file.path}"`, e);
      new Notice("Gentle pomodoro: couldn't update the log — see the developer console.");
      return "failed";
    }
    if (changed) {
      new Notice(LINE_CHANGED_NOTICE);
      return "changed";
    }
    this.host.logChanged();
    new Notice(
      replacement === null
        ? "Gentle pomodoro: session deleted."
        : "Gentle pomodoro: session updated."
    );
    return "done";
  }

  /** The tasks the timer's picker would offer now, for the dialog's task button. */
  async taskChoices(): Promise<SessionTaskChoice[]> {
    const settings = this.host.settings();
    const source = resolveTaskSource(settings.taskSource);
    const scope = resolveTaskScope(this.host.app.workspace, source, settings.tasksPath);
    const tasks = await loadTasks(this.host.app, {
      scope,
      limitDays: settings.taskSelectorDays,
      includeUndated: scope.kind === "notes",
    });
    // The timer's own name for a task (cleanText, tags kept): the reviews
    // take a session's area from the tag in the logged name.
    return tasks.map((task) => ({
      task: { name: task.cleanText, path: task.path, id: task.taskId },
      label: task.displayText,
    }));
  }

  private askForm(options: SessionFormOptions): Promise<SessionFormAnswer> {
    return this.host.askSessionForm
      ? this.host.askSessionForm(options)
      : askSessionForm(this.host.app, options);
  }

  /** "Add a session": the dialog, then the line. */
  async addSession(): Promise<void> {
    const settings = this.host.settings();
    if (!settings.logFolderPath) {
      new Notice(NO_LOG_FOLDER_NOTICE);
      return;
    }
    const toMoment = (ms: number) => moment(ms);
    const answer = await this.askForm({
      title: "Add a session",
      form: newSessionForm(Date.now(), settings.focusMinutes, toMoment),
      submitText: "Add",
      canDelete: false,
      tasks: () => this.taskChoices(),
      check: (form) => {
        const built = sessionFromForm(form, { toMoment, nowMs: Date.now() });
        return built.ok ? null : built.message;
      },
    });
    if (answer === null || answer.action !== "save") return;
    const built = sessionFromForm(answer.form, { toMoment, nowMs: Date.now() });
    if (!built.ok) {
      new Notice(`Gentle pomodoro: ${built.message}`);
      return;
    }
    await this.addSessionLine(built.session);
  }

  /** "Fix a logged session": a day, one of its lines, then the dialog. */
  fixSession(): void {
    if (!this.host.settings().logFolderPath) {
      new Notice(NO_LOG_FOLDER_NOTICE);
      return;
    }
    new PickSessionModal(this.host.app, {
      date: this.today(),
      sessionsOn: async (date) => (await this.sessionsOn(date))?.lines ?? null,
      describe: describeLoggedLine,
      pick: (date, line) => {
        void this.fixLine(date, line);
      },
    }).open();
  }

  /** The dialog for one logged line, and its write. */
  async fixLine(date: string, line: LoggedLine): Promise<void> {
    const file = this.logFile(date);
    if (file === null) {
      new Notice(LINE_CHANGED_NOTICE);
      return;
    }
    const toMoment = (ms: number) => moment(ms);
    const initial = formFromLine(line, toMoment);
    if (initial === null) {
      new Notice(
        "Gentle pomodoro: that line's start time can't be read. Fix it in the file itself."
      );
      return;
    }
    const edit = (form: SessionForm) =>
      editedLine(line, initial, form, {
        toMoment,
        nowMs: Date.now(),
        dayStartHour: this.host.settings().dayStartHour,
        fileDate: date,
      });
    const answer = await this.askForm({
      title: "Fix a logged session",
      form: initial,
      submitText: "Save",
      canDelete: true,
      tasks: () => this.taskChoices(),
      check: (form) => {
        const result = edit(form);
        return result.kind === "error" ? result.message : null;
      },
    });
    if (answer === null) return;
    if (answer.action === "delete") {
      const confirmed = await this.host.confirm({
        title: "Delete this session?",
        body: `${describeLoggedLine(line)}, from the log for ${date}. This can't be undone.`,
        ctaText: "Delete",
        destructive: true,
      });
      if (confirmed) await this.rewriteSessionLine(file, line, null);
      return;
    }
    const result = edit(answer.form);
    if (result.kind === "unchanged") {
      new Notice("Gentle pomodoro: nothing changed.");
      return;
    }
    if (result.kind === "error") {
      new Notice(`Gentle pomodoro: ${result.message}`);
      return;
    }
    await this.rewriteSessionLine(file, line, result.text);
  }
}

/** Check's findings, one warning per file. */
function reportAnomalies(anomalies: readonly LogAnomaly[]): void {
  const byPath = new Map<string, LogAnomaly[]>();
  for (const anomaly of anomalies) {
    const list = byPath.get(anomaly.path) ?? [];
    list.push(anomaly);
    byPath.set(anomaly.path, list);
  }
  for (const [path, list] of byPath) {
    const lines = list.map((a) => `  line ${String(a.line)}: ${a.detail}`).join("\n");
    logger.warn(`Check log: "${path}"\n${lines}`);
  }
}
