/**
 * Source files read as text, for the checks that only text can make: where a
 * call is made. Nothing here runs the code.
 */

/**
 * The body of the callback that `opener` starts in `source` — `opener` ends
 * with its `{` — up to the `}` that closes it, braces counted. Throws when
 * `opener` is not there or never closes.
 *
 * A slice that runs on to a later landmark (the next method) takes in what
 * follows the callback too, so a call moved out of it — to run before
 * layout-ready, say — would still be found there.
 *
 * Counts every brace, so it is for code with none inside a string or a
 * comment: strip comments first.
 */
export function callbackBody(source: string, opener: string): string {
  const at = source.indexOf(opener);
  if (at === -1 || !opener.endsWith("{")) throw new Error(`No "${opener}" to read`);
  const start = at + opener.length;
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i);
  }
  throw new Error(`"${opener}" never closes`);
}

/**
 * The statements at the top level of `body` (a callbackBody), each trimmed and
 * ending with its `;`. A call wrapped in a condition, or moved into a nested
 * callback, is part of a bigger statement and is not one of these — which a
 * plain `toContain` on the body cannot tell. Brackets of every kind are
 * counted, so the same rule as callbackBody's holds: strip comments first.
 */
export function topLevelStatements(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === ";" && depth === 0) {
      out.push(body.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  return out;
}
