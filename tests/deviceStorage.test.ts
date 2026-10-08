import { describe, it, expect, vi, afterEach } from "vitest";
import type { App } from "obsidian";
import { deviceStorage, type WebStorage } from "../deviceStorage";

/** A window.localStorage stand-in that records what it was asked. */
function webStorage(): WebStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

const asApp = (app: object) => app as unknown as App;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deviceStorage — Obsidian's own vault storage, found by a probe", () => {
  it("uses App.loadLocalStorage / saveLocalStorage when the app has them (1.8.7+)", () => {
    const stored = new Map<string, unknown>();
    const app = {
      loadLocalStorage(this: unknown, key: string) {
        expect(this).toBe(app);
        return stored.get(key) ?? null;
      },
      saveLocalStorage(this: unknown, key: string, value: unknown) {
        expect(this).toBe(app);
        if (value === null) stored.delete(key);
        else stored.set(key, value);
      },
    };
    const web = webStorage();
    const storage = deviceStorage(asApp(app), () => web);
    storage.save("k", { a: 1 });
    expect(stored.get("k")).toEqual({ a: 1 });
    expect(storage.load("k")).toEqual({ a: 1 });
    storage.save("k", null);
    expect(storage.load("k")).toBeNull();
    // The window's storage is never touched while the app's is there.
    expect(web.items.size).toBe(0);
  });

  it.each([
    ["loadLocalStorage", { loadLocalStorage: () => null }],
    ["saveLocalStorage", { saveLocalStorage: () => undefined }],
  ])("uses the window's storage when the app has only %s", (_, methods) => {
    // Both are needed: with only one, half the calls would go to a method
    // that is not there — a save silently lost, or a load that always reads
    // nothing — while the window's storage stood unused.
    const web = webStorage();
    const storage = deviceStorage(asApp({ appId: "a", ...methods }), () => web);
    storage.save("k", { n: 1 });
    expect([...web.items.keys()]).toEqual(["a-k"]);
    expect(storage.load("k")).toEqual({ n: 1 });
  });

  it("does not throw when the app's storage does", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = {
      loadLocalStorage: () => {
        throw new Error("blocked");
      },
      saveLocalStorage: () => {
        throw new Error("quota");
      },
    };
    const storage = deviceStorage(asApp(app), () => null);
    expect(storage.load("k")).toBeNull();
    expect(() => storage.save("k", 1)).not.toThrow();
  });
});

describe("deviceStorage — the window's storage below 1.8.7", () => {
  it("keys each value by the vault, the way Obsidian keys its own", () => {
    // So the values carry over the day the app updates past 1.8.7.
    const web = webStorage();
    const storage = deviceStorage(asApp({ appId: "abc123" }), () => web);
    storage.save("gentle-pomodoro-open-session", { mode: "focus" });
    expect([...web.items.keys()]).toEqual(["abc123-gentle-pomodoro-open-session"]);
    expect(storage.load("gentle-pomodoro-open-session")).toEqual({ mode: "focus" });
    storage.save("gentle-pomodoro-open-session", null);
    expect(web.items.size).toBe(0);
  });

  it("scopes by the vault's name when the app's id cannot be read", () => {
    const web = webStorage();
    const vault = {
      name: "Planner",
      getName(this: { name: string }) {
        return this.name;
      },
    };
    deviceStorage(asApp({ vault }), () => web).save("k", 1);
    expect([...web.items.keys()]).toEqual(["gentle-pomo-Planner-k"]);
  });

  it("keeps two vaults on one device apart", () => {
    const web = webStorage();
    deviceStorage(asApp({ appId: "one" }), () => web).save("k", 1);
    expect(deviceStorage(asApp({ appId: "two" }), () => web).load("k")).toBeNull();
  });

  it("never throws: storage blocked, full, missing, or holding something unreadable", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throwing: WebStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const blocked = deviceStorage(asApp({ appId: "a" }), () => throwing);
    expect(blocked.load("k")).toBeNull();
    expect(() => blocked.save("k", 1)).not.toThrow();
    expect(() => blocked.save("k", null)).not.toThrow();

    const missing = deviceStorage(asApp({ appId: "a" }), () => null);
    expect(missing.load("k")).toBeNull();
    expect(() => missing.save("k", 1)).not.toThrow();

    const web = webStorage();
    web.items.set("a-k", "{not json");
    expect(deviceStorage(asApp({ appId: "a" }), () => web).load("k")).toBeNull();
  });
});
