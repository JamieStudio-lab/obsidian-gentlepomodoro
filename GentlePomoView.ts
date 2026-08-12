import { ItemView, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type GentlePomoPlugin from "./main";
import type { TimerListener, TimerState } from "./types";
import {
  DEFAULT_SETTINGS,
  VIEW_TYPE_GENTLE_POMO,
  NO_TASK_LABEL,
  ONE_MINUTE_MS,
  PEEK_REVEAL_MS,
  MUSIC_LISTENING_DELAY_MS,
  MUSIC_DUCK_FACTOR,
  MUSIC_DUCK_DOWN_MS,
  MUSIC_DUCK_UP_MS,
  MUSIC_DUCK_STEP_MS,
  MUSIC_ENDED_NOTICE_DELAY_MS,
  MUSIC_STALL_NOTICE_DELAY_MS,
  MUSIC_STALL_RENOTIFY_MS,
} from "./constants";
import { TimerEngine } from "./TimerEngine";
import { loadTasks as fetchTasks, groupTasksByDate } from "./taskLoader";
import { buildDayNightIcon, DAY_NIGHT_ICON_ORDER, type DayNightIcon } from "./icons";
import type { MomentFactory } from "./momentTypes";
import {
  YT_EMBED_ORIGIN,
  YT_ALLOWED_MESSAGE_ORIGINS,
  YT_STATE,
  parseYouTubeUrl,
  buildEmbedUrl,
  buildPlayerCommand,
  buildListeningMessage,
  parsePlayerMessage,
  musicVolumeTo100,
  buildVolumeRamp,
  isResumablePosition,
  resumeTarget,
  type MusicTarget,
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
  private musicIframe: HTMLIFrameElement | null = null;
  private musicListenTimeout: number | null = null;
  private musicPlayerReady = false;
  private musicPlayerState: number = YT_STATE.UNSTARTED;
  private musicErrorNotified = false; // one Notice per iframe build
  private musicEndedTimeout: number | null = null; // pending "music ended" Notice
  private musicStallTimeout: number | null = null; // pending "music is buffering" Notice
  private musicStallNotifiedAt = 0; // rate-limits stall notices (0 = never fired)
  // Resume bookkeeping. The embed reports its clock/metadata piecemeal over
  // infoDelivery, so the view keeps the running picture and hands whole
  // positions to the plugin (which owns persistence).
  private musicCurrentVideoId: string | null = null; // seeded from the URL, corrected by videoData
  private musicCurrentDuration: number | null = null; // null/0 ⇒ live stream: nothing to resume
  private musicTargetPlaylistId: string | null = null; // list context of the loaded embed
  private musicResumeOffsetActive = false; // the loaded embed URL carries a resume start=
  private musicSeekToZeroOnPlay = false; // one-shot: next PLAYING seeks back to 0
  // Music ducking (the music dips under a sound cue, then eases back).
  // duckLevel is the last 0–1 volume actually posted while ducking — the start
  // point for the next ramp (so overlapping cues never double-dip or jump) and,
  // when non-null, the "duck in progress" marker.
  private duckRampInterval: number | null = null;
  private duckRestoreTimeout: number | null = null;
  private duckLevel: number | null = null;

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
  // whole (toggle, url) reconcile to actual changes; lastMusicEmbedUrl gates iframe
  // rebuilds; lastAppliedMusicVolume gates setVolume posts.
  private lastMusicKey: string | null = null;
  private lastMusicEmbedUrl: string | null = null;
  private lastAppliedMusicVolume: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GentlePomoPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.timer = plugin.timer;
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
    this.resizeObserver = new ResizeObserver(() => this.updateCompactClass());
    this.resizeObserver.observe(container);
    this.registerDomEvent(window, "resize", () => this.updateCompactClass());

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

    // Create Layers in Order: Day -> Dusk -> Night
    this.timerShape.createDiv("gp-layer-day");
    this.timerShape.createDiv("gp-layer-dusk");
    this.timerShape.createDiv("gp-layer-night");

    // Frosted-glass theme layers (CSS-toggled per theme; built once here).
    const orbs = this.timerShape.createDiv("gp-glass-orbs");
    orbs.createDiv("gp-orb gp-orb-1");
    orbs.createDiv("gp-orb gp-orb-2");
    orbs.createDiv("gp-orb gp-orb-3");
    this.timerShape.createDiv("gp-glass-pane");
    this.timerShape.createDiv("gp-glass-highlight");

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

    const settingsBtn = row2.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(settingsBtn, "settings");
    this.registerDomEvent(settingsBtn, "click", (evt) => {
      evt.preventDefault();
      this.settingsVisible = !this.settingsVisible;
      this.settingsPanel.toggleClass("gp-visible", this.settingsVisible);
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
    this.settingsPanel = controls.createDiv("gp-settings-panel");
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
        this.taskListContainer.addClass("gp-visible");
        void this.loadTasks();
      } else {
        this.taskListContainer.removeClass("gp-visible");
      }
    });

    // --- Task List Container ---
    this.taskListContainer = controls.createDiv("gp-task-list");

    // --- Music (audio-only lofi playback) ---
    // Hairline between the task selector and the music row. Reconciled in
    // applySettings — visible only when both neighbors are visible, so it
    // never dangles under a hidden selector or above a hidden music row.
    this.musicDivider = controls.createDiv("gp-music-divider");

    // The ♪ row is the only playback UI — the YouTube iframe below is a
    // visually-hidden audio engine (see .gp-music-player in styles.css). The
    // iframe itself is (re)built in applySettings(), which reconciles the
    // showMusicPlayer/musicUrl settings against the DOM.
    this.musicSection = controls.createDiv("gp-music-section");
    const musicRow = this.musicSection.createDiv("gp-controls-row");

    // Decorative glyph so the row reads as the music row, not more timer buttons.
    const musicGlyph = musicRow.createSpan("gp-music-row-icon");
    setIcon(musicGlyph, "music");
    musicGlyph.setAttribute("aria-hidden", "true");

    this.musicPlayBtn = musicRow.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(this.musicPlayBtn, "play");
    this.musicPlayBtn.setAttribute("aria-label", "Play music");
    this.registerDomEvent(this.musicPlayBtn, "click", (evt) => {
      evt.preventDefault();
      // Pre-handshake commands are silently dropped by the embed — without
      // this, playing while offline (or mid-boot) is just a dead button.
      if (!this.musicPlayerReady) {
        new Notice(
          "Gentle pomodoro: the music player hasn't loaded yet — wait a moment, or check your connection if you're offline."
        );
        return;
      }
      this.postToMusicPlayer(buildPlayerCommand("playVideo"));
    });

    this.musicPauseBtn = musicRow.createEl("button", { cls: "gp-btn gp-icon-btn gp-hidden" });
    setIcon(this.musicPauseBtn, "pause");
    this.musicPauseBtn.setAttribute("aria-label", "Pause music");
    this.registerDomEvent(this.musicPauseBtn, "click", (evt) => {
      evt.preventDefault();
      this.postToMusicPlayer(buildPlayerCommand("pauseVideo"));
    });

    const musicStopBtn = musicRow.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(musicStopBtn, "square");
    musicStopBtn.setAttribute("aria-label", "Stop music");
    this.registerDomEvent(musicStopBtn, "click", (evt) => {
      evt.preventDefault();
      this.postToMusicPlayer(buildPlayerCommand("stopVideo"));
      // Stop means "start from the top next time" — pause is what remembers.
      // The loaded iframe still carries its start= in the URL, so also arm the
      // seek-to-0 that makes playing again honour that within this session.
      this.plugin.clearMusicPosition();
      this.musicCurrentDuration = null;
      if (this.musicResumeOffsetActive) this.musicSeekToZeroOnPlay = true;
    });

    this.musicPlayerContainer = this.musicSection.createDiv("gp-music-player");

    // The embed talks back over the shared window message bus. Source and
    // origin are checked before parsing — everything else on the bus is noise.
    this.registerDomEvent(window, "message", (evt: MessageEvent) => {
      if (!this.musicIframe || evt.source !== this.musicIframe.contentWindow) return;
      if (!YT_ALLOWED_MESSAGE_ORIGINS.includes(evt.origin)) return;
      const msg = parsePlayerMessage(evt.data);
      if (!msg) return;
      if (msg.type === "ready") {
        this.musicPlayerReady = true;
        // Apply the saved volume as soon as the player can take commands.
        this.postMusicVolume();
      } else if (msg.type === "error") {
        this.notifyMusicError(msg.code);
      } else if (msg.type === "state") {
        this.handleMusicState(msg.state);
      } else {
        // infoDelivery: merge whatever this message carried, position before
        // state so a transition into PAUSED flushes the freshest clock value.
        if (msg.videoId !== null) this.musicCurrentVideoId = msg.videoId;
        if (msg.duration !== null) this.musicCurrentDuration = msg.duration;
        if (msg.currentTime !== null) this.trackMusicPosition(msg.currentTime);
        if (msg.state !== null) this.handleMusicState(msg.state);
      }
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
        this.secondaryControlsWrapper.removeClass("gp-hidden-animated");
        this.adjustWrapper.removeClass("gp-hidden-animated");
      } else {
        startBtn.removeClass("gp-hidden");
        pauseBtn.addClass("gp-hidden");

        if (state.remainingMs !== state.totalMs) {
          this.secondaryControlsWrapper.removeClass("gp-hidden-animated");
          this.adjustWrapper.removeClass("gp-hidden-animated");
        } else {
          this.secondaryControlsWrapper.addClass("gp-hidden-animated");
          this.adjustWrapper.addClass("gp-hidden-animated");
        }
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
        let progress = 0;
        if (state.totalMs > 0) {
          progress = 1 - state.remainingMs / state.totalMs;
        }
        progress = Math.max(0, Math.min(1, progress));

        let skyPhase = 0;
        if (state.mode === "focus") {
          skyPhase = progress;
        } else {
          skyPhase = 1 - progress;
        }

        let duskOpacity = 0;
        let nightOpacity = 0;
        if (skyPhase < 0.5) {
          duskOpacity = skyPhase * 2;
          nightOpacity = 0;
        } else {
          duskOpacity = 1;
          nightOpacity = (skyPhase - 0.5) * 2;
        }
        visual.style.setProperty("--gp-dusk-opacity", duskOpacity.toString());
        visual.style.setProperty("--gp-night-opacity", nightOpacity.toString());
        // Consumed by frosted-glass orb color-mix() in styles.css. Uses skyPhase
        // (not raw progress) so orbs warm→cool on focus and cool→warm on break,
        // matching the classic theme's narrative arc.
        visual.style.setProperty("--gp-progress", skyPhase.toString());
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
    this.destroyMusicIframe();
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
    const theme = this.plugin.settings.theme;
    this.containerEl.toggleClass("gp-theme-classic", theme === "classic");
    this.containerEl.toggleClass("gp-theme-frosted-glass", theme === "frosted-glass");

    const state = this.lastState ?? this.timer.getState();

    // Task-selector visibility. Idempotent, so safe to run on every tick. The
    // unlink-on-hide side effect lives in the settings toggle's onChange (calling
    // setTask here would fire every tick); on load no task is ever pre-linked.
    const showSelector = this.plugin.settings.showTaskSelector;
    this.taskSelectorRow?.toggleClass("gp-hidden", !showSelector);
    this.taskListContainer?.toggleClass("gp-hidden", !showSelector);
    if (!showSelector && this.taskListVisible) {
      this.taskListVisible = false;
      this.taskListContainer.removeClass("gp-visible");
    }

    // Music player reconciliation. Runs here so the per-tick call and the settings
    // tab's applySettingsToOpenViews() converge on the same DOM. The lastMusicKey
    // string guard keeps the ~20Hz hot path to one concat + compare — the URL is
    // only parsed when the (toggle, loop, url) triple actually changes. Removing
    // the iframe is what stops playback, which implements "toggle off = hide + stop".
    // Loop is baked into the embed URL, so flipping it rebuilds the iframe too.
    const musicKey = `${this.plugin.settings.showMusicPlayer ? "1" : "0"}|${this.plugin.settings.musicLoop ? "1" : "0"}|${this.plugin.settings.musicUrl}`;
    if (musicKey !== this.lastMusicKey) {
      this.lastMusicKey = musicKey;
      const target = this.plugin.settings.showMusicPlayer
        ? parseYouTubeUrl(this.plugin.settings.musicUrl)
        : null;
      // Fold in the remembered position so the embed loads pre-seeked. Read
      // here, at build time, and deliberately NOT part of musicKey — keying on
      // it would rebuild the iframe every time the position moved.
      const resumed = target ? resumeTarget(target, this.plugin.musicResumeState()) : null;
      const embedUrl = resumed ? buildEmbedUrl(resumed, this.plugin.settings.musicLoop) : null;
      this.musicSectionVisible = embedUrl !== null;
      this.musicSection?.toggleClass("gp-hidden", !this.musicSectionVisible);
      if (embedUrl !== this.lastMusicEmbedUrl) {
        this.lastMusicEmbedUrl = embedUrl;
        this.destroyMusicIframe();
        // resumeTarget returns its input unchanged when nothing applied, so an
        // identity check is exactly "this embed carries a resume offset".
        if (embedUrl !== null && resumed !== null) {
          this.buildMusicIframe(embedUrl, resumed, resumed !== target);
        }
      }
    }
    // The task-selector/music divider needs both neighbors visible. Outside the
    // musicKey guard because showTaskSelector can change independently of it.
    this.musicDivider?.toggleClass("gp-hidden", !showSelector || !this.musicSectionVisible);
    // Volume convergence (settings changed from another view or a reload while
    // the player was still booting). No-op per tick once applied.
    if (this.musicPlayerReady && this.plugin.settings.musicVolume !== this.lastAppliedMusicVolume) {
      this.postMusicVolume();
    }

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

    const icon = this.getDayNightIcon(state);
    for (const key of DAY_NIGHT_ICON_ORDER) {
      this.dayNightIconEls[key]?.toggleClass("is-active", key === icon);
    }
  }

  /**
   * Create the hidden YouTube iframe and start the postMessage handshake:
   * after the iframe's load event, wait a beat (the embed isn't ready the
   * instant it loads), then announce {"event":"listening"} so it starts
   * streaming onReady/onStateChange/infoDelivery/onError back to us.
   */
  private buildMusicIframe(embedUrl: string, target: MusicTarget, resumeApplied: boolean) {
    // Seed the resume bookkeeping from the target. videoId matters for a plain
    // video, where the embed's videoData may never tell us anything we don't
    // already know; inside a playlist the stream corrects it as items advance.
    this.musicCurrentVideoId = target.videoId;
    this.musicTargetPlaylistId = target.playlistId;
    this.musicCurrentDuration = null;
    this.musicResumeOffsetActive = resumeApplied;
    this.musicSeekToZeroOnPlay = false;

    const iframe = this.musicPlayerContainer.createEl("iframe", {
      attr: {
        src: embedUrl,
        allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
        referrerpolicy: "strict-origin-when-cross-origin", // YouTube needs a Referer or it throws error 153
        allowfullscreen: "",
        title: "Lofi music player",
      },
    });
    this.musicIframe = iframe;
    this.registerDomEvent(iframe, "load", () => {
      if (this.musicListenTimeout !== null) window.clearTimeout(this.musicListenTimeout);
      this.musicListenTimeout = window.setTimeout(() => {
        this.musicListenTimeout = null;
        this.postToMusicPlayer(buildListeningMessage());
      }, MUSIC_LISTENING_DELAY_MS);
    });
  }

  /**
   * Tear the iframe down — removal from the DOM is what stops playback.
   * Also resets the handshake/volume state so a rebuilt iframe starts fresh.
   */
  private destroyMusicIframe() {
    // Teardown is a boundary: closing the panel, moving the leaf, or changing
    // the URL all end playback. The pending position is keyed by the video it
    // came from, so saving the *outgoing* one here is correct even mid-swap.
    this.plugin.flushMusicPosition();
    this.musicResumeOffsetActive = false;
    this.musicSeekToZeroOnPlay = false;
    this.musicCurrentVideoId = null;
    this.musicCurrentDuration = null;
    this.musicTargetPlaylistId = null;
    this.cancelMusicDuck();
    if (this.musicListenTimeout !== null) {
      window.clearTimeout(this.musicListenTimeout);
      this.musicListenTimeout = null;
    }
    if (this.musicEndedTimeout !== null) {
      window.clearTimeout(this.musicEndedTimeout);
      this.musicEndedTimeout = null;
    }
    if (this.musicStallTimeout !== null) {
      window.clearTimeout(this.musicStallTimeout);
      this.musicStallTimeout = null;
    }
    this.musicIframe?.remove();
    this.musicIframe = null;
    this.musicPlayerReady = false;
    this.musicErrorNotified = false;
    this.lastAppliedMusicVolume = null;
    this.updateMusicButtons(YT_STATE.UNSTARTED);
  }

  private postToMusicPlayer(payload: string) {
    this.musicIframe?.contentWindow?.postMessage(payload, YT_EMBED_ORIGIN);
  }

  private postMusicVolume() {
    // An explicit volume set (segmented control, reset, cross-view reconcile)
    // always wins over an in-flight duck.
    this.cancelMusicDuck();
    this.postToMusicPlayer(
      buildPlayerCommand("setVolume", [musicVolumeTo100(this.plugin.settings.musicVolume)])
    );
    this.lastAppliedMusicVolume = this.plugin.settings.musicVolume;
  }

  /**
   * Dip the music under a sound cue: a quick stepped ramp down to
   * MUSIC_DUCK_FACTOR × the user's volume, hold for the cue's duration, then a
   * slower ease back up. Called (via the plugin) from TimerEngine.playSound with
   * the decoded clip's length. A cue landing mid-duck restarts the hold from the
   * current level — extend, never double-dip. No-op unless the player is ready
   * and actually playing (pre-handshake commands are dropped by the embed anyway).
   */
  duckMusic(cueDurationSec: number) {
    const playing =
      this.musicPlayerState === YT_STATE.PLAYING || this.musicPlayerState === YT_STATE.BUFFERING;
    if (!this.musicPlayerReady || !playing) return;

    const base = this.plugin.settings.musicVolume;
    const target = base * MUSIC_DUCK_FACTOR;
    const from = this.duckLevel ?? base;
    this.clearDuckTimers();
    this.runDuckRamp(from, target, MUSIC_DUCK_DOWN_MS);
    // The down-ramp runs under the cue's attack; restore starts when the clip ends.
    const holdMs = Math.max(cueDurationSec * 1000, MUSIC_DUCK_DOWN_MS);
    this.duckRestoreTimeout = window.setTimeout(() => {
      this.duckRestoreTimeout = null;
      this.restoreDuckedMusic();
    }, holdMs);
  }

  /** Ease the music back to the user's volume (re-read at restore time) and end the duck. */
  private restoreDuckedMusic() {
    const userVolume = this.plugin.settings.musicVolume;
    const from = this.duckLevel ?? userVolume * MUSIC_DUCK_FACTOR;
    this.runDuckRamp(from, userVolume, MUSIC_DUCK_UP_MS, () => {
      this.duckLevel = null;
      // Exact landing + lastAppliedMusicVolume bookkeeping (cancel inside is a no-op here).
      this.postMusicVolume();
    });
  }

  /** Post a stepped volume ramp — one setVolume per MUSIC_DUCK_STEP_MS. Replaces any running ramp. */
  private runDuckRamp(from01: number, to01: number, durationMs: number, onDone?: () => void) {
    if (this.duckRampInterval !== null) window.clearInterval(this.duckRampInterval);
    const steps = Math.max(1, Math.round(durationMs / MUSIC_DUCK_STEP_MS));
    const levels = buildVolumeRamp(from01, to01, steps);
    let i = 0;
    this.duckRampInterval = window.setInterval(() => {
      const level = levels[i++];
      this.duckLevel = level;
      this.postToMusicPlayer(buildPlayerCommand("setVolume", [musicVolumeTo100(level)]));
      if (i >= levels.length && this.duckRampInterval !== null) {
        window.clearInterval(this.duckRampInterval);
        this.duckRampInterval = null;
        onDone?.();
      }
    }, MUSIC_DUCK_STEP_MS);
  }

  /** Drop any in-flight duck (timers + state). Restores nothing — callers either
   *  post the user volume next (postMusicVolume) or are tearing the iframe down. */
  private cancelMusicDuck() {
    this.clearDuckTimers();
    this.duckLevel = null;
  }

  private clearDuckTimers() {
    if (this.duckRampInterval !== null) {
      window.clearInterval(this.duckRampInterval);
      this.duckRampInterval = null;
    }
    if (this.duckRestoreTimeout !== null) {
      window.clearTimeout(this.duckRestoreTimeout);
      this.duckRestoreTimeout = null;
    }
  }

  /**
   * React to a reported player state, from either onStateChange or an
   * infoDelivery that carried one.
   *
   * Ordering is load-bearing: updateMusicButtons is what advances
   * musicPlayerState, and both the stall notice and the transition checks here
   * read it as the *previous* state, so it must stay last.
   */
  private handleMusicState(state: number) {
    if (state !== this.musicPlayerState) {
      if (state === YT_STATE.PAUSED) {
        // The position only lives in memory while playing — pausing is the
        // boundary that has to reach disk, and it's the main way users leave.
        this.plugin.flushMusicPosition();
      } else if (state === YT_STATE.ENDED) {
        // Finished: next time this track opens at the top. With loop on, the
        // restart re-records from ~0 a moment later. The embed may also
        // re-apply the URL's start= on each repeat, so arm the corrective seek.
        this.plugin.clearMusicPosition();
        if (this.musicResumeOffsetActive) this.musicSeekToZeroOnPlay = true;
      } else if (state === YT_STATE.PLAYING && this.musicSeekToZeroOnPlay) {
        // Consume the one-shot armed by ⏹ Stop or a loop restart. Harmless when
        // the embed already restarted at 0 — it's then a seek to where we are.
        this.musicSeekToZeroOnPlay = false;
        this.postToMusicPlayer(buildPlayerCommand("seekTo", [0, true]));
      }
    }
    this.maybeNotifyMusicStalled(state);
    this.maybeNotifyMusicEnded(state);
    this.updateMusicButtons(state);
  }

  /**
   * Hand a reported playback position to the plugin's store. Live streams and
   * the final seconds of a track are filtered out by isResumablePosition; the
   * "too early to bother resuming" floor lives on the *apply* side instead, so
   * that a restarted track immediately overwrites a stale offset here.
   *
   * Only an audibly-running player is recorded. A cued one also reports a clock
   * (at 0), which would otherwise let a second, idle panel — or the moment just
   * after ⏹ Stop — reset a position the playing panel had banked. Note the
   * state read here is the *previous* one (updateMusicButtons advances it after
   * this runs), which is also what keeps the first 0 of a resumed track from
   * overwriting the very offset it was built with.
   */
  private trackMusicPosition(seconds: number) {
    const audible =
      this.musicPlayerState === YT_STATE.PLAYING || this.musicPlayerState === YT_STATE.BUFFERING;
    if (!audible) return;
    const videoId = this.musicCurrentVideoId;
    if (videoId === null) return;
    if (!isResumablePosition(seconds, this.musicCurrentDuration)) return;
    this.plugin.recordMusicPosition({
      videoId,
      playlistId: this.musicTargetPlaylistId,
      seconds,
    });
  }

  /**
   * Swap the ♪ play/pause buttons to match the reported player state (the
   * same .gp-hidden swap the main start/pause buttons use). Guarded so the
   * ~4Hz infoDelivery stream doesn't produce redundant DOM writes.
   */
  private updateMusicButtons(state: number) {
    if (state === this.musicPlayerState) return;
    this.musicPlayerState = state;
    const playing = state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING;
    this.musicPlayBtn?.toggleClass("gp-hidden", playing);
    this.musicPauseBtn?.toggleClass("gp-hidden", !playing);
  }

  /**
   * Surface a *lasting* BUFFERING state as a Notice — a network stall is just
   * silence with the player hidden. Armed once per stall episode (on the
   * transition into BUFFERING), disarmed the moment any other state arrives;
   * normal track starts and brief rebuffers stay under the delay. The player
   * self-recovers when the connection returns, so this only informs — it never
   * pauses or reloads anything. Rate-limited so a flapping connection doesn't
   * nag: at most one notice per MUSIC_STALL_RENOTIFY_MS.
   */
  private maybeNotifyMusicStalled(state: number) {
    if (state !== YT_STATE.BUFFERING) {
      if (this.musicStallTimeout !== null) {
        window.clearTimeout(this.musicStallTimeout);
        this.musicStallTimeout = null;
      }
      return;
    }
    // Arm only on the transition into BUFFERING — the ~4Hz infoDelivery stream
    // repeats the state, and after the timeout fires (timeout null, state still
    // BUFFERING) those repeats must not re-arm it within the same episode.
    if (this.musicStallTimeout !== null || this.musicPlayerState === YT_STATE.BUFFERING) return;
    this.musicStallTimeout = window.setTimeout(() => {
      this.musicStallTimeout = null;
      const now = Date.now();
      if (
        now - this.musicStallNotifiedAt < MUSIC_STALL_RENOTIFY_MS &&
        this.musicStallNotifiedAt !== 0
      )
        return;
      this.musicStallNotifiedAt = now;
      new Notice(
        "Gentle pomodoro: the music is buffering — slow or lost connection. It resumes by itself once the network is back; if it stays silent, press ⏹ then ♪ to reload."
      );
    }, MUSIC_STALL_NOTICE_DELAY_MS);
  }

  /**
   * Surface a *lasting* ENDED state as a Notice — with the player hidden there
   * is nothing to show that playback truly stopped (a finished video with loop
   * off, or a live stream going offline). Playlist auto-advance and loop
   * restarts pass through ENDED and resume within ~a second, so the Notice is
   * armed on a playing→ENDED transition and disarmed if playback resumes
   * before MUSIC_ENDED_NOTICE_DELAY_MS.
   */
  private maybeNotifyMusicEnded(state: number) {
    if (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING) {
      if (this.musicEndedTimeout !== null) {
        window.clearTimeout(this.musicEndedTimeout);
        this.musicEndedTimeout = null;
      }
      return;
    }
    const wasAudible =
      this.musicPlayerState === YT_STATE.PLAYING || this.musicPlayerState === YT_STATE.BUFFERING;
    if (state === YT_STATE.ENDED && wasAudible && this.musicEndedTimeout === null) {
      this.musicEndedTimeout = window.setTimeout(() => {
        this.musicEndedTimeout = null;
        new Notice(
          "Gentle pomodoro: the music ended — a live stream may have gone offline. Press ♪ to play again or paste a new link."
        );
      }, MUSIC_ENDED_NOTICE_DELAY_MS);
    }
  }

  /**
   * Surface an embed error as a Notice — with the player hidden there is no
   * visible error screen, so without this a broken URL is just a dead Play
   * button. Once per iframe build (the embed can re-emit onError).
   */
  private notifyMusicError(code: number) {
    if (this.musicErrorNotified) return;
    this.musicErrorNotified = true;
    const message =
      code === 101 || code === 150
        ? "Gentle pomodoro: this video doesn't allow embedding — try another URL."
        : "Gentle pomodoro: the music video can't be played (unavailable or restricted).";
    new Notice(message);
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

  private getDayNightIcon(state: TimerState): DayNightIcon {
    if (state.mode === "focus") {
      if (state.remainingMs <= 0) return "moon";
      if (state.remainingMs <= state.totalMs / 2) return "sunset";
      return "sun";
    }

    if (state.remainingMs <= 0) return "sun";
    if (state.remainingMs <= state.totalMs / 2) return "sunrise";
    return "moon";
  }

  /** Re-render the task picker. Sources tasks via taskLoader so regex parsing stays centralized. */
  async loadTasks() {
    this.taskListContainer.empty();

    const clearItem = this.taskListContainer.createDiv("gp-task-item");
    clearItem.addClass("gp-task-item-clear");
    setIcon(clearItem, "x-circle");
    clearItem.createSpan({ text: "Unlink Current Task" });

    this.registerDomEvent(clearItem, "click", () => {
      this.timer.setTask(NO_TASK_LABEL);
      this.taskListVisible = false;
      this.taskListContainer.removeClass("gp-visible");
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
        item.createSpan({ text: task.displayText });

        if (
          task.cleanText === this.timer.currentTaskName &&
          task.path === this.timer.currentTaskPath
        ) {
          item.addClass("gp-task-selected");
          const iconContainer = item.createDiv("gp-task-check-icon");
          setIcon(iconContainer, "check");
        }

        this.registerDomEvent(item, "click", () => {
          this.timer.setTask(task.cleanText, task.path, task.taskId);
          this.taskListVisible = false;
          this.taskListContainer.removeClass("gp-visible");
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
        // via the lastAppliedMusicVolume guard in their applySettings.
        this.postMusicVolume();
      }
    );

    section("Auto-start");
    toggleRow("Auto-start break", settings.autoStartBreak, async (v) => {
      settings.autoStartBreak = v;
      await this.plugin.saveSettings();
    });
    toggleRow("Auto-start focus", settings.autoStartFocus, async (v) => {
      settings.autoStartFocus = v;
      await this.plugin.saveSettings();
    });

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
      await this.plugin.saveSettings();
      this.timer.updateDuration("focus", settings.focusMinutes);
      this.timer.updateDuration("break", settings.breakMinutes);
      this.postMusicVolume();
      this.renderSettingsPanel();
    });
  }
}
