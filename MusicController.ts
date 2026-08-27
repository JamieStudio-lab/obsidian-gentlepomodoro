import { logger } from "./logger";
import {
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
  MUSIC_ADVANCE_NOTICE_GRACE_MS,
  MUSIC_STALL_NOTICE_DELAY_MS,
  MUSIC_STALL_RENOTIFY_MS,
  RESUME_SEEK_LANDING_TOLERANCE_S,
} from "./constants";
import {
  YT_EMBED_ORIGIN,
  YT_ALLOWED_MESSAGE_ORIGINS,
  YT_STATE,
  buildPlayerCommand,
  buildListeningMessage,
  parsePlayerMessage,
  describeMusicError,
  musicVolumeTo100,
  buildVolumeRamp,
  buildFadeRamp,
  isResumablePosition,
  visibleNameText,
  musicPositionAppliesToUrl,
  type ResumePlan,
  type MusicResumeState,
} from "./youtubeMusic";

/** How many volume posts fit into `durationMs` at `stepMs` apart — at least one. */
function rampSteps(durationMs: number, stepMs: number): number {
  return Math.max(1, Math.round(durationMs / stepMs));
}

/**
 * Everything the music state machine needs from outside itself: a clock, the
 * hidden player it drives, the store it reports positions to, and the handful
 * of statements it makes to the user.
 *
 * Injecting all four is the entire point of this class. Every music defect this
 * plugin has shipped was a *sequencing* rule — "read this field before clearing
 * that timer", "post the command on the ramp's landing, not up front" — and
 * neither the type checker nor a pure-helper test can reach one. A fake clock
 * and a recording message sink can.
 */
export interface MusicHost {
  /* --- clock: window.* in the app, a controllable fake in tests --- */
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;

  /* --- the hidden player --- */
  /** Mount the iframe at `src`; call `onLoad` when it fires its load event. */
  mountPlayer(src: string, onLoad: () => void): void;
  /** Remove it. Removal is what stops playback — there is no stop command here. */
  unmountPlayer(): void;
  /** postMessage into the mounted frame, addressed to one origin. No-op when nothing is mounted. */
  postToPlayer(payload: string, origin: string): void;
  /** postMessage into the mounted frame once per origin — the handshake, which
   *  goes out before any origin has been learned. */
  broadcastToPlayer(payload: string, origins: readonly string[]): void;

  /* --- settings & persistence --- */
  musicVolume(): number;
  recordPosition(position: MusicResumeState): void;
  clearPosition(url: string | null): void;
  flushPosition(): void;

  /* --- what the panel says --- */
  /** The transport now shows playing / paused: swap the buttons and repaint the caption. */
  setTransportPlaying(playing: boolean): void;
  /** The track under the current station changed (its title, or the playlist context). */
  onTrackChanged(): void;
  notice(message: string): void;
  /** Platform.isIosApp — error 153 is a platform limit there, not a bad link. */
  isIosApp(): boolean;
}

/**
 * A ⏭ press, captured before the settings write it has to wait on. Compared
 * against the controller's state afterwards to decide whether the press still
 * means anything.
 */
export interface StationHandOff {
  /** Which mounted frame was playing. A rebuild is what makes the hand-off necessary. */
  generation: number;
  /** Bumped by every ⏸/⏹, so a press landing inside the write cancels the hand-off. */
  token: number;
}

/**
 * The lofi player's state machine: transport, volume ramps (fades and ducking
 * share one channel), the postMessage handshake, and the resume bookkeeping.
 *
 * Extracted from GentlePomoView in 0.5.8 as a pure move — no DOM, no
 * `obsidian` import, no `window`. Everything it touches arrives through
 * MusicHost. The ordering comments throughout are the specification: they
 * record bugs that shipped, and re-ordering the statements they sit above
 * re-introduces those bugs silently.
 */
export class MusicController {
  private readonly host: MusicHost;

  private playerMounted = false;
  /** Bumped on every mount. Identifies "a different frame" for the ⏭ hand-off. */
  private frameGeneration = 0;
  private listenTimeout: number | null = null;
  private handshakeInterval: number | null = null; // re-sends until the embed answers
  private handshakeAttempts = 0;
  private playerReady = false;
  // Where to address commands. Depending on the video the embed bounces from
  // the nocookie origin we loaded to www.youtube.com, and postMessage delivers
  // nothing when targetOrigin doesn't match the frame's *current* origin — so
  // this tracks the origin the player last spoke from (always one of
  // YT_ALLOWED_MESSAGE_ORIGINS, checked on the way in) rather than assuming.
  private playerOrigin: string = YT_EMBED_ORIGIN;
  private playerState: number = YT_STATE.UNSTARTED;
  private errorNotified = false; // one Notice per iframe build
  private endedTimeout: number | null = null; // pending "music ended" Notice
  private stallTimeout: number | null = null; // pending "music is buffering" Notice
  private stallNotifiedAt = 0; // rate-limits stall notices (0 = never fired)
  // Resume bookkeeping. The embed reports its clock/metadata piecemeal over
  // infoDelivery, so the controller keeps the running picture and hands whole
  // positions to the store (which owns persistence).
  // The musicUrl *setting* this iframe was built from — the provenance stamped
  // on any position it reports. Read at build time and frozen here on purpose:
  // both settings paths assign settings.musicUrl and only then `await
  // saveSettings()`, and the outgoing iframe keeps streaming its ~4Hz clock
  // across that await. Reading the live setting when a sample lands would stamp
  // the OLD track's position with the NEW URL, at which point both of 0.5.6's
  // guards see a match and the offset is applied to a URL it never came from.
  private currentSourceUrl: string | null = null;
  private currentVideoId: string | null = null; // seeded from the URL, corrected by videoData
  private currentDuration: number | null = null; // null/0 ⇒ live stream: nothing to resume
  private targetPlaylistId: string | null = null; // list context of the loaded embed
  /** Title of the item the embed is actually on; only shown for a playlist. */
  private currentVideoTitle: string | null = null;
  private pendingResumeSeconds: number | null = null; // one-shot: seek here once playback starts
  private resumeSeekLanding: number | null = null; // seek posted, waiting for the clock to catch up
  // Volume ramps. One channel serves both the sound-cue duck and the ▶️/⏸/⏹
  // fades, so they can never post over each other. rampLevel is the last 0–1
  // volume actually posted by a ramp — the start point for the next one (so
  // overlapping ramps never jump) and, when non-null, the "the player is not
  // simply sitting at the user's volume" marker.
  private rampInterval: number | null = null;
  private duckRestoreTimeout: number | null = null;
  /** When an in-flight duck is owed until, so a skip's fade can restore it. */
  private duckHoldUntilMs: number | null = null;
  private fadeArmTimeout: number | null = null; // "playback never started" backstop
  private rampLevel: number | null = null;
  // Fade phase. "armed" = ▶️ pressed and the volume parked at 0, waiting for
  // playback to actually start; "in"/"out" = a fade ramp is running. A fade owns
  // the volume for its whole life, so ducking stands down while one is in flight.
  private fadePhase: "armed" | "in" | "out" | null = null;
  // ⏹ pressed: the fade-out is still playing audio, but the position has already
  // been forgotten and must not be recorded again on the way down.
  private stopPending = false;
  private lastAppliedVolume: number | null = null;
  /** What the transport is currently showing; the caption's wording follows it. */
  private showingPlaying = false;
  // When ⏩ last asked the playlist to advance. Only used to hold the
  // "the music ended" notice, which is wrong in answer to that button.
  private advanceRequestedAt: number | null = null;
  // The station URL a ⏭ press asked to keep playing, or null. Stores the URL
  // rather than a boolean so a flag that outlives its rebuild can never fire on
  // an unrelated one — the stranded-auto-play hazard 0.5.7 rejected switching
  // auto-play over. Lives on the controller (one per view), never in settings:
  // switching writes a shared setting and every open panel rebuilds, so a
  // persisted flag would have every panel start playing at once.
  private autoPlayOnReady: string | null = null;
  // Bumped by fadeOut alone. A ⏭ arms the hand-off only AFTER awaiting the
  // settings write, so without this a ⏸/⏹ landing inside that await has nothing
  // to cancel — the rebuild then erases every other trace of the press and the
  // new station plays anyway. Deliberately NOT bumped in destroy(): teardown
  // runs *inside* that same await, so it would mismatch on every press and the
  // hand-off would never fire at all.
  private handOffToken = 0;

  constructor(host: MusicHost) {
    this.host = host;
  }

  /* ===== What the view reads ===== */

  /** Whether the transport is showing "playing" right now — the caption's wording. */
  get showingAsPlaying(): boolean {
    return this.showingPlaying;
  }

  /** The playlist context of the loaded embed, or null for a plain video. */
  get playlistId(): string | null {
    return this.targetPlaylistId;
  }

  /** The title of the item the embed is on, or null. */
  get videoTitle(): string | null {
    return this.currentVideoTitle;
  }

  /** The station URL the mounted frame was built for, frozen at build time. */
  get sourceUrl(): string | null {
    return this.currentSourceUrl;
  }

  /** Whether a ⏭ press is still waiting for its player to load. */
  get handOffPending(): boolean {
    return this.autoPlayOnReady !== null;
  }

  /**
   * Whether the user would say music is playing right now. Deliberately not
   * shared with updateButtons, which reads the incoming state and skips the
   * readiness check.
   *
   * A running fade-out counts as NOT playing even though playerState is still
   * PLAYING: setButtonsPlaying deliberately does not advance that field, so the
   * player is audible but on its way to a pause the user already asked for.
   * Same for a pending ⏹.
   */
  isPlayingForUser(): boolean {
    if (!this.playerReady) return false;
    if (this.stopPending) return false;
    // Read the transport, do not re-derive it. A fade-out is NOT by itself a
    // pause any more: since ⏩/⏪ started fading, fadePhase === "out" covers a
    // skip too, and treating that as stopped made ⏭ pressed inside a skip hand
    // over nothing — the new station loaded silent while the panel still read
    // "Now playing". The mirror was worse: a ⏸ landing nulls fadePhase while
    // playerState is still PLAYING until the embed answers, so for that round
    // trip the old predicate said "playing" with ▶️ already showing, and ⏭ would
    // answer a pause with sound. showingPlaying is set by setButtonsPlaying,
    // which ⏸/⏹ drive and a skip deliberately does not.
    return this.showingPlaying;
  }

  /**
   * Whether a pending ⏹ should suppress the resume plan for `url`.
   *
   * The pending stop belongs to the OUTGOING station only — stopPending is set
   * on the ⏹ click and not cleared until destroy() or the embed reports the
   * halt, both of which run *after* the incoming plan is worked out. A station
   * switch inside that window therefore used to plan the INCOMING station
   * against an empty store, opening it from the top and then overwriting the
   * position it should have resumed. Trim-tolerant via the shared helper:
   * data.json is hand-editable.
   */
  stopSuppressesResumeFor(url: string): boolean {
    return this.stopPending && musicPositionAppliesToUrl(this.currentSourceUrl, url);
  }

  /* ===== Lifecycle ===== */

  /**
   * Create the hidden YouTube player and start the postMessage handshake:
   * after the frame's load event, wait a beat (the embed isn't ready the
   * instant it loads), then announce {"event":"listening"} so it starts
   * streaming onReady/onStateChange/infoDelivery/onError back to us.
   */
  build(embedUrl: string, plan: ResumePlan, sourceUrl: string): void {
    // Seed the resume bookkeeping from the target. videoId matters for a plain
    // video, where the embed's videoData may never tell us anything we don't
    // already know; inside a playlist the stream corrects it as items advance.
    this.currentVideoId = plan.target.videoId;
    this.targetPlaylistId = plan.target.playlistId;
    // Frozen for this frame's lifetime — see the field's comment. Passed in
    // rather than read from settings so it cannot drift from the station this
    // build is actually for: it is the stamp every recorded position carries,
    // and reading the live setting here would label this station's position
    // with whatever slot happens to be active when the sample lands.
    this.currentSourceUrl = sourceUrl;
    this.currentDuration = null;
    this.pendingResumeSeconds = plan.seekSeconds;
    this.resumeSeekLanding = null;

    this.playerMounted = true;
    this.frameGeneration++;
    this.host.mountPlayer(embedUrl, () => {
      if (this.listenTimeout !== null) this.host.clearTimeout(this.listenTimeout);
      this.listenTimeout = this.host.setTimeout(() => {
        this.listenTimeout = null;
        this.beginHandshake();
      }, MUSIC_LISTENING_DELAY_MS);
    });
  }

  /**
   * Tear the player down — removal from the DOM is what stops playback.
   * Also resets the handshake/volume state so a rebuilt player starts fresh.
   */
  destroy(): void {
    // Teardown is a boundary: closing the panel, moving the leaf, or changing
    // the URL all end playback. The pending position is keyed by the video it
    // came from, so saving the *outgoing* one here is correct even mid-swap —
    // unless ⏹ was pressed and its fade never landed, in which case the stop is
    // honoured instead. Banking a position the user just asked to forget would
    // be the wrong answer to the last button they pressed.
    // Reads currentSourceUrl while it is still set — the null below is what
    // makes this ordering load-bearing. Resolving the station from settings
    // here would be wrong: teardown is invoked FROM the switch's own rebuild,
    // so by this point the settings already name the INCOMING station.
    // A hand-off belongs to the frame it was armed for; this one is going away.
    // (The ⏭ path arms AFTER its rebuild, so it never clears its own flag.)
    this.autoPlayOnReady = null;
    if (this.stopPending) this.host.clearPosition(this.currentSourceUrl);
    else this.host.flushPosition();
    this.pendingResumeSeconds = null;
    this.resumeSeekLanding = null;
    this.currentVideoId = null;
    this.currentVideoTitle = null;
    // The track half of the caption belongs to the frame being torn down.
    // targetPlaylistId is nulled below, so this drops it rather than leaving
    // the previous playlist's item named under a new station.
    this.targetPlaylistId = null;
    this.host.onTrackChanged();
    this.currentDuration = null;
    this.currentSourceUrl = null;
    this.stopPending = false;
    // Drops the ramp timers along with any pauseVideo/stopVideo still waiting on
    // one — the player is going away, and removing it is what stops playback.
    this.cancelRamps();
    if (this.listenTimeout !== null) {
      this.host.clearTimeout(this.listenTimeout);
      this.listenTimeout = null;
    }
    this.stopHandshakeRetries();
    if (this.endedTimeout !== null) {
      this.host.clearTimeout(this.endedTimeout);
      this.endedTimeout = null;
    }
    if (this.stallTimeout !== null) {
      this.host.clearTimeout(this.stallTimeout);
      this.stallTimeout = null;
    }
    this.host.unmountPlayer();
    this.playerMounted = false;
    this.playerReady = false;
    // Back to the origin the next frame is loaded from — a learned one belongs
    // to the frame that taught it, and the next video may not bounce at all.
    this.playerOrigin = YT_EMBED_ORIGIN;
    this.errorNotified = false;
    this.lastAppliedVolume = null;
    // This is ALSO what resets playerState — updateButtons assigns it before
    // doing the swap. Never reset that field separately above this line: the
    // swap sits behind the method's `state === playerState` early return, so a
    // pre-reset silently kills the ▶️/⏸ restore and leaves ⏸ on screen with no
    // play button after every teardown-while-playing.
    this.updateButtons(YT_STATE.UNSTARTED);
  }

  /* ===== Inbound messages ===== */

  /**
   * Handle one message from the embed. The caller has already checked that it
   * came from the mounted frame; the origin allowlist is checked here.
   */
  handleFrameMessage(origin: string, data: unknown): void {
    if (!YT_ALLOWED_MESSAGE_ORIGINS.includes(origin)) return;
    // Address every later command to wherever the player actually is. Pinning
    // to the origin we loaded meant that once a video bounced the frame to
    // www.youtube.com, playVideo/setVolume/seekTo were all dropped by the
    // browser — no error, no state change, and the player still looking ready.
    this.playerOrigin = origin;
    // Any message at all means the embed heard the handshake — even one this
    // parser goes on to discard. Stop re-sending it.
    this.stopHandshakeRetries();
    const msg = parsePlayerMessage(data);
    if (!msg) return;
    if (msg.type === "ready") {
      this.playerReady = true;
      // Apply the saved volume as soon as the player can take commands.
      this.postVolume();
      // Hand a ⏭ press over to the station it actually asked for. The stored
      // URL is compared against the one THIS frame was built for, so a flag
      // that somehow outlived its rebuild dies here instead of starting music
      // the user never asked to hear.
      const handOffTo = this.autoPlayOnReady;
      this.autoPlayOnReady = null;
      if (handOffTo !== null && handOffTo === this.currentSourceUrl) {
        this.startPlayback();
      }
    } else if (msg.type === "error") {
      this.notifyError(msg.code);
    } else if (msg.type === "state") {
      this.handleState(msg.state);
    } else {
      // infoDelivery: merge whatever this message carried, position before
      // state so a transition into PAUSED flushes the freshest clock value.
      if (msg.videoId !== null) this.currentVideoId = msg.videoId;
      if (msg.videoTitle !== null) {
        // Assigned unconditionally, even when it reduces to nothing: guarding
        // on "is it visible?" would leave the PREVIOUS item's title standing
        // as the playlist advances, naming the wrong track — worse than no
        // name. visibleNameText also collapses whitespace, keeping a
        // network-sourced value out of the newline-delimited caption key.
        this.currentVideoTitle = visibleNameText(msg.videoTitle);
        this.host.onTrackChanged();
      }
      if (msg.duration !== null) this.currentDuration = msg.duration;
      if (msg.currentTime !== null) this.trackPosition(msg.currentTime);
      if (msg.state !== null) this.handleState(msg.state);
    }
  }

  /* ===== Transport (the buttons) ===== */

  /** ▶️ pressed. */
  pressPlay(): void {
    // Pre-handshake commands are silently dropped by the embed — without
    // this, playing while offline (or mid-boot) is just a dead button.
    if (!this.playerReady) {
      this.host.notice(
        "Gentle pomodoro: the music player hasn't loaded yet — wait a moment, or check your connection if you're offline."
      );
      return;
    }
    // Park the volume at silence and arm the fade — it starts for real when
    // playback does, so it isn't spent on the buffering gap before any audio.
    // (Or, if this press landed inside a fade-out, cancel that and ease back
    // up from where it got to — the player never stopped.)
    this.startPlayback();
  }

  /** ⏸ pressed. Fade first, pause on landing: pausing up front would cut the
   *  audio dead and leave the fade nothing to fade. */
  pressPause(): void {
    this.fadeOut(() => this.postToPlayer(buildPlayerCommand("pauseVideo")));
  }

  /**
   * ⏹ pressed. Stop means "start from the top next time" — pause is what
   * remembers. Dropping the pending seek is what makes that true within this
   * session too; the embed URL itself never carried the offset.
   *
   * All of it lands *with* the stopVideo, not on the click: ▶️ pressed inside
   * the fade-out cancels the stop, and a half-applied stop would outlive it (a
   * nulled currentDuration alone kills position recording for the rest of the
   * track — isResumablePosition reads a null duration as "live stream").
   * stopPending is the one thing set now, because audio keeps running through
   * the fade and those last reported seconds must not bank a position the stop
   * is about to drop.
   */
  pressStop(): void {
    this.stopPending = true;
    // Which station this Stop belongs to, frozen at click time. The clear below
    // runs on the fade's landing ~450ms later, by which point the user may have
    // switched stations — reading the active URL there would forget the
    // incoming station's position instead of this one's.
    const stopUrl = this.currentSourceUrl;
    this.fadeOut(() => {
      this.postToPlayer(buildPlayerCommand("stopVideo"));
      this.host.clearPosition(stopUrl);
      this.pendingResumeSeconds = null;
      // A seek posted but never landed would otherwise keep blocking
      // trackPosition against an offset the restarted track has to climb all
      // the way back to before recording anything.
      this.resumeSeekLanding = null;
      this.currentDuration = null;
      // A stop that landed on an already-halted player is settled right here:
      // no straggler clock can pass trackPosition's audibility gate, and there
      // may be no further state transition to settle it later. When the player
      // was still running, the flag must survive until the embed reports the
      // halt (handleState clears it) — the embed keeps reporting PLAYING clocks
      // for a beat after stopVideo, and those must not re-bank the position
      // just cleared.
      if (!this.isAudibleState(this.playerState)) this.stopPending = false;
    });
  }

  /** ⏩ / ⏪ pressed: move within the playlist. */
  stepPlaylist(direction: "nextVideo" | "previousVideo"): void {
    if (this.fadePhase === "out" || this.stopPending) return;
    if (!this.playerReady) {
      this.host.notice(
        "Gentle pomodoro: the music player hasn't loaded yet — wait a moment, or check your connection if you're offline."
      );
      return;
    }
    if (!this.isAudibleState(this.playerState)) {
      this.host.notice(
        "Gentle pomodoro: press ▶️ first — skipping tracks needs the music playing."
      );
      return;
    }
    // Ride the same ramp ▶️/⏸/⏹ use: fade the outgoing track down, switch on the
    // landing, and let the fade-in carry the new one up. Posting nextVideo bare
    // cut one track dead and dropped the next in at full volume, which is the
    // one thing this feature family exists to avoid.
    //
    // The transport keeps showing "playing" throughout — this is a skip, not a
    // pause. And because the pending switch lives in the ramp's completion
    // callback, a ⏸ or ⏹ landing inside the fade cancels the advance and wins,
    // which is the behaviour that reads correctly.
    this.fadeOut(() => {
      // Stamped here rather than at the click: this is the moment ENDED could
      // fire, and the grace window should start from it.
      this.advanceRequestedAt = this.host.now();
      // A seek posted for the OUTGOING item must not outlive it. trackPosition
      // ignores every clock reading below resumeSeekLanding, so leaving it
      // armed means the new item records nothing until its clock climbs past
      // the old item's offset — on a resumed long track, the rest of the
      // session. Cleared on the landing, so an advance that a ⏸ cancels leaves
      // the outgoing item's bookkeeping untouched.
      this.pendingResumeSeconds = null;
      this.resumeSeekLanding = null;
      // currentDuration and currentVideoId are deliberately NOT cleared.
      // duration rides only the fuller payloads that accompany a state change,
      // and an advance that turns out to be a no-op produces no state change at
      // all — so a nulled duration would never be restored, and
      // isResumablePosition reads a null duration as "live stream" and stops
      // recording for the rest of the track. The stream corrects both fields.
      this.postToPlayer(buildPlayerCommand(direction));
      // Ease the new item up from the silence the fade-out left. The player was
      // never halted, so armFadeIn takes its "still running" branch and ramps
      // straight up from rampLevel (0) — and that ramp holds itself while the
      // new item buffers, so the rise is spent on audio rather than on the gap
      // before it.
      this.armFadeIn();
      // Hand the cue its dip back. fadeOut cleared duckRestoreTimeout, which was
      // the only thing holding it, so without this the music swells to full
      // volume under a bell that is still ringing — fade trap 4, via a path that
      // did not exist before skips faded. fadePhase is "in" here, which is
      // exactly the branch duck() is built to take over.
      const owed = this.duckHoldUntilMs;
      if (owed !== null && owed > this.host.now()) this.duck((owed - this.host.now()) / 1000);
    }, true);
  }

  /* ===== ⏭ station hand-off ===== */

  /**
   * Capture the state a ⏭ press starts from, before the settings write it has
   * to wait on. saveSettings is a real file write; a ⏸ or ⏹ can land while it
   * is out.
   */
  snapshotHandOff(): StationHandOff {
    return { generation: this.frameGeneration, token: this.handOffToken };
  }

  /**
   * Carry playback across a station switch, if the press still means anything.
   *
   * Switching tears the player down, which is what stops the audio, so
   * continuing means starting the NEW one once it is ready — never a fade
   * across the gap. A fade would have to carry "now actually switch" in a ramp
   * completion callback, and cancelRamps drops those, so a duck or a ▶️ inside
   * the window would leave the setting changed and the player not.
   */
  armHandOff(snapshot: StationHandOff): void {
    // Two slots may hold identical URLs, in which case the embed key never
    // moves, nothing is torn down and the music never stopped — handing over
    // there would drop it to silence and swell it back for no reason.
    if (!this.playerMounted || this.frameGeneration === snapshot.generation) return;
    // Pausing or stopping during the write cancels the hand-off, exactly as it
    // does after one. Without this the press has nothing to cancel: the rebuild
    // clears fadePhase and stopPending on its way through.
    if (snapshot.token !== this.handOffToken) return;
    this.autoPlayOnReady = this.currentSourceUrl;
  }

  /* ===== Volume ===== */

  /**
   * Apply the volume setting now, unconditionally — an explicit set from the
   * in-view control or a reset-to-defaults, which always wins over an in-flight
   * duck and re-aims a running fade-in.
   */
  applyVolume(): void {
    this.postVolume();
  }

  /**
   * Converge the player on the volume setting. Called from the view's per-tick
   * reconcile, so it must be a cheap no-op once applied — a change made in
   * another panel, or a reload while the player was still booting, is what this
   * catches.
   */
  syncVolume(): void {
    if (!this.playerReady || this.host.musicVolume() === this.lastAppliedVolume) return;
    this.postVolume();
  }

  /**
   * Dip the music under a sound cue: a quick stepped ramp to MUSIC_DUCK_FACTOR
   * × the user's volume, hold for the cue's duration, then a slower ease back
   * up. (A ramp *down* in the ordinary case — but see below: catching a fade-in
   * part-way means moving up to the ducked level rather than down to it.)
   * Called (via the plugin) from TimerEngine.playSound with the decoded clip's
   * length. A cue landing mid-duck restarts the hold from the current level —
   * extend, never double-dip. No-op unless the player is ready and actually
   * playing (pre-handshake commands are dropped by the embed anyway).
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
  duck(cueDurationSec: number): void {
    // Stamped before every guard, so a cue that arrives mid-skip (when the
    // "out" guard below turns it away) still records how long the dip owes.
    this.duckHoldUntilMs = this.host.now() + Math.max(cueDurationSec * 1000, MUSIC_DUCK_DOWN_MS);
    const playing = this.isAudibleState(this.playerState);
    if (!this.playerReady || !playing || this.fadePhase === "out") return;

    const base = this.host.musicVolume();
    const target = base * MUSIC_DUCK_FACTOR;
    const from = this.rampLevel ?? base;
    this.clearRampTimers();
    this.fadePhase = null;
    // The duck is aimed at the setting as it stands, so record that. A fade the
    // duck just took over may have left the stamp stale (its skip path in
    // postVolume deliberately doesn't stamp), and a stale stamp here would have
    // the ~20Hz convergence check cancel this duck on the very next tick — full
    // volume under the cue, the exact thing ducking exists to prevent.
    this.lastAppliedVolume = base;
    this.runRamp(
      buildVolumeRamp(from, target, rampSteps(MUSIC_DUCK_DOWN_MS, MUSIC_DUCK_STEP_MS)),
      MUSIC_DUCK_STEP_MS
    );
    // The down-ramp runs under the cue's attack; restore starts when the clip ends.
    const holdMs = Math.max(cueDurationSec * 1000, MUSIC_DUCK_DOWN_MS);
    this.duckRestoreTimeout = this.host.setTimeout(() => {
      this.duckRestoreTimeout = null;
      this.restoreDucked();
    }, holdMs);
  }

  /* ===== Internals: playback ===== */

  /**
   * Start playback the way ▶️ does: park the volume at silence and arm the
   * fade, so it begins when audio does rather than being spent on the buffering
   * gap. Shared with the ⏭ hand-off so the two can never drift apart.
   */
  private startPlayback(): void {
    this.armFadeIn();
    this.postToPlayer(buildPlayerCommand("playVideo"));
  }

  private postToPlayer(payload: string): void {
    this.host.postToPlayer(payload, this.playerOrigin);
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
  private postHandshake(): void {
    this.host.broadcastToPlayer(buildListeningMessage(), YT_ALLOWED_MESSAGE_ORIGINS);
  }

  /** Send the handshake and keep sending until the embed answers (or the
   *  attempts run out). See MUSIC_HANDSHAKE_RETRY_MS for why one shot isn't
   *  enough off the desktop. */
  private beginHandshake(): void {
    this.stopHandshakeRetries();
    this.handshakeAttempts = 0;
    this.postHandshake();
    this.handshakeInterval = this.host.setInterval(() => {
      this.handshakeAttempts++;
      // The mounted check matters: teardown clears this interval, but a rebuild
      // racing the tick would otherwise post into the outgoing frame.
      if (!this.playerMounted || this.handshakeAttempts > MUSIC_HANDSHAKE_MAX_ATTEMPTS) {
        this.stopHandshakeRetries();
        return;
      }
      this.postHandshake();
    }, MUSIC_HANDSHAKE_RETRY_MS);
  }

  private stopHandshakeRetries(): void {
    if (this.handshakeInterval === null) return;
    this.host.clearInterval(this.handshakeInterval);
    this.handshakeInterval = null;
  }

  private postVolume(): void {
    // A fade owns the volume from the ▶️/⏸/⏹ press until it lands — jumping the
    // player to full volume mid-fade is exactly the jolt the fade exists to
    // remove. The fade-in re-reads the setting when it lands, so a volume
    // change made mid-fade still arrives. Deliberately does NOT stamp
    // lastAppliedVolume: leaving it stale keeps the view's convergence check
    // firing, so if a fade ever ends without applying the volume itself, the
    // next tick heals it rather than the control going quietly dead.
    //
    // A running fade-in is re-aimed rather than dropped: its ramp was built to
    // a target snapshotted at the start, so leaving it alone would climb to the
    // old volume and only then jump to the new one. 0.5.0's promise is that
    // changing the music volume always wins immediately.
    if (this.fadePhase === "in") {
      // Stamped here precisely because the ramp is what applies it now: leaving
      // it stale would have the ~20Hz convergence check rebuild the ramp on
      // every tick, restarting it faster than a single step could ever fire.
      this.lastAppliedVolume = this.host.musicVolume();
      this.beginFadeIn();
      return;
    }
    if (this.fadePhase !== null) return;
    // An explicit volume set (segmented control, reset, cross-view reconcile)
    // always wins over an in-flight duck.
    this.cancelRamps();
    this.postToPlayer(buildPlayerCommand("setVolume", [musicVolumeTo100(this.host.musicVolume())]));
    this.lastAppliedVolume = this.host.musicVolume();
  }

  /**
   * ▶️ pressed: park the player at silence and arm the fade-in. The ramp itself
   * waits for the first PLAYING state (see handleState) — playVideo is followed
   * by a buffering gap with no audio in it, and a fade spent on silence is a
   * fade nobody hears.
   *
   * This also cancels whatever the previous press left running. A fade-out
   * still on its way down is abandoned here, which is what makes ⏸ → ▶️ during
   * a fade simply carry on playing: the pending pauseVideo/stopVideo lives in
   * the ramp's completion callback, so dropping the ramp drops the command too.
   */
  private armFadeIn(): void {
    // Read before the clear: a player still running here means the press landed
    // inside a fade-out that had not yet paused or stopped it.
    const stillRunning = this.isAudibleState(this.playerState);
    this.clearRampTimers();
    this.stopPending = false;
    if (stillRunning) {
      // The player never actually stopped, so playVideo changes nothing and no
      // state transition need ever arrive — an armed fade could wait forever
      // with the volume parked at 0. Ease straight back up from wherever the
      // abandoned fade-out got to instead; that is also the smoother sound. If
      // it happens to be mid-rebuffer, the ramp's own hold covers the silence.
      this.setButtonsPlaying(true);
      this.beginFadeIn();
      return;
    }
    this.fadePhase = "armed";
    this.rampLevel = 0;
    this.postToPlayer(buildPlayerCommand("setVolume", [0]));
    this.scheduleFadeArmBackstop();
    // A cancelled fade-out already flipped the buttons to "paused" — put back
    // whatever the player is really doing.
    this.setButtonsPlaying(this.isAudibleState(this.playerState));
  }

  /**
   * Backstop for the "armed" phase: if playback never starts, stand the fade
   * down rather than leave the player silent with postVolume locked out.
   * A player that is merely buffering slowly hands over to the ramp instead,
   * which holds itself until audio starts — cancelling there would make a slow
   * connection snap in at full volume once it finally plays.
   */
  private scheduleFadeArmBackstop(): void {
    if (this.fadeArmTimeout !== null) this.host.clearTimeout(this.fadeArmTimeout);
    this.fadeArmTimeout = this.host.setTimeout(() => {
      this.fadeArmTimeout = null;
      if (this.fadePhase !== "armed") return;
      if (this.isAudibleState(this.playerState)) {
        this.beginFadeIn();
        return;
      }
      this.fadePhase = null;
      this.postVolume();
    }, MUSIC_FADE_ARM_TIMEOUT_MS);
  }

  /** Run the armed fade-in, now that audio is actually flowing. */
  private beginFadeIn(): void {
    const from = this.rampLevel ?? 0;
    this.clearRampTimers(); // drops the arm backstop; the fade is under way
    this.fadePhase = "in";
    this.runRamp(
      buildFadeRamp(from, this.host.musicVolume(), rampSteps(MUSIC_FADE_IN_MS, MUSIC_FADE_STEP_MS)),
      MUSIC_FADE_STEP_MS,
      () => {
        this.fadePhase = null;
        // Exact landing on the volume as it stands *now* (the setting may have
        // changed mid-fade) plus the lastAppliedVolume bookkeeping.
        this.postVolume();
      },
      // Only spend the fade on audible time. A resumed track rebuffers right
      // here — the seekTo goes out on the first audible state, usually the
      // BUFFERING just before this one — and without the hold the whole ramp
      // would run through that silence and the music would arrive at full
      // volume, no fade heard. Bounded, so a player that never comes back
      // can't strand the ramp half-way up.
      () => this.playerState !== YT_STATE.PLAYING
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
  private fadeOut(onLanding: () => void, keepShowingPlaying = false): void {
    // A ⏸ or ⏹ press always cancels a pending ⏭ hand-off, and it must be
    // cleared HERE rather than only in destroy(): the early return below lands
    // immediately and destroys nothing, so during the second or two a new
    // station takes to load, a press would otherwise leave the flag standing —
    // the stopVideo is dropped (no handshake yet), the incoming station's
    // position is wiped, and then the player becomes ready and starts playing.
    // The plugin would answer Stop with sound.
    this.autoPlayOnReady = null;
    this.handOffToken++;
    const from = this.rampLevel ?? this.host.musicVolume();
    this.clearRampTimers();
    // Swap the buttons now rather than a fade-length later, so the press never
    // looks ignored. The only thing that un-does the pending command is a ▶️
    // press, and that puts the buttons back itself.
    //
    // ⏩ opts out: skipping to the next track is not a pause, and flashing ▶️
    // (and "Music") for the length of the fade before flipping straight back
    // would read as the player stumbling.
    if (!keepShowingPlaying) this.setButtonsPlaying(false);
    if (!this.playerReady || !this.isAudibleState(this.playerState) || from <= 0) {
      this.fadePhase = null;
      onLanding();
      return;
    }
    this.fadePhase = "out";
    this.runRamp(
      buildFadeRamp(from, 0, rampSteps(MUSIC_FADE_OUT_MS, MUSIC_FADE_STEP_MS)),
      MUSIC_FADE_STEP_MS,
      () => {
        this.fadePhase = null;
        onLanding();
      }
    );
  }

  /** Ease the music back to the user's volume (re-read at restore time) and end the duck. */
  private restoreDucked(): void {
    const userVolume = this.host.musicVolume();
    const from = this.rampLevel ?? userVolume * MUSIC_DUCK_FACTOR;
    this.runRamp(
      buildVolumeRamp(from, userVolume, rampSteps(MUSIC_DUCK_UP_MS, MUSIC_DUCK_STEP_MS)),
      MUSIC_DUCK_STEP_MS,
      () => {
        // Exact landing + lastAppliedVolume bookkeeping (the cancel inside
        // clears rampLevel, ending the duck).
        this.postVolume();
      }
    );
  }

  /**
   * Post a stepped volume ramp — one setVolume per `stepMs`, or none at all on
   * a tick `holdWhile` holds — and run `onDone` on the last step. Replaces any
   * running ramp, which is also how a pending pauseVideo/stopVideo gets
   * cancelled: it lives in that callback and a replaced ramp never reaches it.
   */
  private runRamp(
    levels: number[],
    stepMs: number,
    onDone?: () => void,
    holdWhile?: () => boolean
  ): void {
    if (this.rampInterval !== null) this.host.clearInterval(this.rampInterval);
    let i = 0;
    let held = 0;
    const maxHeld = Math.floor(MUSIC_FADE_HOLD_MAX_MS / stepMs);
    this.rampInterval = this.host.setInterval(() => {
      // A held tick posts nothing and advances nothing — the ramp simply waits
      // for audio to come back, up to the bound.
      if (holdWhile?.() === true && held < maxHeld) {
        held++;
        return;
      }
      const level = levels[i++];
      this.rampLevel = level;
      this.postToPlayer(buildPlayerCommand("setVolume", [musicVolumeTo100(level)]));
      if (i >= levels.length && this.rampInterval !== null) {
        this.host.clearInterval(this.rampInterval);
        this.rampInterval = null;
        onDone?.();
      }
    }, stepMs);
  }

  /** Drop any in-flight ramp — duck or fade — and all of its state. Restores
   *  nothing: callers either post the user volume next (postVolume) or are
   *  tearing the player down. Any pending pauseVideo/stopVideo goes with it. */
  private cancelRamps(): void {
    this.clearRampTimers();
    this.rampLevel = null;
    this.fadePhase = null;
    // Deliberately here and not in clearRampTimers: a skip clears the timers
    // and must still owe the rest of the dip, whereas a teardown or an explicit
    // volume change ends the duck outright.
    this.duckHoldUntilMs = null;
  }

  private clearRampTimers(): void {
    if (this.rampInterval !== null) {
      this.host.clearInterval(this.rampInterval);
      this.rampInterval = null;
    }
    if (this.duckRestoreTimeout !== null) {
      this.host.clearTimeout(this.duckRestoreTimeout);
      this.duckRestoreTimeout = null;
    }
    if (this.fadeArmTimeout !== null) {
      this.host.clearTimeout(this.fadeArmTimeout);
      this.fadeArmTimeout = null;
    }
  }

  /* ===== Internals: reported state ===== */

  /**
   * React to a reported player state, from either onStateChange or an
   * infoDelivery that carried one.
   *
   * Ordering is load-bearing: updateButtons is what advances playerState, and
   * both the stall notice and the transition checks here read it as the
   * *previous* state, so it must stay last.
   */
  private handleState(state: number): void {
    if (state !== this.playerState) {
      // A ⏹ whose stopVideo has gone out (no fade still running) is settled the
      // moment the embed reports a halt: the straggler window stopPending
      // exists for — PLAYING clocks arriving after the stop — closes on this
      // transition, and from here the audibility gate blocks recording anyway.
      // Leaving the flag up would keep position recording dead through a later
      // resume (media keys never pass through ▶️, which is the other clearer).
      if (this.stopPending && this.fadePhase === null && !this.isAudibleState(state)) {
        this.stopPending = false;
      }
      if (state === YT_STATE.PAUSED) {
        // The position only lives in memory while playing — pausing is the
        // boundary that has to reach disk, and it's the main way users leave.
        this.host.flushPosition();
      } else if (state === YT_STATE.ENDED) {
        // Finished: next time this station opens at the top. With loop on, the
        // restart re-records from ~0 a moment later. Scoped to the station this
        // frame was built for, not the active setting.
        this.host.clearPosition(this.currentSourceUrl);
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
        if (this.currentDuration === null || this.currentDuration > 0) {
          this.resumeSeekLanding = seconds;
          this.postToPlayer(buildPlayerCommand("seekTo", [seconds, true]));
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
      if (this.fadePhase === "armed") {
        if (state === YT_STATE.PLAYING) {
          this.beginFadeIn();
        } else if (state === YT_STATE.PAUSED || state === YT_STATE.ENDED) {
          this.fadePhase = null;
          this.postVolume();
        }
      } else if (
        this.fadePhase === null &&
        this.isAudibleState(state) &&
        !this.isAudibleState(this.playerState) &&
        this.rampInterval === null &&
        this.duckRestoreTimeout === null &&
        this.rampLevel !== null
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
          this.beginFadeIn();
        } else {
          // BUFFERING: audio hasn't started — re-arm instead of fading through
          // the silence, and the existing armed machinery finishes the job.
          this.fadePhase = "armed";
          this.scheduleFadeArmBackstop();
        }
      }
    }
    this.maybeNotifyStalled(state);
    this.maybeNotifyEnded(state);
    this.updateButtons(state);
  }

  /** Playing or buffering — i.e. the player is running, not cued or paused. */
  private isAudibleState(state: number): boolean {
    return state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING;
  }

  /**
   * Hand a reported playback position to the store. Live streams and the final
   * seconds of a track are filtered out by isResumablePosition; the "too early
   * to bother resuming" floor lives on the *apply* side instead, so that a
   * restarted track immediately overwrites a stale offset here.
   *
   * Only an audibly-running player is recorded. A cued one also reports a clock
   * (at 0), which would otherwise let a second, idle panel — or the moment just
   * after ⏹ Stop — reset a position the playing panel had banked. Note the
   * state read here is the *previous* one (updateButtons advances it after this
   * runs), which is also what keeps the first 0 of a resumed track from
   * overwriting the very offset it was built with.
   */
  private trackPosition(seconds: number): void {
    if (!this.isAudibleState(this.playerState)) return;
    // ⏹ Stop forgets the position on the click, but audio keeps running through
    // the fade-out — without this, those last reported seconds would bank the
    // very position that was just cleared. Cleared again on the next ▶️ press.
    if (this.stopPending) return;
    // A resume seek is posted while the embed is still reporting the old clock,
    // so ignore readings until it lands — otherwise the first ~second of
    // playback overwrites the very position we just asked it to jump to. If the
    // seek is never honoured nothing is recorded, which leaves the stored
    // position intact and the next open resumes from it again.
    if (this.resumeSeekLanding !== null) {
      if (seconds < this.resumeSeekLanding - RESUME_SEEK_LANDING_TOLERANCE_S) return;
      this.resumeSeekLanding = null;
    }
    const videoId = this.currentVideoId;
    if (videoId === null) return;
    // Provenance comes from the frame, never from the live setting — see
    // currentSourceUrl. Null means no player is running, so there is nothing to
    // attribute the position to.
    const sourceUrl = this.currentSourceUrl;
    if (sourceUrl === null) return;
    if (!isResumablePosition(seconds, this.currentDuration)) return;
    this.host.recordPosition({
      videoId,
      playlistId: this.targetPlaylistId,
      seconds,
      url: sourceUrl,
    });
  }

  /**
   * Swap the ▶️ play/pause buttons to match the reported player state. Guarded
   * so the ~4Hz infoDelivery stream doesn't produce redundant DOM writes.
   */
  private updateButtons(state: number): void {
    if (state === this.playerState) return;
    this.playerState = state;
    // A fade-out wins: the player genuinely keeps running through it, so a
    // rebuffer or a playlist advance landing mid-fade would otherwise put the
    // ⏸ button back moments after the user pressed it.
    this.setButtonsPlaying(this.fadePhase === "out" ? false : this.isAudibleState(state));
  }

  /**
   * Do the ▶️/⏸ swap itself. Split out of updateButtons so a fade-out can flip
   * the buttons the moment it starts: the pause/stop command is already
   * guaranteed to go out, and waiting a fade-length for YouTube to confirm it
   * would leave the button looking dead. Deliberately does NOT touch
   * playerState — the real transition still has to arrive for the position
   * flush, the resume seek and the notices to run off it.
   */
  private setButtonsPlaying(playing: boolean): void {
    // The caption's wording is the same statement as the button's shape, so it
    // is driven from the same call rather than recomputed. Two reasons it must
    // be this and not isPlayingForUser():
    //
    //  - Order. fadeOut flips the buttons BEFORE it sets fadePhase to "out", so
    //    a recompute here still sees PLAYING and no fade — the caption would
    //    keep saying "Now playing" until the embed confirmed the pause a
    //    fade-length later.
    //  - Ownership. This is the single funnel for "what the transport now
    //    says", so routing the caption through it makes the two agree by
    //    construction instead of by two predicates staying in step.
    //
    // Assigned before the host is told, so the caption it repaints reads the
    // value this call is announcing rather than the previous one.
    this.showingPlaying = playing;
    this.host.setTransportPlaying(playing);
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
  private maybeNotifyStalled(state: number): void {
    if (state !== YT_STATE.BUFFERING) {
      if (this.stallTimeout !== null) {
        this.host.clearTimeout(this.stallTimeout);
        this.stallTimeout = null;
      }
      return;
    }
    // Arm only on the transition into BUFFERING — the ~4Hz infoDelivery stream
    // repeats the state, and after the timeout fires (timeout null, state still
    // BUFFERING) those repeats must not re-arm it within the same episode.
    if (this.stallTimeout !== null || this.playerState === YT_STATE.BUFFERING) return;
    this.stallTimeout = this.host.setTimeout(() => {
      this.stallTimeout = null;
      const now = this.host.now();
      if (now - this.stallNotifiedAt < MUSIC_STALL_RENOTIFY_MS && this.stallNotifiedAt !== 0)
        return;
      this.stallNotifiedAt = now;
      this.host.notice(
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
  private maybeNotifyEnded(state: number): void {
    if (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING) {
      if (this.endedTimeout !== null) {
        this.host.clearTimeout(this.endedTimeout);
        this.endedTimeout = null;
      }
      return;
    }
    if (this.fadePhase === "out") return;
    // A manual ⏩ that ran off the end of a non-looping playlist ends playback.
    // "A live stream may have gone offline — paste a new link" is nonsense in
    // answer to a button the user just pressed.
    if (
      this.advanceRequestedAt !== null &&
      this.host.now() - this.advanceRequestedAt < MUSIC_ADVANCE_NOTICE_GRACE_MS
    ) {
      return;
    }
    const wasAudible =
      this.playerState === YT_STATE.PLAYING || this.playerState === YT_STATE.BUFFERING;
    if (state === YT_STATE.ENDED && wasAudible && this.endedTimeout === null) {
      this.endedTimeout = this.host.setTimeout(() => {
        this.endedTimeout = null;
        this.host.notice(
          "Gentle pomodoro: the music ended — a live stream may have gone offline. Press ▶️ to play again or paste a new link."
        );
      }, MUSIC_ENDED_NOTICE_DELAY_MS);
    }
  }

  /**
   * Surface an embed error as a Notice — with the player hidden there is no
   * visible error screen, so without this a broken URL is just a dead Play
   * button. Once per player build (the embed can re-emit onError).
   */
  private notifyError(code: number): void {
    if (this.errorNotified) return;
    this.errorNotified = true;
    // Logged as well as shown: the Notice is transient, and this is the one
    // signal that says whether a "it won't play on my iPad" report is a plugin
    // bug or YouTube refusing the video on that platform.
    // The station this frame was built for, not the active setting — after a
    // switch the latter names a different link than the one that failed.
    logger.warn(`Music player error ${String(code)} for ${this.currentSourceUrl ?? "(none)"}`);
    this.host.notice(`Gentle pomodoro: ${describeMusicError(code, this.host.isIosApp())}`);
  }
}
