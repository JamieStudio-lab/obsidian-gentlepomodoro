import { SETTINGS_SAVE_RENOTIFY_MS } from "./constants";

/**
 * What the settings store needs from the plugin. `write` is the load-bearing
 * one — see the warning on `SettingsStore.save`.
 */
export interface SettingsIo {
  /** Read data.json. Must mirror `Plugin.loadData()`'s tri-state contract below. */
  read(): Promise<unknown>;
  /** Write data.json. **Must reject on failure** — `Plugin.saveData()` does not. */
  write(data: unknown): Promise<void>;
  now(): number;
  notice(message: string): void;
  warn(message: string, error?: unknown): void;
}

/**
 * What a read of data.json actually told us.
 *
 * `Plugin.loadData()` has a **tri-state** contract that is easy to miss,
 * because it is nowhere in the typings — the declared return is `Promise<any>`.
 * Underneath it is `vault.readPluginData` → `Vault.readJson`, which catches
 * everything and returns:
 *
 *   - `null`      — ENOENT: no data.json yet. A fresh install.
 *   - `undefined` — the file exists but could not be read or parsed. It logs to
 *                   the console and hands back nothing.
 *   - the parsed value otherwise, which need not be an object at all.
 *
 * It **never rejects**, so a `try`/`catch` around `loadData()` catches nothing.
 * Telling `null` from `undefined` is the only way to know a file was damaged,
 * and that distinction decides whether it is safe to write over it.
 */
export type DataRead =
  | { kind: "fresh" }
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "damaged" };

/** Sort a raw `loadData()` result into the three cases above. */
export function classifyPluginData(raw: unknown): DataRead {
  if (raw === null) return { kind: "fresh" };
  if (raw === undefined) return { kind: "damaged" };
  // Valid JSON that is not an object — `5`, `"x"`, `[]`. Merging one into the
  // defaults yields the defaults, so nothing would break, but the file is not
  // settings and must not be written over as though it were.
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "damaged" };
  return { kind: "ok", data: raw as Record<string, unknown> };
}

/**
 * The break-end chime's first-run value: ON for a brand-new install, OFF for
 * everyone upgrading. Returns `null` when the user already has a stored choice
 * and nothing should be derived at all.
 *
 * This exists as a function rather than a `DEFAULT_SETTINGS` entry because
 * DEFAULT_SETTINGS is the `Object.assign` merge base in `loadSettings()`, so a
 * `true` there would silently switch the chime on for every UPGRADING user too
 * — and an upgrade must never start making a sound the plugin has never made.
 * The silence at the zero crossing is a deliberate flow-protection choice (see
 * CLAUDE.md), so inheriting it is the correct answer for an existing user; only
 * someone with no history to preserve gets the chime by default.
 *
 * `"damaged"` counts as NOT fresh on purpose: that is an existing user whose
 * data.json we merely failed to read, and staying quiet is the safe answer.
 */
export function deriveBreakEndChime(
  read: DataRead,
  loaded: { breakEndSoundEnabled?: unknown } | null
): boolean | null {
  if (loaded && loaded.breakEndSoundEnabled !== undefined) return null;
  return read.kind === "fresh";
}

/**
 * Drop loaded values whose type disagrees with the default's, so that one
 * hand-edited or sync-mangled field cannot take the plugin down on startup.
 *
 * `{"tasksPath": 123}` is valid JSON and a valid object, so it survives every
 * check above — and then the first `settings.tasksPath.trim()` throws inside
 * `onload`, which is the whole failure this guards against. The default is used
 * for any field whose type is wrong.
 *
 * Unknown keys are **kept**, deliberately: a data.json written by a newer
 * version must survive a downgrade and an upgrade back, and dropping its
 * unrecognised fields here would quietly make that lossy.
 */
export function coerceToDefaults<T extends Record<string, unknown>>(
  loaded: Record<string, unknown>,
  defaults: T
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...loaded };
  for (const key of Object.keys(defaults)) {
    if (!(key in out)) continue;
    const fallback = defaults[key];
    // A null default carries no type information — `lastGoalHitDate` and
    // `lastMusicUrl` are null until first written, then strings — so anything
    // is allowed through and the reader stays responsible for it. That is a
    // standing rule with a known past violation: `loadSettings`' legacy
    // position fold called `.trim()` on `lastMusicUrl` unguarded, and threw out
    // of `onload`. Any new reader of a null-defaulted field must check the type
    // itself.
    if (fallback === null) continue;
    const value = out[key];
    if (value === null || value === undefined) {
      delete out[key];
      continue;
    }
    if (typeof value !== typeof fallback || Array.isArray(value) !== Array.isArray(fallback)) {
      delete out[key];
    }
  }
  return out;
}

/**
 * Reads and writes data.json, and — the reason this exists — actually notices
 * when either fails.
 */
export class SettingsStore {
  private readonly io: SettingsIo;
  /** When the last write failed, so a broken vault can't nag per keystroke. */
  private saveFailedAt: number | null = null;

  constructor(io: SettingsIo) {
    this.io = io;
  }

  /**
   * Read data.json and say which of the three cases it is, reporting a damaged
   * file to the user. The caller must not write over a damaged one.
   */
  async read(): Promise<DataRead> {
    // `read()` is `Plugin.loadData()`, which swallows everything; the catch is
    // belt-and-braces for a host that some day does reject.
    let raw: unknown;
    try {
      raw = await this.io.read();
    } catch (e) {
      this.io.warn("Could not read data.json", e);
      raw = undefined;
    }
    const result = classifyPluginData(raw);
    if (result.kind === "damaged") {
      this.io.warn("data.json is unreadable or malformed; starting from the defaults");
      this.io.notice(
        "Gentle pomodoro: couldn't read its settings, so it started with the defaults. Your data.json has been left alone — fix or delete it and reload the plugin."
      );
    }
    return result;
  }

  /**
   * Persist, and report a failure. Returns whether the write landed.
   *
   * **`io.write` must not be `Plugin.saveData()`.** That method is
   * `vault.writePluginData` → `Vault.writeJson`, which wraps the adapter call
   * in a try/catch whose catch body is *empty*, and resolves `undefined` on
   * every failure. Wrapping `saveData()` in a try/catch therefore produces a
   * handler that can never run — which is exactly the dead code 0.5.8 first
   * shipped. The write has to go through something that rejects.
   *
   * Rate-limited because the pre-1.13 settings path commits on every keystroke,
   * so an unwritable vault would otherwise queue one Notice per character.
   */
  async save(data: unknown): Promise<boolean> {
    try {
      await this.io.write(data);
      this.saveFailedAt = null;
      return true;
    } catch (e) {
      this.io.warn("Could not save settings", e);
      const now = this.io.now();
      if (this.saveFailedAt === null || now - this.saveFailedAt > SETTINGS_SAVE_RENOTIFY_MS) {
        this.saveFailedAt = now;
        this.io.notice(
          "Gentle pomodoro: couldn't save its settings — check that the vault is writable. Changes made now will be lost when Obsidian restarts."
        );
      }
      return false;
    }
  }
}
