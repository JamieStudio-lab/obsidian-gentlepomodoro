import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUILTIN_CUES,
  CUE_MAX_SECONDS,
  CUE_SETTING_KEY,
  DEFAULT_END_CUE,
  checkCueDuration,
  checkCueFileSize,
  cueChoiceText,
  cueChoiceValue,
  cueChoices,
  cueExtension,
  cueLabel,
  describeCueFallback,
  describeCueRefusal,
  resolveCue,
  type CueProblem,
} from "../timerCues";
import { DEFAULT_SETTINGS } from "../constants";

// ---------------------------------------------------------------------------
// Which sound marks each end (0.6.7, GitHub issue #5). The resolver is the
// only reader of the two settings, and coerceToDefaults lets ANY string reach
// it — so every odd value a hand-edited or newer data.json can hold has to
// land on today's sound, never on silence and never on the other edge's.
// ---------------------------------------------------------------------------

const BELL = "singing_bell_short.mp3";
const DING = "ding-sound.mp3";
const DRUM = "war-drum_short.mp3";

describe("the defaults are today's sounds", () => {
  it("rings the bell when focus ends and the ding when a break ends", () => {
    // An upgrade must change nobody's sounds: the merge base IS the default.
    expect(resolveCue(DEFAULT_SETTINGS.focusEndSound, "focus")).toEqual({ file: BELL, path: null });
    expect(resolveCue(DEFAULT_SETTINGS.breakEndSound, "break")).toEqual({ file: DING, path: null });
  });

  it("keeps the stored defaults and the resolver's fallbacks in step", () => {
    expect(DEFAULT_SETTINGS.focusEndSound).toBe(DEFAULT_END_CUE.focus);
    expect(DEFAULT_SETTINGS.breakEndSound).toBe(DEFAULT_END_CUE.break);
  });

  it("maps each edge to its OWN setting", () => {
    // The mapping lives here so it can be tested; crossed, a focus choice
    // would ring at the end of breaks and read perfectly well doing it.
    expect(CUE_SETTING_KEY).toEqual({ focus: "focusEndSound", break: "breakEndSound" });
  });

  it("names each built-in's own file", () => {
    expect(BUILTIN_CUES.bell.file).toBe(BELL);
    expect(BUILTIN_CUES.ding.file).toBe(DING);
    expect(BUILTIN_CUES.drum.file).toBe(DRUM);
  });
});

describe("resolveCue", () => {
  it("plays any built-in on either edge", () => {
    expect(resolveCue("drum", "focus")).toEqual({ file: DRUM, path: null });
    expect(resolveCue("bell", "break")).toEqual({ file: BELL, path: null });
  });

  it("keeps a vault file, with the edge's own default behind it", () => {
    expect(resolveCue("file:Sounds/gong.mp3", "focus")).toEqual({
      file: BELL,
      path: "Sounds/gong.mp3",
    });
    expect(resolveCue("file:Sounds/gong.mp3", "break")).toEqual({
      file: DING,
      path: "Sounds/gong.mp3",
    });
  });

  it("does not take prototype names for sounds", () => {
    // `in` walks the prototype chain — resolveTheme shipped this exact bug.
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(resolveCue(name, "focus"), name).toEqual({ file: BELL, path: null });
    }
  });

  it("falls back to the edge's default for anything it does not recognise", () => {
    for (const value of ["", "gong", "Bell", "file:", "file:notes.md", "file:x.ogg", 42, null]) {
      expect(resolveCue(value, "break"), String(value)).toEqual({ file: DING, path: null });
    }
  });

  it("needs the prefix: a bare path is not a file choice", () => {
    // The prefix says which kind a value is; nothing is inferred from the text.
    expect(resolveCue("Sounds/gong.mp3", "focus")).toEqual({ file: BELL, path: null });
    expect(resolveCue("ding-sound.mp3", "focus")).toEqual({ file: BELL, path: null });
  });
});

describe("cueExtension", () => {
  it("accepts mp3, m4a and wav in any case", () => {
    expect(cueExtension("a/b.mp3")).toBe("mp3");
    expect(cueExtension("a/b.M4A")).toBe("m4a");
    expect(cueExtension("b.Wav")).toBe("wav");
  });

  it("refuses the formats that do not play everywhere, and names with no extension", () => {
    for (const path of [
      "a.ogg",
      "a.opus",
      "a.flac",
      "a.webm",
      "a.aiff",
      "a",
      ".mp3",
      "dir.mp3/a",
    ]) {
      expect(cueExtension(path), path).toBe(null);
    }
  });
});

describe("the limits", () => {
  it("refuses a compressed file over 2 MB before it is read", () => {
    expect(checkCueFileSize("a.mp3", 2 * 1024 * 1024)).toBe(null);
    expect(checkCueFileSize("a.mp3", 2 * 1024 * 1024 + 1)).toBe("too-large");
    expect(checkCueFileSize("a.m4a", 3 * 1024 * 1024)).toBe("too-large");
  });

  it("lets a wav be larger, since it decodes to only about twice its size", () => {
    // 30 seconds of 24-bit stereo is about 9 MB.
    expect(checkCueFileSize("a.wav", 9 * 1024 * 1024)).toBe(null);
    // ...and 32-bit float, 30.5 s at 48 kHz, is about 11.7 MB.
    expect(checkCueFileSize("a.wav", 11_712_000)).toBe(null);
    expect(checkCueFileSize("a.wav", 12 * 1024 * 1024 + 1)).toBe("too-large");
  });

  it("refuses a sound longer than 30 seconds, with room for encoder padding", () => {
    expect(CUE_MAX_SECONDS).toBe(30);
    expect(checkCueDuration(30.4)).toBe(null);
    expect(checkCueDuration(31)).toBe("too-long");
    expect(checkCueDuration(4)).toBe(null);
  });
});

describe("cueLabel — what the button says", () => {
  it("names a built-in", () => {
    expect(cueLabel("bell", "focus")).toBe("Singing bell");
    expect(cueLabel("drum", "break")).toBe("War drum");
    expect(cueLabel("garbage", "break")).toBe("Ding");
  });

  it("names a file by its own name, not its folder", () => {
    expect(cueLabel("file:Sounds/Chimes/gong.m4a", "focus")).toBe("gong.m4a");
  });

  it("shortens a long name but keeps its extension", () => {
    const label = cueLabel(`file:${"x".repeat(80)}.wav`, "focus");
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label.endsWith("….wav")).toBe(true);
  });
});

describe("the picker's list", () => {
  it("offers the three built-ins first, then the playable vault files by path", () => {
    const choices = cueChoices([
      { path: "z/late.mp3" },
      { path: "notes.md" },
      { path: "a/early.WAV" },
      { path: "clip.ogg" },
    ]);
    expect(choices.map(cueChoiceText)).toEqual([
      "Singing bell (built-in)",
      "Ding (built-in)",
      "War drum (built-in)",
      "a/early.WAV",
      "z/late.mp3",
    ]);
  });

  it("stores a built-in by id and a file with the prefix", () => {
    expect(cueChoiceValue({ kind: "builtin", id: "drum" })).toBe("drum");
    expect(cueChoiceValue({ kind: "file", path: "a/b.mp3" })).toBe("file:a/b.mp3");
    // And the stored value reads back as the same choice.
    expect(resolveCue(cueChoiceValue({ kind: "file", path: "a/b.mp3" }), "focus").path).toBe(
      "a/b.mp3"
    );
  });
});

describe("the wording", () => {
  const problems: CueProblem[] = ["missing", "too-large", "unreadable", "undecodable", "too-long"];

  it("always says what plays instead when a saved file cannot", () => {
    for (const p of problems) {
      expect(describeCueFallback(p, "a.mp3", "focus"), p).toMatch(/Singing bell plays instead\.$/);
      expect(describeCueFallback(p, "a.mp3", "break"), p).toMatch(/Ding plays instead\.$/);
    }
  });

  it("gives each problem its own line, both when saved and when picked", () => {
    const saved = new Set(problems.map((p) => describeCueFallback(p, "a.mp3", "focus")));
    const picked = new Set(problems.map((p) => describeCueRefusal(p, "a.mp3")));
    expect(saved.size).toBe(problems.length);
    expect(picked.size).toBe(problems.length);
  });

  it("quotes the limit that applies to this kind of file", () => {
    expect(describeCueRefusal("too-large", "a.mp3")).toContain("2 MB");
    expect(describeCueRefusal("too-large", "a.wav")).toContain("12 MB");
    expect(describeCueRefusal("too-long", "a.mp3")).toContain("30 seconds");
  });
});

describe("the plugin's wiring", () => {
  // main.ts cannot be imported by a test (it pulls in the whole view), so the
  // line that decodes a chosen file at startup is read as text, comments
  // stripped. Deleting it kept every other test green: the engine's own
  // prepareEndCues test calls the method directly, and cannot see who does.
  const main = readFileSync(resolve(__dirname, "..", "main.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

  it("decodes a chosen sound file once the layout is ready", () => {
    const start = main.indexOf("this.app.workspace.onLayoutReady(() => {");
    expect(start).toBeGreaterThan(-1);
    const callback = main.slice(start, main.indexOf("});", start));
    expect(callback).toContain("this.timer.prepareEndCues();");
  });

  it("hands every vault modify to the engine, which re-decodes a chosen file", () => {
    expect(main).toContain(
      'this.app.vault.on("modify", async (file) => { await this.timer.onFileModify(file); })'
    );
  });
});
