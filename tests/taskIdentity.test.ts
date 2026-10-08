import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { TFile } from "obsidian";
// The recording Notice and Modal, by path so `tsc` sees their statics
// (tests/settingTab.test.ts explains why this is the same module).
import { Modal, Notice } from "../__mocks__/obsidian";
import { LogManager } from "../logManager";
import { TASK_RENAME_DELAY_MS } from "../constants";
import { parseLogLine } from "../logLine";
import {
  duplicateTaskIds,
  findIdTaskLineInContent,
  findTaskLineById,
  findTaskLineByLoggedName,
  findTaskTextByIdInContent,
  idTaskDone,
  isPathGone,
  linkedLineIndex,
  loggedNameKey,
  nameTags,
  nameWithoutTags,
  pathAfterMove,
  taskCreatedDate,
} from "../taskLoader";
import { refreshExamples, refreshLeftAlone, emptyRefreshSkips, renamedAlias } from "../logRename";
import type { ConfirmOptions } from "../confirmModal";
import type GentlePomoPlugin from "../main";
import { fakeVault, linkCache, type FakeVault } from "./fakeVault";

// LogManager's rename delay runs on `window.setTimeout`; in Node that lives
// on globalThis.
beforeAll(() => {
  if (typeof (globalThis as unknown as { window?: unknown }).window === "undefined") {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  }
});

/* ===== The line a 🆔 names (F2, F15) ===== */

describe("findTaskLineById — a 🆔 on more than one line (F2)", () => {
  // The maintainer's notes hold 12 IDs on 25 lines, every one a copied line in
  // the same note. Taking the first logged a session under the copy above the
  // task and rewrote that task's history to the copy's name.
  const lines = [
    "- [x] Update codebook to V7.4 🆔 qfd97u ✅ 2026-08-26",
    "- [ ] Update codebook to V7.5 🆔 qfd97u",
    "- [ ] Something else 🆔 other1",
  ];

  it("takes the copy the key names, not the first", () => {
    expect(findTaskLineById(lines, "qfd97u", "Update codebook to V7.5 🆔 qfd97u")).toEqual({
      kind: "found",
      index: 1,
      text: "Update codebook to V7.5 🆔 qfd97u",
    });
    // A name works as the key too: it is what writeLog has.
    expect(findTaskLineById(lines, "qfd97u", "Update codebook to V7.5")).toMatchObject({
      index: 1,
    });
    // Two open copies: each is the one its key names.
    const open = ["- [ ] Update codebook to V7.4 🆔 q", "- [ ] Update codebook to V7.5 🆔 q"];
    expect(findTaskLineById(open, "q", "Update codebook to V7.4")).toMatchObject({ index: 0 });
    expect(findTaskLineById(open, "q", "Update codebook to V7.5 🆔 q")).toMatchObject({
      index: 1,
    });
  });

  it("prefers an open copy over a done one with the same text", () => {
    const recurring = ["- [x] Water plants 🆔 w1 ✅ 2026-10-01", "- [ ] Water plants 🆔 w1"];
    expect(findTaskLineById(recurring, "w1", "Water plants 🆔 w1")).toMatchObject({ index: 1 });
    // Without the count, as for a task with no 🆔: an open line a count ahead
    // still wins over a done copy that matches exactly.
    const counted = ["- [x] Water plants 🍅 2 🆔 w1", "- [ ] Water plants 🍅 3 🆔 w1"];
    expect(findTaskLineById(counted, "w1", "Water plants 🍅 2 🆔 w1")).toMatchObject({ index: 1 });
  });

  it("is ambiguous when neither the key nor a single open copy can tell — never a guess", () => {
    // Two open copies, both renamed: the key names neither, and two are open.
    const renamed = ["- [ ] V7.6 🆔 q", "- [ ] V7.7 🆔 q"];
    expect(findTaskLineById(renamed, "q", "V7.5 🆔 q")).toEqual({ kind: "ambiguous" });
    const twins = ["- [ ] Same 🆔 q", "- [ ] Same 🆔 q"];
    expect(findTaskLineById(twins, "q", "Same 🆔 q")).toEqual({ kind: "ambiguous" });
    expect(findTaskLineById(twins, "q")).toEqual({ kind: "ambiguous" });
    // Every copy ticked, and the key names none of them, or two equally.
    const ticked = ["- [x] V7.4 🆔 q", "- [x] V7.6 🆔 q", "- [x] V7.6 🆔 q"];
    expect(findTaskLineById(ticked, "q", "V7.5 🆔 q")).toEqual({ kind: "ambiguous" });
    expect(findTaskLineById(ticked, "q", "V7.6 🆔 q")).toEqual({ kind: "ambiguous" });
  });

  it("takes a single line by its 🆔 alone, whatever the key says", () => {
    expect(findTaskLineById(lines, "other1", "Not this at all")).toMatchObject({ index: 2 });
    expect(findTaskLineById(lines, "nope", "x")).toEqual({ kind: "missing" });
  });

  it("keeps the linked name when the 🆔 is ambiguous", () => {
    const content = `${lines.join("\n")}\n- [ ] Update codebook to V8 🆔 qfd97u`;
    expect(findTaskTextByIdInContent(content, "qfd97u")).toBeNull();
    expect(findTaskTextByIdInContent(content, "qfd97u", "Update codebook to V7.6")).toBeNull();
    expect(findTaskTextByIdInContent(content, "qfd97u", "Update codebook to V7.5")).toBe(
      "Update codebook to V7.5 🆔 qfd97u"
    );
  });

  it("finds a task in a CRLF note (F15)", () => {
    const crlf = "- [ ] New name 🆔 abc123\r\n- [ ] Other 🆔 def456\r\n";
    expect(findTaskTextByIdInContent(crlf, "abc123")).toBe("New name 🆔 abc123");
    expect(findTaskTextByIdInContent(crlf, "def456")).toBe("Other 🆔 def456");
  });

  it("lists the 🆔s a note has on more than one task line that no single open line tells apart", () => {
    expect(duplicateTaskIds(`${lines.join("\r\n")}\n- [ ] Third 🆔 qfd97u`)).toEqual(["qfd97u"]);
    expect(duplicateTaskIds("- [x] Old 🆔 d\n- [x] Older 🆔 d\n")).toEqual(["d"]);
    expect(duplicateTaskIds("- [ ] A 🆔 a\n- [ ] B 🆔 b\nSee 🆔 a in prose")).toEqual([]);
    // One open copy and a ticked one: the open one is the task (resolveIdLine).
    expect(duplicateTaskIds(lines.join("\n"))).toEqual([]);
  });
});

describe("findTaskLineById — the one open copy, when the key cannot tell (F2, 2026-10-04)", () => {
  // The maintainer copies a task forward: the old copy is ticked, the new one
  // is open, and both keep the 🆔. A rename of the new one matches neither
  // copy, so up to now it was never followed and the 🍅 counted nothing.

  it("follows the rename of the one open copy", () => {
    const renamed = ["- [x] V7.4 🆔 q ✅ 2026-09-20", "- [ ] V7.6 🆔 q"];
    expect(findTaskLineById(renamed, "q", "V7.5 🆔 q")).toEqual({
      kind: "found",
      index: 1,
      text: "V7.6 🆔 q",
    });
    // The open copy below a ticked one, or above it: the order does not matter.
    expect(findTaskLineById([...renamed].reverse(), "q", "V7.5 🆔 q")).toMatchObject({ index: 0 });
    // A name as the key, as writeLog and Refresh have.
    expect(findTaskLineById(renamed, "q", "V7.5")).toMatchObject({ index: 1 });
  });

  it("picks the open copy of two with the same text, whatever the key", () => {
    const copied = ["- [x] Draft chapter 2 🆔 d ✅ 2026-10-01", "- [ ] Draft chapter 2 🆔 d"];
    expect(findTaskLineById(copied, "d", "Draft chapter 2 🆔 d")).toMatchObject({ index: 1 });
    expect(findTaskLineById(copied, "d", "Something else entirely")).toMatchObject({ index: 1 });
    expect(findTaskLineById(copied, "d")).toMatchObject({ index: 1 });
  });

  it("is ambiguous with two open copies", () => {
    const open = ["- [x] Draft 🆔 d", "- [ ] Draft v2 🆔 d", "- [ ] Draft v3 🆔 d"];
    expect(findTaskLineById(open, "d", "Draft v1 🆔 d")).toEqual({ kind: "ambiguous" });
    expect(findTaskLineById(open, "d")).toEqual({ kind: "ambiguous" });
  });

  it("looks for the open copy only among the copies the key names, when it names several open ones", () => {
    // The key names two open copies equally: one of them is meant, and the
    // open copy it does not name is not a candidate.
    const twins = ["- [ ] V7.6 🆔 q", "- [ ] V7.6 🆔 q", "- [ ] V8 🆔 q"];
    expect(findTaskLineById(twins, "q", "V7.6 🆔 q")).toEqual({ kind: "ambiguous" });
    expect(idTaskDone(twins, "q", "V7.6 🆔 q")).toBe(false);
    // Naming none of them, every copy is a candidate, and three are open.
    expect(findTaskLineById(twins, "q", "V7.5 🆔 q")).toEqual({ kind: "ambiguous" });
  });

  it("stays with the one open copy when the key names only ticked copies (2026-10-04)", () => {
    // Copied forward and the old copy ticked: the timer's key still names the
    // ticked copy, and the task is the one copy still open — edited or not.
    const copies = ["- [x] V7.4 🆔 q ✅ 2026-09-20", "- [ ] V7.5 🆔 q"];
    expect(findTaskLineById(copies, "q", "V7.4 🆔 q")).toEqual({
      kind: "found",
      index: 1,
      text: "V7.5 🆔 q",
    });
    // A name as the key, as writeLog has, the same.
    expect(findTaskLineById(copies, "q", "V7.4")).toMatchObject({ index: 1 });
    // However many ticked copies the key names, equally or not.
    const ticked = ["- [x] V7.6 🆔 q", "- [x] V7.6 🆔 q", "- [ ] V8 🆔 q"];
    expect(findTaskLineById(ticked, "q", "V7.6 🆔 q")).toMatchObject({ index: 2 });
    expect(idTaskDone(ticked, "q", "V7.6 🆔 q")).toBe(false);
  });

  it("takes a ticked copy the key names only when no copy, or more than one, is open", () => {
    const none = ["- [x] V7.4 🆔 q ✅ 2026-09-20", "- [x] V7.5 🆔 q"];
    expect(findTaskLineById(none, "q", "V7.4 🆔 q")).toEqual({
      kind: "found",
      index: 0,
      text: "V7.4 🆔 q ✅ 2026-09-20",
    });
    const two = ["- [x] V7.4 🆔 q", "- [ ] V8 🆔 q", "- [ ] V9 🆔 q"];
    expect(findTaskLineById(two, "q", "V7.4 🆔 q")).toMatchObject({ index: 0 });
    expect(idTaskDone(two, "q", "V7.4 🆔 q")).toBe(true);
    // And two ticked copies the key names equally, with two open: no answer.
    const tie = ["- [x] V7.4 🆔 q", "- [x] V7.4 🆔 q", "- [ ] V8 🆔 q", "- [ ] V9 🆔 q"];
    expect(findTaskLineById(tie, "q", "V7.4 🆔 q")).toEqual({ kind: "ambiguous" });
  });

  it("gives the 🍅 counter the same line", () => {
    const renamed = ["- [x] V7.4 🆔 q", "Notes on 🆔 q", "- [ ] V7.6 🆔 q"];
    expect(linkedLineIndex(renamed, "q", "V7.5 🆔 q")).toBe(2);
    expect(linkedLineIndex(["- [ ] A 🆔 q", "- [ ] B 🆔 q"], "q", "C 🆔 q")).toBe(-1);
    // The key names the ticked copy, and one copy is open: the open copy counts.
    expect(linkedLineIndex(["- [x] V7.4 🆔 q", "- [ ] V7.5 🆔 q"], "q", "V7.4 🆔 q")).toBe(1);
    expect(linkedLineIndex(["- [x] V7.4 🆔 q", "- [x] V7.5 🆔 q"], "q", "V7.4 🆔 q")).toBe(0);
  });

  it("says the task is done exactly when the line it takes is ticked", () => {
    const copied = ["- [x] V7.4 🆔 q", "- [ ] V7.5 🆔 q"];
    expect(idTaskDone(copied, "q", "V7.5 🆔 q")).toBe(false);
    // Copied forward: ticking the linked copy leaves the task the open one.
    expect(idTaskDone(copied, "q", "V7.4 🆔 q")).toBe(false);
    expect(idTaskDone(copied, "q", "V7.3 🆔 q")).toBe(false);
    // No copy left open: the ticked copy the key names is the task, done.
    expect(idTaskDone(["- [x] V7.4 🆔 q", "- [x] V7.5 🆔 q"], "q", "V7.4 🆔 q")).toBe(true);
    // Cannot tell: done only when every copy it weighed is.
    expect(idTaskDone(["- [ ] A 🆔 q", "- [ ] B 🆔 q"], "q", "C 🆔 q")).toBe(false);
    expect(idTaskDone(["- [x] A 🆔 q", "- [x] B 🆔 q"], "q", "C 🆔 q")).toBe(true);
    expect(idTaskDone(["- [ ] A 🆔 r"], "q", "A 🆔 q")).toBeNull();
  });

  it("hands a rename the line and the other copies", () => {
    const content = "- [x] V7.4 🆔 q\r\n- [ ] V7.6 🆔 q\r\n- [ ] Other 🆔 z\r\n";
    expect(findIdTaskLineInContent(content, "q", "V7.5 🆔 q")).toEqual({
      text: "V7.6 🆔 q",
      line: "- [ ] V7.6 🆔 q",
      copies: ["- [x] V7.4 🆔 q"],
    });
    expect(findIdTaskLineInContent(content, "z", "anything")).toEqual({
      text: "Other 🆔 z",
      line: "- [ ] Other 🆔 z",
      copies: [],
    });
  });
});

describe("findTaskLineByLoggedName — a past line's name read as the log wrote it (F23)", () => {
  // The log writes a name through sanitizeAlias: `[[Paper]]` as `Paper`, `[x]`
  // as `(x)`, `::` as `:`. Compared with the raw line, such a name named no
  // copy, and fell to the one open copy — a ticked copy's history went with it.
  // The name is also the line's taskLineName, which a priority typed mid-text
  // takes the next word out of: the copy is read as that name too.
  it.each([
    ["a [[link]]", "Read [[Paper]] ch", "Read Paper ch"],
    ["a [[link|alias]]", "Read [[Paper|the paper]] ch", "Read the paper ch"],
    ["brackets", "Check [x] ch", "Check (x) ch"],
    ["a ::", "A::B ch", "A:B ch"],
    ["a priority mid-text", "Fix ⏫ login bug v", "Fix bug v"],
  ])("names the ticked copy it was logged under when the task's text has %s", (_l, raw, logged) => {
    const lines = [`- [x] ${raw}1 🆔 q ✅ 2026-10-01`, `- [ ] ${raw}3 🆔 q`];
    expect(findTaskLineByLoggedName(lines, "q", `${logged}1`)).toMatchObject({ index: 0 });
    expect(findTaskLineByLoggedName(lines, "q", `${logged}3`)).toMatchObject({ index: 1 });
    // A name no copy has is still the one open copy's (2026-10-04).
    expect(findTaskLineByLoggedName(lines, "q", `${logged}2`)).toMatchObject({ index: 1 });
  });

  it("keeps a name that names a ticked copy with that copy, though one copy is open: history never follows the open copy", () => {
    // The timer's key goes to the one open copy when it names only a ticked
    // one (2026-10-04); a past line's name does not, or renaming the open
    // copy would rewrite the ticked copy's sessions.
    const lines = ["- [x] Update codebook to V7.4 🆔 q ✅ 2026-09-20", "- [ ] V7.5 🆔 q"];
    expect(findTaskLineByLoggedName(lines, "q", "Update codebook to V7.4")).toMatchObject({
      index: 0,
    });
    expect(findTaskLineById(lines, "q", "Update codebook to V7.4")).toMatchObject({ index: 1 });
  });

  it("names its copy through a count, a retag or spacing, which are no rename", () => {
    const lines = ["- [x] Water  plants 🍅 3 #task/a 🆔 w ✅ 2026-10-01", "- [ ] Water roses 🆔 w"];
    expect(findTaskLineByLoggedName(lines, "w", "Water plants 🍅 2 #task/b")).toMatchObject({
      index: 0,
    });
  });

  it("is ambiguous when the name names no copy and two are open — never a guess", () => {
    const lines = ["- [ ] Read [[Paper]] ch1 🆔 q", "- [ ] Read [[Paper]] ch3 🆔 q"];
    expect(findTaskLineByLoggedName(lines, "q", "Read Paper ch2")).toEqual({ kind: "ambiguous" });
    expect(findTaskLineByLoggedName(lines, "q", "Read Paper ch1")).toMatchObject({ index: 0 });
    expect(findTaskLineByLoggedName(lines, "nope", "Read Paper ch1")).toEqual({ kind: "missing" });
  });
});

describe("linkedLineIndex — the 🍅 counter's 🆔 branch (F2)", () => {
  it("counts the copy the timer holds, not the done copy above it", () => {
    const lines = [
      "- [x] Update codebook to V7.4 🆔 qfd97u",
      "- [ ] Update codebook to V7.5 🆔 qfd97u",
    ];
    expect(linkedLineIndex(lines, "qfd97u", "Update codebook to V7.5 🆔 qfd97u")).toBe(1);
  });

  it("counts nothing when it cannot tell which copy is meant", () => {
    const lines = ["- [ ] Draft 🆔 q", "- [ ] Draft 🆔 q"];
    expect(linkedLineIndex(lines, "q", "Draft 🆔 q")).toBe(-1);
  });

  it("still finds a lone 🆔 on any line, a task in progress or a CRLF line included", () => {
    expect(linkedLineIndex(["- [/] Doing it 🆔 q"], "q", "whatever")).toBe(0);
    expect(linkedLineIndex(["intro", "- [ ] Write 🆔 q\r"], "q", "Write 🆔 q")).toBe(1);
    expect(linkedLineIndex(["- [x] Write 🆔 q\r", "- [ ] Write 🆔 q\r"], "q", "Write 🆔 q")).toBe(
      1
    );
  });
});

describe("the path helpers a moved or deleted note goes through (C1)", () => {
  it("follows the note itself and anything under a moved folder, and nothing else", () => {
    expect(pathAfterMove("Projects/Docs.md", "Projects/Docs.md", "Archive/Docs.md")).toBe(
      "Archive/Docs.md"
    );
    expect(pathAfterMove("Projects/A/Docs.md", "Projects/A", "Projects/B")).toBe(
      "Projects/B/Docs.md"
    );
    expect(pathAfterMove("Projects/AB/Docs.md", "Projects/A", "Projects/B")).toBeNull();
    expect(pathAfterMove(undefined, "Projects/A", "Projects/B")).toBeNull();
    expect(isPathGone("Projects/A/Docs.md", "Projects/A")).toBe(true);
    expect(isPathGone("Projects/AB/Docs.md", "Projects/A")).toBe(false);
    expect(isPathGone(undefined, "Projects/A")).toBe(false);
  });
});

/* ===== What a rename does to one logged name (F34, F54, F63) ===== */

describe("renamedAlias — a past line's name after its task is renamed", () => {
  it("is a plain rename when the tags are the same ones", () => {
    expect(renamedAlias("Write paper #task/research/x", "Write the paper #task/research/x")).toBe(
      "Write the paper #task/research/x"
    );
    // Same tags, wherever they stand: the new name as it is.
    expect(renamedAlias("Fix #1 bug", "Fix #1 bug now")).toBe("Fix #1 bug now");
  });

  it("keeps the line's own tags when the task was retagged as well (F54)", () => {
    // The reviews file a session under the area in its tag: a retag must not
    // move months already reviewed.
    expect(renamedAlias("Write paper #task/research/x", "Write the paper #task/other/x")).toBe(
      "Write the paper #task/research/x"
    );
    expect(renamedAlias("Write paper", "Write the paper #task/other/x")).toBe("Write the paper");
  });

  it.each([
    ["a retag alone", "Write paper #task/research/x", "Write paper #task/other/x"],
    ["spacing", "Write  draft #task/x", "Write draft #task/x"],
    ["a field", "Write docs", "Write docs ⛔ xyz789 🏁 delete"],
    ["the count", "Write docs 🍅 4", "Write docs 🍅 9"],
    ["brackets the log wrote as parentheses", "Fix (bug) a: b", "Fix [bug] a:: b"],
  ])("is no rename for %s", (_label, logged, name) => {
    expect(renamedAlias(logged, name)).toBeNull();
  });

  it("splits a name into its words and its tags by the Tasks grammar", () => {
    expect(nameTags("Write #a paper #task/research/x C#")).toEqual(["#a", "#task/research/x"]);
    expect(nameWithoutTags("Write #a paper  #task/research/x")).toBe("Write paper");
    expect(loggedNameKey("Write  docs 🍅 3 #x ⌛ 2026-10-01")).toBe("Write docs");
  });

  it("reads a task line's created date", () => {
    expect(taskCreatedDate("Write 🆔 q ➕ 2026-09-11 ⏳ 2026-09-12")).toBe("2026-09-11");
    expect(taskCreatedDate("Write 🆔 q")).toBeNull();
  });
});

describe("Refresh's words", () => {
  it("shows the first three different examples, old → new", () => {
    const renamed = [
      { from: "A", to: "B" },
      { from: "A", to: "B" },
      { from: "C", to: "D" },
      { from: "E", to: "F" },
      { from: "G", to: "H" },
    ];
    expect(refreshExamples(renamed)).toEqual(["A → B", "C → D", "E → F"]);
  });

  it("says what it left alone, and nothing when it left nothing", () => {
    expect(refreshLeftAlone(emptyRefreshSkips(), 0)).toBe("");
    expect(
      refreshLeftAlone(
        { unresolved: 1, missing: 2, duplicate: 1, beforeCreated: 1, unreadable: 1 },
        2
      )
    ).toBe(
      " Left alone: 3 line(s) whose task couldn't be found, 1 line(s) whose 🆔 is on tasks that can't be told apart, " +
        "1 line(s) from before their task was created, 1 line(s) whose task's note couldn't be read. " +
        "Couldn't read or write 2 log file(s)."
    );
  });
});

/* ===== LogManager: the log side ===== */

const v2 = (path: string, name: string, id: string, start = "2026-10-02 09:00:00") =>
  `- 🍅 Focus [Task:: [[${path}|${name}]]] [ID:: ${id}] [Start:: ${start}] ` +
  "[End:: 2026-10-02 09:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] " +
  "[Status:: finished] [Type:: focus] [Overtime:: 0]";
const v1 = (path: string, name: string, id: string) =>
  `- 🍅 Focus | Task:: [[${path}|${name}]] | ID:: ${id} | Start:: 2026-09-30 09:00:00 | ` +
  "End:: 2026-09-30 09:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus";
const DOCS = "Projects/Docs.md";
const LOG = "Logs/2026-10-02-gentle-pomodoro-log.md";
const OLD_LOG = "Logs/2026-09-30-gentle-pomodoro-log.md";

function managerFor(vault: FakeVault, settings: Record<string, unknown> = {}) {
  const plugin = {
    settings: { logFolderPath: "Logs", ...settings },
    app: { vault, metadataCache: linkCache(vault) },
  } as unknown as GentlePomoPlugin;
  return new LogManager(plugin);
}

const renameOf = (
  name: string,
  extra: { createdDate?: string | null; taskPath?: string; copies?: string[] } = {}
) => ({
  taskId: "abc123",
  name,
  taskPath: extra.taskPath ?? DOCS,
  createdDate: extra.createdDate ?? null,
  line: `- [ ] ${name} 🆔 abc123`,
  copies: extra.copies ?? [],
});

describe("LogManager.updateLoggedTaskName — which lines are the task's", () => {
  beforeEach(() => {
    Notice.shown.length = 0;
  });

  it("leaves the sessions of a ticked copy alone when the open copy is renamed (F2)", async () => {
    // Copied forward: V7.4 ticked, V7.5 open, one 🆔. Renaming V7.5 rewrote
    // every line with the 🆔 — the V7.4 sessions became V7.5b too.
    const vault = fakeVault({
      [DOCS]: "- [x] Update codebook to V7.4 🆔 abc123\n- [ ] Update codebook to V7.5b 🆔 abc123\n",
      [LOG]: [
        v2(DOCS, "Update codebook to V7.4", "abc123"),
        v2(DOCS, "Update codebook to V7.5", "abc123"),
        v2(DOCS, "Update codebook to V7.3", "abc123"),
      ].join("\n"),
    });

    await managerFor(vault).updateLoggedTaskName(
      renameOf("Update codebook to V7.5b", { copies: ["- [x] Update codebook to V7.4 🆔 abc123"] })
    );

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(DOCS, "Update codebook to V7.4", "abc123"),
      v2(DOCS, "Update codebook to V7.5b", "abc123"),
      // A name no copy has is the open copy's, as Refresh reads it.
      v2(DOCS, "Update codebook to V7.5b", "abc123"),
    ]);
  });

  it.each([
    ["a [[link]]", "Read [[Paper]] ch", "Read Paper ch"],
    ["brackets", "Check [x] ch", "Check (x) ch"],
    ["a ::", "A::B ch", "A:B ch"],
  ])(
    "leaves a ticked copy's sessions alone when the task's text has %s (F23)",
    async (_label, raw, logged) => {
      // The log wrote the name sanitized: compared with the raw line it named
      // no copy, and the ch1 sessions were renamed to ch3 with the rest.
      const ticked = `- [x] ${raw}1 🆔 abc123 ✅ 2026-10-01`;
      const vault = fakeVault({
        [DOCS]: `${ticked}\n- [ ] ${raw}3 🆔 abc123\n`,
        [LOG]: [v2(DOCS, `${logged}1`, "abc123"), v2(DOCS, `${logged}2`, "abc123")].join("\n"),
      });

      await managerFor(vault).updateLoggedTaskName(renameOf(`${raw}3`, { copies: [ticked] }));

      expect(vault.contents[LOG].split("\n")).toEqual([
        v2(DOCS, `${logged}1`, "abc123"),
        v2(DOCS, `${logged}3`, "abc123"),
      ]);
    }
  );

  it("renames no line it cannot tell apart from another open copy (F2)", async () => {
    const vault = fakeVault({
      [DOCS]: "- [ ] Draft v2 🆔 abc123\n- [ ] Draft v3 🆔 abc123\n",
      [LOG]: [v2(DOCS, "Draft v1", "abc123"), v2(DOCS, "Draft v3", "abc123")].join("\n"),
    });
    const before = vault.contents[LOG];

    await managerFor(vault).updateLoggedTaskName(
      renameOf("Draft v2", { copies: ["- [ ] Draft v3 🆔 abc123"] })
    );

    expect(vault.contents[LOG]).toBe(before);
    expect(vault.writes).toEqual([]);
  });

  it("renames only the lines whose own link leads to the task's note (F11)", async () => {
    // A line copied into another note keeps its 🆔: that note's sessions are
    // that task's, and were renamed and repointed to this one.
    const vault = fakeVault({
      [DOCS]: "- [ ] New name 🆔 abc123\n",
      "Projects/B.md": "- [ ] Task in B 🆔 abc123\n",
      [LOG]: [v2(DOCS, "Old name", "abc123"), v2("Projects/B.md", "Task in B", "abc123")].join(
        "\n"
      ),
    });

    await managerFor(vault).updateLoggedTaskName(renameOf("New name"));

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(DOCS, "New name", "abc123"),
      v2("Projects/B.md", "Task in B", "abc123"),
    ]);
  });

  it("takes the link as an exact path when Obsidian's link resolution finds nothing", async () => {
    const vault = fakeVault({ [DOCS]: "", [LOG]: v2(DOCS, "Old", "abc123") });
    const lm = new LogManager({
      settings: { logFolderPath: "Logs" },
      app: { vault, metadataCache: { getFirstLinkpathDest: () => null } },
    } as unknown as GentlePomoPlugin);

    await lm.updateLoggedTaskName(renameOf("New"));

    expect(vault.contents[LOG]).toBe(v2(DOCS, "New", "abc123"));
  });

  it("follows a link Obsidian shortened when the note moved, and gives it the full path (F10)", async () => {
    const path = "Projects/02 Design Projects/Toy.md";
    const vault = fakeVault({
      [path]: "- [ ] New name 🆔 abc123\n",
      [LOG]: [
        v2("Toy", "Old name", "abc123"),
        v2("Gone/Toy2.md", "Old name", "abc123"),
        // Hand-written heading links: the note is what comes before the first #.
        v2("Toy#Plan#Week 1", "Old name", "abc123"),
        v2(`${path}#^b1`, "Old name", "abc123"),
      ].join("\n"),
    });

    await managerFor(vault).updateLoggedTaskName(renameOf("New name", { taskPath: path }));

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(path, "New name", "abc123"),
      // A link that leads to no note is no line of this task.
      v2("Gone/Toy2.md", "Old name", "abc123"),
      // Renamed, given the full path, and the heading or block kept.
      v2(`${path}#Plan#Week 1`, "New name", "abc123"),
      v2(`${path}#^b1`, "New name", "abc123"),
    ]);
  });

  it("keeps each line's own tags (F54), and leaves a retag alone", async () => {
    const vault = fakeVault({
      [DOCS]: "",
      [LOG]: [
        v2(DOCS, "Write paper #task/research/x", "abc123"),
        v2(DOCS, "Write paper #task/other/x", "abc123"),
      ].join("\n"),
    });

    await managerFor(vault).updateLoggedTaskName(renameOf("Write the paper #task/other/x"));

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(DOCS, "Write the paper #task/research/x", "abc123"),
      v2(DOCS, "Write the paper #task/other/x", "abc123"),
    ]);

    const retag = fakeVault({
      [DOCS]: "",
      [LOG]: v2(DOCS, "Write paper #task/research/x", "abc123"),
    });
    await managerFor(retag).updateLoggedTaskName(renameOf("Write paper #task/other/x"));
    expect(retag.writes).toEqual([]);
  });

  it("leaves a line whose name differs only by spacing or a Tasks field (F34, F63)", async () => {
    const vault = fakeVault({
      [DOCS]: "",
      [LOG]: [v2(DOCS, "Write  docs", "abc123"), v2(DOCS, "Write docs ⛔ old111", "abc123")].join(
        "\n"
      ),
    });

    await managerFor(vault).updateLoggedTaskName(renameOf("Write docs ⛔ xyz789"));

    expect(vault.writes).toEqual([]);
  });

  it.each([["$1"], ["$&"], ["$$"], ["$'"], ["$`"], ["$<name>"]])(
    "writes a '%s' in the new name as it is (F4)",
    async (pattern) => {
      const vault = fakeVault({
        [DOCS]: "",
        [LOG]: [v1(DOCS, "Old", "abc123"), v2(DOCS, "Old", "abc123")].join("\n"),
      });
      const name = `Pay ${pattern}120 invoice`;

      await managerFor(vault).updateLoggedTaskName(renameOf(name));

      expect(vault.contents[LOG].split("\n")).toEqual([
        v1(DOCS, name, "abc123"),
        v2(DOCS, name, "abc123"),
      ]);
      for (const line of vault.contents[LOG].split("\n")) {
        expect(parseLogLine(line)?.task).toMatchObject({ path: DOCS, name });
      }
    }
  );

  it("leaves a session that began before the task was created", async () => {
    // The 🆔 was given to a task made later; the session is another task's.
    const vault = fakeVault({
      [DOCS]: "",
      [LOG]: [
        v2(DOCS, "Old", "abc123", "2026-09-05 20:13:00"),
        v2(DOCS, "Old", "abc123", "2026-09-11 08:00:00"),
      ].join("\n"),
    });

    await managerFor(vault).updateLoggedTaskName(renameOf("New", { createdDate: "2026-09-11" }));

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(DOCS, "Old", "abc123", "2026-09-05 20:13:00"),
      v2(DOCS, "New", "abc123", "2026-09-11 08:00:00"),
    ]);
  });

  it("writes through Vault.process, only the files that change, and keeps CRLF", async () => {
    const vault = fakeVault({
      [DOCS]: "",
      [OLD_LOG]: `${v1(DOCS, "Old", "abc123")}\r\n${v1(DOCS, "Other", "zzz999")}\r\n`,
      [LOG]: v2(DOCS, "Other", "zzz999"),
    });
    vault.modify = () => Promise.reject(new Error("modify is a read-then-write: never"));

    await managerFor(vault).updateLoggedTaskName(renameOf("New"));

    expect(vault.writes).toEqual([OLD_LOG]);
    expect(vault.contents[OLD_LOG]).toBe(
      `${v1(DOCS, "New", "abc123")}\r\n${v1(DOCS, "Other", "zzz999")}\r\n`
    );
  });

  it("reads each line's link from its log file, as Obsidian does", async () => {
    // Two notes named Toy. A link Obsidian rewrote as a relative path (its
    // "Relative path to file" link format) leads, from the log file, to the
    // task's note; read without the log file's path, `../Toy` is the other Toy.
    const NESTED_LOG = "Pomodoro/Logs/2026-10-02-gentle-pomodoro-log.md";
    const TOY = "Pomodoro/Toy.md";
    const vault = fakeVault({
      "Toy.md": "A different note\n",
      [TOY]: "- [ ] New name 🆔 abc123\n",
      [NESTED_LOG]: [v2("../Toy", "Old name", "abc123"), v2("Toy", "Old name", "abc123")].join(
        "\n"
      ),
    });
    const cache = linkCache(vault);
    const lm = new LogManager({
      settings: { logFolderPath: "Pomodoro/Logs" },
      app: { vault, metadataCache: cache },
    } as unknown as GentlePomoPlugin);

    await lm.updateLoggedTaskName(renameOf("New name", { taskPath: TOY }));

    expect(vault.contents[NESTED_LOG].split("\n")).toEqual([
      v2(TOY, "New name", "abc123"),
      // From the log file `[[Toy]]` is the Toy at the root, not the task's.
      v2("Toy", "Old name", "abc123"),
    ]);
    expect(cache.sources.length).toBeGreaterThan(0);
    expect(new Set(cache.sources)).toEqual(new Set([NESTED_LOG]));
  });

  it("keeps a session line appended between the read and the write (F25)", async () => {
    const vault = fakeVault({ [DOCS]: "", [LOG]: v2(DOCS, "Old", "abc123") });
    const read = vault.read;
    vault.read = async (file) => {
      const text = await read(file);
      // A session ends while the walk holds what it read.
      vault.contents[LOG] += `\n${v2(DOCS, "New", "abc123")}`;
      return text;
    };

    await managerFor(vault).updateLoggedTaskName(renameOf("New"));

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(DOCS, "New", "abc123"),
      v2(DOCS, "New", "abc123"),
    ]);
  });

  it("carries on past a file it cannot read, and says so (F41)", async () => {
    const vault = fakeVault({
      [DOCS]: "",
      "Logs/2026-09-29-gentle-pomodoro-log.md": v2(DOCS, "Old", "abc123"),
      [OLD_LOG]: v2(DOCS, "Old", "abc123"),
      [LOG]: v2(DOCS, "Old", "abc123"),
    });
    const read = vault.read;
    vault.read = (file) =>
      file.path === OLD_LOG ? Promise.reject(new Error("ENOENT")) : read(file);

    await managerFor(vault).updateLoggedTaskName(renameOf("New"));

    expect(vault.contents["Logs/2026-09-29-gentle-pomodoro-log.md"]).toBe(
      v2(DOCS, "New", "abc123")
    );
    expect(vault.contents[LOG]).toBe(v2(DOCS, "New", "abc123"));
    expect(vault.contents[OLD_LOG]).toBe(v2(DOCS, "Old", "abc123"));
    expect(Notice.shown).toEqual([
      'Gentle pomodoro: couldn\'t rename the task in 1 log file(s). Run "Refresh log task names by ID" to try again.',
    ]);
  });
});

describe("LogManager.scheduleTaskRename — after the typing stops (F26)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes only the last of quick renames, once, after the delay", async () => {
    const vault = fakeVault({ [DOCS]: "", [OLD_LOG]: v1(DOCS, "Write chapter", "abc123") });
    const lm = managerFor(vault);

    lm.scheduleTaskRename(renameOf("Write chapter 3 dr"));
    await vi.advanceTimersByTimeAsync(TASK_RENAME_DELAY_MS - 1);
    lm.scheduleTaskRename(renameOf("Write chapter 3 draft"));
    await vi.advanceTimersByTimeAsync(TASK_RENAME_DELAY_MS - 1);
    await lm.walksSettled();
    expect(vault.writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await lm.walksSettled();
    expect(vault.writes).toEqual([OLD_LOG]);
    expect(vault.contents[OLD_LOG]).toBe(v1(DOCS, "Write chapter 3 draft", "abc123"));
  });

  it("runs one walk at a time", async () => {
    const vault = fakeVault({
      [DOCS]: "",
      [OLD_LOG]: [v1(DOCS, "A", "abc123"), v1(DOCS, "B", "def456")].join("\n"),
    });
    const lm = managerFor(vault);
    const reads: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vault.read;
    vault.read = async (file) => {
      reads.push(file.path);
      if (reads.length === 1) await gate;
      return read(file);
    };

    lm.scheduleTaskRename(renameOf("A2"));
    lm.scheduleTaskRename({ ...renameOf("B2"), taskId: "def456" });
    await vi.advanceTimersByTimeAsync(TASK_RENAME_DELAY_MS);
    expect(reads).toEqual([OLD_LOG]);

    release();
    await lm.walksSettled();
    expect(reads).toEqual([OLD_LOG, OLD_LOG]);
    expect(vault.contents[OLD_LOG]).toBe(
      [v1(DOCS, "A2", "abc123"), v1(DOCS, "B2", "def456")].join("\n")
    );
  });

  it("follows the note when it moves before the walk", async () => {
    const vault = fakeVault({
      "Archive/Docs.md": "",
      [OLD_LOG]: v1("Archive/Docs.md", "Old", "abc123"),
    });
    const lm = managerFor(vault);

    lm.scheduleTaskRename(renameOf("New"));
    lm.taskNoteMoved(DOCS, "Archive/Docs.md");
    await vi.advanceTimersByTimeAsync(TASK_RENAME_DELAY_MS);
    await lm.walksSettled();

    expect(vault.contents[OLD_LOG]).toBe(v1("Archive/Docs.md", "New", "abc123"));
  });

  it("goes on after a walk that fails: later renames and Refresh still write", async () => {
    // One failed walk must not leave the queue rejected, or every rename and
    // Refresh write after it would silently never run.
    const vault = fakeVault({
      [DOCS]: "- [ ] Newest 🆔 abc123\n",
      [OLD_LOG]: v1(DOCS, "Old", "abc123"),
    });
    const lm = managerFor(vault);
    const lookup = vault.getAbstractFileByPath;
    vault.getAbstractFileByPath = (path) => {
      if (path !== "Logs") return lookup(path);
      vault.getAbstractFileByPath = lookup;
      throw new Error("vault not ready");
    };

    lm.scheduleTaskRename(renameOf("New"));
    await vi.advanceTimersByTimeAsync(TASK_RENAME_DELAY_MS);
    await lm.walksSettled();
    expect(vault.writes).toEqual([]);

    lm.scheduleTaskRename(renameOf("Newer"));
    await vi.advanceTimersByTimeAsync(TASK_RENAME_DELAY_MS);
    await lm.walksSettled();
    expect(vault.contents[OLD_LOG]).toBe(v1(DOCS, "Newer", "abc123"));

    await lm.refreshLoggedTaskNamesById(() => Promise.resolve(true));
    expect(vault.contents[OLD_LOG]).toBe(v1(DOCS, "Newest", "abc123"));
  });

  it("drops a waiting rename when the plugin unloads", async () => {
    const vault = fakeVault({ [DOCS]: "", [OLD_LOG]: v1(DOCS, "Old", "abc123") });
    const lm = managerFor(vault);

    lm.scheduleTaskRename(renameOf("New"));
    lm.dispose();
    lm.scheduleTaskRename(renameOf("Newer"));
    await vi.advanceTimersByTimeAsync(TASK_RENAME_DELAY_MS * 2);
    await lm.walksSettled();

    expect(vault.writes).toEqual([]);
  });
});

describe("LogManager.refreshLoggedTaskNamesById — ask, then write (F12)", () => {
  const yes = () => Promise.resolve(true);

  beforeEach(() => {
    Notice.shown.length = 0;
    Modal.opened = null;
  });

  function refreshVault(note: string, log: string[], extra: Record<string, string> = {}) {
    return fakeVault({ [DOCS]: note, [LOG]: log.join("\n"), ...extra });
  }

  it("asks with the count and three examples, and Cancel writes nothing", async () => {
    const vault = refreshVault(
      "- [ ] One 🆔 a1\n- [ ] Two 🆔 a2\n- [ ] Three 🆔 a3\n- [ ] Four 🆔 a4\n",
      [v2(DOCS, "1", "a1"), v2(DOCS, "2", "a2"), v2(DOCS, "3", "a3"), v2(DOCS, "4", "a4")]
    );
    const lm = managerFor(vault);

    const run = lm.refreshLoggedTaskNamesById();
    await vi.waitFor(() => {
      expect(Modal.opened).not.toBeNull();
    });
    const dialog = Modal.opened as Modal;
    expect(dialog.titleEl.text).toBe("Update task names in the log?");
    expect(dialog.contentEl.paragraphs).toEqual([
      "4 log line(s) in 1 file(s) will take their task's current name. Each line keeps its own tags.",
      "1 → One",
      "2 → Two",
      "3 → Three",
    ]);
    const [cancel, update] = dialog.contentEl.settings[0].components;
    expect(update.buttonText).toBe("Update 4 line(s)");
    expect(vault.writes).toEqual([]);

    cancel.click?.();
    await run;
    expect(vault.writes).toEqual([]);
    expect(Notice.shown).toEqual([]);
  });

  it("writes once the dialog says yes", async () => {
    const vault = refreshVault("- [ ] One 🆔 a1\n", [v2(DOCS, "1", "a1")]);

    const run = managerFor(vault).refreshLoggedTaskNamesById();
    await vi.waitFor(() => {
      expect(Modal.opened).not.toBeNull();
    });
    (Modal.opened as Modal).contentEl.settings[0].components[1].click?.();
    await run;

    expect(vault.contents[LOG]).toBe(v2(DOCS, "One", "a1"));
    expect(Notice.shown).toEqual(["Gentle pomodoro: updated 1 line(s) in 1 file(s)."]);
  });

  it("leaves a session from before its task was created, comparing dates only", async () => {
    // The real case: a session on 09-05 under a 🆔 whose line says ➕ 09-11.
    // The last line was written under Arabic before 0.6.9 (F14): its date is
    // read in any script's digits.
    const vault = refreshVault("- [x] Create a document 🆔 1ct3mi ➕ 2026-09-11\n", [
      v2(DOCS, "Reorganize the codebook", "1ct3mi", "2026-09-05 20:13:00"),
      v2(DOCS, "Make a doc", "1ct3mi", "2026-09-11 08:00:00"),
      v2(DOCS, "Make a doc", "1ct3mi", "2026-09-12 08:00:00"),
      v2(DOCS, "Reorganize", "1ct3mi", "٢٠٢٦-٠٩-٠٥ ٢٠:١٣:٠٠"),
    ]);

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(DOCS, "Reorganize the codebook", "1ct3mi", "2026-09-05 20:13:00"),
      v2(DOCS, "Create a document", "1ct3mi", "2026-09-11 08:00:00"),
      v2(DOCS, "Create a document", "1ct3mi", "2026-09-12 08:00:00"),
      v2(DOCS, "Reorganize", "1ct3mi", "٢٠٢٦-٠٩-٠٥ ٢٠:١٣:٠٠"),
    ]);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: updated 2 line(s) in 1 file(s). Left alone: 2 line(s) from before their task was created.",
    ]);
  });

  it("follows a shortened link, and gives a renamed line the full path (F10)", async () => {
    const path = "Projects/02 Design Projects/Toy.md";
    const vault = fakeVault({
      [path]: "- [ ] Toy design 🆔 eqzaoz\n",
      [LOG]: [
        v2("Toy", "Toy idea", "eqzaoz"),
        v2("Toy", "Toy design", "eqzaoz"),
        v2("Toy#Plan", "Toy idea", "eqzaoz"),
      ].join("\n"),
    });

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(path, "Toy design", "eqzaoz"),
      // Not renamed, so not rewritten: its short link stays.
      v2("Toy", "Toy design", "eqzaoz"),
      // A heading link leads to its note too, and keeps its heading.
      v2(`${path}#Plan`, "Toy design", "eqzaoz"),
    ]);
  });

  it("reads each line's link from its log file, as Obsidian does", async () => {
    // As for the automatic rename: from the log file, the relative `../Toy`
    // is the task's note; read without the log file's path it is the other
    // Toy, which has no line with the 🆔.
    const NESTED_LOG = "Pomodoro/Logs/2026-10-02-gentle-pomodoro-log.md";
    const TOY = "Pomodoro/Toy.md";
    const vault = fakeVault({
      "Toy.md": "A different note\n",
      [TOY]: "- [ ] New name 🆔 abc123\n",
      [NESTED_LOG]: [v2("../Toy", "Old name", "abc123"), v2("Toy", "Old name", "abc123")].join(
        "\n"
      ),
    });
    const cache = linkCache(vault);
    const lm = new LogManager({
      settings: { logFolderPath: "Pomodoro/Logs" },
      app: { vault, metadataCache: cache },
    } as unknown as GentlePomoPlugin);

    await lm.refreshLoggedTaskNamesById(yes);

    expect(vault.contents[NESTED_LOG].split("\n")).toEqual([
      v2(TOY, "New name", "abc123"),
      // From the log file `[[Toy]]` is the Toy at the root: no 🆔 there.
      v2("Toy", "Old name", "abc123"),
    ]);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: updated 1 line(s) in 1 file(s). Left alone: 1 line(s) whose task couldn't be found.",
    ]);
    expect(cache.sources.length).toBeGreaterThan(0);
    expect(new Set(cache.sources)).toEqual(new Set([NESTED_LOG]));
  });

  it("keeps a CRLF log's line endings (F15)", async () => {
    const vault = fakeVault({
      [DOCS]: "- [ ] New 🆔 abc123\r\n- [ ] Other 🆔 zzz999\r\n",
      [LOG]: `${v2(DOCS, "Old", "abc123")}\r\n${v2(DOCS, "Other", "zzz999")}\r\n`,
    });

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.contents[LOG]).toBe(
      `${v2(DOCS, "New", "abc123")}\r\n${v2(DOCS, "Other", "zzz999")}\r\n`
    );
    expect(Notice.shown).toEqual(["Gentle pomodoro: updated 1 line(s) in 1 file(s)."]);
  });

  it("gives a line under no copy's name the one open copy's, and leaves a ticked copy's (F2)", async () => {
    const vault = refreshVault(
      "- [x] Update codebook to V7.4 🆔 qfd97u\n- [ ] Update codebook to V7.6 🆔 qfd97u\n",
      [v2(DOCS, "Update codebook to V7.4", "qfd97u"), v2(DOCS, "Update codebook to V7.5", "qfd97u")]
    );

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(DOCS, "Update codebook to V7.4", "qfd97u"),
      v2(DOCS, "Update codebook to V7.6", "qfd97u"),
    ]);
    expect(Notice.shown).toEqual(["Gentle pomodoro: updated 1 line(s) in 1 file(s)."]);
  });

  it.each([
    ["a [[link]]", "Read [[Paper]] ch", "Read Paper ch"],
    ["brackets", "Check [x] ch", "Check (x) ch"],
    ["a ::", "A::B ch", "A:B ch"],
    ["a priority mid-text", "Fix ⏫ login bug v", "Fix bug v"],
  ])(
    "leaves a ticked copy's sessions alone when the task's text has %s (F23)",
    async (_label, raw, logged) => {
      const vault = refreshVault(
        `- [x] ${raw}1 🆔 abc123 ✅ 2026-10-01\n- [ ] ${raw}3 🆔 abc123\n`,
        [v2(DOCS, `${logged}1`, "abc123"), v2(DOCS, `${logged}2`, "abc123")]
      );

      await managerFor(vault).refreshLoggedTaskNamesById(yes);

      expect(vault.contents[LOG].split("\n")).toEqual([
        v2(DOCS, `${logged}1`, "abc123"),
        v2(DOCS, `${logged}3`, "abc123"),
      ]);
      expect(Notice.shown).toEqual(["Gentle pomodoro: updated 1 line(s) in 1 file(s)."]);
    }
  );

  it("never renames a 🆔 whose copies it cannot tell apart (F2)", async () => {
    const vault = refreshVault(
      "- [ ] Update codebook to V7.6 🆔 qfd97u\n- [ ] Update codebook to V7.7 🆔 qfd97u\n" +
        "- [x] Old 🆔 done1\n- [x] Older 🆔 done1\n",
      [v2(DOCS, "Update codebook to V7.5", "qfd97u"), v2(DOCS, "Oldest", "done1")]
    );

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.writes).toEqual([]);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: no task names to update. Left alone: 2 line(s) whose 🆔 is on tasks that can't be told apart.",
    ]);
  });

  it("keeps each line's own tags (F54)", async () => {
    const vault = refreshVault("- [ ] Write the paper #task/other/x 🆔 abc123\n", [
      v2(DOCS, "Write paper #task/research/x", "abc123"),
      v2(DOCS, "Write the paper #task/research/x", "abc123"),
    ]);

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(DOCS, "Write the paper #task/research/x", "abc123"),
      v2(DOCS, "Write the paper #task/research/x", "abc123"),
    ]);
  });

  it.each([["$1"], ["$&"], ["$$"], ["$'"], ["$`"]])(
    "writes a '%s' in a name as it is (F4)",
    async (pattern) => {
      const name = `Budget ${pattern}100 for ads`;
      const vault = refreshVault(`- [ ] ${name} 🆔 abc123\n`, [
        v1(DOCS, "Budget", "abc123"),
        v2(DOCS, name, "abc123"),
      ]);

      await managerFor(vault).refreshLoggedTaskNamesById(yes);

      expect(vault.contents[LOG].split("\n")).toEqual([
        v1(DOCS, name, "abc123"),
        v2(DOCS, name, "abc123"),
      ]);
      expect(Notice.shown).toEqual(["Gentle pomodoro: updated 1 line(s) in 1 file(s)."]);
    }
  );

  it("counts what it could not find or read, and carries on (F41)", async () => {
    const vault = fakeVault({
      [DOCS]: "- [ ] New 🆔 abc123\n",
      "Projects/Unreadable.md": "- [ ] Whatever 🆔 u1\n",
      "Logs/2026-09-29-gentle-pomodoro-log.md": v2(DOCS, "Old", "abc123"),
      [LOG]: [
        v2(DOCS, "Old", "abc123"),
        v2("Projects/Missing.md", "Gone", "m1"),
        v2(DOCS, "Not in the note", "zzz999"),
        v2("Projects/Unreadable.md", "Old", "u1"),
      ].join("\n"),
      [OLD_LOG]: v2(DOCS, "Old", "abc123"),
    });
    const read = vault.read;
    vault.read = (file) =>
      file.path === OLD_LOG || file.path === "Projects/Unreadable.md"
        ? Promise.reject(new Error("EACCES"))
        : read(file);

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.contents["Logs/2026-09-29-gentle-pomodoro-log.md"]).toBe(
      v2(DOCS, "New", "abc123")
    );
    expect(vault.contents[LOG].split("\n")[0]).toBe(v2(DOCS, "New", "abc123"));
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: updated 2 line(s) in 2 file(s). Left alone: 2 line(s) whose task couldn't be found, " +
        "1 line(s) whose task's note couldn't be read. Couldn't read or write 1 log file(s).",
    ]);
  });

  it("writes through Vault.process, planned again on what the file holds then", async () => {
    const vault = refreshVault("- [ ] New 🆔 abc123\n", [v2(DOCS, "Old", "abc123")]);
    vault.modify = () => Promise.reject(new Error("never"));
    const confirm = (options: ConfirmOptions) => {
      expect(options.ctaText).toBe("Update 1 line(s)");
      // A session ends while the dialog is open, still under the old name.
      vault.contents[LOG] += `\n${v2(DOCS, "Old", "abc123", "2026-10-02 10:00:00")}`;
      return Promise.resolve(true);
    };

    await managerFor(vault).refreshLoggedTaskNamesById(confirm);

    expect(vault.contents[LOG].split("\n")).toEqual([
      v2(DOCS, "New", "abc123"),
      v2(DOCS, "New", "abc123", "2026-10-02 10:00:00"),
    ]);
    expect(Notice.shown).toEqual(["Gentle pomodoro: updated 2 line(s) in 1 file(s)."]);
  });

  it("runs one at a time", async () => {
    const vault = refreshVault("- [ ] New 🆔 abc123\n", [v2(DOCS, "Old", "abc123")]);
    const lm = managerFor(vault);
    let answer: ((yes: boolean) => void) | null = null;
    const first = lm.refreshLoggedTaskNamesById(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })
    );
    const second = vi.fn(yes);
    await vi.waitFor(() => {
      expect(answer).not.toBeNull();
    });

    await lm.refreshLoggedTaskNamesById(second);
    (answer as unknown as (yes: boolean) => void)(false);
    await first;

    expect(second).not.toHaveBeenCalled();
    expect(vault.writes).toEqual([]);
  });

  it("can run again once a run has finished", async () => {
    // One at a time, not once per session: every later Refresh would return
    // without a word.
    const vault = refreshVault("- [ ] One 🆔 a1\n", [v2(DOCS, "1", "a1")]);
    const lm = managerFor(vault);
    await lm.refreshLoggedTaskNamesById(yes);
    expect(vault.contents[LOG]).toBe(v2(DOCS, "One", "a1"));

    vault.contents[DOCS] = "- [ ] Uno 🆔 a1\n";
    await lm.refreshLoggedTaskNamesById(yes);

    expect(vault.contents[LOG]).toBe(v2(DOCS, "Uno", "a1"));
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: updated 1 line(s) in 1 file(s).",
      "Gentle pomodoro: updated 1 line(s) in 1 file(s).",
    ]);
  });

  it("says so when the run itself fails, and the next run still goes ahead", async () => {
    const vault = refreshVault("- [ ] One 🆔 a1\n", [v2(DOCS, "1", "a1")]);
    const lm = managerFor(vault);

    await lm.refreshLoggedTaskNamesById(() => Promise.reject(new Error("no dialog")));
    expect(vault.writes).toEqual([]);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: couldn't refresh the task names — see the developer console for details.",
    ]);

    await lm.refreshLoggedTaskNamesById(yes);
    expect(vault.contents[LOG]).toBe(v2(DOCS, "One", "a1"));
  });

  it("counts in the dialog only the log files that will change", async () => {
    const vault = fakeVault({
      [DOCS]: "- [ ] One 🆔 a1\n- [ ] Two 🆔 a2\n",
      [LOG]: [v2(DOCS, "1", "a1"), v2(DOCS, "2", "a2")].join("\n"),
      [OLD_LOG]: v1(DOCS, "One", "a1"),
      "Logs/2026-09-29-gentle-pomodoro-log.md": v2(DOCS, "Uno", "a1"),
    });
    const asked: ConfirmOptions[] = [];
    const confirm = (options: ConfirmOptions) => {
      asked.push(options);
      return Promise.resolve(true);
    };

    await managerFor(vault).refreshLoggedTaskNamesById(confirm);

    // Three log files, one already up to date.
    expect(asked.map((options) => [options.body, options.ctaText])).toEqual([
      [
        "3 log line(s) in 2 file(s) will take their task's current name. Each line keeps its own tags.",
        "Update 3 line(s)",
      ],
    ]);
    expect(vault.writes.slice().sort()).toEqual(["Logs/2026-09-29-gentle-pomodoro-log.md", LOG]);
    expect(Notice.shown).toEqual(["Gentle pomodoro: updated 3 line(s) in 2 file(s)."]);
  });

  it("counts a log file it could read but not write, and carries on (F41)", async () => {
    const UNREADABLE = "Logs/2026-09-28-gentle-pomodoro-log.md";
    const vault = fakeVault({
      [DOCS]: "- [ ] New 🆔 abc123\n",
      [UNREADABLE]: v2(DOCS, "Old", "abc123"),
      [OLD_LOG]: v2(DOCS, "Old", "abc123"),
      [LOG]: v2(DOCS, "Old", "abc123"),
    });
    const { read, process } = vault;
    vault.read = (file) =>
      file.path === UNREADABLE ? Promise.reject(new Error("EACCES")) : read(file);
    vault.process = (file, fn) => {
      if (file.path !== OLD_LOG) return process(file, fn);
      fn(vault.contents[file.path]); // planned on what it holds, then the write fails
      return Promise.reject(new Error("EBUSY"));
    };

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.contents[OLD_LOG]).toBe(v2(DOCS, "Old", "abc123"));
    expect(vault.contents[LOG]).toBe(v2(DOCS, "New", "abc123"));
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: updated 1 line(s) in 1 file(s). Couldn't read or write 2 log file(s).",
    ]);
  });
});

describe("LogManager — a note moved or deleted mid-session (C1)", () => {
  let previousMoment: unknown;
  beforeEach(() => {
    const g = globalThis as unknown as { moment?: unknown };
    previousMoment = g.moment;
    g.moment = createRequire(import.meta.url)("moment");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 2, 9, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { moment?: unknown }).moment = previousMoment;
  });

  function logging(files: Record<string, string>, taskSwitchLogging = "last-task") {
    const vault = fakeVault({ [LOG]: "", ...files });
    Object.assign(vault, {
      adapter: { exists: () => Promise.resolve(true), append: vi.fn() },
      append: (file: TFile, data: string) => {
        vault.contents[file.path] += data;
        return Promise.resolve();
      },
    });
    const lm = new LogManager({
      settings: { logFolderPath: "Logs", dayStartHour: 0, taskSwitchLogging },
      app: { vault, metadataCache: linkCache(vault) },
      invalidateFocusTotalCache: () => {},
    } as unknown as GentlePomoPlugin);
    const tasks = () =>
      vault.contents[LOG].split("\n")
        .map((line) => parseLogLine(line))
        .filter((parsed) => parsed !== null)
        .map((parsed) => ({ raw: parsed.task?.raw, id: parsed.values.get("ID") }));
    return { vault, lm, tasks };
  }

  it("writes the note's new path when it moved, segments included", async () => {
    const { lm, tasks } = logging({ "Archive/A.md": "", "Archive/B.md": "" }, "split");
    lm.startSession("focus", "Task A", 25, "Projects/A.md", "aaa111");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 10, 0));
    lm.updateTask("Task B", "Projects/B.md", "bbb222");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 25, 0));
    lm.taskNoteMoved("Projects", "Archive");

    await lm.endSession("finished");

    expect(tasks()).toEqual([
      { raw: "[[Archive/A.md|Task A]]", id: "aaa111" },
      { raw: "[[Archive/B.md|Task B]]", id: "bbb222" },
    ]);
  });

  // A deleted note is not followed: its lines keep the link as it was, to the
  // note now gone — what Obsidian leaves in the log's older lines of that
  // task. Its 🆔 lookup finds no note to read, and keeps the linked name.
  it("keeps the link as it was when the note is deleted, reading no missing note", async () => {
    const { lm, tasks, vault } = logging({ [DOCS]: "- [ ] Write the docs 🆔 abc123\n" });
    lm.startSession("focus", "Write docs", 25, DOCS, "abc123");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 25, 0));
    vault.remove(vault.getAbstractFileByPath(DOCS) as TFile);

    await lm.endSession("finished");

    expect(tasks()).toEqual([{ raw: `[[${DOCS}|Write docs]]`, id: "abc123" }]);
    expect(DOCS in vault.contents).toBe(false);
  });

  it("keeps a deleted note's link in the segments a split closed, too", async () => {
    // The segment closed by the switch to Task B is written only at the end,
    // with the link it was closed with.
    const { lm, tasks, vault } = logging(
      { "Projects/A.md": "- [ ] Task A 🆔 aaa111\n", "Projects/B.md": "" },
      "split"
    );
    lm.startSession("focus", "Task A", 25, "Projects/A.md", "aaa111");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 10, 0));
    lm.updateTask("Task B", "Projects/B.md", "bbb222");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 25, 0));
    vault.remove(vault.getAbstractFileByPath("Projects/A.md") as TFile);

    await lm.endSession("finished");

    expect(tasks()).toEqual([
      { raw: "[[Projects/A.md|Task A]]", id: "aaa111" },
      { raw: "[[Projects/B.md|Task B]]", id: "bbb222" },
    ]);
  });

  // A folder renamed, as Obsidian says so (FileSystemAdapter.rename, app.js
  // 1.13.7): the folder's own word first, its notes still at their old
  // paths; then each note in it, moved, says so for itself.
  const folderRenamed = (vault: FakeVault, lm: LogManager, from: string, to: string) => {
    lm.taskNoteMoved(from, to);
    for (const path of Object.keys(vault.contents)) {
      if (!path.startsWith(`${from}/`)) continue;
      const moved = to + path.slice(from.length);
      vault.move(vault.getAbstractFileByPath(path) as TFile, moved);
      lm.taskNoteMoved(path, moved);
    }
  };

  it("keeps a deleted note's link as it was when a folder above it is renamed after", async () => {
    // Obsidian updates no link to a note that is gone, older lines included:
    // the line keeps the path it was linked with, never one that never held
    // the note.
    const { lm, tasks, vault } = logging({
      [DOCS]: "- [ ] Write the docs 🆔 abc123\n",
      "Projects/Other.md": "x\n",
    });
    lm.startSession("focus", "Write docs", 25, DOCS, "abc123");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 25, 0));
    vault.remove(vault.getAbstractFileByPath(DOCS) as TFile);
    folderRenamed(vault, lm, "Projects", "Projects 2");

    await lm.endSession("finished");

    expect(tasks()).toEqual([{ raw: `[[${DOCS}|Write docs]]`, id: "abc123" }]);
  });

  it("in a split, follows the moved segment's note and keeps the deleted one's link", async () => {
    const { lm, tasks, vault } = logging(
      { "Projects/A.md": "- [ ] Task A 🆔 aaa111\n", "Projects/B.md": "" },
      "split"
    );
    lm.startSession("focus", "Task A", 25, "Projects/A.md", "aaa111");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 10, 0));
    lm.updateTask("Task B", "Projects/B.md", "bbb222");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 25, 0));
    vault.remove(vault.getAbstractFileByPath("Projects/A.md") as TFile);
    folderRenamed(vault, lm, "Projects", "Archive");

    await lm.endSession("finished");

    expect(tasks()).toEqual([
      { raw: "[[Projects/A.md|Task A]]", id: "aaa111" },
      { raw: "[[Archive/B.md|Task B]]", id: "bbb222" },
    ]);
  });

  it("follows a folder renamed at the folder's own word, before its notes say they moved", async () => {
    // A session that ends in between is written with the new path.
    const { lm, tasks } = logging({ [DOCS]: "- [ ] Write the docs 🆔 abc123\n" });
    lm.startSession("focus", "Write docs", 25, DOCS, "abc123");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 25, 0));
    lm.taskNoteMoved("Projects", "Archive");

    await lm.endSession("finished");

    expect(tasks()).toEqual([{ raw: "[[Archive/Docs.md|Write docs]]", id: "abc123" }]);
  });

  it("leaves a session alone when another note moves", async () => {
    const { lm, tasks } = logging({ [DOCS]: "- [ ] Write docs 🆔 abc123\n" });
    lm.startSession("focus", "Write docs", 25, DOCS, "abc123");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 25, 0));
    lm.taskNoteMoved("Projects/Doc", "Projects/Other");

    await lm.endSession("finished");

    expect(tasks()).toEqual([{ raw: `[[${DOCS}|Write docs]]`, id: "abc123" }]);
  });

  it("logs the linked copy's name when the 🆔 is on several lines (F2)", async () => {
    const { lm, tasks } = logging({
      [DOCS]: "- [x] Update codebook to V7.4 🆔 qfd97u\n- [ ] Update codebook to V7.5 🆔 qfd97u\n",
    });
    lm.startSession("focus", "Update codebook to V7.5", 25, DOCS, "qfd97u");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 25, 0));

    await lm.endSession("finished");

    expect(tasks()).toEqual([{ raw: `[[${DOCS}|Update codebook to V7.5]]`, id: "qfd97u" }]);
  });

  it("follows the one open copy for the task still linked at the end, the copy linked ticked meanwhile", async () => {
    // The timer's live key: the task copied forward (2026-10-04).
    const { lm, tasks, vault } = logging({ [DOCS]: "- [ ] V7.4 🆔 q\n- [ ] V7.5 🆔 q\n" });
    lm.startSession("focus", "V7.4", 25, DOCS, "q");
    vault.contents[DOCS] = "- [x] V7.4 🆔 q\n- [ ] V7.5 🆔 q\n";
    vi.setSystemTime(new Date(2026, 9, 2, 9, 25, 0));

    await lm.endSession("finished");

    expect(tasks()).toEqual([{ raw: `[[${DOCS}|V7.5]]`, id: "q" }]);
  });

  it("a split segment of a copy ticked before the end keeps its own name (F22)", async () => {
    // Copied forward: tick the old copy, pick the new one mid-session. The
    // segment worked on the old copy is history, never the open copy's.
    const { lm, tasks, vault } = logging({ [DOCS]: "- [ ] V7.4 🆔 q\n- [ ] V7.5 🆔 q\n" }, "split");
    lm.startSession("focus", "V7.4", 25, DOCS, "q");
    vi.setSystemTime(new Date(2026, 9, 2, 9, 15, 0));
    lm.updateTask("V7.5", DOCS, "q");
    vault.contents[DOCS] = "- [x] V7.4 🆔 q\n- [ ] V7.5 🆔 q\n";
    vi.setSystemTime(new Date(2026, 9, 2, 9, 25, 0));

    await lm.endSession("finished");

    expect(tasks()).toEqual([
      { raw: `[[${DOCS}|V7.4]]`, id: "q" },
      { raw: `[[${DOCS}|V7.5]]`, id: "q" },
    ]);
  });

  it("a recovered session's split segment of a ticked copy keeps its own name (F22)", async () => {
    const { lm, tasks } = logging({ [DOCS]: "- [x] V7.4 🆔 q\n- [ ] V7.5 🆔 q\n" }, "split");
    const at = (minute: number) => new Date(2026, 9, 2, 9, minute, 0).getTime();

    await lm.logUnfinished({
      mode: "focus",
      taskName: "V7.5",
      taskPath: DOCS,
      taskId: "q",
      startMs: at(0),
      pauses: [],
      pauseStartMs: null,
      scheduledMinutes: 25,
      breakType: null,
      segments: [{ taskName: "V7.4", taskPath: DOCS, taskId: "q", endMs: at(15) }],
      plannedMs: null,
      lastSeenMs: at(25),
    });

    expect(tasks()).toEqual([
      { raw: `[[${DOCS}|V7.4]]`, id: "q" },
      { raw: `[[${DOCS}|V7.5]]`, id: "q" },
    ]);
  });
});

describe("LogManager.findDuplicateTaskIds — for Check log (F2)", () => {
  it("lists the logged 🆔s on task lines of their note that no single open line tells apart", async () => {
    const vault = fakeVault({
      // `twin` is on two lines of a note the log links to, but no line logs
      // it: no session of it can be misnamed, so it is not listed. Nor is
      // `qfd97u`: of its two lines one is open, and that one is the task.
      [DOCS]:
        "- [x] V7.4 🆔 qfd97u\n- [ ] V7.5 🆔 qfd97u\n- [ ] A 🆔 dup2\n- [ ] B 🆔 dup2\n- [ ] C 🆔 one\n" +
        "- [ ] P 🆔 twin\n- [ ] Q 🆔 twin\n- [x] D 🆔 done2\n- [x] E 🆔 done2\n",
      "Projects/Unlogged.md": "- [ ] X 🆔 nolog\n- [ ] Y 🆔 nolog\n",
      [LOG]: [
        v2("Docs", "V7.4", "qfd97u"),
        v2(DOCS, "C", "one"),
        v2(DOCS, "A", "dup2"),
        v2(DOCS, "D", "done2"),
      ].join("\n"),
    });

    expect(await managerFor(vault).findDuplicateTaskIds()).toEqual([
      { taskId: "dup2", path: DOCS },
      { taskId: "done2", path: DOCS },
    ]);
  });
});
