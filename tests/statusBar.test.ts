import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import moment from "moment";
import {
  DEFAULT_STATUS_BAR_TIME,
  STATUS_BAR_TIMES,
  deriveStatusBarTime,
  formatClock,
  goalFraction,
  isOvertime,
  isTimerAction,
  resolveStatusBarTime,
  statusBarClasses,
  statusBarPhase,
  statusMenuEntries,
  statusMenuKey,
  statusModeLabel,
  statusTimeText,
  statusTooltip,
  type StatusBarLook,
  type StatusMenuEntry,
} from "../statusBar";
import { formatEndTime } from "../endTime";
import { DEFAULT_SETTINGS } from "../constants";
import type { MomentFactory } from "../momentTypes";
import type { TimerState } from "../types";

const MIN = 60_000;

function state(over: Partial<TimerState> = {}): TimerState {
  return {
    mode: "focus",
    isRunning: false,
    remainingMs: 25 * MIN,
    totalMs: 25 * MIN,
    taskName: "No Task",
    breakType: null,
    ...over,
  };
}

const idle = state();
const running = state({ isRunning: true, remainingMs: 12 * MIN + 30_000 });
const paused = state({ isRunning: false, remainingMs: 12 * MIN + 30_000 });
const overRunning = state({ isRunning: true, remainingMs: -(3 * MIN) + 10_000 });
const overPaused = state({ isRunning: false, remainingMs: -(3 * MIN) + 10_000 });
const shortBreak = state({
  mode: "break",
  breakType: "short",
  totalMs: 5 * MIN,
  remainingMs: 5 * MIN,
});
const longBreak = state({
  mode: "break",
  breakType: "long",
  totalMs: 15 * MIN,
  remainingMs: 15 * MIN,
});

const END = (ms: number) => `END@${String(ms)}`;
const NOW = 1_000_000;

describe("the time display setting", () => {
  it("offers exactly four choices, hidden by default", () => {
    expect(Object.keys(STATUS_BAR_TIMES)).toEqual(["hidden", "minutes", "clock", "end"]);
    expect(DEFAULT_STATUS_BAR_TIME).toBe("hidden");
    // DEFAULT_SETTINGS is also the merge base for an upgrade, and must agree.
    expect(DEFAULT_SETTINGS.statusBarTime).toBe("hidden");
    expect(DEFAULT_SETTINGS.statusBarShowTotal).toBe(false);
  });

  it("resolves a stored value by list, never through the prototype chain", () => {
    for (const id of Object.keys(STATUS_BAR_TIMES)) expect(resolveStatusBarTime(id)).toBe(id);
    for (const bad of ["toString", "constructor", "__proto__", "Clock", "", 3, null, undefined]) {
      expect(resolveStatusBarTime(bad)).toBe("hidden");
    }
  });

  it("keeps an upgrade's clock on, and starts everyone else hidden", () => {
    // Before 0.6.8 a click on the word flipped showStatusBarTimeLeft and
    // showed the clock; that is what such a user sees today.
    expect(deriveStatusBarTime({ showStatusBarTimeLeft: true })).toBe("clock");
    expect(deriveStatusBarTime({ showStatusBarTimeLeft: false })).toBe("hidden");
    expect(deriveStatusBarTime({})).toBe("hidden");
    // A fresh install, and a data.json that could not be read.
    expect(deriveStatusBarTime(null)).toBe("hidden");
  });

  it("derives nothing once a choice is stored — the legacy switch never overrides it", () => {
    expect(deriveStatusBarTime({ statusBarTime: "minutes", showStatusBarTimeLeft: true })).toBe(
      undefined
    );
    expect(deriveStatusBarTime({ statusBarTime: "hidden", showStatusBarTimeLeft: true })).toBe(
      undefined
    );
  });
});

describe("the four states", () => {
  it("tells idle, running and paused apart", () => {
    expect(statusBarPhase(idle)).toBe("idle");
    expect(statusBarPhase(running)).toBe("running");
    expect(statusBarPhase(paused)).toBe("paused");
  });

  it("calls a session paused in overtime paused, not idle", () => {
    expect(statusBarPhase(overPaused)).toBe("paused");
    expect(isOvertime(overPaused)).toBe(true);
  });

  it("marks time's up from the first moment past zero, and not at zero itself", () => {
    expect(isOvertime(state({ isRunning: true, remainingMs: 0 }))).toBe(false);
    expect(isOvertime(state({ isRunning: true, remainingMs: -1 }))).toBe(true);
    expect(isOvertime(running)).toBe(false);
  });

  it("names a long break as one", () => {
    expect(statusModeLabel(idle)).toBe("Focus");
    expect(statusModeLabel(shortBreak)).toBe("Break");
    expect(statusModeLabel(longBreak)).toBe("Long break");
  });
});

describe("the time text", () => {
  it("is empty when hidden, whatever the state", () => {
    for (const s of [idle, running, paused, overRunning]) {
      expect(statusTimeText(s, "hidden", NOW, END)).toBe("");
    }
  });

  it("rounds minutes up, so 0m never shows while time is left", () => {
    expect(statusTimeText(running, "minutes", NOW, END)).toBe("13m");
    expect(
      statusTimeText(state({ isRunning: true, remainingMs: 45_000 }), "minutes", NOW, END)
    ).toBe("1m");
    expect(statusTimeText(idle, "minutes", NOW, END)).toBe("25m");
  });

  it("counts overtime up with a plus, never +0m", () => {
    expect(statusTimeText(overRunning, "minutes", NOW, END)).toBe("+3m");
    expect(statusTimeText(state({ isRunning: true, remainingMs: -1 }), "minutes", NOW, END)).toBe(
      "+1m"
    );
  });

  it("shows the clock the timer panel shows", () => {
    expect(statusTimeText(running, "clock", NOW, END)).toBe("12:30");
    expect(statusTimeText(idle, "clock", NOW, END)).toBe("25:00");
    expect(formatClock(-(3 * MIN + 12_000))).toBe("+03:12");
    // Seconds round up, like the panel's clock.
    expect(formatClock(59_001)).toBe("01:00");
  });

  it("names the end only while there is an end to name", () => {
    expect(statusTimeText(running, "end", NOW, END)).toBe(
      `END@${String(NOW + running.remainingMs)}`
    );
    for (const s of [idle, paused, overRunning, overPaused]) {
      expect(statusTimeText(s, "end", NOW, END)).toBe("");
    }
  });
});

describe("the goal ring", () => {
  it("is the share of today's goal done, capped at a full ring", () => {
    expect(goalFraction(0, 240)).toBe(0);
    expect(goalFraction(120 * 60, 240)).toBe(0.5);
    expect(goalFraction(500 * 60, 240)).toBe(1);
  });

  it("is empty with no goal, or with a goal that is not a number", () => {
    expect(goalFraction(3600, 0)).toBe(0);
    expect(goalFraction(3600, -5)).toBe(0);
    expect(goalFraction(3600, Number.NaN)).toBe(0);
  });
});

describe("the state classes", () => {
  const look = (over: Partial<StatusBarLook> = {}): StatusBarLook => ({
    phase: "idle",
    overtime: false,
    goalOn: true,
    goalMet: false,
    time: "hidden",
    showTotal: false,
    ...over,
  });
  const on = (s: TimerState, l: StatusBarLook) =>
    statusBarClasses(s, l)
      .filter(([, v]) => v)
      .map(([c]) => c);

  it("puts exactly one phase class on", () => {
    for (const phase of ["idle", "running", "paused"] as const) {
      const classes = on(idle, look({ phase }));
      expect(classes.filter((c) => /^gp-state-(idle|running|paused)$/.test(c))).toEqual([
        `gp-state-${phase}`,
      ]);
    }
  });

  it("lists every class it can set, so a class never lingers from the state before", () => {
    const names = statusBarClasses(idle, look()).map(([c]) => c);
    expect(names).toEqual([
      "gp-state-idle",
      "gp-state-running",
      "gp-state-paused",
      "gp-state-overtime",
      "gp-mode-focus",
      "gp-mode-break",
      "gp-break-long",
      "gp-goal-on",
      "gp-goal-met",
      "gp-time-hidden",
      "gp-time-minutes",
      "gp-time-clock",
      "gp-time-end",
      "gp-show-total",
    ]);
  });

  it("marks a long break, and only a break", () => {
    expect(on(longBreak, look())).toContain("gp-break-long");
    expect(on(shortBreak, look())).not.toContain("gp-break-long");
    expect(on(state({ breakType: "long" }), look())).not.toContain("gp-break-long");
  });

  it("follows the look it is given", () => {
    const classes = on(
      running,
      look({ phase: "running", overtime: true, goalMet: true, time: "end", showTotal: true })
    );
    expect(classes).toEqual(
      expect.arrayContaining([
        "gp-state-running",
        "gp-state-overtime",
        "gp-mode-focus",
        "gp-goal-on",
        "gp-goal-met",
        "gp-time-end",
        "gp-show-total",
      ])
    );
    expect(on(running, look({ goalOn: false }))).not.toContain("gp-goal-on");
  });
});

describe("the hover text", () => {
  const base = {
    nowMs: NOW,
    formatEnd: () => "Ends 15:30",
    taskName: null,
    todayText: "1h 24m",
    goalText: "4h 0m",
    goalMet: false,
  };

  it("says what the item leaves out, one fact per line", () => {
    expect(statusTooltip({ ...base, state: running, taskName: "Write the docs" })).toBe(
      [
        "Focus: 13 min left. Ends 15:30",
        "Task: Write the docs",
        "Today: 1h 24m of 4h 0m",
        "Click for timer controls",
      ].join("\n")
    );
  });

  it("covers each state", () => {
    const first = (s: TimerState) => statusTooltip({ ...base, state: s }).split("\n")[0];
    expect(first(idle)).toBe("Focus: not started (25 min)");
    expect(first(paused)).toBe("Focus: paused, 13 min left");
    expect(first(overRunning)).toBe("Focus: time is up (3 min over)");
    expect(first(overPaused)).toBe("Focus: time is up (3 min over), paused");
    expect(first(longBreak)).toBe("Long break: not started (15 min)");
  });

  it("drops the task line with no task, and the goal with no goal", () => {
    const lines = statusTooltip({ ...base, state: idle, goalText: null }).split("\n");
    expect(lines).toEqual([
      "Focus: not started (25 min)",
      "Today: 1h 24m",
      "Click for timer controls",
    ]);
  });

  it("says when the goal is met", () => {
    expect(statusTooltip({ ...base, state: idle, goalMet: true })).toContain(
      "Today: 1h 24m of 4h 0m (goal met)"
    );
  });
});

describe("the menu", () => {
  const titles = (entries: (StatusMenuEntry | null)[]) => entries.map((e) => (e ? e.title : "—"));

  it("offers Start, Skip, the panel and the time choices when idle — nothing to finish yet", () => {
    expect(titles(statusMenuEntries(idle, "hidden"))).toEqual([
      "Start",
      "Skip to next",
      "—",
      "Open timer",
      "—",
      "Hide time",
      "Show minutes left",
      "Show clock",
      "Show end time",
    ]);
  });

  it("offers Pause and Finish & next while running", () => {
    expect(titles(statusMenuEntries(running, "hidden")).slice(0, 3)).toEqual([
      "Pause",
      "Finish & next",
      "Skip to next",
    ]);
  });

  it("offers Resume once a session has begun, in overtime too", () => {
    for (const s of [paused, overPaused]) {
      expect(titles(statusMenuEntries(s, "hidden")).slice(0, 3)).toEqual([
        "Resume",
        "Finish & next",
        "Skip to next",
      ]);
    }
  });

  it("checks the time display in use, and only that one", () => {
    for (const time of ["hidden", "minutes", "clock", "end"] as const) {
      const checked = statusMenuEntries(idle, time)
        .filter((e): e is StatusMenuEntry => e !== null && e.checked === true)
        .map((e) => e.action);
      expect(checked).toEqual([`time:${time}`]);
    }
  });

  it("gives every entry an icon, so no title sits out of line", () => {
    // Obsidian's menu gives an item without an icon no icon column.
    for (const s of [idle, running, paused]) {
      for (const e of statusMenuEntries(s, "clock")) {
        if (e) expect(e.icon, e.title).not.toBe("");
      }
    }
  });

  it("uses the names the panel and the command palette use", () => {
    const main = readFileSync(resolve(__dirname, "..", "main.ts"), "utf8");
    expect(main).toContain('name: "Finish & next"');
    expect(main).toContain('name: "Skip to next"');
  });
});

describe("the menu's guard against a timer that moved on", () => {
  it("marks exactly the five timer actions", () => {
    for (const a of ["start", "resume", "pause", "finish", "skip"] as const) {
      expect(isTimerAction(a), a).toBe(true);
    }
    for (const a of ["open", "time:hidden", "time:minutes", "time:clock", "time:end"] as const) {
      expect(isTimerAction(a), a).toBe(false);
    }
  });

  it("keys on the session and the phase, and on nothing that ticks", () => {
    expect(statusMenuKey(4, running)).toBe(
      statusMenuKey(4, state({ isRunning: true, remainingMs: 1 }))
    );
    // Time's up is the same session in the same phase: Finish still applies.
    expect(statusMenuKey(4, running)).toBe(statusMenuKey(4, overRunning));
    expect(statusMenuKey(4, running)).not.toBe(statusMenuKey(5, running));
    expect(statusMenuKey(4, running)).not.toBe(statusMenuKey(4, paused));
    expect(statusMenuKey(4, paused)).not.toBe(statusMenuKey(4, idle));
  });
});

describe("the end time the panel and the status bar share", () => {
  const m = moment as unknown as MomentFactory;

  it("names today's end plainly", () => {
    const end = moment().add(10, "minutes");
    // Skip the one minute before midnight, where +10 minutes is tomorrow.
    if (!end.isSame(moment(), "day")) return;
    expect(formatEndTime(m, end.valueOf())).toBe(`Ends ${end.format("LT")}`);
  });

  it("counts calendar days past today", () => {
    const tomorrow = moment().add(1, "day").startOf("day").add(1, "hour");
    expect(formatEndTime(m, tomorrow.valueOf())).toBe(`Ends ${tomorrow.format("LT")} (+1 day)`);
    const later = moment().add(3, "days").startOf("day").add(1, "hour");
    expect(formatEndTime(m, later.valueOf())).toBe(`Ends ${later.format("LT")} (+3 days)`);
  });
});

describe("the plugin's wiring", () => {
  // main.ts cannot be imported by a test (it pulls in the whole view), so the
  // lines that matter are read as text, comments stripped.
  const main = readFileSync(resolve(__dirname, "..", "main.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
  const create = main.slice(
    main.indexOf("private createStatusBar() {"),
    main.indexOf("private destroyStatusBar() {")
  );
  /** A method's text, from its signature to the next member's. */
  const method = (signature: string, next: string): string => {
    const at = main.indexOf(signature);
    expect(at, signature).toBeGreaterThan(-1);
    const end = main.indexOf(next, at);
    expect(end, next).toBeGreaterThan(at);
    return main.slice(at, end);
  };

  it("opens the menu from a click and from a right-click, and does nothing else on either", () => {
    expect(create).toContain(
      'this.registerDomEvent(item, "click", (evt) => { evt.preventDefault(); this.openStatusMenu(evt); });'
    );
    expect(create).toContain(
      'this.registerDomEvent(item, "contextmenu", (evt) => { evt.preventDefault(); this.openStatusMenu(evt); });'
    );
    // The old hidden gestures are gone: two targets, two actions, no hint.
    expect(create.match(/registerDomEvent\(/g)).toHaveLength(2);
    expect(main).not.toContain("showStatusBarTimeLeft = !this.settings.showStatusBarTimeLeft");
  });

  it("uses Obsidian's own clickable style", () => {
    expect(create).toContain('item.addClasses(["gp-status", "mod-clickable"]);');
  });

  it("closes an open menu when the timer moves on, before painting", () => {
    expect(create).toContain(
      "this.statusTimerListener = (state) => { this.closeStaleStatusMenu(state); this.updateStatusBar(state); };"
    );
    const close = main.slice(
      main.indexOf("private closeStaleStatusMenu(state: TimerState): void {")
    );
    expect(close.slice(0, close.indexOf("private async runStatusMenuAction"))).toContain(
      "if (statusMenuKey(this.timer.session, state) !== this.statusMenuFor) this.statusMenu.hide();"
    );
  });

  it("drops a timer action chosen for a session that is gone", () => {
    const run = main.slice(main.indexOf("private async runStatusMenuAction("));
    const guard = run.indexOf(
      "if ( isTimerAction(action) && statusMenuKey(this.timer.session, this.timer.getState()) !== builtFor ) { return; }"
    );
    expect(guard).toBeGreaterThan(-1);
    // Before the switch that acts.
    expect(guard).toBeLessThan(run.indexOf("switch (action)"));
    expect(main).toContain("void this.runStatusMenuAction(entry.action, builtFor);");
    expect(main).toContain("const builtFor = statusMenuKey(this.timer.session, state);");
  });

  it("records the key it opened for, so the stale check leaves a current menu alone", () => {
    // Without the record, the first emit compares against null and closes the
    // menu within 50ms of opening — every running session.
    const open = method(
      "private openStatusMenu(evt: MouseEvent): void {",
      "private closeStaleStatusMenu("
    );
    expect(open).toContain("this.statusMenu = menu;");
    expect(open).toContain("this.statusMenuFor = builtFor;");
    expect(open.indexOf("this.statusMenuFor = builtFor;")).toBeLessThan(
      open.indexOf("menu.showAtMouseEvent(evt);")
    );
  });

  it("always uses Obsidian's DOM menu, which code can close", () => {
    // Native menus (Obsidian's default on macOS) ignore Menu.hide(): a stale
    // menu stayed on screen with every timer entry dead.
    const open = method(
      "private openStatusMenu(evt: MouseEvent): void {",
      "private closeStaleStatusMenu("
    );
    expect(open).toContain("const menu = new Menu().setUseNativeMenu(false);");
  });

  it("writes the ring only when its rounded value changes", () => {
    const update = main.slice(
      main.indexOf("private updateStatusBar(state: TimerState, force = false)")
    );
    expect(update).toContain(
      "const goal = (Math.round(goalFraction(focusSeconds, goalMinutes) * 100) / 100).toString();"
    );
    expect(update).toContain(
      'if (goal !== this.lastStatusGoal) { this.lastStatusGoal = goal; item.style.setProperty("--gp-goal", goal); }'
    );
  });

  it("forgets every write guard when the item goes, so a re-shown bar paints in full", () => {
    // Each guard skips a write to ONE element; left set, a re-created item
    // never gets its ring value or its tooltip.
    const destroy = method("private destroyStatusBar() {", "private openStatusMenu(");
    for (const reset of [
      "this.lastStatusKey = null;",
      "this.lastStatusTooltip = null;",
      "this.lastStatusGoal = null;",
      "this.statusMenu?.hide();",
    ]) {
      expect(destroy, reset).toContain(reset);
    }
  });

  it("keeps the legacy switch in step with the time display, and repaints after saving", () => {
    const setter = method("async setStatusBarTime(value: unknown)", "refreshStatusBar(): void");
    expect(setter).toContain('this.settings.showStatusBarTimeLeft = time !== "hidden";');
    // The timer is silent while idle, so the choice would not show otherwise.
    const save = setter.indexOf("await this.saveSettings();");
    expect(save).toBeGreaterThan(-1);
    expect(setter.indexOf("this.refreshStatusBar();")).toBeGreaterThan(save);
  });

  it("repaints the status bar and every open panel's goal line when the goal changes", () => {
    const refresh = method("refreshGoalDisplays(): void {", "private updateStatusBar(");
    expect(refresh).toContain("this.updateStatusBar(state, true);");
    // The status bar can be hidden, and then the panels are the only goal line.
    expect(refresh).toMatch(
      /for \(const leaf of this\.app\.workspace\.getLeavesOfType\(VIEW_TYPE_GENTLE_POMO\)\) \{ if \(leaf\.view instanceof GentlePomoView\) this\.refreshViewGoalProgress\(leaf\.view, state\); \}/
    );
    const folder = method("logFolderChanged(): void {", "refreshGoalDisplays(): void {");
    expect(folder).toContain("this.logManager.invalidateTodayTotal();");
    expect(folder).toContain("this.refreshGoalDisplays();");
  });

  it("seeds the time display from the stored file before the defaults fill it in", () => {
    const load = main.slice(main.indexOf("async loadSettings() {"));
    const derive = load.indexOf("const statusBarTime = deriveStatusBarTime(loaded);");
    const merge = load.indexOf(
      "this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});"
    );
    expect(derive).toBeGreaterThan(-1);
    expect(derive).toBeLessThan(merge);
  });

  it("repaints when anything the item shows changes, not just the second", () => {
    const update = main.slice(
      main.indexOf("private updateStatusBar(state: TimerState, force = false)")
    );
    const key = update.slice(
      update.indexOf("const key = [") + "const key = [".length,
      update.indexOf('].join("\\n");')
    );
    expect(update).toContain("const second = Math.ceil(Math.abs(state.remainingMs) / 1000);");
    // The gate itself: compared, then stored.
    expect(update).toContain(
      "if (!force && key === this.lastStatusKey) return; this.lastStatusKey = key;"
    );
    // Exact entries, not substrings — "time" is inside "isOvertime(state)".
    const entries = key
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    expect([...entries].sort()).toEqual(
      [
        "second",
        "statusBarPhase(state)",
        "isOvertime(state)",
        "state.mode",
        "state.breakType",
        "state.isRunning",
        "state.totalMs",
        "state.taskName",
        "time",
        "showTotal",
        "goalMinutes",
      ].sort()
    );
  });
});

describe("the stylesheet and the code agree", () => {
  // The look is CSS keyed off class names the code sets, so a typo on either
  // side fails silently: a state that never shows, or a rule for nothing.
  const css = readFileSync(resolve(__dirname, "..", "styles.css"), "utf8");
  const start = css.indexOf("/* ===== Status bar (0.6.8) =====");
  const end = css.indexOf("/* Disabled State for Buttons */");
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const icons = readFileSync(resolve(__dirname, "..", "icons.ts"), "utf8");
  const main = readFileSync(resolve(__dirname, "..", "main.ts"), "utf8");
  const classesIn = (text: string) =>
    new Set([...text.matchAll(/\.(gp-[a-z-]+)/g)].map((m) => m[1]));

  it("finds its own block", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("styles only state classes the code can set", () => {
    const settable = new Set(
      statusBarClasses(state(), {
        phase: "idle",
        overtime: false,
        goalOn: false,
        goalMet: false,
        time: "hidden",
        showTotal: false,
      }).map(([c]) => c)
    );
    // Every class the block names is a built part, the item's own class, or
    // one statusBarClasses can set — no prefix filter, so a mistyped state
    // ("gp-running", the old dot's class) fails too.
    const named = [...classesIn(block)];
    expect(named.length).toBeGreaterThan(0);
    for (const c of named) {
      if (c === "gp-status" || c.startsWith("gp-status-")) continue;
      expect(settable.has(c), c).toBe(true);
    }
  });

  it("styles every part the code builds, and builds every part it styles", () => {
    const built = new Set([
      ...[...icons.matchAll(/svgPart\("[a-z]+", "(gp-status-[a-z-]+)"/g)].map((m) => m[1]),
      ...[...main.matchAll(/createSpan\(\{ cls: "(gp-status-[a-z-]+)"/g)].map((m) => m[1]),
    ]);
    const styled = new Set([...classesIn(block)].filter((c) => c.startsWith("gp-status-")));
    // The item's own class is set with addClasses, not built as a part.
    styled.delete("gp-status");
    expect([...built].sort()).toEqual([...styled].sort());
  });

  it("never loops an animation in the corner of the eye", () => {
    expect(block).not.toMatch(/@keyframes|animation\s*:/);
  });

  it("turns off every transition it declares under reduced motion", () => {
    const at = block.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThan(-1);
    // The @media's own body, by brace matching.
    const open = block.indexOf("{", at);
    let depth = 0;
    let close = open;
    for (let i = open; i < block.length; i++) {
      if (block[i] === "{") depth++;
      else if (block[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    const inside = block.slice(open + 1, close);
    // Every rule elsewhere in the block — before AND after the @media.
    const outside = block.slice(0, at) + block.slice(close + 1);
    const silenced = new Set<string>();
    for (const m of inside.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/transition\s*:\s*none/.test(m[2])) continue;
      for (const sel of m[1].split(",")) silenced.add(sel.trim());
    }
    let declared = 0;
    for (const m of outside.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/transition\s*:/.test(m[2])) continue;
      for (const selector of m[1].split(",").map((x) => x.trim())) {
        declared++;
        expect(silenced.has(selector), selector).toBe(true);
      }
    }
    expect(declared).toBeGreaterThan(0);
  });
});
