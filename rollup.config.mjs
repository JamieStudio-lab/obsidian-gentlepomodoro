import typescript from "@rollup/plugin-typescript";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import url from "@rollup/plugin-url";

/**
 * Config is a function so it can see the CLI args: `npm run dev` passes `-w`,
 * `npm run build` does not. That one flag is the dev/release discriminator.
 *
 * WHY THE SOURCEMAP IS DEV-ONLY. It used to be `sourcemap: "inline"`
 * unconditionally, and both scripts share this file — so the artifact CI built,
 * attested and uploaded to every release carried it. That was 1,217,205 of
 * main.js's 1,938,425 bytes: 63% of what every user downloaded, on every
 * device, was a debugging aid none of them could use. The cost of dropping it
 * is that a user-reported stack trace no longer maps back to TypeScript, which
 * has cost nothing so far — this plugin's bug reports are behavioural
 * ("music won't play on iPad"), not exception traces.
 */
export default (commandLineArgs) => ({
  input: "main.ts",
  output: {
    dir: ".",
    sourcemap: commandLineArgs.watch ? "inline" : false,
    format: "cjs",
    exports: "default",
  },
  external: ["obsidian"],
  plugins: [
    url({
      // The audio cues and, since 0.6.2, the Rooftop Skyline plates. Obsidian
      // installs three files, so an image that is not inside main.js does not
      // reach users at all — see rooftopArt.ts.
      include: ["**/*.mp3", "**/*.png"],
      limit: Infinity, // always inline as a base64 data URL; never emit a separate file
    }),
    typescript(),
    nodeResolve({ browser: true }),
    commonjs(),
  ],
});
