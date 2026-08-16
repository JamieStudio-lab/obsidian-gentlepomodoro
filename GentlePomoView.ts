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
  MUSIC_HANDSHAKE_RETRY_MS,
  MUSIC_HANDSHAKE_MAX_ATTEMPTS,
  MUSIC_DUCK_FACTOR,
  MUSIC_DUCK_DOWN_MS,
  MUSIC_DUCK_UP_MS,
  MUSIC_DUCK_STEP_MS,
  MUSIC_FADE_IN_MS,
  MUSIC_FADE_OUT_MS,
  MUSIC_FADE_STEP_MS,
  MUSIC_FADE_ARM_TIMEOUT_MS,
  MUSIC_FADE_HOLD_MAX_MS,
  MUSIC_ENDED_NOTICE_DELAY_MS,
  MUSIC_STALL_NOTICE_DELAY_MS,
  MUSIC_STALL_RENOTIFY_MS,
  RESUME_SEEK_LANDING_TOLERANCE_S,
} from "./constants";
import { TimerEngine } from "./TimerEngine";
import { loadTasks as fetchTasks, groupTasksByDate } from "./taskLoader";
import { buildDayNightIcon, DAY_NIGHT_ICON_ORDER, type DayNightIcon } from "./icons";
import { logger } from "./logger";
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
  describeMusicError,
  musicVolumeTo100,
  buildVolumeRamp,
  buildFadeRamp,
  isResumablePosition,
  planResume,
  type ResumePlan,
} from "./youtubeMusic";

declare const moment: MomentFactory;

/** How many volume posts fit into `durationMs` at `stepMs` apart — at least one. */
function rampSteps(durationMs: number, stepMs: number): number {
  return Math.max(1, Math.round(durationMs / stepMs));
}

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
  private musicHandshakeInterval: number | null = null; // re-sends until the embed answers
  private musicHandshakeAttempts = 0;
  private musicPlayerReady = false;
  // Where to address commands. Depending on the video the embed bounces from
  // the nocookie origin we loaded to www.youtube.com, and postMessage delivers
  // nothing when targetOrigin doesn't match the frame's *current* origin — so
  // this tracks the origin the player last spoke from (always one of
  // YT_ALLOWED_MESSAGE_ORIGINS, checked on the way in) rather than assuming.
  private musicPlayerOrigin: string = YT_EMBED_ORIGIN;
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
  private pendingResumeSeconds: number | null = null; // one-shot: seek here once playback starts
  private resumeSeekLanding: number | null = null; // seek posted, waiting for the clock to catch up
  // Music volume ramps. One channel serves both the sound-cue duck and the
  // ▶️/⏸/⏹ fades, so they can never post over each other. musicRampLevel is the
  // last 0–1 volume actually posted by a ramp — the start point for the next one
  // (so overlapping ramps never jump) and, when non-null, the "the player is not
  // simply sitting at the user's volume" marker.
  private musicRampInterval: number | null = null;
  private duckRestoreTimeout: number | null = null;
  private musicFadeArmTimeout: number | null = null; // "playback never started" backstop
  private musicRampLevel: number | null = null;
  // Fade phase. "armed" = ▶️ pressed and the volume parked at 0, waiting for
  // playback to actually start; "in"/"out" = a fade ramp is running. A fade owns
  // the volume for its whole life, so ducking stands down while one is in flight.
  private musicFadePhase: "armed" | "in" | "out" | null = null;
  // ⏹ pressed: the fade-out is still playing audio, but the position has already
  // been forgotten and must not be recorded again on the way down.
  private musicStopPending = false;

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
  // lastMusicSeekSeconds together gate iframe rebuilds (an offset no longer shows
  // up in the URL); lastAppliedMusicVolume gates setVolume posts.
  private lastMusicKey: string | null = null;
  private lastMusicEmbedUrl: string | null = null;
  private lastMusicSeekSeconds: number | null = null;
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

    // The ▶️ row is the only playback UI — the YouTube iframe below is a
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
      // Park the volume at silence and arm the fade — it starts for real when
      // playback does, so it isn't spent on the buffering gap before any audio.
      // (Or, if this press landed inside a fade-out, cancel that and ease back
      // up from where it got to — the player never stopped.)
      this.armMusicFadeIn();
      this.postToMusicPlayer(buildPlayerCommand("playVideo"));
    });

    this.musicPauseBtn = musicRow.createEl("button", { cls: "gp-btn gp-icon-btn gp-hidden" });
    setIcon(this.musicPauseBtn, "pause");
    this.musicPauseBtn.setAttribute("aria-label", "Pause music");
    this.registerDomEvent(this.musicPauseBtn, "click", (evt) => {
      evt.preventDefault();
      // Fade first, pause on landing: pausing up front would cut the audio dead
      // and leave the fade nothing to fade.
      this.fadeMusicOut(() => this.postToMusicPlayer(buildPlayerCommand("pauseVideo")));
    });

    const musicStopBtn = musicRow.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(musicStopBtn, "square");
    musicStopBtn.setAttribute("aria-label", "Stop music");
    this.registerDomEvent(musicStopBtn, "click", (evt) => {
      evt.preventDefault();
      // Stop means "start from the top next time" — pause is what remembers.
      // Dropping the pending seek is what makes that true within this session
      // too; the embed URL itself never carried the offset.
      //
      // All of it lands *with* the stopVideo, not on the click: ▶️ pressed
      // inside the fade-out cancels the stop, and a half-applied stop would
      // outlive it (a nulled musicCurrentDuration alone kills position
      // recording for the rest of the track — isResumablePosition reads a null
      // duration as "live stream"). musicStopPending is the one thing set now,
      // because audio keeps running through the fade and those last reported
      // seconds must not bank a position the stop is about to drop.
      this.musicStopPending = true;
      this.fadeMusicOut(() => {
        this.postToMusicPlayer(buildPlayerCommand("stopVideo"));
        this.plugin.clearMusicPosition();
        this.pendingResumeSeconds = null;
        // A seek posted but never landed would otherwise keep blocking
        // trackMusicPosition against an offset the restarted track has to climb
        // all the way back to before recording anything.
        this.resumeSeekLanding = null;
        this.musicCurrentDuration = null;
        // A stop that landed on an already-halted player is settled right here:
        // no straggler clock can pass trackMusicPosition's audibility gate, and
        // there may be no further state transition to settle it later. When the
        // player was still running, the flag must survive until the embed
        // reports the halt (handleMusicState clears it) — the embed keeps
        // reporting PLAYING clocks for a beat after stopVideo, and those must
        // not re-bank the position just cleared.
        if (!this.isAudibleState(this.musicPlayerState)) this.musicStopPending = false;
      });
    });

    this.musicPlayerContainer = this.musicSection.createDiv("gp-music-player");

    // The embed talks back over the shared window message bus. Source and
    // origin are checked before parsing — everything else on the bus is noise.
    this.registerDomEvent(window, "message", (evt: MessageEvent) => {
      if (!this.musicIframe || evt.source !== this.musicIframe.contentWindow) return;
      if (!YT_ALLOWED_MESSAGE_ORIGINS.includes(evt.origin)) return;
      // Address every later command to wherever the player actually is. Pinning
      // to the origin we loaded meant that once a video bounced the frame to
      // www.youtube.com, playVideo/setVolume/seekTo were all dropped by the
      // browser — no error, no state change, and the player still looking ready.
      this.musicPlayerOrigin = evt.origin;
      // Any message at all means the embed heard the handshake — even one this
      // parser goes on to discard. Stop re-sending it.
      this.stopMusicHandshakeRetries();
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
      // An edited URL retires the position recorded under the old one. Runs
      // before the plan is worked out, so the edit is honoured on the very
      // rebuild it triggers rather than one change later.
      this.plugin.retireMusicPositionOnUrlChange();
      const target = this.plugin.settings.showMusicPlayer
        ? parseYouTubeUrl(this.plugin.settings.musicUrl)
        : null;
      // Work out the remembered position here, at build time — deliberately NOT
      // part of musicKey, since keying on a value that moves every second would
      // rebuild the iframe ~20×/sec. The offset is carried as a pending seek,
      // not baked into the URL, so the embed stays exactly what 0.5.2 built.
      // While a ⏹ is pending, plan as if the store were already empty: its
      // clearMusicPosition rides in the fade landing, and a rebuild inside that
      // window (flipping Loop, say) would otherwise snapshot the position the
      // stop is in the middle of forgetting and seed the new iframe with it.
      const plan = target
        ? planResume(
            target,
            this.musicStopPending ? null : this.plugin.musicResumeState(),
            this.plugin.settings.musicUrl
          )
        : null;
      const embedUrl = plan ? buildEmbedUrl(plan.target, this.plugin.settings.musicLoop) : null;
      const seekSeconds = plan?.seekSeconds ?? null;
      this.musicSectionVisible = embedUrl !== null;
      this.musicSection?.toggleClass("gp-hidden", !this.musicSectionVisible);
      // The seek joins the URL in the rebuild decision because no offset reaches
      // the embed URL any more: editing only a t= leaves the built URL identical,
      // and without this the new offset would be computed and then dropped on the
      // floor. Bounded by the musicKey guard, so it can only fire on a real edit.
      if (embedUrl !== this.lastMusicEmbedUrl || seekSeconds !== this.lastMusicSeekSeconds) {
        this.lastMusicEmbedUrl = embedUrl;
        this.lastMusicSeekSeconds = seekSeconds;
        this.destroyMusicIframe();
        if (embedUrl !== null && plan !== null) this.buildMusicIframe(embedUrl, plan);
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
  private buildMusicIframe(embedUrl: string, plan: ResumePlan) {
    // Seed the resume bookkeeping from the target. videoId matters for a plain
    // video, where the embed's videoData may never tell us anything we don't
    // already know; inside a playlist the stream corrects it as items advance.
    this.musicCurrentVideoId = plan.target.videoId;
    this.musicTargetPlaylistId = plan.target.playlistId;
    this.musicCurrentDuration = null;
    this.pendingResumeSeconds = plan.seekSeconds;
    this.resumeSeekLanding = null;

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
        this.beginMusicHandshake();
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
    // came from, so saving the *outgoing* one here is correct even mid-swap —
    // unless ⏹ was pressed and its fade never landed, in which case the stop is
    // honoured instead. Banking a position the user just asked to forget would
    // be the wrong answer to the last button they pressed.
    if (this.musicStopPending) this.plugin.clearMusicPosition();
    else this.plugin.flushMusicPosition();
    this.pendingResumeSeconds = null;
    this.resumeSeekLanding = null;
    this.musicCurrentVideoId = null;
    this.musicCurrentDuration = null;
    this.musicTargetPlaylistId = null;
    this.musicStopPending = false;
    // Drops the ramp timers along with any pauseVideo/stopVideo still waiting on
    // one — the iframe is going away, and removing it is what stops playback.
    this.cancelMusicRamps();
    if (this.musicListenTimeout !== null) {
      window.clearTimeout(this.musicListenTimeout);
      this.musicListenTimeout = null;
    }
    this.stopMusicHandshakeRetries();
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
    // Back to the origin the next iframe is loaded from — a learned one belongs
    // to the frame that taught it, and the next video may not bounce at all.
    this.musicPlayerOrigin = YT_EMBED_ORIGIN;
    this.musicErrorNotified = false;
    this.lastAppliedMusicVolume = null;
    this.updateMusicButtons(YT_STATE.UNSTARTED);
  }

  private postToMusicPlayer(payload: string) {
    this.musicIframe?.contentWindow?.postMessage(payload, this.musicPlayerOrigin);
  }

  /**
   * The handshake is the one message that goes out before the embed has told us
   * anything, so there is no learned origin yet — and if the player has already
   * bounced to www.youtube.com, a nocookie-addressed handshake is dropped and
   * the embed never streams a single event (the panel then reports "the music
   * player hasn't loaded" forever). Sent to every origin the embed may
   * legitimately be on instead: only the frame's actual origin receives it, the
   * browser drops the rest, so the player is never handed a duplicate.
   */
  private postMusicHandshake() {
    const payload = buildListeningMessage();
    for (const origin of YT_ALLOWED_MESSAGE_ORIGINS) {
      this.musicIframe?.contentWindow?.postMessage(payload, origin);
    }
  }

  /** Send the handshake and keep sending until the embed answers (or the
   *  attempts run out). See MUSIC_HANDSHAKE_RETRY_MS for why one shot isn't
   *  enough off the desktop. */
  private beginMusicHandshake() {
    this.stopMusicHandshakeRetries();
    this.musicHandshakeAttempts = 0;
    this.postMusicHandshake();
    this.musicHandshakeInterval = window.setInterval(() => {
      this.musicHandshakeAttempts++;
      // The iframe check matters: teardown clears this interval, but a rebuild
      // racing the tick would otherwise post into the outgoing frame.
      if (this.musicIframe === null || this.musicHandshakeAttempts > MUSIC_HANDSHAKE_MAX_ATTEMPTS) {
        this.stopMusicHandshakeRetries();
        return;
      }
      this.postMusicHandshake();
    }, MUSIC_HANDSHAKE_RETRY_MS);
  }

  private stopMusicHandshakeRetries() {
    if (this.musicHandshakeInterval === null) return;
    window.clearInterval(this.musicHandshakeInterval);
    this.musicHandshakeInterval = null;
  }

  private postMusicVolume() {
    // A fade owns the volume from the ▶️/⏸/⏹ press until it lands — jumping the
    // player to full volume mid-fade is exactly the jolt the fade exists to
    // remove. The fade-in re-reads the setting when it lands, so a volume
    // change made mid-fade still arrives. Deliberately does NOT stamp
    // lastAppliedMusicVolume: leaving it stale keeps applySettings' convergence
    // check firing, so if a fade ever ends without applying the volume itself,
    // the next tick heals it rather than the control going quietly dead.
    //
    // A running fade-in is re-aimed rather than dropped: its ramp was built to
    // a target snapshotted at the start, so leaving it alone would climb to the
    // old volume and only then jump to the new one. 0.5.0's promise is that
    // changing the music volume always wins immediately.
    if (this.musicFadePhase === "in") {
      // Stamped here precisely because the ramp is what applies it now: leaving
      // it stale would have the ~20Hz convergence check rebuild the ramp on
      // every tick, restarting it faster than a single step could ever fire.
      this.lastAppliedMusicVolume = this.plugin.settings.musicVolume;
      this.beginMusicFadeIn();
      return;
    }
    if (this.musicFadePhase !== null) return;
    // An explicit volume set (segmented control, reset, cross-view reconcile)
    // always wins over an in-flight duck.
    this.cancelMusicRamps();
    this.postToMusicPlayer(
      buildPlayerCommand("setVolume", [musicVolumeTo100(this.plugin.settings.musicVolume)])
    );
    this.lastAppliedMusicVolume = this.plugin.settings.musicVolume;
  }

  /**
   * ▶️ pressed: park the player at silence and arm the fade-in. The ramp itself
   * waits for the first PLAYING state (see handleMusicState) — playVideo is
   * followed by a buffering gap with no audio in it, and a fade spent on
   * silence is a fade nobody hears.
   *
   * This also cancels whatever the previous press left running. A fade-out
   * still on its way down is abandoned here, which is what makes ⏸ → ▶️ during
   * a fade simply carry on playing: the pending pauseVideo/stopVideo lives in
   * the ramp's completion callback, so dropping the ramp drops the command too.
   */
  private armMusicFadeIn() {
    // Read before the clear: a player still running here means the press landed
    // inside a fade-out that had not yet paused or stopped it.
    const stillRunning = this.isAudibleState(this.musicPlayerState);
    this.clearMusicRampTimers();
    this.musicStopPending = false;
    if (stillRunning) {
      // The player never actually stopped, so playVideo changes nothing and no
      // state transition need ever arrive — an armed fade could wait forever
      // with the volume parked at 0. Ease straight back up from wherever the
      // abandoned fade-out got to instead; that is also the smoother sound. If
      // it happens to be mid-rebuffer, the ramp's own hold covers the silence.
      this.setMusicButtonsPlaying(true);
      this.beginMusicFadeIn();
      return;
    }
    this.musicFadePhase = "armed";
    this.musicRampLevel = 0;
    this.postToMusicPlayer(buildPlayerCommand("setVolume", [0]));
    this.scheduleMusicFadeArmBackstop();
    // A cancelled fade-out already flipped the buttons to "paused" — put back
    // whatever the player is really doing.
    this.setMusicButtonsPlaying(this.isAudibleState(this.musicPlayerState));
  }

  /**
   * Backstop for the "armed" phase: if playback never starts, stand the fade
   * down rather than leave the player silent with postMusicVolume locked out.
   * A player that is merely buffering slowly hands over to the ramp instead,
   * which holds itself until audio starts — cancelling there would make a slow
   * connection snap in at full volume once it finally plays.
   */
  private scheduleMusicFadeArmBackstop() {
    if (this.musicFadeArmTimeout !== null) window.clearTimeout(this.musicFadeArmTimeout);
    this.musicFadeArmTimeout = window.setTimeout(() => {
      this.musicFadeArmTimeout = null;
      if (this.musicFadePhase !== "armed") return;
      if (this.isAudibleState(this.musicPlayerState)) {
        this.beginMusicFadeIn();
        return;
      }
      this.musicFadePhase = null;
      this.postMusicVolume();
    }, MUSIC_FADE_ARM_TIMEOUT_MS);
  }

  /** Run the armed fade-in, now that audio is actually flowing. */
  private beginMusicFadeIn() {
    const from = this.musicRampLevel ?? 0;
    this.clearMusicRampTimers(); // drops the arm backstop; the fade is under way
    this.musicFadePhase = "in";
    this.runMusicRamp(
      buildFadeRamp(
        from,
        this.plugin.settings.musicVolume,
        rampSteps(MUSIC_FADE_IN_MS, MUSIC_FADE_STEP_MS)
      ),
      MUSIC_FADE_STEP_MS,
      () => {
        this.musicFadePhase = null;
        // Exact landing on the volume as it stands *now* (the setting may have
        // changed mid-fade) plus the lastAppliedMusicVolume bookkeeping.
        this.postMusicVolume();
      },
      // Only spend the fade on audible time. A resumed track rebuffers right
      // here — the seekTo goes out on the first audible state, usually the
      // BUFFERING just before this one — and without the hold the whole ramp
      // would run through that silence and the music would arrive at full
      // volume, no fade heard. Bounded, so a player that never comes back
      // can't strand the ramp half-way up.
      () => this.musicPlayerState !== YT_STATE.PLAYING
    );
  }

  /**
   * ⏸/⏹ pressed: ease the volume down to silence, then run `onLanding` — the
   * pauseVideo or stopVideo that actually halts playback. Posting that command
   * first would cut the audio dead and leave the fade nothing to fade.
   *
   * Skips straight to the command when there is nothing to fade: the player
   * isn't ready, isn't running, or is already silent because ▶️ was pressed and
   * playback never started. ⏹ on an idle player therefore still forgets the
   * position instantly. The player is deliberately left at volume 0 afterwards
   * — it's paused, so that is inaudible, and ▶️ re-parks it at 0 regardless.
   */
  private fadeMusicOut(onLanding: () => void) {
    const from = this.musicRampLevel ?? this.plugin.settings.musicVolume;
    this.clearMusicRampTimers();
    // Swap the buttons now rather than a fade-length later, so the press never
    // looks ignored. The only thing that un-does the pending command is a ▶️
    // press, and that puts the buttons back itself.
    this.setMusicButtonsPlaying(false);
    if (!this.musicPlayerReady || !this.isAudibleState(this.musicPlayerState) || from <= 0) {
      this.musicFadePhase = null;
      onLanding();
      return;
    }
    this.musicFadePhase = "out";
    this.runMusicRamp(
      buildFadeRamp(from, 0, rampSteps(MUSIC_FADE_OUT_MS, MUSIC_FADE_STEP_MS)),
      MUSIC_FADE_STEP_MS,
      () => {
        this.musicFadePhase = null;
        onLanding();
      }
    );
  }

  /**
   * Dip the music under a sound cue: a quick stepped ramp to MUSIC_DUCK_FACTOR
   * × the user's volume, hold for the cue's duration, then a slower ease back
   * up. (A ramp *down* in the ordinary case — but see below: catching a fade-in
   * part-way means moving up to the ducked level rather than down to it.)
   * Called (via the plugin) from TimerEngine.playSound with
   * the decoded clip's length. A cue landing mid-duck restarts the hold from the
   * current level — extend, never double-dip. No-op unless the player is ready
   * and actually playing (pre-handshake commands are dropped by the embed anyway).
   *
   * A ▶️ fade-in does NOT block the duck — that would leave a cue playing over
   * music rising to full volume, which is exactly what ducking exists to
   * prevent, and "press ▶️, then press Start" puts the war drum right in that
   * window. The duck simply takes the volume over: it ramps from wherever the
   * fade had reached and its restore ramp finishes the job of bringing the
   * music up. Clearing the phase is what keeps the abandoned fade from
   * stranding it (its landing callback dies with the replaced ramp). A fade-OUT
   * still wins: the player is about to pause, so there is nothing to duck.
   */
  duckMusic(cueDurationSec: number) {
    const playing = this.isAudibleState(this.musicPlayerState);
    if (!this.musicPlayerReady || !playing || this.musicFadePhase === "out") return;

    const base = this.plugin.settings.musicVolume;
    const target = base * MUSIC_DUCK_FACTOR;
    const from = this.musicRampLevel ?? base;
    this.clearMusicRampTimers();
    this.musicFadePhase = null;
    // The duck is aimed at the setting as it stands, so record that. A fade the
    // duck just took over may have left the stamp stale (its skip path in
    // postMusicVolume deliberately doesn't stamp), and a stale stamp here would
    // have the ~20Hz convergence check cancel this duck on the very next tick —
    // full volume under the cue, the exact thing ducking exists to prevent.
    this.lastAppliedMusicVolume = base;
    this.runMusicRamp(
      buildVolumeRamp(from, target, rampSteps(MUSIC_DUCK_DOWN_MS, MUSIC_DUCK_STEP_MS)),
      MUSIC_DUCK_STEP_MS
    );
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
    const from = this.musicRampLevel ?? userVolume * MUSIC_DUCK_FACTOR;
    this.runMusicRamp(
      buildVolumeRamp(from, userVolume, rampSteps(MUSIC_DUCK_UP_MS, MUSIC_DUCK_STEP_MS)),
      MUSIC_DUCK_STEP_MS,
      () => {
        // Exact landing + lastAppliedMusicVolume bookkeeping (the cancel inside
        // clears musicRampLevel, ending the duck).
        this.postMusicVolume();
      }
    );
  }

  /**
   * Post a stepped volume ramp — one setVolume per `stepMs`, or none at all on
   * a tick `holdWhile` holds — and run `onDone` on the last step. Replaces any
   * running ramp, which is also how a pending pauseVideo/stopVideo gets
   * cancelled: it lives in that callback and a replaced ramp never reaches it.
   */
  private runMusicRamp(
    levels: number[],
    stepMs: number,
    onDone?: () => void,
    holdWhile?: () => boolean
  ) {
    if (this.musicRampInterval !== null) window.clearInterval(this.musicRampInterval);
    let i = 0;
    let held = 0;
    const maxHeld = Math.floor(MUSIC_FADE_HOLD_MAX_MS / stepMs);
    this.musicRampInterval = window.setInterval(() => {
      // A held tick posts nothing and advances nothing — the ramp simply waits
      // for audio to come back, up to the bound.
      if (holdWhile?.() === true && held < maxHeld) {
        held++;
        return;
      }
      const level = levels[i++];
      this.musicRampLevel = level;
      this.postToMusicPlayer(buildPlayerCommand("setVolume", [musicVolumeTo100(level)]));
      if (i >= levels.length && this.musicRampInterval !== null) {
        window.clearInterval(this.musicRampInterval);
        this.musicRampInterval = null;
        onDone?.();
      }
    }, stepMs);
  }

  /** Drop any in-flight ramp — duck or fade — and all of its state. Restores
   *  nothing: callers either post the user volume next (postMusicVolume) or are
   *  tearing the iframe down. Any pending pauseVideo/stopVideo goes with it. */
  private cancelMusicRamps() {
    this.clearMusicRampTimers();
    this.musicRampLevel = null;
    this.musicFadePhase = null;
  }

  private clearMusicRampTimers() {
    if (this.musicRampInterval !== null) {
      window.clearInterval(this.musicRampInterval);
      this.musicRampInterval = null;
    }
    if (this.duckRestoreTimeout !== null) {
      window.clearTimeout(this.duckRestoreTimeout);
      this.duckRestoreTimeout = null;
    }
    if (this.musicFadeArmTimeout !== null) {
      window.clearTimeout(this.musicFadeArmTimeout);
      this.musicFadeArmTimeout = null;
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
      // A ⏹ whose stopVideo has gone out (no fade still running) is settled the
      // moment the embed reports a halt: the straggler window musicStopPending
      // exists for — PLAYING clocks arriving after the stop — closes on this
      // transition, and from here the audibility gate blocks recording anyway.
      // Leaving the flag up would keep position recording dead through a later
      // resume (media keys never pass through ▶️, which is the other clearer).
      if (this.musicStopPending && this.musicFadePhase === null && !this.isAudibleState(state)) {
        this.musicStopPending = false;
      }
      if (state === YT_STATE.PAUSED) {
        // The position only lives in memory while playing — pausing is the
        // boundary that has to reach disk, and it's the main way users leave.
        this.plugin.flushMusicPosition();
      } else if (state === YT_STATE.ENDED) {
        // Finished: next time this track opens at the top. With loop on, the
        // restart re-records from ~0 a moment later.
        this.plugin.clearMusicPosition();
      } else if (this.pendingResumeSeconds !== null && this.isAudibleState(state)) {
        // Resume, the moment playback actually starts. Seeking is documented as
        // safe only from a running player (from a *cued* one it would start
        // playback, which is exactly the auto-play this feature must not do), so
        // the offset waits here rather than riding along in the embed URL.
        // BUFFERING usually arrives first, so the jump lands before any audio.
        const seconds = this.pendingResumeSeconds;
        this.pendingResumeSeconds = null;
        // Consumed either way — a seek that isn't posted now must not fire on
        // some later transition. A non-positive duration is how the embed
        // reports a live stream: an offset means nothing on one (YouTube
        // ignored `start=` there outright), and seeking would land far outside
        // the DVR window. Only skipped when we positively know it's live —
        // duration stays null until the info stream carries one, and for an
        // ordinary video the seek is the entire point. Stored positions are
        // never live (isResumablePosition refuses them); a pasted t= can be.
        if (this.musicCurrentDuration === null || this.musicCurrentDuration > 0) {
          this.resumeSeekLanding = seconds;
          this.postToMusicPlayer(buildPlayerCommand("seekTo", [seconds, true]));
        }
      }
      // The armed fade-in starts the moment audio does — PLAYING, not
      // BUFFERING, which is still silence. It stands down only on a genuine
      // halt (PAUSED/ENDED — iOS pausing on background, an external pause):
      // the embed can report transient UNSTARTED/CUED on its way to playing,
      // and treating those as dead ends would cancel the fade and let the
      // music snap in at full volume. A player that truly never starts is the
      // arm timeout's job, and ⏸/⏹ pressed during the gap resolve the phase in
      // their own handlers.
      if (this.musicFadePhase === "armed") {
        if (state === YT_STATE.PLAYING) {
          this.beginMusicFadeIn();
        } else if (state === YT_STATE.PAUSED || state === YT_STATE.ENDED) {
          this.musicFadePhase = null;
          this.postMusicVolume();
        }
      } else if (
        this.musicFadePhase === null &&
        this.isAudibleState(state) &&
        !this.isAudibleState(this.musicPlayerState) &&
        this.musicRampInterval === null &&
        this.duckRestoreTimeout === null &&
        this.musicRampLevel !== null
      ) {
        // The player left a halted state while the volume was parked below the
        // setting with no ramp left to lift it — a landed ⏸/⏹ fade leaves the
        // embed at 0, and hardware media keys can resume it without going
        // through ▶️. In 0.5.3 this was audible (pause kept the user volume);
        // silent playback with ⏸ showing would be the regression. Requiring the
        // *previous* state to be halted is what keeps this off the stragglers a
        // landing races (a PLAYING report crossing the just-posted pauseVideo
        // arrives from a still-audible previous state). Unreachable during a
        // duck (its hold keeps duckRestoreTimeout set) and during our own ▶️
        // press (the phase is "armed" there).
        if (state === YT_STATE.PLAYING) {
          this.beginMusicFadeIn();
        } else {
          // BUFFERING: audio hasn't started — re-arm instead of fading through
          // the silence, and the existing armed machinery finishes the job.
          this.musicFadePhase = "armed";
          this.scheduleMusicFadeArmBackstop();
        }
      }
    }
    this.maybeNotifyMusicStalled(state);
    this.maybeNotifyMusicEnded(state);
    this.updateMusicButtons(state);
  }

  /** Playing or buffering — i.e. the player is running, not cued or paused. */
  private isAudibleState(state: number): boolean {
    return state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING;
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
    if (!this.isAudibleState(this.musicPlayerState)) return;
    // ⏹ Stop forgets the position on the click, but audio keeps running through
    // the fade-out — without this, those last reported seconds would bank the
    // very position that was just cleared. Cleared again on the next ▶️ press.
    if (this.musicStopPending) return;
    // A resume seek is posted while the embed is still reporting the old clock,
    // so ignore readings until it lands — otherwise the first ~second of
    // playback overwrites the very position we just asked it to jump to. If the
    // seek is never honoured nothing is recorded, which leaves the stored
    // position intact and the next open resumes from it again.
    if (this.resumeSeekLanding !== null) {
      if (seconds < this.resumeSeekLanding - RESUME_SEEK_LANDING_TOLERANCE_S) return;
      this.resumeSeekLanding = null;
    }
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
   * Swap the ▶️ play/pause buttons to match the reported player state (the
   * same .gp-hidden swap the main start/pause buttons use). Guarded so the
   * ~4Hz infoDelivery stream doesn't produce redundant DOM writes.
   */
  private updateMusicButtons(state: number) {
    if (state === this.musicPlayerState) return;
    this.musicPlayerState = state;
    // A fade-out wins: the player genuinely keeps running through it, so a
    // rebuffer or a playlist advance landing mid-fade would otherwise put the
    // ⏸ button back moments after the user pressed it.
    this.setMusicButtonsPlaying(this.musicFadePhase === "out" ? false : this.isAudibleState(state));
  }

  /**
   * Do the ▶️/⏸ swap itself. Split out of updateMusicButtons so a fade-out can
   * flip the buttons the moment it starts: the pause/stop command is already
   * guaranteed to go out, and waiting a fade-length for YouTube to confirm it
   * would leave the button looking dead. Deliberately does NOT touch
   * musicPlayerState — the real transition still has to arrive for the
   * position flush, the resume seek and the notices to run off it.
   */
  private setMusicButtonsPlaying(playing: boolean) {
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
        "Gentle pomodoro: the music is buffering — slow or lost connection. It resumes by itself once the network is back; if it stays silent, press ⏹ then ▶️ to reload."
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
   *
   * Never armed during a ⏸/⏹ fade-out. The user has just asked for silence and
   * the audio runs on for the length of the fade, so a track that happens to
   * end inside that window would answer the button press with "the music ended
   * — paste a new link". Stopping on purpose is not news.
   */
  private maybeNotifyMusicEnded(state: number) {
    if (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING) {
      if (this.musicEndedTimeout !== null) {
        window.clearTimeout(this.musicEndedTimeout);
        this.musicEndedTimeout = null;
      }
      return;
    }
    if (this.musicFadePhase === "out") return;
    const wasAudible =
      this.musicPlayerState === YT_STATE.PLAYING || this.musicPlayerState === YT_STATE.BUFFERING;
    if (state === YT_STATE.ENDED && wasAudible && this.musicEndedTimeout === null) {
      this.musicEndedTimeout = window.setTimeout(() => {
        this.musicEndedTimeout = null;
        new Notice(
          "Gentle pomodoro: the music ended — a live stream may have gone offline. Press ▶️ to play again or paste a new link."
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
    // Logged as well as shown: the Notice is transient, and this is the one
    // signal that says whether a "it won't play on my iPad" report is a plugin
    // bug or YouTube refusing the video on that platform.
    logger.warn(`Music player error ${String(code)} for ${this.plugin.settings.musicUrl}`);
    new Notice(`Gentle pomodoro: ${describeMusicError(code, Platform.isIosApp)}`);
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
