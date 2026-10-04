/**
 * The daily log file's properties — the YAML at its top (0.6.9). The plugin
 * keeps one there, `goal_minutes`: the daily focus goal of the day the file
 * is for, so a review of an old day reads the goal that day had, not today's
 * setting. Pure — text in, text out; no `obsidian` import.
 *
 * Every reader of a log file skips these rows (frontmatterRowCount): a
 * property is not a session line, and a value that looks like one — a YAML
 * list holding `- 🍅 Focus [Total:: …]` — must not be counted, converted,
 * renamed or moved. Every writer keeps them where they are, byte for byte.
 */

/** The property that holds the day's goal, in minutes. */
export const LOG_GOAL_KEY = "goal_minutes";

// The rule of the parser behind Obsidian's metadata cache — what Properties,
// Dataview and the API's frontmatter read — out of app.js 1.13.7: past a byte
// order mark, which it drops, the file opens with a line that is exactly
// `---`, and the properties end at the next line that STARTS with `---` —
// `--- `, `----` and `---x` close them too. getFrontMatterInfo is stricter
// (a closing line of `---` alone, no mark), and copying it, a file whose
// closing line had a trailing space read as having none: the timer put a
// second block of properties on top, and Obsidian then read only that one.
const OPEN_REGEX = /^\uFEFF?---(\r?\n)/;
const CLOSE_REGEX = /---/g;

/** Where a file's properties are. */
export interface LogFrontmatter {
  /** The opening line's line break, "\n" or "\r\n". */
  eol: string;
  /** The YAML between the two `---` lines: `content.slice(from, to)`. */
  from: number;
  to: number;
  /** Where the file's body starts: just after the closing line — all of it,
   *  so text after its `---` is no session line. */
  bodyStart: number;
}

/** A file's properties, or null when it has none — as Obsidian reads them. */
export function logFrontmatter(content: string): LogFrontmatter | null {
  const open = OPEN_REGEX.exec(content);
  if (!open) return null;
  const from = open[0].length;
  CLOSE_REGEX.lastIndex = from;
  for (let close = CLOSE_REGEX.exec(content); close; close = CLOSE_REGEX.exec(content)) {
    // Only a `---` that starts its line closes them.
    if (content.charAt(close.index - 1) === "\n") {
      const lineEnd = content.indexOf("\n", close.index);
      const bodyStart = lineEnd === -1 ? content.length : lineEnd + 1;
      return { eol: open[1], from, to: close.index, bodyStart };
    }
  }
  return null;
}

/**
 * How many of the file's rows — split on "\n", the way every reader splits —
 * belong to its properties, both `---` lines included; 0 when it has none. A
 * reader starts at this row.
 */
export function frontmatterRowCount(content: string): number {
  const frontmatter = logFrontmatter(content);
  if (frontmatter === null) return 0;
  const head = content.slice(0, frontmatter.bodyStart);
  const rows = head.split("\n").length;
  return head.endsWith("\n") ? rows - 1 : rows;
}

/** The setting's goal as minutes to record: a positive number, else 0 (no goal). */
export function resolveGoalMinutes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// `goal_minutes: 120`, at the start of its row — a key indented under another
// is not this one. Quotes and a trailing comment are allowed, as YAML allows.
const GOAL_ROW_REGEX = new RegExp(`^${LOG_GOAL_KEY}:(.*)$`);
const GOAL_VALUE_REGEX = /^\s*(["']?)(\d+(?:\.\d+)?)\1\s*(?:#.*)?$/;

/** The rows of the properties, each as its span in `content`, line break left out. */
function propertyRows(content: string, frontmatter: LogFrontmatter) {
  const rows: { start: number; end: number; text: string }[] = [];
  let start = frontmatter.from;
  while (start < frontmatter.to) {
    const lineEnd = content.indexOf("\n", start);
    const next = lineEnd === -1 || lineEnd >= frontmatter.to ? frontmatter.to : lineEnd + 1;
    let end = lineEnd === -1 || lineEnd >= frontmatter.to ? frontmatter.to : lineEnd;
    if (content.charAt(end - 1) === "\r") end--;
    rows.push({ start, end, text: content.slice(start, end) });
    start = next;
  }
  return rows;
}

/**
 * The goal row in the properties: its span in `content`, and the value it
 * holds. A value that runs on over the rows below its key — a list, as
 * Properties writes one, a `|` or `>` block, a scalar folded onto the next
 * row — is all of the span, and no number: rewritten, only its first row
 * went, and `goal_minutes: 120` over `  - 90` read in YAML as the text
 * "120 - 90".
 */
function goalRow(
  content: string,
  frontmatter: LogFrontmatter
): { start: number; end: number; minutes: number | null } | null {
  const rows = propertyRows(content, frontmatter);
  const at = rows.findIndex((row) => GOAL_ROW_REGEX.test(row.text));
  if (at === -1) return null;
  const head = GOAL_ROW_REGEX.exec(rows[at].text)?.[1] ?? "";
  // A key with no value of its own may take a list at its own indent.
  const bare = /^\s*(?:#.*)?$/.test(head);
  let end = rows[at].end;
  let runsOn = false;
  for (const row of rows.slice(at + 1)) {
    const trimmed = row.text.trim();
    const indented = /^\s/.test(row.text);
    // A blank row, or an indented comment, ends nothing and adds nothing.
    if (trimmed === "" || (indented && trimmed.startsWith("#"))) continue;
    if (!indented && !(bare && /^-(?:\s|$)/.test(row.text))) break;
    end = row.end;
    runsOn = true;
  }
  const value = runsOn ? null : GOAL_VALUE_REGEX.exec(head);
  return { start: rows[at].start, end, minutes: value ? Number(value[2]) : null };
}

/**
 * The goal a log file records for its day, in minutes; null when it records
 * none — no properties, no `goal_minutes`, or a value that is not a number.
 * Files from before 0.6.9 have none.
 */
export function readLogGoal(content: string): number | null {
  const frontmatter = logFrontmatter(content);
  if (frontmatter === null) return null;
  return goalRow(content, frontmatter)?.minutes ?? null;
}

/**
 * `content` recording `minutes` as its day's goal. Unchanged when it already
 * does, when `minutes` is no goal (0 — with the goal off nothing is written,
 * and a goal already there stays), when the file starts with a byte order
 * mark — a file another program wrote, as Obsidian drops the mark from every
 * file it saves; its head is left as that program wrote it — and when a file
 * with no properties starts with a row that starts with `---`: a block put in
 * front of that would end at it.
 *
 * Only the goal's own row is written: rewritten in place when the file has
 * one — the rows a value runs on over with it (goalRow) — added as the last
 * property when it has others, or — in a file with none — a new block of
 * properties in front of everything, in the file's own line ending. Every
 * other byte stays, the body untouched.
 *
 * LogManager runs this inside the Vault.process callback that appends a
 * session to TODAY's file, and nowhere else: never on a past day's file,
 * whose goal is the one that day had.
 */
export function withLogGoal(content: string, minutes: number): string {
  if (resolveGoalMinutes(minutes) === 0 || content.startsWith("﻿")) return content;
  const value = `${LOG_GOAL_KEY}: ${String(minutes)}`;
  const frontmatter = logFrontmatter(content);
  if (frontmatter === null) {
    if (content.startsWith("---")) return content;
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    return `---${eol}${value}${eol}---${eol}${content}`;
  }
  const row = goalRow(content, frontmatter);
  if (row === null) {
    // Before the closing `---`, which starts its own row.
    const at = frontmatter.to;
    return content.slice(0, at) + value + frontmatter.eol + content.slice(at);
  }
  if (row.minutes === minutes) return content;
  return content.slice(0, row.start) + value + content.slice(row.end);
}
