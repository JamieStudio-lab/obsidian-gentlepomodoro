import { describe, it, expect } from "vitest";
import {
  normalizeTaskText,
  normalizeTaskTextForDisplay,
  isPathInFolder,
  findTaskNameByIdInContent,
  parseTodayPomodoroCount,
  incrementTodayPomodoroCount,
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

describe("parseTodayPomodoroCount", () => {
  const TODAY = "2025-05-18";

  it("returns 0 when no marker is present", () => {
    expect(parseTodayPomodoroCount("- [ ] Write docs ⏳ 2025-12-23", TODAY)).toBe(0);
  });

  it("returns the count when the marker matches today", () => {
    expect(parseTodayPomodoroCount("- [ ] Write docs 🍅 3 (2025-05-18)", TODAY)).toBe(3);
  });

  it("returns 0 when the marker date is stale", () => {
    expect(parseTodayPomodoroCount("- [ ] Write docs 🍅 5 (2024-01-01)", TODAY)).toBe(0);
  });

  it("returns 0 when the marker has no date (treated as stale)", () => {
    expect(parseTodayPomodoroCount("- [ ] Write docs 🍅 5", TODAY)).toBe(0);
  });
});

describe("incrementTodayPomodoroCount", () => {
  const TODAY = "2025-05-18";

  it("appends `🍅 1 (today)` when no marker is present", () => {
    const line = "- [ ] Write docs ⏳ 2025-12-23";
    expect(incrementTodayPomodoroCount(line, TODAY)).toBe(
      "- [ ] Write docs ⏳ 2025-12-23 🍅 1 (2025-05-18)"
    );
  });

  it("increments N when the marker matches today", () => {
    const line = "- [ ] Write docs 🍅 3 (2025-05-18)";
    expect(incrementTodayPomodoroCount(line, TODAY)).toBe("- [ ] Write docs 🍅 4 (2025-05-18)");
  });

  it("resets to `🍅 1 (today)` when the marker date is stale", () => {
    const line = "- [ ] Write docs 🍅 5 (2024-01-01)";
    expect(incrementTodayPomodoroCount(line, TODAY)).toBe("- [ ] Write docs 🍅 1 (2025-05-18)");
  });

  it("resets to `🍅 1 (today)` when the marker has no date", () => {
    const line = "- [ ] Write docs 🍅 5";
    expect(incrementTodayPomodoroCount(line, TODAY)).toBe("- [ ] Write docs 🍅 1 (2025-05-18)");
  });

  it("is idempotent within a day: 0 -> 1 -> 2", () => {
    const start = "- [ ] T";
    const after1 = incrementTodayPomodoroCount(start, TODAY);
    expect(parseTodayPomodoroCount(after1, TODAY)).toBe(1);
    const after2 = incrementTodayPomodoroCount(after1, TODAY);
    expect(parseTodayPomodoroCount(after2, TODAY)).toBe(2);
  });

  it("trims trailing whitespace before appending", () => {
    const line = "- [ ] Write docs   ";
    expect(incrementTodayPomodoroCount(line, TODAY)).toBe("- [ ] Write docs 🍅 1 (2025-05-18)");
  });
});
