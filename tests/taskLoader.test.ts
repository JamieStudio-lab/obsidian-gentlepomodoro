import { describe, it, expect } from "vitest";
import {
  TASK_LINE_REGEX,
  normalizeTaskText,
  normalizeTaskTextForDisplay,
  findTaskTextByIdInContent,
  taskLineName,
  taskNameAfterEdit,
  parsePomodoroCount,
  incrementPomodoroCount,
  repairPomodoroMarkerPlacement,
  repairPomodoroMarkersInContent,
  removeMisplacedPomodoroMarker,
  removeMisplacedPomodoroMarkersInContent,
  removeAnyPomodoroMarker,
  removeAllPomodoroMarkersInContent,
} from "../taskLoader";

describe("normalizeTaskText", () => {
  it("returns plain text unchanged (trimmed)", () => {
    expect(normalizeTaskText("Write the docs")).toBe("Write the docs");
    expect(normalizeTaskText("  Write the docs  ")).toBe("Write the docs");
  });

  it("strips scheduled (⏳) and due (📅) dates", () => {
    expect(normalizeTaskText("Write docs ⏳ 2025-12-23")).toBe("Write docs");
    expect(normalizeTaskText("Write docs 📅 2025-12-25")).toBe("Write docs");
    expect(normalizeTaskText("Write docs ⏳ 2025-12-23 📅 2025-12-25")).toBe("Write docs");
  });

  it("strips Tasks-plugin ID markers (🆔)", () => {
    expect(normalizeTaskText("Write docs 🆔 abc123")).toBe("Write docs");
    expect(normalizeTaskText("Write docs 🆔 ABC_xyz-1")).toBe("Write docs");
  });

  it("strips priority emoji and recurrence markers", () => {
    expect(normalizeTaskText("Write docs 🔺")).toBe("Write docs");
    expect(normalizeTaskText("Write docs 🔁 every week")).toBe("Write docs");
  });

  it("handles a real-world mixed line", () => {
    const input = "Write docs 🔺 ⏳ 2025-12-23 📅 2025-12-25 🆔 abc123";
    expect(normalizeTaskText(input)).toBe("Write docs");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeTaskText("")).toBe("");
  });
});

describe("normalizeTaskTextForDisplay", () => {
  it("strips dates and IDs but keeps the priority icon as a suffix", () => {
    expect(normalizeTaskTextForDisplay("Write docs 🔺 ⏳ 2025-12-23 🆔 abc")).toBe("Write docs 🔺");
  });

  it("strips hashtags (display flavor only)", () => {
    expect(normalizeTaskTextForDisplay("Write docs #project ⏳ 2025-12-23")).toBe("Write docs");
  });

  it("matches normalizeTaskText output when no priority icon is present", () => {
    const input = "Write docs ⏳ 2025-12-23";
    expect(normalizeTaskTextForDisplay(input)).toBe("Write docs");
  });
});

describe("TASK_LINE_REGEX", () => {
  it("matches every bullet form the Tasks plugin accepts", () => {
    for (const bullet of ["-", "*", "+", "1.", "12)"]) {
      const match = `${bullet} [ ] Write docs 📅 2026-08-14`.match(TASK_LINE_REGEX);
      expect(match?.[1]).toBe(" ");
      expect(match?.[2]).toBe("Write docs 📅 2026-08-14");
    }
  });

  it("captures the completed status char on any bullet", () => {
    expect("* [x] Done task".match(TASK_LINE_REGEX)?.[1]).toBe("x");
    expect("2. [X] Done task".match(TASK_LINE_REGEX)?.[1]).toBe("X");
  });

  it("parses the asterisk-bulleted line that was invisible before 0.5.5", () => {
    const line =
      "* [ ] Dissertation - AI workflow - Update the skills and housekeeping 1 #task/research/dissertation 🆔 xy8ffp 🔼 ➕ 2026-08-13 📅 2026-08-14";
    const match = line.match(TASK_LINE_REGEX);
    expect(match?.[1]).toBe(" ");
    expect(normalizeTaskText(match?.[2] ?? "")).toBe(
      "Dissertation - AI workflow - Update the skills and housekeeping 1 #task/research/dissertation"
    );
  });

  it("does not match non-task lines", () => {
    expect(TASK_LINE_REGEX.test("Plain prose with * [ ] mid-line")).toBe(false);
    expect(TASK_LINE_REGEX.test("- 🍅 Focus | Task:: [[a.md|A]] | Start:: 2025-12-23")).toBe(false);
    expect(TASK_LINE_REGEX.test("- [ ]")).toBe(false);
  });

  it("keeps the historical leniency about the space between bullet and checkbox", () => {
    expect(TASK_LINE_REGEX.test("-[ ] tight bullet")).toBe(true);
  });
});

describe("findTaskTextByIdInContent", () => {
  // The line's text; taskLineName makes the name the picker would link it by.
  const findTaskNameByIdInContent = (content: string, taskId: string) => {
    const text = findTaskTextByIdInContent(content, taskId);
    return text === null ? null : taskLineName(text);
  };

  const content = [
    "Some notes about the project.",
    "",
    "- [ ] First task ⏳ 2025-12-23 🆔 first-id",
    "- [x] Done task ⏳ 2025-12-20 🆔 done-id",
    "- [ ] Unrelated task with no ID",
    "- [ ] Second task 🆔 second-id 🔺",
  ].join("\n");

  it("returns the normalized name for an open task matching the ID", () => {
    expect(findTaskNameByIdInContent(content, "first-id")).toBe("First task");
  });

  it("matches a completed task too", () => {
    expect(findTaskNameByIdInContent(content, "done-id")).toBe("Done task");
  });

  it("strips priority emoji from the matched task name", () => {
    expect(findTaskNameByIdInContent(content, "second-id")).toBe("Second task");
  });

  it("returns null when no task matches the ID", () => {
    expect(findTaskNameByIdInContent(content, "missing-id")).toBeNull();
  });

  it("returns null for empty inputs", () => {
    expect(findTaskNameByIdInContent("", "anything")).toBeNull();
    expect(findTaskNameByIdInContent(content, "")).toBeNull();
  });

  it("finds tasks on asterisk, plus, and numbered bullets", () => {
    const altBullets = [
      "* [ ] Star task ⏳ 2025-12-23 🆔 star-id",
      "+ [ ] Plus task 🆔 plus-id",
      "3. [ ] Numbered task 🆔 num-id",
    ].join("\n");
    expect(findTaskNameByIdInContent(altBullets, "star-id")).toBe("Star task");
    expect(findTaskNameByIdInContent(altBullets, "plus-id")).toBe("Plus task");
    expect(findTaskNameByIdInContent(altBullets, "num-id")).toBe("Numbered task");
  });
});

describe("taskNameAfterEdit", () => {
  // The name a task with a 🆔 goes by once its line changes: the line's name,
  // unless all that changed is the 🍅 counter's count.
  const name = (text: string) => normalizeTaskText(text);

  it.each([
    ["the first count", "Write docs", "Write docs 🍅 1 ⏳ 2026-10-01 🆔 x"],
    ["a count going up", "Write docs 🍅 3", "Write docs 🍅 4 ⏳ 2026-10-01 🆔 x"],
    ["the count removed", "Write docs 🍅 3", "Write docs ⏳ 2026-10-01 🆔 x"],
    ["a count set by hand", "Write docs 🍅 3", "Write docs 🍅 12 🆔 x"],
    [
      "a tag after the fields",
      name("Write docs 🍅 3 ⏳ 2026-10-01 #task/research/docs 🆔 x"),
      "Write docs 🍅 4 ⏳ 2026-10-01 #task/research/docs 🆔 x",
    ],
    [
      "text after the fields",
      name("Write docs ⏳ 2026-10-01 see notes 🆔 x"),
      "Write docs 🍅 1 ⏳ 2026-10-01 see notes 🆔 x",
    ],
    [
      "a ≤0.5.0 marker moved in front of the fields",
      name("Write docs ⏳ 2026-10-01 🆔 x 🍅 3"),
      "Write docs 🍅 4 ⏳ 2026-10-01 🆔 x",
    ],
    [
      "a count with text after the fields",
      name("Write docs 🍅 3 ⏳ 2026-10-01 see notes 🆔 x"),
      "Write docs 🍅 4 ⏳ 2026-10-01 see notes 🆔 x",
    ],
    // A name has lost the fields that tell the counter's 🍅 from a typed one,
    // so each 🍅 in it is tried as the count.
    ["a count beside a typed 🍅", "Buy 🍅 2 kg 🍅 1", "Buy 🍅 2 kg 🍅 2 ⏳ 2026-10-01 🆔 x"],
    ["a block reference", "Write docs ^ref1", "Write docs 🍅 1 🆔 x ^ref1"],
    ["no Tasks fields at all", "Write docs", "Write docs 🍅 1"],
  ])("keeps the name through %s", (_label, previous, text) => {
    expect(taskNameAfterEdit(previous, text)).toBe(previous);
  });

  it.each([
    ["a new name", "Write docs 🍅 3", "Write the docs 🍅 4 🆔 x", "Write the docs 🍅 4"],
    ["a new name, no count", "Write docs", "Write the docs 🆔 x", "Write the docs"],
    ["a new name, count removed", "Write docs 🍅 3", "Write the docs 🆔 x", "Write the docs"],
    ["a new tag", "Write docs 🍅 3", "Write docs #urgent 🍅 4 🆔 x", "Write docs #urgent 🍅 4"],
    // A 🍅 typed into the description is text, not the count.
    ["a typed 🍅 changed", "Buy 🍅 2 kg", "Buy 🍅 3 kg 🆔 x", "Buy 🍅 3 kg"],
    ["a typed 🍅 removed", "Buy 🍅 2 kg", "Buy kg 🆔 x", "Buy kg"],
    [
      "a typed 🍅 changed beside a count",
      "Buy 🍅 2 kg 🍅 1",
      "Buy 🍅 3 kg 🍅 1 🆔 x",
      "Buy 🍅 3 kg 🍅 1",
    ],
    ["a 🍅 typed in", "Buy kg", "Buy 🍅 2 kg 🆔 x", "Buy 🍅 2 kg"],
  ])("renames on %s", (_label, previous, text, renamed) => {
    expect(taskNameAfterEdit(previous, text)).toBe(renamed);
  });

  it("reads alike when only the spacing differs, as a count rewrites it", () => {
    expect(taskNameAfterEdit("Write  docs", "Write docs 🍅 1 🆔 x")).toBe("Write  docs");
  });

  it("leaves a change with no count on either side as it always was", () => {
    // Only the count is new here: with none involved, any change is a rename.
    expect(taskNameAfterEdit("Write  docs", "Write docs 🆔 x")).toBe("Write docs");
  });

  it("is the line's own name when nothing changed", () => {
    expect(taskNameAfterEdit("Write docs 🍅 2", "Write docs 🍅 2 🆔 x")).toBe("Write docs 🍅 2");
  });
});

describe("parsePomodoroCount", () => {
  it("returns 0 when no marker is present", () => {
    expect(parsePomodoroCount("- [ ] Write docs ⏳ 2025-12-23")).toBe(0);
  });

  it("returns N for the lifetime marker `🍅 N`", () => {
    expect(parsePomodoroCount("- [ ] Write docs 🍅 3")).toBe(3);
  });

  it("reads N from the legacy today-only format `🍅 N (date)`", () => {
    expect(parsePomodoroCount("- [ ] Write docs 🍅 5 (2024-01-01)")).toBe(5);
  });

  it("reads only a date in the legacy parens — anything else in brackets is the user's", () => {
    // The dated build only ever wrote `(YYYY-MM-DD)`. Taking any `(…)` as part
    // of the marker made "🍅 7 (anything)" the counter and deleted the note.
    expect(parsePomodoroCount("- [ ] Write docs 🍅 7 (anything)")).toBe(0);
    expect(parsePomodoroCount("- [ ] Write docs 🍅 7 (2024-01-01, at work)")).toBe(0);
  });
});

describe("incrementPomodoroCount", () => {
  it("inserts `🍅 1` before the Tasks fields, not after them (issue #2)", () => {
    const line = "- [ ] Write docs ⏳ 2025-12-23";
    expect(incrementPomodoroCount(line)).toBe("- [ ] Write docs 🍅 1 ⏳ 2025-12-23");
  });

  it("inserts before the first of several Tasks fields", () => {
    const line = "- [ ] Write docs ⏳ 2025-12-23 📅 2025-12-24 🆔 abcd12";
    expect(incrementPomodoroCount(line)).toBe(
      "- [ ] Write docs 🍅 1 ⏳ 2025-12-23 📅 2025-12-24 🆔 abcd12"
    );
  });

  it("relocates a ≤0.5.0 trailing marker in front of the fields when incrementing", () => {
    const line = "- [ ] Write docs ⏳ 2025-12-23 📅 2025-12-24 🍅 3";
    expect(incrementPomodoroCount(line)).toBe("- [ ] Write docs 🍅 4 ⏳ 2025-12-23 📅 2025-12-24");
  });

  it("inserts before a priority emoji", () => {
    const line = "- [ ] Write docs ⏫ 📅 2025-12-24";
    expect(incrementPomodoroCount(line)).toBe("- [ ] Write docs 🍅 1 ⏫ 📅 2025-12-24");
  });

  it("keeps a trailing block reference at the very end", () => {
    expect(incrementPomodoroCount("- [ ] Write docs ^abc123")).toBe(
      "- [ ] Write docs 🍅 1 ^abc123"
    );
    expect(incrementPomodoroCount("- [ ] Write docs 📅 2025-12-24 ^abc123")).toBe(
      "- [ ] Write docs 🍅 1 📅 2025-12-24 ^abc123"
    );
  });

  it("preserves the indentation of nested tasks", () => {
    expect(incrementPomodoroCount("    - [ ] Nested ⏳ 2025-12-23")).toBe(
      "    - [ ] Nested 🍅 1 ⏳ 2025-12-23"
    );
  });

  it("increments N on an existing lifetime marker", () => {
    expect(incrementPomodoroCount("- [ ] Write docs 🍅 3")).toBe("- [ ] Write docs 🍅 4");
  });

  it("migrates legacy `🍅 N (date)` to `🍅 N+1` (date stripped)", () => {
    expect(incrementPomodoroCount("- [ ] Write docs 🍅 5 (2024-01-01)")).toBe(
      "- [ ] Write docs 🍅 6"
    );
  });

  it("accumulates across multiple increments: 0 -> 1 -> 2 -> 3", () => {
    const start = "- [ ] Task";
    const a = incrementPomodoroCount(start);
    expect(parsePomodoroCount(a)).toBe(1);
    const b = incrementPomodoroCount(a);
    expect(parsePomodoroCount(b)).toBe(2);
    const c = incrementPomodoroCount(b);
    expect(parsePomodoroCount(c)).toBe(3);
  });

  it("trims trailing whitespace before appending", () => {
    expect(incrementPomodoroCount("- [ ] Write docs   ")).toBe("- [ ] Write docs 🍅 1");
  });
});

describe("repairPomodoroMarkerPlacement", () => {
  it("moves a ≤0.5.0 trailing marker in front of the fields, preserving the count", () => {
    expect(repairPomodoroMarkerPlacement("- [ ] Write docs ⏳ 2025-12-23 📅 2025-12-24 🍅 3")).toBe(
      "- [ ] Write docs 🍅 3 ⏳ 2025-12-23 📅 2025-12-24"
    );
  });

  it("strips legacy parens while relocating", () => {
    expect(repairPomodoroMarkerPlacement("- [ ] Write docs ⏳ 2025-12-23 🍅 5 (2024-01-01)")).toBe(
      "- [ ] Write docs 🍅 5 ⏳ 2025-12-23"
    );
  });

  it("moves a marker that landed after a trailing block reference", () => {
    expect(repairPomodoroMarkerPlacement("- [ ] Write docs ^abc123 🍅 1")).toBe(
      "- [ ] Write docs 🍅 1 ^abc123"
    );
  });

  it("leaves a correctly placed marker byte-for-byte untouched", () => {
    const line = "- [ ] Write docs 🍅 3 ⏳ 2025-12-23";
    expect(repairPomodoroMarkerPlacement(line)).toBe(line);
  });

  it("leaves a trailing marker untouched when the line has no fields (harmless)", () => {
    const line = "- [ ] Write docs 🍅 4";
    expect(repairPomodoroMarkerPlacement(line)).toBe(line);
  });

  it("leaves a harmless mid-description marker untouched (never invents moves)", () => {
    const line = "- [ ] Buy 🍅 2 kg of tomatoes";
    expect(repairPomodoroMarkerPlacement(line)).toBe(line);
  });

  it("leaves lines without a marker untouched", () => {
    const line = "- [ ] Write docs ⏳ 2025-12-23";
    expect(repairPomodoroMarkerPlacement(line)).toBe(line);
  });

  it("is idempotent", () => {
    const once = repairPomodoroMarkerPlacement("- [ ] Write docs ⏳ 2025-12-23 🍅 3");
    expect(repairPomodoroMarkerPlacement(once)).toBe(once);
  });
});

describe("repairPomodoroMarkersInContent", () => {
  it("repairs only broken task lines and counts them", () => {
    const content = [
      "# Tasks",
      "- [ ] Broken ⏳ 2025-12-23 🍅 2",
      "- [x] Done but broken 📅 2025-12-20 🍅 7",
      "- [ ] Fine 🍅 1 ⏳ 2025-12-24",
      "- [ ] No marker ⏳ 2025-12-25",
      "- 🍅 Focus | Task:: [[a.md|A]] | Start:: 2025-12-23 10:00:00",
      "Plain prose mentioning 🍅 3 stays as is.",
    ].join("\n");

    const result = repairPomodoroMarkersInContent(content);
    expect(result.linesChanged).toBe(2);
    expect(result.content).toBe(
      [
        "# Tasks",
        "- [ ] Broken 🍅 2 ⏳ 2025-12-23",
        "- [x] Done but broken 🍅 7 📅 2025-12-20",
        "- [ ] Fine 🍅 1 ⏳ 2025-12-24",
        "- [ ] No marker ⏳ 2025-12-25",
        "- 🍅 Focus | Task:: [[a.md|A]] | Start:: 2025-12-23 10:00:00",
        "Plain prose mentioning 🍅 3 stays as is.",
      ].join("\n")
    );
  });

  it("returns the content unchanged when nothing needs repair", () => {
    const content = "- [ ] Fine 🍅 1 ⏳ 2025-12-24\n- [ ] Also fine ⏳ 2025-12-25";
    const result = repairPomodoroMarkersInContent(content);
    expect(result.linesChanged).toBe(0);
    expect(result.content).toBe(content);
  });

  it("repairs task lines on asterisk and numbered bullets too", () => {
    const content = [
      "* [ ] Broken star ⏳ 2025-12-23 🍅 2",
      "2. [x] Broken numbered 📅 2025-12-20 🍅 5",
    ].join("\n");
    const result = repairPomodoroMarkersInContent(content);
    expect(result.linesChanged).toBe(2);
    expect(result.content).toBe(
      ["* [ ] Broken star 🍅 2 ⏳ 2025-12-23", "2. [x] Broken numbered 🍅 5 📅 2025-12-20"].join(
        "\n"
      )
    );
  });
});

describe("removeMisplacedPomodoroMarker", () => {
  it("deletes a ≤0.5.0 trailing marker, restoring the exact pre-bug line", () => {
    // The old bug turned `- [ ] Write docs ⏳ 2025-12-23` into the line below
    // by appending " 🍅 1" — removal must give back the original, byte-for-byte.
    expect(removeMisplacedPomodoroMarker("- [ ] Write docs ⏳ 2025-12-23 🍅 1")).toBe(
      "- [ ] Write docs ⏳ 2025-12-23"
    );
  });

  it("deletes a marker that landed after a trailing block reference", () => {
    expect(removeMisplacedPomodoroMarker("- [ ] Write docs ^abc123 🍅 2")).toBe(
      "- [ ] Write docs ^abc123"
    );
  });

  it("deletes a misplaced legacy `🍅 N (date)` marker", () => {
    expect(removeMisplacedPomodoroMarker("- [ ] Write docs 📅 2025-12-24 🍅 5 (2024-01-01)")).toBe(
      "- [ ] Write docs 📅 2025-12-24"
    );
  });

  it("keeps a correctly placed marker (never deletes healthy counts)", () => {
    const line = "- [ ] Write docs 🍅 3 ⏳ 2025-12-23";
    expect(removeMisplacedPomodoroMarker(line)).toBe(line);
  });

  it("keeps a harmless trailing marker on a line without fields", () => {
    const line = "- [ ] Write docs 🍅 4";
    expect(removeMisplacedPomodoroMarker(line)).toBe(line);
  });

  it("leaves lines without a marker untouched", () => {
    const line = "- [ ] Write docs ⏳ 2025-12-23";
    expect(removeMisplacedPomodoroMarker(line)).toBe(line);
  });
});

describe("removeAnyPomodoroMarker", () => {
  it("deletes a correctly placed marker (before the fields)", () => {
    expect(removeAnyPomodoroMarker("- [ ] Write docs 🍅 3 ⏳ 2025-12-23")).toBe(
      "- [ ] Write docs ⏳ 2025-12-23"
    );
  });

  it("deletes a misplaced trailing marker", () => {
    expect(removeAnyPomodoroMarker("- [ ] Write docs ⏳ 2025-12-23 🍅 1")).toBe(
      "- [ ] Write docs ⏳ 2025-12-23"
    );
  });

  it("deletes a trailing marker on a field-less line", () => {
    expect(removeAnyPomodoroMarker("- [ ] Write docs 🍅 4")).toBe("- [ ] Write docs");
  });

  it("deletes a marker before a trailing block reference", () => {
    expect(removeAnyPomodoroMarker("- [ ] Write docs 🍅 1 ^abc123")).toBe(
      "- [ ] Write docs ^abc123"
    );
  });

  it("deletes a trailing legacy `🍅 N (date)` marker", () => {
    expect(removeAnyPomodoroMarker("- [ ] Write docs 🍅 5 (2024-01-01)")).toBe("- [ ] Write docs");
  });

  it("keeps a `🍅 N` the user typed mid-description (text after it)", () => {
    const noFields = "- [ ] Buy 🍅 2 kg of tomatoes";
    expect(removeAnyPomodoroMarker(noFields)).toBe(noFields);
    const withFields = "- [ ] Buy 🍅 2 kg of tomatoes ⏳ 2025-12-23";
    expect(removeAnyPomodoroMarker(withFields)).toBe(withFields);
  });

  it("leaves lines without a marker untouched", () => {
    const line = "- [ ] Write docs ⏳ 2025-12-23";
    expect(removeAnyPomodoroMarker(line)).toBe(line);
  });
});

describe("removeAllPomodoroMarkersInContent", () => {
  it("removes placed and misplaced markers but keeps mid-description ones", () => {
    const content = [
      "- [ ] Placed 🍅 3 ⏳ 2025-12-23",
      "- [ ] Misplaced ⏳ 2025-12-23 🍅 2",
      "- [ ] Buy 🍅 2 kg of tomatoes ⏳ 2025-12-23",
      "Plain prose mentioning 🍅 3 stays as is.",
    ].join("\n");

    const result = removeAllPomodoroMarkersInContent(content);
    expect(result.linesChanged).toBe(2);
    expect(result.content).toBe(
      [
        "- [ ] Placed ⏳ 2025-12-23",
        "- [ ] Misplaced ⏳ 2025-12-23",
        "- [ ] Buy 🍅 2 kg of tomatoes ⏳ 2025-12-23",
        "Plain prose mentioning 🍅 3 stays as is.",
      ].join("\n")
    );
  });
});

describe("removeMisplacedPomodoroMarkersInContent", () => {
  it("removes only misplaced markers and counts the lines", () => {
    const content = [
      "- [ ] Broken ⏳ 2025-12-23 🍅 2",
      "- [ ] Fine 🍅 1 ⏳ 2025-12-24",
      "Plain prose mentioning 🍅 3 stays as is.",
    ].join("\n");

    const result = removeMisplacedPomodoroMarkersInContent(content);
    expect(result.linesChanged).toBe(1);
    expect(result.content).toBe(
      [
        "- [ ] Broken ⏳ 2025-12-23",
        "- [ ] Fine 🍅 1 ⏳ 2025-12-24",
        "Plain prose mentioning 🍅 3 stays as is.",
      ].join("\n")
    );
  });
});

describe("a 🍅 the user typed is never the counter", () => {
  // The counter's marker sits where the plugin writes it: nothing but tags
  // between it and the Tasks fields, a trailing block reference, or the end of
  // the line. A `🍅 N` with ordinary text after it is the user's own text.
  // Every reader used to take the FIRST `🍅 N` on the line, so a typed one in
  // front of the counter was rewritten ("Buy 🍅 2 kg" became "Buy kg 🍅 3"),
  // hid the counter from Remove all, and hid a misplaced counter from Repair.
  const TYPED = "- [ ] Buy 🍅 2 kg ⏳ 2026-10-01";
  const TYPED_AND_COUNTER = "- [ ] Buy 🍅 2 kg 🍅 3 ⏳ 2026-10-01";
  const TYPED_AND_MISPLACED = "- [ ] Buy 🍅 2 kg ⏳ 2026-10-01 🍅 3";
  const TYPED_AND_AFTER_BLOCK_REF = "- [ ] Buy 🍅 2 kg ^abc123 🍅 1";
  // Your own vault has field emoji inside task text ("Add 🔺 watchlist — all
  // ⏫/🔺 tasks"), so "after the first field emoji" does not mean "after the
  // fields": a 🍅 typed after one is still the user's.
  const AFTER_EMOJI_IN_TEXT = "- [ ] Fix ❌ login, then 🍅 2 tests ⏳ 2026-10-01";
  // The Tasks plugin moves tags that sit among the fields to the end of the
  // description when it rewrites a line (ticking it, Edit Task, the next
  // recurrence), so a tag can end up between the counter and the fields.
  const TAG_MOVED_BY_TASKS = "- [ ] Write docs 🍅 1 #task/research/docs 🔁 every day ⏳ 2026-10-01";

  describe("parsePomodoroCount", () => {
    it("reads 0 when the only 🍅 is the user's", () => {
      expect(parsePomodoroCount(TYPED)).toBe(0);
      expect(parsePomodoroCount("- [ ] Buy 🍅 2 kg of tomatoes")).toBe(0);
      expect(parsePomodoroCount(AFTER_EMOJI_IN_TEXT)).toBe(0);
    });

    it("reads the counter, not a typed 🍅 in front of it", () => {
      expect(parsePomodoroCount(TYPED_AND_COUNTER)).toBe(3);
      expect(parsePomodoroCount(TYPED_AND_MISPLACED)).toBe(3);
      expect(parsePomodoroCount(TYPED_AND_AFTER_BLOCK_REF)).toBe(1);
    });

    it("reads a counter that has tags after it", () => {
      expect(parsePomodoroCount(TAG_MOVED_BY_TASKS)).toBe(1);
      expect(parsePomodoroCount("- [ ] Write docs 🍅 4 #inbox #later")).toBe(4);
      expect(parsePomodoroCount("- [ ] Write docs 🍅 4 #paper📅 2026-10-01")).toBe(4);
    });
  });

  describe("incrementPomodoroCount", () => {
    it("leaves a typed 🍅 alone and starts the counter at 1 beside it", () => {
      expect(incrementPomodoroCount(TYPED)).toBe("- [ ] Buy 🍅 2 kg 🍅 1 ⏳ 2026-10-01");
      expect(incrementPomodoroCount("- [ ] Buy 🍅 2 kg of tomatoes")).toBe(
        "- [ ] Buy 🍅 2 kg of tomatoes 🍅 1"
      );
      expect(incrementPomodoroCount("- [ ] Buy 🍅 2 kg ^abc123")).toBe(
        "- [ ] Buy 🍅 2 kg 🍅 1 ^abc123"
      );
    });

    it("keeps counting its own marker on later sessions, not the typed one", () => {
      const once = incrementPomodoroCount(TYPED);
      const twice = incrementPomodoroCount(once);
      const thrice = incrementPomodoroCount(twice);
      expect(thrice).toBe("- [ ] Buy 🍅 2 kg 🍅 3 ⏳ 2026-10-01");
      expect([once, twice, thrice].map(parsePomodoroCount)).toEqual([1, 2, 3]);
    });

    it("heals a misplaced counter without touching the typed 🍅", () => {
      expect(incrementPomodoroCount(TYPED_AND_MISPLACED)).toBe(
        "- [ ] Buy 🍅 2 kg 🍅 4 ⏳ 2026-10-01"
      );
      expect(incrementPomodoroCount(TYPED_AND_AFTER_BLOCK_REF)).toBe(
        "- [ ] Buy 🍅 2 kg 🍅 2 ^abc123"
      );
    });

    it("leaves a 🍅 typed after a field emoji in the task text alone", () => {
      const once = incrementPomodoroCount(AFTER_EMOJI_IN_TEXT);
      expect(once).toContain("then 🍅 2 tests ⏳ 2026-10-01");
      expect(parsePomodoroCount(once)).toBe(1);
      const twice = incrementPomodoroCount(once);
      expect(twice).toContain("then 🍅 2 tests ⏳ 2026-10-01");
      expect(parsePomodoroCount(twice)).toBe(2);
    });

    it("still takes its counter when the Tasks plugin moved a tag behind it", () => {
      // Not a second `🍅 1` in front of the fields: the marker IS the counter.
      expect(incrementPomodoroCount(TAG_MOVED_BY_TASKS)).toBe(
        "- [ ] Write docs #task/research/docs 🍅 2 🔁 every day ⏳ 2026-10-01"
      );
    });

    it.each([
      TYPED,
      TYPED_AND_COUNTER,
      TYPED_AND_MISPLACED,
      TYPED_AND_AFTER_BLOCK_REF,
      AFTER_EMOJI_IN_TEXT,
      TAG_MOVED_BY_TASKS,
      "- [ ] Buy 🍅 2 kg of tomatoes",
      "- [ ] Write docs ⏳ 2025-12-23 📅 2025-12-24 🍅 3",
      "- [ ] Write docs 🍅 5 (2024-01-01)",
    ])("adds exactly one to what parsePomodoroCount reads — %s", (line) => {
      expect(parsePomodoroCount(incrementPomodoroCount(line))).toBe(parsePomodoroCount(line) + 1);
    });
  });

  describe("Remove all", () => {
    it("removes the counter behind a typed 🍅 and keeps the typed one", () => {
      expect(removeAnyPomodoroMarker(TYPED_AND_COUNTER)).toBe(TYPED);
      expect(removeAnyPomodoroMarker(TYPED_AND_MISPLACED)).toBe(TYPED);
      expect(removeAnyPomodoroMarker("- [ ] Buy 🍅 2 kg of tomatoes 🍅 4")).toBe(
        "- [ ] Buy 🍅 2 kg of tomatoes"
      );
    });

    it("removes a counter that has tags after it", () => {
      expect(removeAnyPomodoroMarker(TAG_MOVED_BY_TASKS)).toBe(
        "- [ ] Write docs #task/research/docs 🔁 every day ⏳ 2026-10-01"
      );
      expect(removeAnyPomodoroMarker("- [ ] Write docs 🍅 4 #inbox #later")).toBe(
        "- [ ] Write docs #inbox #later"
      );
      expect(removeAnyPomodoroMarker("- [ ] Write docs 🍅 4 #paper📅 2026-10-01")).toBe(
        "- [ ] Write docs #paper📅 2026-10-01"
      );
    });

    it("keeps a typed 🍅 that only looks like a tag would follow", () => {
      const line = "- [ ] Buy 🍅 2 # of tomatoes";
      expect(removeAnyPomodoroMarker(line)).toBe(line);
    });

    it.each([TYPED, "- [ ] Buy 🍅 2 kg of tomatoes", "- [ ] Buy 🍅 2 kg ^abc123"])(
      "undoes the counter exactly, and a second run changes nothing — %s",
      (line) => {
        const counted = incrementPomodoroCount(incrementPomodoroCount(line));
        const removed = removeAnyPomodoroMarker(counted);
        expect(removed).toBe(line);
        expect(removeAnyPomodoroMarker(removed)).toBe(line);
      }
    );

    it("counts those lines in a note", () => {
      const content = [TYPED_AND_COUNTER, TYPED_AND_MISPLACED, TYPED, AFTER_EMOJI_IN_TEXT].join(
        "\n"
      );
      const result = removeAllPomodoroMarkersInContent(content);
      expect(result.linesChanged).toBe(2);
      expect(result.content).toBe([TYPED, TYPED, TYPED, AFTER_EMOJI_IN_TEXT].join("\n"));
    });
  });

  describe("a note in brackets after a typed 🍅", () => {
    // Only `(YYYY-MM-DD)` belongs to a marker — the 13-minute dated build from
    // before 0.1.0 wrote nothing else. Any other `(…)` is ordinary text, so the
    // 🍅 in front of it is the user's.
    const NOTE = "- [ ] Buy 🍅 2 (big ones) ⏳ 2026-10-01";
    const NOTE_AT_END = "- [ ] Call mum 🍅 2 (Sunday)";

    it("is not read as a count", () => {
      expect(parsePomodoroCount(NOTE)).toBe(0);
      expect(parsePomodoroCount(NOTE_AT_END)).toBe(0);
      expect(parsePomodoroCount("- [ ] Push-ups 🍅 2 (10-15)")).toBe(0);
      expect(parsePomodoroCount("- [ ] Buy 🍅 2 (big ones) 🍅 4 ⏳ 2026-10-01")).toBe(4);
    });

    it("keeps its note when the counter counts", () => {
      expect(incrementPomodoroCount(NOTE)).toBe("- [ ] Buy 🍅 2 (big ones) 🍅 1 ⏳ 2026-10-01");
      expect(incrementPomodoroCount(NOTE_AT_END)).toBe("- [ ] Call mum 🍅 2 (Sunday) 🍅 1");
      expect(incrementPomodoroCount("- [ ] Push-ups 🍅 2 (10-15)")).toBe(
        "- [ ] Push-ups 🍅 2 (10-15) 🍅 1"
      );
      expect(incrementPomodoroCount("- [ ] Write 🍅 1 (2024-01-01, at work)")).toBe(
        "- [ ] Write 🍅 1 (2024-01-01, at work) 🍅 1"
      );
    });

    it("is left alone by Remove all, which takes only the counter beside it", () => {
      expect(removeAnyPomodoroMarker(NOTE)).toBe(NOTE);
      expect(removeAnyPomodoroMarker(NOTE_AT_END)).toBe(NOTE_AT_END);
      expect(removeAnyPomodoroMarker(incrementPomodoroCount(NOTE))).toBe(NOTE);
    });

    it("is never called misplaced, even after the fields", () => {
      const line = "- [ ] Buy ⏳ 2026-10-01 🍅 2 (big ones)";
      expect(repairPomodoroMarkerPlacement(line)).toBe(line);
      expect(removeMisplacedPomodoroMarker(line)).toBe(line);
    });

    it("still treats a dated marker as the counter, date dropped on write", () => {
      expect(parsePomodoroCount("- [ ] Write docs 🍅 5 (2024-01-01) ⏳ 2026-10-01")).toBe(5);
      expect(incrementPomodoroCount("- [ ] Write docs 🍅 5 (2024-01-01) ⏳ 2026-10-01")).toBe(
        "- [ ] Write docs 🍅 6 ⏳ 2026-10-01"
      );
      expect(removeAnyPomodoroMarker("- [ ] Write docs 🍅 5 (2024-01-01) ⏳ 2026-10-01")).toBe(
        "- [ ] Write docs ⏳ 2026-10-01"
      );
    });
  });

  describe("Check, Repair and Remove misplaced", () => {
    it("repair moves a misplaced counter behind a typed 🍅, keeping both", () => {
      expect(repairPomodoroMarkerPlacement(TYPED_AND_MISPLACED)).toBe(TYPED_AND_COUNTER);
      expect(repairPomodoroMarkerPlacement(TYPED_AND_AFTER_BLOCK_REF)).toBe(
        "- [ ] Buy 🍅 2 kg 🍅 1 ^abc123"
      );
    });

    it("remove-misplaced deletes that counter and keeps the typed 🍅", () => {
      expect(removeMisplacedPomodoroMarker(TYPED_AND_MISPLACED)).toBe(TYPED);
      expect(removeMisplacedPomodoroMarker(TYPED_AND_AFTER_BLOCK_REF)).toBe(
        "- [ ] Buy 🍅 2 kg ^abc123"
      );
    });

    it("never calls a 🍅 typed after a field emoji in the task text misplaced", () => {
      expect(repairPomodoroMarkerPlacement(AFTER_EMOJI_IN_TEXT)).toBe(AFTER_EMOJI_IN_TEXT);
      expect(removeMisplacedPomodoroMarker(AFTER_EMOJI_IN_TEXT)).toBe(AFTER_EMOJI_IN_TEXT);
    });

    it("still repairs a misplaced counter that has tags after it", () => {
      expect(repairPomodoroMarkerPlacement("- [ ] Buy 📅 2026-10-01 🍅 3 #shopping")).toBe(
        "- [ ] Buy 🍅 3 📅 2026-10-01 #shopping"
      );
    });

    it("leaves a typed 🍅 beside a correctly placed counter alone", () => {
      expect(repairPomodoroMarkerPlacement(TYPED_AND_COUNTER)).toBe(TYPED_AND_COUNTER);
      expect(removeMisplacedPomodoroMarker(TYPED_AND_COUNTER)).toBe(TYPED_AND_COUNTER);
    });

    it("finds those lines in a note, and only those", () => {
      const content = [TYPED_AND_MISPLACED, TYPED_AND_COUNTER, AFTER_EMOJI_IN_TEXT, TYPED].join(
        "\n"
      );
      const result = repairPomodoroMarkersInContent(content);
      expect(result.linesChanged).toBe(1);
      expect(result.content).toBe(
        [TYPED_AND_COUNTER, TYPED_AND_COUNTER, AFTER_EMOJI_IN_TEXT, TYPED].join("\n")
      );
      expect(repairPomodoroMarkersInContent(result.content).linesChanged).toBe(0);
    });
  });
});
