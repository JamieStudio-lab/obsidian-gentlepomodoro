/**
 * A tiny CSS reader for the stylesheet's own tests.
 *
 * styles.css is the one file in this project nothing can observe at runtime —
 * computed styles exist only inside a running Obsidian — so every guard on it
 * is a text check, and the quality of those guards is exactly the quality of
 * the parse underneath them. Two things went wrong before this module existed:
 *
 *  - Guards scanned LINES. Prettier writes every selector of a list on its own
 *    line and wraps a long descendant selector across several, so a line scan
 *    sees neither the whole selector list nor the whole rule. A guard that
 *    said "no rule may name two themes" passed the moment the two selectors
 *    were merged into one comma list, which is precisely the edit it existed
 *    to stop.
 *  - Guards searched for a selector as a SUBSTRING of the file.
 *    `gp-theme-frosted-glass` is a prefix of `gp-theme-frosted-glass-2`, and a
 *    wrapped selector is not a substring of anything, so both a false positive
 *    and a false negative were one prettier reflow away.
 *
 * So: parse into rules, carry each rule's at-rule context, and normalise the
 * text before comparing. `namesClass` is the only sanctioned way to ask
 * whether a piece of selector text names a theme.
 */

/** A style rule: its selector list, its declarations, and what encloses it. */
export interface CssRule {
  /** The at-rule preludes around this rule, outermost first, normalised. */
  context: string[];
  /** The selector list, normalised to `a, b, c` on one line. */
  sel: string;
  /** The declaration block verbatim, between the braces. */
  body: string;
  /** Where the selector starts, as an offset into the text parsed. */
  index: number;
}

/** Comments gone. Every parse below runs on this, never on the raw file. */
export const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const squash = (s: string): string => s.trim().replace(/\s+/g, " ");

/** `a ,\n  b` -> `a, b`. Prettier's wrapping is not part of a selector. */
export const normalizeSelector = (sel: string): string =>
  sel.split(",").map(squash).filter(Boolean).join(", ");

/**
 * Does `text` name this class as a WHOLE class?
 *
 * `(?![\w-])` and not `\b`: a hyphen IS a word boundary, so `\b` would report
 * every rule of `gp-theme-frosted-glass-2` as a rule of `gp-theme-frosted-glass`
 * — the exact confusion the fourth theme's id creates.
 */
export const namesClass = (text: string, cls: string): boolean =>
  new RegExp(`(?<![\\w-])${cls}(?![\\w-])`).test(text);

/** The body of the block whose opening brace is at `open`. */
export const bodyAt = (text: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced braces");
};

/**
 * Every style rule in comment-free CSS, with its at-rule context.
 *
 * At-rules are descended into rather than reported, so a rule inside
 * `@media (prefers-reduced-motion: reduce)` arrives as an ordinary rule
 * carrying that prelude in `context` — which is what lets a guard say "this
 * rule exists AND it is inside the gate" in one comparison instead of two
 * index arithmetic tricks over the raw text.
 *
 * `@keyframes` is descended into as well, so its steps arrive as rules whose
 * selector is `0%, 100%` carrying `@keyframes <name>` in `context`. Harmless
 * to the selector guards — a step names no class — and load-bearing for the
 * freeze, which reaches for those steps through that context.
 */
export function parseRules(text: string, context: string[] = [], offset = 0): CssRule[] {
  const out: CssRule[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ";" || ch === "}") {
      i += 1;
      start = i;
      continue;
    }
    if (ch !== "{") {
      i += 1;
      continue;
    }
    const prelude = squash(text.slice(start, i));
    const body = bodyAt(text, i);
    const close = i + 1 + body.length;
    if (prelude.startsWith("@")) {
      out.push(...parseRules(body, [...context, prelude], offset + i + 1));
    } else if (prelude) {
      out.push({ context, sel: normalizeSelector(prelude), body, index: offset + start });
    }
    i = close + 1;
    start = i;
  }
  return out;
}

/**
 * One rule as the fixtures store it: context, selector, one declaration a
 * line. Declarations keep their values verbatim apart from whitespace, so a
 * retune shows up as a one-line diff rather than as a wall of reformatting.
 */
export function ruleText(rule: CssRule): string {
  const decls = rule.body
    .split(";")
    .map(squash)
    .filter(Boolean)
    .map((d) => `  ${d};`);
  const head = rule.context.map((c) => `[${c}]\n`).join("");
  return `${head}${rule.sel} {\n${decls.join("\n")}\n}`;
}

/** The same, but the selector line only — for a theme still being tuned. */
export function selectorText(rule: CssRule): string {
  return `${rule.context.map((c) => `[${c}] `).join("")}${rule.sel}`;
}

/** The keyframes name in an at-rule prelude, or null for any other at-rule. */
const keyframesName = (prelude: string): string | null =>
  /^@(?:-\w+-)?keyframes\s+([\w-]+)$/.exec(prelude)?.[1] ?? null;

/**
 * Every rule whose selector names `cls`, plus every `@keyframes` block those
 * rules animate with, as fixture text.
 *
 * This is the shape of the freeze: a theme is the set of rules that name its
 * class, and "left as shipped" means that set, rendered this way, has not
 * changed. A retarget onto another theme's class removes a rule from the set;
 * a retune changes a declaration line; a rule slipping out of a media gate
 * changes its context line.
 *
 * The keyframes are here because a selector filter cannot see them: a step's
 * selector is `0%, 100%`, so it names no theme, and retuning a transform
 * inside `@keyframes gp-orb-drift-1` moved the frozen theme's orbs while the
 * whole suite stayed green. Every keyframe the theme's rules NAME is included,
 * shared ones too: `gp-gentle-pulse-glow` is also Pixel City's and the mobile
 * swap's, and retuning it still changes how this theme breathes, which is the
 * only question the freeze asks. So a shared retune fails here even though the
 * edit was aimed elsewhere — that failure is correct, and the answer is to
 * regenerate the fixture and say why the frozen theme moved.
 *
 * Owned rules first in source order, then the keyframes sorted by name (steps
 * keep their source order inside each block), so moving a block in the file is
 * not a diff.
 */
export function themeSnapshot(css: string, cls: string): string {
  const all = parseRules(stripComments(css));
  const owned = all.filter((r) => namesClass(r.sel, cls));
  const animated = owned.flatMap((r) =>
    [...r.body.matchAll(/(?:^|[\s;])animation(?:-name)?\s*:([^;]*)/g)].map((m) => m[1])
  );
  const named = (prelude: string): boolean => {
    const name = keyframesName(prelude);
    return name !== null && animated.some((value) => namesClass(value, name));
  };
  const key = (r: CssRule): string => r.context.map(keyframesName).find(Boolean) ?? "";
  const steps = all
    .filter((r) => r.context.some(named))
    // Codepoint order, not localeCompare: the fixture must not depend on the
    // locale the suite happens to run under.
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return [...owned, ...steps].map(ruleText).join("\n\n");
}
