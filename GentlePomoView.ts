import { ItemView, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { THEME_IDS, resolveTheme, themeClass } from "./themes";
import { PIXEL_CITY_LAYERS } from "./pixelCityArt";
import type GentlePomoPlugin from "./main";
import type { TimerListener, TimerState } from "./types";
import { sessionEndSummary, type SessionEndEdge } from "./sessionEndSummary";

/**
 * The settings that live on BOTH the gear panel and the Obsidian settings tab.
 * Naming them as a union rather than plain strings is what stops the two
 * surfaces drifting: a key that exists on one and not the other is a compile
 * error, and `settings[key]` below stays type-checked.
 */
type SharedPanelKey =
  | "autoStartBreak"
  | "autoStartFocus"
  | "focusEndSoundEnabled"
  | "breakEndSoundEnabled";
import {
  DEFAULT_SETTINGS,
  VIEW_TYPE_GENTLE_POMO,
  NO_TASK_LABEL,
  ONE_MINUTE_MS,
  PEEK_REVEAL_MS,
  CAPTION_NAME_FADE_MS,
} from "./constants";
import { TimerEngine } from "./TimerEngine";
import { loadTasks as fetchTasks, groupTasksByDate } from "./taskLoader";
import {
  buildDayNightIcon,
  dayNightIconFor,
  skyPhase,
  buildMusicIcon,
  DAY_NIGHT_ICON_ORDER,
  type DayNightIcon,
} from "./icons";
import { MusicController, type MusicHost } from "./MusicController";
import type { MomentFactory } from "./momentTypes";
import {
  parseYouTubeUrl,
  buildEmbedUrl,
  planResume,
  MUSIC_STATION_LIMIT,
  resolveStationIndex,
  buildStationList,
  nextStationIndex,
} from "./youtubeMusic";

declare const moment: MomentFactory;

export class GentlePomoView extends ItemView {
  plugin: GentlePomoPlugin;
  timer: TimerEngine;
  timerShape!: HTMLDivElement;
  timerVisual!: HTMLDivElement;
  dayNightIndicator!: HTMLDivElement;
  private dayNightIconEls: Partial<Record<DayNightIcon, HTMLSpanElement>> = {};
  timeLabel!: HTMLDivElement;
  totalTimeLabel!: HTMLDivElement;
  modeLabel!: HTMLDivElement;
  endTimeLabel!: HTMLDivElement;
  goalProgressEl!: HTMLDivElement;
  settingsPanel!: HTMLDivElement;

  /**
   * Panel toggles that are ALSO reachable from the Obsidian settings tab, so
   * they have to follow a change made over there. Rebuilt by
   * renderSettingsPanel(); empty until the gear panel has been opened once,
   * which is why syncSettingsPanel() is a no-op loop rather than a guard.
   */
  private sharedPanelRows: {
    key: SharedPanelKey;
    row: HTMLElement;
    input: HTMLInputElement;
  }[] = [];

  /**
   * The plain-English outcome line under each pair of toggles. Re-worded by
   * syncSettingsPanel() whenever either of its two settings moves, from either
   * surface — which is the whole point of it: it has to be true right now, not
   * true when the panel was last opened.
   */
  private endSummaryLines: { edge: SessionEndEdge; el: HTMLElement }[] = [];
  settingsVisible = false;

  // Wrappers for animation
  adjustWrapper!: HTMLDivElement;
  secondaryControlsWrapper!: HTMLDivElement;

  // Task List Elements
  taskSelectorRow!: HTMLDivElement;
  taskListContainer!: HTMLDivElement;
  taskListVisible = false;
  taskBtn!: HTMLButtonElement;

  // Music (audio-only lofi playback; the YouTube iframe is a hidden audio engine)
  musicSection!: HTMLDivElement;
  private musicDivider!: HTMLDivElement;
  private musicSectionVisible = false; // mirrors musicSection's gp-hidden; feeds the divider rule
  private musicPlayBtn!: HTMLButtonElement;
  private musicPauseBtn!: HTMLButtonElement;
  private musicPlayerContainer!: HTMLDivElement; // visually-hidden iframe host
  // The frame itself stays here: the view is what owns DOM. Everything that
  // decides *what to do with it* lives in MusicController, reached through the
  // host object below.
  private musicIframe: HTMLIFrameElement | null = null;
  private readonly music: MusicController;

  private timerListener: TimerListener | null = null;
  private lastState: TimerState | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private peekTimeout: number | null = null;
  // Last countdown string rendered; used to skip the ~20Hz text/gradient writes on
  // ticks where the displayed second didn't change (avoids iPhone backdrop flicker).
  private lastTimeText: string | null = null;
  // Last end-time string rendered; gates the ~once/minute DOM write (mirrors lastTimeText).
  private lastEndText: string | null = null;
  // Music reconciliation guards (same write-guard family). lastMusicKey gates the
  // whole (toggle, url) reconcile to actual changes; lastMusicEmbedUrl and
  // lastMusicSourceUrl together gate iframe rebuilds (an offset no longer shows
  // up in the URL). Volume convergence is the controller's own bookkeeping.
  private lastMusicKey: string | null = null;
  private lastMusicEmbedUrl: string | null = null;
  private lastMusicSourceUrl: string | null = null;
  // The station picker's own repaint guard, deliberately separate from
  // lastMusicKey: names and inactive slots change what the buttons say without
  // changing what plays, and folding them into the embed key would reload the
  // player on a rename. Newline-delimited because names and URLs are free-form
  // and a printable separator could be typed into one, making two different
  // configurations compare equal — and a missed change here is a stale picker.
  private lastStationUiKey: string | null = null;
  private stationCaption: HTMLDivElement | null = null;
  private stationCaptionName: HTMLSpanElement | null = null;
  private stationCaptionTrack: HTMLSpanElement | null = null;
  private lastStationCaptionKey: string | null = null;
  private stationCaptionFullText = "";
  private nameSwapTimeout: number | null = null;
  private stationName = "";
  private stationListContainer: HTMLDivElement | null = null;
  private stationListBtn: HTMLButtonElement | null = null;
  private nextStationBtn: HTMLButtonElement | null = null;
  private musicVideoRow: HTMLDivElement | null = null;
  private stationRows: HTMLDivElement[] = [];
  private stationRowLabels: HTMLElement[] = [];
  private stationListVisible = false;

  constructor(leaf: WorkspaceLeaf, plugin: GentlePomoPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.timer = plugin.timer;
    this.music = new MusicController(this.createMusicHost());
  }

  getViewType(): string {
    return VIEW_TYPE_GENTLE_POMO;
  }

  getDisplayText(): string {
    return "Gentle pomodoro";
  }

  override getIcon(): string {
    return "clock";
  }

  override onOpen(): Promise<void> {
    const container = this.containerEl;
    container.empty();
    container.addClass("gp-root");

    // Toggle .gp-compact when the panel is a short, wide leaf (e.g. iPhone landscape),
    // measured directly off the panel element. We can't use viewport media queries
    // here: Obsidian's mobile webview doesn't expose reliable @media for this leaf.
    // ResizeObserver catches the leaf resize; the window "resize" listener is a
    // belt-and-suspenders catch for rotation. See updateCompactClass + styles.css.
    this.resizeObserver = new ResizeObserver(() => {
      this.updateCompactClass();
      // Whether the caption is cut depends on the panel's width, not its text.
      this.updateCaptionTooltip();
    });
    this.resizeObserver.observe(container);
    this.registerDomEvent(window, "resize", () => {
      this.updateCompactClass();
      this.updateCaptionTooltip();
    });

    // --- Timer Visual Area ---
    const visual = container.createDiv("gp-timer-visual");
    this.timerVisual = visual;

    // Tap-to-peek: touch devices have no hover, so tapping the shape reveals
    // the running countdown via the .gp-peek class — the touch equivalent of
    // the desktop hover reveal (see styles.css). Since there's no hover-out to
    // re-hide it, auto-hide after a short peek; each tap restarts the countdown.
    // Harmless on desktop, where the :hover rule drives the reveal instead.
    this.registerDomEvent(visual, "click", () => {
      visual.addClass("gp-peek");
      if (this.peekTimeout !== null) window.clearTimeout(this.peekTimeout);
      this.peekTimeout = window.setTimeout(() => {
        visual.removeClass("gp-peek");
        this.peekTimeout = null;
      }, PEEK_REVEAL_MS);
    });

    // Create Shape
    this.timerShape = visual.createDiv("gp-timer-shape");

    // Artwork nodes for EVERY theme are built once, here, and carry `gp-art`:
    // hidden by default in CSS, and each theme's own block shows only its own.
    // Create Layers in Order: Day -> Dusk -> Night
    this.timerShape.createDiv("gp-art gp-layer-day");
    this.timerShape.createDiv("gp-art gp-layer-dusk");
    this.timerShape.createDiv("gp-art gp-layer-night");

    // Frosted-glass theme layers (CSS-toggled per theme; built once here).
    const orbs = this.timerShape.createDiv("gp-art gp-glass-orbs");
    orbs.createDiv("gp-orb gp-orb-1");
    orbs.createDiv("gp-orb gp-orb-2");
    orbs.createDiv("gp-orb gp-orb-3");
    this.timerShape.createDiv("gp-art gp-glass-pane");
    this.timerShape.createDiv("gp-art gp-glass-highlight");

    // Pixel City: the bitmap plates (pixelCityArt.ts), bundled as data
    // URLs. Real <img> elements rather than background-images, so no style is
    // written from TypeScript and styles.css carries no base64. Hidden with
    // the rest of the artwork until the theme block shows them.
    for (const layer of PIXEL_CITY_LAYERS) {
      this.timerShape.createEl("img", {
        cls: `gp-art gp-pixel-city ${layer.cls}`,
        attr: { src: layer.src, alt: "", "aria-hidden": "true", draggable: "false" },
      });
    }

    const content = visual.createDiv("gp-timer-content");
    this.dayNightIndicator = content.createDiv("gp-daynight-indicator");
    this.dayNightIndicator.setAttribute("aria-hidden", "true");
    const badge = this.dayNightIndicator.createDiv("gp-daynight-badge");
    const iconStack = badge.createDiv("gp-daynight-icon-stack");

    DAY_NIGHT_ICON_ORDER.forEach((key) => {
      const iconEl = iconStack.createSpan({ cls: "gp-daynight-icon" });
      iconEl.appendChild(buildDayNightIcon(key));
      this.dayNightIconEls[key] = iconEl;
    });

    this.timeLabel = content.createDiv("gp-timer-time");
    this.totalTimeLabel = content.createDiv("gp-total-time");
    this.modeLabel = content.createDiv("gp-mode-label");
    this.endTimeLabel = content.createDiv("gp-end-time");

    // --- Controls ---
    const controls = container.createDiv("gp-controls");

    // ROW 1: Start, Pause, Stop, Reset, Skip
    const row1 = controls.createDiv("gp-controls-row");

    const startBtn = row1.createEl("button", { cls: "gp-btn gp-icon-btn gp-btn-primary" });
    setIcon(startBtn, "play");
    startBtn.setAttribute("aria-label", "Start");
    this.registerDomEvent(startBtn, "click", (evt) => {
      evt.preventDefault();
      this.timer.start();
    });

    const pauseBtn = row1.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(pauseBtn, "pause");
    pauseBtn.setAttribute("aria-label", "Pause");
    this.registerDomEvent(pauseBtn, "click", (evt) => {
      evt.preventDefault();
      this.timer.pause();
    });

    this.secondaryControlsWrapper = row1.createDiv("gp-animated-wrapper gp-secondary-controls");

    const stopBtn = this.secondaryControlsWrapper.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(stopBtn, "square");
    stopBtn.setAttribute("aria-label", "Finish & next");
    this.registerDomEvent(stopBtn, "click", (evt) => {
      evt.preventDefault();
      void this.timer.finish();
    });

    const resetBtn = this.secondaryControlsWrapper.createEl("button", {
      cls: "gp-btn gp-icon-btn",
    });
    setIcon(resetBtn, "rotate-ccw");
    resetBtn.setAttribute("aria-label", "Reset session");
    this.registerDomEvent(resetBtn, "click", (evt) => {
      evt.preventDefault();
      this.timer.reset();
    });

    const skipBtn = row1.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(skipBtn, "skip-forward");
    skipBtn.setAttribute("aria-label", "Skip to next");
    this.registerDomEvent(skipBtn, "click", (evt) => {
      evt.preventDefault();
      void this.timer.skip();
    });

    // ROW 2: -5m, +5m, Settings
    const row2 = controls.createDiv("gp-controls-row");

    this.adjustWrapper = row2.createDiv("gp-animated-wrapper gp-adjust-wrapper");

    const minusBtn = this.adjustWrapper.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(minusBtn, "minus");
    this.registerDomEvent(minusBtn, "click", (evt) => {
      evt.preventDefault();
      if (this.timer.getState().remainingMs > 5 * ONE_MINUTE_MS) {
        this.timer.addMinutes(-5);
      }
    });

    const plusBtn = this.adjustWrapper.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(plusBtn, "plus");
    this.registerDomEvent(plusBtn, "click", (evt) => {
      evt.preventDefault();
      this.timer.addMinutes(5);
    });

    const settingsBtn = row2.createEl("button", {
      cls: "gp-btn gp-icon-btn",
      // Seeded here rather than only in the handler, so the very first render
      // already says what the button does.
      attr: { "aria-expanded": "false" },
    });
    setIcon(settingsBtn, "settings");
    this.registerDomEvent(settingsBtn, "click", (evt) => {
      evt.preventDefault();
      this.settingsVisible = !this.settingsVisible;
      this.setSettingsPanelVisible(this.settingsVisible);
      settingsBtn.setAttribute("aria-expanded", this.settingsVisible ? "true" : "false");
      if (this.settingsVisible) {
        this.renderSettingsPanel();
        // Give the open transition a moment to start, then scroll the
        // panel into view so the user sees it without manual scrolling.
        window.setTimeout(() => {
          this.settingsPanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }, 50);
      }
    });

    // --- Settings Panel ---
    // `inert` is SEEDED at construction, not left to the first toggle. The
    // panel is populated unconditionally with about a dozen controls,
    // including "Reset to defaults", and it is hidden by max-height: 0 — which
    // removes nothing from the tab order. Before 0.6.1 you could Tab straight
    // into an invisible settings panel and press Enter on a reset button you
    // could not see.
    this.settingsPanel = controls.createDiv("gp-settings-panel");
    this.settingsPanel.toggleAttribute("inert", true);
    this.renderSettingsPanel();

    // ROW 3: Task Selector
    const row3 = controls.createDiv("gp-controls-row");
    this.taskSelectorRow = row3;
    this.taskBtn = row3.createEl("button", { cls: "gp-btn gp-btn-full" });

    const btnLabel = this.taskBtn.createDiv("gp-task-btn-label");
    btnLabel.setText("Current task");

    const btnText = this.taskBtn.createDiv("gp-task-btn-text");
    btnText.setText("Select a task...");

    this.registerDomEvent(this.taskBtn, "click", () => {
      this.taskListVisible = !this.taskListVisible;
      if (this.taskListVisible) {
        this.setStationListVisible(false);
        this.taskListContainer.addClass("gp-visible");
        this.taskListContainer.toggleAttribute("inert", false);
        void this.loadTasks();
      } else {
        this.taskListContainer.removeClass("gp-visible");
        this.taskListContainer.toggleAttribute("inert", true);
      }
    });

    // --- Task List Container ---
    this.taskListContainer = controls.createDiv("gp-task-list", (el) => {
      el.setAttribute("role", "listbox");
      el.setAttribute("aria-label", "Tasks");
      // Seeded closed, for the same reason as the settings panel above.
      el.toggleAttribute("inert", true);
    });
    // ONE delegated handler, registered once, rather than a listener per row.
    // loadTasks() rebuilds every row on each open and Component.registerDomEvent
    // releases on unload rather than on removal, so a per-row listener would
    // accumulate against detached nodes for the life of the session. Dispatching
    // the element's own click keeps activation on exactly the path the mouse
    // uses, so the two can never diverge.
    this.registerDomEvent(this.taskListContainer, "keydown", (evt: KeyboardEvent) => {
      if (evt.key !== "Enter" && evt.key !== " ") return;
      // closest() rather than instanceof: an Obsidian pop-out window is a
      // different realm, where `instanceof HTMLElement` is false and the rows
      // would silently stop responding.
      const row = (evt.target as Element | null)?.closest<HTMLElement>(".gp-task-item");
      if (!row || !this.taskListContainer.contains(row)) return;
      // Space would scroll the panel out from under the list.
      evt.preventDefault();
      row.click();
    });

    // --- Music (audio-only lofi playback) ---
    // Hairline between the task selector and the music row. Reconciled in
    // applySettings — visible only when both neighbors are visible, so it
    // never dangles under a hidden selector or above a hidden music row.
    this.musicDivider = controls.createDiv("gp-music-divider");

    // The ▶️ row is the only playback UI — the YouTube iframe below is a
    // visually-hidden audio engine (see .gp-music-player in styles.css). The
    // iframe itself is (re)built in applySettings(), which reconciles the
    // showMusicPlayer/musicUrl settings against the DOM.
    this.musicSection = controls.createDiv("gp-music-section");

    // What is playing, as one quiet line above the transport. Deliberately not
    // a control: the list button below opens the picker, so making this
    // clickable too would be a second, heavier affordance for the same thing.
    this.stationCaption = this.musicSection.createDiv("gp-station-current");
    // Both words exist at once and hand over in sequence (see the CSS): the
    // arriving one's transition is delayed by the departing one's duration, so
    // they never overlap, and no timer is involved. Width rides max-width with
    // both words in flow, so the label is only ever as wide as what it says.
    const captionLabel = this.stationCaption.createSpan("gp-station-current-label");
    captionLabel.createSpan({ cls: "gp-station-label-idle", text: "Music" });
    captionLabel.createSpan({ cls: "gp-station-label-playing", text: "Now playing" });
    this.stationCaptionName = this.stationCaption.createSpan("gp-station-current-name");
    this.stationCaptionTrack = this.stationCaption.createSpan("gp-station-current-track gp-hidden");
    // The label's own width eases over --gp-caption-fade, so the measurement
    // taken when the text changed read the BEFORE width. Re-measure when the
    // width has actually settled. The transitions are on the child spans and
    // bubble; under prefers-reduced-motion no event fires, which is right —
    // with no transition the synchronous read already saw the final width.
    this.registerDomEvent(this.stationCaption, "transitionend", (evt: TransitionEvent) => {
      if (evt.propertyName !== "max-width") return;
      this.updateCaptionTooltip();
    });

    const musicRow = this.musicSection.createDiv("gp-controls-row");

    // The only way to open the picker — the caption above is a label, not a
    // control. Shown once there is a choice to make; with one link it would be
    // a control that changes nothing.
    this.stationListBtn = musicRow.createEl("button", {
      cls: "gp-btn gp-icon-btn gp-hidden",
      attr: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" },
    });
    this.stationListBtn.appendChild(buildMusicIcon("station-list"));
    this.stationListBtn.setAttribute("aria-label", "Show music links");
    this.registerDomEvent(this.stationListBtn, "click", (evt) => {
      evt.preventDefault();
      this.toggleStationList();
    });

    this.musicPlayBtn = musicRow.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(this.musicPlayBtn, "play");
    this.musicPlayBtn.setAttribute("aria-label", "Play music");
    this.registerDomEvent(this.musicPlayBtn, "click", (evt) => {
      evt.preventDefault();
      this.music.pressPlay();
    });

    this.musicPauseBtn = musicRow.createEl("button", { cls: "gp-btn gp-icon-btn gp-hidden" });
    setIcon(this.musicPauseBtn, "pause");
    this.musicPauseBtn.setAttribute("aria-label", "Pause music");
    this.registerDomEvent(this.musicPauseBtn, "click", (evt) => {
      evt.preventDefault();
      this.music.pressPause();
    });

    const musicStopBtn = musicRow.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(musicStopBtn, "square");
    musicStopBtn.setAttribute("aria-label", "Stop music");
    this.registerDomEvent(musicStopBtn, "click", (evt) => {
      evt.preventDefault();
      this.music.pressStop();
    });

    // ⏭ next link. Hidden below two links, like the list button.
    this.nextStationBtn = musicRow.createEl("button", {
      cls: "gp-btn gp-icon-btn gp-hidden",
      attr: { type: "button" },
    });
    // The same glyph the timer's "Skip to next" button uses, deliberately: both
    // mean "move on to the next one", and two near-identical hand-drawn
    // variants of that idea in one panel read as a mistake.
    setIcon(this.nextStationBtn, "skip-forward");
    this.nextStationBtn.setAttribute("aria-label", "Next music link");
    this.registerDomEvent(this.nextStationBtn, "click", (evt) => {
      evt.preventDefault();
      // Keep playing only if something is audibly playing right now — or if a
      // previous press is still waiting for its player. Without the second
      // clause, tapping through 1→2→3 to find a station ends in silence: press
      // two sees a player that has not finished loading and reads it as stopped.
      void this.nextMusicStation(this.music.isPlayingForUser() || this.music.handOffPending);
    });

    // Playlist transport, on its own row so the first one keeps its four
    // controls at a comfortable size in a 260px column. The whole row animates
    // in and out, since it only applies to a playlist.
    this.musicVideoRow = this.musicSection.createDiv(
      "gp-controls-row gp-music-video-row gp-hidden-animated"
    );

    const prevVideoBtn = this.musicVideoRow.createEl("button", {
      cls: "gp-btn gp-icon-btn",
      attr: { type: "button" },
    });
    // The same artwork as ⏩, mirrored in CSS rather than drawn again: a
    // reflection preserves stroke length, so the pair cannot drift in weight.
    const prevIcon = buildMusicIcon("next-video");
    prevIcon.addClass("gp-icon-flip-x");
    prevVideoBtn.appendChild(prevIcon);
    prevVideoBtn.setAttribute("aria-label", "Previous video in playlist");
    this.registerDomEvent(prevVideoBtn, "click", (evt) => {
      evt.preventDefault();
      this.music.stepPlaylist("previousVideo");
    });

    const nextVideoBtn = this.musicVideoRow.createEl("button", {
      cls: "gp-btn gp-icon-btn",
      attr: { type: "button" },
    });
    nextVideoBtn.appendChild(buildMusicIcon("next-video"));
    nextVideoBtn.setAttribute("aria-label", "Next video in playlist");
    this.registerDomEvent(nextVideoBtn, "click", (evt) => {
      evt.preventDefault();
      this.music.stepPlaylist("nextVideo");
    });

    // The link list, below the button that opens it. Built once — every slot's
    // row exists from the start and is only ever re-labelled or hidden, never
    // re-created, because the pre-1.13 settings path commits on every keystroke
    // and a rebuild-per-reconcile would leak a detached row (and its listener,
    // which Component.registerDomEvent releases on unload rather than on
    // removal) for every character typed into a URL.
    //
    // Selecting is all a row does: it never starts playback, so picking a
    // station cannot surprise the user with sound. ⏭ is the one exception, and
    // it carries its own explicit opt-in.
    this.stationListContainer = this.musicSection.createDiv({
      cls: "gp-task-list gp-station-list",
      // `inert` is seeded HERE, not left to setStationListVisible. That method
      // early-returns when the value is unchanged, and stationListVisible starts
      // false — so a closing call is a no-op, and with two links and the player
      // on, neither of its conditional call sites is reached at all. The closed
      // list would keep its rows in the tab order until the user opened it once,
      // i.e. the attribute armed only after the action it exists to guard.
      // Seeded false-y the same way aria-expanded already is on the button.
      attr: { role: "listbox", "aria-label": "Music links", inert: "" },
    });
    for (let slot = 0; slot < MUSIC_STATION_LIMIT; slot++) {
      // A div, not a <button>, and that is the whole reason the rows look right:
      // Obsidian's own button styling is more specific than a plain class reset,
      // so a <button> here kept a filled background in dark mode and swallowed
      // the hover. The task list is built from divs; matching it exactly is the
      // only way the two lists cannot diverge. Keyboard operability is put back
      // by hand below, which the task list itself still lacks.
      const row = this.stationListContainer.createDiv({
        cls: "gp-task-item gp-station-item gp-hidden",
        attr: { role: "option", "aria-selected": "false", tabindex: "0" },
      });
      // Label and tick are separate children so relabelling never has to clear
      // the row (setText on the row itself would drop the icon).
      // Held rather than re-found: a querySelector result is typed Element, and
      // `instanceof HTMLElement` is false in an Obsidian pop-out window, whose
      // document is a different realm — the rows would render blank there, with
      // nothing logged. (The repo's prefer-instanceof lint rule does not catch
      // it: a union operand type defeats its check.)
      this.stationRowLabels.push(row.createSpan("gp-station-item-label"));
      setIcon(row.createDiv("gp-task-check-icon"), "check");
      this.stationRows.push(row);
      const choose = () => {
        // Close first, synchronously. selectMusicStation awaits saveSettings and
        // then fans out through applySettingsToOpenViews, which re-enters
        // applySettings on this very view — closing afterwards would be racing
        // a reconcile that has already repainted the row under this handler.
        this.setStationListVisible(false);
        // The row that was activated is now inside an inert container, so focus
        // would be dropped to the document. Put it back on the control that
        // opened the list.
        this.stationListBtn?.focus();
        void this.selectMusicStation(slot);
      };
      this.registerDomEvent(row, "click", (evt) => {
        evt.preventDefault();
        choose();
      });
      this.registerDomEvent(row, "keydown", (evt: KeyboardEvent) => {
        if (evt.key !== "Enter" && evt.key !== " ") return;
        // Space would scroll the panel out from under the list.
        evt.preventDefault();
        choose();
      });
    }

    this.musicPlayerContainer = this.musicSection.createDiv("gp-music-player");

    // The embed talks back over the shared window message bus. Only messages
    // from *our* frame get through; the controller checks the origin against
    // its allowlist and learns the origin to address commands to from it.
    this.registerDomEvent(window, "message", (evt: MessageEvent) => {
      if (!this.musicIframe || evt.source !== this.musicIframe.contentWindow) return;
      this.music.handleFrameMessage(evt.origin, evt.data);
    });

    // Daily-goal progress. Hidden on desktop via CSS (the status bar carries it
    // there); revealed on mobile, where Obsidian hides the status bar. Populated by
    // the plugin via refreshViewGoalProgress() — once now (so it shows immediately,
    // even idle) and again on every timer tick (in timerListener below). Driving it
    // from the view's own subscription rather than the status-bar update path is what
    // makes it appear on mobile, where the status bar (and its update loop) is absent.
    this.goalProgressEl = container.createDiv("gp-goal-progress");
    this.plugin.refreshViewGoalProgress(this);

    // (Control-button glyph sizing — including the iPad min-width floor — lives in
    // styles.css; see the `.gp-icon-btn svg.svg-icon` rule in the Mobile & touch section.)

    // --- State Updates ---
    this.timerListener = (state) => {
      this.lastState = state;
      this.applySettings();
      this.plugin.refreshViewGoalProgress(this, state);

      if (state.isRunning) {
        startBtn.addClass("gp-hidden");
        pauseBtn.removeClass("gp-hidden");
        this.setSecondaryControlsHidden(false);
      } else {
        startBtn.removeClass("gp-hidden");
        pauseBtn.addClass("gp-hidden");
        this.setSecondaryControlsHidden(state.remainingMs === state.totalMs);
      }

      if (state.remainingMs <= 5 * ONE_MINUTE_MS) {
        minusBtn.setAttribute("disabled", "true");
        minusBtn.addClass("gp-btn-disabled");
      } else {
        minusBtn.removeAttribute("disabled");
        minusBtn.removeClass("gp-btn-disabled");
      }

      const isOvertime = state.remainingMs < 0;

      visual.toggleClass("gp-state-overtime", isOvertime);
      visual.toggleClass("gp-mode-focus", state.mode === "focus");
      visual.toggleClass("gp-mode-break", state.mode === "break");

      const absMs = Math.abs(state.remainingMs);
      const totalSec = Math.ceil(absMs / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;

      let timeText = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
      if (isOvertime) {
        timeText = "+" + timeText;
        this.timeLabel.addClass("gp-overtime");
      } else {
        this.timeLabel.removeClass("gp-overtime");
      }

      this.modeLabel.setText(state.mode === "focus" ? "Focus" : "Rest");
      visual.toggleClass("gp-state-running", state.isRunning);

      const textEl = this.taskBtn.querySelector(".gp-task-btn-text");
      if (textEl) {
        if (state.taskName === NO_TASK_LABEL) {
          textEl.setText("Select a task...");
        } else {
          textEl.setText(state.taskName);
        }
      }

      // The timer ticks every 50ms (see TimerEngine), but the displayed second — and
      // the gradient driven off it — only changes ~1×/sec. Writing the countdown text
      // and the gradient CSS variables on every tick makes the frosted-glass
      // backdrop-filter re-blur ~20×/sec, which flickers on iPhone. Gate those writes
      // on the second actually changing; the 0.8s CSS transitions bridge the steps.
      if (timeText !== this.lastTimeText) {
        this.lastTimeText = timeText;

        this.timeLabel.setText(timeText);
        if (isOvertime) {
          const actualTotalMs = state.totalMs + absMs;
          const tSec = Math.floor(actualTotalMs / 1000);
          const tM = Math.floor(tSec / 60);
          const tS = tSec % 60;
          this.totalTimeLabel.setText(`Total: ${tM}:${tS.toString().padStart(2, "0")}`);
        } else {
          this.totalTimeLabel.setText("");
        }

        // --- Gradient Transition Logic ---
        // skyPhase() is shared with the day/night badge (icons.ts). Deriving it
        // twice is what let the badge run a whole phase behind the artwork.
        const phase = skyPhase(state);

        let duskOpacity = 0;
        let nightOpacity = 0;
        if (phase < 0.5) {
          duskOpacity = phase * 2;
          nightOpacity = 0;
        } else {
          duskOpacity = 1;
          nightOpacity = (phase - 0.5) * 2;
        }
        visual.style.setProperty("--gp-dusk-opacity", duskOpacity.toString());
        visual.style.setProperty("--gp-night-opacity", nightOpacity.toString());
        // Consumed by frosted-glass orb color-mix() in styles.css. Uses skyPhase
        // (not raw progress) so orbs warm→cool on focus and cool→warm on break,
        // matching the classic theme's narrative arc.
        visual.style.setProperty("--gp-progress", phase.toString());
      }
    };

    this.plugin.timer.onChange(this.timerListener);
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    if (this.timerListener) {
      this.plugin.timer.offChange(this.timerListener);
      this.timerListener = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.peekTimeout !== null) {
      window.clearTimeout(this.peekTimeout);
      this.peekTimeout = null;
    }
    // The iframe would die with the view DOM anyway, but explicit teardown
    // clears the pending handshake timeout and nulls the refs.
    this.music.destroy();
    // After the teardown, not before: the teardown drops the track title
    // and re-renders the caption, which arms a fresh swap timer. Clearing first
    // made this a no-op in exactly the case it was written for. Not moved into
    // the controller's destroy() itself — that also runs on a live station
    // switch, where the pending swap is the animation we want.
    if (this.nameSwapTimeout !== null) {
      window.clearTimeout(this.nameSwapTimeout);
      this.nameSwapTimeout = null;
    }
    return Promise.resolve();
  }

  /**
   * Add .gp-compact to the panel when it's a short, wide leaf (e.g. iPhone
   * landscape), so styles.css can shrink + un-pin the timer. Detection keys off the
   * panel's measured *aspect ratio* (wider than tall) rather than an absolute height
   * threshold — Obsidian's mobile webview reports unreliable viewport state, and an
   * earlier `< 480px` height guess never matched. `h < 600` still excludes iPad
   * landscape (~760px+); `Platform.isMobile` keeps desktop out. Measured off the real
   * panel element, not a media query.
   */
  private updateCompactClass() {
    const w = this.containerEl.clientWidth;
    const h = this.containerEl.clientHeight;
    const compact = Platform.isMobile && h < w && h < 600;
    this.containerEl.toggleClass("gp-compact", compact);
  }

  /**
   * Update the in-view daily-goal progress line. Called from main.ts alongside
   * the status-bar update so mobile (no status bar) still sees goal progress.
   * The element is hidden on desktop via CSS, so this is a cheap no-op there.
   */
  setGoalProgress(text: string, met: boolean) {
    if (!this.goalProgressEl) return;
    this.goalProgressEl.setText(text);
    this.goalProgressEl.toggleClass("gp-goal-met", met);
  }

  applySettings() {
    // Driven by the registry, so a new theme needs no change here. resolveTheme
    // rather than a comparison: artwork is opt-in per theme since 0.6.0, so an
    // id matching no theme would leave the square empty — before that it fell
    // through to classic's unscoped rules and the damage was invisible.
    const theme = resolveTheme(this.plugin.settings.theme);
    for (const id of THEME_IDS) {
      this.containerEl.toggleClass(themeClass(id), id === theme);
    }

    const state = this.lastState ?? this.timer.getState();

    // Follow settings changed on the OTHER surface. Cheap: a handful of
    // property writes over rows that already exist, no allocation, no listener
    // churn. See syncSettingsPanel for why this must not re-render.
    this.syncSettingsPanel();

    // Task-selector visibility. Idempotent, so safe to run on every tick. The
    // unlink-on-hide side effect lives in the settings toggle's onChange (calling
    // setTask here would fire every tick); on load no task is ever pre-linked.
    const showSelector = this.plugin.settings.showTaskSelector;
    this.taskSelectorRow?.toggleClass("gp-hidden", !showSelector);
    this.taskListContainer?.toggleClass("gp-hidden", !showSelector);
    if (!showSelector && this.taskListVisible) {
      this.taskListVisible = false;
      this.taskListContainer.removeClass("gp-visible");
      this.taskListContainer.toggleAttribute("inert", true);
    }

    // Station picker reconciliation. Separate from the embed reconcile below and
    // running first, so an edit to ANY slot is retired before the plan for the
    // active one is worked out. The embed key only moves when the *active* URL
    // changes, so it would never notice a slot the user is not listening to.
    const stationUrls = this.plugin.musicStationUrls();
    const stationNames = [
      this.plugin.settings.musicName1,
      this.plugin.settings.musicName2,
      this.plugin.settings.musicName3,
    ];
    const activeSlot = resolveStationIndex(stationUrls, this.plugin.settings.musicStationIndex);
    const stationUiKey = [
      this.plugin.settings.showMusicPlayer ? "1" : "0",
      String(activeSlot),
      ...stationUrls,
      ...stationNames,
    ].join("\n");
    if (stationUiKey !== this.lastStationUiKey) {
      this.lastStationUiKey = stationUiKey;
      // Heals the selected slot and drops positions belonging to links no slot
      // holds any more. Idempotent and write-free unless something actually
      // changed, which is what makes it safe to call from every open view.
      this.plugin.reconcileMusicStations();
      const rows = buildStationList(stationUrls, stationNames, activeSlot);
      // Rows are positional — row N is always slot N — so an empty slot keeps
      // its (hidden) row rather than shifting the ones after it. buildStationList
      // returns filled slots only, hence the lookup by slot rather than by index.
      for (let slot = 0; slot < this.stationRows.length; slot++) {
        const row = this.stationRows[slot];
        if (!row) continue;
        const entry = rows.find((candidate) => candidate.slot === slot) ?? null;
        row.toggleClass("gp-hidden", entry === null);
        row.toggleClass("gp-task-selected", entry?.active === true);
        row.setAttribute("aria-selected", entry?.active === true ? "true" : "false");
        this.stationRowLabels[slot]?.setText(entry?.label ?? "");
        // The full link lives in the tooltip: a name is optional, and a URL is
        // far too long to render in a narrow sidebar. Deliberately `title` and
        // not `aria-label` — the latter REPLACES the accessible name, so a
        // screen reader would announce a 60-character URL instead of the
        // station's name.
        if (entry === null) row.removeAttribute("title");
        else row.setAttribute("title", entry.url);
      }
      const activeEntry = rows.find((candidate) => candidate.active) ?? null;
      this.stationName = activeEntry?.label ?? "";
      this.renderStationCaption();
      // With one link there is nothing to switch between, so the shortcut button
      // would be a control that changes nothing. The box above still names what
      // is playing, which is the part that has to survive at any count.
      const multi = rows.length > 1;
      this.stationListBtn?.toggleClass("gp-hidden", !multi);
      this.nextStationBtn?.toggleClass("gp-hidden", !multi);
      // A list left open under a picker that just lost its choices would spring
      // back open the next time the section is shown.
      if (!multi) this.setStationListVisible(false);
    }

    // Music player reconciliation. Runs here so the per-tick call and the settings
    // tab's applySettingsToOpenViews() converge on the same DOM. The lastMusicKey
    // string guard keeps the ~20Hz hot path to one concat + compare — the URL is
    // only parsed when the (toggle, loop, url) triple actually changes. Removing
    // the iframe is what stops playback, which implements "toggle off = hide + stop".
    // Loop is baked into the embed URL, so flipping it rebuilds the iframe too.
    // Only the ACTIVE station's URL is in this key. Names are display-only and
    // the inactive slots do not affect playback, so neither may appear here —
    // renaming a station or editing a slot you are not listening to must never
    // reload the player. The station picker's own repaint is gated separately,
    // by lastStationUiKey below.
    const activeMusicUrl = this.plugin.activeMusicUrl();
    const musicKey = `${this.plugin.settings.showMusicPlayer ? "1" : "0"}|${this.plugin.settings.musicLoop ? "1" : "0"}|${activeMusicUrl}`;
    if (musicKey !== this.lastMusicKey) {
      this.lastMusicKey = musicKey;
      // Parsed once per key change, and kept separate from the visibility
      // toggle: `parsed` answers "is this a URL yet?", `target` answers "is
      // there anything to embed right now?". Conflating them made the retire
      // below follow the toggle — every URL edit made while the player was
      // hidden kept its old position, so hiding the player quietly changed what
      // an edit meant.
      const parsed = parseYouTubeUrl(activeMusicUrl);
      const target = this.plugin.settings.showMusicPlayer ? parsed : null;
      // Retiring an edited link's position is NOT done here any more — it moved
      // to the station block above, which sees every slot rather than only the
      // active one, and which runs first so an edit is still honoured on the
      // very rebuild it triggers. planResume's own URL check remains the last
      // line of defence either way.
      //
      // Work out the remembered position here, at build time — deliberately NOT
      // part of musicKey, since keying on a value that moves every second would
      // rebuild the iframe ~20×/sec. The offset is carried as a pending seek,
      // not baked into the URL, so the embed stays exactly what 0.5.2 built.
      // While a ⏹ is pending, plan as if the store were already empty: its
      // clearMusicPosition rides in the fade landing, and a rebuild inside that
      // window (flipping Loop, say) would otherwise snapshot the position the
      // stop is in the middle of forgetting and seed the new iframe with it.
      //
      // But the pending stop belongs to the OUTGOING station only — musicStopPending
      // is set on the ⏹ click and not cleared until destroyMusicIframe (below) or
      // the embed reports the halt, both of which run *after* this plan is worked
      // out. A station switch inside that window therefore used to plan the
      // INCOMING station against an empty store, opening it from the top and then
      // overwriting the position it should have resumed. Scope the suppression to
      // the station the stop is actually for; musicSourceUrl is that station,
      // frozen at build time. (Trim-tolerant via the shared helper: data.json is
      // hand-editable.) The window is longer than the fade — a stop landing on a
      // still-running player keeps the flag up until the halt is reported.
      const stopSuppressesResume = this.music.stopSuppressesResumeFor(activeMusicUrl);
      const plan = target
        ? planResume(
            target,
            stopSuppressesResume ? null : this.plugin.musicResumeState(activeMusicUrl),
            activeMusicUrl
          )
        : null;
      const embedUrl = plan ? buildEmbedUrl(plan.target, this.plugin.settings.musicLoop) : null;
      // The URL *setting* this build comes from, tracked alongside the embed URL
      // in the rebuild decision because no offset reaches the embed URL any
      // more: editing only a t= leaves the built URL byte-identical, and the
      // embed URL alone would skip the rebuild and drop the fresh seek on the
      // floor. Keying on the seek instead is not enough — a new t= that happens
      // to equal the offset the last build used compares equal too, which is the
      // same failure one step removed. Null when nothing is embedded, so a view
      // that has never had a player doesn't rebuild on its first tick. Bounded
      // by the musicKey guard, so it can only fire on a real edit.
      const sourceUrl = embedUrl === null ? null : activeMusicUrl;
      // Visible whenever a link is configured — deliberately NOT `embedUrl !==
      // null`, which would hide the whole section, picker included, exactly when
      // a station whose link does not parse needs switching away from.
      // resolveStationIndex falls back to the first filled slot, so an empty
      // active URL means every slot is empty; both inputs are therefore part of
      // musicKey and this can never be left stale inside the guard.
      this.musicSectionVisible =
        this.plugin.settings.showMusicPlayer && activeMusicUrl.trim() !== "";
      this.musicSection?.toggleClass("gp-hidden", !this.musicSectionVisible);
      // ⏩ belongs to a real playlist only. Read from the PARSED URL's list=,
      // never from the message stream: with Loop on, buildEmbedUrl gives a plain
      // single video a `playlist=<its own id>` param (YouTube's quirk — loop
      // needs one), so the embed then reports a one-item playlist and the button
      // would appear on every looped video and merely restart the track. Sitting
      // inside the musicKey guard is what keeps it fresh: both the URL and the
      // loop flag are already in that key.
      // gp-hidden-animated, not gp-hidden: display:none cannot animate, and this
      // row is meant to ease in and out the way the session controls do.
      this.musicVideoRow?.toggleClass("gp-hidden-animated", parsed?.playlistId == null);
      // gp-hidden-animated collapses and fades but does NOT remove the row from
      // the tab order, and pointer-events does not gate Enter on a focused
      // button. Without this, Tab reaches two invisible controls that skip
      // tracks or pop a Notice. (The old gp-hidden was display:none, which did.)
      this.musicVideoRow?.toggleAttribute("inert", parsed?.playlistId == null);
      // Same reason the task selector clears its own flag when hidden: a list
      // left open behind a hidden section reappears with it.
      if (!this.musicSectionVisible) this.setStationListVisible(false);
      // Now that the section has a layout again, whatever was measured while it
      // was hidden (and skipped) can finally be resolved.
      else this.updateCaptionTooltip();
      if (embedUrl !== this.lastMusicEmbedUrl || sourceUrl !== this.lastMusicSourceUrl) {
        this.lastMusicEmbedUrl = embedUrl;
        this.lastMusicSourceUrl = sourceUrl;
        this.music.destroy();
        if (embedUrl !== null && plan !== null) {
          this.music.build(embedUrl, plan, activeMusicUrl);
        }
      }
    }
    // Outside the station guard: the caption's wording follows playback, which
    // changes without any settings key moving. Its own key keeps this to one
    // concat and one compare on the ~20Hz path.
    this.renderStationCaption();
    // The task-selector/music divider needs both neighbors visible. Outside the
    // musicKey guard because showTaskSelector can change independently of it.
    this.musicDivider?.toggleClass("gp-hidden", !showSelector || !this.musicSectionVisible);
    // Volume convergence (settings changed from another view or a reload while
    // the player was still booting). No-op per tick once applied.
    this.music.syncVolume();

    // Estimated end time. Shown only while running and before overtime — a static
    // "you'll finish at 15:30", the calm counterpart to the hidden countdown.
    // Driven from here (not just the tick listener, which calls applySettings) so
    // toggling the setting updates open views at once; the lastEndText guard keeps
    // the DOM write to ~once/minute. See formatEndTime for the day-rollover suffix.
    if (this.endTimeLabel) {
      const showEnd = this.plugin.settings.showEndTime && state.isRunning && state.remainingMs > 0;
      this.endTimeLabel.toggleClass("gp-visible", showEnd);
      if (showEnd) {
        const endText = this.formatEndTime(Date.now() + state.remainingMs);
        if (endText !== this.lastEndText) {
          this.lastEndText = endText;
          this.endTimeLabel.setText(endText);
        }
      } else {
        this.lastEndText = null;
      }
    }

    if (!this.dayNightIndicator) return;
    const enabled = this.plugin.settings.showDayNightIndicator;
    this.dayNightIndicator.toggleClass("gp-hidden", !enabled);
    if (!enabled) return;

    const icon = dayNightIconFor(state);
    for (const key of DAY_NIGHT_ICON_ORDER) {
      this.dayNightIconEls[key]?.toggleClass("is-active", key === icon);
    }
  }

  /**
   * ⏭: move to the next slot holding a link, wrapping and stepping over empty
   * ones. `continuePlayback` carries the music across the switch — see
   * MusicController.armHandOff for why that is a hand-off to the newly built
   * player rather than a fade across the gap.
   */
  private async nextMusicStation(continuePlayback: boolean): Promise<void> {
    const urls = this.plugin.musicStationUrls();
    // Step from the RESOLVED slot: the stored index is only a preference, and
    // stepping from a stale one can land on the slot already playing, where
    // selectMusicStation's "already selected" early return swallows the press.
    const from = resolveStationIndex(urls, this.plugin.settings.musicStationIndex);
    const to = nextStationIndex(urls, from);
    if (to === from) return;
    // Captured before the settings write, which is a real file write a ⏸ or ⏹
    // can land inside — the controller decides on the way out whether the press
    // still means anything.
    const handOff = this.music.snapshotHandOff();
    await this.selectMusicStation(to);
    if (!continuePlayback) return;
    this.music.armHandOff(handOff);
  }

  /**
   * Paint the "Now playing" line: the station's own name, plus the track the
   * embed is actually on when the station is a playlist (a playlist moves
   * between items under one unchanged link, so its name alone stops being an
   * answer to "what is this?"). A plain video is its own track, so naming it
   * twice would just be noise.
   *
   * Guarded by its own key because the title arrives on the ~4Hz info stream:
   * without it this would rewrite the DOM several times a second.
   */
  private renderStationCaption() {
    const track = this.music.playlistId !== null ? (this.music.videoTitle ?? "") : "";
    // "Now playing" only while it is true. Picking a station does not start it,
    // so the idle line names what ▶️ would play rather than claiming it already
    // is. Read from the transport's own state rather than recomputed, so the
    // wording and the ▶️/⏸ button can never disagree — and so it does not
    // depend on the timer ticking (the engine is silent while no session runs,
    // which is exactly when someone is most likely to be only playing music).
    const playing = this.music.showingAsPlaying;
    const key = `${playing ? "1" : "0"}\n${this.stationName}\n${track}`;
    if (key === this.lastStationCaptionKey) return;
    this.lastStationCaptionKey = key;
    // The wording is two fixed words, so it hands over in pure CSS (see the
    // label rules). The names are arbitrary strings, which cannot be
    // pre-rendered that way — they dip out, change while invisible, and come
    // back, which is the one place a timer earns its keep here.
    this.stationCaption?.toggleClass("is-playing", playing);
    this.stationCaptionFullText = [playing ? "Now playing" : "Music", this.stationName, track]
      .filter((part) => part !== "")
      .join("  |  ");
    this.writeStationNames(this.stationName, track);
    // Nothing to announce at all: no station selected.
    this.stationCaption?.toggleClass("gp-hidden", this.stationName === "");
  }

  /**
   * Put the station and track names on screen, dipping them out and back when
   * they actually change so a switch or a playlist advance does not snap.
   *
   * Skipped — written straight through — on the first paint, when only the
   * wording changed, and under prefers-reduced-motion, where a fade the user
   * asked not to see would just make the text arrive late.
   */
  private writeStationNames(name: string, track: string) {
    const nameEl = this.stationCaptionName;
    const trackEl = this.stationCaptionTrack;
    if (!nameEl || !trackEl) return;

    const paint = () => {
      nameEl.setText(name);
      trackEl.setText(track);
      trackEl.toggleClass("gp-hidden", track === "");
      // After the text, never before: the tooltip decides on a measurement.
      this.updateCaptionTooltip();
    };

    const changed = nameEl.textContent !== name || trackEl.textContent !== track;
    const firstPaint = nameEl.textContent === "" && trackEl.textContent === "";
    if (!changed || firstPaint || this.prefersReducedMotion()) {
      if (this.nameSwapTimeout !== null) {
        window.clearTimeout(this.nameSwapTimeout);
        this.nameSwapTimeout = null;
      }
      this.stationCaption?.removeClass("is-swapping");
      paint();
      return;
    }

    // A second change landing mid-dip replaces the first: the names are already
    // invisible, so it just repaints and rides the same rise back.
    if (this.nameSwapTimeout !== null) window.clearTimeout(this.nameSwapTimeout);
    this.stationCaption?.addClass("is-swapping");
    this.nameSwapTimeout = window.setTimeout(() => {
      this.nameSwapTimeout = null;
      paint();
      this.stationCaption?.removeClass("is-swapping");
    }, CAPTION_NAME_FADE_MS);
  }

  /** Honour the OS motion setting for the timer-driven fades CSS cannot gate. */
  private prefersReducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /**
   * Offer the whole line as a tooltip, but only while some of it is actually
   * hidden. Both halves ellipsize independently, so either can be the one that
   * is cut; a tooltip that merely repeats fully-visible text is noise.
   *
   * Measured rather than assumed because it depends on the panel's width, not
   * on the text: the same name fits a wide sidebar and not a narrow one. Reads
   * layout, so it is called only when the text changes (renderStationCaption is
   * behind its own key), when the label's width transition lands, when the
   * section is unhidden, or when the panel is resized — never per tick. Writing
   * `title` cannot itself affect layout, so this is safe inside the
   * ResizeObserver callback.
   */
  private updateCaptionTooltip() {
    const caption = this.stationCaption;
    if (!caption) return;
    // Nothing is laid out: the section is hidden, or the panel is closed. A
    // measurement here reads 0 for both widths and concludes "not cut", which
    // would strip a tooltip that is needed — and for a plain video the caption
    // key never moves again, so nothing would re-measure for the rest of the
    // session. Leave whatever is there; the unhide re-measures.
    if (caption.clientWidth === 0) return;
    const cut = [this.stationCaptionName, this.stationCaptionTrack].some(
      (el) => el !== null && !el.hasClass("gp-hidden") && el.scrollWidth > el.clientWidth + 1
    );
    if (cut) caption.setAttribute("title", this.stationCaptionFullText);
    else caption.removeAttribute("title");
  }

  /**
   * Open or close the station list. Mirrors the task selector's expander, and
   * closes that one on the way — on mobile both lose their height cap and the
   * task list sits above the music section, so leaving both open would push the
   * thing just opened below the fold.
   */
  /**
   * Collapse or reveal the Stop / Reset / -5 / +5 groups.
   *
   * The class and the `inert` attribute must move together: gp-hidden-animated
   * collapses the wrapper to max-width: 0, which removes NOTHING from the tab
   * order, and pointer-events: none does not gate Enter on a focused control.
   * Before 0.6.1 a paused-at-full timer still let you Tab to a Stop button
   * that was not on screen.
   */
  private setSecondaryControlsHidden(hidden: boolean) {
    for (const el of [this.secondaryControlsWrapper, this.adjustWrapper]) {
      el.toggleClass("gp-hidden-animated", hidden);
      el.toggleAttribute("inert", hidden);
    }
  }

  /**
   * Close the task picker after a row is activated, and hand focus back.
   *
   * The row that was just used is now inside an inert container, so focus would
   * be dropped to the document and a keyboard user would land back at the top
   * of the panel. The station list already does this; the two pickers are meant
   * to be indistinguishable.
   */
  private closeTaskList() {
    this.taskListVisible = false;
    this.taskListContainer.removeClass("gp-visible");
    this.taskListContainer.toggleAttribute("inert", true);
    this.taskBtn?.focus();
  }

  /** Same pairing for the settings panel, which hides by max-height instead. */
  private setSettingsPanelVisible(visible: boolean) {
    this.settingsPanel.toggleClass("gp-visible", visible);
    this.settingsPanel.toggleAttribute("inert", !visible);
  }

  private setStationListVisible(visible: boolean) {
    if (visible === this.stationListVisible) return;
    this.stationListVisible = visible;
    this.stationListContainer?.toggleClass("gp-visible", visible);
    // The closed list is max-height:0, not display:none, so its rows stay
    // focusable — Tab into one and Enter switches station, silencing whatever is
    // playing from a control that is not on screen. (Predates the div rewrite:
    // the buttons it replaced were equally reachable.)
    this.stationListContainer?.toggleAttribute("inert", !visible);
    this.stationListBtn?.setAttribute("aria-expanded", visible ? "true" : "false");
    if (visible && this.taskListVisible) {
      this.taskListVisible = false;
      this.taskListContainer.removeClass("gp-visible");
      this.taskListContainer.toggleAttribute("inert", true);
    }
  }

  private toggleStationList() {
    this.setStationListVisible(!this.stationListVisible);
  }

  /**
   * Pick a station. Selection only — it never posts a play command, so a tap can
   * never produce sound the user did not ask for. Switching therefore reloads
   * the player and lands silent; ▶️ starts it.
   *
   * No fade on the way out: a fade would have to carry "now actually switch" in
   * a ramp completion callback, and cancelMusicRamps drops those — a duck, a ▶️
   * press or another reconcile inside the fade window would leave the setting
   * changed and the iframe not. Teardown is instant, so this cannot desync.
   */
  private async selectMusicStation(slot: number): Promise<void> {
    const urls = this.plugin.musicStationUrls();
    if ((urls[slot] ?? "").trim() === "") return; // empty slot: nothing to select
    if (resolveStationIndex(urls, this.plugin.settings.musicStationIndex) === slot) return;
    this.plugin.settings.musicStationIndex = slot;
    await this.plugin.saveSettings();
    // Every open panel converges on the new station through the same reconcile
    // path a settings edit uses, so a second panel can't be left on the old one.
    this.plugin.applySettingsToOpenViews();
  }

  /**
   * Dip the music under a sound cue. Called (via the plugin) from
   * TimerEngine.playSound, which must not touch the DOM itself; the controller
   * no-ops unless a player is ready and actually playing.
   */
  duckMusic(cueDurationSec: number) {
    this.music.duck(cueDurationSec);
  }

  /**
   * The view's half of the music contract: real timers, the hidden iframe, the
   * plugin's position store, and the two statements the controller makes to the
   * panel. Everything the state machine touches outside itself goes through
   * here — which is what lets tests drive it with a fake clock and a recording
   * message sink instead of a browser. See [MusicController.ts](MusicController.ts).
   */
  private createMusicHost(): MusicHost {
    return {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => {
        window.clearTimeout(id);
      },
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (id) => {
        window.clearInterval(id);
      },
      mountPlayer: (src, onLoad) => {
        const iframe = this.musicPlayerContainer.createEl("iframe", {
          attr: {
            src,
            allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
            referrerpolicy: "strict-origin-when-cross-origin", // YouTube needs a Referer or it throws error 153
            allowfullscreen: "",
            title: "Lofi music player",
          },
        });
        this.musicIframe = iframe;
        this.registerDomEvent(iframe, "load", onLoad);
      },
      unmountPlayer: () => {
        this.musicIframe?.remove();
        this.musicIframe = null;
      },
      postToPlayer: (payload, origin) => {
        this.musicIframe?.contentWindow?.postMessage(payload, origin);
      },
      broadcastToPlayer: (payload, origins) => {
        for (const origin of origins) {
          this.musicIframe?.contentWindow?.postMessage(payload, origin);
        }
      },
      musicVolume: () => this.plugin.settings.musicVolume,
      recordPosition: (position) => {
        this.plugin.recordMusicPosition(position);
      },
      clearPosition: (url) => {
        this.plugin.clearMusicPosition(url);
      },
      flushPosition: () => {
        this.plugin.flushMusicPosition();
      },
      setTransportPlaying: (playing) => {
        this.musicPlayBtn?.toggleClass("gp-hidden", playing);
        this.musicPauseBtn?.toggleClass("gp-hidden", !playing);
        // The caption's wording is the same statement as the button's shape, so
        // it repaints from this one call rather than being recomputed — see
        // MusicController.setButtonsPlaying for the two reasons that matters.
        this.renderStationCaption();
      },
      onTrackChanged: () => {
        this.renderStationCaption();
      },
      notice: (message) => {
        new Notice(message);
      },
      isIosApp: () => Platform.isIosApp,
    };
  }

  /**
   * Format a projected end timestamp as a localized wall-clock time — "Ends
   * 15:30" (or "Ends 3:30 PM" per locale, via moment's LT). When the session
   * finishes on a later calendar day than now (a late start plus a long
   * session), append "(+1 day)" — or "(+N days)" in the extreme. The delta is
   * measured on local-midnight boundaries (startOf("day")), so it counts
   * calendar days and stays correct across DST rather than counting 24h chunks.
   */
  private formatEndTime(endMs: number): string {
    const end = moment(endMs);
    const time = end.format("LT");
    // startOf mutates `end` in place; it isn't read again after this.
    const dayDelta = end.startOf("day").diff(moment().startOf("day"), "days");
    if (dayDelta <= 0) return `Ends ${time}`;
    const suffix = dayDelta === 1 ? "+1 day" : `+${dayDelta} days`;
    return `Ends ${time} (${suffix})`;
  }

  /** Re-render the task picker. Sources tasks via taskLoader so regex parsing stays centralized. */
  async loadTasks() {
    this.taskListContainer.empty();

    const clearItem = this.taskListContainer.createDiv("gp-task-item");
    clearItem.setAttribute("role", "option");
    clearItem.setAttribute("aria-selected", "false");
    clearItem.setAttribute("tabindex", "0");
    clearItem.addClass("gp-task-item-clear");
    setIcon(clearItem, "x-circle");
    clearItem.createSpan({ text: "Unlink Current Task" });

    this.registerDomEvent(clearItem, "click", () => {
      this.timer.setTask(NO_TASK_LABEL);
      this.closeTaskList();
    });

    const tasks = await fetchTasks(this.plugin.app, {
      tasksPath: this.plugin.settings.tasksPath,
      limitDays: this.plugin.settings.taskSelectorDays,
    });
    const groups = groupTasksByDate(tasks);

    if (groups.length === 0) {
      // An empty tasksPath scans the whole vault, so "no path + no results"
      // almost always means task linking was never set up — nudge instead.
      const configured = this.plugin.settings.tasksPath.trim() !== "";
      const empty = this.taskListContainer.createDiv("gp-task-empty");
      setIcon(
        empty.createDiv("gp-task-empty-icon"),
        configured ? "calendar-check" : "folder-search"
      );
      empty.createDiv({
        cls: "gp-task-empty-title",
        text: configured ? "All clear" : "Nothing here yet",
      });
      empty.createDiv({
        cls: "gp-task-empty-hint",
        text: configured
          ? `No tasks scheduled or due in the next ${this.plugin.settings.taskSelectorDays} days.`
          : "Set a Tasks folder path in the plugin settings to pick tasks here.",
      });
      return;
    }

    for (const group of groups) {
      this.taskListContainer.createDiv("gp-task-group-header").setText(group.label);

      for (const task of group.items) {
        const item = this.taskListContainer.createDiv("gp-task-item");
        item.setAttribute("role", "option");
        item.setAttribute("tabindex", "0");
        item.setAttribute("aria-selected", "false");
        item.createSpan({ text: task.displayText });

        if (
          task.cleanText === this.timer.currentTaskName &&
          task.path === this.timer.currentTaskPath
        ) {
          item.addClass("gp-task-selected");
          item.setAttribute("aria-selected", "true");
          const iconContainer = item.createDiv("gp-task-check-icon");
          setIcon(iconContainer, "check");
        }

        this.registerDomEvent(item, "click", () => {
          this.timer.setTask(task.cleanText, task.path, task.taskId);
          this.closeTaskList();
        });
      }
    }
  }

  renderSettingsPanel() {
    this.settingsPanel.empty();

    const settings = this.plugin.settings;

    const section = (label: string) => {
      this.settingsPanel.createDiv({ cls: "gp-settings-section-label", text: label });
    };

    const numberRow = (
      label: string,
      initial: number,
      onChange: (next: number) => Promise<void>
    ) => {
      const row = this.settingsPanel.createDiv("gp-settings-row");
      row.createSpan({ text: label });
      const input = row.createEl("input", { type: "number" });
      input.value = initial.toString();
      this.registerDomEvent(input, "change", () => {
        const val = parseInt(input.value);
        if (val > 0) void onChange(val);
      });
      this.registerDomEvent(input, "keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") input.blur();
      });
    };

    const toggleRow = (
      label: string,
      initial: boolean,
      onChange: (next: boolean) => Promise<void>
    ) => {
      const row = this.settingsPanel.createDiv("gp-settings-row");
      row.createSpan({ text: label });
      const wrap = row.createEl("label", { cls: "gp-toggle" });
      const input = wrap.createEl("input", { type: "checkbox" });
      input.checked = initial;
      wrap.createSpan({ cls: "gp-toggle-slider" });
      this.registerDomEvent(input, "change", () => void onChange(input.checked));
      return { row, input };
    };

    const segmentedRow = <T>(
      label: string,
      options: { label: string; value: T }[],
      initial: T,
      onChange: (next: T) => Promise<void>
    ) => {
      const row = this.settingsPanel.createDiv("gp-settings-row");
      row.createSpan({ text: label });
      const seg = row.createDiv({ cls: "gp-segmented", attr: { role: "radiogroup" } });
      // For numeric values we pick the option closest to `initial` (e.g. volume:
      // tolerate any past saved float). For other types, strict equality.
      const initialOpt: { label: string; value: T } =
        typeof initial === "number"
          ? options.reduce((best, opt) =>
              Math.abs((opt.value as number) - (initial as number)) <
              Math.abs((best.value as number) - (initial as number))
                ? opt
                : best
            )
          : (options.find((o) => o.value === initial) ?? options[0]);
      const buttons: HTMLButtonElement[] = [];
      for (const opt of options) {
        const btn = seg.createEl("button", { cls: "gp-segmented-btn", text: opt.label });
        btn.type = "button";
        btn.setAttribute("role", "radio");
        const isActive = opt === initialOpt;
        btn.setAttribute("aria-checked", String(isActive));
        if (isActive) btn.addClass("is-active");
        buttons.push(btn);
        this.registerDomEvent(btn, "click", () => {
          for (const b of buttons) {
            b.removeClass("is-active");
            b.setAttribute("aria-checked", "false");
          }
          btn.addClass("is-active");
          btn.setAttribute("aria-checked", "true");
          void onChange(opt.value);
        });
      }
    };

    section("Timing");
    numberRow("Focus (m)", settings.focusMinutes, async (v) => {
      settings.focusMinutes = v;
      await this.plugin.saveSettings();
      this.timer.updateDuration("focus", v);
    });
    numberRow("Break (m)", settings.breakMinutes, async (v) => {
      settings.breakMinutes = v;
      await this.plugin.saveSettings();
      this.timer.updateDuration("break", v);
    });

    section("Audio");
    toggleRow("Sound", settings.soundEnabled, async (v) => {
      settings.soundEnabled = v;
      await this.plugin.saveSettings();
    });
    segmentedRow(
      "Volume",
      [
        { label: "Low", value: 0.3 },
        { label: "Mid", value: 0.7 },
        { label: "High", value: 1.0 },
      ],
      settings.soundVolume,
      async (v) => {
        settings.soundVolume = v;
        await this.plugin.saveSettings();
      }
    );
    segmentedRow(
      "Music volume",
      [
        { label: "Low", value: 0.3 },
        { label: "Mid", value: 0.7 },
        { label: "High", value: 1.0 },
      ],
      settings.musicVolume,
      async (v) => {
        settings.musicVolume = v;
        await this.plugin.saveSettings();
        // Live-apply to this view's playing iframe; other open views converge
        // through their own syncVolume() on the next reconcile.
        this.music.applyVolume();
      }
    );

    // Two sections keyed by EVENT, replacing the flat "Auto-start" pair. The
    // heading names the moment once, so both rows under it answer the same
    // question and the duplicate "Play a chime" labels are unambiguous. Flat
    // rows put opposite mode words side by side ("Auto-start break" above
    // "Chime when focus ends"), where adjacency fought comprehension — and the
    // pairing is also what makes a disappearing chime row self-explanatory.
    //
    // Each shared row registers itself for syncSettingsPanel(), which re-seeds
    // it when the same setting is changed from the settings tab.
    this.sharedPanelRows = [];
    const sharedToggle = (key: SharedPanelKey, label: string) => {
      const { row, input } = toggleRow(label, Boolean(settings[key]), async (v) => {
        settings[key] = v;
        await this.plugin.saveSettings();
        // Fan out: the engine is silent while the timer is idle, so without
        // this a second open panel (and the settings tab) never converges.
        this.plugin.applySettingsToOpenViews();
      });
      this.sharedPanelRows.push({ key, row, input });
      return { row, input };
    };

    // Four independent rows, nothing conditional. "Play a chime" governs BOTH
    // paths — the clock running out into overtime and the next session starting
    // on its own — so neither row is ever moot and neither is hidden. An
    // earlier cut hid each chime while its auto-start was on, which read
    // backwards: turning something on should reveal choices, not remove them.
    //
    // The chime sits ABOVE its start toggle so reading order presents it as a
    // property of the whole event rather than a fallback for when nothing else
    // happens, and each pair closes with a line saying what will actually
    // happen — because "Play a chime" cannot carry its own scope, and the
    // question it leaves ("does it still chime if the break auto-starts?")
    // deserves an answer on screen rather than by experiment.
    this.endSummaryLines = [];
    const summaryFor = (edge: SessionEndEdge) => {
      const el = this.settingsPanel.createDiv({ cls: "gp-settings-hint" });
      this.endSummaryLines.push({ edge, el });
    };

    section("When focus ends");
    sharedToggle("focusEndSoundEnabled", "Play a chime");
    sharedToggle("autoStartBreak", "Auto-start the next break");
    summaryFor("focus");

    section("When a break ends");
    sharedToggle("breakEndSoundEnabled", "Play a chime");
    sharedToggle("autoStartFocus", "Auto-start the next focus");
    summaryFor("break");

    // Seed the summaries now rather than waiting for the next engine emit: the
    // rows above are built empty, and the tick that would fill them does not
    // run while the timer is idle — which is exactly when someone opens the
    // gear panel to read what these toggles do.
    this.syncSettingsPanel();

    const resetWrap = this.settingsPanel.createDiv("gp-settings-reset");
    const resetBtn = resetWrap.createEl("button", {
      cls: "gp-reset-button",
      text: "Reset to defaults",
    });
    resetBtn.type = "button";
    this.registerDomEvent(resetBtn, "click", async () => {
      settings.focusMinutes = DEFAULT_SETTINGS.focusMinutes;
      settings.breakMinutes = DEFAULT_SETTINGS.breakMinutes;
      settings.soundEnabled = DEFAULT_SETTINGS.soundEnabled;
      settings.soundVolume = DEFAULT_SETTINGS.soundVolume;
      settings.musicVolume = DEFAULT_SETTINGS.musicVolume;
      settings.autoStartBreak = DEFAULT_SETTINGS.autoStartBreak;
      settings.autoStartFocus = DEFAULT_SETTINGS.autoStartFocus;
      settings.focusEndSoundEnabled = DEFAULT_SETTINGS.focusEndSoundEnabled;
      // NOT DEFAULT_SETTINGS.breakEndSoundEnabled: that is false because it is
      // the upgrade merge base (see settingsStore.deriveBreakEndChime). What a
      // reset should restore is the value a NEW install gets, which is on.
      settings.breakEndSoundEnabled = true;
      await this.plugin.saveSettings();
      this.timer.updateDuration("focus", settings.focusMinutes);
      this.timer.updateDuration("break", settings.breakMinutes);
      this.music.applyVolume();
      this.renderSettingsPanel();
      // Reset writes shared settings, so other open panels and the settings tab
      // have to hear about it too.
      this.plugin.applySettingsToOpenViews();
    });
  }

  /**
   * Re-seed the panel controls that can also be changed from the settings tab.
   * Called on every engine emit via applySettings().
   *
   * This re-SEEDS; it must never call renderSettingsPanel(), which empties the
   * container and re-registers every listener. `registerDomEvent` releases on
   * unload rather than on removal, and applySettings() runs on a 50ms tick — so
   * a rebuild here would leak twenty detached rows a second. Same rule as the
   * station rows, which are built once and only re-labelled.
   *
   * Only SHARED controls are re-seeded. The number inputs are deliberately left
   * alone: writing `input.value` while the user is mid-edit rewrites the field
   * under their caret, and nothing else can change them anyway.
   */
  private syncSettingsPanel() {
    const settings = this.plugin.settings;
    for (const entry of this.sharedPanelRows) {
      entry.input.checked = Boolean(settings[entry.key]);
    }
    for (const line of this.endSummaryLines) {
      // The whole mapping lives in the pure function, so the view holds no
      // branch a test cannot reach.
      line.el.setText(sessionEndSummary(line.edge, settings));
    }
  }
}
