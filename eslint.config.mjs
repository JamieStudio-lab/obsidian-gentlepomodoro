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
      "rollup.config.js",
      "vitest.config.ts",
      "tests/**",
      "__mocks__/**",
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
