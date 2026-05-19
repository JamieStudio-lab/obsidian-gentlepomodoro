// Lightweight logging helpers that auto-prefix "[GentlePomo]" so the maintainer
// can grep plugin output out of Obsidian's developer console.

const PREFIX = "[GentlePomo]";

// Note: console.log is disallowed by obsidianmd's recommended ESLint config.
// Use logger.debug for verbose tracing, warn/error for real diagnostics.
export const logger = {
  warn(message: string, ...rest: unknown[]): void {
    console.warn(`${PREFIX} ${message}`, ...rest);
  },
  error(message: string, ...rest: unknown[]): void {
    console.error(`${PREFIX} ${message}`, ...rest);
  },
  debug(message: string, ...rest: unknown[]): void {
    console.debug(`${PREFIX} ${message}`, ...rest);
  },
};
