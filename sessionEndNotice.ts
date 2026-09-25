import { logger } from "./logger";
import type { PomoMode } from "./types";

/**
 * The opt-in system notification when a session's time is up (0.6.6, the
 * follow-up question on GitHub issue #4: "I forget to turn off the timer
 * because other windows cover Obsidian, and I keep the sound off").
 *
 * Neither thing the plugin already had could answer that. The status bar and
 * the panel are inside the window that is covered, and the chime is exactly
 * what that user has muted. A system notification is the one signal that lands
 * outside the window and needs no sound.
 *
 * It is SILENT on purpose, and that is load-bearing: sound is governed by the
 * "Timer sounds" switch, and a notification that beeped would walk straight
 * past a user's mute. It is also opt-in and off by default, for the reason the
 * zero crossing is silent in the first place — an interruption at minute 25 is
 * what this plugin exists to avoid (see CLAUDE.md, Important Quirks).
 *
 * Desktop only. Obsidian's desktop app grants the page's own permission
 * requests (checked in the 1.13.7 bundle: its `setPermissionRequestHandler`
 * allows any request from the app origin except `openExternal`), while the
 * mobile apps' web views have no `Notification` at all — so the host passes
 * `create: null` there and the settings rows are not built.
 *
 * Kept free of `obsidian` imports, like MusicController: every side effect
 * arrives through the host, so the rules below can be tested with a fake.
 */

/** Shared verbatim by the settings tab and the timer panel. */
export const SESSION_END_NOTIFICATION_LABEL = "Notify when time is up";

export const SESSION_END_NOTIFICATION_DESC =
  "Shows a silent system notification when focus or break time is up, so you notice even when other windows cover Obsidian.";

export interface NoticeText {
  title: string;
  body: string;
}

/**
 * What the notification says. It speaks about the session that ENDED, and
 * says what happens next, because the two cases need different things from
 * the reader: when the next session started on its own there is nothing to
 * do, and when it did not the timer is now counting overtime — which is the
 * "I forgot it was still running" the request was about.
 */
export function sessionEndNoticeText(endedMode: PomoMode, nextStarts: boolean): NoticeText {
  const focus = endedMode === "focus";
  const title = focus ? "Focus time is up" : "Break time is up";
  if (!nextStarts) return { title, body: "The timer keeps counting until you stop it." };
  return {
    title,
    body: focus ? "Your break has started." : "Your next focus session has started.",
  };
}

/**
 * Shown once when the switch is turned ON, from either surface. Not a
 * nicety: the first notification an app posts is often when the operating
 * system asks whether to allow them at all, and that question should come
 * while the user is looking at the switch — not at the end of a 25-minute
 * session, where the notice it was guarding would be the one that got lost.
 */
export const NOTIFICATION_PREVIEW_TEXT: NoticeText = {
  title: "Notifications are on",
  body: "You'll get one like this when focus or break time is up.",
};

/**
 * One tag for every notice this plugin posts. Chromium takes the tag as the
 * notification's identity, and Electron closes an earlier notification with
 * the same identity before showing the new one. That is what keeps Windows'
 * Action Center down to one entry: there, a toast that has timed off the
 * screen is already "closed" as far as the page knows, so the notifier's own
 * close() on it does nothing. `renotify` asks the replacement to alert like a
 * new notification — by the web spec a same-tag replacement may otherwise be
 * swapped in silently, which would defeat the point.
 */
export const NOTIFICATION_TAG = "gentle-pomodoro-time-up";

/** The options every notice is posted with. */
export interface NoticeOptions {
  body: string;
  silent: boolean;
  tag: string;
  renotify: boolean;
}

/** What the notifier keeps of a notification it posted. */
export interface ShownNotification {
  close(): void;
}

/**
 * Posts one notification. There is deliberately no click handler: on macOS the
 * system brings Obsidian forward when a notification is clicked, and elsewhere
 * a renderer's `window.focus()` does not raise Electron's native window, so a
 * handler would promise something it cannot do.
 */
export type NotificationFactory = (title: string, options: NoticeOptions) => ShownNotification;

/** The slice of the DOM's `Notification` constructor the factory uses. */
export type NotificationConstructor = new (
  title: string,
  options: NoticeOptions
) => ShownNotification;

/**
 * The real factory, or null where there is nothing to post with. The mobile
 * apps' web views have no `Notification`, and the platform cannot change under
 * a running plugin, so this is decided once. Both inputs are passed in rather
 * than read here so the module stays free of `obsidian` and the DOM, and so a
 * test can hand it a fake constructor.
 */
export function systemNotificationFactory(
  isDesktopApp: boolean,
  ctor: NotificationConstructor | undefined
): NotificationFactory | null {
  if (!isDesktopApp || !ctor) return null;
  return (title, options) => new ctor(title, options);
}

export interface SessionEndNotifierHost {
  /**
   * A call, never a captured value: loadSettings() replaces the settings
   * object wholesale, so a snapshot taken at construction would read the
   * pre-load settings forever.
   */
  enabled(): boolean;
  /** Null where the platform has no system notifications (the mobile apps). */
  create: NotificationFactory | null;
}

export class SessionEndNotifier {
  /**
   * The last notification posted, closed when the next one arrives so a day
   * of sessions does not stack a column of stale "time is up" notices. On
   * macOS that close is what does it; on Windows the shared tag does (see
   * NOTIFICATION_TAG).
   */
  private current: ShownNotification | null = null;

  /**
   * Set by dispose() and never cleared. An auto-start that was mid-way through
   * its vault writes when the plugin unloaded used to restart the tick
   * afterwards, and a notifier that still worked then kept posting from a
   * plugin the user had switched off. TimerEngine.dispose() is terminal now,
   * so the engine no longer calls in after unload; this flag keeps the
   * notifier's own promise — nothing after dispose — without relying on that.
   */
  private disposed = false;

  constructor(private readonly host: SessionEndNotifierHost) {}

  /** Called at the zero crossing, whichever way the session goes on from it. */
  sessionEnded(endedMode: PomoMode, nextStarts: boolean): void {
    if (!this.host.enabled()) return;
    this.show(sessionEndNoticeText(endedMode, nextStarts));
  }

  /** Called when the user turns the switch on. Not gated on the setting: the caller just set it. */
  preview(): void {
    this.show(NOTIFICATION_PREVIEW_TEXT);
  }

  dispose(): void {
    this.disposed = true;
    this.closeCurrent();
  }

  private show(text: NoticeText): void {
    const create = this.host.create;
    if (!create || this.disposed) return;
    this.closeCurrent();
    try {
      this.current = create(text.title, {
        body: text.body,
        silent: true,
        tag: NOTIFICATION_TAG,
        renotify: true,
      });
    } catch (error) {
      // A notification is a courtesy. Failing to post one must never reach the
      // timer tick that asked for it.
      logger.warn("Could not show a system notification:", error);
    }
  }

  private closeCurrent(): void {
    const current = this.current;
    this.current = null;
    if (!current) return;
    try {
      current.close();
    } catch (error) {
      logger.warn("Could not close a system notification:", error);
    }
  }
}
