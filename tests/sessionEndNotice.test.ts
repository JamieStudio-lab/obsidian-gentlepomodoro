import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NOTIFICATION_PREVIEW_TEXT,
  NOTIFICATION_TAG,
  SESSION_END_NOTIFICATION_DESC,
  SESSION_END_NOTIFICATION_LABEL,
  SessionEndNotifier,
  sessionEndNoticeText,
  systemNotificationFactory,
  type NoticeOptions,
  type NotificationConstructor,
  type NotificationFactory,
} from "../sessionEndNotice";

/**
 * The opt-in "time is up" system notification (0.6.6).
 *
 * The request behind it came from someone who keeps the timer's sound OFF and
 * loses the Obsidian window behind others — so the properties that matter are
 * that it is silent, that it reaches past a covered window at all, and that it
 * never becomes a new way for the timer tick to throw.
 */

interface Posted extends NoticeOptions {
  title: string;
  closed: boolean;
}

function makeNotifier(opts: { enabled?: boolean; create?: "fake" | null | "throws" } = {}) {
  const posted: Posted[] = [];
  const state = { enabled: opts.enabled ?? true };
  const fake: NotificationFactory = (title, options) => {
    const entry: Posted = { ...options, title, closed: false };
    posted.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
    };
  };
  const create =
    opts.create === null
      ? null
      : opts.create === "throws"
        ? () => {
            throw new Error("Illegal constructor");
          }
        : fake;
  const notifier = new SessionEndNotifier({ enabled: () => state.enabled, create });
  return { notifier, posted, state };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sessionEndNoticeText", () => {
  it("names the session that ended", () => {
    expect(sessionEndNoticeText("focus", false).title).toBe("Focus time is up");
    expect(sessionEndNoticeText("break", false).title).toBe("Break time is up");
  });

  it("says the timer is still running when nothing started on its own", () => {
    // The request, in its own words: "I forget to turn off the timer". Overtime
    // is the state they forget about, so it is the one this must name.
    for (const mode of ["focus", "break"] as const) {
      expect(sessionEndNoticeText(mode, false).body).toBe(
        "The timer keeps counting until you stop it."
      );
    }
  });

  it("says what started when the next session began on its own", () => {
    expect(sessionEndNoticeText("focus", true).body).toBe("Your break has started.");
    expect(sessionEndNoticeText("break", true).body).toBe("Your next focus session has started.");
  });

  it("gives all four cases a different message", () => {
    const seen = new Set<string>();
    for (const mode of ["focus", "break"] as const) {
      for (const next of [false, true]) {
        const { title, body } = sessionEndNoticeText(mode, next);
        seen.add(`${title}|${body}`);
      }
    }
    expect(seen.size).toBe(4);
  });
});

describe("the switch's wording", () => {
  it("promises no sound, because the people it is for keep the sound off", () => {
    expect(SESSION_END_NOTIFICATION_DESC.toLowerCase()).toContain("silent");
  });

  it("says when it fires, so the panel's row needs no description", () => {
    // The gear panel shows labels only — there is no room for a description in
    // its 260px column — so the label alone has to carry the moment.
    expect(SESSION_END_NOTIFICATION_LABEL.toLowerCase()).toContain("time is up");
  });
});

describe("SessionEndNotifier", () => {
  it("posts nothing while the switch is off — the shipped default", () => {
    const { notifier, posted } = makeNotifier({ enabled: false });
    notifier.sessionEnded("focus", false);
    expect(posted).toHaveLength(0);
  });

  it("posts a SILENT notification when the switch is on", () => {
    // Silent is load-bearing, not a style choice: sound belongs to "Timer
    // sounds", and a notification that beeped would walk past the user's mute.
    const { notifier, posted } = makeNotifier();
    notifier.sessionEnded("focus", false);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      title: "Focus time is up",
      body: "The timer keeps counting until you stop it.",
      silent: true,
    });
  });

  it("posts every notice under one tag, asking it to alert again", () => {
    // The tag is what replaces the previous notice where close() cannot reach
    // it (a Windows toast that has already timed into Action Center), and
    // renotify is what keeps that replacement from being swapped in silently.
    const { notifier, posted } = makeNotifier();
    notifier.preview();
    notifier.sessionEnded("focus", true);
    notifier.sessionEnded("break", false);
    for (const p of posted) {
      expect(p.tag).toBe(NOTIFICATION_TAG);
      expect(p.renotify).toBe(true);
    }
  });

  it("reads the switch at the moment of posting, not at construction", () => {
    // loadSettings() replaces the settings object wholesale, so the host hands
    // over a call. A captured value would keep the pre-load answer forever.
    const { notifier, posted, state } = makeNotifier({ enabled: false });
    state.enabled = true;
    notifier.sessionEnded("break", true);
    expect(posted.map((p) => p.body)).toEqual(["Your next focus session has started."]);
  });

  it("does nothing, and throws nothing, where the platform has no notifications", () => {
    const { notifier } = makeNotifier({ create: null });
    expect(() => notifier.sessionEnded("focus", false)).not.toThrow();
    expect(() => notifier.preview()).not.toThrow();
    expect(() => notifier.dispose()).not.toThrow();
  });

  it("never lets a failed post reach the timer tick that asked for it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { notifier } = makeNotifier({ create: "throws" });
    expect(() => notifier.sessionEnded("focus", false)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("closes the previous notification when the next one arrives", () => {
    // A day of sessions must not stack a column of stale notices.
    const { notifier, posted } = makeNotifier();
    notifier.sessionEnded("focus", true);
    notifier.sessionEnded("break", false);
    expect(posted.map((p) => p.closed)).toEqual([true, false]);
  });

  it("survives a close() that throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const notifier = new SessionEndNotifier({
      enabled: () => true,
      create: () => {
        calls += 1;
        return {
          close: () => {
            throw new Error("already gone");
          },
        };
      },
    });
    notifier.sessionEnded("focus", false);
    expect(() => notifier.sessionEnded("break", false)).not.toThrow();
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("shows the sample when asked, whatever the stored switch says", () => {
    // The caller has just turned the switch on; the sample is how the user
    // sees it work and when the operating system asks to allow notifications.
    const { notifier, posted } = makeNotifier({ enabled: false });
    notifier.preview();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ...NOTIFICATION_PREVIEW_TEXT, silent: true });
  });

  it("closes what it posted when the plugin unloads, and posts nothing after", () => {
    // The timer can outlive the plugin by a moment — an auto-start mid-way
    // through its vault writes restarts the tick after unload — and a notifier
    // that still worked would post from a plugin the user had switched off.
    const { notifier, posted } = makeNotifier();
    notifier.sessionEnded("focus", false);
    notifier.dispose();
    expect(posted[0].closed).toBe(true);

    notifier.sessionEnded("break", false);
    notifier.preview();
    expect(posted).toHaveLength(1);
    expect(() => notifier.dispose()).not.toThrow();
  });
});

describe("systemNotificationFactory", () => {
  class FakeNotification {
    static made: FakeNotification[] = [];
    closed = false;
    constructor(
      public title: string,
      public options: NoticeOptions
    ) {
      FakeNotification.made.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const ctor = FakeNotification as unknown as NotificationConstructor;
  const options: NoticeOptions = { body: "b", silent: true, tag: NOTIFICATION_TAG, renotify: true };

  it("has nothing to post with off the desktop app, or without a constructor", () => {
    expect(systemNotificationFactory(false, ctor)).toBeNull();
    expect(systemNotificationFactory(true, undefined)).toBeNull();
  });

  it("builds the notification it is asked for, with every option passed through", () => {
    FakeNotification.made = [];
    const create = systemNotificationFactory(true, ctor);
    const shown = create?.("Focus time is up", options);
    const made = FakeNotification.made[0];
    expect(made.title).toBe("Focus time is up");
    expect(made.options).toEqual(options);
    shown?.close();
    expect(made.closed).toBe(true);
  });
});

describe("the plugin's wiring", () => {
  // main.ts cannot be imported by a test (it pulls in the whole view), so the
  // lines that connect the notifier are read as text, comments stripped.
  const main = readFileSync(resolve(__dirname, "..", "main.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

  it("reads the stored switch, through a call", () => {
    expect(main).toContain("enabled: () => this.settings.sessionEndNotification,");
  });

  it("uses the real Notification only on the desktop app", () => {
    expect(main).toContain(
      'create: systemNotificationFactory( Platform.isDesktopApp, typeof Notification === "function" ? Notification : undefined ),'
    );
  });

  it("forwards the engine's call and the sample, and closes the notification on unload", () => {
    expect(main).toContain(
      "notifySessionEnd(endedMode: PomoMode, nextStarts: boolean): void { this.sessionEndNotifier.sessionEnded(endedMode, nextStarts); }"
    );
    expect(main).toContain(
      "previewSessionEndNotification(): void { this.sessionEndNotifier.preview(); }"
    );
    const unload = main.slice(main.indexOf("override onunload() {"));
    expect(unload.slice(0, unload.indexOf("async activateView"))).toContain(
      "this.sessionEndNotifier.dispose();"
    );
  });
});
