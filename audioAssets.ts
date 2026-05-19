// Centralized audio imports. @rollup/plugin-url inlines each as a base64
// data URL at build time, so main.js carries the audio bytes — no filesystem
// dependency at runtime.

import warDrumUrl from "./war-drum_short.mp3";
import bellUrl from "./singing_bell_short.mp3";
import dingUrl from "./ding-sound.mp3";

export const AUDIO_URLS: Record<string, string> = {
  "war-drum_short.mp3": warDrumUrl,
  "singing_bell_short.mp3": bellUrl,
  "ding-sound.mp3": dingUrl,
};
