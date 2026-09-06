import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import moment from "moment";
import type { App } from "obsidian";
import {
  loadTasks,
  groupTasksByDate,
  scanAllPomodoroMarkersInVault,
  removeAllPomodoroMarkersInVault,
  scanMisplacedPomodoroMarkersInVault,
  repairPomodoroMarkersInVault,
  removeMisplacedPomodoroMarkersInVault,
} from "../taskLoader";
import type { TaskScope } from "../taskScope";

/**
 * BASELINE LOCKS for loadTasks / groupTasksByDate.
 *
 * Both shipped from 0.1.0 with zero tests, and 0.6.4 rewrites their scoping
 * (folder / current note / open notes) and their date rule (undated tasks are
 * admitted in the note scopes). Every assertion in the two `describe`s marked
 * "pre-0.6.4 behaviour" describes what the folder scope did BEFORE that work,
 * and folder-scope behaviour must stay byte-identical: an upgrading user's
 * picker has to look exactly as it did.
 *
 * The real `moment` 2.29.4 is used rather than a stub — it is the version
 * Obsidian bundles, it is already in the tree as a dependency of the `obsidian`
 * typings package, and loadTasks leans on `add`/`endOf`/`isSameOrBefore` while
 * groupTasksByDate leans on `startOf`/`isBefore`/`isSame`/`format`. A stub
 * faithful enough to exercise those is just moment with more places to be
 * wrong.
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

/** The pre-0.6.4 scope: one folder, or the whole vault when the path is "". */
const folder = (tasksPath: string): TaskScope => ({ kind: "folder", tasksPath });

/** Build an App stub whose vault serves the given path → content map. */
function fakeApp(files: Record<string, string>): App {
  const list = Object.keys(files).map((path) => ({
    path,
    extension: path.slice(path.lastIndexOf(".") + 1),
  }));
  return {
    vault: {
      getFiles: () => list,
      cachedRead: (file: { path: string }) => Promise.resolve(files[file.path]),
    },
  } as unknown as App;
}

describe("loadTasks — pre-0.6.4 behaviour (folder scope)", () => {
  it("returns only OPEN tasks; completed ones are skipped", async () => {
    const app = fakeApp({
      "notes/a.md": ["- [ ] Open task ⏳ 2026-09-05", "- [x] Done task ⏳ 2026-09-05"].join("\n"),
    });

    const tasks = await loadTasks(app, { scope: folder("") });

    expect(tasks.map((t) => t.cleanText)).toEqual(["Open task"]);
  });

  it("skips a task with neither a scheduled nor a due date", async () => {
    const app = fakeApp({
      "notes/a.md": ["- [ ] Undated task", "- [ ] Dated task 📅 2026-09-05"].join("\n"),
    });

    const tasks = await loadTasks(app, { scope: folder("") });

    expect(tasks.map((t) => t.cleanText)).toEqual(["Dated task"]);
  });

  it("prefers the scheduled date over the due date for sorting/grouping", async () => {
    const app = fakeApp({
      "notes/a.md": "- [ ] Both dates ⏳ 2026-09-06 📅 2026-09-07",
    });

    const [task] = await loadTasks(app, { scope: folder("") });

    expect(task.scheduled).toBe("2026-09-06");
    expect(task.due).toBe("2026-09-07");
    expect(task.effectiveDateStr).toBe("2026-09-06");
  });

  it("applies the lookahead window, but never hides an overdue task", async () => {
    const app = fakeApp({
      "notes/a.md": [
        "- [ ] Long overdue 📅 2020-01-01",
        "- [ ] Inside window 📅 2026-09-07",
        "- [ ] Beyond window 📅 2026-09-30",
      ].join("\n"),
    });

    const tasks = await loadTasks(app, { scope: folder(""), limitDays: 3 });

    expect(tasks.map((t) => t.cleanText)).toEqual(["Long overdue", "Inside window"]);
  });

  it("defaults the lookahead window to 3 days", async () => {
    const app = fakeApp({
      "notes/a.md": ["- [ ] Day three 📅 2026-09-08", "- [ ] Day four 📅 2026-09-09"].join("\n"),
    });

    const tasks = await loadTasks(app, { scope: folder("") });

    expect(tasks.map((t) => t.cleanText)).toEqual(["Day three"]);
  });

  it("includes a task dated later today (the window ends at end-of-day)", async () => {
    const app = fakeApp({ "notes/a.md": "- [ ] Today 📅 2026-09-05" });

    const tasks = await loadTasks(app, { scope: folder(""), limitDays: 0 });

    expect(tasks).toHaveLength(1);
  });

  it("scopes to the tasks folder and ignores non-markdown files", async () => {
    const app = fakeApp({
      "projects/a.md": "- [ ] Inside 📅 2026-09-05",
      "other/b.md": "- [ ] Outside 📅 2026-09-05",
      "projects/c.txt": "- [ ] Not markdown 📅 2026-09-05",
    });

    const tasks = await loadTasks(app, { scope: folder("projects") });

    expect(tasks.map((t) => t.cleanText)).toEqual(["Inside"]);
  });

  it("scans the whole vault when the tasks path is empty", async () => {
    const app = fakeApp({
      "projects/a.md": "- [ ] One 📅 2026-09-05",
      "other/b.md": "- [ ] Two 📅 2026-09-05",
    });

    const tasks = await loadTasks(app, { scope: folder("") });

    expect(tasks).toHaveLength(2);
  });

  it("sorts by effective date, then by path", async () => {
    const app = fakeApp({
      "z.md": "- [ ] Later note, same day 📅 2026-09-06",
      "a.md": [
        "- [ ] Earlier note, same day 📅 2026-09-06",
        "- [ ] Earlier day 📅 2026-09-05",
      ].join("\n"),
    });

    const tasks = await loadTasks(app, { scope: folder("") });

    expect(tasks.map((t) => t.cleanText)).toEqual([
      "Earlier day",
      "Earlier note, same day",
      "Later note, same day",
    ]);
  });

  it("carries the file path, the Tasks id, and both text forms", async () => {
    const app = fakeApp({
      "projects/a.md": "- [ ] Write docs ⏫ #work ⏳ 2026-09-05 🆔 abc123",
    });

    const [task] = await loadTasks(app, { scope: folder("") });

    expect(task.path).toBe("projects/a.md");
    expect(task.taskId).toBe("abc123");
    expect(task.status).toBe("todo");
    // The two forms strip DIFFERENT things and both matter. cleanText drops
    // the priority but keeps tags — it is the identity a linked task is matched
    // by, so it has to equal what TimerEngine derives from the same line.
    // displayText is the opposite: tags out, priority icon kept and moved to
    // the end, because that is what the picker shows.
    expect(task.cleanText).toBe("Write docs #work");
    expect(task.displayText).toBe("Write docs ⏫");
  });

  it("falls back to 'Untitled Task' when the description is only metadata", async () => {
    const app = fakeApp({ "a.md": "- [ ] ⏳ 2026-09-05" });

    const [task] = await loadTasks(app, { scope: folder("") });

    expect(task.cleanText).toBe("Untitled Task");
    expect(task.displayText).toBe("Untitled Task");
  });

  it("reads tasks on every bullet form Obsidian allows (0.5.5)", async () => {
    const app = fakeApp({
      "a.md": [
        "- [ ] Dash 📅 2026-09-05",
        "* [ ] Star 📅 2026-09-05",
        "+ [ ] Plus 📅 2026-09-05",
        "1. [ ] Numbered dot 📅 2026-09-05",
        "2) [ ] Numbered paren 📅 2026-09-05",
        "  - [ ] Indented 📅 2026-09-05",
      ].join("\n"),
    });

    const tasks = await loadTasks(app, { scope: folder("") });

    expect(tasks).toHaveLength(6);
  });
});

describe("groupTasksByDate — pre-0.6.4 behaviour", () => {
  const item = (cleanText: string, effectiveDateStr: string) => ({
    text: cleanText,
    cleanText,
    displayText: cleanText,
    status: "todo",
    path: "a.md",
    scheduled: effectiveDateStr,
    due: null,
    effectiveDateStr,
  });

  it("labels past, today and tomorrow in words and later days by weekday", () => {
    const groups = groupTasksByDate([
      item("Old", "2026-09-01"),
      item("Now", "2026-09-05"),
      item("Next", "2026-09-06"),
      item("Later", "2026-09-09"),
    ]);

    expect(groups.map((g) => g.label)).toEqual([
      "Overdue",
      "Today",
      "Tomorrow",
      "Wednesday, Sep 9",
    ]);
  });

  it("collects consecutive same-label tasks into one group", () => {
    const groups = groupTasksByDate([
      item("A", "2026-09-01"),
      item("B", "2026-09-02"),
      item("C", "2026-09-05"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].items.map((t) => t.cleanText)).toEqual(["A", "B"]);
    expect(groups[1].items.map((t) => t.cleanText)).toEqual(["C"]);
  });

  it("returns no groups for no tasks", () => {
    expect(groupTasksByDate([])).toEqual([]);
  });
});

/** The 0.6.4 note scope: an explicit list of files, whatever folder they sit in. */
const notes = (...paths: string[]): TaskScope => ({ kind: "notes", paths });

describe("loadTasks — the note scopes (0.6.4)", () => {
  it("reads exactly the listed notes, wherever they live", async () => {
    const app = fakeApp({
      "inbox/a.md": "- [ ] From A 📅 2026-09-05",
      "archive/deep/b.md": "- [ ] From B 📅 2026-09-05",
      "c.md": "- [ ] From C 📅 2026-09-05",
    });

    const tasks = await loadTasks(app, { scope: notes("inbox/a.md", "archive/deep/b.md") });

    // Path order within the date group, not the order the scope listed them —
    // the pre-0.6.4 sort, unchanged.
    expect(tasks.map((t) => t.cleanText)).toEqual(["From B", "From A"]);
  });

  it("returns nothing for an empty note scope", async () => {
    // "Current note" with no note open. The picker distinguishes this from an
    // empty note in its own copy; the loader just has nothing to read.
    const app = fakeApp({ "a.md": "- [ ] Something 📅 2026-09-05" });

    expect(await loadTasks(app, { scope: notes() })).toEqual([]);
  });

  it("admits undated tasks when asked, with a null effective date", async () => {
    const app = fakeApp({
      "a.md": ["- [ ] Undated", "- [ ] Dated 📅 2026-09-05"].join("\n"),
    });

    const tasks = await loadTasks(app, { scope: notes("a.md"), includeUndated: true });

    expect(tasks.map((t) => t.cleanText)).toEqual(["Dated", "Undated"]);
    expect(tasks[1].effectiveDateStr).toBeNull();
    expect(tasks[1].scheduled).toBeNull();
    expect(tasks[1].due).toBeNull();
  });

  it("still hides undated tasks when NOT asked", async () => {
    // includeUndated is what the two note scopes pass; the folder scope does
    // not, and one flag governs both so they cannot drift apart.
    const app = fakeApp({ "a.md": "- [ ] Undated" });

    expect(await loadTasks(app, { scope: notes("a.md") })).toEqual([]);
  });

  it("sorts undated tasks after every dated one, as one block", async () => {
    // groupTasksByDate closes the list with a single trailing "No date" group
    // and has no special case for it — this ordering is what makes that work.
    const app = fakeApp({
      "b.md": ["- [ ] Undated B", "- [ ] Late 📅 2026-09-30"].join("\n"),
      "a.md": ["- [ ] Undated A", "- [ ] Early 📅 2026-09-05"].join("\n"),
    });

    const tasks = await loadTasks(app, {
      scope: notes("a.md", "b.md"),
      includeUndated: true,
      limitDays: 90,
    });

    expect(tasks.map((t) => t.cleanText)).toEqual(["Early", "Late", "Undated A", "Undated B"]);
  });

  it("applies the lookahead window to the dated tasks it does admit", async () => {
    const app = fakeApp({
      "a.md": ["- [ ] Undated", "- [ ] Far off 📅 2026-12-01"].join("\n"),
    });

    const tasks = await loadTasks(app, {
      scope: notes("a.md"),
      includeUndated: true,
      limitDays: 3,
    });

    expect(tasks.map((t) => t.cleanText)).toEqual(["Undated"]);
  });
});

describe("loadTasks — the pinned (linked) task", () => {
  const pinned = { path: "elsewhere/linked.md", cleanText: "The linked task" };

  it("reads the linked task's own note even when the scope excludes it", async () => {
    const app = fakeApp({
      "a.md": "- [ ] In scope 📅 2026-09-05",
      "elsewhere/linked.md": "- [ ] The linked task 📅 2026-09-05",
    });

    const tasks = await loadTasks(app, { scope: notes("a.md"), pin: pinned });

    expect(tasks.map((t) => t.cleanText).sort()).toEqual(["In scope", "The linked task"]);
    expect(tasks.find((t) => t.cleanText === "The linked task")?.pinned).toBe(true);
    expect(tasks.find((t) => t.cleanText === "In scope")?.pinned).toBe(false);
  });

  it("takes ONLY the linked line from an out-of-scope note", async () => {
    // Otherwise choosing "Current note" would quietly drag in every other task
    // from wherever the linked one happens to live.
    const app = fakeApp({
      "a.md": "- [ ] In scope 📅 2026-09-05",
      "elsewhere/linked.md": [
        "- [ ] The linked task 📅 2026-09-05",
        "- [ ] Its neighbour 📅 2026-09-05",
      ].join("\n"),
    });

    const tasks = await loadTasks(app, { scope: notes("a.md"), pin: pinned });

    expect(tasks.map((t) => t.cleanText).sort()).toEqual(["In scope", "The linked task"]);
  });

  it("shows the linked task past the lookahead window, and undated", async () => {
    const app = fakeApp({
      "elsewhere/linked.md": "- [ ] The linked task 📅 2027-12-31",
    });
    const undatedApp = fakeApp({ "elsewhere/linked.md": "- [ ] The linked task" });

    const dated = await loadTasks(app, { scope: notes(), pin: pinned, limitDays: 3 });
    const undated = await loadTasks(undatedApp, { scope: notes(), pin: pinned, limitDays: 3 });

    expect(dated.map((t) => t.pinned)).toEqual([true]);
    expect(undated.map((t) => t.pinned)).toEqual([true]);
    expect(undated[0].effectiveDateStr).toBeNull();
  });

  it("does NOT mark it pinned when the scope shows it anyway", async () => {
    // Pinned means "here because it is linked". A task the scope already
    // includes must stay in its date group, or the picker lists it twice.
    const app = fakeApp({
      "elsewhere/linked.md": "- [ ] The linked task 📅 2026-09-05",
    });

    const tasks = await loadTasks(app, { scope: notes("elsewhere/linked.md"), pin: pinned });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].pinned).toBe(false);
  });

  it("matches on path AND text, so a same-named task elsewhere is not it", async () => {
    const app = fakeApp({
      "a.md": "- [ ] The linked task 📅 2026-09-05",
      "elsewhere/linked.md": "- [ ] Something else 📅 2026-09-05",
    });

    const tasks = await loadTasks(app, { scope: notes("a.md"), pin: pinned });

    expect(tasks.map((t) => t.cleanText)).toEqual(["The linked task"]);
    expect(tasks[0].pinned).toBe(false);
    expect(tasks[0].path).toBe("a.md");
  });

  it("copes with a linked task whose line is gone", async () => {
    const app = fakeApp({ "elsewhere/linked.md": "- [ ] Not it 📅 2026-09-05" });

    expect(await loadTasks(app, { scope: notes(), pin: pinned })).toEqual([]);
  });

  it("copes with a linked task whose note is gone", async () => {
    const app = fakeApp({ "a.md": "- [ ] In scope 📅 2026-09-05" });

    const tasks = await loadTasks(app, { scope: notes("a.md"), pin: pinned });

    expect(tasks.map((t) => t.cleanText)).toEqual(["In scope"]);
  });

  it("never resurrects a COMPLETED linked task", async () => {
    // The maintainer's rule on issue #4 is "keep it selected unless it is
    // marked as finished". TimerEngine unlinks on completion; the pin must not
    // undo that by lifting a ticked line back into the list.
    const app = fakeApp({ "elsewhere/linked.md": "- [x] The linked task 📅 2026-09-05" });

    expect(await loadTasks(app, { scope: notes(), pin: pinned })).toEqual([]);
  });

  it("pins in the folder scope too", async () => {
    const app = fakeApp({
      "projects/a.md": "- [ ] In folder 📅 2026-09-05",
      "elsewhere/linked.md": "- [ ] The linked task 📅 2026-09-05",
    });

    const tasks = await loadTasks(app, {
      scope: { kind: "folder", tasksPath: "projects" },
      pin: pinned,
    });

    expect(tasks.map((t) => t.cleanText).sort()).toEqual(["In folder", "The linked task"]);
    expect(tasks.find((t) => t.cleanText === "The linked task")?.pinned).toBe(true);
  });
});

describe("groupTasksByDate — undated and pinned (0.6.4)", () => {
  const item = (cleanText: string, effectiveDateStr: string | null, pinned = false) => ({
    text: cleanText,
    cleanText,
    displayText: cleanText,
    status: "todo",
    path: "a.md",
    scheduled: effectiveDateStr,
    due: null,
    effectiveDateStr,
    pinned,
  });

  it("closes the list with a single 'No date' group", () => {
    const groups = groupTasksByDate([
      item("Dated", "2026-09-05"),
      item("Loose one", null),
      item("Loose two", null),
    ]);

    expect(groups.map((g) => g.label)).toEqual(["Today", "No date"]);
    expect(groups[1].items.map((t) => t.cleanText)).toEqual(["Loose one", "Loose two"]);
  });

  it("does NOT file undated tasks under Today", () => {
    // moment(undefined) is *now*, so a missing date read through the date
    // branch would land every one of these in whatever today is.
    const groups = groupTasksByDate([item("Loose", null)]);

    expect(groups.map((g) => g.label)).toEqual(["No date"]);
  });

  it("puts a pinned task first, under its own heading", () => {
    const groups = groupTasksByDate([
      item("Linked", "2020-01-01", true),
      item("Normal", "2026-09-05"),
    ]);

    expect(groups.map((g) => g.label)).toEqual(["Linked task", "Today"]);
    expect(groups[0].items.map((t) => t.cleanText)).toEqual(["Linked"]);
  });

  it("never also lists a pinned task in its date group", () => {
    const groups = groupTasksByDate([item("Linked", "2026-09-05", true)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Linked task");
  });

  it("groups an undated pinned task the same way", () => {
    const groups = groupTasksByDate([item("Linked", null, true), item("Loose", null)]);

    expect(groups.map((g) => g.label)).toEqual(["Linked task", "No date"]);
  });
});

describe("marker maintenance reaches wherever the counter can write", () => {
  /**
   * Until 0.6.4 the tasks folder was the right scope for the 🍅 cleanup
   * actions, because the picker could only link a task inside it, so the
   * counter could only write inside it. The note scopes broke that: a task
   * linked from any note gets its marker written there. A folder-scoped sweep
   * could not see it, which would have made "Remove all" — documented as the
   * counter's full uninstall — silently partial.
   */
  const vault = (files: Record<string, string>) => {
    const written: Record<string, string> = {};
    const app = fakeApp(files);
    const v = (app as unknown as { vault: Record<string, unknown> }).vault;
    v.process = (file: { path: string }, fn: (data: string) => string) => {
      written[file.path] = fn(files[file.path]);
      return Promise.resolve(written[file.path]);
    };
    return { app, written };
  };

  const scattered = {
    "projects/inside.md": "- [ ] In the folder 🍅 2 📅 2026-09-05",
    "inbox/outside.md": "- [ ] Linked from a note 🍅 7 📅 2026-09-05",
    "deep/nested/also.md": "- [ ] Another 🍅 1",
  };

  it("counts markers in every note, not just one folder", async () => {
    const { app } = vault(scattered);

    const result = await scanAllPomodoroMarkersInVault(app);

    expect(result.filesAffected).toBe(3);
    expect(result.affected.map((f) => f.path).sort()).toEqual([
      "deep/nested/also.md",
      "inbox/outside.md",
      "projects/inside.md",
    ]);
  });

  it("removes them everywhere, so 'all' means all", async () => {
    const { app, written } = vault(scattered);

    await removeAllPomodoroMarkersInVault(app);

    expect(Object.keys(written).sort()).toEqual([
      "deep/nested/also.md",
      "inbox/outside.md",
      "projects/inside.md",
    ]);
    for (const content of Object.values(written)) {
      expect(content).not.toContain("🍅");
    }
  });

  it("sweeps the whole vault through EVERY wrapper, not just the two 'all' ones", async () => {
    // Repair and Remove-misplaced are the write paths whose reach this widened,
    // and they had no whole-vault assertion at all — the two tests above drive
    // only scanAll/removeAll. A re-narrowing of the other three passed the
    // entire suite.
    const misplaced = {
      "projects/inside.md": "- [ ] In the folder 📅 2026-09-05 🍅 2",
      "inbox/outside.md": "- [ ] Linked from a note 📅 2026-09-05 🍅 7",
      "deep/nested/also.md": "- [ ] Another 🆔 abc 🍅 1",
    };

    for (const sweep of [
      scanMisplacedPomodoroMarkersInVault,
      repairPomodoroMarkersInVault,
      removeMisplacedPomodoroMarkersInVault,
    ]) {
      const { app } = vault(misplaced);
      const result = await sweep(app);
      expect(result.filesAffected, sweep.name).toBe(3);
      expect(result.affected.map((f) => f.path).sort(), sweep.name).toEqual([
        "deep/nested/also.md",
        "inbox/outside.md",
        "projects/inside.md",
      ]);
    }
  });

  it("still skips notes with no marker in them", async () => {
    const { app } = vault({ ...scattered, "notes/plain.md": "- [ ] Nothing here 📅 2026-09-05" });

    const result = await scanAllPomodoroMarkersInVault(app);

    expect(result.filesScanned).toBe(4);
    expect(result.filesAffected).toBe(3);
  });
});

describe("the marker sweep cannot be re-narrowed to a folder", () => {
  /**
   * This replaces an arity check that could not do its job. `Function.length`
   * counts only the parameters BEFORE the first defaulted one, so
   * `tasksPath = ""` — the exact shape someone would reach for, because it
   * keeps every existing call site compiling — was invisible to it. The full
   * pre-0.6.4 narrowing was restored as an experiment and the whole suite,
   * typecheck and lint stayed green.
   *
   * Read as source text, the route tests/settingTab.test.ts already uses for
   * things no unit test can observe.
   */
  const loader = readFileSync(resolve(__dirname, "..", "taskLoader.ts"), "utf8");
  const main = readFileSync(resolve(__dirname, "..", "main.ts"), "utf8");

  const bodyOf = (src: string, signature: string) => {
    const at = src.indexOf(signature);
    expect(at, `${signature} not found`).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("\n}", at));
  };

  it("does not scope the walker by folder, in any parameter shape", () => {
    const walker = bodyOf(loader, "async function processPomodoroMarkersInVault(");
    expect(walker).not.toContain("tasksPath");
    // The folder test itself must not reappear inside the sweep. It is still
    // exported and still used — the folder TASK SCOPE needs it — so its mere
    // presence in the file proves nothing.
    expect(walker).not.toContain("isPathInFolder");
  });

  it("gives every exported wrapper a signature with no room for a folder", () => {
    for (const name of [
      "scanMisplacedPomodoroMarkersInVault",
      "repairPomodoroMarkersInVault",
      "removeMisplacedPomodoroMarkersInVault",
      "scanAllPomodoroMarkersInVault",
      "removeAllPomodoroMarkersInVault",
    ]) {
      const at = loader.indexOf(`export function ${name}(`);
      expect(at, `${name} not found`).toBeGreaterThan(-1);
      // Whitespace-normalised: prettier wraps the longest of these five across
      // three lines, so matching the literal text passes or fails on formatting
      // rather than on the parameter list.
      const signature = loader.slice(at, loader.indexOf(")", at)).replace(/\s+/g, "");
      expect(signature, `${name} must take only the app`).toBe(`exportfunction${name}(app:App`);
    }
  });

  it("has no call site that hands one a path", () => {
    // main.ts is where the narrowing lived, so this is where it would return.
    expect(main).not.toMatch(/InVault\(\s*this\.app,/);
  });
});
