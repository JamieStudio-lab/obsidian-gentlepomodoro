import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import prettierConfig from "eslint-config-prettier";

export default defineConfig([
  {
    ignores: [
      "node_modules/**",
      "main.js",
      "eslint.config.mjs",
      "rollup.config.mjs",
      "vitest.config.ts",
      "tests/**",
      "__mocks__/**",
      // obsidianmd's recommended set applies type-aware rules globally, which crash
      // on package.json (no TS project for it). We only need it to lint our TS.
      "package.json",
      // Claude Code process files (skills, workflow scripts) — not shippable
      // code, and the workflow .js runs in a sandbox with its own globals.
      ".claude/**",
    ],
  },

  ...obsidianmd.configs.recommended,

  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      globals: {
        console: "readonly",
        document: "readonly",
        activeDocument: "readonly",
        MutationObserver: "readonly",
        window: "readonly",
      },
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
    },
  },

  prettierConfig,
]);
