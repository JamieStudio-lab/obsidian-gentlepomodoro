import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import moment from "moment";
import type { App } from "obsidian";
import { loadTasks, groupTasksByDate } from "../taskLoader";
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
