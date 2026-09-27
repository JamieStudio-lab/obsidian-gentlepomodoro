import { vi } from "vitest";
import { TAbstractFile, TFile, TFolder, Vault } from "obsidian";

/**
 * A vault shaped the way Obsidian's is, for the code that walks it.
 *
 * Built from a path → content map into a real tree of the mock's TFile and
 * TFolder, with `parent` and `children` set, and the root keyed `"/"` as the
 * real `fileMap` keys it. Folders are created the first time a path needs
 * them, and each folder's children are in the order the map listed them. The
 * paths should be ones Obsidian could hold: already `normalizePath`'d.
 *
 * `getAbstractFileByPath` reads a PLAIN OBJECT through `hasOwnProperty`, as
 * Obsidian's does, quirk included: a top-level item named `__proto__` sets the
 * object's prototype instead of adding a key, so the lookup cannot see it
 * while the tree (and so `getFiles`) still holds it.
 *
 * `getFiles()` is `Vault.recurseChildren` from the root, which is exactly what
 * Obsidian's is (read out of app.js, 1.7.7 and 1.13.7), so the order a test
 * sees is the order the plugin really gets — including the one place it shows,
 * a tie in loadTasks' sort. It is a spy, so a test can assert that a feature
 * no longer lists the vault at all.
 */
export interface FakeVault {
  root: TFolder;
  getRoot(): TFolder;
  getFiles: ReturnType<typeof vi.fn<() => TFile[]>>;
  getAbstractFileByPath(path: string): TAbstractFile | null;
  cachedRead(file: TFile): Promise<string>;
  read(file: TFile): Promise<string>;
  modify(file: TFile, data: string): Promise<void>;
  process(file: TFile, fn: (data: string) => string): Promise<string>;
  /** The current content of every file, writes included. */
  contents: Record<string, string>;
  /** The paths written, in the order they were written. */
  writes: string[];
}

/** Obsidian's rule: after the last dot, lower-cased; none for a leading dot. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function fakeVault(files: Record<string, string>, extraFolders: string[] = []): FakeVault {
  const root = Object.assign(new TFolder(), { path: "/" });
  const byPath = new Map<string, TAbstractFile>([["/", root]]);
  // Obsidian's fileMap: a plain object, written by plain assignment.
  const fileMap: Record<string, TAbstractFile> = { "/": root };
  const own = (path: string) => Object.prototype.hasOwnProperty.call(fileMap, path);
  const contents: Record<string, string> = { ...files };

  const folderAt = (path: string): TFolder => {
    if (path === "") return root;
    const existing = byPath.get(path);
    if (existing instanceof TFolder) return existing;
    const cut = path.lastIndexOf("/");
    const parent = folderAt(cut === -1 ? "" : path.slice(0, cut));
    const folder = Object.assign(new TFolder(), { path, parent });
    parent.children.push(folder);
    byPath.set(path, folder);
    fileMap[path] = folder;
    return folder;
  };

  for (const path of extraFolders) folderAt(path);
  for (const path of Object.keys(files)) {
    const cut = path.lastIndexOf("/");
    const parent = folderAt(cut === -1 ? "" : path.slice(0, cut));
    const name = path.slice(cut + 1);
    const extension = extensionOf(name);
    const basename = extension ? name.slice(0, name.length - extension.length - 1) : name;
    const file = Object.assign(new TFile(), { path, parent, extension, basename });
    parent.children.push(file);
    byPath.set(path, file);
    fileMap[path] = file;
  }

  const writes: string[] = [];
  return {
    root,
    getRoot: () => root,
    getFiles: vi.fn(() => {
      const list: TFile[] = [];
      Vault.recurseChildren(root, (item) => {
        if (item instanceof TFile) list.push(item);
      });
      return list;
    }),
    getAbstractFileByPath: (path) => (own(path) ? fileMap[path] : null),
    cachedRead: (file) => Promise.resolve(contents[file.path]),
    read: (file) => Promise.resolve(contents[file.path]),
    modify: (file, data) => {
      contents[file.path] = data;
      writes.push(file.path);
      return Promise.resolve();
    },
    process: (file, fn) => {
      contents[file.path] = fn(contents[file.path]);
      writes.push(file.path);
      return Promise.resolve(contents[file.path]);
    },
    contents,
    writes,
  };
}
