# Changelog

All notable changes to **Gentle Pomodoro** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3] — 2026-09-04

You can now ask the timer to chime when a session runs out, without giving up
the quiet. Gentle Pomodoro has always stayed silent at the end of a session
unless the next one starts on its own — that is deliberate, so a chime never
interrupts focus you want to keep. This release turns that into a choice you
make per edge, and adds a state that was never possible before: starting the
next session **without** a sound.

### Added

- **Two sounds you can turn on separately** ([#5](https://github.com/JamieStudio-lab/obsidian-gentlepomodoro/issues/5)).
  "Play a sound when a break ends" tells you break time is up, so a five-minute
  break does not quietly become twenty. "Play a sound when focus ends" is there
  if you want it, and stays **off** by default — that is the one that would interrupt a
  session you are still in the middle of. Both live in the timer panel (under
  the gear) and in Settings → Gentle Pomodoro → **Audio**.
- **A quiet hand-over.** Each sound setting now applies whether the timer runs into
  overtime _or_ starts the next session automatically, so you can auto-advance
  with no sound at all. Previously auto-start always chimed and there was no way
  to turn that off.

- **A mute for the music**, next to its volume in the timer panel. Unlike pause
  or stop it silences without stopping, so a 24/7 lofi stream stays live instead
  of dropping off the edge with nothing to come back to. The timer panel's Audio
  section now reads as two matched pairs — **Timer sounds** with **Timer volume**,
  **Music sound** with **Music volume**.

### Changed

- The panel's volume row is now **Timer volume**, so it pairs with the switch
  above it instead of sitting unlabelled next to **Music volume**.
- **The auto-start toggles now also appear in the plugin settings**, in the new
  Audio group alongside the chimes.
- **The timer panel follows settings changed elsewhere.** Flip a shared setting
  in the plugin settings and an open panel updates instead of waiting to be
  closed and reopened.
- The timer panel's Auto-start section is now two sections, **When focus ends**
  and **When a break ends**, each holding the chime and the start toggle for
  that moment — and a line underneath saying, in words, what will actually
  happen with the settings you have. "Play a chime" cannot say for itself
  whether it still applies when the next session starts on its own; the summary
  answers that on screen instead of leaving you to test it. The same line
  appears under each pair in the plugin settings.
- The auto-start toggles are now called **Auto-start the break** and
  **Auto-start the focus**, in both the timer panel and the plugin settings —
  "Start the break" read as though it might begin one right now.
- **Nothing you hear changes when you upgrade.** Each chime starts out matching
  your current auto-start setting, which is exactly what your timer does today —
  so the sounds stay the same and the switch is simply yours now. New installs
  start with the break-end sound on. One thing to know afterwards: because
  the chime is now a setting of its own, turning an auto-start _on_ no longer
  brings a sound with it, and turning one _off_ no longer takes the sound away.
  Whatever the chime says is what you get.
- **The plugin settings now carry the master sound switch too**, at the top of
  the Audio group. It was previously only in the timer panel, so the settings
  page could promise a sound with no way to see — or change — what was silencing
  it. It is called **Timer sounds**, and it now says what it covers: the drum
  when focus starts and the sound when you stop, neither of which has a switch
  of its own. Your music is separate and always was.

### Fixed

- Stop and Skip no longer play the end sound a second time when it has already
  played for that session, or when pressed in the last moments before the timer
  runs out.
- With Timer sounds off, the line under the toggles now says so instead of
  promising a sound that cannot play.
- The end-of-session sound is no longer lost on iPhone and iPad after a phone call, Siri, or a
  locked screen — the situation it is most needed in.
- A backward jump in the system clock (an automatic time correction, or waking a
  sleeping laptop) no longer swallows the next Stop sound.
- Changing **Timer sounds** in the plugin settings now moves the matching switch
  in an open timer panel, instead of leaving it stale until the panel is
  reopened.

### Internal

- CI now runs `tsc --noEmit`. Rollup reports a type error as a warning and still
  emits `main.js`, so the build alone was passing with type errors in the tree.

## [0.6.2] — 2026-09-04

A third timer theme, **Pixel City** (planned under the working name Rooftop Skyline), in pixel art: a city along the bottom
of the square, a dithered sky above it, and windows that light up as the
session runs toward night. The first theme built from pictures rather than
CSS, and the first to use the scrim 0.6.1 put in place for exactly that.

### Added

- **Pixel City theme.** Pick it under Settings → Gentle Pomodoro → Theme.
  Eight sky plates cross-fade from day through golden hour and dusk to night
  over a focus session; the city's windows come on in six waves between 40%
  and 80% of it; stars come out over the last third. A break runs the whole
  arc backwards, the windows going dark as dawn comes up. Two planes of
  buildings — a slate city in the distance behind the ink one in front — the
  plugin's shared rounded corners, and a cat on a roof right of centre.
- The artwork is drawn by a script in `art/pixel-city/` on the Endesga 32
  palette and shipped as sixteen 128×128 indexed PNGs, under 7 KB in all, bundled
  into `main.js`. The files open in Aseprite with their palette intact and can
  be hand-edited; the script's `--layout` flag tries alternative arrangements.

### Internal

- Bitmap plates ride the same bundling route as the audio cues. Obsidian
  installs three files, so a loose image beside them works on the machine that
  put it there and is silently missing for everyone else.
- Every plate moves on the eased `--gp-progress` alone — sky plates and stars
  by `clamp()`, window waves by a ramp steep enough to be a switch — with no
  second transition anywhere, so a skip or reset eases once, not twice.
- The theme swaps the running-state size pulse for the shadow-only breath
  (scaling a bitmap 1.03× shimmers on a pixel grid). That swap has to exclude
  overtime: it out-ranked the shared overtime rule and the breathing glow
  vanished on this theme alone, until the user noticed.
- 488 → 504 tests. The plate list, the files on disk, the stylesheet's rules
  and thresholds, the view's node-building line and the build config must all
  agree; every plate is 128×128, indexed, and inside a size budget; the theme's
  block reads `--gp-progress` and declares no transition; the pulse opt-out
  stays gated on reduced motion and stays out of overtime.

## [0.6.1] — 2026-09-02

The visible half of the design-system work 0.6.0 laid the groundwork for. The
timer square finally sets in one typeface, the day/night badge stops
contradicting the artwork it sits on, and every control the panel builds has a
focus ring. The two shipped themes are otherwise left looking exactly as they
looked.

### Fixed

- **The day/night badge was a whole phase behind the timer.** It showed a sun
  for the entire first half of a focus session and only reached the moon once
  you ran into overtime — while the square behind it faded all the way to night.
  Badge and artwork now come from the same value, so they cannot disagree again.
- **Three typefaces inside the timer square.** The clock, the mode label, the
  end time and the overtime total each named a different font — or, in one case,
  none at all. Invisible on a Mac, where the first font in every list is
  installed; on Windows and Linux the clock was rounded and the label beneath it
  was not. All four now use the same face.
- **The overtime total jittered sideways once a second.** It is the visible
  clock once a session runs over, and it was the one ticking number in the
  plugin without fixed-width figures.
- **The keyboard could reach controls you could not see.** The settings panel,
  the Stop / Reset / −5 / +5 groups and the task list are hidden by collapsing
  them, which does not remove them from the tab order — so Tab could land on
  "Reset to defaults" inside a closed panel and Enter would fire it. All three
  are now properly inert while closed.

### Added

- **A focus ring on every control.** Five had none at all, including the panel's
  most-used button, and three others had three different treatments. Rows inside
  the scrolling lists get an inset ring so it is not clipped at the top and
  bottom of the list.
- **The task picker is keyboard-operable.** Arrow to a row and press Enter or
  Space, the way the music-link picker already worked. Closing it puts focus
  back on the task button instead of dropping you at the top of the panel.

### Changed

- **The day/night badge is bigger and clearer** — a larger pill and a larger
  glyph. Sunrise and sunset used to differ only in whether two small ticks were
  diagonal or horizontal, which at that size nobody could see; each now carries
  an arrow pointing the way the sun is going.
- Eleven text sizes become six. Seven of them shift by less than a pixel.

### Internal

- On-artwork text colours become per-theme slots, defaulting to exactly today's
  values, plus a scrim that both shipped themes set to zero. This is what lets a
  future theme use artwork the plugin did not draw — white text hardcoded for a
  dark square cannot survive an arbitrary picture. One deliberate sub-perceptual
  change: the mode label's text shadow moves from 0.2 to 0.22 alpha so it can
  share one token.
- The four badge glyphs become data rather than a branch, so a theme can supply
  its own set.
- 475 → 488 tests. The new day/night suite is mutation-checked against five
  breakages, including a verbatim restoration of the phase bug above.

## [0.6.0] — 2026-09-01

A structural release. The plugin gets a design system — named values for
spacing, type, corners, motion and depth — and the two themes become genuinely
independent of each other. **Nothing in the timer panel looks any different**,
which was the requirement: the visible polish this unlocks lands in 0.6.1.

### Changed

- **The download is a third of the size.** `main.js` went from 1.94 MB to 721 KB.
  Almost two thirds of every release was a debugging sourcemap that only the
  developer could use, shipped because the development and release builds shared
  one configuration. They are separate now.
- **Themes no longer depend on each other.** "Classic" was never really a theme —
  it was whatever was left after Frosted Glass hid the parts it did not want, by
  name. Each theme now owns its own artwork and declares its own colours, and
  neither mentions the other. Adding a theme is two steps instead of five, and
  the plugin's theme contract is written down in THEMES.md for anyone who wants
  to contribute one.
- **An unreadable theme name in `data.json` now lands on Classic** instead of on
  whatever happened to be left over. Hand-editing or a sync merge can put a value
  there that no theme matches, and it is a string like any other, so nothing
  earlier in the load could catch it.

### Fixed

- **A shadow setting that never existed.** The timer's drop shadow was written to
  read a colour the plugin never defined, so for the whole life of the theme
  feature every theme quietly fell back to plain black. It now has an owner in
  each theme — still black today, and available to a theme that wants to tint it.

### Internal

- `styles.css` gains a token layer: 11 font sizes, ~70 spacing values across two
  unit systems, 7 corner radii and 12 durations written 14 different ways
  collapse onto named scales, across 169 substitutions. Verified by resolving
  every token back and diffing against the previous file — the only value that
  moved is a border radius that renders identically.
- New `DESIGN.md` records the rules a stylesheet change has to obey, including
  the ones that look like tidy-ups and break things silently.
- New `themes.ts` is the single place a theme is registered; a missing entry is
  now a compile error rather than a theme that silently stores the wrong value.
- New test suite over `styles.css` itself — undeclared tokens, dead tokens,
  cross-theme references, and the two values that must agree with TypeScript.
  Mutation-checked: nine deliberate breakages, nine caught. 452 → 475 tests.

## [0.5.8] — 2026-08-30

### Fixed

- **Settings that could not be saved failed silently.** If the vault could not be written — a read-only folder, a sync client holding the file, storage pressure on a phone — a setting you changed appeared to take, and then came back the way it was after a restart, with nothing to explain it. The plugin now tells you when a save fails. It says so at most once a minute, so a jammed disk cannot bury you in messages while you type.
- **A damaged settings file was quietly replaced.** `data.json` lives in your vault, so it can be edited by hand or merged by sync into something the plugin cannot read. When that happened the plugin started on the defaults without a word — and then saved them over the unreadable file, so whatever had been in it was gone. It now tells you instead, and leaves the file alone, so a fixable `data.json` is still there to fix.
- **One bad value in that file could stop the plugin loading.** A setting edited to the wrong kind of value — a number where text belongs — is still perfectly valid JSON, so nothing above catches it, and the plugin failed to start at all. A setting whose value is the wrong shape now falls back to its default instead. Settings the plugin doesn't recognise are left untouched, so moving back and forth between versions doesn't lose anything.

### Notes

- **Most of this release is internal.** The music player, the settings page and the daily-goal bookkeeping were reorganised so their rules can be tested; nothing about them should look or behave differently. Tests went from 291 to 452, and the parts of the plugin where every past music bug actually lived are now covered.
- On Obsidian versions before 1.13, the settings page is now generated from the same description the newer settings page uses, rather than written out a second time by hand. The two could previously drift apart, and only the newer one was visible to anyone testing. One consequence: a number field there now refuses entries like `5abc` instead of quietly storing `5`, matching what Obsidian 1.13 already did.

## [0.5.7] — 2026-08-27

### Added

- **Up to three music links, switchable from the timer panel.** Settings now has three link slots instead of one, each with an optional short name ("Lofi", "Rain"). The music controls now name the chosen link on one quiet line — reading "Music" until you press ▶️, then "Now playing", and adding the track name when the link is a playlist. Names fade rather than snap when they change, whether you switch links or a playlist moves on — with a list button beside the transport to pick a different link. Leave the extra slots empty and there is simply nothing to pick from. Your existing link becomes the first slot automatically — nothing to set up, and nothing is lost.
  - **Each link remembers its own place.** Play one for a while, switch to another, come back, and the first picks up where you left it. Previously there was a single remembered spot shared by whatever link was configured. (Live streams have no "place" to return to, so those still always start live.)
  - **Renaming a link doesn't interrupt anything**, and neither does editing a link you are not currently listening to.
  - Clearing a slot's text removes that link, and forgets the place it had remembered.
- **A next-link button, which keeps the music going.** Press ⏭ while something is playing and the next link starts on its own once it has loaded. Press it while paused or stopped and nothing makes a sound. Picking a link from the list still never starts playback by itself — ⏭ is the one control that says "and keep playing", because a next button that answers with silence isn't much of a next button. It appears only when you have more than one link.
- **Previous and next video buttons for playlists.** Press ⏪ or ⏩ to move through the playlist you're listening to — they fade out and back in like the other controls rather than cutting, and pressing ⏸ or ⏹ while one fades cancels the skip. They sit on their own row, which eases in and out the way the session controls do, and appears only when the link you're on is actually a playlist. They stay out of the way for ordinary videos — including looped ones, which YouTube internally treats as a one-item playlist.
- **Bad links now say so, in the settings, under the box.** Paste something that isn't a YouTube link, or one YouTube has no record of, and a short message appears under that box. It is honest about its limits: it can tell you a link is malformed, deleted, private, or blocked from embedding, but it cannot promise a link will play — that depends on things it has no way to test from here. Anything it isn't sure about, it stays quiet about.
- **Links name themselves.** Paste a link and the name box beside it fills in on its own, from the video or playlist title, tidied up: a SHOUTING title is brought back to sentence case, a lowercase one gets its first letter capitalised, and an over-long one is cut at a word. You can still type over it, and it never touches a name you have already written, or one you are in the middle of writing. If a title turns out to be unusable — one link tested here has a title that is a single invisible character — the channel name is used instead.

### Notes

- **Audited, no change: the hidden music player and YouTube playback quality.** The plugin never asks YouTube for a playback quality, and that is deliberate — the embed API's quality setters have been no-ops for years (YouTube picks automatically from player size and bandwidth, so the invisible 1×1 player gets the lowest video rendition), and it makes no audible difference: YouTube serves the same audio stream whether the video is 144p or 1080p. Forcing the hidden player to 1080p would only spend bandwidth and CPU on pixels nobody sees.
- **Checking a link is one small request to YouTube**, sent shortly after you stop typing in a link box, carrying only the video or playlist ID you pasted. Unlike the music player itself, it happens even with the timer panel closed and "Show music player" off — those settings control playback, and this is the settings page. The README's "Network use" section has been rewritten to describe both. Nothing is sent for an empty slot.
- On Obsidian 1.13 and later, a link that isn't recognised is now saved as you typed it rather than being refused — so nothing you type is lost, and the message under the box explains what is wrong. Earlier Obsidian versions already behaved this way.
- An older bug surfaced while building this and is fixed here: pressing ⏹ and then switching links straight away made the new link start from the top and forget where it had been.
- The "Music" / "Now playing" wording follows the ▶️/⏸ button exactly, including when no Pomodoro session is running. It briefly did not: it was recomputed on the timer's tick, and the timer does not tick while idle, so it changed late and then stuck.
- A place remembered by 0.5.6 or earlier is carried over to whichever slot holds that link. If it had no record of which link it belonged to (from before 0.5.6), it is forgotten once, as it was already.
- The music player remains unavailable on iPhone and iPad — see 0.5.6. Adding more links does not change that; no link works there.

## [0.5.6] — 2026-08-16

### Added

- **Older `#t=` timestamp links are recognized.** A music URL that carries its start time in the fragment (`https://youtu.be/…#t=1m30s`) now opens at that point, like the modern `?t=90` form. Previously the link worked but the timestamp was silently ignored. An explicit `?t=` still wins if a link somehow has both.

### Fixed

- **A YouTube link with its own timestamp no longer breaks play-after-pause.** Pasting a music URL copied at a specific time (`…?t=90`, YouTube's "copy link at current time") put a `start=` parameter on the embed, and an embed loaded that way stops responding to play once it has been paused — press ▶️, ⏸, then ▶️ again and the music was simply gone until you pressed ⏹. The timestamp is now applied the same way the remembered position has been since 0.5.3: as a jump made once playback starts, with nothing added to the embed itself.
- **Editing the music URL now takes effect exactly as pasted.** A remembered position belonged only to a video, not to the URL it came from, so two edits were quietly overridden by it: switching to a different video of the **same playlist** reopened the old item instead of the one you named, and changing only the `?t=` on the same video kept resuming at the old spot. Both were sticky — every later reopen re-applied the stored position. Changing the URL now forgets the position recorded under the previous one.
- **Live streams ignore a pasted timestamp again** rather than seeking far outside the available window.
- **Turning "Resume where you left off" off now sticks.** With no position stored — a fresh install, or any time after ⏹ Stop — switching it off was never written to disk, so it came back on at the next restart. Present since 0.5.3.
- **Music that loads but never plays.** For some videos the player moves itself from `youtube-nocookie.com` to `youtube.com`, and every command sent after that — play, pause, volume, seek — was quietly discarded, with no error and the panel still looking ready. Commands now follow the player wherever it goes.
- **On iPhone and iPad, the music player now says what's actually wrong.** It reported a link problem and invited you to try another URL. The real cause is that YouTube won't load its player inside Obsidian on iOS at all — it requires the embedding page to identify itself with an HTTP `Referer`, and iOS doesn't send one for an app served from a custom scheme. No URL works, so the message no longer sends you hunting for one, and the README now lists the music player as desktop-only. Every other feature is unaffected on mobile.
- **"The music video can't be played" now says which problem it is.** One message covered three unrelated YouTube errors — the video being private or removed, the link being malformed, and this device's player refusing a video that plays fine elsewhere — which made a link that works on a desktop but not on an iPad impossible to tell apart from a dead link. Each now has its own wording and quotes YouTube's error number, and the code is written to the developer console alongside the URL.
- **A player that never finishes starting up.** The one message that asks the player to start reporting back was sent once, a tenth of a second after the frame loaded, and was simply lost if the player wasn't listening yet — after which ▶️ only ever answered "the music player hasn't loaded". It is now repeated until the player acknowledges it, which should mostly help slower devices and connections.

### Notes

- A position remembered before this version is forgotten once, on the first update: it carries no record of which URL it belonged to. The music simply starts from the top the first time you open it after updating.

## [0.5.5] — 2026-08-14

### Fixed

- **Tasks on `*`, `+`, or numbered bullets are no longer invisible to the plugin.** Obsidian and the Tasks plugin treat any list bullet as a task line (`- [ ]`, `* [ ]`, `+ [ ]`, `1. [ ]`, `1) [ ]`), but Gentle Pomodoro only recognized the dash form — an asterisk-bulleted task never appeared in the side-panel task picker, its name couldn't be looked up by 🆔 for the daily log, completing it never unlinked it from the timer, the opt-in 🍅 per-task counter skipped it, and the marker Check/Repair/Remove maintenance actions walked right past it. All task-line parsing now goes through one shared pattern that accepts every bullet form.
- **The completion check is line-ending-safe.** The check that auto-unlinks a completed linked task now reads files with Windows-style CRLF line endings correctly, so a completed task in such a file can't silently stay linked under the stricter full-line matcher above.

## [0.5.4] — 2026-08-13

### Changed

- **The music now fades in and out instead of snapping.** Press ▶️ and the lofi track eases up from silence over about eight-tenths of a second rather than arriving at full volume mid-bar; press ⏸ or ⏹ and it eases down to silence before the player actually pauses or stops. The curve is weighted toward the quiet end, so the change sounds even all the way through rather than rushing in and then hanging — the same "gentle" idea as the timer's own animations, applied to the one part of the panel that was still abrupt. The buttons still respond the instant you press them.
  - **Changing your mind mid-fade works.** Press ▶️ while a pause is still fading out and the music simply carries on, easing back up from wherever it had got to — it never pauses a moment later.
  - **Everything the fades touch keeps its old behaviour.** ⏸ still remembers your place and ⏹ still forgets it — and if you press ▶️ before a ⏹ has finished fading, the stop is called off completely, position and all. The session sounds still duck the music under them, changing the music volume still wins immediately (even mid-fade), looping and playlists are unchanged, and closing the panel still stops playback at once.
  - A fade-in waits for the audio to actually start, so it isn't spent on a buffering gap — and if a track needs to rebuffer part-way in (resuming where you left off does exactly that), the fade waits with it instead of finishing over the silence.
  - Resuming from outside the panel — hardware media keys, Bluetooth controls — fades in too, instead of coming back silent or at a jump.

## [0.5.3] — 2026-08-12

### Added

- **The music picks up where you left it.** Pause the lofi player — or just close the timer panel, or quit Obsidian entirely — and the next time the panel opens, the track is queued at the moment you stopped instead of back at the beginning. Press ▶️ and it carries on. Nothing plays by itself: the position is restored, not the playback, so opening Obsidian is never a surprise burst of music (and on iPhone/iPad, where autoplay is blocked outright, the behaviour is identical).
  - **⏹ Stop is how you forget it.** Pause remembers, Stop clears — press it whenever you'd rather start the mix from the top next time.
  - **Playlists resume on the right track**, not back at track 1: the position is remembered against the video that was actually playing, so it stays correct even if you reorder the playlist later.
  - Pasting a different URL never inherits the old position, a finished track opens at the top again, and **live streams always start live** (a saved offset would be meaningless on a stream).
  - New **Resume where you left off** toggle in the Music section of the plugin settings, on by default. Turning it off forgets the stored position immediately.

## [0.5.2] — 2026-07-31

### Fixed

- **No more phantom "goal hit" notice on the first session of a new day.** If Obsidian stayed open (or your laptop just slept) across midnight, the timer still held _yesterday's_ focus total in its cached "today" number when the new day's first session started. One short pomodoro was enough to trigger the **Daily focus goal hit** notice — and because the notice only fires once per day, it then stayed silent when you genuinely reached your goal later that day. The cached total is now stamped with the day it was read for and counts as zero the moment the date rolls over, so the notice only ever fires from the new day's real minutes. (The timezone handling was audited along the way and is consistent: every "today" in the plugin — the goal notice, the daily log file name, the long-break counter — uses your local date; UTC is never involved.)
- **The goal notice and "Today X / Y" meter no longer need the status bar.** Both were driven from inside the status-bar update, so with **Show in status bar** switched off the notice could never fire and the in-view meter never picked up the day's logged total (it only counted the session in progress). The goal bookkeeping now subscribes to the timer directly and works exactly the same with the bar hidden — on desktop and mobile.
- **The status bar no longer shows yesterday's focus total on a new day.** The "Today X / Y" text only refreshed while the timer was doing something, so an app left open (or a laptop asleep) across midnight kept yesterday's number — and its goal-met highlight — on screen until the day's first interaction. The plugin now re-checks the total about once a minute while idle, and immediately when the window regains focus, so the meter resets shortly after midnight (and also picks up manual edits to today's log note within a couple of minutes, even while idle).

### Changed

- **The goal notice now arrives with the end-of-session bell, not mid-focus.** It used to fire the instant the running session's live minutes crossed the daily goal — a popup in the middle of deep work, and if that session never made it into the log (Obsidian quit mid-session), the once-per-day notice had already been spent on time the log never recorded, so the real crossing later that day stayed silent. The notice now counts logged sessions only and fires right after the crossing session's line is written — landing together with the bell, at the natural break point. The goal threshold is your **Daily focus goal (minutes)** setting, as always. The status bar and in-view meter still tick up live during a session.
- **Skipped sessions no longer count toward the daily goal.** In the classic pomodoro spirit, **Skip** now forfeits the session's minutes: they count toward neither the "Today X / Y" meter nor the goal notice (so skipping the session that would have crossed your goal fires nothing). The line is still written to the daily log — marked `Status:: cancelled` — so your records and Dataview queries keep the full history; the meter simply drops back when the forfeited minutes leave it. **Stop is different: stopping early keeps the time.** Stop logs the session as `finished` and it counts in full — Stop is "end early, keep the time," Skip is "discard, move on." Hand-added log lines without a `Status::` field still count.

## [0.5.1] — 2026-07-28

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

- **Lofi study music, right in the timer panel.** Paste a YouTube link — a video, a 24/7 live stream like Lofi Girl, or a playlist — into the new **YouTube music URL** setting (Settings → Gentle Pomodoro → Music), and a small ▶️ play/pause/stop row appears in the timer panel. It's audio-only by design: no video ever appears, keeping the panel as calm as the rest of the timer. A **Music volume** control (Low/Mid/High) sits next to the existing sound volume in the in-view settings panel. Playback is fully manual — it doesn't start or stop with your sessions — and stops when you close the timer panel. A **Show music player** toggle hides the controls (and stops playback) if you'd rather not see them; if a pasted video turns out not to allow embedding, a notice tells you instead of leaving a silent play button.
- **The music ducks under the session sounds.** When a cue plays while music is streaming — the war drum on a focus start, the bell at a focus end, the ding at a break end — the music smoothly dips to about a third of your set volume for exactly the length of the cue, then eases back up over a second or so. The cues stay clearly audible without the timer ever jolting your mix; changing the music volume mid-dip always wins immediately.
- **Loop music, and a heads-up when it truly stops.** A new **Loop music** toggle (Settings → Gentle Pomodoro → Music, on by default) replays a video or playlist from the start when it ends, so background music keeps going through long sessions; live streams play continuously either way. And because the player is invisible, silence used to be the only sign that playback had stopped — now, when the music genuinely ends (a finished video with loop off, or a live stream going offline), a notice tells you so you can press ▶️ play again or paste a new link. Playlist track changes and loop restarts don't trigger it.
- **Notices for network trouble.** If the music buffers for more than ~10 seconds — a slow or dropped connection — a notice says so and explains that playback resumes by itself once the network is back (with a manual reload tip if it doesn't). Brief rebuffers and normal track starts never trigger it, and it won't repeat more than once every five minutes on a flaky connection. And pressing ▶️ play before the player has loaded (for example, offline) now tells you why nothing is happening instead of silently doing nothing.
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
