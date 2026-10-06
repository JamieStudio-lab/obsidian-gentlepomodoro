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
