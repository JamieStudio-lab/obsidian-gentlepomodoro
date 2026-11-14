import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FrameWindow, type FrameMessageHandler, type FrameWindowTarget } from "../frameWindow";
import { MusicController, type MusicHost } from "../MusicController";
import { YT_EMBED_ORIGIN, YT_STATE } from "../youtubeMusic";

/**
 * Music in a pop-out window. The pure part runs on fake windows whose timer ids
 * all start at 1, as two real windows' can, and which throw on any call once
 * closed. The view's part is read as text, since nothing can import the view.
 */

class FakeWindow implements FrameWindowTarget {
  closed = false;
  readonly listeners: FrameMessageHandler[] = [];
  readonly timeouts = new Map<number, () => void>();
  readonly intervals = new Map<number, () => void>();
  readonly clearedTimeouts: number[] = [];
  readonly clearedIntervals: number[] = [];
  readonly delays: number[] = [];
  removals = 0;
  private nextId = 1;

  private alive(): void {
    if (this.closed) throw new Error(`${this.name} is closed`);
  }

  constructor(readonly name: string) {}

  addEventListener(type: "message", listener: FrameMessageHandler): void {
    this.alive();
    expect(type).toBe("message");
    this.listeners.push(listener);
  }

  removeEventListener(type: "message", listener: FrameMessageHandler): void {
    this.alive();
    expect(type).toBe("message");
    this.removals++;
    const at = this.listeners.indexOf(listener);
    if (at >= 0) this.listeners.splice(at, 1);
  }

  setTimeout(fn: () => void, ms: number): number {
    this.alive();
    const id = this.nextId++;
    this.delays.push(ms);
    this.timeouts.set(id, fn);
    return id;
  }

  clearTimeout(id: number): void {
    this.alive();
    this.clearedTimeouts.push(id);
    this.timeouts.delete(id);
  }

  setInterval(fn: () => void, ms: number): number {
    this.alive();
    const id = this.nextId++;
    this.delays.push(ms);
    this.intervals.set(id, fn);
    return id;
  }

  clearInterval(id: number): void {
    this.alive();
    this.clearedIntervals.push(id);
    this.intervals.delete(id);
  }

  fireTimeout(id: number): void {
    const fn = this.timeouts.get(id);
    if (!fn) throw new Error(`no timeout ${id} on ${this.name}`);
    this.timeouts.delete(id);
    fn();
  }

  post(): void {
    for (const listener of [...this.listeners]) listener({} as MessageEvent);
  }

  get pendingTimers(): number {
    return this.timeouts.size + this.intervals.size;
  }

  /** Every pending timeout once, and every interval once. */
  fireAll(): void {
    for (const id of [...this.timeouts.keys()]) this.fireTimeout(id);
    for (const fn of [...this.intervals.values()]) fn();
  }
}

describe("FrameWindow", () => {
  let main: FakeWindow;
  let popout: FakeWindow;
  let messages: number;
  let frames: FrameWindow;

  beforeEach(() => {
    main = new FakeWindow("main");
    popout = new FakeWindow("popout");
    messages = 0;
    frames = new FrameWindow(main, () => messages++);
  });

  describe("the listener", () => {
    it("starts on no window: the fallback only holds timers until a frame is mounted", () => {
      expect(frames.win).toBe(main);
      expect(main.listeners).toHaveLength(0);
    });

    it("puts the listener on the window it is given and makes that window current", () => {
      frames.listen(popout);
      expect(frames.win).toBe(popout);
      popout.post();
      expect(messages).toBe(1);
    });

    it("moves the listener: the old window no longer reaches the handler", () => {
      frames.listen(main);
      frames.listen(popout);
      expect(main.listeners).toHaveLength(0);
      expect(popout.listeners).toHaveLength(1);
      main.post();
      expect(messages).toBe(0);
    });

    it("never doubles on the same window", () => {
      frames.listen(popout);
      frames.listen(popout);
      expect(popout.listeners).toHaveLength(1);
      popout.post();
      expect(messages).toBe(1);
    });

    it("never doubles on a window it comes back to", () => {
      frames.listen(main);
      frames.listen(popout);
      frames.listen(main);
      expect(main.listeners).toHaveLength(1);
      expect(popout.listeners).toHaveLength(0);
    });

    it("stop takes it off and leaves the window in use, for the timers", () => {
      frames.listen(popout);
      frames.stop();
      expect(popout.listeners).toHaveLength(0);
      expect(frames.win).toBe(popout);
      frames.setTimeout(() => {}, 10);
      expect(popout.timeouts.size).toBe(1);
      expect(main.timeouts.size).toBe(0);
    });

    it("listening again after stop puts it back, on the same window too", () => {
      frames.listen(popout);
      frames.stop();
      frames.listen(popout);
      expect(popout.listeners).toHaveLength(1);
    });

    it("stop takes it off once: a second stop asks the window nothing", () => {
      frames.listen(popout);
      frames.stop();
      frames.stop();
      expect(popout.removals).toBe(1);
    });

    it("stop with nothing listening does nothing", () => {
      expect(() => frames.stop()).not.toThrow();
      expect(frames.win).toBe(main);
    });
  });

  describe("timers", () => {
    it("run on the window in use", () => {
      frames.setTimeout(() => {}, 10);
      frames.setInterval(() => {}, 10);
      expect(main.timeouts.size).toBe(1);
      expect(main.intervals.size).toBe(1);

      frames.listen(popout);
      frames.setTimeout(() => {}, 10);
      frames.setInterval(() => {}, 10);
      expect(popout.timeouts.size).toBe(1);
      expect(popout.intervals.size).toBe(1);
      expect(main.timeouts.size).toBe(1);
    });

    it("keep the delay they were given: a fade's steps are its timing", () => {
      frames.setTimeout(() => {}, 450);
      frames.setInterval(() => {}, 50);
      expect(main.delays).toEqual([450, 50]);
    });

    it("run what they were given", () => {
      let ran = 0;
      frames.setTimeout(() => ran++, 10);
      main.fireTimeout(1);
      expect(ran).toBe(1);

      frames.setInterval(() => (ran += 10), 10);
      main.intervals.get(2)?.();
      main.intervals.get(2)?.();
      expect(ran).toBe(21);
    });

    it("give different handles when two windows issue the same id", () => {
      const onMain = frames.setTimeout(() => {}, 10);
      frames.listen(popout);
      const onPopout = frames.setTimeout(() => {}, 10);
      // Both windows gave out id 1: the fake is what makes this collide.
      expect([...main.timeouts.keys()]).toEqual([1]);
      expect([...popout.timeouts.keys()]).toEqual([1]);
      expect(onMain).not.toBe(onPopout);

      frames.clearTimeout(onPopout);
      expect(popout.timeouts.size).toBe(0);
      expect(main.timeouts.size).toBe(1);
    });

    it("clear on the window that set them, after the window in use has moved", () => {
      const timeout = frames.setTimeout(() => {}, 10);
      const interval = frames.setInterval(() => {}, 10);
      frames.listen(popout);
      // A timer of the same id on the new window, which a wrong clear would kill.
      frames.setTimeout(() => {}, 10);
      frames.setInterval(() => {}, 10);

      frames.clearTimeout(timeout);
      frames.clearInterval(interval);
      expect(main.timeouts.size).toBe(0);
      expect(main.intervals.size).toBe(0);
      expect(popout.clearedTimeouts).toEqual([]);
      expect(popout.clearedIntervals).toEqual([]);
      expect(popout.timeouts.size).toBe(1);
      expect(popout.intervals.size).toBe(1);
    });

    it("clear on the pop-out what was set on the pop-out, once the panel has left it", () => {
      frames.listen(popout);
      const timeout = frames.setTimeout(() => {}, 10);
      const interval = frames.setInterval(() => {}, 10);
      frames.listen(main);
      frames.clearTimeout(timeout);
      frames.clearInterval(interval);
      expect(popout.pendingTimers).toBe(0);
      expect(main.clearedTimeouts).toEqual([]);
      expect(main.clearedIntervals).toEqual([]);
    });

    it("use the clear that matches the timer", () => {
      const timeout = frames.setTimeout(() => {}, 10);
      const interval = frames.setInterval(() => {}, 10);
      frames.clearTimeout(timeout);
      frames.clearInterval(interval);
      expect(main.clearedTimeouts).toEqual([1]);
      expect(main.clearedIntervals).toEqual([2]);
    });

    it("forget a timeout when it fires, so a late clear cannot hit a reused id", () => {
      const handle = frames.setTimeout(() => {}, 10);
      main.fireTimeout(1);
      frames.clearTimeout(handle);
      expect(main.clearedTimeouts).toEqual([]);
    });

    it("forget the entry before running the timeout, so it can set its own next one", () => {
      let inner = 0;
      const handle = frames.setTimeout(() => {
        frames.clearTimeout(handle);
        inner = frames.setTimeout(() => {}, 10);
      }, 10);
      main.fireTimeout(1);
      expect(main.clearedTimeouts).toEqual([]);
      expect(inner).not.toBe(handle);
      expect(main.timeouts.size).toBe(1);
    });

    it("keep an interval's entry through its ticks", () => {
      const handle = frames.setInterval(() => {}, 10);
      main.intervals.get(1)?.();
      frames.clearInterval(handle);
      expect(main.clearedIntervals).toEqual([1]);
    });

    it("clear a handle once, and ignore one they never gave", () => {
      const handle = frames.setTimeout(() => {}, 10);
      frames.clearTimeout(handle);
      frames.clearTimeout(handle);
      frames.clearTimeout(999);
      frames.clearInterval(999);
      expect(main.clearedTimeouts).toEqual([1]);
      expect(main.clearedIntervals).toEqual([]);
    });
  });

  describe("a closed window is never called", () => {
    beforeEach(() => {
      frames.listen(popout);
    });

    it("stop on it does not reach it", () => {
      popout.closed = true;
      expect(() => frames.stop()).not.toThrow();
      expect(frames.win).toBe(popout);
    });

    it("moving off it does not reach it, and the new window gets the listener", () => {
      popout.closed = true;
      expect(() => frames.listen(main)).not.toThrow();
      expect(main.listeners).toHaveLength(1);
      expect(frames.win).toBe(main);
    });

    it("listening on one adds nothing, and a later stop does not reach it", () => {
      const closed = new FakeWindow("closed");
      closed.closed = true;
      expect(() => frames.listen(closed)).not.toThrow();
      expect(frames.win).toBe(closed);
      expect(popout.listeners).toHaveLength(0);
      expect(() => frames.stop()).not.toThrow();
    });

    it("a clear just drops the entry", () => {
      const timeout = frames.setTimeout(() => {}, 10);
      const interval = frames.setInterval(() => {}, 10);
      popout.closed = true;
      expect(() => frames.clearTimeout(timeout)).not.toThrow();
      expect(() => frames.clearInterval(interval)).not.toThrow();
      // Dropped, not kept: clearing again finds nothing even once it reopens.
      popout.closed = false;
      frames.clearTimeout(timeout);
      frames.clearInterval(interval);
      expect(popout.clearedTimeouts).toEqual([]);
      expect(popout.clearedIntervals).toEqual([]);
    });

    it("a new timer goes on the fallback window, and clears there", () => {
      popout.closed = true;
      const timeout = frames.setTimeout(() => {}, 10);
      const interval = frames.setInterval(() => {}, 10);
      expect(main.timeouts.size).toBe(1);
      expect(main.intervals.size).toBe(1);

      frames.clearTimeout(timeout);
      frames.clearInterval(interval);
      expect(main.timeouts.size).toBe(0);
      expect(main.intervals.size).toBe(0);
    });

    it("the window in use stays the closed one, so the panel's check still sees a change", () => {
      popout.closed = true;
      frames.setTimeout(() => {}, 10);
      expect(frames.win).toBe(popout);
    });
  });

  it("a real Window satisfies the target", () => {
    const asTarget = (win: Window): FrameWindowTarget => win;
    expect(asTarget).toBeTypeOf("function");
  });
});

/**
 * The real controller on a real FrameWindow, as the view wires them. A closed fake
 * throws on any call, so a controller timer that reaches a closed window fails here.
 */
describe("the controller on a FrameWindow", () => {
  const URL_A = "https://youtu.be/abcdefghijk";
  const PLAN = {
    target: { videoId: "abcdefghijk", playlistId: null, startSeconds: null },
    seekSeconds: null,
  };
  let main: FakeWindow;
  let popout: FakeWindow;
  let frames: FrameWindow;
  let holder: FakeWindow;
  let onLoad: (() => void) | null;
  let funcs: string[];
  let flushes: number;
  let music: MusicController;

  beforeEach(() => {
    main = new FakeWindow("main");
    popout = new FakeWindow("popout");
    frames = new FrameWindow(main, () => {});
    holder = popout;
    onLoad = null;
    funcs = [];
    flushes = 0;
    const host: MusicHost = {
      now: () => 0,
      setTimeout: (fn, ms) => frames.setTimeout(fn, ms),
      clearTimeout: (id) => frames.clearTimeout(id),
      setInterval: (fn, ms) => frames.setInterval(fn, ms),
      clearInterval: (id) => frames.clearInterval(id),
      rebuildPlayer: () => undefined,
      mountPlayer: (_src, load) => {
        onLoad = load;
        frames.listen(holder);
      },
      unmountPlayer: () => {
        onLoad = null;
        frames.stop();
      },
      postToPlayer: (payload) => {
        funcs.push((JSON.parse(payload) as { func: string }).func);
      },
      broadcastToPlayer: () => {},
      musicVolume: () => 1,
      recordPosition: () => {},
      clearPosition: () => {},
      flushPosition: () => {
        flushes++;
      },
      setTransportPlaying: () => {},
      onTrackChanged: () => {},
      notice: () => {},
      isIosApp: () => false,
    };
    music = new MusicController(host);
  });

  const say = (data: unknown): void => {
    music.handleFrameMessage(YT_EMBED_ORIGIN, JSON.stringify(data));
  };
  /** Mounted on `holder`, the handshake answered, playing, the fade-in landed. */
  const playOn = (win: FakeWindow): void => {
    holder = win;
    music.build("https://embed", PLAN, URL_A);
    onLoad?.();
    win.fireAll();
    say({ event: "onReady" });
    music.pressPlay();
    say({ event: "onStateChange", info: YT_STATE.PLAYING });
    for (let step = 0; step < 40 && win.pendingTimers > 0; step++) win.fireAll();
  };

  it("runs every timer on the window holding the frame", () => {
    playOn(popout);
    expect(popout.delays.length).toBeGreaterThan(1);
    expect(main.delays).toEqual([]);
  });

  it("leaves no timer behind on the window a move leaves", () => {
    playOn(popout);
    music.pressPause();
    expect(popout.pendingTimers).toBeGreaterThan(0);
    music.destroy();
    expect(popout.pendingTimers).toBe(0);
  });

  it("a track's end, waiting to see if it was only a playlist's gap, goes with the teardown", () => {
    playOn(popout);
    expect(popout.pendingTimers).toBe(0);
    say({ event: "onStateChange", info: YT_STATE.ENDED });
    expect(popout.timeouts.size).toBe(1);
    music.destroy();
    expect(popout.pendingTimers).toBe(0);
  });

  describe("each timer a frame can leave goes with the teardown", () => {
    beforeEach(() => {
      holder = popout;
      music.build("https://embed", PLAN, URL_A);
      onLoad?.();
    });

    it("the wait after the frame's load", () => {
      expect(popout.timeouts.size).toBe(1);
      music.destroy();
      expect(popout.pendingTimers).toBe(0);
    });

    it("an unanswered handshake's retries", () => {
      popout.fireAll();
      expect(popout.intervals.size).toBe(1);
      music.destroy();
      expect(popout.pendingTimers).toBe(0);
    });

    it("a stalled embed's notice", () => {
      popout.fireAll();
      // Any message from the frame ends the retries, so only the stall timer is left.
      say({ event: "onStateChange", info: YT_STATE.BUFFERING });
      expect(popout.intervals.size).toBe(0);
      expect(popout.timeouts.size).toBe(1);
      music.destroy();
      expect(popout.pendingTimers).toBe(0);
    });
  });

  it("the pop-out closes with a fade pending: the teardown never calls it, and main takes over", () => {
    playOn(popout);
    funcs = [];
    music.pressPause();
    expect(popout.intervals.size).toBe(1);

    popout.closed = true;
    expect(() => music.destroy()).not.toThrow();
    // Its pauseVideo rode on the landing, which died with the window.
    expect(funcs).not.toContain("pauseVideo");
    expect(flushes).toBeGreaterThan(0);
    expect(music.showingAsPlaying).toBe(false);

    playOn(main);
    expect(frames.win).toBe(main);
    expect(main.delays.length).toBeGreaterThan(1);
    expect(funcs).toContain("playVideo");
  });

  it("a window closed with nothing rebuilt yet: a late timer runs on the fallback", () => {
    playOn(popout);
    music.destroy();
    popout.closed = true;
    // No frame, so the window in use is still the closed one.
    expect(frames.win).toBe(popout);
    expect(() => music.duck(1)).not.toThrow();
    frames.setTimeout(() => {}, 5);
    expect(main.delays).toEqual([5]);
  });
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** A file as code: a comment can neither keep a guard green nor trip one. */
const codeOf = (file: string): string =>
  readFileSync(resolve(root, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();

describe("frameWindow.ts stays pure", () => {
  const code = codeOf("frameWindow.ts");

  it("imports nothing", () => {
    expect(code).not.toMatch(/\bimport\b[^;]*\bfrom\b/);
    expect(code).not.toMatch(/\brequire\(/);
  });

  it("reads no global window or document", () => {
    expect(code).not.toMatch(/(^|[^.\w])(window|document|globalThis|activeWindow)\b/);
    // A bare setTimeout would run on whichever window loaded the plugin. The
    // lookahead lets through the module's own declarations of these names.
    expect(code).not.toMatch(
      /(^|[^.\w])(setTimeout|clearTimeout|setInterval|clearInterval)\((?!fn: |id: |handle: )/
    );
  });
});

describe("the view's wiring", () => {
  const code = codeOf("GentlePomoView.ts");
  const between = (from: string, to: string): string => {
    const start = code.indexOf(from);
    expect(start, from).toBeGreaterThanOrEqual(0);
    const end = code.indexOf(to, start + from.length);
    expect(end, to).toBeGreaterThan(start);
    return code.slice(start, end);
  };

  it("has no message listener of its own on any window", () => {
    expect(code).not.toContain('registerDomEvent(window, "message"');
    expect(code).not.toMatch(/registerDomEvent\([^,]*, "message"/);
    expect(code).not.toContain('addEventListener("message"');
  });

  it("builds the FrameWindow on the main window, before the controller's host needs it", () => {
    const ctor = between("constructor(leaf: WorkspaceLeaf", "getViewType()");
    expect(ctor).toContain("this.frameWindow = new FrameWindow(window, (evt) => {");
    expect(ctor.indexOf("new FrameWindow(")).toBeLessThan(ctor.indexOf("new MusicController("));
  });

  it("passes on only its own frame's messages", () => {
    const ctor = between("new FrameWindow(window", "new MusicController(");
    expect(ctor).toContain(
      "if (!this.musicIframe || evt.source !== this.musicIframe.contentWindow) return;"
    );
    expect(ctor).toContain("this.music.handleFrameMessage(evt.origin, evt.data);");
    expect(ctor.indexOf("evt.source")).toBeLessThan(ctor.indexOf("handleFrameMessage"));
  });

  it("gives the controller the FrameWindow's four timers", () => {
    const host = between("private createMusicHost(): MusicHost {", "mountPlayer:");
    expect(host).toContain("setTimeout: (fn, ms) => this.frameWindow.setTimeout(fn, ms),");
    expect(host).toContain("clearTimeout: (id) => { this.frameWindow.clearTimeout(id); },");
    expect(host).toContain("setInterval: (fn, ms) => this.frameWindow.setInterval(fn, ms),");
    expect(host).toContain("clearInterval: (id) => { this.frameWindow.clearInterval(id); },");
    expect(host).not.toContain("window.");
  });

  it("listens on the window that owns the frame, from the mount", () => {
    const mount = between("mountPlayer: (src, onLoad) => {", "unmountPlayer:");
    expect(mount).toContain("this.frameWindow.listen(iframe.win);");
    expect(mount.indexOf("this.frameWindow.listen(iframe.win);")).toBeGreaterThan(
      mount.indexOf('createEl("iframe"')
    );
  });

  it("stops listening at the unmount", () => {
    const unmount = between("unmountPlayer: () => {", "postToPlayer:");
    expect(unmount).toContain("this.frameWindow.stop();");
  });

  describe("the panel changing windows", () => {
    const method = between("private panelChangedWindows(): void {", "private updateCompactClass()");

    it("does nothing when the panel is on the window in use", () => {
      expect(method.indexOf("if (this.containerEl.win === this.frameWindow.win) return;")).toBe(
        "private panelChangedWindows(): void { ".length
      );
    });

    it("tears down, drops all three reconcile keys, and lets the reconcile build", () => {
      const steps = [
        "this.music.destroy();",
        "this.lastMusicKey = null;",
        "this.lastMusicEmbedUrl = null;",
        "this.lastMusicSourceUrl = null;",
        "this.applySettings();",
      ];
      const places = steps.map((step) => method.indexOf(step));
      expect(places.every((place) => place >= 0)).toBe(true);
      // destroy first: it flushes the position the reconcile's resume plan reads.
      expect(places[0]).toBe(Math.min(...places));
      // applySettings last: a key still standing would skip the rebuild.
      expect(places[4]).toBe(Math.max(...places));
    });

    it("rebuilds only after the guard, through the one method the controller's reload uses", () => {
      const guard = method.indexOf("if (this.containerEl.win === this.frameWindow.win) return;");
      expect(method.indexOf("this.rebuildMusicFrame();")).toBeGreaterThan(guard);
      expect(between("rebuildPlayer: () => {", "onTrackChanged:")).toContain(
        "this.rebuildMusicFrame();"
      );
    });

    it("builds nothing itself and carries nothing over: the reconcile plans the resume", () => {
      expect(method).not.toContain("music.build(");
      expect(method).not.toContain("startPlayback");
      expect(method).not.toContain("frameWindow.listen");
    });
  });

  describe("its two triggers", () => {
    it("onWindowMigrated, one listener while loaded, and back after a close and reopen", () => {
      const open = between("override onOpen(): Promise<void> {", "override onClose()");
      expect(open).toContain(
        "if (!this.windowMigratedOn) { this.windowMigratedOn = true; const off = this.containerEl.onWindowMigrated(() => this.panelChangedWindows()); this.register(() => { off(); this.windowMigratedOn = false; }); }"
      );
      expect(open.split("onWindowMigrated(").length - 1).toBe(1);
    });

    it("the frame's load, which checks the window before the normal handshake", () => {
      const mount = between("mountPlayer: (src, onLoad) => {", "unmountPlayer:");
      expect(mount).toContain(
        'this.registerDomEvent(iframe, "load", () => { if (iframe.win !== this.frameWindow.win) { this.panelChangedWindows(); return; } onLoad(); });'
      );
      expect(mount).not.toContain('registerDomEvent(iframe, "load", onLoad)');
    });
  });
});
