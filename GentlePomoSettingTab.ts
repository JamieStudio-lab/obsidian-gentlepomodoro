import {
  App,
  PluginSettingTab,
  Setting,
  debounce,
  requestUrl,
  type SettingDefinitionItem,
  type SettingGroupItem,
  type TextComponent,
} from "obsidian";
import { markDestructive } from "./confirmModal";
import type GentlePomoPlugin from "./main";
import { NO_TASK_LABEL, VIEW_TYPE_GENTLE_POMO } from "./constants";
import type { GentlePomoSettings } from "./types";
import {
  validateMusicUrl,
  parseYouTubeUrl,
  buildOEmbedProbeUrl,
  parseOEmbedResponse,
  pickStationName,
  describeLinkCheck,
  MUSIC_STATION_LIMIT,
  type MusicTarget,
} from "./youtubeMusic";

type SettingsKey = keyof GentlePomoSettings;

// Shared between the declarative (1.13+) and imperative (pre-1.13) paths so
// the two can't drift.
const POMO_COUNT_TOGGLE_DESC =
  "Beta — edits your task files. Adds a lifetime '🍅 N' marker to the task line each time a linked focus session ends.";
const MUSIC_RESUME_DESC =
  "Reopen each link where you paused or left it, including after quitting Obsidian. Press ⏹ — or change the link — to start that one from the top next time. Live streams always start live.";
const MUSIC_URL_DESC =
  "Paste a YouTube video, live stream, or playlist link. Audio plays in the timer panel — the video is never shown. A playlist is the easiest way to line up several tracks under one link.";
const MUSIC_URL_EXTRA_DESC =
  "Optional. Fill this in to switch between links from the timer panel; leave it empty and the slot is unused.";
const MUSIC_NAME_DESC =
  "Optional short name for this link's button in the timer panel, e.g. Lofi or Rain. Leave empty to use the number.";
const CHECK_MARKERS_NAME = "Check for misplaced pomodoro count markers";
const CHECK_MARKERS_DESC =
  "Counts markers misplaced by versions before 0.5.1, changing nothing. Affected files are listed in the developer console.";
const REPAIR_MARKERS_NAME = "Repair misplaced pomodoro count markers";
const REPAIR_MARKERS_DESC =
  "Moves misplaced markers back in front of the Tasks fields, keeping their counts. Asks for confirmation first.";
const REMOVE_MARKERS_NAME = "Remove misplaced pomodoro count markers";
const REMOVE_MARKERS_DESC =
  "Deletes misplaced markers instead, losing their counts. Asks for confirmation first.";
const REMOVE_ALL_MARKERS_NAME = "Remove all pomodoro count markers";
const REMOVE_ALL_MARKERS_DESC =
  "Risky — deletes every 🍅 marker the counter has written, losing all counts, and cannot be undone. Back up your vault first. Asks for confirmation.";

// How long to wait after the last keystroke before asking YouTube about a link.
// Both settings paths commit on every keystroke, so an un-debounced check would
// be one request per character.
const MUSIC_LINK_CHECK_DEBOUNCE_MS = 800;
// A "YouTube has it" answer is stable; a negative one may be a link that was
// only just published, or a blip, so it is re-asked after a while.
const MUSIC_LINK_CACHE_TTL_MS = 60_000;

const MUSIC_URL_KEYS = ["musicUrl", "musicUrl2", "musicUrl3"] as const;
const MUSIC_NAME_KEYS = ["musicName1", "musicName2", "musicName3"] as const;
const MUSIC_NAME_PLACEHOLDERS = ["Lofi", "Rain", "Piano"] as const;

/** What one oEmbed probe learned. `name` is "" when nothing usable came back. */
interface LinkProbeResult {
  status: number;
  name: string;
}

/**
 * Ask YouTube whether it has this link, and what it is called. Returns null
 * when the question could not be put at all (offline, blocked, a body that is
 * not JSON) — callers must then say nothing rather than accuse the link.
 */
async function probeMusicLink(target: MusicTarget): Promise<LinkProbeResult | null> {
  const url = buildOEmbedProbeUrl(target);
  if (url === null) return null;
  try {
    // throw:false — a 400/401/404 IS the answer here, not an error.
    const response = await requestUrl({ url, method: "GET", throw: false });
    let name = "";
    if (response.status === 200) {
      // .json is a getter that parses on access, and the non-200 bodies are
      // plain text under a JSON content type — so it is only ever touched here,
      // and even then defensively.
      try {
        const fields = parseOEmbedResponse(response.json);
        if (fields !== null) name = pickStationName(fields);
      } catch {
        name = "";
      }
    }
    return { status: response.status, name };
  } catch {
    return null;
  }
}

/** Per-slot view state for the link rows. Rebuilt whenever the tab renders. */
interface MusicSlotUi {
  urlInput: TextComponent | null;
  nameInput: TextComponent | null;
  errorEl: HTMLElement | null;
  /** Bumped on every keystroke and on hide(); a probe whose token moved is stale. */
  token: number;
  probe: ((url: string, target: MusicTarget, token: number) => void) | null;
}

export class GentlePomoSettingTab extends PluginSettingTab {
  plugin: GentlePomoPlugin;

  constructor(app: App, plugin: GentlePomoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * The six link/name rows, shared shape for the 1.13 path. Kept beside the
   * imperative loop in display() — changing one means changing both.
   */
  private musicLinkDefinitions(): SettingGroupItem<SettingsKey>[] {
    const rows: SettingGroupItem<SettingsKey>[] = [];
    for (let slot = 0; slot < MUSIC_STATION_LIMIT; slot++) {
      rows.push({
        name: `Music link ${String(slot + 1)}`,
        desc: slot === 0 ? MUSIC_URL_DESC : MUSIC_URL_EXTRA_DESC,
        render: (setting) => this.buildMusicUrlRow(setting, slot),
      });
      rows.push({
        name: `Name for link ${String(slot + 1)}`,
        desc: MUSIC_NAME_DESC,
        render: (setting) => this.buildMusicNameRow(setting, slot),
      });
    }
    return rows;
  }

  private musicSlotUi: MusicSlotUi[] = [];
  private linkProbeCache = new Map<string, { result: LinkProbeResult; at: number }>();

  private musicSlot(slot: number): MusicSlotUi {
    let ui = this.musicSlotUi[slot];
    if (!ui) {
      ui = { urlInput: null, nameInput: null, errorEl: null, token: 0, probe: null };
      this.musicSlotUi[slot] = ui;
    }
    return ui;
  }

  /**
   * Closing the tab must drop every request still in the air, or a landing
   * would paint an error into a torn-down row, or write a name for a link the
   * user has since changed.
   */
  override hide(): void {
    for (const ui of this.musicSlotUi) {
      if (ui) ui.token++;
    }
    super.hide();
  }

  /**
   * One music-link row, shared by both settings paths so they cannot drift.
   * Returns the teardown the 1.13 render hook wants; harmless to ignore.
   *
   * Deliberately NOT the declarative `validate` hook, even though it accepts a
   * promise: that hook is awaited inside the control's own per-keystroke
   * handler, with no debouncing and no sequencing of its own, so a slow answer
   * to an old keystroke can land after a newer one. The debounce and the token
   * below are the whole point, and they have to live outside it.
   */
  private buildMusicUrlRow(setting: Setting, slot: number): () => void {
    const ui = this.musicSlot(slot);
    const urlKey = MUSIC_URL_KEYS[slot];
    setting.addText((text) => {
      ui.urlInput = text;
      text
        .setPlaceholder("Paste a YouTube link")
        .setValue(this.plugin.settings[urlKey])
        .onChange((value) => {
          void this.handleMusicUrlInput(slot, value);
        });
    });
    setting.settingEl.addClass("gp-setting-with-error");
    ui.errorEl = setting.controlEl.createDiv("gp-setting-error");
    // Paint what the STORED value already says. The sync validate hook used to
    // do this for free on mount, and a link that is broken in data.json must not
    // become invisible here just because nobody has typed in the box yet.
    this.paintMusicLinkError(slot, validateMusicUrl(this.plugin.settings[urlKey]) ?? null);
    return () => {
      ui.token++;
      ui.urlInput = null;
      ui.errorEl = null;
    };
  }

  /** The name row beside a link. Held onto so a probe can offer a name into it. */
  private buildMusicNameRow(setting: Setting, slot: number): () => void {
    const ui = this.musicSlot(slot);
    const nameKey = MUSIC_NAME_KEYS[slot];
    setting.addText((text) => {
      ui.nameInput = text;
      text
        .setPlaceholder(MUSIC_NAME_PLACEHOLDERS[slot] ?? "")
        .setValue(this.plugin.settings[nameKey])
        .onChange((value) => {
          void this.commitMusicName(slot, value);
        });
    });
    return () => {
      ui.nameInput = null;
    };
  }

  private async commitMusicName(slot: number, value: string): Promise<void> {
    const nameKey = MUSIC_NAME_KEYS[slot];
    this.plugin.settings[nameKey] = value.trim();
    await this.plugin.saveSettings();
    this.applySettingsToOpenViews();
  }

  private paintMusicLinkError(slot: number, message: string | null): void {
    const el = this.musicSlot(slot).errorEl;
    if (!el) return;
    el.setText(message ?? "");
  }

  private async handleMusicUrlInput(slot: number, raw: string): Promise<void> {
    const ui = this.musicSlot(slot);
    // Every keystroke invalidates whatever is in flight for this slot.
    const token = ++ui.token;
    const value = raw.trim();
    const urlKey = MUSIC_URL_KEYS[slot];
    this.plugin.settings[urlKey] = value;
    await this.plugin.saveSettings();
    this.applySettingsToOpenViews();

    // Tier 1: is this a YouTube link at all. Local, instant, and the only check
    // that can be certain.
    const syntax = validateMusicUrl(value);
    if (syntax !== undefined) {
      this.paintMusicLinkError(slot, syntax);
      return;
    }
    this.paintMusicLinkError(slot, null);
    if (value === "") return;
    const target = parseYouTubeUrl(value);
    if (target === null) return;
    // Tier 2: does YouTube have it, and what is it called. One request answers
    // both. (There is no tier 3 — whether it will actually PLAY depends on the
    // Referer the iframe sends, which this request cannot reproduce.)
    ui.probe ??= debounce(
      (url: string, probeTarget: MusicTarget, issuedToken: number) => {
        void this.runMusicLinkProbe(slot, url, probeTarget, issuedToken);
      },
      MUSIC_LINK_CHECK_DEBOUNCE_MS,
      true
    );
    ui.probe(value, target, token);
  }

  private async runMusicLinkProbe(
    slot: number,
    frozenUrl: string,
    target: MusicTarget,
    token: number
  ): Promise<void> {
    const ui = this.musicSlot(slot);
    if (token !== ui.token) return;

    const cached = this.linkProbeCache.get(frozenUrl);
    const fresh =
      cached !== undefined &&
      (cached.result.status === 200 || Date.now() - cached.at < MUSIC_LINK_CACHE_TTL_MS);
    const result = fresh && cached !== undefined ? cached.result : await probeMusicLink(target);
    // A keystroke landed while the request was out: this answer describes a URL
    // the user has already moved on from.
    if (token !== ui.token) return;
    // Could not ask. Saying nothing beats accusing a link that may be fine.
    if (result === null) return;
    if (!fresh) this.linkProbeCache.set(frozenUrl, { result, at: Date.now() });
    // Belt to the token's braces: the slot must still hold the link we asked
    // about. Compared against the string frozen when the request was issued,
    // never against the live setting — that is 0.5.6's provenance rule, and the
    // reason a position could once be stamped with the wrong URL.
    if (this.plugin.settings[MUSIC_URL_KEYS[slot]].trim() !== frozenUrl) return;

    this.paintMusicLinkError(slot, describeLinkCheck(result.status, target));
    this.maybePrefillMusicName(slot, result.name);
  }

  /**
   * Offer the name YouTube reports, and only ever as an offer: a name the user
   * has typed is never overwritten, and neither is one they are in the middle
   * of typing.
   *
   * The stored setting is trimmed, so "the setting is empty" is not enough on
   * its own — someone who typed a letter and deleted it, or only whitespace,
   * has an empty setting with their cursor still in the box, and writing there
   * would rewrite the field under the caret. That window grows with latency,
   * and it is the one moment "still allow edits" is most visibly broken.
   */
  private maybePrefillMusicName(slot: number, name: string): void {
    if (name === "") return;
    const nameKey = MUSIC_NAME_KEYS[slot];
    if (this.plugin.settings[nameKey].trim() !== "") return;
    const input = this.musicSlot(slot).nameInput;
    if (input) {
      if (!input.inputEl.isConnected) return;
      if (input.getValue().trim() !== "") return;
      if (activeDocument.activeElement === input.inputEl) return;
      input.setValue(name);
    }
    void this.commitMusicName(slot, name);
  }

  private applySettingsToOpenViews(): void {
    const hasApplySettings = (view: unknown): view is { applySettings: () => void } => {
      if (!view || typeof view !== "object") return false;
      return (
        "applySettings" in view &&
        typeof (view as { applySettings?: unknown }).applySettings === "function"
      );
    };

    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GENTLE_POMO);
    for (const leaf of leaves) {
      const view: unknown = leaf.view;
      if (hasApplySettings(view)) view.applySettings();
    }
  }

  override getSettingDefinitions(): SettingDefinitionItem<SettingsKey>[] {
    return [
      {
        type: "group",
        heading: "Display & behavior",
        items: [
          {
            name: "Pomodoro logs folder",
            desc: "Folder to store daily log files (e.g., 'pomodoro_logs').",
            control: { type: "text", key: "logFolderPath", placeholder: "Example: pomodoro_logs" },
          },
          {
            name: "Auto-open on startup",
            desc: "Open the view in the right panel when Obsidian starts.",
            control: { type: "toggle", key: "autoOpenOnStartup" },
          },
          {
            name: "Show status bar",
            desc: "Show the status bar indicator.",
            control: { type: "toggle", key: "showInStatusBar" },
          },
        ],
      },
      {
        type: "group",
        heading: "Timer appearance",
        items: [
          {
            name: "Theme",
            desc: "Visual style for the timer.",
            control: {
              type: "dropdown",
              key: "theme",
              options: { classic: "Classic", "frosted-glass": "Frosted glass" },
            },
          },
          {
            name: "Day/night indicator",
            desc: "Show a subtle sun/moon indicator above the timer.",
            control: { type: "toggle", key: "showDayNightIndicator" },
          },
          {
            name: "Show estimated end time",
            desc: "Show the projected finish time on the timer while a session is running.",
            control: { type: "toggle", key: "showEndTime" },
          },
        ],
      },
      {
        type: "group",
        heading: "Music",
        items: [
          // Rendered rather than declared, because the link check owns its own
          // debounce, its own staleness token and an error line of its own —
          // none of which the `validate` hook can carry (see buildMusicUrlRow).
          // setName/setDesc still come from here, so settings search keeps
          // finding these rows.
          ...this.musicLinkDefinitions(),
          {
            name: "Show music player",
            desc: "Show the music controls in the timer panel. Turning this off also stops playback.",
            control: { type: "toggle", key: "showMusicPlayer" },
          },
          {
            name: "Loop music",
            desc: "Replay the video or playlist from the start when it ends. Live streams aren't affected. Changing this reloads the player.",
            control: { type: "toggle", key: "musicLoop" },
          },
          {
            name: "Resume where you left off",
            desc: MUSIC_RESUME_DESC,
            control: { type: "toggle", key: "musicResume" },
          },
        ],
      },
      {
        type: "group",
        heading: "Long break",
        items: [
          {
            name: "Long break duration (minutes)",
            desc: "Length of the long break that replaces a regular break.",
            control: { type: "number", key: "longBreakMinutes", min: 1 },
          },
          {
            name: "Long break frequency",
            desc: "Number of focus sessions before each long break (classic technique uses 4).",
            control: { type: "number", key: "longBreakEvery", min: 1 },
          },
        ],
      },
      {
        type: "group",
        heading: "Daily focus goal",
        items: [
          {
            name: "Daily focus goal (minutes)",
            desc: "Set to 0 to disable. The status bar shows today's progress against this goal.",
            control: { type: "number", key: "dailyFocusGoalMinutes", min: 0 },
          },
          {
            name: "Goal-hit notice",
            desc: "Show a one-time notice when today's focus first crosses the daily goal.",
            control: { type: "toggle", key: "goalNoticeEnabled" },
          },
        ],
      },
      {
        type: "group",
        heading: "Task selector",
        items: [
          {
            name: "Tasks folder path",
            desc: "Folder to search for tasks (e.g., 'daily notes'). Leave empty to search the entire vault.",
            control: { type: "text", key: "tasksPath", placeholder: "Example: projects/active" },
          },
          {
            name: "Show task selector",
            desc: "Show the task picker in the timer panel. Turning this off unlinks the current task.",
            control: { type: "toggle", key: "showTaskSelector" },
          },
          {
            name: "Task lookahead window",
            desc: "How many days ahead the task selector shows scheduled/due tasks. Overdue tasks always appear.",
            control: {
              type: "dropdown",
              key: "taskSelectorDays",
              options: {
                "3": "3 Days",
                "5": "5 Days",
                "7": "7 Days",
                "14": "14 Days",
                "30": "30 Days",
              },
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Task integration",
        items: [
          {
            name: "Increment task pomodoro count on finish",
            desc: POMO_COUNT_TOGGLE_DESC,
            control: { type: "toggle", key: "incrementPomodoroCountOnFinish" },
          },
          {
            name: CHECK_MARKERS_NAME,
            desc: CHECK_MARKERS_DESC,
            action: () => {
              void this.plugin.checkPomodoroMarkers();
            },
          },
          {
            name: REPAIR_MARKERS_NAME,
            desc: REPAIR_MARKERS_DESC,
            action: () => {
              void this.plugin.repairPomodoroMarkers();
            },
          },
          {
            name: REMOVE_MARKERS_NAME,
            desc: REMOVE_MARKERS_DESC,
            action: () => {
              void this.plugin.removeMisplacedPomodoroMarkers();
            },
          },
          {
            name: REMOVE_ALL_MARKERS_NAME,
            desc: REMOVE_ALL_MARKERS_DESC,
            action: () => {
              void this.plugin.removeAllPomodoroMarkers();
            },
          },
        ],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    // The lookahead dropdown persists a number but renders string option keys.
    if (key === "taskSelectorDays") return this.plugin.settings.taskSelectorDays.toString();
    return this.plugin.settings[key as SettingsKey];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    switch (key as SettingsKey) {
      case "tasksPath":
        settings.tasksPath = String(value);
        break;
      case "showTaskSelector": {
        const show = Boolean(value);
        settings.showTaskSelector = show;
        await this.plugin.saveSettings();
        if (!show && this.plugin.timer.currentTaskName !== NO_TASK_LABEL) {
          this.plugin.timer.setTask(NO_TASK_LABEL);
        }
        this.applySettingsToOpenViews();
        return;
      }
      case "taskSelectorDays": {
        const n = parseInt(String(value), 10);
        if (!Number.isFinite(n) || n <= 0) return;
        settings.taskSelectorDays = n;
        break;
      }
      case "logFolderPath":
        settings.logFolderPath = String(value);
        break;
      case "autoOpenOnStartup":
        settings.autoOpenOnStartup = Boolean(value);
        break;
      case "showInStatusBar":
        await this.plugin.setStatusBarVisibility(Boolean(value));
        return;
      case "showDayNightIndicator":
        settings.showDayNightIndicator = Boolean(value);
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      case "showEndTime":
        settings.showEndTime = Boolean(value);
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      // The six station link/name rows are render rows on both paths now
      // (see musicLinkDefinitions / buildMusicUrlRow), so they own their reads
      // and writes and never come through here. Adding a case back would be
      // dead code that silently disagrees with the builder.
      case "showMusicPlayer":
        // The view-side reconciliation removes the iframe when this goes off —
        // that removal is what stops playback (no timer/engine side effect).
        settings.showMusicPlayer = Boolean(value);
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      case "musicLoop":
        // Loop is baked into the embed URL, so the view rebuilds the iframe
        // (stopping any current playback) when this flips.
        settings.musicLoop = Boolean(value);
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      case "musicResume":
        settings.musicResume = Boolean(value);
        // Turning it off drops every station's remembered position.
        // clearAllMusicPositions saves too, but only when there was something to
        // clear — so the save has to happen here unconditionally, or switching
        // this off with no position stored (a fresh install, or any time after
        // ⏹) would live in memory only and come back on at the next restart.
        if (!settings.musicResume) this.plugin.clearAllMusicPositions();
        await this.plugin.saveSettings();
        return;
      case "theme":
        settings.theme = value === "frosted-glass" ? "frosted-glass" : "classic";
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      case "longBreakMinutes": {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return;
        settings.longBreakMinutes = Math.floor(n);
        break;
      }
      case "longBreakEvery": {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1) return;
        settings.longBreakEvery = Math.floor(n);
        break;
      }
      case "dailyFocusGoalMinutes": {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return;
        settings.dailyFocusGoalMinutes = Math.floor(n);
        break;
      }
      case "goalNoticeEnabled":
        settings.goalNoticeEnabled = Boolean(value);
        break;
      case "incrementPomodoroCountOnFinish":
        settings.incrementPomodoroCountOnFinish = Boolean(value);
        break;
      default:
        return;
    }
    await this.plugin.saveSettings();
  }

  // Fallback for Obsidian < 1.13.0 (minAppVersion is below that). Never called
  // on 1.13+, where the tab renders declaratively from getSettingDefinitions()
  // — keep both paths in sync when adding or changing a setting.
  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const applySettingsToOpenViews = () => this.applySettingsToOpenViews();

    new Setting(containerEl).setName("Display & behavior").setHeading();

    new Setting(containerEl)
      .setName("Pomodoro logs folder")
      .setDesc("Folder to store daily log files (e.g., 'pomodoro_logs').")
      .addText((text) =>
        text
          .setPlaceholder("Example: pomodoro_logs")
          .setValue(this.plugin.settings.logFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.logFolderPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-open on startup")
      .setDesc("Open the view in the right panel when Obsidian starts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoOpenOnStartup).onChange(async (value) => {
          this.plugin.settings.autoOpenOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show status bar")
      .setDesc("Show the status bar indicator.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showInStatusBar).onChange(async (value) => {
          await this.plugin.setStatusBarVisibility(value);
        })
      );

    new Setting(containerEl).setName("Timer appearance").setHeading();

    new Setting(containerEl)
      .setName("Theme")
      .setDesc("Visual style for the timer.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("classic", "Classic")
          .addOption("frosted-glass", "Frosted glass")
          .setValue(this.plugin.settings.theme)
          .onChange(async (value) => {
            this.plugin.settings.theme = value as "classic" | "frosted-glass";
            await this.plugin.saveSettings();
            applySettingsToOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Day/night indicator")
      .setDesc("Show a subtle sun/moon indicator above the timer.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showDayNightIndicator).onChange(async (value) => {
          this.plugin.settings.showDayNightIndicator = value;
          await this.plugin.saveSettings();
          applySettingsToOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Show estimated end time")
      .setDesc("Show the projected finish time on the timer while a session is running.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showEndTime).onChange(async (value) => {
          this.plugin.settings.showEndTime = value;
          await this.plugin.saveSettings();
          applySettingsToOpenViews();
        })
      );

    new Setting(containerEl).setName("Music").setHeading();

    // Three link slots + their names, through the same builder the 1.13 path
    // uses — so the link check, the error line and the name prefill are
    // identical on both, and there is only one place to change them.
    for (let slot = 0; slot < MUSIC_STATION_LIMIT; slot++) {
      this.buildMusicUrlRow(
        new Setting(containerEl)
          .setName(`Music link ${String(slot + 1)}`)
          .setDesc(slot === 0 ? MUSIC_URL_DESC : MUSIC_URL_EXTRA_DESC),
        slot
      );
      this.buildMusicNameRow(
        new Setting(containerEl)
          .setName(`Name for link ${String(slot + 1)}`)
          .setDesc(MUSIC_NAME_DESC),
        slot
      );
    }

    new Setting(containerEl)
      .setName("Show music player")
      .setDesc("Show the music controls in the timer panel. Turning this off also stops playback.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showMusicPlayer).onChange(async (value) => {
          this.plugin.settings.showMusicPlayer = value;
          await this.plugin.saveSettings();
          applySettingsToOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Loop music")
      .setDesc(
        "Replay the video or playlist from the start when it ends. Live streams aren't affected. Changing this reloads the player."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.musicLoop).onChange(async (value) => {
          this.plugin.settings.musicLoop = value;
          await this.plugin.saveSettings();
          applySettingsToOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Resume where you left off")
      .setDesc(MUSIC_RESUME_DESC)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.musicResume).onChange(async (value) => {
          this.plugin.settings.musicResume = value;
          // Turning it off drops every station's remembered position. The save
          // is unconditional because clearAllMusicPositions only saves when
          // there was something to clear — see the declarative path's note.
          if (!value) this.plugin.clearAllMusicPositions();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Long break").setHeading();

    new Setting(containerEl)
      .setName("Long break duration (minutes)")
      .setDesc("Length of the long break that replaces a regular break.")
      .addText((text) =>
        text.setValue(this.plugin.settings.longBreakMinutes.toString()).onChange(async (value) => {
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.longBreakMinutes = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Long break frequency")
      .setDesc("Number of focus sessions before each long break (classic technique uses 4).")
      .addText((text) =>
        text.setValue(this.plugin.settings.longBreakEvery.toString()).onChange(async (value) => {
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n >= 1) {
            this.plugin.settings.longBreakEvery = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl).setName("Daily focus goal").setHeading();

    new Setting(containerEl)
      .setName("Daily focus goal (minutes)")
      .setDesc("Set to 0 to disable. The status bar shows today's progress against this goal.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.dailyFocusGoalMinutes.toString())
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n >= 0) {
              this.plugin.settings.dailyFocusGoalMinutes = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Goal-hit notice")
      .setDesc("Show a one-time notice when today's focus first crosses the daily goal.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.goalNoticeEnabled).onChange(async (value) => {
          this.plugin.settings.goalNoticeEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Task selector").setHeading();

    new Setting(containerEl)
      .setName("Tasks folder path")
      .setDesc(
        "Folder to search for tasks (e.g., 'daily notes'). Leave empty to search the entire vault."
      )
      .addText((text) =>
        text
          .setPlaceholder("Example: projects/active")
          .setValue(this.plugin.settings.tasksPath)
          .onChange(async (value) => {
            this.plugin.settings.tasksPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show task selector")
      .setDesc(
        "Show the task picker in the timer panel. Turning this off unlinks the current task."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showTaskSelector).onChange(async (value) => {
          this.plugin.settings.showTaskSelector = value;
          await this.plugin.saveSettings();
          if (!value && this.plugin.timer.currentTaskName !== NO_TASK_LABEL) {
            this.plugin.timer.setTask(NO_TASK_LABEL);
          }
          applySettingsToOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Task lookahead window")
      .setDesc(
        "How many days ahead the task selector shows scheduled/due tasks. Overdue tasks always appear."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("3", "3 Days")
          .addOption("5", "5 Days")
          .addOption("7", "7 Days")
          .addOption("14", "14 Days")
          .addOption("30", "30 Days")
          .setValue(this.plugin.settings.taskSelectorDays.toString())
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.taskSelectorDays = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl).setName("Task integration").setHeading();

    new Setting(containerEl)
      .setName("Increment task pomodoro count on finish")
      .setDesc(POMO_COUNT_TOGGLE_DESC)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.incrementPomodoroCountOnFinish)
          .onChange(async (value) => {
            this.plugin.settings.incrementPomodoroCountOnFinish = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(CHECK_MARKERS_NAME)
      .setDesc(CHECK_MARKERS_DESC)
      .addButton((btn) =>
        btn.setButtonText("Check").onClick(() => {
          void this.plugin.checkPomodoroMarkers();
        })
      );

    new Setting(containerEl)
      .setName(REPAIR_MARKERS_NAME)
      .setDesc(REPAIR_MARKERS_DESC)
      .addButton((btn) =>
        btn.setButtonText("Repair").onClick(() => {
          void this.plugin.repairPomodoroMarkers();
        })
      );

    new Setting(containerEl)
      .setName(REMOVE_MARKERS_NAME)
      .setDesc(REMOVE_MARKERS_DESC)
      .addButton((btn) => {
        btn.setButtonText("Remove").onClick(() => {
          void this.plugin.removeMisplacedPomodoroMarkers();
        });
        markDestructive(btn);
      });

    new Setting(containerEl)
      .setName(REMOVE_ALL_MARKERS_NAME)
      .setDesc(REMOVE_ALL_MARKERS_DESC)
      .addButton((btn) => {
        btn.setButtonText("Remove all").onClick(() => {
          void this.plugin.removeAllPomodoroMarkers();
        });
        markDestructive(btn);
      });
  }
}
