import { describe, it, expect } from "vitest";
import {
  TASK_LINE_REGEX,
  normalizeTaskText,
  normalizeTaskTextForDisplay,
  isPathInFolder,
  findTaskNameByIdInContent,
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

describe("isPathInFolder", () => {
  it("returns true for any path when folder is empty (whole-vault scope)", () => {
    expect(isPathInFolder("Notes/a.md", "")).toBe(true);
    expect(isPathInFolder("anywhere.md", "")).toBe(true);
  });

  it("returns true when path is inside the folder", () => {
    expect(isPathInFolder("Projects/A.md", "Projects")).toBe(true);
    expect(isPathInFolder("Projects/sub/A.md", "Projects")).toBe(true);
  });

  it("handles trailing slashes on the folder", () => {
    expect(isPathInFolder("Projects/A.md", "Projects/")).toBe(true);
  });

  it("returns false when path is outside the folder", () => {
    expect(isPathInFolder("Notes/A.md", "Projects")).toBe(false);
  });

  it("does not match a prefix that isn't a folder boundary", () => {
    expect(isPathInFolder("ProjectsArchive/A.md", "Projects")).toBe(false);
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

describe("findTaskNameByIdInContent", () => {
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

  it("tolerates arbitrary content inside the legacy parens", () => {
    expect(parsePomodoroCount("- [ ] Write docs 🍅 7 (anything)")).toBe(7);
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
