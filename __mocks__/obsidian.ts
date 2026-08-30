// Minimal stubs for the parts of the Obsidian API exercised by unit tests.
// Only what the units under test actually import — extend as needed.

export class TFile {
  path: string = "";
  extension: string = "";
  basename: string = "";
}

export class TAbstractFile {
  path: string = "";
}

export class Plugin {}
export class ItemView {}
export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
}
export class Modal {}
export class WorkspaceLeaf {}
export class Notice {
  constructor(_message: string) {}
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function setIcon(_el: HTMLElement, _icon: string): void {}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, _ms?: number) {
  return (...args: A) => {
    fn(...args);
  };
}

export function requestUrl(_options: unknown): Promise<never> {
  return Promise.reject(new Error("requestUrl is not available in tests"));
}

export type App = unknown;

/* ===== Setting, recorded =====
 *
 * Enough of the builder for GentlePomoSettingTab's pre-1.13 display() path to
 * run headlessly. Every call is recorded on the instance, and each Setting
 * pushes itself onto the container element it was constructed with — so a test
 * can read back exactly what the tab rendered, in order.
 */

export interface RecordedComponent {
  kind: "toggle" | "text" | "dropdown" | "button";
  value?: unknown;
  placeholder?: string;
  buttonText?: string;
  options: { value: string; label: string }[];
  destructive: boolean;
  change?: (value: never) => void;
  click?: () => void;
}

function component(kind: RecordedComponent["kind"]): RecordedComponent {
  return { kind, options: [], destructive: false };
}

class ToggleStub {
  constructor(readonly rec: RecordedComponent) {}
  setValue(value: boolean): this {
    this.rec.value = value;
    return this;
  }
  onChange(cb: (value: boolean) => void): this {
    this.rec.change = cb as (value: never) => void;
    return this;
  }
}

class TextStub {
  constructor(readonly rec: RecordedComponent) {}
  setValue(value: string): this {
    this.rec.value = value;
    return this;
  }
  setPlaceholder(value: string): this {
    this.rec.placeholder = value;
    return this;
  }
  onChange(cb: (value: string) => void): this {
    this.rec.change = cb as (value: never) => void;
    return this;
  }
}

class DropdownStub {
  constructor(readonly rec: RecordedComponent) {}
  addOption(value: string, label: string): this {
    this.rec.options.push({ value, label });
    return this;
  }
  setValue(value: string): this {
    this.rec.value = value;
    return this;
  }
  onChange(cb: (value: string) => void): this {
    this.rec.change = cb as (value: never) => void;
    return this;
  }
}

class ButtonStub {
  // markDestructive probes for this by name, so it has to exist to be found.
  readonly buttonEl = {} as HTMLElement;
  constructor(readonly rec: RecordedComponent) {}
  setButtonText(text: string): this {
    this.rec.buttonText = text;
    return this;
  }
  onClick(cb: () => void): this {
    this.rec.click = cb;
    return this;
  }
  setWarning(): this {
    this.rec.destructive = true;
    return this;
  }
}

export type TextComponent = TextStub;
export type ButtonComponent = ButtonStub;

/** Just enough element for the rows that build their own DOM. */
export interface StubEl {
  classes: string[];
  children: StubEl[];
  text: string;
  addClass: (cls: string) => void;
  createDiv: (cls?: string) => StubEl;
  setText: (text: string) => void;
}

export function stubEl(cls = ""): StubEl {
  const el: StubEl = {
    classes: cls === "" ? [] : cls.split(" "),
    children: [],
    text: "",
    addClass: (c: string) => el.classes.push(c),
    createDiv: (c = "") => {
      const child = stubEl(c);
      el.children.push(child);
      return child;
    },
    setText: (t: string) => {
      el.text = t;
    },
  };
  return el;
}

export class Setting {
  readonly settingEl = stubEl();
  readonly controlEl = stubEl();
  name = "";
  desc = "";
  heading = false;
  readonly components: RecordedComponent[] = [];

  constructor(containerEl?: unknown) {
    const sink = containerEl as { settings?: Setting[] } | undefined;
    if (sink && Array.isArray(sink.settings)) sink.settings.push(this);
  }
  setName(name: string): this {
    this.name = name;
    return this;
  }
  setDesc(desc: string): this {
    this.desc = typeof desc === "string" ? desc : String(desc);
    return this;
  }
  setHeading(): this {
    this.heading = true;
    return this;
  }
  addToggle(cb: (c: ToggleStub) => unknown): this {
    const rec = component("toggle");
    this.components.push(rec);
    cb(new ToggleStub(rec));
    return this;
  }
  addText(cb: (c: TextStub) => unknown): this {
    const rec = component("text");
    this.components.push(rec);
    cb(new TextStub(rec));
    return this;
  }
  addDropdown(cb: (c: DropdownStub) => unknown): this {
    const rec = component("dropdown");
    this.components.push(rec);
    cb(new DropdownStub(rec));
    return this;
  }
  addButton(cb: (c: ButtonStub) => unknown): this {
    const rec = component("button");
    this.components.push(rec);
    cb(new ButtonStub(rec));
    return this;
  }
}
