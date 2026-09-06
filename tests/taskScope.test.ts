import { describe, it, expect } from "vitest";
import {
  TASK_SOURCE_ORDER,
  TASK_SOURCE_LABELS,
  openMarkdownPaths,
  resolveTaskScope,
  resolveTaskSource,
  taskScopeKey,
  taskScopeSummary,
  taskPickerEmptyState,
  type ScopeLeaf,
  type ScopeWorkspace,
} from "../taskScope";

/** A leaf as the workspace reports it — view TYPE and view STATE, no view. */
function leaf(type: string, file?: string): ScopeLeaf {
  return { getViewState: () => ({ type, state: file === undefined ? {} : { file } }) };
}

function workspace(options: { active?: string | null; leaves?: ScopeLeaf[] }): ScopeWorkspace {
  const { active = null, leaves = [] } = options;
  return {
    getActiveFile: () => (active === null ? null : { path: active }),
    iterateRootLeaves: (cb) => leaves.forEach(cb),
  };
}

describe("resolveTaskSource", () => {
  it("accepts each of the three sources", () => {
    for (const source of TASK_SOURCE_ORDER) {
      expect(resolveTaskSource(source)).toBe(source);
    }
  });

  it("falls back to the folder for anything else", () => {
    // data.json is hand-editable and coerceToDefaults only drops values whose
    // TYPE disagrees, so an unknown string genuinely reaches this function.
    for (const bad of ["", "notes", "Folder", null, undefined, 3, {}]) {
      expect(resolveTaskSource(bad)).toBe("folder");
    }
  });

  it("does not resolve inherited properties", () => {
    // `"toString" in obj` walks the prototype chain — the bug themes.ts shipped.
    expect(resolveTaskSource("toString")).toBe("folder");
    expect(resolveTaskSource("constructor")).toBe("folder");
  });
});

describe("openMarkdownPaths", () => {
  it("reads the file out of the view STATE, not the view", () => {
    // The whole point: a background tab is deferred since Obsidian 1.7.2, so
    // its `view` is a placeholder that has loaded no file. Only view state
    // survives, so only view state sees every tab.
    const paths = openMarkdownPaths(
      workspace({ leaves: [leaf("markdown", "a.md"), leaf("markdown", "b.md")] })
    );
    expect(paths).toEqual(["a.md", "b.md"]);
  });

  it("keeps tab order and drops duplicates", () => {
    const paths = openMarkdownPaths(
      workspace({
        leaves: [leaf("markdown", "b.md"), leaf("markdown", "a.md"), leaf("markdown", "b.md")],
      })
    );
    expect(paths).toEqual(["b.md", "a.md"]);
  });

  it("ignores leaves that are not markdown", () => {
    const paths = openMarkdownPaths(
      workspace({
        leaves: [
          leaf("gentle-pomo-view"),
          leaf("canvas", "board.canvas"),
          leaf("markdown", "a.md"),
          leaf("image", "pic.png"),
        ],
      })
    );
    expect(paths).toEqual(["a.md"]);
  });

  it("ignores a markdown leaf carrying no usable file", () => {
    // An empty tab, and — defensively — a state whose `file` is not a string.
    // ViewState.state is Record<string, unknown>; nothing types that field.
    const odd: ScopeLeaf = { getViewState: () => ({ type: "markdown", state: { file: 42 } }) };
    const noState: ScopeLeaf = { getViewState: () => ({ type: "markdown" }) };
    const paths = openMarkdownPaths(
      workspace({ leaves: [leaf("markdown", ""), odd, noState, leaf("markdown", "a.md")] })
    );
    expect(paths).toEqual(["a.md"]);
  });

  it("returns nothing when no tab is open", () => {
    expect(openMarkdownPaths(workspace({}))).toEqual([]);
  });
});

describe("resolveTaskScope", () => {
  it("passes the folder through untouched", () => {
    const scope = resolveTaskScope(workspace({}), "folder", "projects/active");
    expect(scope).toEqual({ kind: "folder", tasksPath: "projects/active" });
  });

  it("uses getActiveFile for the current note, not the active leaf", () => {
    // Clicking the timer panel makes IT the active leaf while getActiveFile
    // keeps naming the note — so the picker must not empty itself the moment
    // the user reaches for it. The workspace here reports NO markdown leaves
    // at all, exactly as it would with the panel focused.
    const scope = resolveTaskScope(workspace({ active: "notes/today.md" }), "current-note", "any");
    expect(scope).toEqual({ kind: "notes", paths: ["notes/today.md"] });
  });

  it("reports an EMPTY note scope when nothing is open", () => {
    // Distinct from "the note has no tasks", and the picker says so.
    expect(resolveTaskScope(workspace({}), "current-note", "any")).toEqual({
      kind: "notes",
      paths: [],
    });
    expect(resolveTaskScope(workspace({}), "open-notes", "any")).toEqual({
      kind: "notes",
      paths: [],
    });
  });

  it("collects every open tab for the open-notes scope", () => {
    const scope = resolveTaskScope(
      workspace({
        active: "a.md",
        leaves: [leaf("markdown", "a.md"), leaf("markdown", "b.md")],
      }),
      "open-notes",
      "ignored"
    );
    expect(scope).toEqual({ kind: "notes", paths: ["a.md", "b.md"] });
  });

  it("ignores the tasks folder in both note scopes", () => {
    const ws = workspace({ active: "a.md", leaves: [leaf("markdown", "a.md")] });
    expect(resolveTaskScope(ws, "current-note", "projects")).toEqual(
      resolveTaskScope(ws, "current-note", "somewhere/else")
    );
  });
});

describe("taskScopeKey", () => {
  it("separates the two kinds", () => {
    expect(taskScopeKey({ kind: "folder", tasksPath: "a" })).not.toBe(
      taskScopeKey({ kind: "notes", paths: ["a"] })
    );
  });

  it("changes when the notes change", () => {
    expect(taskScopeKey({ kind: "notes", paths: ["a.md"] })).not.toBe(
      taskScopeKey({ kind: "notes", paths: ["a.md", "b.md"] })
    );
    expect(taskScopeKey({ kind: "notes", paths: ["a.md", "b.md"] })).not.toBe(
      taskScopeKey({ kind: "notes", paths: ["b.md", "a.md"] })
    );
  });

  it("is stable for the same scope", () => {
    expect(taskScopeKey({ kind: "notes", paths: ["a.md"] })).toBe(
      taskScopeKey({ kind: "notes", paths: ["a.md"] })
    );
  });

  it("cannot be forged by a path containing the delimiter's alternatives", () => {
    // A newline is the one printable character an Obsidian path cannot hold, so
    // it is the only safe join. A comma or a pipe CAN be typed into a filename,
    // and would make two different scopes compare equal — at which point an
    // open picker silently stops following the note you switched to.
    const a = taskScopeKey({ kind: "notes", paths: ["a,b.md"] });
    const b = taskScopeKey({ kind: "notes", paths: ["a.md", "b.md"] });
    expect(a).not.toBe(b);
    const c = taskScopeKey({ kind: "notes", paths: ["a|b.md"] });
    expect(c).not.toBe(b);
  });
});

describe("taskScopeSummary", () => {
  it("distinguishes a configured folder from a whole-vault scan", () => {
    expect(taskScopeSummary("folder", "projects")).not.toBe(taskScopeSummary("folder", ""));
    // Whitespace is not a path.
    expect(taskScopeSummary("folder", "   ")).toBe(taskScopeSummary("folder", ""));
  });

  it("gives every source a distinct sentence", () => {
    const lines = [
      taskScopeSummary("folder", "projects"),
      taskScopeSummary("folder", ""),
      taskScopeSummary("current-note", ""),
      taskScopeSummary("open-notes", ""),
    ];
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("ignores the folder in the note scopes", () => {
    expect(taskScopeSummary("current-note", "projects")).toBe(taskScopeSummary("current-note", ""));
    expect(taskScopeSummary("open-notes", "projects")).toBe(taskScopeSummary("open-notes", ""));
  });

  it("fits the panel's 260px column", () => {
    // Same budget as the end-of-session summaries — this line sits in the same
    // hard-width column and wraps to two lines past about 40 characters.
    for (const source of TASK_SOURCE_ORDER) {
      for (const path of ["", "projects/active"]) {
        expect(taskScopeSummary(source, path).length).toBeLessThanOrEqual(40);
      }
    }
  });
});

describe("taskPickerEmptyState", () => {
  const call = (
    source: (typeof TASK_SOURCE_ORDER)[number],
    tasksPath: string,
    scopeIsEmpty: boolean
  ) => taskPickerEmptyState({ source, tasksPath, limitDays: 7, scopeIsEmpty });

  it("tells 'nothing open' apart from 'nothing in it'", () => {
    // One empty list, two completely different situations. Collapsing them is
    // what makes a working feature read as broken.
    for (const source of ["current-note", "open-notes"] as const) {
      const nothingOpen = call(source, "", true);
      const nothingInIt = call(source, "", false);
      expect(nothingOpen.title).not.toBe(nothingInIt.title);
      expect(nothingOpen.hint).not.toBe(nothingInIt.hint);
    }
  });

  it("nudges rather than congratulates when no folder was ever set", () => {
    const copy = call("folder", "", false);
    expect(copy.title).toBe("Nothing here yet");
    // Since 0.6.4 the folder is not the only answer, and the nudge says so —
    // issue #4 is a user who does not want one.
    expect(copy.hint.toLowerCase()).toContain("note you're in");
  });

  it("congratulates when a folder IS set and the window is simply empty", () => {
    const copy = call("folder", "projects", false);
    expect(copy.title).toBe("All clear");
    expect(copy.hint).toContain("7 days");
  });

  it("never promises a lookahead window in the note scopes", () => {
    // Those scopes admit undated tasks, so quoting a day count there would
    // describe a filter that is not being applied.
    for (const source of ["current-note", "open-notes"] as const) {
      for (const empty of [true, false]) {
        expect(call(source, "projects", empty).hint).not.toContain("days");
      }
    }
  });

  it("always supplies all three fields", () => {
    for (const source of TASK_SOURCE_ORDER) {
      for (const path of ["", "projects"]) {
        for (const empty of [true, false]) {
          const copy = call(source, path, empty);
          expect(copy.icon.length).toBeGreaterThan(0);
          expect(copy.title.length).toBeGreaterThan(0);
          expect(copy.hint.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("the shared option labels", () => {
  it("names every source exactly once", () => {
    const labels = TASK_SOURCE_ORDER.map((s) => TASK_SOURCE_LABELS[s]);
    expect(new Set(labels).size).toBe(TASK_SOURCE_ORDER.length);
    for (const label of labels) expect(label.trim()).toBe(label);
  });

  it("offers the folder first, so the default is the first option", () => {
    expect(TASK_SOURCE_ORDER[0]).toBe("folder");
  });
});
