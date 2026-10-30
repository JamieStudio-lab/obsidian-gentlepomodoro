import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * Dataview 0.5.68's own engine, in node, for the code the settings' Copy
 * buttons give (logQueries.ts). Nothing is reimplemented: the query parser,
 * the evaluator, the DataviewJS API and the worker that turns a file into its
 * fields are Dataview's, read out of an unmodified copy of its main.js
 * (tests/fixtures/dataview, MIT — see the LICENSE.txt beside it).
 *
 * What is NOT Dataview's, and so what this can get wrong:
 *
 * - Obsidian's metadata cache, which tells the worker where the list items,
 *   the frontmatter and the links are. `metadataOf` builds it for the simple
 *   files the tests use: dash list items, `---` properties, `[[path|name]]`.
 * - The vault index Dataview keeps (`buildIndex`): the pages, the folder
 *   lookup FROM uses and the link resolution, built the way its FullIndex
 *   builds them.
 * - The DOM: tables are captured, never drawn.
 *
 * The bundle is evaluated as text with an export line after it, so the copy
 * stays byte for byte what Dataview ships; `obsidian` and `@codemirror/*` are
 * stand-ins that answer anything (the query engine touches none of them).
 */

const here = dirname(fileURLToPath(import.meta.url));
export const DATAVIEW_BUNDLE = resolve(here, "fixtures/dataview/main.js");

/* eslint-disable @typescript-eslint/no-explicit-any -- the bundle is untyped */
type Any = any;

/** A stand-in that answers every property, call and `new` with another one. */
function universal(name: string): Any {
  const cache: Record<string | symbol, unknown> = {};
  const target = function () {};
  return new Proxy(target, {
    get(t, p) {
      if (p === "prototype") return t.prototype;
      if (p === Symbol.toPrimitive) return () => name;
      if (p === "then" || p === Symbol.iterator) return undefined;
      if (!(p in cache)) cache[p] = universal(`${name}.${String(p)}`);
      return cache[p];
    },
    apply: () => universal(`${name}()`),
    construct: (_t, _args, newTarget) => Reflect.construct(Object, [], newTarget) as object,
  });
}

class Component {
  addChild<T>(child: T): T {
    return child;
  }
  removeChild(): void {}
  register(): void {}
  registerEvent(): void {}
  registerInterval(): void {}
  registerDomEvent(): void {}
  load(): void {}
  unload(): void {}
  onload(): void {}
  onunload(): void {}
}

/** The classes the bundle extends at load must be real classes. */
const obsidianClasses: Record<string, unknown> = {
  Component,
  TAbstractFile: class {},
  TFile: class {},
  TFolder: class {},
  MarkdownRenderChild: class extends Component {
    containerEl: unknown;
    constructor(containerEl: unknown) {
      super();
      this.containerEl = containerEl;
    }
  },
  Plugin: class extends Component {},
  PluginSettingTab: class {},
  ItemView: class extends Component {},
  Modal: class {},
  Setting: class {},
  Notice: class {},
  Platform: { isMobile: false, isDesktop: true },
  apiVersion: "1.7.7",
};

const obsidianStub = new Proxy(obsidianClasses, {
  get(t, p: string) {
    if (p in t) return t[p];
    if (p === "__esModule") return false;
    t[p] = universal(`obsidian.${p}`);
    return t[p];
  },
});

const STUBS: Record<string, unknown> = {
  obsidian: obsidianStub,
  "@codemirror/state": universal("@codemirror/state"),
  "@codemirror/view": universal("@codemirror/view"),
  "@codemirror/language": universal("@codemirror/language"),
};

/** What the export line hands out: names defined at the bundle's top level. */
const EXPORTS = [
  "parseQuery",
  "executeTable",
  "PageMetadata",
  "Transferable",
  "DEFAULT_SETTINGS",
  "DataviewApi",
  "DataviewInlineApi",
  "Values",
  "Settings",
  "IndexMap",
  "ValueCaseInsensitiveIndexMap",
  "Result",
  "DataArray",
];

export interface Dataview {
  dv: Any;
  /** The worker's own parse of one file: what Dataview's index holds for it. */
  parseFile(path: string, contents: string, frontmatter?: Record<string, unknown>): Promise<Any>;
}

let loaded: Dataview | null = null;

/** The bundle, evaluated once per test file. */
export function loadDataview(): Dataview {
  if (loaded) return loaded;
  const src = readFileSync(DATAVIEW_BUNDLE, "utf8");
  const mod: { exports: Any } = { exports: {} };
  const fakeRequire = (name: string): unknown => {
    if (name in STUBS) return STUBS[name];
    throw new Error(`The Dataview bundle asked for "${name}"`);
  };
  const tail = `\n;module.exports.__gp = { ${EXPORTS.join(", ")} };\n`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- a copy of Dataview, on purpose
  const run = new Function("require", "module", "exports", src + tail) as (
    r: typeof fakeRequire,
    m: typeof mod,
    e: unknown
  ) => void;
  run(fakeRequire, mod, mod.exports);
  const dv = (mod.exports as { __gp: Any }).__gp;

  // The worker the bundle starts for its index, decoded as its own createURL
  // decodes it (base64 read as Latin-1, its first line dropped) and run in a
  // context of its own, as a worker is.
  const encoded = /createBase64WorkerFactory\('([A-Za-z0-9+/=]+)', null, false\)/.exec(src);
  if (!encoded) throw new Error("No worker in the Dataview bundle");
  const source = Buffer.from(encoded[1], "base64").toString("latin1");
  const body = source.substring(source.indexOf("\n", 10) + 1);
  const posted: { result: unknown }[] = [];
  const context: Record<string, unknown> = {
    console,
    postMessage: (message: { result: unknown }) => posted.push(message),
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    URL,
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(body, context);
  const onmessage = context.onmessage as (event: { data: unknown }) => Promise<void>;

  async function parseFile(
    path: string,
    contents: string,
    frontmatter?: Record<string, unknown>
  ): Promise<Any> {
    posted.length = 0;
    await onmessage({
      data: {
        path,
        contents,
        stat: { ctime: Date.UTC(2026, 9, 20), mtime: Date.UTC(2026, 9, 23), size: contents.length },
        metadata: metadataOf(contents, frontmatter),
      },
    });
    // postMessage clones what it sends; so does this, which also brings the
    // worker's Maps into this realm. Then main.js's own decoder.
    const result = (structuredClone(posted[0]) as { result: Any }).result;
    if (result?.$error) throw new Error(String(result.$error));
    return dv.Transferable.value(result);
  }

  loaded = { dv, parseFile };
  return loaded;
}

/**
 * The part of Obsidian's CachedMetadata the worker reads, for files made of
 * properties, headings, prose and dash list items: each item's line and its
 * parent (a top-level item's parent is minus the first line of its list, as
 * Obsidian has it), the list sections, and each `[[link|name]]`.
 */
function metadataOf(contents: string, frontmatter?: Record<string, unknown>): Any {
  const lines = contents.split("\n");
  const listItems: Any[] = [];
  const sections: Any[] = [];
  const links: Any[] = [];
  const at = (line: number, col: number) => ({ line, col, offset: 0 });
  let end = -1;
  if (lines[0] === "---") {
    end = lines.indexOf("---", 1);
    sections.push({ type: "yaml", position: { start: at(0, 0), end: at(end, 3) } });
  }
  let listStart = -1;
  for (let i = end + 1; i <= lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && /^\s*([-*+]|\d+[.)])\s/.test(line)) {
      if (listStart < 0) listStart = i;
      const item: Any = {
        position: { start: at(i, 0), end: at(i, line.length) },
        parent: -listStart,
      };
      const task = /^\s*([-*+]|\d+[.)])\s+\[(.)\]/.exec(line);
      if (task) item.task = task[2];
      listItems.push(item);
      for (const m of line.matchAll(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) {
        const col = m.index ?? 0;
        links.push({
          link: m[1],
          original: m[0],
          displayText: m[2] ?? m[1],
          position: { start: at(i, col), end: at(i, col + m[0].length) },
        });
      }
    } else if (listStart >= 0) {
      sections.push({ type: "list", position: { start: at(listStart, 0), end: at(i - 1, 0) } });
      listStart = -1;
    }
  }
  const metadata: Any = { listItems, sections, headings: [], links, tags: [] };
  if (frontmatter) metadata.frontmatter = frontmatter;
  return metadata;
}

/** A fake vault: path → the file's text, and its properties when it has any. */
export type FakeFiles = Record<string, { contents: string; frontmatter?: Record<string, unknown> }>;

/**
 * The index the queries run over, built as Dataview's FullIndex finishes a
 * file: the worker's parse, canonicalised with the link resolution, then the
 * folder lookup FROM reads.
 */
export async function buildIndex(files: FakeFiles): Promise<Any> {
  const { dv, parseFile } = loadDataview();
  const paths = Object.keys(files);
  const metadataCache = {
    getFirstLinkpathDest(link: string) {
      const bare = link.replace(/#.*$/, "");
      const exact = [bare, `${bare}.md`].find((p) => paths.includes(p));
      if (exact) return { path: exact };
      const named = paths.find((p) => {
        const name = p.split("/").pop();
        return name === bare || name === `${bare}.md`;
      });
      return named ? { path: named } : null;
    },
    resolvedLinks: {},
    trigger() {},
  };
  const pages = new Map<string, Any>();
  const links = new dv.IndexMap();
  const tags = new dv.ValueCaseInsensitiveIndexMap();
  const etags = new dv.ValueCaseInsensitiveIndexMap();
  for (const path of paths) {
    const parsed = await parseFile(path, files[path].contents, files[path].frontmatter);
    const meta = dv.PageMetadata.canonicalize(parsed, (link: Any) => {
      const real = metadataCache.getFirstLinkpathDest(link.path);
      return real ? link.withPath(real.path) : link;
    });
    pages.set(path, meta);
    tags.set(path, meta.fullTags());
    etags.set(path, meta.tags);
    links.set(path, new Set(meta.links.map((l: Any) => l.path)));
  }
  const folders = new Set([""]);
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const inFolder = (folder: string, path: string) =>
    folder === "" || folder === "/" || path.startsWith(`${folder}/`);
  return {
    pages,
    links,
    tags,
    etags,
    metadataCache,
    prefix: {
      nodeExists: (folder: string) => folders.has(folder || ""),
      pathExists: (path: string) => folders.has(path || "") || paths.includes(path),
      get: (folder: string, filter?: (path: string) => boolean) =>
        new Set(paths.filter((p) => inFolder(folder || "", p) && (!filter || filter(p)))),
      resolveRelative: (path: string) => path,
    },
    starred: { starred: () => false },
    vault: { getMarkdownFiles: () => paths.map((path) => ({ path })) },
    csv: { get: () => Promise.resolve(dv.Result.failure("no csv")) },
  };
}

/** Dataview's clock: what `date(today)`, `date(now)` and `dv.date("today")` read. */
export function setNow(at: Date): void {
  const ms = at.getTime();
  loadDataview().dv.Settings.now = () => ms;
}

/** A table as the engine made it. */
export interface TableResult {
  headers: string[];
  rows: unknown[][];
  /** Rows a cell or a WHERE failed on: Dataview drops them without a word. */
  rowErrors: string[];
}

/** Strip a fenced block down to its body, checking its language. */
function body(code: string, lang: string): string {
  const m = new RegExp(`^(\`{3,})${lang}\\n([\\s\\S]*)\\n\\1$`).exec(code);
  if (!m) throw new Error(`Not one fenced ${lang} block:\n${code}`);
  return m[2];
}

/** Run a copied ```dataview block as Dataview runs a TABLE query in `origin`. */
export async function runDql(code: string, index: Any, origin: string): Promise<TableResult> {
  const { dv } = loadDataview();
  const parsed = dv.parseQuery(body(code, "dataview"));
  if (!parsed.successful) throw new Error(`Dataview could not parse it: ${String(parsed.error)}`);
  if (parsed.value.header.type !== "table") throw new Error("Not a TABLE query");
  const run = await dv.executeTable(parsed.value, index, origin, dv.DEFAULT_SETTINGS);
  if (!run.successful) throw new Error(`Dataview could not run it: ${String(run.error)}`);
  const rowErrors = (run.value.core.diagnostics as { errors: { message: string }[] }[]).flatMap(
    (d) => d.errors.map((e) => e.message)
  );
  return { headers: run.value.names, rows: run.value.data, rowErrors };
}

/**
 * Run a copied ```dataviewjs block as Dataview runs one in `origin`: a real
 * DataviewInlineApi, its `dv.table` captured.
 */
export async function runDataviewJs(
  code: string,
  index: Any,
  origin: string
): Promise<TableResult> {
  const { dv } = loadDataview();
  const app = { vault: index.vault, metadataCache: index.metadataCache, workspace: {} };
  const api = new dv.DataviewApi(app, index, dv.DEFAULT_SETTINGS, "0.5.68");
  const tables: TableResult[] = [];
  api.table = (headers: unknown, values: unknown) => {
    const list = (v: unknown): unknown[] =>
      dv.DataArray.isDataArray(v) ? (v as { array(): unknown[] }).array() : Array.from(v as []);
    tables.push({
      headers: list(headers) as string[],
      rows: list(values).map(list),
      rowErrors: [],
    });
    return Promise.resolve();
  };
  const inline = new dv.DataviewInlineApi(api, new Component(), {}, origin);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (dvApi: unknown, input: unknown) => Promise<void>;
  await new AsyncFunction("dv", "input", body(code, "dataviewjs"))(inline, undefined);
  if (tables.length !== 1) throw new Error(`Drew ${String(tables.length)} tables, not one`);
  return tables[0];
}

/** A cell as text, telling types apart: a date, a link, a number, text, null. */
export function cellText(value: unknown): string {
  const { dv } = loadDataview();
  if (value === null || value === undefined) return "-";
  if (dv.Values.isLink(value)) {
    const link = value as { path: string; display?: string };
    return `[[${link.path}${link.display ? `|${link.display}` : ""}]]`;
  }
  if (dv.Values.isDate(value)) {
    return `date(${(value as { toFormat(f: string): string }).toFormat("yyyy-MM-dd HH:mm")})`;
  }
  if (dv.Values.isArray(value)) return `[${(value as unknown[]).map(cellText).join(", ")}]`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(dv.Values.toString(value));
}
