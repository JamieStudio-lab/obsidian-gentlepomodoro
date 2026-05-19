import typescript from "@rollup/plugin-typescript";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import url from "@rollup/plugin-url";

export default {
  input: "main.ts",
  output: {
    dir: ".",
    sourcemap: "inline",
    format: "cjs",
    exports: "default",
  },
  external: ["obsidian"],
  plugins: [
    url({
      include: ["**/*.mp3"],
      limit: Infinity, // always inline as a base64 data URL; never emit a separate file
    }),
    typescript(),
    nodeResolve({ browser: true }),
    commonjs(),
  ],
};
