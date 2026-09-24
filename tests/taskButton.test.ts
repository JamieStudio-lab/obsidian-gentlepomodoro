import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  TASK_LINE_REGEX,
  linkedTaskDisplayName,
  normalizeTaskText,
  normalizeTaskTextForDisplay,
} from "../taskLoader";
import { parseRules, stripComments } from "./cssRules";

/**
 * The "Current task" button (0.6.6).
 *
 * Until 0.6.6 the button printed the timer's raw task name — the
 * normalizeTaskText form, which keeps `#tags` — on one ellipsized line, while
 * the picker's rows printed the display form and wrapped. So a task read
 * `… Transcript 5 #task/research/aiprobe` on the button, cut short, with no
 * way to see the rest. The fix is display-only on purpose: the raw name is
 * the key every task comparison uses and the name the daily log records.
 *
 * Three files have to agree and nothing else checks them: the helper, the
 * view (read as text, since nothing can import it), and the stylesheet.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * The view as CODE: block comments and whole-line `//` comments removed, so a
 * line commented out cannot keep a guard green, and prose explaining a call
 * cannot be counted as one. (Trailing comments stay: a `//` can sit inside a
 * string, and nothing below depends on one.)
 */
const view = readFileSync(resolve(root, "GentlePomoView.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const code = squash(view);
const css = stripComments(readFileSync(resolve(root, "styles.css"), "utf8"));

const textOf = (line: string): string => {
  const match = line.match(TASK_LINE_REGEX);
  if (!match) throw new Error(`not a task line: ${line}`);
  return match[2];
};

/** Real lines from the maintainer's vault, the report's own shape. */
const LINES = [
  "- [ ] AI Probe - Phase 1 - Coding - Create Joint Code of Transcript 5 #task/research/aiprobe 🆔 xspepd ⏫ ➕ 2026-09-24 📅 2026-09-25",
  "- [ ] MAES - Staff interview paper - Draft manuscript - Revise 5.1 #task/research/maes/staff 🆔 f37r6h 🔺 ➕ 2026-09-07 🛫 2026-09-07 📅 2026-09-30 ",
  "- [ ] Register for CPR/AED and First Aid Training at Recwell #task/other/xx",
  "* [ ] Write the docs 🍅 3 ⏳ 2026-09-24",
  "- [ ] Plain task with no fields at all",
  // A tag written flush against a field, and the two Tasks fields the row
  // used to print: the row and the button must still read alike.
  "- [ ] Write summary #paper📅 2026-09-30",
  "- [ ] Write summary #paper🆔 abc123 📅 2026-09-30",
  "- [ ] Draft intro ⛔ xspepd,k2x9aa 📅 2026-09-30",
  "- [ ] Archive notes 🏁 delete 📅 2026-09-30",
];

describe("linkedTaskDisplayName", () => {
  it("drops the #tag the timer's name carries (the reported case)", () => {
    const clean = normalizeTaskText(textOf(LINES[0]));
    expect(clean).toContain("#task/research/aiprobe");
    expect(linkedTaskDisplayName(clean)).toBe(
      "AI Probe - Phase 1 - Coding - Create Joint Code of Transcript 5"
    );
  });

  it("reads exactly like the picker's row, minus the row's priority icon", () => {
    for (const line of LINES) {
      const text = textOf(line);
      const row = normalizeTaskTextForDisplay(text).replace(/\s*[🔺🔽🔥⏫⏬🔼]$/u, "");
      expect(linkedTaskDisplayName(normalizeTaskText(text))).toBe(row);
    }
  });

  it("drops a tag written flush against a field, and the ⛔ and 🏁 fields", () => {
    const names = LINES.slice(5).map((line) =>
      linkedTaskDisplayName(normalizeTaskText(textOf(line)))
    );
    expect(names).toEqual(["Write summary", "Write summary", "Draft intro", "Archive notes"]);
  });

  it("falls back to the name itself when it is nothing but tags, as the rows do", () => {
    expect(linkedTaskDisplayName("#task/other/xx")).toBe("#task/other/xx");
  });

  it("leaves a name with nothing to clean untouched", () => {
    expect(linkedTaskDisplayName("Plain task with no fields at all")).toBe(
      "Plain task with no fields at all"
    );
    expect(linkedTaskDisplayName("Untitled Task")).toBe("Untitled Task");
  });
});

describe("the timer's own name keeps its tags", () => {
  // The display fix must never move into normalizeTaskText. That form is the
  // key the picker, the 🆔 refresh, the completion unlink and the 🍅 counter
  // compare against, and the name written into `Task:: [[path|name]]` — a
  // Dataview query can read the tag straight off the log line.
  it("normalizeTaskText still returns the #tag", () => {
    expect(normalizeTaskText(textOf(LINES[2]))).toBe(
      "Register for CPR/AED and First Aid Training at Recwell #task/other/xx"
    );
  });

  it("and it is the name the view links, not the row's display text", () => {
    // The likeliest regression of all: "fixing" the button by linking the
    // display form. That strips the tag from the key and from the log line,
    // and every other test here would still pass.
    expect(code).toContain("this.timer.setTask(task.cleanText, task.path, task.taskId);");
    expect(code).not.toMatch(/setTask\(\s*task\.displayText/);
  });
});

describe("the view's task button", () => {
  /**
   * The tick's whole button block, pinned. It runs every 50ms, so each line is
   * load-bearing: the text and the tooltip both come from the display form,
   * and BOTH guard fields are written before the measure — drop either
   * assignment and the guard is always true, which means a DOM write and a
   * forced layout read on every tick (the iPhone-flicker shape).
   */
  const TICK_BLOCK = squash(`
    const linked = state.taskName !== NO_TASK_LABEL;
    const taskText = linked ? linkedTaskDisplayName(state.taskName) : "Select a task...";
    const fullText = linked ? taskText : "";
    if (taskText !== this.lastTaskBtnText || fullText !== this.taskBtnFullText) {
      this.lastTaskBtnText = taskText;
      this.taskBtnFullText = fullText;
      this.taskBtnText.setText(taskText);
      this.updateTaskBtnTooltip();
    }
  `);

  const TOOLTIP_METHOD = squash(`
    private updateTaskBtnTooltip() {
      const text = this.taskBtnText;
      const cut = this.taskBtnFullText !== "" && text.scrollHeight > text.clientHeight + 1;
      if (cut) this.taskBtn.setAttribute("title", this.taskBtnFullText);
      else this.taskBtn.removeAttribute("title");
    }
  `);

  it("writes the display form, text and tooltip alike, and only on a change", () => {
    expect(code).toContain(TICK_BLOCK);
    expect(code).not.toMatch(/setText\(\s*state\.taskName\s*\)/);
  });

  it("offers the full name through `title`, only while the clamp hides some of it", () => {
    expect(code).toContain(TOOLTIP_METHOD);
    // setTooltip() writes aria-label, and aria-label REPLACES the button's
    // accessible name ("Current task" and the name) — DESIGN.md entry 9.
    expect(code).not.toMatch(/setTooltip\(\s*this\.taskBtn/);
    expect(code).not.toMatch(/taskBtn\.setAttribute\(\s*"aria-label"/);
    expect(code).not.toMatch(/taskBtn\.ariaLabel\s*=/);
  });

  it("measures on a change of text, size or font — never per tick", () => {
    // Three calls and three only: the changed-text guard, the ResizeObserver,
    // and the font handler. Anything else is a candidate for the tick.
    const calls = [...code.matchAll(/this\.updateTaskBtnTooltip\(\)/g)].map((m) => m.index);
    expect(calls).toHaveLength(3);

    const inside = (start: string, end: string): boolean => {
      const from = code.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      const to = code.indexOf(end, from);
      return calls.some((at) => at > from && at < to);
    };
    expect(inside(TICK_BLOCK.slice(0, 60), "}")).toBe(true);
    expect(inside("new ResizeObserver(", "});")).toBe(true);
    expect(inside("const remeasureText = () => {", "};")).toBe(true);
  });

  it("re-measures when the box is laid out, and when a font change re-wraps it in place", () => {
    expect(code).toContain("this.resizeObserver.observe(btnText);");
    // A font or theme change can push a two-line name onto a hidden third line
    // with the clamped box keeping its exact size, so no observer fires.
    expect(code).toContain(
      'this.registerEvent(this.plugin.app.workspace.on("css-change", remeasureText));'
    );
    expect(code).toContain('fonts.addEventListener("loadingdone", remeasureText);');
    expect(code).toContain(
      'this.register(() => fonts.removeEventListener("loadingdone", remeasureText));'
    );
  });
});

describe("the task button's stylesheet", () => {
  const rules = parseRules(css);
  const bodyOf = (sel: string): string => {
    const found = rules.filter((r) => r.sel === sel && r.context.length === 0);
    expect(found, sel).toHaveLength(1);
    return found[0].body.replace(/\s+/g, " ");
  };

  it("lets the button grow past Obsidian's fixed button height", () => {
    // app.css: `button { height: var(--input-height) }`. min-height alone
    // holds the one-line box at 52px and lets a second line overflow it.
    expect(bodyOf(".gp-btn-full")).toMatch(/(^|;)\s*height: auto;/);
  });

  it("keeps its padding on the iPad, where Obsidian's tablet button rule out-ranks the base", () => {
    // app.css: `.is-tablet button:not(.clickable-icon) { padding: 4px 20px }`,
    // specificity (0,2,1). The touch rule must restate the base padding and
    // beat that outright — a tie would leave the winner to stylesheet order.
    const padding = (body: string): string | undefined =>
      /(?:^|;)\s*padding: ([^;]+);/.exec(body)?.[1];
    const base = padding(bodyOf(".gp-btn-full"));
    const touch = bodyOf("body.is-mobile button.gp-btn-full, body.is-tablet button.gp-btn-full");
    expect(base).toBeDefined();
    expect(padding(touch)).toBe(base);
  });

  it("clamps the name to two lines with an ellipsis", () => {
    const body = bodyOf(".gp-task-btn-text");
    expect(body).toContain("display: -webkit-box;");
    expect(body).toContain("-webkit-box-orient: vertical;");
    expect(body).toContain("-webkit-line-clamp: 2;");
    expect(body).toContain("overflow: hidden;");
    // Obsidian's button rule sets nowrap and it inherits; the clamp needs wrapping.
    expect(body).toContain("white-space: normal;");
    expect(body).not.toContain("nowrap");
  });
});
