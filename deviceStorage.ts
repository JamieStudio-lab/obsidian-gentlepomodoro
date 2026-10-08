import type { App } from "obsidian";
import { logger } from "./logger";

/**
 * Small values kept on THIS device, for this vault (0.6.9): the session in
 * progress, so a quit or a crash can offer it back, and a log line that could
 * not be written, until it can. Never data.json — that file syncs, so every
 * save would be sync traffic, and a session open on a phone would be offered
 * back on the laptop.
 *
 * Obsidian has `App.loadLocalStorage` / `saveLocalStorage` for exactly this,
 * but only from 1.8.7, above this plugin's minAppVersion (1.7.2). So they are
 * found by a runtime probe, never called as the typed members, and without
 * them `window.localStorage` stands in under a key scoped to the vault the
 * way Obsidian scopes its own — so the values carry over the day the app
 * updates past 1.8.7.
 *
 * Nothing here may throw: storage can be full, blocked or missing (a private
 * window, a locked-down web view), and a value that cannot be kept is lost
 * rather than taking a timer action down with it.
 */
export interface DeviceStorage {
  /** The stored value, or null when there is none or it cannot be read. */
  load(key: string): unknown;
  /** Store a value; null removes it. */
  save(key: string, value: unknown): void;
}

/** What the probe looks for; 1.8.7's two methods, and the id Obsidian keys them by. */
interface LocalStorageApp {
  loadLocalStorage?: unknown;
  saveLocalStorage?: unknown;
  appId?: unknown;
  vault?: { getName?: unknown };
}

/** The part of `window.localStorage` the fallback uses. */
export interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The device storage for `app`. `web` is the fallback's storage — the
 * window's, unless a test passes its own.
 */
export function deviceStorage(
  app: App,
  web: () => WebStorage | null = windowStorage
): DeviceStorage {
  const probe = app as unknown as LocalStorageApp;
  const load = probe.loadLocalStorage;
  const save = probe.saveLocalStorage;
  if (typeof load === "function" && typeof save === "function") {
    return {
      load: (key) => {
        try {
          const value: unknown = (load as (key: string) => unknown).call(app, key);
          return value ?? null;
        } catch (e) {
          logger.warn(`Could not read "${key}" from this device`, e);
          return null;
        }
      },
      save: (key, value) => {
        try {
          (save as (key: string, value: unknown) => void).call(app, key, value);
        } catch (e) {
          logger.warn(`Could not keep "${key}" on this device`, e);
        }
      },
    };
  }

  const scope = vaultScope(probe);
  return {
    load: (key) => {
      try {
        const text = web()?.getItem(`${scope}-${key}`) ?? null;
        return text === null ? null : (JSON.parse(text) as unknown);
      } catch (e) {
        logger.warn(`Could not read "${key}" from this device`, e);
        return null;
      }
    },
    save: (key, value) => {
      try {
        const storage = web();
        if (storage === null) return;
        if (value === null || value === undefined) storage.removeItem(`${scope}-${key}`);
        else storage.setItem(`${scope}-${key}`, JSON.stringify(value));
      } catch (e) {
        logger.warn(`Could not keep "${key}" on this device`, e);
      }
    },
  };
}

/**
 * Obsidian keys its own vault values `<appId>-<key>`, appId being the vault's
 * id; that is used when it can be read. Failing that, the vault's name — not
 * unique across devices, but this storage never leaves the device.
 */
function vaultScope(app: LocalStorageApp): string {
  if (typeof app.appId === "string" && app.appId !== "") return app.appId;
  const getName = app.vault?.getName;
  const name: unknown =
    typeof getName === "function" ? (getName as () => unknown).call(app.vault) : null;
  return `gentle-pomo-${typeof name === "string" ? name : "vault"}`;
}

function windowStorage(): WebStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Reading the property itself throws where storage is blocked.
    return null;
  }
}
