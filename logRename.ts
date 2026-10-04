/**
 * How a task's past log lines follow it when it is renamed (0.6.9): the
 * automatic rename, when the linked task with a 🆔 is renamed, and "Refresh
 * log task names by ID". Pure — LogManager resolves the links, reads the
 * notes and writes the files.
 *
 * Every rule here is one a rewrite of history used to break:
 * - only a line whose OWN link leads to the task's note is that task's (F11):
 *   the 🆔 alone repointed a copied task's sessions in another note;
 * - a link Obsidian shortened when the note moved (`[[Toy|…]]`) is still the
 *   task's (F10), and a line that is renamed gets the full path back — and
 *   keeps a `#heading` or `#^block` part, which is the user's;
 * - the line keeps its own #tags (F54): the reviews file a session under the
 *   area in its tag, and a retag must not move months already reviewed;
 * - a count, a Tasks field or spacing is no rename (F34, F63);
 * - a past line's name is held against the note's copies as the log wrote it
 *   — `[[Paper]]` as `Paper` — or it names none of them (F23);
 * - Refresh leaves a session that began before its task's ➕ date (F12): the
 *   🆔 was reused, and the session is another task's.
 */
import {
  formatTaskValue,
  logStartDate,
  logTaskId,
  parseLogLine,
  replaceTaskValue,
  sanitizeAlias,
  type ParsedLogLine,
} from "./logLine";
import { frontmatterRowCount } from "./logFrontmatter";
import {
  findTaskLineByLoggedName,
  loggedNameKey,
  nameTags,
  nameWithoutTags,
  taskCreatedDate,
  taskLineName,
} from "./taskLoader";

/** A link's target as a vault path, or null when it leads to no note. */
export type ResolveLink = (linkpath: string, sourcePath: string) => string | null;

/**
 * What a logged name becomes when its task now goes by `name`, or null when
 * that is no rename of it (loggedNameKey). The line keeps its own #tags: when
 * the new name's tags are the same ones it is taken as it is, and otherwise
 * its words go with the line's own tags after them (F54).
 */
export function renamedAlias(logged: string, name: string): string | null {
  const before = sanitizeAlias(logged);
  const after = sanitizeAlias(name);
  if (loggedNameKey(before) === loggedNameKey(after)) return null;
  const ownTags = nameTags(before);
  const sameTags = [...ownTags].sort().join(" ") === nameTags(after).sort().join(" ");
  if (sameTags) return after;
  return [nameWithoutTags(after), ...ownTags].join(" ").trim();
}

/** A focus line's 🆔 and the link it names, or null for any other line. */
function idLink(
  parsed: ParsedLogLine | null
): { taskId: string; linkpath: string; name: string } | null {
  if (!parsed?.task?.path) return null;
  const taskId = logTaskId(parsed);
  if (taskId === null) return null;
  return { taskId, linkpath: parsed.task.path, name: parsed.task.name };
}

/**
 * A link's heading or block part (`#Section`, `#^abc`), or "". Obsidian's own
 * rule (getLinkpath): the note path ends at the first `#`. The plugin never
 * writes one, so it is a hand edit, and a renamed line keeps it.
 */
function linkSubpath(linkpath: string): string {
  const hash = linkpath.indexOf("#");
  return hash === -1 ? "" : linkpath.slice(hash);
}

/** Did the line's session start on a day before `created`? Dates only: a
 *  session on the day its task was created is that task's. */
function startedBefore(parsed: ParsedLogLine, created: string | null): boolean {
  if (created === null) return false;
  const start = logStartDate(parsed);
  return start !== null && start < created;
}

/** The linked task renamed, as the automatic rename hands it on. */
export interface TaskRename {
  taskId: string;
  name: string;
  /** The task's note: a line is renamed only when its own link leads here. */
  taskPath: string;
  /** The task line's ➕ date, if it has one. */
  createdDate: string | null;
  /** The renamed task line, whole, as it read when the rename was taken. */
  line: string;
  /**
   * The note's other task lines carrying the 🆔, whole — a copied line, a
   * ticked copy of a task copied forward. A past line whose name leads to one
   * of them (ownCopy) is that copy's, and keeps its name (F2).
   */
  copies: readonly string[];
}

/**
 * Does a past line logged as `name` belong to the renamed line, as Refresh
 * reads it (findTaskLineByLoggedName)? Its name names that line — or names no
 * copy, and that line is the one open copy. A line whose name names another
 * copy, or that cannot be told apart, is left as it is: renaming a task copied
 * forward rewrote the sessions of its ticked copy too — and still did when the
 * task's text held a `[[link]]`, brackets or `::`, until the copies were read
 * as logged names (F23).
 */
function ownCopy(name: string, rename: TaskRename): boolean {
  if (rename.copies.length === 0) return true;
  const found = findTaskLineByLoggedName([rename.line, ...rename.copies], rename.taskId, name);
  return found.kind === "found" && found.index === 0;
}

/**
 * A log file with `rename` applied to the lines that are that task's, and
 * how many changed. Split and joined on "\n", as every write path is, so a
 * CRLF file keeps its line endings.
 */
export function renameLogContent(
  content: string,
  logPath: string,
  rename: TaskRename,
  resolve: ResolveLink
): { content: string; lines: number } {
  const lines = content.split("\n");
  let changed = 0;
  // Past the file's properties, which are no session's (logFrontmatter.ts).
  for (let i = frontmatterRowCount(content); i < lines.length; i++) {
    const parsed = parseLogLine(lines[i]);
    const ref = idLink(parsed);
    if (!parsed || !ref || ref.taskId !== rename.taskId) continue;
    if (resolve(ref.linkpath, logPath) !== rename.taskPath) continue;
    const alias = renamedAlias(ref.name, rename.name);
    if (alias === null || startedBefore(parsed, rename.createdDate)) continue;
    if (!ownCopy(ref.name, rename)) continue;
    const path = rename.taskPath + linkSubpath(ref.linkpath);
    lines[i] = replaceTaskValue(lines[i], parsed, formatTaskValue(alias, path));
    changed++;
  }
  return { content: lines.join("\n"), lines: changed };
}

/** Why Refresh left a line alone. */
export const REFRESH_SKIPS = [
  /** Its link leads to no note. */
  "unresolved",
  /** Its note has no line with its 🆔 any more. */
  "missing",
  /** Its 🆔 is on more than one line of the note, and neither its name nor a
   *  single open line tells which (F2). */
  "duplicate",
  /** Its session began before the task's ➕ date (F12). */
  "beforeCreated",
  /** Its note could not be read. */
  "unreadable",
] as const;
export type RefreshSkip = (typeof REFRESH_SKIPS)[number];

export function emptyRefreshSkips(): Record<RefreshSkip, number> {
  return { unresolved: 0, missing: 0, duplicate: 0, beforeCreated: 0, unreadable: 0 };
}

/** What Refresh reads before it plans, so that the write can be synchronous. */
export interface RefreshNotes {
  resolve: ResolveLink;
  /** A note's lines, or null when it could not be read (or was not read). */
  lines(path: string): readonly string[] | null;
}

/** One name Refresh changes, as the dialog shows it. */
export interface RefreshedName {
  from: string;
  to: string;
}

export interface ContentRefresh {
  content: string;
  renamed: RefreshedName[];
  skipped: Record<RefreshSkip, number>;
}

/** The notes a log file's 🆔 lines link to — what Refresh has to read first. */
export function refreshTargets(content: string, logPath: string, resolve: ResolveLink): string[] {
  const targets = new Set<string>();
  for (const line of content.split(/\r?\n/).slice(frontmatterRowCount(content))) {
    const ref = idLink(parseLogLine(line));
    if (!ref) continue;
    const target = resolve(ref.linkpath, logPath);
    if (target !== null) targets.add(target);
  }
  return [...targets];
}

/**
 * A log file with every 🆔 line's name refreshed from its task's line as it
 * reads now. The dry run and the write both run this — the write inside
 * Vault.process, on the file as it is then — so the two agree but for lines
 * that changed in between.
 */
export function refreshLogContent(
  content: string,
  logPath: string,
  notes: RefreshNotes
): ContentRefresh {
  const lines = content.split("\n");
  const renamed: RefreshedName[] = [];
  const skipped = emptyRefreshSkips();
  for (let i = frontmatterRowCount(content); i < lines.length; i++) {
    const parsed = parseLogLine(lines[i]);
    const ref = idLink(parsed);
    if (!parsed || !ref) continue;
    const target = notes.resolve(ref.linkpath, logPath);
    if (target === null) {
      skipped.unresolved++;
      continue;
    }
    const noteLines = notes.lines(target);
    if (noteLines === null) {
      skipped.unreadable++;
      continue;
    }
    // The line's own name is the key, as for the automatic rename (ownCopy):
    // a name that names a copy is that copy's, and needs no rename; a name
    // that names none takes the one open copy's (F2). Compared as a logged
    // name, so a `[[link]]` the log wrote as its text still names its copy (F23).
    const found = findTaskLineByLoggedName(noteLines, ref.taskId, ref.name);
    if (found.kind !== "found") {
      skipped[found.kind === "missing" ? "missing" : "duplicate"]++;
      continue;
    }
    const alias = renamedAlias(ref.name, taskLineName(found.text));
    if (alias === null) continue;
    if (startedBefore(parsed, taskCreatedDate(found.text))) {
      skipped.beforeCreated++;
      continue;
    }
    const path = target + linkSubpath(ref.linkpath);
    lines[i] = replaceTaskValue(lines[i], parsed, formatTaskValue(alias, path));
    renamed.push({ from: sanitizeAlias(ref.name), to: sanitizeAlias(alias) });
  }
  return { content: lines.join("\n"), renamed, skipped };
}

/** How many examples the confirm dialog shows. */
export const REFRESH_EXAMPLE_COUNT = 3;

/** "old → new", the first few, each once. */
export function refreshExamples(renamed: readonly RefreshedName[]): string[] {
  const examples: string[] = [];
  for (const { from, to } of renamed) {
    const example = `${from} → ${to}`;
    if (!examples.includes(example)) examples.push(example);
    if (examples.length === REFRESH_EXAMPLE_COUNT) break;
  }
  return examples;
}

/**
 * The sentences after a Refresh's result that say which lines it left alone
 * and which log files it could not read or write; "" when none. A link that
 * leads nowhere and a note without the 🆔 count as one: either way the task
 * could not be found.
 */
export function refreshLeftAlone(
  skipped: Record<RefreshSkip, number>,
  failedFiles: number
): string {
  const parts: string[] = [];
  const unresolved = skipped.unresolved + skipped.missing;
  if (unresolved > 0) parts.push(`${unresolved} line(s) whose task couldn't be found`);
  if (skipped.duplicate > 0) {
    parts.push(`${skipped.duplicate} line(s) whose 🆔 is on tasks that can't be told apart`);
  }
  if (skipped.beforeCreated > 0) {
    parts.push(`${skipped.beforeCreated} line(s) from before their task was created`);
  }
  if (skipped.unreadable > 0) {
    parts.push(`${skipped.unreadable} line(s) whose task's note couldn't be read`);
  }
  const left = parts.length > 0 ? ` Left alone: ${parts.join(", ")}.` : "";
  return failedFiles > 0 ? `${left} Couldn't read or write ${failedFiles} log file(s).` : left;
}
