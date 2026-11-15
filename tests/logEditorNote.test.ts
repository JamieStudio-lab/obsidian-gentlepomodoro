import { describe, it, expect, vi, beforeEach } from "vitest";
import moment from "moment";
import { FORM_UNSAFE_MESSAGE, editedLine, formFromLine, loggedLines } from "../logEditor";
import type { MomentLike } from "../momentTypes";

/**
 * The last check on a note Fix writes: the line must read back as version 2
 * with that note and every other part as it was. The cleaner leaves no text
 * that fails it, so setSessionNote is stood in for here, to show what the
 * check refuses. tests/logEditor.test.ts holds the rest of the rules.
 */

const hook = vi.hoisted(() => ({ next: null as string | null | undefined }));

vi.mock("../logLine", async (original) => {
  const actual = await original<typeof import("../logLine")>();
  return {
    ...actual,
    setSessionNote: (...args: Parameters<typeof actual.setSessionNote>) =>
      hook.next === undefined ? actual.setSessionNote(...args) : hook.next,
  };
});

const toMoment = (ms: number) => moment(ms) as unknown as MomentLike;
const LINE =
  "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:30:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1800] [Status:: finished] [Type:: focus] [Overtime:: 300] [Session:: sd4f6g8j2k] and a remark";
const FIELDS = LINE.replace(" and a remark", "");

const save = (returned?: string | null) => {
  hook.next = returned;
  const line = loggedLines(LINE)[0];
  const start = formFromLine(line, toMoment);
  if (!start) throw new Error("unreadable");
  const initial = { ...start, note: { face: null, text: "" } };
  return editedLine(
    line,
    initial,
    { ...initial, note: { face: "meh", text: "stuck" } },
    { toMoment, nowMs: new Date(2026, 9, 2, 18).getTime(), dayStartHour: 0, fileDate: "2026-10-02" }
  );
};

beforeEach(() => {
  hook.next = undefined;
});

describe("a note Fix writes, read back", () => {
  it("passes with the real writer's line", () => {
    expect(save()).toEqual({
      kind: "ok",
      text: `${FIELDS} [Note:: meh · stuck] and a remark`,
    });
  });

  it.each([
    ["no line came back", null],
    ["it is no longer version 2", "- 🍅 Focus | Task:: No Task | Note:: meh · stuck"],
    ["it is no session line", "just words"],
    [
      "it became a rest line",
      `${FIELDS.replace("🍅 Focus", "☕ Rest")} [Note:: meh · stuck] and a remark`,
    ],
    ["the note is missing", `${FIELDS} and a remark`],
    ["the note is another", `${FIELDS} [Note:: smile · stuck] and a remark`],
    ["the words are another", `${FIELDS} [Note:: meh · unstuck] and a remark`],
    ["a second note is there", `${FIELDS} [Note:: meh · stuck] [Note:: x] and a remark`],
    ["the text after the fields moved", `${FIELDS} [Note:: meh · stuck] and another`],
    ["a field changed", `${FIELDS.replace("1800", "1700")} [Note:: meh · stuck] and a remark`],
    [
      "a field went",
      `${FIELDS.replace(" [Overtime:: 300]", "")} [Note:: meh · stuck] and a remark`,
    ],
  ])("refuses when %s", (_name, returned) => {
    expect(save(returned)).toEqual({ kind: "error", message: FORM_UNSAFE_MESSAGE });
  });
});
