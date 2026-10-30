import { describe, it, expect } from "vitest";
import {
  LOG_TABLES_PAGE,
  logPageValue,
  logTablesPageValue,
  musicPageValue,
  musicPageWarning,
  safePageStatus,
  safePageValue,
  soundsPageValue,
  statusBarPageValue,
  tasksPageValue,
  timerPageValue,
} from "../settingPages";
import { DEFAULT_SETTINGS } from "../constants";
import { THEMES } from "../themes";
import { cueLabel } from "../timerCues";
import type { GentlePomoSettings } from "../types";

/**
 * The values on the right of the settings tab's page rows (0.7.0,
 * settingPages.ts). Each is worked out when Obsidian draws the list, so these
 * are what a page row says for the settings as they are.
 */

const settings = (over: Partial<GentlePomoSettings> = {}): GentlePomoSettings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

describe("the settings pages' values", () => {
  it("names the theme on the Timer page, falling back as the timer does", () => {
    expect(timerPageValue(settings({ theme: "pixel-city" }))).toBe(THEMES["pixel-city"]);
    expect(timerPageValue(settings({ theme: "toString" as never }))).toBe(THEMES.classic);
  });

  it("says whether the status bar is shown", () => {
    expect(statusBarPageValue(settings({ showInStatusBar: true }))).toBe("On");
    expect(statusBarPageValue(settings({ showInStatusBar: false }))).toBe("Off");
  });

  it("names the two end sounds, or that the timer is muted", () => {
    const s = settings({ focusEndSound: "drum", breakEndSound: "file:Sounds/chime.mp3" });
    expect(soundsPageValue(s)).toBe(
      `${cueLabel("drum", "focus")} · ${cueLabel("file:Sounds/chime.mp3", "break")}`
    );
    expect(soundsPageValue(s)).toBe("War drum · chime.mp3");
    expect(soundsPageValue(settings({ soundEnabled: false }))).toBe("Timer sounds off");
  });

  it("counts the music links, or says the player is off", () => {
    expect(musicPageValue(settings({ musicUrl: "", musicUrl2: "", musicUrl3: "" }))).toBe(
      "No link"
    );
    expect(
      musicPageValue(settings({ musicUrl: " ", musicUrl2: "https://youtu.be/abcdefghijk" }))
    ).toBe("1 link");
    expect(
      musicPageValue(
        settings({
          musicUrl: "https://youtu.be/abcdefghijk",
          musicUrl3: "https://youtu.be/abcdefghijl",
        })
      )
    ).toBe("2 links");
    expect(
      musicPageValue(settings({ musicUrl: "https://youtu.be/abcdefghijk", showMusicPlayer: false }))
    ).toBe("Off");
  });

  it("warns of a music link that is not one the player can load, and only then", () => {
    expect(musicPageWarning(settings({ musicUrl: "https://youtu.be/abcdefghijk" }))).toBe(false);
    expect(musicPageWarning(settings({ musicUrl: "", musicUrl2: "", musicUrl3: "" }))).toBe(false);
    expect(musicPageWarning(settings({ musicUrl3: "https://example.com/song" }))).toBe(true);
  });

  it("names the log folder, trimmed, or says the log is off", () => {
    expect(logPageValue(settings({ logFolderPath: " Journal/Pomodoro " }))).toBe(
      "Journal/Pomodoro"
    );
    expect(logPageValue(settings({ logFolderPath: "" }))).toBe("Off");
    expect(logPageValue(settings({ logFolderPath: 3 as never }))).toBe("Off");
  });

  it("counts the sessions table's columns and names its days", () => {
    expect(logTablesPageValue(settings())).toBe("5 columns · Last 7 days");
    expect(logTablesPageValue(settings({ queryColumns: "task", queryRange: "note" }))).toBe(
      "1 column · This note's day"
    );
    expect(logTablesPageValue(settings({ queryRange: "fortnight" as never }))).toBe(
      "5 columns · Last 7 days"
    );
  });

  it("names where the task picker looks, or says it is off", () => {
    expect(tasksPageValue(settings({ taskSource: "open-notes" }))).toBe("Open notes");
    expect(tasksPageValue(settings({ taskSource: "nonsense" as never }))).toBe("Tasks folder");
    expect(tasksPageValue(settings({ showTaskSelector: false }))).toBe("Picker off");
  });

  it("never throws into Obsidian's drawing of the list", () => {
    expect(
      safePageValue(() => {
        throw new Error("boom");
      })
    ).toBe("");
    expect(safePageValue(() => 3 as never)).toBe("");
    expect(safePageValue(() => "Off")).toBe("Off");
    expect(
      safePageStatus(() => {
        throw new Error("boom");
      })
    ).toBeNull();
    expect(safePageStatus(() => true)).toBe("warning");
    expect(safePageStatus(() => false)).toBeNull();
  });

  it("calls the tables page what the group is called", () => {
    expect(LOG_TABLES_PAGE).toBe("Log tables");
  });
});
