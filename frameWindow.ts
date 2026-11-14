/**
 * The window that holds the hidden music player.
 *
 * Obsidian's pop-out windows are separate documents, and two things follow the
 * frame there. A frame's postMessage goes to the window that owns it, so the
 * `message` listener has to sit on that window or the handshake is never
 * answered. And a page that is hidden and silent has its timers woken once a
 * minute, so a 450 ms fade run from a covered main window could take minutes
 * while the music plays on in the pop-out: the controller's timers belong to
 * the window making the sound.
 *
 * Takes its windows as arguments and reads no global, so tests drive it with
 * fake windows.
 */

export type FrameMessageHandler = (evt: MessageEvent) => void;

/** The part of a window this module uses. A real `Window` satisfies it. */
export interface FrameWindowTarget {
  readonly closed: boolean;
  addEventListener(type: "message", listener: FrameMessageHandler): void;
  removeEventListener(type: "message", listener: FrameMessageHandler): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

/** A real timer: its id means something only on the window that issued it. */
interface WindowTimer {
  id: number;
  win: FrameWindowTarget;
}

export class FrameWindow {
  private current: FrameWindowTarget;
  private listeningOn: FrameWindowTarget | null = null;
  private readonly timers = new Map<number, WindowTimer>();
  private nextHandle = 1;

  constructor(
    private readonly fallback: FrameWindowTarget,
    private readonly onMessage: FrameMessageHandler
  ) {
    this.current = fallback;
  }

  /** The window now in use. It stays after stop(), for the timers still to come. */
  get win(): FrameWindowTarget {
    return this.current;
  }

  /** Listen on `win` and nowhere else, and make it the window in use. */
  listen(win: FrameWindowTarget): void {
    this.current = win;
    this.stop();
    if (win.closed) return;
    win.addEventListener("message", this.onMessage);
    this.listeningOn = win;
  }

  /** Take the listener off. A closed window has nothing left to take it off. */
  stop(): void {
    if (this.listeningOn && !this.listeningOn.closed) {
      this.listeningOn.removeEventListener("message", this.onMessage);
    }
    this.listeningOn = null;
  }

  setTimeout(fn: () => void, ms: number): number {
    const win = this.timerWindow();
    const handle = this.nextHandle++;
    const id = win.setTimeout(() => {
      this.timers.delete(handle);
      fn();
    }, ms);
    this.timers.set(handle, { id, win });
    return handle;
  }

  clearTimeout(handle: number): void {
    const timer = this.takeLive(handle);
    timer?.win.clearTimeout(timer.id);
  }

  setInterval(fn: () => void, ms: number): number {
    const win = this.timerWindow();
    const handle = this.nextHandle++;
    this.timers.set(handle, { id: win.setInterval(fn, ms), win });
    return handle;
  }

  clearInterval(handle: number): void {
    const timer = this.takeLive(handle);
    timer?.win.clearInterval(timer.id);
  }

  /** A closed window runs nothing, so a new timer goes where it will fire. */
  private timerWindow(): FrameWindowTarget {
    return this.current.closed ? this.fallback : this.current;
  }

  /**
   * Forget a timer and hand it back if its window can still be asked to clear
   * it. The handle, not the id, says which window that is: two windows issue
   * the same ids, and the window in use may have changed since it was set.
   */
  private takeLive(handle: number): WindowTimer | null {
    const timer = this.timers.get(handle);
    if (!timer) return null;
    this.timers.delete(handle);
    return timer.win.closed ? null : timer;
  }
}
