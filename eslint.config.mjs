import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tsParser from "@typescript-eslint/parser";

export default defineConfig([
  // Don’t lint dependencies/build output/config files
  {
    ignores: [
      "node_modules/**",
      "main.js",
      "eslint.config.mjs",
      "rollup.config.js",
    ],
  },

  // Obsidian’s recommended rules (matches what the review bot expects)
  ...obsidianmd.configs.recommended,

  // Parse TypeScript (enables typed rules like @typescript-eslint/no-deprecated)
  {
    files: ["**/*.ts", "**/*.tsx"],
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
  },
]);
