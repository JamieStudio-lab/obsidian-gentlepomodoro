import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TFile } from "obsidian";
import { LogManager } from "../logManager";
import { logTaskId, newestFocusNote, type ParsedLogLine } from "../logLine";
import {
  FocusNoteStore,
  lastNoteWhen,
  type FocusNoteHost,
  type FocusNoteTarget,
  type NoteWriteResult,
} from "../focusNote";
import { FOCUS_NOTE_LOOKBACK_DAYS } from "../constants";
import type GentlePomoPlugin from "../main";
import type { MomentFactory } from "../momentTypes";
import { fakeVault, linkCache } from "./fakeVault";
import { memoryStorage } from "./memoryStorage";
import { callbackBody } from "./sourceText";
import { parseRules, stripComments } from "./cssRules";

/**
 * "Last time" (0.7.1, part 2): the linked task's newest focus note, under the
 * task button. Four places hold it — the pure read in logLine.ts, the day walk
 * in LogManager, the store's revision, and the view (read as text, since
 * nothing can import it) with its stylesheet.
 */

const moment = createRequire(import.meta.url)("moment") as MomentFactory;

interface LineSpec {
  task?: string;
  id?: string;
  session?: string | null;
  note?: string;
  start?: string;
}

const S1 = "s000000001";
const S2 = "s000000002";
const S3 = "s000000003";

/** A focus line as the timer writes it (version 2), with what a test varies. */
function focusLine(spec: LineSpec = {}): string {
  const start = spec.start ?? "2026-10-20 09:00:00";
  const session = spec.session === undefined ? S1 : spec.session;
  return [
    `- 🍅 Focus [Task:: ${spec.task ?? "[[Projects/Toy.md|Write docs]]"}]`,
    spec.id ? ` [ID:: ${spec.id}]` : "",
    ` [Start:: ${start}] [End:: ${start}] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500]`,
    ` [Status:: finished] [Type:: focus] [Overtime:: 0]`,
    session === null ? "" : ` [Session:: ${session}] [StartedBy:: start] [EndedBy:: time-up]`,
    spec.note === undefined ? "" : ` [Note:: ${spec.note}]`,
  ].join("");
}

const anyLine = () => true;

describe("newestFocusNote", () => {
  it("takes the newest line that holds a note and says yes, bottom-up", () => {
    const content = [
      focusLine({ session: S1, note: "meh · first" }),
      focusLine({ session: S2, note: "smile · second" }),
      focusLine({ session: S3 }),
      "",
    ].join("\n");
    expect(newestFocusNote(content, anyLine)).toEqual({
      sessionId: S2,
      start: "2026-10-20 09:00:00",
      note: { face: "smile", text: "second" },
    });
  });

  it("asks the predicate, and passes over a line it refuses", () => {
    const content = [
      focusLine({ session: S1, id: "abc123", note: "mine" }),
      focusLine({ session: S2, id: "zzz999", note: "theirs" }),
    ].join("\n");
    const seen: (string | null)[] = [];
    const found = newestFocusNote(content, (parsed: ParsedLogLine) => {
      seen.push(logTaskId(parsed));
      return logTaskId(parsed) === "abc123";
    });
    expect(found?.note).toEqual({ face: null, text: "mine" });
    expect(seen).toEqual(["zzz999", "abc123"]);
  });

  it("counts a face alone, and not an empty Note", () => {
    expect(newestFocusNote(focusLine({ note: "frown" }), anyLine)?.note).toEqual({
      face: "frown",
      text: "",
    });
    expect(newestFocusNote(focusLine({ note: " " }), anyLine)).toBeNull();
    expect(newestFocusNote(focusLine({}), anyLine)).toBeNull();
  });

  it("reads no note off a break, an older line or one without a valid Session", () => {
    const rest =
      "- ☕ Rest [Start:: 2026-10-20 09:25:00] [End:: 2026-10-20 09:30:00] [Scheduled:: 300]" +
      ` [Total:: 300] [Type:: short-break] [Session:: ${S2}] [Note:: smile · rest]`;
    const v1 =
      "- 🍅 Focus | Task:: [[Projects/Toy.md|Write docs]] | Start:: 2026-10-20 08:00:00 |" +
      ` Total:: 1500 | Session:: ${S3} | Note:: smile · v1`;
    const noSession = focusLine({ session: null, note: "smile · none" });
    const badSession = focusLine({ session: "s123", note: "smile · bad" });
    for (const row of [rest, v1, noSession, badSession]) {
      expect(
        newestFocusNote(`${focusLine({ note: "meh · real" })}\n${row}`, anyLine)?.note
      ).toEqual({ face: "meh", text: "real" });
      expect(newestFocusNote(row, anyLine)).toBeNull();
    }
  });

  it("starts past the properties: a property that reads as a noted line is none", () => {
    const content = `---\nfake: x\n${focusLine({ note: "smile · property" })}\n---\n`;
    expect(newestFocusNote(content, anyLine)).toBeNull();
    expect(
      newestFocusNote(`${content}${focusLine({ note: "meh · body" })}\n`, anyLine)?.note
    ).toEqual({ face: "meh", text: "body" });
  });

  it("reads a CRLF file", () => {
    const content = `${focusLine({ session: S1, note: "meh · a" })}\r\n${focusLine({ session: S2 })}\r\n`;
    expect(newestFocusNote(content, anyLine)?.sessionId).toBe(S1);
  });
});

describe("lastNoteWhen", () => {
  it("says today and yesterday by the file's logical day", () => {
    expect(lastNoteWhen(moment, 0, "2026-10-20 09:00:00", "2026-10-20")).toBe("today");
    // A line started after midnight in yesterday's file ("Day starts at").
    expect(lastNoteWhen(moment, 1, "2026-10-20 01:00:00", "2026-10-19")).toBe("yesterday");
  });
  it("else the line's Start as a short date, or the file's day when Start is unreadable", () => {
    expect(lastNoteWhen(moment, 5, "2026-10-14 23:00:00", "2026-10-14")).toBe(
      moment(new Date(2026, 9, 14).getTime()).format("ll")
    );
    expect(lastNoteWhen(moment, 5, "", "2026-10-14")).toBe(
      moment(new Date(2026, 9, 14).getTime()).format("ll")
    );
  });
  it("takes the file's own day, never today less daysAgo (a day late after midnight)", () => {
    // 02:00 on Oct 20 with "Day starts at" 4: today is the 19th, so five days
    // back is the 14th's file — counting back from the clock gives the 15th.
    expect(lastNoteWhen(moment, 5, "", "2026-10-14")).not.toBe(
      moment(new Date(2026, 9, 15).getTime()).format("ll")
    );
  });
});

describe("FocusNoteStore.revision", () => {
  function host() {
    let settle: ((r: NoteWriteResult) => void) | null = null;
    const h: FocusNoteHost = {
      storage: memoryStorage(),
      enabled: () => true,
      write: () =>
        new Promise((r) => {
          settle = r;
        }),
      notice: () => undefined,
      now: () => 0,
    };
    return {
      h,
      async settle(result: NoteWriteResult) {
        settle?.(result);
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }
  const target: FocusNoteTarget = {
    sessionId: S1,
    path: "Logs/x.md",
    logged: "file",
    startMs: 0,
    endMs: 1,
    taskName: "Write docs",
  };

  it("moves when a write settles, whatever its result — and on nothing typed", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target);
    const r0 = store.revision;
    store.setDraft("meh", "typing");
    store.setDraft("smile", "typing more");
    expect(store.revision).toBe(r0);
    const saved = store.save(target, { face: "smile", text: "x" });
    expect(store.revision).toBe(r0);
    await c.settle("saved");
    await saved;
    expect(store.revision).toBe(r0 + 1);
    const failed = store.clear(target);
    await c.settle("failed");
    await failed;
    expect(store.revision).toBe(r0 + 2);
  });

  it("has moved by the time its listeners hear the result", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target);
    const seen: number[] = [];
    store.onChange(() => seen.push(store.revision));
    const r0 = store.revision;
    const saved = store.save(target, { face: "smile", text: "x" });
    await c.settle("saved");
    await saved;
    expect(seen[seen.length - 1]).toBe(r0 + 1);
  });
});

describe("LogManager.lastTaskNote: the day walk", () => {
  let previousMoment: unknown;
  beforeEach(() => {
    const g = globalThis as unknown as { moment?: unknown };
    previousMoment = g.moment;
    g.moment = moment;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 20, 10, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as unknown as { moment?: unknown }).moment = previousMoment;
  });

  const log = (day: string) => `Logs/${day}-gentle-pomodoro-log.md`;
  /** The log file `n` calendar days before 2026-10-20. */
  const daysBack = (n: number) =>
    log(moment(new Date(2026, 9, 20 - n).getTime()).format("YYYY-MM-DD"));

  function manager(files: Record<string, string>, dayStartHour = 0) {
    const vault = fakeVault({
      "Projects/Toy.md": "- [ ] Write docs",
      "Projects/Other.md": "- [ ] Write docs",
      ...files,
    });
    const plugin = {
      settings: { logFolderPath: "Logs", dayStartHour },
      app: { vault, metadataCache: linkCache(vault) },
      invalidateFocusTotalCache: vi.fn(),
    } as unknown as GentlePomoPlugin;
    return { vault, plugin, lm: new LogManager(plugin) };
  }
  const toy = { path: "Projects/Toy.md", name: "Write docs" };

  it("with a 🆔: the lines carrying it, wherever they link and whatever they are called", async () => {
    const { lm } = manager({
      [daysBack(0)]: [
        focusLine({ session: S1, id: "abc123", task: "[[Projects/Other.md|Old name]]", note: "a" }),
        focusLine({ session: S2, id: "zzz999", note: "not this task" }),
        focusLine({ session: S3, note: "no id" }),
      ].join("\n"),
    });
    const found = await lm.lastTaskNote({ ...toy, id: "abc123" });
    expect(found).toMatchObject({ sessionId: S1, daysAgo: 0, note: { face: null, text: "a" } });
    // The file's own logical day, which the label falls back on.
    expect(found?.day).toBe(daysBack(0).match(/(\d{4}-\d{2}-\d{2})/)?.[1]);
  });

  it("without one: no 🆔, the link leads to the task's note, the name as the writer gave it", async () => {
    const name = "Read [ch 2] :: notes";
    const { lm } = manager({
      [daysBack(0)]: [
        // The writer's form of the name (sanitizeAlias), linked the short way.
        focusLine({ session: S1, task: "[[Toy|Read (ch 2) : notes]]", note: "mine" }),
        focusLine({
          session: S2,
          task: "[[Projects/Other.md|Read (ch 2) : notes]]",
          note: "other note",
        }),
        focusLine({
          session: S3,
          task: "[[Projects/Toy.md|Read (ch 2) : notes]]",
          id: "abc123",
          note: "has an id",
        }),
        focusLine({ session: S3, task: "[[Projects/Toy.md|Something else]]", note: "other name" }),
        focusLine({ session: S3, task: "No Task", note: "unlinked" }),
      ].join("\n"),
    });
    const found = await lm.lastTaskNote({ path: "Projects/Toy.md", name });
    expect(found?.sessionId).toBe(S1);
    expect(found?.note.text).toBe("mine");
    // The raw name is not what the line holds.
    expect(await lm.lastTaskNote({ path: "Projects/Toy.md", name: "Something" })).toBeNull();
  });

  it("resolves each link from the log file, as Obsidian would from that note", async () => {
    const { plugin, lm } = manager({
      [daysBack(0)]: focusLine({ task: "[[Toy|Write docs]]", note: "short link" }),
    });
    const cache = plugin.app.metadataCache as unknown as { sources: string[] };
    expect(await lm.lastTaskNote(toy)).toMatchObject({ note: { text: "short link" } });
    expect(cache.sources.length).toBeGreaterThan(0);
    expect(new Set(cache.sources)).toEqual(new Set([daysBack(0)]));
  });

  it("never takes an unlinked line, even one under the task's own name", async () => {
    const { lm } = manager({
      [daysBack(0)]: [
        focusLine({ session: S1, note: "linked, older" }),
        focusLine({ session: S2, task: "Write docs", note: "bare name" }),
      ].join("\n"),
    });
    expect(await lm.lastTaskNote(toy)).toMatchObject({ sessionId: S1 });
  });

  it("walks back from today and stops at the first day that has one", async () => {
    const { vault, lm } = manager({
      [daysBack(0)]: focusLine({ session: S1 }),
      [daysBack(2)]: focusLine({ session: S2, note: "two days back" }),
      [daysBack(3)]: focusLine({ session: S3, note: "three days back" }),
    });
    const read = vi.spyOn(vault, "cachedRead");
    const found = await lm.lastTaskNote(toy);
    expect(found).toMatchObject({ sessionId: S2, daysAgo: 2 });
    // Day 1 has no file: passed over, never read. Day 3 is never reached.
    expect(read.mock.calls.map(([f]) => (f as TFile).path)).toEqual([daysBack(0), daysBack(2)]);
  });

  it(`searches ${FOCUS_NOTE_LOOKBACK_DAYS} logical days, today's included, and no further`, async () => {
    const last = FOCUS_NOTE_LOOKBACK_DAYS - 1;
    const inside = manager({ [daysBack(last)]: focusLine({ note: "edge" }) });
    expect(await inside.lm.lastTaskNote(toy)).toMatchObject({ daysAgo: last });
    const outside = manager({ [daysBack(last + 1)]: focusLine({ note: "too old" }) });
    expect(await outside.lm.lastTaskNote(toy)).toBeNull();
  });

  it("counts days as Day starts at does: before it, today is yesterday's file", async () => {
    vi.setSystemTime(new Date(2026, 9, 20, 2, 0));
    const { lm } = manager({ [daysBack(1)]: focusLine({ note: "late" }) }, 4);
    expect(await lm.lastTaskNote(toy)).toMatchObject({ daysAgo: 0 });
    const midnight = manager({ [daysBack(1)]: focusLine({ note: "late" }) }, 0);
    expect(await midnight.lm.lastTaskNote(toy)).toMatchObject({ daysAgo: 1 });
  });

  it("passes over a file it cannot read, and goes on to the day before", async () => {
    const { vault, lm } = manager({
      [daysBack(0)]: focusLine({ session: S1, note: "unreadable" }),
      [daysBack(1)]: focusLine({ session: S2, note: "yesterday" }),
    });
    const real = vault.cachedRead.bind(vault);
    vi.spyOn(vault, "cachedRead").mockImplementation((file: TFile) =>
      file.path === daysBack(0) ? Promise.reject(new Error("locked")) : real(file)
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await lm.lastTaskNote(toy)).toMatchObject({ sessionId: S2, daysAgo: 1 });
    expect(warn).toHaveBeenCalled();
  });

  it("finds nothing with no folder, or with no note anywhere", async () => {
    const { plugin, lm } = manager({
      [daysBack(0)]: focusLine({}),
      // With no folder set, a log-named file at the top level is no log.
      "2026-10-20-gentle-pomodoro-log.md": focusLine({ note: "at the top level" }),
    });
    expect(await lm.lastTaskNote(toy)).toBeNull();
    plugin.settings.logFolderPath = "";
    expect(await lm.lastTaskNote(toy)).toBeNull();
  });
});

/* ===== The view, read as text: nothing can import it ===== */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const view = readFileSync(resolve(root, "GentlePomoView.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const refresh = squash(callbackBody(view, "private refreshLastNote(): void {"));
const paint = squash(callbackBody(view, "private paintLastNote(today: string): void {"));
const readBlock = squash(callbackBody(refresh, "if (readKey !== this.lastNoteReadKey) {"));

describe("the view's Last time line", () => {
  it("reads the log only when its read key moves, never on the tick", () => {
    expect(readBlock).toContain("this.plugin.logManager.lastTaskNote(");
    // The key is stored before the read starts: without it every tick reads.
    const store = "this.lastNoteReadKey = readKey;";
    expect(readBlock.startsWith(store)).toBe(true);
    expect(readBlock.indexOf(store)).toBeLessThan(readBlock.indexOf("lastTaskNote("));
    expect(refresh.replace(readBlock, "").includes("lastTaskNote(")).toBe(false);
    for (const body of [refresh, paint]) {
      expect(body).not.toMatch(/\bvault\b|cachedRead|\.read\(/);
    }
  });

  it("keys the read on everything it depends on, the store's revision included", () => {
    for (const part of [
      "settings.logFolderPath",
      "path",
      "timer.currentTaskId",
      "timer.currentTaskName",
      "settings.dayStartHour",
      "today",
      "this.plugin.focusNotes.revision",
      "this.lastNoteLogRevision",
    ]) {
      expect(refresh).toMatch(
        new RegExp(`JSON\\.stringify\\(\\[[^\\]]*${part.replace(/\./g, "\\.")}`)
      );
    }
  });

  it("is wanted only with the setting, the picker and a linked task — by its path, never its name", () => {
    expect(refresh).toContain("const path = timer.currentTaskPath;");
    const wanted = /const wanted = ([^;]*);/.exec(refresh)?.[1] ?? "";
    // The whole expression: a `!` before any guard must fail.
    expect(wanted).toBe(
      'settings.focusNoteEnabled && settings.showTaskSelector && path !== undefined && settings.logFolderPath !== ""'
    );
  });

  it("keys a 🆔 task without its name, so a rename of its text does not blink", () => {
    expect(refresh).toContain("timer.currentTaskId ? null : timer.currentTaskName,");
    expect(refresh).not.toMatch(/currentTaskId \?\? null, timer\.currentTaskName/);
  });

  it("re-reads after a daily log file changes, once a burst settles", () => {
    const code = squash(view);
    for (const event of ["modify", "create", "delete"]) {
      expect(code).toContain(
        `this.registerEvent(this.app.vault.on("${event}", (file) => touched(file)));`
      );
    }
    expect(code).toContain(
      'this.registerEvent(this.app.vault.on("rename", (file, oldPath) => touched(file, oldPath)));'
    );
    expect(code).toContain(
      "if (file.path.endsWith(LOG_FILE_SUFFIX) || oldPath?.endsWith(LOG_FILE_SUFFIX)) { this.lastNoteLogTouched(); }"
    );
    const touched = squash(callbackBody(view, "private lastNoteLogTouched(): void {"));
    expect(touched).toContain(
      "if (this.lastNoteLogTimer !== null) window.clearTimeout(this.lastNoteLogTimer);"
    );
    expect(touched).toContain(
      "this.lastNoteLogTimer = null; this.lastNoteLogRevision++; this.refreshLastNote(); }, LAST_NOTE_LOG_SETTLE_MS);"
    );
    // Registered once per view, and the timer cleared at unload.
    expect(code).toContain("if (!this.lastNoteLogEventsOn) { this.lastNoteLogEventsOn = true;");
    expect(code).toContain(
      "this.register(() => { if (this.lastNoteLogTimer !== null) window.clearTimeout(this.lastNoteLogTimer); this.lastNoteLogTimer = null; });"
    );
  });

  it("drops a read a newer one overtook, and paints the one that lands", () => {
    expect(refresh).toContain("const generation = ++this.lastNoteGeneration;");
    // While the timer is idle nothing ticks, so the landing itself must paint.
    expect(refresh).toContain(
      "if (generation !== this.lastNoteGeneration) return; this.lastNote = found; this.paintLastNote(today);"
    );
  });

  it("drops the old task's note at once when the task changes, before the read", () => {
    const clear = "if (taskKey !== this.lastNoteTaskKey) this.lastNote = null;";
    expect(readBlock).toContain(clear);
    expect(readBlock).toContain("this.lastNoteTaskKey = taskKey;");
    expect(readBlock.indexOf(clear)).toBeLessThan(readBlock.indexOf("lastTaskNote("));
    expect(readBlock.indexOf(clear)).toBeLessThan(
      readBlock.indexOf("this.lastNoteTaskKey = taskKey;")
    );
  });

  it("writes the label, the face and the words, and repaints when the note itself moves", () => {
    // An Update keeps the session and its Start: only the note tells it apart.
    expect(paint).toMatch(/const key = JSON\.stringify\([^;]*found\.note[^;]*\);/);
    expect(paint).toContain("this.lastNoteWhenEl.setText(`${LAST_NOTE_LABEL} · ${when}`);");
    expect(paint).toContain('this.lastNoteFaceEl.toggleClass("gp-hidden", face === null);');
    expect(paint).toContain("setIcon(this.lastNoteFaceEl, face);");
    expect(paint).toContain('this.lastNoteFaceEl.setAttribute("aria-label", FACE_LABELS[face]);');
    expect(paint).toContain('this.lastNoteTextEl.toggleClass("gp-hidden", text === "");');
    expect(paint).toContain("this.lastNoteTextEl.setText(text);");
    expect(paint).toContain('else this.lastNoteTextEl.setAttribute("title", text);');
    expect(paint).toContain('if (text === "") this.lastNoteTextEl.removeAttribute("title");');
  });

  it("hides while the card shows in this panel, and writes text only", () => {
    expect(paint).toContain("const cardShowing = store.target !== null && store.cardOpen;");
    expect(paint).toMatch(/const found = [^;]*cardShowing \? null : this\.lastNote;/);
    expect(paint).toContain('el.toggleClass("gp-hidden", found === null);');
    expect(paint).not.toMatch(/innerHTML|insertAdjacentHTML/);
    // Painted only when what it shows moves: the key checked, then kept.
    expect(paint).toContain(
      "if (key === this.lastNotePaintKey) return; this.lastNotePaintKey = key;"
    );
  });

  it("runs from applySettings, and hears the store through a listener taken off at unload", () => {
    const apply = squash(callbackBody(view, "applySettings() {"));
    expect(apply).toContain("this.refreshLastNote();");
    // While idle nothing ticks: a new log folder or "Day starts at", and
    // midnight, reach an open panel only through main.ts's goal-line push
    // (logFolderChanged, the heartbeat's landing), so the line hangs off it.
    const goal = squash(callbackBody(view, "setGoalProgress(text: string, met: boolean) {"));
    expect(goal.startsWith("this.refreshLastNote();")).toBe(true);
    const main = readFileSync(resolve(root, "main.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(squash(callbackBody(main, "logFolderChanged(): void {"))).toContain(
      "this.refreshGoalDisplays();"
    );
    expect(squash(callbackBody(main, "refreshGoalDisplays(): void {"))).toContain(
      "this.refreshViewGoalProgress(leaf.view, state);"
    );
    expect(squash(callbackBody(main, "onLanded: () => {"))).toContain(
      "this.refreshViewGoalProgress(leaf.view, state);"
    );
    expect(
      squash(
        callbackBody(
          main,
          "refreshViewGoalProgress(view: GentlePomoView, state: TimerState = this.timer.getState()): void {"
        )
      )
    ).toContain("view.setGoalProgress(");
    const code = squash(view);
    expect(code).toContain("this.plugin.focusNotes.onChange(this.lastNoteListener);");
    expect(code).toContain(
      "this.register(() => this.plugin.focusNotes.offChange(this.lastNoteListener));"
    );
  });

  it("is built after the card and before the music rule", () => {
    const card = view.indexOf("new FocusNoteCard(controls");
    const line = view.indexOf('controls.createDiv("gp-last-note gp-hidden")');
    const rule = view.indexOf('controls.createDiv("gp-music-divider")');
    expect(card).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(card);
    expect(rule).toBeGreaterThan(line);
  });
});

describe("the Last time line's styles", () => {
  const rules = parseRules(stripComments(readFileSync(resolve(root, "styles.css"), "utf8")));
  const body = (sel: string) => rules.find((r) => r.sel === sel)?.body ?? "";
  const decl = (sel: string, prop: string) =>
    new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body(sel))?.[1].trim();

  it("sits as far above the music rule as the card does", () => {
    expect(decl(".gp-last-note", "margin-bottom")).toBeDefined();
    expect(decl(".gp-last-note", "margin-bottom")).toBe(decl(".gp-note", "margin-bottom"));
  });

  it("is as wide as the task button, its words starting where the button's do", () => {
    expect(decl(".gp-last-note", "width")).toBe("100%");
    expect(decl(".gp-last-note", "box-sizing")).toBe("border-box");
    const sidePadding = (value: string | undefined) => value?.split(/\s+/)[1];
    expect(sidePadding(decl(".gp-last-note", "padding"))).toBe(
      sidePadding(decl(".gp-btn-full", "padding"))
    );
    expect(sidePadding(decl(".gp-btn-full", "padding"))).toBeDefined();
  });

  it("takes the card's place under a closed list, and none under an open list", () => {
    // Pulled up one row gap, as the card: deeper laid it over the list's last
    // rows while the list shrank after closing.
    expect(decl(".gp-last-note", "margin-top")).toBe("calc(-1 * var(--gp-space-5))");
    expect(decl(".gp-last-note", "margin-top")).toBe(decl(".gp-note", "margin-top"));
    expect(decl(".gp-task-list.gp-visible ~ .gp-last-note", "margin-top")).toBe("0");
  });

  it("moves nothing, and floors its icon against WebKit's sliver", () => {
    for (const rule of rules.filter((r) => r.sel.includes("gp-last-note"))) {
      expect(rule.body).not.toMatch(/transition|animation/);
    }
    const svg = body(".gp-last-note-face svg");
    expect(svg).toMatch(/min-width:\s*14px/);
    expect(svg).toMatch(/flex-shrink:\s*0/);
  });
});
