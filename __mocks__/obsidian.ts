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
export class PluginSettingTab {}
export class Setting {}
export class WorkspaceLeaf {}
export class Notice {
  constructor(_message: string) {}
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function setIcon(_el: HTMLElement, _icon: string): void {}

export type App = unknown;
