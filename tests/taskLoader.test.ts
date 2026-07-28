import { describe, it, expect } from "vitest";
import {
  normalizeTaskText,
  normalizeTaskTextForDisplay,
  isPathInFolder,
  findTaskNameByIdInContent,
  parsePomodoroCount,
  incrementPomodoroCount,
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
