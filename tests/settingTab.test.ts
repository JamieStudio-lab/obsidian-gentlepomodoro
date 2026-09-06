import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Imported from the mock by path, not through the "obsidian" alias: the alias
// is a vitest resolution rule, so `tsc` would type these against the real
// package (which has no recording stubs). Vitest points the alias at this very
// file, so it is the same module instance the tab constructs.
import { Setting, type RecordedComponent } from "../__mocks__/obsidian";
import { GentlePomoSettingTab } from "../GentlePomoSettingTab";
import { DEFAULT_SETTINGS } from "../constants";
import {
  AUTO_START_BREAK_LABEL,
  AUTO_START_FOCUS_LABEL,
  MASTER_SOUND_LABEL,
  MUSIC_SOUND_LABEL,
  MUSIC_VOLUME_LABEL,
  TIMER_VOLUME_LABEL,
  sessionEndSummary,
} from "../sessionEndSummary";
import { VOLUME_OPTIONS } from "../segmentedChoice";
import { TASK_SOURCE_ORDER, TASK_SOURCE_LABELS, TASK_SOURCE_SETTING_NAME } from "../taskScope";
import type { GentlePomoSettings } from "../types";

/**
 * The pre-1.13 `display()` path cannot be exercised on a machine running a
 * current Obsidian — it is dead code there by design. These tests are what
 * stands in for that: they render it headlessly and hold it against the
 * declarative definitions, which is the invariant that used to be maintained
 * by hand (and that five separate warnings in the docs asked contributors to
 * remember).
 */

/** A container that collects the Settings constructed into it, in order. */
function container(): { settings: Setting[]; empty: () => void } {
  const el = {
    settings: [] as Setting[],
    empty: () => {
      el.settings.length = 0;
    },
  };
  return el;
}

interface Call {
  method: string;
  args: unknown[];
}

function makeTab(overrides: Partial<GentlePomoSettings> = {}) {
  const calls: Call[] = [];
  const settings: GentlePomoSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const plugin = {
    settings,
    app: {},
    timer: { currentTaskName: "No task", setTask: () => undefined },
    saveSettings: () => {
      calls.push({ method: "saveSettings", args: [] });
      return Promise.resolve();
    },
    setStatusBarVisibility: (v: boolean) => {
      calls.push({ method: "setStatusBarVisibility", args: [v] });
      return Promise.resolve();
    },
    clearAllMusicPositions: () => calls.push({ method: "clearAllMusicPositions", args: [] }),
    checkPomodoroMarkers: () => {
      calls.push({ method: "checkPomodoroMarkers", args: [] });
      return Promise.resolve();
    },
    repairPomodoroMarkers: () => {
      calls.push({ method: "repairPomodoroMarkers", args: [] });
      return Promise.resolve();
    },
    removeMisplacedPomodoroMarkers: () => {
      calls.push({ method: "removeMisplacedPomodoroMarkers", args: [] });
      return Promise.resolve();
    },
    removeAllPomodoroMarkers: () => {
      calls.push({ method: "removeAllPomodoroMarkers", args: [] });
      return Promise.resolve();
    },
    app_workspace: null,
  };
  // The tab reaches app.workspace only through applySettingsToOpenViews. Give
  // it ONE leaf whose view records the call: with an empty leaf list the fan-out
  // is a no-op nobody can observe, so a deleted applySettingsToOpenViews() would
  // be invisible to every assertion below — and that call is the only thing
  // keeping an open gear panel from showing a stale toggle. applySettingsToOpenViews
  // duck-types on `"applySettings" in view`, so this stub is enough.
  (plugin as unknown as { app: unknown }).app = {
    workspace: {
      getLeavesOfType: () => [
        { view: { applySettings: () => calls.push({ method: "applySettings", args: [] }) } },
      ],
    },
  };
  const tab = new GentlePomoSettingTab(
    plugin.app as never,
    plugin as unknown as ConstructorParameters<typeof GentlePomoSettingTab>[1]
  );
  const el = container();
  (tab as unknown as { containerEl: unknown }).containerEl = el;
  return { tab, el, calls, settings };
}

/** Flatten the 1.13 definitions to (heading, name, desc) in render order. */
function declarativeRows(tab: GentlePomoSettingTab) {
  const out: { heading: string; name: string; desc: string }[] = [];
  for (const group of tab.getSettingDefinitions()) {
    const g = group as { heading: string; items: { name: string; desc?: unknown }[] };
    for (const item of g.items) {
      out.push({ heading: g.heading, name: item.name, desc: String(item.desc ?? "") });
    }
  }
  return out;
}

/** The same, as the pre-1.13 path actually renders it. */
function imperativeRows(tab: GentlePomoSettingTab, el: { settings: Setting[] }) {
  tab.display();
  const out: { heading: string; name: string; desc: string }[] = [];
  let heading = "";
  for (const setting of el.settings) {
    if (setting.heading) {
      heading = setting.name;
      continue;
    }
    out.push({ heading, name: setting.name, desc: setting.desc });
  }
  return out;
}

/**
 * A source file with its comments removed, for the drift guards.
 *
 * Full-line `//` comments only, deliberately: stripping every `//` would cut a
 * line short at an https URL, and the tab is full of them.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function rowFor(el: { settings: Setting[] }, name: string): Setting {
  const found = el.settings.find((s) => s.name === name && !s.heading);
  if (!found) throw new Error(`no setting row named ${name}`);
  return found;
}

function componentOf(el: { settings: Setting[] }, name: string): RecordedComponent {
  const c = rowFor(el, name).components[0];
  if (!c) throw new Error(`setting ${name} rendered no component`);
  return c;
}

let ctx: ReturnType<typeof makeTab>;
beforeEach(() => {
  ctx = makeTab();
});

describe("the two settings paths cannot drift", () => {
  it("renders exactly the same rows, in the same groups, in the same order", () => {
    expect(imperativeRows(ctx.tab, ctx.el)).toEqual(declarativeRows(ctx.tab));
  });

  it("hands 1.13 a usable definition for every row", () => {
    // The comparison above only looks at names and descriptions, so a mapper
    // that dropped `render` would still line up — and every music link row
    // would render on 1.13 as a label with no box under it.
    for (const group of ctx.tab.getSettingDefinitions()) {
      const g = group as unknown as { heading: string; items: Record<string, unknown>[] };
      for (const item of g.items) {
        const kinds = ["control", "render", "action"].filter((k) => item[k] !== undefined);
        expect(kinds, `${g.heading} / ${String(item.name)}`).toHaveLength(1);
      }
    }
  });

  it("keeps the music link rows as render rows, not declared controls", () => {
    // Load-bearing: the link check owns a debounce and a staleness token, and
    // the declarative `validate` hook is awaited inside the control's own
    // per-keystroke handler with no sequencing — a slow answer to an old
    // keystroke would land after a newer one.
    const music = ctx.tab.getSettingDefinitions().find((g) => {
      return (g as { heading?: string }).heading === "Music";
    }) as unknown as { items: Record<string, unknown>[] };
    for (const item of music.items) {
      const name = String(item.name);
      if (!name.startsWith("Music link") && !name.startsWith("Name for link")) continue;
      expect(typeof item.render, name).toBe("function");
    }
  });

  it("covers every group heading", () => {
    ctx.tab.display();
    const headings = ctx.el.settings.filter((s) => s.heading).map((s) => s.name);
    expect(headings).toEqual([
      "Display & behavior",
      "Timer appearance",
      "Audio",
      "Music",
      "Long break",
      "Daily focus goal",
      "Task selector",
      "Task integration",
    ]);
  });

  it("gives every row a control, a rendered body or a button", () => {
    ctx.tab.display();
    for (const setting of ctx.el.settings) {
      if (setting.heading) continue;
      // The Audio group's outcome lines are text, not controls — they carry no
      // component by design and identify themselves with their own class.
      if (setting.settingEl.classes.includes("gp-setting-summary")) continue;
      expect(setting.components.length, `${setting.name} rendered nothing`).toBeGreaterThan(0);
    }
  });

  it("clears the container first, so a re-render cannot double every row", () => {
    ctx.tab.display();
    const first = ctx.el.settings.length;
    ctx.tab.display();
    expect(ctx.el.settings).toHaveLength(first);
  });
});

describe("controls are wired through setControlValue", () => {
  it("seeds each control from the stored value", () => {
    const seeded = makeTab({
      logFolderPath: "logs/pomodoro",
      autoOpenOnStartup: false,
      theme: "frosted-glass",
      longBreakMinutes: 17,
      taskSelectorDays: 14,
    });
    seeded.tab.display();
    expect(componentOf(seeded.el, "Pomodoro logs folder").value).toBe("logs/pomodoro");
    expect(componentOf(seeded.el, "Auto-open on startup").value).toBe(false);
    expect(componentOf(seeded.el, "Theme").value).toBe("frosted-glass");
    expect(componentOf(seeded.el, "Long break duration (minutes)").value).toBe("17");
    // Persisted as a number, rendered as a string option key.
    expect(componentOf(seeded.el, "Task lookahead window").value).toBe("14");
  });

  it("writes a toggle through, side effects and all", () => {
    ctx.tab.display();
    componentOf(ctx.el, "Loop music").change?.(false as never);
    expect(ctx.settings.musicLoop).toBe(false);
  });

  it("routes the status-bar toggle to its own setter rather than the raw field", () => {
    ctx.tab.display();
    componentOf(ctx.el, "Show status bar").change?.(false as never);
    expect(ctx.calls.map((c) => c.method)).toContain("setStatusBarVisibility");
  });

  it("drops every remembered position when resume is switched off", () => {
    ctx.tab.display();
    componentOf(ctx.el, "Resume where you left off").change?.(false as never);
    expect(ctx.calls.map((c) => c.method)).toContain("clearAllMusicPositions");
    // Unconditional save: clearAllMusicPositions only saves when it had
    // something to clear, so without this the toggle reverts on restart.
    expect(ctx.calls.map((c) => c.method)).toContain("saveSettings");
  });

  it("refuses a number the validation rejects instead of storing NaN", () => {
    ctx.tab.display();
    const before = ctx.settings.longBreakMinutes;
    componentOf(ctx.el, "Long break duration (minutes)").change?.("" as never);
    componentOf(ctx.el, "Long break duration (minutes)").change?.("not a number" as never);
    componentOf(ctx.el, "Long break duration (minutes)").change?.("0" as never);
    expect(ctx.settings.longBreakMinutes).toBe(before);
    componentOf(ctx.el, "Long break duration (minutes)").change?.("25" as never);
    expect(ctx.settings.longBreakMinutes).toBe(25);
  });

  it("does not persist a blank number box as zero", () => {
    // Both paths commit on every keystroke, so clearing a field to retype it
    // must not write an intermediate value — and Number("") is 0, which for
    // the daily focus goal is the value that DISABLES it. The pre-0.5.8
    // imperative path used parseInt, which rejected a blank box; routing both
    // paths through Number() quietly lost that.
    const seeded = makeTab({ dailyFocusGoalMinutes: 120 });
    seeded.tab.display();
    const goal = componentOf(seeded.el, "Daily focus goal (minutes)");
    goal.change?.("" as never);
    goal.change?.("   " as never);
    expect(seeded.settings.dailyFocusGoalMinutes).toBe(120);
    // A real zero is still how the goal is switched off.
    goal.change?.("0" as never);
    expect(seeded.settings.dailyFocusGoalMinutes).toBe(0);
  });

  it("keeps rejecting a blank box for every other number field", () => {
    const seeded = makeTab({ longBreakMinutes: 15, longBreakEvery: 4, taskSelectorDays: 7 });
    seeded.tab.display();
    for (const [name, expected] of [
      ["Long break duration (minutes)", 15],
      ["Long break frequency", 4],
    ] as const) {
      componentOf(seeded.el, name).change?.("" as never);
    }
    componentOf(seeded.el, "Task lookahead window").change?.("" as never);
    expect(seeded.settings.longBreakMinutes).toBe(15);
    expect(seeded.settings.longBreakEvery).toBe(4);
    expect(seeded.settings.taskSelectorDays).toBe(7);
  });

  it("offers every lookahead option, in order", () => {
    ctx.tab.display();
    expect(componentOf(ctx.el, "Task lookahead window").options.map((o) => o.value)).toEqual([
      "3",
      "5",
      "7",
      "14",
      "30",
    ]);
  });

  it("offers every registered theme", () => {
    ctx.tab.display();
    expect(componentOf(ctx.el, "Theme").options).toEqual([
      { value: "classic", label: "Classic" },
      { value: "frosted-glass", label: "Frosted glass" },
      { value: "pixel-city", label: "Pixel city" },
    ]);
  });
});

describe("marker maintenance buttons", () => {
  const rows = [
    ["Check for misplaced pomodoro count markers", "Check", "checkPomodoroMarkers", false],
    ["Repair misplaced pomodoro count markers", "Repair", "repairPomodoroMarkers", false],
    ["Remove misplaced pomodoro count markers", "Remove", "removeMisplacedPomodoroMarkers", true],
    ["Remove all pomodoro count markers", "Remove all", "removeAllPomodoroMarkers", true],
  ] as const;

  for (const [name, label, method, destructive] of rows) {
    it(`renders "${label}" and calls ${method}`, () => {
      ctx.tab.display();
      const c = componentOf(ctx.el, name);
      expect(c.kind).toBe("button");
      expect(c.buttonText).toBe(label);
      c.click?.();
      expect(ctx.calls.map((x) => x.method)).toContain(method);
    });

    it(`${destructive ? "marks" : "does not mark"} "${label}" destructive`, () => {
      // The two that delete counts must read as destructive. This is the one
      // thing the pre-1.13 path does that 1.13's action rows cannot, so it has
      // no counterpart to be checked against.
      ctx.tab.display();
      expect(componentOf(ctx.el, name).destructive).toBe(destructive);
    });
  }
});

describe("music link rows", () => {
  it("renders a text box per slot, seeded from its own setting", () => {
    const seeded = makeTab({ musicUrl: "https://youtu.be/aaaaaaaaaaa", musicUrl3: "" });
    seeded.tab.display();
    expect(componentOf(seeded.el, "Music link 1").value).toBe("https://youtu.be/aaaaaaaaaaa");
    expect(componentOf(seeded.el, "Music link 3").value).toBe("");
  });

  it("renders a name box per slot with its own placeholder", () => {
    const seeded = makeTab({ musicName2: "Rainy" });
    seeded.tab.display();
    expect(componentOf(seeded.el, "Name for link 2").value).toBe("Rainy");
    expect(componentOf(seeded.el, "Name for link 1").placeholder).toBe("Lofi");
  });

  it("only the first link carries the long explanation", () => {
    ctx.tab.display();
    expect(rowFor(ctx.el, "Music link 1").desc).not.toEqual(rowFor(ctx.el, "Music link 2").desc);
    expect(rowFor(ctx.el, "Music link 2").desc).toEqual(rowFor(ctx.el, "Music link 3").desc);
  });
});

// ---------------------------------------------------------------------------
// 0.6.3 — the Audio group. Four INDEPENDENT rows: two chimes and the two
// auto-start toggles that moved here from the timer panel. Nothing is
// conditional, which is the point — an earlier cut hid each chime while its
// auto-start was on, and a control vanishing because you turned something ON
// reads backwards.
// ---------------------------------------------------------------------------
describe("Audio group", () => {
  const names = (el: { settings: Setting[] }) =>
    el.settings.filter((s) => !s.heading).map((s) => s.name);

  const AUDIO_ROWS = [
    MASTER_SOUND_LABEL,
    "Play a sound when focus ends",
    AUTO_START_BREAK_LABEL,
    "Play a sound when a break ends",
    AUTO_START_FOCUS_LABEL,
  ];

  it("shows all four rows whatever the auto-start toggles are set to", () => {
    for (const overrides of [
      { autoStartBreak: false, autoStartFocus: false },
      { autoStartBreak: true, autoStartFocus: false },
      { autoStartBreak: false, autoStartFocus: true },
      { autoStartBreak: true, autoStartFocus: true },
    ]) {
      const c = makeTab(overrides);
      c.tab.display();
      for (const row of AUDIO_ROWS) {
        expect(names(c.el), `${row} with ${JSON.stringify(overrides)}`).toContain(row);
      }
    }
  });

  it("no row description promises the auto-start path always chimes", () => {
    // It no longer does — the chime toggle governs both paths. A stale
    // "Always chimes" here would be the one place the UI lies about behaviour.
    const c = makeTab();
    c.tab.display();
    for (const setting of c.el.settings) {
      expect(setting.desc.toLowerCase(), setting.name).not.toContain("always chimes");
    }
  });

  it("shows an outcome line under each pair, matching what the panel says", () => {
    const c = makeTab({ autoStartBreak: true, focusEndSoundEnabled: false });
    c.tab.display();
    const summaries = c.el.settings
      .filter((s) => s.settingEl.classes.includes("gp-setting-summary"))
      .map((s) => s.settingEl.children.map((child) => child.text).join(""));

    expect(summaries).toHaveLength(2);
    // The exact question this line exists to answer: auto-start on, chime off.
    expect(summaries[0]).toBe(sessionEndSummary("focus", c.settings));
    expect(summaries[0]).toBe("The break starts, with no sound.");
    expect(summaries[1]).toBe(sessionEndSummary("break", c.settings));
  });

  it("rewrites the outcome line when a setting is written, not just on reopen", async () => {
    // getSettingDefinitions() runs on every display(), but refreshDomState() —
    // all Obsidian runs after setControlValue — only re-evaluates predicates and
    // does NOT re-render. A description baked in at definition time would sit
    // there contradicting the toggle the user just flipped.
    const c = makeTab();
    c.tab.display();
    const summaryOf = (edge: "focus" | "break") =>
      c.el.settings
        .filter((s) => s.settingEl.classes.includes("gp-setting-summary"))
        [edge === "focus" ? 0 : 1].settingEl.children.map((child) => child.text)
        .join("");

    expect(summaryOf("focus")).toBe("Nothing — the timer counts up.");

    await c.tab.setControlValue("autoStartBreak", true);
    expect(summaryOf("focus")).toBe("The break starts, with no sound.");

    await c.tab.setControlValue("focusEndSoundEnabled", true);
    expect(summaryOf("focus")).toBe("A sound, then the break starts.");

    // And the other edge is untouched by either write.
    expect(summaryOf("break")).toBe("Nothing — the timer counts up.");
  });

  it("uses the same auto-start labels as the timer panel", () => {
    // These two strings are identical on both surfaces by design, so they are
    // shared rather than typed twice. The panel cannot be imported by a test
    // (it pulls in the whole Obsidian view), so it is read as text — the same
    // route tests/pixelCityArt.test.ts takes for view assertions.
    const view = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    expect(view).toContain("AUTO_START_BREAK_LABEL");
    expect(view).toContain("AUTO_START_FOCUS_LABEL");
    expect(view).toContain("MASTER_SOUND_LABEL");
    // ...and not a hand-typed copy that could drift from the tab's. Matched as
    // an ARGUMENT (`, "label")`) rather than as a bare substring: the label also
    // appears in prose comments, and a guard that cannot tell code from a
    // comment fails on the next person who explains why the const exists.
    for (const label of [AUTO_START_BREAK_LABEL, AUTO_START_FOCUS_LABEL, MASTER_SOUND_LABEL]) {
      expect(view, `${label} must come from the shared const`).not.toContain(`, "${label}")`);
    }

    const c = makeTab();
    c.tab.display();
    const names = c.el.settings.filter((s) => !s.heading).map((s) => s.name);
    expect(names).toContain(AUTO_START_BREAK_LABEL);
    expect(names).toContain(AUTO_START_FOCUS_LABEL);
    expect(names).toContain(MASTER_SOUND_LABEL);
  });

  it("re-arms the panel's row registries BEFORE any row registers", () => {
    // renderSettingsPanel() runs again on every gear-open and empties the
    // container first, so both registries must be cleared at the TOP. A reset
    // placed lower silently drops every row built above it — which shipped for
    // one commit: `sharedPanelRows = []` sat below the Audio section, so
    // "Timer sounds" registered and was immediately wiped, and changing it in
    // this tab left the panel's toggle stale. Read as text; nothing can import
    // the view.
    // Each registry is checked against ITS OWN first registration, not against
    // the first sharedToggle. Checking one common landmark is what let the
    // third instance of this bug through: the re-arm block sat below the two
    // Timing `numberRow` calls but above every `sharedToggle`, so the old
    // assertion passed while `numberPanelRows` was cleared the instant after
    // those two rows had pushed into it — the caret-guarded re-seed they exist
    // for never ran once in 0.6.3.
    const view = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    const registries: Record<string, string> = {
      sharedPanelRows: 'sharedToggle("',
      numberPanelRows: "numberRow(",
      segmentedPanelRows: "segmentedRow(",
      selectPanelRows: "selectRow<",
      conditionalPanelRows: "onlyWhen(",
      endSummaryLines: 'summaryFor("',
    };

    for (const [field, firstCall] of Object.entries(registries)) {
      const armed = view.indexOf(`this.${field} = [];`);
      const registration = view.indexOf(firstCall);
      expect(armed, `${field} must be re-armed`).toBeGreaterThan(-1);
      expect(registration, `no call site found for ${field} (${firstCall})`).toBeGreaterThan(-1);
      expect(armed, `${field} must be re-armed before the first ${firstCall}`).toBeLessThan(
        registration
      );
    }
  });

  it("re-seeds every panel row type, and guards the number inputs on focus", () => {
    // Reset to defaults in a SECOND panel fans out, so the number inputs are
    // genuinely reachable from elsewhere — the old "nothing else can change
    // them" reasoning was wrong. What that note was really protecting is the
    // caret: writing input.value mid-edit rewrites the field under the cursor.
    // Both properties are read off the shipped source; nothing can import the
    // view to exercise it directly.
    const view = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    const sync = view.slice(view.indexOf("private syncSettingsPanel()"));
    const body = sync.slice(0, sync.indexOf("\n  }"));

    for (const registry of [
      "sharedPanelRows",
      "segmentedPanelRows",
      "numberPanelRows",
      "selectPanelRows",
      "conditionalPanelRows",
      "endSummaryLines",
    ]) {
      expect(body, `${registry} must be re-seeded`).toContain(registry);
    }
    // It must never rebuild: renderSettingsPanel empties the container and
    // re-registers every listener, and registerDomEvent releases on unload
    // rather than removal — on a 50ms tick that leaks rows by the second.
    expect(body).not.toContain("renderSettingsPanel(");

    // The caret guard, on the number seed specifically.
    const numberRow = view.slice(view.indexOf("const numberRow = ("));
    expect(numberRow.slice(0, 1600)).toContain("activeDocument.activeElement === input");
  });

  it("writes each row through and fans out to open panels", async () => {
    // setControlValue ends in a silent `default: return;` and `key` is a
    // string, so a missing case is a no-op no compiler can see. All four are
    // dual-surface, so the fan-out is what stops an open gear panel showing a
    // stale toggle — the engine is idle and will not reconcile it.
    for (const key of [
      "focusEndSoundEnabled",
      "breakEndSoundEnabled",
      "autoStartBreak",
      "autoStartFocus",
      "soundEnabled",
    ] as const) {
      const c = makeTab();
      c.settings[key] = false;
      await c.tab.setControlValue(key, true);
      expect(c.settings[key], key).toBe(true);
      expect(
        c.calls.some((call) => call.method === "saveSettings"),
        key
      ).toBe(true);
      // The fan-out itself, now observable. Without it an open gear panel keeps
      // showing the old toggle: the engine is idle, so nothing reconciles it.
      expect(
        c.calls.some((call) => call.method === "applySettings"),
        `${key} must fan out to open views`
      ).toBe(true);
      expect(c.tab.getControlValue(key), key).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 0.6.3 — the mixer on both surfaces. Timer volume, Music sound and Music
// volume were gear-panel-only; the two volumes are also the plugin's first
// dual-surface NON-toggle settings, which is why the panel needed a re-seed
// for segmented rows before these rows could be added at all.
// ---------------------------------------------------------------------------
describe("the audio mixer across the two surfaces", () => {
  const audioGroup = (tab: GentlePomoSettingTab) => {
    const group = tab
      .getSettingDefinitions()
      .find((g) => (g as { heading?: string }).heading === "Audio");
    if (!group) throw new Error("no Audio group");
    return group as unknown as {
      heading: string;
      items: { name: string; desc?: string; control?: { key?: string } }[];
    };
  };

  it("carries both mutes and neither volume", () => {
    // The split is a decision, not an oversight: a level is something you move
    // WHILE LISTENING, which is a timer-panel gesture, and both volumes have
    // been panel-only since 0.1.2. The mutes are policy and belong here. Order
    // is asserted too — the two empty names are the outcome lines, text rows.
    expect(audioGroup(ctx.tab).items.map((i) => i.name)).toEqual([
      MASTER_SOUND_LABEL,
      MUSIC_SOUND_LABEL,
      "Play a sound when focus ends",
      AUTO_START_BREAK_LABEL,
      "",
      "Play a sound when a break ends",
      AUTO_START_FOCUS_LABEL,
      "",
    ]);
  });

  it("says where the volumes live, so their absence reads as a decision", () => {
    // Without this the tab is simply missing a control the panel has, which is
    // the complaint that started this work. Both switches point at the panel.
    const items = audioGroup(ctx.tab).items;
    const byKey = (key: string) => items.find((i) => i.control?.key === key);
    expect(byKey("soundEnabled")?.desc).toContain("timer panel");
    expect(byKey("musicSoundEnabled")?.desc).toContain("timer panel");
  });

  it("keeps no volume plumbing behind, on either read or write path", async () => {
    // A getControlValue branch or a setControlValue case for a row that no
    // longer exists is dead code that reads as an intention. Both volumes must
    // fall through to the generic passthrough and be unwritable from here.
    const c = makeTab();
    expect(c.settings.soundVolume).toBe(0.7);
    await c.tab.setControlValue("soundVolume", "low");
    await c.tab.setControlValue("musicVolume", "low");
    expect(c.settings.soundVolume, "the tab must not write soundVolume").toBe(0.7);
    expect(c.settings.musicVolume, "the tab must not write musicVolume").toBe(0.7);
  });

  it("still fans the music mute out to open panels", async () => {
    // It is the one mixer control that IS dual-surface, and the mute only
    // reaches the player through the view's musicVolume() accessor — so the
    // fan-out is what actually silences it, not just what repaints a toggle.
    const c = makeTab();
    await c.tab.setControlValue("musicSoundEnabled", false);
    expect(c.settings.musicSoundEnabled).toBe(false);
    expect(c.calls.some((call) => call.method === "applySettings")).toBe(true);
  });
});

describe("the timer panel's segmented rows re-seed", () => {
  // Nothing can import GentlePomoView, so these read it as text — the same
  // route tests/pixelCityArt.test.ts takes for view assertions.
  const view = () => readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");

  /** The bodies of the two `segmentedRow(...)` CALLS, not its definition. */
  // Indent-aware: the music volume row sits inside an `onlyWhen` block since
  // 0.6.4, so a fixed four-space split silently found only one of the two and
  // the assertions below passed over whichever row had moved.
  const segmentedCalls = (src: string) => {
    const out: string[] = [];
    const opener = /\n([ \t]*)segmentedRow\(/g;
    let match: RegExpExecArray | null;
    while ((match = opener.exec(src)) !== null) {
      const rest = src.slice(opener.lastIndex);
      out.push(rest.slice(0, rest.indexOf(`\n${match[1]});`)));
    }
    return out;
  };

  it("builds both volume rows from the shared stop list, not a re-typed one", () => {
    const calls = segmentedCalls(view());
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toContain("VOLUME_OPTIONS");
      // A second hand-typed list is the drift: the panel's nearest-stop rule
      // would still light "Mid" for a tab that stored 0.6, so the surfaces
      // would look consistent while holding different numbers.
      expect(call).not.toContain('label: "Low"');
    }
  });

  it("re-reads through the live settings object, not the captured one", () => {
    // loadSettings() replaces the settings object wholesale, and this closure
    // now runs on a tick rather than once — the same rule the extracted modules
    // follow (MusicHost, FocusTotalHost: calls, never captured references).
    for (const call of segmentedCalls(view())) {
      expect(call).toContain("() => this.plugin.settings.");
    }
  });

  it("fans a volume change out to the other open panels", () => {
    // Both volumes are dual-surface now, so a change made here has to reach
    // every other open panel's segmented row. Nothing else can: the engine
    // emits nothing at all while the timer is idle, so there is no tick to
    // converge on. Timer volume shipped without this and two open panels
    // genuinely disagreed.
    for (const call of segmentedCalls(view())) {
      expect(call).toContain("applySettingsToOpenViews()");
    }
  });

  it("re-arms the segmented registry BEFORE the first segmented row", () => {
    // Same rule as sharedPanelRows above, and the same shipped bug: a reset
    // placed lower silently drops every row built above it.
    const src = view();
    const armed = src.indexOf("this.segmentedPanelRows = [];");
    const firstRow = src.indexOf("\n    segmentedRow(");
    expect(armed).toBeGreaterThan(-1);
    expect(firstRow).toBeGreaterThan(-1);
    expect(armed, "segmentedPanelRows must be re-armed before the first segmentedRow").toBeLessThan(
      firstRow
    );
  });

  it("re-seeds the segmented rows from syncSettingsPanel, without rebuilding", () => {
    // The crux. syncSettingsPanel() walking only the toggles is exactly the
    // defect this release already shipped once for toggles: the tab moves the
    // value, the panel keeps the old highlight — and because the highlight IS
    // the control, tapping the button that looks active silently writes the
    // old value back over the change just made.
    //
    // And it must re-SEED, never re-render: renderSettingsPanel() empties the
    // container and re-registers every listener, and registerDomEvent releases
    // on unload rather than on removal, so a rebuild on the 50ms tick leaks
    // twenty detached rows a second.
    const src = view();
    const start = src.indexOf("private syncSettingsPanel()");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    expect(body).toContain("this.segmentedPanelRows");
    expect(body).toContain("seed()");
    expect(body).not.toContain("renderSettingsPanel()");
  });

  it("uses the shared mixer labels rather than re-typing them", () => {
    // Read with comments stripped: a label may legitimately be quoted in prose
    // above the row that uses it, and a guard that cannot tell code from a
    // comment fails on the next person who explains why the const exists.
    const code = view().replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, "");
    for (const label of [TIMER_VOLUME_LABEL, MUSIC_SOUND_LABEL, MUSIC_VOLUME_LABEL]) {
      expect(code, `${label} must come from the shared const`).not.toContain(`"${label}"`);
    }
    const src = view();
    expect(src).toContain("TIMER_VOLUME_LABEL");
    expect(src).toContain("MUSIC_SOUND_LABEL");
    expect(src).toContain("MUSIC_VOLUME_LABEL");
  });
});

describe("Task source (issue #4)", () => {
  it("offers the three sources, in the shared wording, on both paths", () => {
    const c = makeTab();
    c.tab.display();
    // The imperative path renders whatever the definitions declare, so reading
    // it back is how the pre-1.13 dropdown gets checked at all — it is dead
    // code on any Obsidian a contributor is actually running.
    const component = componentOf(c.el, TASK_SOURCE_SETTING_NAME);
    expect(component.kind).toBe("dropdown");
    expect(component.options).toEqual(
      TASK_SOURCE_ORDER.map((source) => ({ value: source, label: TASK_SOURCE_LABELS[source] }))
    );
    expect(component.value).toBe("folder");
  });

  it("sits ABOVE the folder path it governs", () => {
    // Choosing "Current note" is what makes that path irrelevant, so the reader
    // has to meet the decision before the field it decides about.
    const c = makeTab();
    const rows = declarativeRows(c.tab)
      .filter((r) => r.heading === "Task selector")
      .map((r) => r.name);
    expect(rows.indexOf(TASK_SOURCE_SETTING_NAME)).toBeLessThan(rows.indexOf("Tasks folder path"));
  });

  it("keeps the folder path row visible in every source", () => {
    // A control that vanished because you changed a dropdown reads as a fault.
    // 0.6.3 learned this with the chimes and deleted the visibility machinery
    // outright; nothing here may bring it back.
    for (const source of TASK_SOURCE_ORDER) {
      const c = makeTab({ taskSource: source });
      const names = declarativeRows(c.tab).map((r) => r.name);
      expect(names, source).toContain("Tasks folder path");
      expect(names, source).toContain("Task lookahead window");
    }
  });

  it("writes the source through, and fans out to open panels", async () => {
    const c = makeTab();
    await c.tab.setControlValue("taskSource", "current-note");

    expect(c.settings.taskSource).toBe("current-note");
    expect(c.calls.some((call) => call.method === "saveSettings")).toBe(true);
    // Dual-surface: without the fan-out the gear panel's own dropdown stays on
    // the old value, and an open picker never reloads against the new scope.
    expect(c.calls.some((call) => call.method === "applySettings")).toBe(true);
  });

  it("NEVER unlinks the current task when the source changes", async () => {
    // The maintainer's second requirement on issue #4. "Show task selector"
    // right beside it DOES unlink on the way off, so this is a real
    // neighbouring behaviour to be told apart, not a hypothetical.
    for (const source of TASK_SOURCE_ORDER) {
      const c = makeTab();
      const timer = { currentTaskName: "Write docs", setTask: () => calls.push("setTask") };
      const calls: string[] = [];
      (c.tab as unknown as { plugin: { timer: unknown } }).plugin.timer = timer;

      await c.tab.setControlValue("taskSource", source);

      expect(calls, source).toEqual([]);
      expect(timer.currentTaskName, source).toBe("Write docs");
    }
  });

  it("refuses a stored value that is not one of the three", async () => {
    const c = makeTab();
    await c.tab.setControlValue("taskSource", "everything, everywhere");
    expect(c.settings.taskSource).toBe("folder");
  });

  it("reads back a resolved value, so the dropdown always shows a selection", () => {
    // coerceToDefaults only drops a value whose TYPE disagrees, so a
    // hand-edited data.json can hold a string that is not one of the three.
    const c = makeTab({ taskSource: "nonsense" as never });
    expect(c.tab.getControlValue("taskSource")).toBe("folder");
  });
});

describe("Task source — one wording, two surfaces", () => {
  it("takes its name and its options from the shared consts in both places", () => {
    // One control asking one question. The user is told the two screens stay in
    // sync, so a re-typed literal in either is a promise quietly broken —
    // the same guard the auto-start labels carry, for the same reason.
    const view = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    expect(view).toContain("TASK_SOURCE_SETTING_NAME");
    expect(view).toContain("TASK_SOURCE_LABELS");
    expect(view).toContain("TASK_SOURCE_ORDER");

    // Searched over CODE only. These labels are dropdown option values, so
    // unlike the auto-start ones they have no single argument shape to match —
    // and a bare substring search fails on the next person who explains in a
    // comment why the const exists, which is exactly what it did here.
    const literals = [TASK_SOURCE_SETTING_NAME, ...Object.values(TASK_SOURCE_LABELS)];
    const tab = readFileSync(resolve(__dirname, "..", "GentlePomoSettingTab.ts"), "utf8");
    for (const file of [view, tab]) {
      for (const label of literals) {
        expect(codeOnly(file), `${label} must come from the shared const`).not.toContain(
          `"${label}"`
        );
      }
    }
  });
});

describe("the panel's feature-switch sections", () => {
  const view = () => readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");

  /** The body of an `onlyWhen(predicate, …)` block, keyed by its predicate. */
  const gatedBlocks = (src: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const opener = /\n([ \t]*)onlyWhen\(\n\s*\(\) => settings\.(\w+),/g;
    let match: RegExpExecArray | null;
    while ((match = opener.exec(src)) !== null) {
      const rest = src.slice(opener.lastIndex);
      out[match[2]] = rest.slice(0, rest.indexOf(`\n${match[1]});`));
    }
    return out;
  };

  it("gates the task-source row on the picker's own switch", () => {
    // Turning "Show task selector" off hides the picker AND unlinks the task,
    // so where that picker looks is then a setting for something absent.
    const block = gatedBlocks(view()).showTaskSelector;
    expect(block, "no onlyWhen block for showTaskSelector").toBeDefined();
    expect(block).toContain('section("Tasks")');
    expect(block).toContain("selectRow<");
  });

  it("gates both music rows on the music player's own switch", () => {
    // With the player off the iframe is destroyed, so a mute and a level here
    // would govern nothing that exists.
    const block = gatedBlocks(view()).showMusicPlayer;
    expect(block, "no onlyWhen block for showMusicPlayer").toBeDefined();
    expect(block).toContain("MUSIC_SOUND_LABEL");
    expect(block).toContain("MUSIC_VOLUME_LABEL");
  });

  it("leaves the timer's own audio rows ungated", () => {
    // Only the two rows belonging to the music player move. "Timer sounds" and
    // "Timer volume" answer to nothing above them and must never disappear.
    const gated = Object.values(gatedBlocks(view())).join("\n");
    expect(gated).not.toContain("MASTER_SOUND_LABEL");
    expect(gated).not.toContain("TIMER_VOLUME_LABEL");
    // Nor may the four end-of-session rows, which have no feature switch at
    // all — 0.6.3 deleted the machinery that hid those and this is not it back.
    expect(gated).not.toContain("AUTO_START_BREAK_LABEL");
    expect(gated).not.toContain("AUTO_START_FOCUS_LABEL");
    expect(gated).not.toContain('sharedToggle("focusEndSoundEnabled"');
    expect(gated).not.toContain('sharedToggle("breakEndSoundEnabled"');
  });

  it("hides by CSS class on the tick, never by re-rendering", () => {
    // renderSettingsPanel() empties the container and re-registers every
    // listener, and registerDomEvent releases on unload rather than removal —
    // rebuilding on a 50ms tick leaks rows by the second. The sync must reach
    // for a class instead. (That it must not call renderSettingsPanel at all is
    // asserted separately, on the whole method.)
    const src = view();
    const sync = src.slice(src.indexOf("private syncSettingsPanel()"));
    const body = sync.slice(0, sync.indexOf("\n  }"));
    expect(body).toContain("conditionalPanelRows");
    expect(body).toContain('toggleClass("gp-hidden"');
  });

  it("keeps both parent switches on a surface the panel cannot hide", () => {
    // A section that hides its own way back is a trap. Both switches live in
    // the settings tab, and so do the rows this hides.
    const c = makeTab();
    c.tab.display();
    const names = c.el.settings.filter((s) => !s.heading).map((s) => s.name);
    expect(names).toContain("Show task selector");
    expect(names).toContain("Show music player");
    expect(names).toContain(TASK_SOURCE_SETTING_NAME);
    expect(names).toContain(MUSIC_SOUND_LABEL);
  });
});

describe("the panel's captions", () => {
  it("keeps only the two end-of-session outcome lines", () => {
    // The master-sound and music-mute captions came out in 0.6.4: the Audio
    // section now shows two matched pairs (mute + level, twice), so the layout
    // makes the scope argument the prose used to. The two lines under the
    // end-of-session pairs STAY — they answer a question the labels genuinely
    // cannot ("does it still play if the break auto-starts?").
    const src = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    const panel = src.slice(src.indexOf("renderSettingsPanel() {"));
    const captions = panel.match(/gp-settings-hint/g) ?? [];
    expect(captions).toHaveLength(1); // the one summaryFor() builds, used twice
    expect(panel).toContain("sessionEndSummary");
  });
});

describe("the picker's live-reload guard has a trigger for every field it watches", () => {
  // GentlePomoView.applySettings reloads an OPEN task picker when
  // taskSettingsKey() moves. That guard only runs from applySettings, and the
  // engine emits nothing while the timer is idle — which is exactly when
  // someone is sitting in the settings tab. So every field the key names must
  // fan out, or the guard covers a subset of what it claims to. It shipped
  // covering one field of three.
  const watched = (): string[] => {
    const src = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    const fn = src.slice(src.indexOf("private taskSettingsKey()"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    return [...body.matchAll(/\$\{s\.(\w+)\}/g)].map((m) => m[1]);
  };

  it("names three fields, so a fourth cannot be added unnoticed", () => {
    expect(watched().sort()).toEqual(["taskSelectorDays", "taskSource", "tasksPath"]);
  });

  it("fans every one of them out to open views", async () => {
    const sample: Record<string, unknown> = {
      taskSource: "open-notes",
      tasksPath: "projects/active",
      taskSelectorDays: "30",
    };
    for (const key of watched()) {
      const c = makeTab();
      await c.tab.setControlValue(key, sample[key]);
      expect(
        c.calls.some((call) => call.method === "saveSettings"),
        key
      ).toBe(true);
      expect(
        c.calls.some((call) => call.method === "applySettings"),
        `${key} is in taskSettingsKey() but never reaches an open picker`
      ).toBe(true);
    }
  });
});

describe("the panel's Reset to defaults", () => {
  const panel = () => {
    const src = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    const whole = src.slice(src.indexOf("renderSettingsPanel() {"));
    const split = whole.indexOf(
      'const resetWrap = this.settingsPanel.createDiv("gp-settings-reset")'
    );
    return {
      rows: whole.slice(0, split),
      reset: whole.slice(split, whole.indexOf("\n  }", split)),
    };
  };

  it("restores every setting the panel's own controls write", () => {
    // A one-off list per control is how taskSource came to be the single
    // panel-visible row that ignored the button. Derived from the handlers
    // instead, so the next control added is covered on the day it lands.
    const { rows, reset } = panel();
    // Two ways a panel row writes a setting: directly (`settings.focusMinutes =`)
    // and through the shared-toggle helper, which writes `settings[key]` off a
    // key it was handed. Reading only the first form finds five of eleven.
    const written = new Set([
      ...[...rows.matchAll(/\bsettings\.(\w+) =/g)].map((m) => m[1]),
      ...[...rows.matchAll(/sharedToggle\("(\w+)"/g)].map((m) => m[1]),
    ]);
    expect(written.size, "no panel writers found — the slice is wrong").toBeGreaterThan(9);
    for (const key of written) {
      expect(reset, `Reset to defaults never restores ${key}`).toContain(`settings.${key} =`);
    }
  });
});
