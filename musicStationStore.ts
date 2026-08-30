import { logger } from "./logger";
import type { GentlePomoSettings } from "./types";
import {
  MUSIC_STATION_LIMIT,
  findPositionForUrl,
  musicPositionAppliesToUrl,
  resolveStationIndex,
  retainPositionsForUrls,
  stationsAreSettled,
  type MusicResumeState,
} from "./youtubeMusic";

/**
 * What the station store needs from the plugin: the settings it reads and
 * writes, and a way to persist them. Injected so the rules below can be tested
 * without an Obsidian runtime — they are where the 0.5.6/0.5.7 provenance and
 * retire rules actually live, and none of them were reachable from a test.
 */
export interface MusicStationStoreHost {
  /** A call rather than a field: the plugin replaces its settings object
   *  wholesale on load, so a captured reference would go stale. */
  settings(): GentlePomoSettings;
  /** Persist. Fire-and-forget on the plugin; the store never awaits it. */
  save(): void;
}

/**
 * The three station slots and the playback positions remembered against them.
 *
 * The whole point of this object is that a position belongs to the *URL it was
 * recorded under*, not to a slot and not to whatever is playing now. Switching
 * stations is therefore not an event at all (every slot's URL is still there),
 * while editing or clearing a slot retires the orphan through one sweep.
 */
export class MusicStationStore {
  private readonly host: MusicStationStoreHost;
  /** Set when a recorded position has moved since the last save. */
  private dirty = false;

  constructor(host: MusicStationStoreHost) {
    this.host = host;
  }

  /** The three station URLs, slot order. The single place that spelling lives. */
  stationUrls(): string[] {
    const s = this.host.settings();
    return [s.musicUrl, s.musicUrl2, s.musicUrl3];
  }

  /** The station URL that should actually play, after resolving a stale index. */
  activeUrl(): string {
    const urls = this.stationUrls();
    return urls[resolveStationIndex(urls, this.host.settings().musicStationIndex)] ?? "";
  }

  /**
   * The remembered position for one station URL, or null when the feature is
   * off or nothing is stored for it. Read once per iframe build — never on the
   * render hot path.
   *
   * Takes the URL rather than reading the active one, because the caller knows
   * which station it is building for and this must not depend on the index
   * having already been updated.
   */
  resumeState(url: string): MusicResumeState | null {
    if (!this.host.settings().musicResume) return null;
    return findPositionForUrl(this.host.settings().musicPositions, url);
  }

  /**
   * Drop positions that belong to links no station holds any more.
   *
   * This is the whole retire rule, and it is driven by the SLOT LIST rather
   * than by what is playing — which is what lets it correctly forget an
   * inactive slot's position, something a "did the playing URL change?" hook
   * never could. Editing a slot and clearing a slot are the same event to it,
   * so neither needs its own path; switching stations is not an event at all,
   * because every slot's URL is still there.
   */
  reconcile(): void {
    const settings = this.host.settings();
    const urls = this.stationUrls();
    let changed = false;

    // Heal the selected slot so what is stored matches what actually plays.
    // Without this the stored index can point at an EMPTY slot while playback
    // runs on the fallback — and then filling that empty slot would silently
    // move playback onto it, because the fallback stops applying. Writing the
    // resolution back means editing a slot you are not listening to can never
    // change what plays.
    const resolved = resolveStationIndex(urls, settings.musicStationIndex);
    if (resolved !== settings.musicStationIndex) {
      settings.musicStationIndex = resolved;
      changed = true;
    }

    // Drop positions belonging to links no slot holds any more. Skipped while
    // any slot holds a half-typed URL: the pre-1.13 settings path commits on
    // every keystroke, and this erase is immediate and destructive. Anything
    // skipped here is still refused by planResume's own URL check, so a stale
    // position can never be applied — only left in place.
    if (stationsAreSettled(urls)) {
      const next = retainPositionsForUrls(settings.musicPositions, urls);
      if (next.length !== settings.musicPositions.length) {
        settings.musicPositions = next;
        this.dirty = false;
        changed = true;
      }
    }

    // One save for both, and none at all in the common case — which matters
    // because every open view runs this from the same change-gated block.
    if (changed) this.host.save();
  }

  /**
   * Track where the music has reached. Called from the embed's ~4Hz message
   * stream, so it stays a short scan and a dirty flag — the disk write is
   * deferred to flush() (boundaries + the slow interval), because data.json
   * lives in the vault and every save is sync traffic.
   */
  record(position: MusicResumeState): void {
    const settings = this.host.settings();
    if (!settings.musicResume) return;
    // Provenance travels WITH the position, from the iframe that produced it —
    // never read off the live settings here. Both settings paths assign the URL
    // and only then `await saveSettings()`, and the outgoing iframe keeps
    // streaming across that await: stamping the live setting would relabel the
    // old track's position with the new URL, and the URL checks would then wave
    // it through onto a station it never came from.
    if (position.url === null || position.url.trim() === "") return;
    const seconds = Math.floor(position.seconds);
    const entry = findPositionForUrl(settings.musicPositions, position.url);
    if (
      entry !== null &&
      entry.videoId === position.videoId &&
      entry.playlistId === position.playlistId &&
      entry.seconds === seconds &&
      entry.url === position.url
    ) {
      return; // same whole second — the 4Hz stream collapses to ~1 update/sec
    }
    if (entry !== null) {
      // Safe to mutate: loadSettings always installs a fresh array of fresh
      // objects, so this can never reach the frozen DEFAULT_SETTINGS one.
      entry.videoId = position.videoId;
      entry.playlistId = position.playlistId;
      entry.seconds = seconds;
      entry.url = position.url;
    } else {
      if (settings.musicPositions.length >= MUSIC_STATION_LIMIT) {
        // Reachable whenever the retire sweep is frozen — one unparseable slot
        // holds stationsAreSettled false indefinitely, and orphans then pile up.
        // Evict an entry NO slot still holds, never index 0: the array is in
        // insertion order, so the oldest entry is typically the user's main
        // station, and dropping it silently loses a position that is still in
        // use. Only fall back to the oldest if every entry is still live, which
        // really is the tripwire case.
        const live = this.stationUrls();
        const orphan = settings.musicPositions.findIndex(
          (candidate) => !live.some((url) => musicPositionAppliesToUrl(candidate.url, url))
        );
        if (orphan >= 0) {
          settings.musicPositions.splice(orphan, 1);
        } else {
          logger.warn("music positions exceeded the station limit; dropping the oldest");
          settings.musicPositions.shift();
        }
      }
      settings.musicPositions.push({
        videoId: position.videoId,
        playlistId: position.playlistId,
        seconds,
        url: position.url,
      });
    }
    this.dirty = true;
  }

  /**
   * Forget one station's position — ⏹ Stop and a finished track both mean "open
   * this from the top next time". Saved at once rather than on the next
   * boundary: it answers a deliberate action, not a background sample.
   *
   * Takes the URL the caller was actually playing. The view passes its frozen
   * copy rather than the active setting, because a Stop can land after the user
   * has already switched stations — resolving it here would clear the incoming
   * station's position instead.
   */
  clear(url: string | null): void {
    const settings = this.host.settings();
    this.dirty = false;
    if (url === null) return;
    const next = settings.musicPositions.filter(
      (position) => !musicPositionAppliesToUrl(position.url, url)
    );
    if (next.length === settings.musicPositions.length) return;
    settings.musicPositions = next;
    this.host.save();
  }

  /** Forget every station's position — used when the resume feature is switched off. */
  clearAll(): void {
    const settings = this.host.settings();
    this.dirty = false;
    if (settings.musicPositions.length === 0) return;
    settings.musicPositions = [];
    this.host.save();
  }

  /** Persist a moved position. No-op when it hasn't changed since the last save. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.host.save();
  }
}
