/**
 * Where the task picker looks for tasks (GitHub issue #4).
 *
 * Pure: the workspace arrives as a structural interface, never as Obsidian's
 * `Workspace`, so the leaf walk — the part with the real trap in it — is
 * testable without an Obsidian runtime.
 */

/** The three scopes, in the order they are offered on both surfaces. */
export type TaskSource = "folder" | "current-note" | "open-notes";

export const TASK_SOURCE_ORDER: readonly TaskSource[] = [
  "folder",
  "current-note",
  "open-notes",
] as const;

/**
 * The option text, shared verbatim by the settings tab's dropdown and the
 * timer panel's — one control asking one question, so it must read identically
 * on both. Same rule (and the same drift test) as the auto-start labels in
 * sessionEndSummary.ts.
 */
export const TASK_SOURCE_LABELS: Record<TaskSource, string> = {
  folder: "Tasks folder",
  "current-note": "Current note",
  "open-notes": "Open notes",
};

/** The setting's own name, also shared by both surfaces. */
export const TASK_SOURCE_SETTING_NAME = "Where to find tasks";

export const TASK_SOURCE_SETTING_DESC =
  "Which notes the task picker reads. The folder below is only used by " +
  '"Tasks folder"; the other two follow whatever you have open.';

/** Narrow a persisted value back to a known source, defaulting to the folder. */
export function resolveTaskSource(value: unknown): TaskSource {
  return TASK_SOURCE_ORDER.find((s) => s === value) ?? "folder";
}

/**
 * What loadTasks should scan.
 *
 * `notes` with an EMPTY path list is a real, distinct state — "current note"
 * with nothing open — and the picker says so rather than showing the
 * indistinguishable "this note has no tasks" empty state.
 */
export type TaskScope = { kind: "folder"; tasksPath: string } | { kind: "notes"; paths: string[] };

/** The one leaf method this needs. Structural so a test can hand over a plain object. */
export interface ScopeLeaf {
  getViewState(): { type: string; state?: Record<string, unknown> };
}

/** The two workspace methods this needs, as calls rather than captured state. */
export interface ScopeWorkspace {
  getActiveFile(): { path: string } | null;
  iterateRootLeaves(callback: (leaf: ScopeLeaf) => void): void;
}

/**
 * The markdown files open in the main area, in tab order, without duplicates.
 *
 * Read through `getViewState()`, NOT `leaf.view`. Since Obsidian 1.7.2 a
 * background tab is *deferred*: its `view` is a placeholder `DeferredView`
 * that has loaded no file, so `leaf.view.file` is null and
 * `getLeavesOfType("markdown")` does not return it at all — a note you have
 * open in another tab is invisible until you click it. View state is exactly
 * what a deferred leaf does keep, so it is the only reading that sees every
 * tab. This is why "Open notes" would otherwise have quietly meant "the one
 * tab I am looking at" on a machine with more than a couple of tabs open.
 */
export function openMarkdownPaths(workspace: ScopeWorkspace): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  workspace.iterateRootLeaves((leaf) => {
    const state = leaf.getViewState();
    if (state.type !== "markdown") return;
    const file = state.state?.file;
    if (typeof file !== "string" || file === "") return;
    if (seen.has(file)) return;
    seen.add(file);
    paths.push(file);
  });

  return paths;
}

/** Resolve the chosen source against the live workspace. */
export function resolveTaskScope(
  workspace: ScopeWorkspace,
  source: TaskSource,
  tasksPath: string
): TaskScope {
  if (source === "current-note") {
    // getActiveFile(), not the active leaf: clicking the timer panel makes IT
    // the active leaf, and the picker must keep meaning the note you were last
    // in rather than emptying itself the moment you reach for it.
    const active = workspace.getActiveFile();
    return { kind: "notes", paths: active ? [active.path] : [] };
  }

  if (source === "open-notes") {
    return { kind: "notes", paths: openMarkdownPaths(workspace) };
  }

  return { kind: "folder", tasksPath };
}

/**
 * One line under the picker's source control saying what it will read.
 *
 * Deliberately a function of the SETTINGS only, never of the live workspace:
 * a hint naming the current note would have to be re-seeded on every
 * active-leaf-change, and a stale file name is worse than no file name. Kept
 * under 40 characters for the panel's hard 260px column, like the
 * end-of-session summaries.
 */
export function taskScopeSummary(source: TaskSource, tasksPath: string): string {
  if (source === "current-note") return "Reads the note you're in.";
  if (source === "open-notes") return "Reads every note you have open.";
  return tasksPath.trim() === "" ? "Reads every note in the vault." : "Reads your tasks folder.";
}

/**
 * A comparable identity for a resolved scope.
 *
 * Newline-delimited because the members are file paths: every other printable
 * character is legal in an Obsidian path, so a comma or a pipe could be typed
 * into a filename and make two different scopes compare equal. Same reasoning
 * as the station list's UI key.
 */
export function taskScopeKey(scope: TaskScope): string {
  return scope.kind === "folder"
    ? `folder\n${scope.tasksPath}`
    : `notes\n${scope.paths.join("\n")}`;
}

export interface TaskPickerEmptyState {
  icon: string;
  title: string;
  hint: string;
}

/**
 * What the picker says when it has nothing to show.
 *
 * There are two genuinely different silences in the note scopes — "you have no
 * note open" and "the note you have open holds no tasks" — and one empty list
 * cannot express both. Splitting them is the difference between a state the
 * user can act on and one that reads as a broken feature.
 */
export function taskPickerEmptyState(args: {
  source: TaskSource;
  tasksPath: string;
  limitDays: number;
  /** A note scope that resolved to no files at all. */
  scopeIsEmpty: boolean;
}): TaskPickerEmptyState {
  const { source, tasksPath, limitDays, scopeIsEmpty } = args;

  if (source === "current-note") {
    return scopeIsEmpty
      ? { icon: "file-search", title: "No note open", hint: "Open a note to see its tasks." }
      : { icon: "calendar-check", title: "All clear", hint: "No open tasks in this note." };
  }

  if (source === "open-notes") {
    return scopeIsEmpty
      ? {
          icon: "file-search",
          title: "No notes open",
          hint: "Open a note in a tab to see its tasks.",
        }
      : {
          icon: "calendar-check",
          title: "All clear",
          hint: "No open tasks in the notes you have open.",
        };
  }

  // An empty tasks path scans the whole vault, so "no path and no results"
  // almost always means task linking was never set up — nudge rather than
  // congratulate. Since 0.6.4 the nudge names both ways out, because the folder
  // is no longer the only answer (GitHub issue #4 is a user who does not want one).
  if (tasksPath.trim() === "") {
    return {
      icon: "folder-search",
      title: "Nothing here yet",
      hint: "In the plugin settings, set a tasks folder — or read tasks from the note you're in.",
    };
  }

  return {
    icon: "calendar-check",
    title: "All clear",
    hint: `No tasks scheduled or due in the next ${limitDays} days.`,
  };
}
