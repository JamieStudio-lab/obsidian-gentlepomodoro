import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    environment: "node",
  },
  resolve: {
    alias: {
      obsidian: resolve(here, "__mocks__/obsidian.ts"),
    },
  },
});
