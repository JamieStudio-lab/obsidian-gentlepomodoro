# Changelog

All notable changes to **Gentle Pomodoro** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] — 2026-07-29

### Fixed

- **No more phantom "goal hit" notice on the first session of a new day.** If Obsidian stayed open (or your laptop just slept) across midnight, the timer still held _yesterday's_ focus total in its cached "today" number when the new day's first session started. One short pomodoro was enough to trigger the **Daily focus goal hit** notice — and because the notice only fires once per day, it then stayed silent when you genuinely reached your goal later that day. The cached total is now stamped with the day it was read for and counts as zero the moment the date rolls over, so the notice only ever fires from the new day's real minutes. (The timezone handling was audited along the way and is consistent: every "today" in the plugin — the goal notice, the daily log file name, the long-break counter — uses your local date; UTC is never involved.)
- **The goal notice and "Today X / Y" meter no longer need the status bar.** Both were driven from inside the status-bar update, so with **Show in status bar** switched off the notice could never fire and the in-view meter never picked up the day's logged total (it only counted the session in progress). The goal bookkeeping now subscribes to the timer directly and works exactly the same with the bar hidden — on desktop and mobile.
- **The status bar no longer shows yesterday's focus total on a new day.** The "Today X / Y" text only refreshed while the timer was doing something, so an app left open (or a laptop asleep) across midnight kept yesterday's number — and its goal-met highlight — on screen until the day's first interaction. The plugin now re-checks the total about once a minute while idle, and immediately when the window regains focus, so the meter resets shortly after midnight (and also picks up manual edits to today's log note within a couple of minutes, even while idle).

### Added

- **A recovery toolkit for already-affected tasks.** If you used the counter before 0.5.1, some of your task lines may still have the marker in the old, harmful position. Three actions — each a button in the plugin settings (Task integration section) and a command in the command palette — cover the whole recovery flow, scanning your tasks folder (or the whole vault if no folder is set):
  - **Check** counts the misplaced markers _without changing anything_ and lists the affected files in the developer console — run it first, and if the number is larger than you expect, inspect those files before going further.
  - **Repair** moves misplaced markers back in front of the Tasks fields, keeping their counts.
  - **Remove** deletes the misplaced markers instead — because the old bug only ever _appended_ the marker, this restores affected lines to exactly how they looked before the counter wrote to them (the lifetime counts on those lines are lost). The escape hatch for anyone who'd rather not have the markers at all.
  - **Remove all** is the counter's full uninstall: it deletes every `🍅 N` marker the plugin has written — correctly placed or misplaced — losing all lifetime counts. It only touches markers in positions the plugin itself writes (followed by nothing but Tasks fields, a block reference, or the end of the line); a `🍅 N` you typed yourself in the middle of a task description is never removed. Its setting and confirmation both warn that the deletion cannot be undone and that backing up the vault first is a good idea.

  All three are deliberately conservative: only task lines whose marker actually sits in a harmful position (after the date fields, or after a `^block-id` reference) are considered — everything else, including a correctly placed marker or a `🍅 N` that happens to appear mid-description on a line without dates, is left byte-for-byte untouched. Repair and Remove first run the same read-only scan as Check and show a **confirmation dialog with the exact counts** ("This will move 12 misplaced 🍅 marker(s) in 3 file(s)…") before writing anything — Cancel, Esc, or clicking outside backs out without a single change, and when nothing is misplaced no dialog appears at all. Files that need no change are never written, a notice reports exactly what was done (or that nothing needed fixing), and running any of them again is always safe.

- **The counter toggle now says what it does to your files.** The **Increment task pomodoro count on finish** setting is marked as beta and its description states plainly that it edits your task files — so opting in is an informed choice.

### Changed

- **Task-line writes are now atomic.** The per-task counter previously read the task file and wrote it back as two separate steps, leaving a small window where a concurrent write (sync, another plugin) could be lost. The increment — and the new repair action — now rewrite the file through Obsidian's atomic `Vault.process`, closing that window.

### Fixed

- **The `🍅 N` counter no longer breaks the Tasks plugin's dates.** With the opt-in **Increment task pomodoro count on finish** setting enabled, the counter was appended to the very end of the task line — _after_ the Tasks plugin's emoji fields (`⏳` scheduled, `📅` due, `🆔` id, …). The Tasks plugin only recognizes those fields when nothing but other fields follows them, so the appended marker silently turned them into plain description text: the line still _looked_ right, but the dates vanished from Edit Task and from date-based queries ([#2](https://github.com/JamieStudio-lab/obsidian-gentlepomodoro/issues/2) — thanks for the detailed report). The counter is now written at the end of the task _description_, before the first Tasks field — e.g. `- [ ] Write docs 🍅 3 ⏳ 2026-07-27 📅 2026-07-28` — which Tasks parses correctly. Tasks that were already affected heal automatically: the next finished focus session relocates the misplaced marker as it increments (or you can move the `🍅 N` in front of the date fields by hand to fix a line immediately). Block references (`^id`) stay at the very end of the line, and nested-task indentation is preserved.

## [0.5.0] — 2026-07-27

### Added

- **Lofi study music, right in the timer panel.** Paste a YouTube link — a video, a 24/7 live stream like Lofi Girl, or a playlist — into the new **YouTube music URL** setting (Settings → Gentle Pomodoro → Music), and a small ♪ play/pause/stop row appears in the timer panel. It's audio-only by design: no video ever appears, keeping the panel as calm as the rest of the timer. A **Music volume** control (Low/Mid/High) sits next to the existing sound volume in the in-view settings panel. Playback is fully manual — it doesn't start or stop with your sessions — and stops when you close the timer panel. A **Show music player** toggle hides the controls (and stops playback) if you'd rather not see them; if a pasted video turns out not to allow embedding, a notice tells you instead of leaving a silent play button.
- **The music ducks under the session sounds.** When a cue plays while music is streaming — the war drum on a focus start, the bell at a focus end, the ding at a break end — the music smoothly dips to about a third of your set volume for exactly the length of the cue, then eases back up over a second or so. The cues stay clearly audible without the timer ever jolting your mix; changing the music volume mid-dip always wins immediately.
- **Loop music, and a heads-up when it truly stops.** A new **Loop music** toggle (Settings → Gentle Pomodoro → Music, on by default) replays a video or playlist from the start when it ends, so background music keeps going through long sessions; live streams play continuously either way. And because the player is invisible, silence used to be the only sign that playback had stopped — now, when the music genuinely ends (a finished video with loop off, or a live stream going offline), a notice tells you so you can press ♪ play again or paste a new link. Playlist track changes and loop restarts don't trigger it.
- **Notices for network trouble.** If the music buffers for more than ~10 seconds — a slow or dropped connection — a notice says so and explains that playback resumes by itself once the network is back (with a manual reload tip if it doesn't). Brief rebuffers and normal track starts never trigger it, and it won't repeat more than once every five minutes on a flaky connection. And pressing ♪ play before the player has loaded (for example, offline) now tells you why nothing is happening instead of silently doing nothing.
- **Privacy note:** the plugin makes no network requests on its own. Only when you paste a URL (and the music player is shown) does the panel embed YouTube's privacy-enhanced player (`youtube-nocookie.com`) to stream the audio — see the README's **Network use** section.

### Changed

- **Smoother focus-session sounds.** The war drum that marks a fresh focus start and the singing bell that marks the end of a focus session (whether it completes naturally or you press Stop or Skip) have been replaced with higher-quality recordings that fade out naturally — the old clips cut off abruptly, which felt at odds with a gentle timer (thanks to the GitHub feedback that pointed this out). Break sessions keep their existing ding.

## [0.4.4] — 2026-07-20

### Added

- **Estimated end time on the timer.** While a session is running, the timer now shows the wall-clock time you'll finish — for example "Ends 15:30" — right under the Focus/Rest label. It's the calm counterpart to the countdown the timer deliberately hides: a static "you're free at 15:30" you can glance at, rather than a ticking clock. If a session would finish after midnight (a late start plus a long focus block), the line reads "Ends 00:15 (+1 day)". The time follows your locale's format (24-hour or AM/PM). It appears only while running and disappears when you pause, stop, or run into overtime. A new **Show estimated end time** toggle in the plugin settings (Settings → Gentle Pomodoro → Timer appearance, on by default) turns it off if you'd rather not see it. It fades and gently slides into place when a session starts, and eases back out when you pause, stop, or finish — instantly, with no motion, if you use the "reduce motion" accessibility setting.

### Changed

- **Timer-visual settings have their own group.** The plugin settings tab now has a **Timer appearance** section — theme, day/night indicator, and the estimated-end-time toggle — split out of the former catch-all **Display & behavior** group (which keeps the logs folder, auto-open, and status-bar options). Same settings, easier to find.

## [0.4.3] — 2026-07-18

### Changed

- **The task picker's empty state has a proper design.** When no tasks fall inside the lookahead window, the dropdown used to show a bare, unpadded line of plain text. It's now a centred empty state that matches the rest of the panel: a soft calendar icon, an "All clear" title, and a muted hint naming the window — "No tasks scheduled or due in the next N days." (The hint says _scheduled or due_ because that's exactly what the picker filters on; overdue tasks always show, so an empty list really does mean nothing is pending.) And when no **Tasks folder path** is configured at all, the empty state becomes a gentle setup nudge instead — a folder icon, "Nothing here yet", and a hint pointing at the plugin settings.

## [0.4.2] — 2026-07-18

### Added

- **Settings now appear in Obsidian's settings search (Obsidian 1.13+).** The plugin settings tab adopts Obsidian's declarative settings API (`getSettingDefinitions()`), so every Gentle Pomodoro setting is indexed by the global settings search introduced in Obsidian 1.13. All groups, names, and behaviors are unchanged; on Obsidian 1.13+ the numeric fields (long break duration/frequency, daily focus goal) additionally render as proper number inputs with minimum-value enforcement. Older Obsidian versions keep the previous settings page as-is — the minimum app version stays 1.7.2.
- **Configurable task lookahead window.** A new **Task lookahead window** dropdown in the plugin settings (Settings → Gentle Pomodoro) lets you choose how many days ahead the task selector reaches — **3, 5, 7, 14, or 30 days** — instead of the previous fixed 3-day view. Overdue tasks always appear regardless of the window, and tasks stay grouped by date (Overdue / Today / Tomorrow / weekday). Defaults to 3 days, so existing setups are unchanged until you widen it.

### Changed

- **Settings tab is now grouped.** The plugin settings page organizes its previously-ungrouped top settings under **Task selector** (tasks folder, show selector, lookahead window) and **Display & behavior** (logs folder, auto-open, status bar, day/night, theme) headings, so related options are easier to find.

## [0.4.1] — 2026-07-14

### Added

- **Show/hide the task selector.** A new **Show task selector** toggle in the plugin settings (Settings → Gentle Pomodoro) lets you remove the "Current task" picker and its dropdown from the timer panel if you don't link sessions to tasks. It's smart about the default: hidden when you haven't set a **Tasks folder path**, shown when you have — so a fresh install stays uncluttered while existing users keep their picker. After that, your explicit choice is always respected. Turning the selector off also unlinks the current task (there'd be no UI to change it otherwise).

## [0.3.2] — 2026-07-01

### Fixed

- **The tapped-to-peek countdown now hides itself on iOS.** On touch, tapping the timer reveals the hidden countdown — but it stayed up until you tapped elsewhere. Two things were at play: there was no auto-hide, and iOS "sticks" the hover state on a tapped element, which pinned the number open. The number now fades away about 2 seconds after your last tap (tapping again keeps it visible and restarts the countdown), and the hover-reveal is limited to devices that actually hover, so the stuck-hover no longer overrides it. Desktop hover-to-peek is unchanged.
- **The frosted-glass timer background no longer flickers on mobile during a session.** Two things made it shimmer (badly on iPhone, occasionally on iPad): the timer redrew its gradient ~20×/second, and the shape's gentle size-pulse continuously rescaled the frosted blur — both forcing the expensive blur to recompute far too often, including a blink right at the rounded inner edge. The gradient now updates about once per second (visually identical, since the colour transition already spans a full second), and on phone and tablet the shape breathes via its soft shadow instead of changing size, so the blurred edge stays still. Desktop keeps the full size-pulse.
- **The peeked countdown now fades smoothly on iPad and iPhone.** Tapping to reveal/hide the number sometimes snapped instead of fading, occasionally with a small glitch at the bottom of the digits. The number is now drawn on its own layer, so its fade is independent of the animated background and stays consistently smooth.

### Changed

- **Larger mobile touch targets.** Icon buttons (48→56px) and their glyphs, the task-picker button and dropdown rows, and the settings controls are all bigger and easier to hit, with a little more space between adjacent buttons so a stray finger is less likely to trigger the wrong one. iPhone and iPad only; desktop is unchanged.
- **The control buttons now shrink to fit a narrow panel instead of wrapping.** In a narrow iPad sidebar the first button row used to wrap onto two lines. The buttons now scale down to fit the width in a single row (staying square, down to a comfortable minimum), and grow back to full size on a wider panel or on iPhone.

## [0.3.1] — 2026-06-26

### Changed

- **Mobile side panel now scrolls as a single surface.** Previously the view nested three independent scroll regions (the panel itself plus the capped task list and settings panel). With a mouse that's fine, but on touch a drag that landed inside an inner box scrolled that box and not the page — so you had to "find" a working place to scroll. On mobile/tablet the task list and settings panel no longer cap their height or scroll internally; the whole view grows and scrolls as one. (Open/close on these two becomes instant on mobile, since an uncapped height can't be animated.)
- **The sticky timer shrinks on short viewports.** It was a fixed 280px on mobile, which dominated a phone screen (and any landscape view) and crowded out the task list. It's now capped against viewport height (`min(280px, 38vh)`), so it stays full-size on a tall iPad but gives the list room elsewhere.

### Fixed

- **The collapsed panel now vertically centres on mobile.** On first load with the settings and task list collapsed, the timer + controls sat packed at the top of the panel with empty space below, instead of centred. The view's root element is the leaf-content itself, and its `height: 100%` doesn't resolve on mobile (no definite ancestor height), so it shrank to its content height. The root now fills the leaf via flex and centres its content with `justify-content: safe center` — the desktop centring spacers are dropped on mobile because Obsidian's mobile styles touch the leaf-content's own `::after` and break them. `safe` keeps the standard fallback: top-aligned + scroll when content is taller than the leaf.
- **The in-view focus-goal meter now shows on iPhone.** The "Today 2h / 4h" focus-time + goal line below the task selector was blank on iPhone (it worked on iPad and desktop). It was only ever filled from the status-bar update path, which on mobile races against the view opening — on iPhone the value landed before the view existed and nothing re-pushed it. The meter is now driven by the view's own timer subscription plus a push when the view opens, so it appears immediately (even idle), ticks up live during a session, and no longer depends on the status bar existing (so it also shows when "Show in status bar" is off).
- **The timer no longer covers the controls in iPhone landscape.** When an iPhone is rotated to landscape the panel is short, and the pinned, opaque timer covered the buttons and task list as they scrolled underneath it. On a short panel the timer now shrinks to a small fixed square and un-pins, so it scrolls away with the page and the controls stay visible. The short panel is detected by measuring the panel directly (a `ResizeObserver` toggles a `gp-compact` class), because Obsidian's mobile webview doesn't expose reliable viewport media queries (`max-height`/`orientation`) for this view. iPad and portrait phones keep the larger pinned clock.
- **Mobile layout no longer reads as off-centre.** The panel reserved a permanent scrollbar gutter even on touch (where there's no persistent scrollbar), nudging content sideways; the gutter is dropped on mobile so the column re-centres. With the smaller timer, content fits more often and the vertical-centring spacers engage.
- Reaching the end of a list on mobile no longer bounces/scrolls the Obsidian app behind the panel (`overscroll-behavior` containment), and the bottom row now clears the iPhone home indicator / mobile nav (safe-area padding). Stray sideways drift from horizontal overscroll is suppressed.

## [0.3.0] — 2026-06-25

### Added

- **Systematic mobile (iPad / phone) support.** All mobile/touch styling now lives in one consolidated section in `styles.css`, driven by sizing tokens (`--gp-tap-min`, `--gp-icon-*-size`) so future tweaks live in one place. Two query strategies are used deliberately: `body.is-mobile` / `body.is-tablet` for layout/sizing, and `@media (hover: none) and (pointer: coarse)` for input-capability fixes.
- **Tap-to-peek countdown on touch.** The running countdown is hidden by design ("gentle, don't fixate on the clock"); on desktop you hover the shape to peek. Touch devices have no hover, so tapping the timer shape now toggles the countdown visible/hidden.
- **Daily-goal progress in the view on mobile.** Obsidian hides the status bar on mobile, which is where the `Today 2h / 4h` goal meter lived — it's now mirrored into the timer view and shown on mobile/tablet (hidden on desktop, where the status bar still carries it).

### Changed

- Bigger touch targets on mobile (≥44px): icon buttons, volume segments, the reset button, task-list rows, and number inputs.
- Mobile control layout reflows (full-width column, wrapping button rows) instead of forcing the whole leaf to scroll sideways, and the timer visual is allowed a little more width.
- **Minimum Obsidian version raised to 1.7.2** (the plugin uses `Workspace.revealLeaf` and `Vault.createFolder`).

### Fixed

- Icon-button glyphs were thin slivers on iPad. Root cause (found via Web Inspector): a WebKit/Safari flexbox bug collapses an SVG flex item's main-axis width to ~min-content (8px) while honoring its height, so the control glyphs rendered ~8px wide × 32px tall. Fixed with a `min-width`/`min-height` floor (plus `flex-shrink: 0`) in CSS, which the flex algorithm can't cross. Glyphs are now a full 32px in a 48px button on mobile; iPhone and desktop unchanged.
- **Daily-log writes are now robust on mobile.** A session could be silently dropped when the Vault file index lagged the filesystem (common on mobile right after the log file is created, or when Obsidian Sync brings it in): the old write path checked the raw filesystem but then looked the file up in the index, and when the two disagreed it appended nowhere. The write path now resolves the file through the Vault index and falls back to an adapter-level append, so a session is never lost to an index lag. Write failures (sync conflicts, locked files) are caught — the user gets a notice and the timer still advances, instead of an unhandled error — and the folder-create step tolerates a sync race.
- Task-rename log rewrites now match the log folder by path boundary, so a log folder named e.g. `Log` no longer also scans/rewrites files under a sibling folder like `Logs`.

### Internal

- Task-picker click handlers converted from direct `.onclick` to `registerDomEvent` so listeners are cleaned up on view close.

### Known limitations

- On iOS, the hardware silent/ring switch mutes WebAudio, so completion sounds won't play with the switch on. Completion sounds otherwise rely on a prior tap (Start) to unlock audio. These are platform constraints, not plugin bugs.

## [0.2.1] — 2026-05-31

### Fixed

- Auto-start break / focus now actually starts the next session when the timer reaches zero — previously the timer slid into overtime and never advanced even with the toggles on.
- The end-of-session sound (bell on focus, ding on break) now plays at natural completion when auto-start is on.
- Audio reliability: a single shared `AudioContext` is created once and resumed when suspended (a fresh per-call context could start suspended or be garbage-collected before playback), decoded clips are cached, and the context + timer tick-loop are released on plugin unload so they don't leak across disable/enable cycles.

### Changed

- **Stop** (Finish & next) now always switches to the next mode **paused**, even when auto-start is on. **Skip** respects the auto-start toggle — it starts the next session when auto-start is on, otherwise switches paused. The auto-start toggles now govern only automatic (timer-reaches-zero) transitions.

## [0.2.0] — 2026-05-26

### Added

- New **Frosted Glass** theme: a 3D backdrop-blurred pane in front of three drifting, hue-shifting color orbs. Warm sunrise (light mode) / fireplace (dark mode) at the start of focus, easing to cool twilight by the end, driven by the `--gp-progress` CSS variable.
- Theme picker — `Classic` (default) or `Frosted glass` — in the main Obsidian Settings tab.
- Pastel-twilight palette in Obsidian light mode; fireplace-orange warmth in Obsidian dark mode (mode-specific overrides scoped via `body.theme-dark` / `body.theme-light`).
- Smooth color interpolation on skip / reset via `@property --gp-progress` registration — color transitions feel cadenced like the Classic theme's opacity transitions.
- `THEMES.md` — documents the two shipped themes plus four future theme ideas (Moon Phases, Tide, Zen Ripple, Lantern) and the wiring pattern for adding a new theme.

### Changed

- Original theme renamed internally from `"sunset"` to `"classic"`. One-time auto-migration runs in `loadSettings()` so existing users carry over silently.
- Overtime text contrast improved across both light and dark Obsidian, both focus and break modes (overtime timer + "Total: M:SS" line both readable on the new pastel/orange backdrops).

## [0.1.3] — 2026-05-20

### Changed

- Docs-only release for the Obsidian Community Plugins catalog launch.
- README install path moved from BRAT to Community Plugins.
- Feature list refreshed to reflect 0.1.1 and 0.1.2 changes that hadn't been written up yet.

## [0.1.2] — 2026-05-20

### Changed

- In-view settings panel redesigned: iOS-style toggle switches, Low / Mid / High segmented volume control, section headers (Timing / Audio / Auto-start), full-width Reset to defaults button.
- Apply-on-Enter for number inputs in the settings panel.
- Responsive pass: sticky timer visual at the top of the view, leaf-level horizontal scrolling on narrow sidebars (controls + settings + tasks lock at 260px), day/night indicator auto-fades when the side panel drops below 200px, clock floors at 200×200, leaf min-height held at 320px.

## [0.1.1] — 2026-05-19

### Added

- Audio cues bundled into `main.js` — no extra mp3 files needed on disk; catalog/BRAT installs get sound out of the box.
- `prefers-reduced-motion` respect on the timer-shape animations.
- Sigstore artifact attestations on release assets.

### Changed

- `package-lock.json` committed; CI uses `npm ci` for reproducible builds.

## [0.1.0] — 2026-05-18

### Added

- Long break after every Nth focus session (classic Pomodoro Technique).
- Daily focus goal with status-bar progress + once-per-day "goal hit" notice.
- Opt-in `🍅 N` counter written back to task lines (lifetime total per task; never resets).
- Volume slider and auto-start toggles in the in-view settings panel.

## [0.0.5] — 2026-02-03

Initial public-facing release. See git log for details.

## [0.0.4-Beta] — 2025-12-29

Pre-release beta. See git log for details.

## [0.0.3] — 2025-12-23

First tagged build. See git log for details.
