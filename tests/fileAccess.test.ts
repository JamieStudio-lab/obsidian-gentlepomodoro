import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import moment from "moment";
import { normalizePath, type App, type TFile } from "obsidian";
// The recording Notice, imported from the mock by path so `tsc` sees its
// `shown` list (tests/settingTab.test.ts explains why this is the same module).
import { Notice } from "../__mocks__/obsidian";
import { filesInFolder, loadTasks } from "../taskLoader";
import { LogManager } from "../logManager";
import type GentlePomoPlugin from "../main";
import type { TaskScope } from "../taskScope";
import { fakeVault, type FakeVault } from "./fakeVault";

/**
 * 0.6.8 — each feature lists only the files it needs.
 *
 * Obsidian's plugin review flagged "Vault Enumeration": the task picker and
 * the two log rewrites listed every file in the vault and then filtered. They
 * now walk the one folder, or look the named notes up by path. The promise
 * the maintainer asked for is that NOTHING a user can see changes — the same
 * files, read in the same order — so these tests hold the new code to what
 * the old filter selected, and not merely to a list written out by hand.
 *
 * The old filter is kept below VERBATIM rather than imported: an oracle that
 * shares a helper with the code under test moves when that helper does, and
 * the first version of this suite let a broken key through exactly that way.
 * The mock's normalizePath is Obsidian's own, so the settings a user can
 * really type (a leading slash, a no-break space, a decomposed accent) are
 * tested the way Obsidian resolves them.
 *
 * Two features still list the vault, by design, and are not tested here: the
 * sound picker (it offers the vault's audio files to choose from) and the 🍅
 * Check/Repair/Remove sweeps (the counter can write into any note).
 */

const NOW = new Date("2026-09-05T10:00:00");

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  (globalThis as unknown as { moment: unknown }).moment = moment;
});

afterAll(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { moment?: unknown }).moment;
});

const appOf = (vault: FakeVault) => ({ vault }) as unknown as App;
const paths = (files: TFile[]) => files.map((f) => f.path);

/** `isPathInFolder` as 0.6.7 shipped it, character for character. */
function inFolderBefore068(filePath: string, folderPath: string): boolean {
  if (!folderPath) return true;

  const normalizedFolder = normalizePath(folderPath).replace(/\/+$/, "");
  const normalizedPath = normalizePath(filePath);

  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}

/** What the old code selected: every file listed, then filtered. */
const oldFilter = (vault: FakeVault, folder: string) =>
  paths(vault.getFiles().filter((f) => inFolderBefore068(f.path, folder)));

/**
 * Paths `localeCompare` calls equal: they differ only by an invisible
 * character. loadTasks' sort then keeps the order the files were read in,
 * which is the one place that order can be seen at all.
 */
const ZWSP = "\u200B";
const SOFT_HYPHEN = "\u00AD";

const logVault = () =>
  fakeVault({
    "Logs/2026-09-01-gentle-pomodoro-log.md": "one",
    "Logs/2026/09/2026-09-02-gentle-pomodoro-log.md": "two",
    "Logs/sub/a.md": "three",
    "Logs/sub/b.txt": "not markdown",
    [`Logs/sub/a${ZWSP}b.md`]: "tie one",
    "Logs/sub/ab.md": "tie two",
    "Logs/2026/08/2026-08-31-gentle-pomodoro-log.md": "four",
    "Logs-old/2025-12-31-gentle-pomodoro-log.md": "sibling",
    "Logsbook.md": "prefix, no folder",
    "Logs.md": "the folder's name as a file",
    "Other/Logs/x.md": "a Logs folder elsewhere",
    "logs/lower.md": "a different case",
    // Stored the way Obsidian stores them: a plain space, a composed é.
    "My Logs/x.md": "typed with a no-break space",
    "Café/y.md": "typed decomposed",
    "__proto__/z.md": "a name a plain object cannot hold as a key",
  });

describe("filesInFolder selects exactly what the old filter did", () => {
  const cases = [
    "Logs",
    "Logs/",
    "Logs//",
    "Logs/sub",
    "Logs/2026",
    "Logs-old",
    "Other/Logs",
    "logs",
    "Missing",
    "Logs/Missing",
    "/",
    "//",
    "Logs/sub/a.md",
    "Logs.md",
    // How Obsidian's normalizePath reads what a user may type.
    "/Logs",
    "/Logs/sub/",
    "Logs//sub",
    "Logs\\sub",
    "./Logs",
    " Logs",
    "My\u00A0Logs",
    "My\u202FLogs",
    "Cafe\u0301",
    "__proto__",
    "/__proto__/",
  ];

  for (const folder of cases) {
    it(`same files, same order, for ${JSON.stringify(folder)}`, () => {
      const vault = logVault();
      expect(paths(filesInFolder(appOf(vault), folder))).toEqual(oldFilter(vault, folder));
    });
  }

  it("walks nested subfolders and stops at the folder's edge", () => {
    const found = paths(filesInFolder(appOf(logVault()), "Logs")).sort();

    expect(found).toEqual(
      [
        "Logs/2026-09-01-gentle-pomodoro-log.md",
        "Logs/2026/08/2026-08-31-gentle-pomodoro-log.md",
        "Logs/2026/09/2026-09-02-gentle-pomodoro-log.md",
        "Logs/sub/a.md",
        `Logs/sub/a${ZWSP}b.md`,
        "Logs/sub/ab.md",
        "Logs/sub/b.txt",
      ].sort()
    );
  });

  it("takes a trailing slash as the same folder", () => {
    const app = appOf(logVault());
    expect(paths(filesInFolder(app, "Logs/"))).toEqual(paths(filesInFolder(app, "Logs")));
    expect(paths(filesInFolder(app, "Logs/"))).toHaveLength(7);
  });

  it("does not take a sibling that only shares the name's start", () => {
    const found = paths(filesInFolder(appOf(logVault()), "Logs"));
    expect(found.some((p) => p.startsWith("Logs-old/"))).toBe(false);
    expect(found).not.toContain("Logsbook.md");
    expect(found).not.toContain("Logs.md");
  });

  it("finds nothing for a missing folder, or for '/'", () => {
    const app = appOf(logVault());
    expect(filesInFolder(app, "Missing")).toEqual([]);
    // "/" keys to "", and Obsidian keys the vault root as "/" — so it is not
    // the root, and the old filter matched no file for it either.
    expect(filesInFolder(app, "/")).toEqual([]);
  });

  it("reads a setting the way Obsidian does", () => {
    const app = appOf(logVault());
    expect(paths(filesInFolder(app, "/Logs"))).toHaveLength(7);
    expect(paths(filesInFolder(app, "Logs\\sub"))).toHaveLength(4);
    expect(paths(filesInFolder(app, "My\u00A0Logs"))).toEqual(["My Logs/x.md"]);
    expect(paths(filesInFolder(app, "Cafe\u0301"))).toEqual(["Caf\u00E9/y.md"]);
  });

  it("finds a top-level folder named __proto__, which the path lookup cannot", () => {
    const vault = logVault();
    // The quirk, as Obsidian has it: the folder is in the tree, not in the map.
    expect(vault.getAbstractFileByPath("__proto__")).toBeNull();
    expect(paths(filesInFolder(appOf(vault), "__proto__"))).toEqual(["__proto__/z.md"]);
  });

  it("never lists the vault to do it", () => {
    const vault = logVault();
    filesInFolder(appOf(vault), "Logs");
    filesInFolder(appOf(vault), "Missing");
    expect(vault.getFiles).not.toHaveBeenCalled();
  });

  it("gives the file order Obsidian's own list gives, not a tidier one", () => {
    // The fixture puts "2026/08" after "2026/09" and the tie pair after "a.md",
    // so any walk other than Obsidian's (last child first) reorders something.
    const vault = logVault();
    const order = paths(filesInFolder(appOf(vault), "Logs"));

    expect(order).toEqual(oldFilter(vault, "Logs"));
    expect(order).not.toEqual([...order].sort());
  });
});

const folder = (tasksPath: string): TaskScope => ({ kind: "folder", tasksPath });
const notes = (...notePaths: string[]): TaskScope => ({ kind: "notes", paths: notePaths });

describe("loadTasks reads only what its scope names", () => {
  const taskVault = () =>
    fakeVault({
      "Projects/a.md": "- [ ] In projects 📅 2026-09-05",
      "Projects/deep/b.md": "- [ ] Deep in projects 📅 2026-09-05",
      "Projects-archive/c.md": "- [ ] In the sibling 📅 2026-09-05",
      "Inbox/d.md": "- [ ] In the inbox 📅 2026-09-05",
      "Inbox/scan.pdf": "- [ ] Not a note 📅 2026-09-05",
    });

  it("walks the tasks folder, with no vault listing", async () => {
    const vault = taskVault();

    const tasks = await loadTasks(appOf(vault), { scope: folder("Projects/") });

    expect(tasks.map((t) => t.cleanText).sort()).toEqual(["Deep in projects", "In projects"]);
    expect(vault.getFiles).not.toHaveBeenCalled();
  });

  it("still lists the whole vault when the tasks path is empty — that is what empty means", async () => {
    const vault = taskVault();

    const tasks = await loadTasks(appOf(vault), { scope: folder("") });

    expect(tasks).toHaveLength(4);
    expect(vault.getFiles).toHaveBeenCalled();
  });

  it("finds nothing for a missing folder", async () => {
    const vault = taskVault();

    expect(await loadTasks(appOf(vault), { scope: folder("Nowhere") })).toEqual([]);
    expect(vault.getFiles).not.toHaveBeenCalled();
  });

  it("looks the named notes up by path, with no vault listing", async () => {
    const vault = taskVault();

    const tasks = await loadTasks(appOf(vault), {
      scope: notes("Inbox/d.md", "Projects/deep/b.md"),
    });

    expect(tasks.map((t) => t.path)).toEqual(["Inbox/d.md", "Projects/deep/b.md"]);
    expect(vault.getFiles).not.toHaveBeenCalled();
  });

  it("skips a named path that is missing, a folder, or not markdown", async () => {
    const vault = taskVault();

    const tasks = await loadTasks(appOf(vault), {
      scope: notes("Inbox/scan.pdf", "Gone.md", "Inbox", "Projects/a.md"),
    });

    expect(tasks.map((t) => t.path)).toEqual(["Projects/a.md"]);
  });

  it("reads a note named twice only once", async () => {
    const vault = taskVault();

    const tasks = await loadTasks(appOf(vault), {
      scope: notes("Inbox/d.md", "Inbox/d.md"),
    });

    expect(tasks).toHaveLength(1);
  });

  it("finds the linked task's note by path too", async () => {
    const vault = taskVault();

    const tasks = await loadTasks(appOf(vault), {
      scope: notes("Inbox/d.md"),
      pin: { path: "Projects-archive/c.md", cleanText: "In the sibling" },
    });

    expect(tasks.map((t) => t.cleanText)).toEqual(["In the inbox", "In the sibling"]);
    expect(tasks[1].pinned).toBe(true);
    expect(vault.getFiles).not.toHaveBeenCalled();
  });
});

describe("loadTasks keeps the old order where the sort ties", () => {
  /**
   * Tasks sort by date, then by `localeCompare` on the path — and that calls
   * these paths equal. The stable sort then keeps the order the files were
   * read in, which used to be `getFiles()` order. Looked up by path, the notes
   * would come in the order the SCOPE listed them (tab order), so they are put
   * back in the order getFiles would have listed them.
   */
  const tieVault = () =>
    fakeVault({
      "p/ab/n.md": "- [ ] Plain 📅 2026-09-05",
      [`p/a${ZWSP}b/n.md`]: "- [ ] Zero-width 📅 2026-09-05",
      [`p/a${SOFT_HYPHEN}b/n.md`]: "- [ ] Soft hyphen 📅 2026-09-05",
      "q.md": "- [ ] Elsewhere 📅 2026-09-05",
      "ab.md": "- [ ] Plain, at the root 📅 2026-09-05",
      [`a${ZWSP}b.md`]: "- [ ] Zero-width, at the root 📅 2026-09-05",
    });
  const tied = ["p/ab/n.md", `p/a${ZWSP}b/n.md`, `p/a${SOFT_HYPHEN}b/n.md`];
  const tiedAtRoot = ["ab.md", `a${ZWSP}b.md`];

  it("really is a tie", () => {
    expect(tied[0].localeCompare(tied[1])).toBe(0);
    expect(tied[0].localeCompare(tied[2])).toBe(0);
    expect(tiedAtRoot[0].localeCompare(tiedAtRoot[1])).toBe(0);
  });

  it("reads tied notes in getFiles order, whatever order the scope names them", async () => {
    const vault = tieVault();
    const listed = paths(vault.getFiles().filter((f) => tied.includes(f.path)));

    for (const scope of [
      notes(...tied),
      notes(...[...tied].reverse()),
      notes(tied[1], tied[2], tied[0]),
    ]) {
      const tasks = await loadTasks(appOf(vault), { scope });
      expect(tasks.map((t) => t.path)).toEqual(listed);
    }
    // Obsidian's walk takes a folder's LAST child first, so the list is the
    // reverse of the order the folders were made in — not the scope's order.
    expect(listed).toEqual([...tied].reverse());
  });

  it("orders tied notes that part ways at the vault root", async () => {
    // Where the paths part ways decides which folder's children are compared:
    // here it is the root's, which a comparator that stops short of the root
    // gets wrong.
    const vault = tieVault();
    const listed = paths(vault.getFiles().filter((f) => tiedAtRoot.includes(f.path)));

    for (const scope of [notes(...tiedAtRoot), notes(...[...tiedAtRoot].reverse())]) {
      const tasks = await loadTasks(appOf(vault), { scope });
      expect(tasks.map((t) => t.path)).toEqual(listed);
    }
    expect(listed).toEqual([...tiedAtRoot].reverse());
  });

  it("reads a tied folder in getFiles order", async () => {
    const vault = tieVault();
    const listed = paths(vault.getFiles().filter((f) => tied.includes(f.path)));

    const tasks = await loadTasks(appOf(vault), { scope: folder("p") });

    expect(tasks.map((t) => t.path)).toEqual(listed);
  });

  it("still puts an out-of-scope linked note after the scope's own notes", async () => {
    // The old code appended the linked task's note last, outside getFiles
    // order; so does the new one. The pinned row is lifted into its own group
    // later, but the task list itself keeps this order.
    const vault = tieVault();

    const tasks = await loadTasks(appOf(vault), {
      scope: notes(tied[0]),
      pin: { path: tied[2], cleanText: "Soft hyphen" },
    });

    expect(tasks.map((t) => t.path)).toEqual([tied[0], tied[2]]);
  });
});

describe("the log rewrites walk only the log folder", () => {
  const line = (name: string) =>
    `- 🍅 Focus | Task:: [[Projects/A.md|${name}]] | ID:: abc123 | Start:: 2026-09-01 10:00:00 | ` +
    "End:: 2026-09-01 10:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus";

  const vaultWithLogs = () =>
    fakeVault({
      "Logs/2026-09-01-gentle-pomodoro-log.md": line("Old name"),
      "Logs/2026/09/2026-09-02-gentle-pomodoro-log.md": line("Old name"),
      "Logs/notes.txt": line("Old name"),
      "Logs-old/2025-12-31-gentle-pomodoro-log.md": line("Old name"),
      "Elsewhere/copy.md": line("Old name"),
      "Projects/A.md": "- [ ] New name 🆔 abc123 📅 2026-09-05",
    });

  const managerFor = (vault: FakeVault, logFolderPath: string) =>
    new LogManager({ settings: { logFolderPath }, app: { vault } } as unknown as GentlePomoPlugin);

  const inLogs = [
    "Logs/2026-09-01-gentle-pomodoro-log.md",
    "Logs/2026/09/2026-09-02-gentle-pomodoro-log.md",
  ];

  /** The order the old code wrote in: the vault's list, filtered. */
  const oldWriteOrder = (vault: FakeVault, logFolderPath: string) =>
    paths(
      vault
        .getFiles()
        .filter((f) => f.extension === "md" && inFolderBefore068(f.path, logFolderPath))
    );

  beforeEach(() => {
    Notice.shown.length = 0;
  });

  for (const logFolderPath of ["Logs", "Logs/", "/Logs"]) {
    it(`renames the task in every log under ${JSON.stringify(logFolderPath)} and nowhere else`, async () => {
      const vault = vaultWithLogs();

      await managerFor(vault, logFolderPath).updateLoggedTaskName(
        "abc123",
        "Renamed",
        "Projects/A.md"
      );

      expect(vault.getFiles).not.toHaveBeenCalled();
      // In the order the old code wrote them, which is not the sorted order.
      expect(vault.writes).toEqual(oldWriteOrder(vault, logFolderPath));
      expect(vault.writes).not.toEqual([...vault.writes].sort());
      expect([...vault.writes].sort()).toEqual(inLogs);
      for (const path of inLogs) expect(vault.contents[path]).toContain("|Renamed]]");
      expect(vault.contents["Logs-old/2025-12-31-gentle-pomodoro-log.md"]).toContain("|Old name]]");
      expect(vault.contents["Elsewhere/copy.md"]).toContain("|Old name]]");
    });
  }

  it("refreshes every log under the folder from the task's current name", async () => {
    const vault = vaultWithLogs();

    await managerFor(vault, "Logs").refreshLoggedTaskNamesById();

    expect(vault.getFiles).not.toHaveBeenCalled();
    expect(vault.writes).toEqual(oldWriteOrder(vault, "Logs"));
    expect(vault.writes).not.toEqual([...vault.writes].sort());
    expect([...vault.writes].sort()).toEqual(inLogs);
    for (const path of inLogs) expect(vault.contents[path]).toContain("|New name]]");
    expect(Notice.shown).toEqual(["[GentlePomo] Updated 2 log line(s) across 2 file(s)."]);
  });

  it("says no log files were found when the folder is missing", async () => {
    const vault = vaultWithLogs();

    await managerFor(vault, "Nowhere").refreshLoggedTaskNamesById();

    expect(Notice.shown).toEqual(["Gentle pomodoro: no log files found."]);
    expect(vault.writes).toEqual([]);
  });

  it("writes nothing on a rename when the folder is missing", async () => {
    const vault = vaultWithLogs();

    await managerFor(vault, "Nowhere").updateLoggedTaskName("abc123", "Renamed", "Projects/A.md");

    expect(vault.writes).toEqual([]);
  });
});
