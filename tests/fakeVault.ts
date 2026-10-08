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
 * A file's `stat.mtime` is 0 until a write changes it, then the time of that
 * write (Date.now(), fake timers included): the files a test starts with were
 * written before anything it does.
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
  /** Move or rename a file, as fileManager.renameFile does: the same TFile, its path changed. */
  move(file: TFile, to: string): void;
  /** Take a file out of the vault, as fileManager.trashFile does. */
  remove(file: TFile): void;
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
  /** Put `file` at `path`: its name, its folder, the lookups. */
  const place = (file: TFile, path: string) => {
    const cut = path.lastIndexOf("/");
    const parent = folderAt(cut === -1 ? "" : path.slice(0, cut));
    const name = path.slice(cut + 1);
    const extension = extensionOf(name);
    const basename = extension ? name.slice(0, name.length - extension.length - 1) : name;
    Object.assign(file, { path, parent, extension, basename });
    parent.children.push(file);
    byPath.set(path, file);
    fileMap[path] = file;
  };
  const unplace = (file: TFile) => {
    const parent = file.parent;
    if (parent) parent.children.splice(parent.children.indexOf(file), 1);
    byPath.delete(file.path);
    Reflect.deleteProperty(fileMap, file.path);
  };
  for (const path of Object.keys(files)) place(new TFile(), path);

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
      file.stat.mtime = Date.now();
      return Promise.resolve();
    },
    // Obsidian's process writes only when the text changes (the adapter's
    // process, app.js 1.13.7), and so moves the modification time only then.
    process: (file, fn) => {
      const data = fn(contents[file.path]);
      if (data !== contents[file.path]) file.stat.mtime = Date.now();
      contents[file.path] = data;
      writes.push(file.path);
      return Promise.resolve(contents[file.path]);
    },
    contents,
    writes,
    move: (file, to) => {
      const content = contents[file.path];
      Reflect.deleteProperty(contents, file.path);
      unplace(file);
      place(file, to);
      contents[to] = content;
    },
    remove: (file) => {
      Reflect.deleteProperty(contents, file.path);
      unplace(file);
    },
  };
}

/** The part of a path after its last "/", and the part before it ("" at the root). */
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string) => {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
};

/**
 * Obsidian's `MetadataCache.getLinkpathDest`, copied from app.js (1.7.7 and
 * 1.13.7 read alike): the notes a link can lead to from `sourcePath`, best
 * first. Case is ignored. A link with no extension means its ".md" note. A
 * name alone held by one note is that note. A `./` or `../` link is read from
 * the source's folder. Then an exact path wins; and otherwise every note whose
 * path ends with the link, those under the source's folder first, each group
 * shortest path first. So the source path decides between two notes of one
 * name, and where a relative link leads. Obsidian's uniqueFileLookup (notes by
 * lower-cased file name) is a walk of the tree here.
 */
function linkpathDest(vault: FakeVault, linkpath: string, sourcePath: string): TFile[] {
  if (linkpath === "" && sourcePath) {
    const source = vault.getAbstractFileByPath(sourcePath);
    if (source instanceof TFile) return [source];
  }
  const named = (name: string) => {
    const list: TFile[] = [];
    Vault.recurseChildren(vault.root, (item) => {
      if (item instanceof TFile && nameOf(item.path).toLowerCase() === name) list.push(item);
    });
    return list;
  };
  let link = linkpath.toLowerCase();
  let name = nameOf(link);
  let candidates = name.includes(".") ? named(name) : [];
  if (candidates.length === 0) {
    link = `${linkpath}.md`.toLowerCase();
    name = nameOf(link);
    candidates = named(name);
  }
  if (candidates.length === 0) return [];
  if (name === link && candidates.length === 1) return candidates.slice();

  const at = (path: string) => candidates.find((file) => file.path.toLowerCase() === path);
  let folder = folderOf(sourcePath).toLowerCase();
  if (link.startsWith("./") || link.startsWith("../")) {
    if (link.startsWith("./../")) link = link.slice(2);
    if (link.startsWith("./")) {
      if (folder !== "") folder += "/";
      link = folder + link.slice(2);
    } else {
      while (link.startsWith("../")) {
        link = link.slice(3);
        folder = folderOf(folder);
      }
      if (folder !== "") folder += "/";
      link = folder + link;
    }
    const relative = at(link);
    if (relative) return [relative];
  }
  if (link.startsWith("/")) link = link.slice(1);
  const exact = at(link);
  if (exact) return [exact];
  if (linkpath.startsWith("/")) return [];

  const near: TFile[] = [];
  const far: TFile[] = [];
  for (const file of candidates) {
    const path = file.path.toLowerCase();
    if (path.endsWith(link)) (path.startsWith(folder) ? near : far).push(file);
  }
  const shortestFirst = (a: TFile, b: TFile) => a.path.length - b.path.length;
  return [...near.sort(shortestFirst), ...far.sort(shortestFirst)];
}

/**
 * Obsidian's metadataCache over a fake vault, as far as the log's links need
 * it: `getFirstLinkpathDest` is Obsidian's (linkpathDest above), so a link
 * Obsidian shortened when the note moved, `[[Toy|…]]`, or rewrote as a
 * relative path, leads where it would in Obsidian. `sources` records the
 * source path of every lookup, in order, so a test can see which file each
 * link was read from. Walks the tree rather than calling `getFiles`, so a test
 * can still assert that a feature lists nothing.
 */
export function linkCache(vault: FakeVault) {
  const sources: string[] = [];
  return {
    sources,
    getFirstLinkpathDest: (linkpath: string, sourcePath: string): TFile | null => {
      sources.push(sourcePath);
      return linkpathDest(vault, linkpath, sourcePath)[0] ?? null;
    },
  };
}
