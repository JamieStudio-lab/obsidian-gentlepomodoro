// Minimal stubs for the parts of the Obsidian API exercised by unit tests.
// Only what the units under test actually import — extend as needed.

export class TAbstractFile {
  path: string = "";
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  extension: string = "";
  basename: string = "";
  // Obsidian's FileStats. tests/fakeVault.ts moves mtime on each write that
  // changes a file, as Obsidian's does; 0 is a file last written long ago.
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Vault {
  /**
   * Obsidian's own walk, copied from app.js (1.7.7 and 1.13.7 read alike): a
   * stack, each folder's children pushed in order and popped from the END, so
   * a folder's LAST child is visited first. `getFiles()` is this walk from the
   * root, which is why tests/fakeVault.ts builds its getFiles on it — the order
   * the plugin sees in tests is then the order Obsidian really gives.
   */
  static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => unknown): void {
    let stack: TAbstractFile[] = [root];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next) continue;
      cb(next);
      if (next instanceof TFolder) stack = stack.concat(next.children);
    }
  }
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
  hide(): void {}
}
/**
 * Enough of a modal for the plugin's dialogs to open, be read and be closed
 * the way Obsidian closes them: `close()` runs `onClose`, as Esc, the close
 * button and a click outside all do. `opened` is the last one opened, and its
 * `contentEl.settings` the button rows it built.
 */
export class Modal {
  static opened: Modal | null = null;
  app: unknown;
  readonly modalEl = stubEl();
  readonly titleEl = stubEl();
  readonly contentEl = modalContent();
  constructor(app: unknown) {
    this.app = app;
  }
  open(): void {
    Modal.opened = this;
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

/**
 * Enough of the suggest modal for the sound picker to be constructed and
 * opened. `opened` records the last one opened, so a test can reach its items
 * and choose one the way a click would.
 */
export class FuzzySuggestModal<T> {
  static opened: FuzzySuggestModal<unknown> | null = null;
  app: unknown;
  emptyStateText = "";
  placeholder = "";
  constructor(app: unknown) {
    this.app = app;
  }
  setPlaceholder(placeholder: string): void {
    this.placeholder = placeholder;
  }
  open(): void {
    FuzzySuggestModal.opened = this as FuzzySuggestModal<unknown>;
  }
  close(): void {}
  getItems(): T[] {
    return [];
  }
  getItemText(_item: T): string {
    return "";
  }
  onChooseItem(_item: T, _evt?: unknown): void {}
}
export class WorkspaceLeaf {}
/**
 * Desktop by default, and MUTABLE on purpose: a test that needs the mobile
 * app flips a field and puts it back. Only the fields the plugin reads.
 */
export const Platform = { isDesktopApp: true, isMobile: false, isIosApp: false };
export class Notice {
  /** Every message shown, in order, so a test can read what the user was told. */
  static shown: string[] = [];
  /** Every message taken down by code (hide), in order: one shown "while it runs". */
  static hidden: string[] = [];
  constructor(private readonly message: string) {
    Notice.shown.push(message);
  }
  hide(): void {
    Notice.hidden.push(this.message);
  }
}

/**
 * Obsidian's own, copied from app.js (1.7.7 and 1.13.7 read alike): collapse
 * runs of slashes and backslashes, trim slashes at both ends ("" becomes "/"),
 * turn the two no-break spaces into spaces, then NFC. Exact rather than close,
 * because the folder settings go through it and a simpler stand-in hides the
 * inputs (a leading slash, a no-break space, a decomposed accent) on which the
 * real one decides which folder is meant.
 */
export function normalizePath(path: string): string {
  let normalized = path.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "");
  if (normalized === "") normalized = "/";
  return normalized.replace(/\u00A0|\u202F/g, " ").normalize("NFC");
}

/** Records the icon on a stub element, so a test can read which one a button got. */
export function setIcon(el: HTMLElement, icon: string): void {
  const stub = el as unknown as { icon?: string };
  if (typeof stub === "object" && stub !== null) stub.icon = icon;
}

/** Obsidian's: a link's text up to its `#heading` or `#^block`. */
export function getLinkpath(linktext: string): string {
  const hash = linktext.indexOf("#");
  return hash === -1 ? linktext : linktext.slice(0, hash);
}

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
  kind: "toggle" | "text" | "dropdown" | "button" | "extraButton";
  icon?: string;
  tooltip?: string;
  value?: unknown;
  placeholder?: string;
  buttonText?: string;
  options: { value: string; label: string }[];
  destructive: boolean;
  /** Styled as the dialog's call to action (setCta). */
  cta?: boolean;
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
  setCta(): this {
    this.rec.cta = true;
    return this;
  }
}

class ExtraButtonStub {
  constructor(readonly rec: RecordedComponent) {}
  setIcon(icon: string): this {
    this.rec.icon = icon;
    return this;
  }
  setTooltip(tooltip: string): this {
    this.rec.tooltip = tooltip;
    return this;
  }
  onClick(cb: () => void): this {
    this.rec.click = cb;
    return this;
  }
}

export type TextComponent = TextStub;
export type ButtonComponent = ButtonStub;

/** What createEl takes, as Obsidian's DomElementInfo has it — the parts used. */
export interface StubElInfo {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
}

/** Just enough element for the rows that build their own DOM. */
export interface StubEl {
  tag: string;
  classes: string[];
  children: StubEl[];
  /** The element this one was created in, or moved into. */
  parent: StubEl | null;
  text: string;
  attrs: Record<string, string>;
  /** A form control's value (a textarea's text). */
  value: string;
  /** Set by select(): the whole value is selected. */
  selected: boolean;
  /** The components built on this element (ToggleComponent, ExtraButtonComponent). */
  controls: unknown[];
  addClass: (cls: string) => void;
  toggleClass: (cls: string, on: boolean) => void;
  createDiv: (cls?: string | StubElInfo) => StubEl;
  createEl: (tag: string, info?: StubElInfo) => StubEl;
  createSpan: (info?: StubElInfo) => StubEl;
  setText: (text: string) => void;
  setAttr: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
  /** Listeners added with addEventListener, by event type; pressKey runs them. */
  listeners: Record<string, ((event: never) => void)[]>;
  /** The same, added with `{ capture: true }`; clickEl runs them on the way down. */
  captureListeners: Record<string, ((event: never) => void)[]>;
  addEventListener: (
    type: string,
    listener: (event: never) => void,
    options?: boolean | { capture?: boolean }
  ) => void;
  /** Node.contains: this element or one inside it. */
  contains: (node: unknown) => boolean;
  /** The icon setIcon put on it. */
  icon?: string;
  empty: () => void;
  /** ChildNode.remove: out of its parent, dropping the focus it holds. */
  remove: () => void;
  /** ChildNode.before / after: `node` moved next to this one, in its parent. */
  before: (node: StubEl) => void;
  after: (node: StubEl) => void;
  /** Takes focus only where Chromium would: see focusable(). */
  focus: () => void;
  select: () => void;
}

/**
 * Whether Chromium would let focus() land here: a button, a form control, a
 * summary or a link, or anything with a tabindex — never a disabled one. A
 * bare div ignores focus(), as a disabled ExtraButton (tabindex taken off)
 * does: a test of where focus goes must not pass by focusing one.
 */
function focusable(el: StubEl): boolean {
  if (el.attrs.disabled !== undefined) return false;
  if (el.attrs.tabindex !== undefined) return true;
  if (el.tag === "a") return el.attrs.href !== undefined;
  return ["button", "input", "select", "textarea", "summary"].includes(el.tag);
}

/**
 * The element focus() was last called on, and how many times a move took
 * focus away from the page; tests reset both.
 */
export const stubFocus: { el: StubEl | null; dropped: number } = { el: null, dropped: 0 };

/**
 * As Chromium does: a node taken out of the page, even to be put straight
 * back, drops the focus it holds (or holds inside it).
 */
function dropFocusIn(node: StubEl): void {
  for (let f = stubFocus.el; f !== null; f = f.parent) {
    if (f === node) {
      stubFocus.el = null;
      stubFocus.dropped++;
      return;
    }
  }
}

export function stubEl(cls = "", tag = "div"): StubEl {
  const place = (node: StubEl, offset: 0 | 1) => {
    const parent = el.parent;
    if (parent === null) throw new Error("before/after on an element with no parent");
    const from = parent.children.indexOf(node);
    if (from !== -1) parent.children.splice(from, 1);
    dropFocusIn(node);
    parent.children.splice(parent.children.indexOf(el) + offset, 0, node);
    node.parent = parent;
  };
  const adopt = (child: StubEl) => {
    child.parent = el;
    el.children.push(child);
    return child;
  };
  const make = (tagName: string, info?: StubElInfo) => {
    const child = adopt(stubEl(info?.cls ?? "", tagName));
    if (info?.text !== undefined) child.text = info.text;
    if (info?.attr) Object.assign(child.attrs, info.attr);
    return child;
  };
  const el: StubEl = {
    tag,
    classes: cls === "" ? [] : cls.split(" "),
    children: [],
    parent: null,
    text: "",
    attrs: {},
    value: "",
    selected: false,
    controls: [],
    listeners: {},
    captureListeners: {},
    addEventListener: (
      type: string,
      listener: (event: never) => void,
      options?: boolean | { capture?: boolean }
    ) => {
      const capture = options === true || (typeof options === "object" && options.capture === true);
      ((capture ? el.captureListeners : el.listeners)[type] ??= []).push(listener);
    },
    contains: (node: unknown) => {
      for (let n = node as StubEl | null; n !== null && n !== undefined; n = n.parent) {
        if (n === el) return true;
      }
      return false;
    },
    addClass: (c: string) => el.classes.push(c),
    toggleClass: (c: string, on: boolean) => {
      const at = el.classes.indexOf(c);
      if (on && at === -1) el.classes.push(c);
      if (!on && at !== -1) el.classes.splice(at, 1);
    },
    createDiv: (c: string | StubElInfo = "") => make("div", typeof c === "string" ? { cls: c } : c),
    createEl: (tagName: string, info?: StubElInfo) => make(tagName, info),
    createSpan: (info?: StubElInfo) => make("span", info),
    setText: (t: string) => {
      el.text = t;
    },
    setAttr: (name: string, value: string) => {
      el.attrs[name] = value;
    },
    getAttribute: (name: string) => el.attrs[name] ?? null,
    removeAttribute: (name: string) => {
      delete el.attrs[name];
    },
    empty: () => {
      for (const child of el.children) {
        dropFocusIn(child);
        child.parent = null;
      }
      el.children.length = 0;
      el.controls.length = 0;
      el.text = "";
    },
    remove: () => {
      dropFocusIn(el);
      const parent = el.parent;
      if (parent === null) return;
      const at = parent.children.indexOf(el);
      if (at !== -1) parent.children.splice(at, 1);
      el.parent = null;
    },
    before: (node: StubEl) => place(node, 0),
    after: (node: StubEl) => place(node, 1),
    focus: () => {
      if (focusable(el)) stubFocus.el = el;
    },
    select: () => {
      el.selected = true;
    },
  };
  return el;
}

/**
 * A click on an element, as the browser dispatches it: the capture listeners
 * of every element above it, from the top down, then its own click
 * listeners (then, it not being modelled, no bubbling). `detail` is the click
 * count — 2 for the second click of a double click. stopPropagation stops
 * the rest. Says whether a listener called stopPropagation.
 */
export function clickEl(el: StubEl, detail = 1): boolean {
  let stopped = false;
  const event = {
    detail,
    target: el,
    stopPropagation: () => (stopped = true),
    preventDefault: () => undefined,
  };
  const above: StubEl[] = [];
  for (let n = el.parent; n !== null; n = n.parent) above.unshift(n);
  for (const node of above) {
    for (const listener of node.captureListeners.click ?? []) {
      listener(event as never);
      if (stopped) return true;
    }
  }
  for (const listener of el.listeners.click ?? []) listener(event as never);
  return stopped;
}

/**
 * A key pressed on an element: its keydown listeners run, as the browser
 * would run them. Says whether one of them called preventDefault.
 */
export function pressKey(el: StubEl, key: string): boolean {
  let prevented = false;
  const event = { key, preventDefault: () => (prevented = true) };
  for (const listener of el.listeners.keydown ?? []) listener(event as never);
  return prevented;
}

/**
 * Which Obsidian's ExtraButton the mock builds: 1.13's, a div with tabindex
 * 0 that Enter and Space press (app.js, 1.13.7), or 1.7's, a bare div with a
 * click listener only (app.js, 1.7.7) — minAppVersion is 1.7.2. Tests reset it.
 */
export const stubObsidian: { extraButton: "1.13" | "1.7" } = { extraButton: "1.13" };

/**
 * Obsidian's switch, built on its own into an element (the column list), as
 * 1.14's app.js has it: setValue runs the change handler when the value
 * moves, and a click does nothing while it is disabled.
 */
export class ToggleComponent {
  readonly toggleEl: StubEl;
  disabled = false;
  tooltip = "";
  private on = false;
  private changeCallback: ((on: boolean) => void) | null = null;
  constructor(containerEl: StubEl) {
    this.toggleEl = containerEl.createDiv("checkbox-container");
    containerEl.controls.push(this);
  }
  getValue(): boolean {
    return this.on;
  }
  setValue(on: boolean): this {
    if (this.on !== on) {
      this.on = on;
      this.changeCallback?.(on);
    }
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.toggleEl.toggleClass("is-disabled", disabled);
    return this;
  }
  setTooltip(tooltip: string): this {
    this.tooltip = tooltip;
    return this;
  }
  onChange(cb: (on: boolean) => void): this {
    this.changeCallback = cb;
    return this;
  }
  /** What a click does. */
  click(): void {
    if (!this.disabled) this.setValue(!this.on);
  }
}

/**
 * Obsidian's icon button, as 1.14's app.js has it: a focusable element
 * (tabindex 0) that loses its tabindex while disabled, and a click that does
 * nothing then.
 */
export class ExtraButtonComponent {
  readonly extraSettingsEl: StubEl;
  disabled = false;
  icon = "";
  private clickCallback: (() => void) | null = null;
  private readonly modern = stubObsidian.extraButton === "1.13";
  constructor(containerEl: StubEl) {
    this.extraSettingsEl = containerEl.createDiv("clickable-icon extra-setting-button");
    // Both versions listen for the click on the element itself.
    this.extraSettingsEl.addEventListener("click", () => {
      if (!this.disabled) this.clickCallback?.();
    });
    if (this.modern) {
      this.extraSettingsEl.setAttr("tabindex", "0");
      this.extraSettingsEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.click();
      });
    }
    containerEl.controls.push(this);
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.extraSettingsEl.toggleClass("is-disabled", disabled);
    if (!this.modern) return this;
    if (disabled) this.extraSettingsEl.removeAttribute("tabindex");
    else this.extraSettingsEl.setAttr("tabindex", "0");
    return this;
  }
  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }
  setTooltip(tooltip: string): this {
    this.extraSettingsEl.setAttr("aria-label", tooltip);
    return this;
  }
  onClick(cb: () => void): this {
    this.clickCallback = cb;
    return this;
  }
  /** A click on its element, through clickEl: capture listeners above it run first. */
  click(detail = 1): void {
    clickEl(this.extraSettingsEl, detail);
  }
}

/** An element inside a modal's content; its own children's text is recorded too. */
export interface ModalChild extends StubEl {
  createEl: (tag: string, options?: StubElInfo) => ModalChild;
}

/** A modal's content: an element, the text written into it (paragraphs and
 *  list items, in order), and the Setting rows built on it (Setting pushes
 *  itself onto `settings`). A div made inside it is one too, with its own
 *  rows and text, so a list a dialog fills and empties can be read back. */
export interface ModalContent extends StubEl {
  paragraphs: string[];
  /** Every element createEl made in it, in order: a textarea can be read back. */
  elements: ModalChild[];
  settings: Setting[];
  createEl: (tag: string, options?: { text?: string }) => ModalChild;
  createDiv: (cls?: string) => ModalContent;
  children: ModalContent[];
  empty: () => void;
}

function modalContent(cls = ""): ModalContent {
  const child = (tag: string, options?: StubElInfo): ModalChild => {
    if (options?.text !== undefined) content.paragraphs.push(options.text);
    const el: ModalChild = Object.assign(stubEl(options?.cls ?? "", tag), {
      createEl: (inner: string, info?: StubElInfo) => child(inner, info),
    });
    if (options?.attr) Object.assign(el.attrs, options.attr);
    content.elements.push(el);
    return el;
  };
  const content: ModalContent = Object.assign(stubEl(cls), {
    paragraphs: [] as string[],
    elements: [] as ModalChild[],
    settings: [] as Setting[],
    children: [] as ModalContent[],
    createEl: (tag: string, options?: StubElInfo) => child(tag, options),
    createDiv: (c = "") => {
      const div = modalContent(c);
      content.children.push(div);
      return div;
    },
    // Divs stay listed: a test may read a dialog's note after it closed.
    empty: () => {
      content.paragraphs.length = 0;
      content.settings.length = 0;
    },
  });
  return content;
}

export class Setting {
  readonly settingEl = stubEl();
  readonly infoEl = stubEl();
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
  addExtraButton(cb: (c: ExtraButtonStub) => unknown): this {
    const rec = component("extraButton");
    this.components.push(rec);
    cb(new ExtraButtonStub(rec));
    return this;
  }
}
