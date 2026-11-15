# State of the session, 14 Nov 2026, about 19:30

Written because the VS Code panel froze; if the session or its agents have to
be restarted, this is what was running and what each still owes. Nothing is
committed anywhere. Agent ids are this session's; `SendMessage` to an id
resumes that agent with its context.

## Standing rules from the user (also in memory)
- Fix what you find (`memory/fix-what-you-find.md`).
- Every feature on every OS, Linux included (`memory/every-feature-on-every-os.md`).
- Settings parity is measured by pixel difference against the web preview.
- Test server is Starling; Docker has been hung since 15:30 and is not to be
  restarted without the user's word; a native Starling runs from
  `scratchpad/starling-native` on 127.0.0.1:64999 (files 8080).
- No sound, no real capture, never the user's production server.
- Shared briefs: `scratchpad/AGENTS-BRIEF.md`, `scratchpad/STARLING.md`.

## Agents still at work, and what each owes
- `acbcde6789b998f76` migration to gpui-fast + gpui-mobile. Private copy
  `F:\fancy-migrate\` (new fork repo `gpui-next`, branch `fancy`), build
  output `C:\fancy-build\migrate-target`. Done: Stage A facts; in the fork:
  text-background fix, set_bounds, Overlay/Floating, change log. Owes:
  backdrop blur (DirectX, wgpu, Metal), `crates/gpui_android` from
  gpui-mobile, client port (62 errors) with before/after measurements
  (retained mode on and off), Android on the emulator, then re-apply to the
  shared tree once it is frozen. User decided: gpui-fast with retained mode;
  use its dynamic textures and window composition instead of ours, watching
  for performance regressions.
- `ac829eaaaf1d74fd3` Starling security. Report received. Owes: the
  certificate race in text (scheduled message refused right after login),
  the screenshare `Viewers` channel check, operator guidance for wrongly
  archived direct messages, then the single `cargo fmt --all` (only after
  the other Starling agent has reported), re-run of clippy and tests, delete
  `C:\fancy-build\starling-gates`.
- `a7e837646964825c1` Starling functional fixes (guest picture/comment, ban
  list writes, pins kept, strokes, comment limit, SFU bind, channel password,
  `next_after_id` in the client's proto). Code done; owes its workspace gates
  (running into `C:\fancy-build\starling-gates`) and its report, including
  the native client's ban, picture, pin and share-through-SFU live tests.
- `a3fac18f75349b847` settings: Profile page to the web's layout (live
  preview card, display name, compact about editor), the user's own tile and
  menu ("Server & app options" sheet), settings shell in Nimbus, re-measure
  with `tools/webshot.mjs`. Report owed.
- `ae5dcc99a874ea391` settings made real: Personalize, Language & format,
  Shortcuts, Notifications, Privacy, Advanced, Identities, then Account,
  Channels & roles, Plugins, Game overlay; every row with its effect, pixel
  parity per page. Report owed.
- `a0b3952af32dd3350` Voice settings page to parity (gate, meter, test
  microphone, hear yourself, exclusive mode, the rest), engine Ogg fix done.
  Report owed. It left a hung headless Chrome (profile `agent-voicemsg-chrome`).
- `a7b9a1cd82c24318e` screen share additions: pop-out window, overlay on the
  sharer's desktop, share audio, camera inset, panning in 1:1, stage repaint
  without whole-window layout, and bringing the crate to clippy clean
  (splitting the over-long shared functions). Report owed.
- `a0d1da91d0f7e1a16` themes: hollow lettering (real face, merged outlines,
  non-ASCII names), then the whole theme table re-measured with
  `tools/webshot.mjs`. Report owed.
- `a77e1a4ad99d6681b` YouTube player: referrer identity per YouTube's rules,
  no autoplay before visible, paused CPU. Short report owed.

## Finished, reported, not yet verified by the main session as a whole
Tray, keyboard focus, translations, Android app fixes (web client), embeds,
format bar, members panel, profiles and the new profile format, GIFs,
livery, welcome renderer (table width, box padding in both clients, fork
text-background fix), startup (idle CPU fix, Windows subsystem, delay-loaded
Media Foundation, import guard test), comparison Tauri vs GPUI, Starling
livery-before-login and ban enforcement.

## Open with the user
- Restart Docker Desktop, or allow use of WSL Ubuntu, for a Linux environment.
- The welcome message's real HTML (two layout defects not reproduced).
- Commit today's work as a fixed point before the migration is re-applied.
- `fancy://` links point at `scratchpad\tauri-compare\mumble-tauri.exe`; the
  registry fix was blocked by the permission system; starting the installed
  client rewrites it.
- Starling: fail-open ban check when moderation is down; no SuperUser
  exemption; whether to review and release the uncommitted security work.
- Not yet assigned: web client defects (ban mask sent, `serializeProfile`
  dropping unknown fields, "Sprache" twice in German), renaming the demo
  server away from "magical.rocks", the Linux implementations owed.

## Things on the machine
- Native client builds: `scratchpad\latest-client\` (`fancy-gpui-1713.exe`
  is the last from a fully green tree; later ones are mid-work snapshots).
  The user has native windows open (13:39 and 16:33 builds) and a comparison
  web client (`scratchpad\tauri-compare\`, identifier `com.fancymumble.ramtest`).
- `vendor/client/src/ui/gpui/target` is a junction to `F:\fancy-build\gpui-target`.
- Leftover profiles: `%APPDATA%\com.fancymumble.ramtest`, `...cmptest`.
- Compose projects to take down when Docker is back: `gpui-starling`,
  `gpui-members-starling`, `gpui-profile-starling`, `gpui-livery-starling`,
  `gpui-page-starling`, `gpui-embeds-starling`.
- Web capture tool: `vendor/client/src/ui/gpui/tools/webshot.mjs`; web
  figures from before 19:00 are void.

## Addendum, about 19:45: two crashes of the editor, staggered restart

VS Code froze once (19:20) and crashed once more (about 19:40) ten minutes
after all seven interrupted agents were resumed together. Machine was not
short of memory or disk either time. Since the second restart only four
agents run: Starling security (`ac829ea...`), the GPUI migration
(`acbcde6...`), settings made real (`ae5dcc9...`), the Voice page
(`a0b3952...`). Each keeps a `PROGRESS.md` in its scratch folder
(migration: `F:\fancy-migrate\notes\PROGRESS.md`).

Held back, to be resumed when one of the four finishes (their remaining
work is listed above):
- `a7b9a1cd82c24318e` screen share additions and clippy clean for the crate
- `a77e1a4ad99d6681b` YouTube: referrer identity, no autoplay before
  visible, paused CPU
- `a0d1da91d0f7e1a16` themes: hollow lettering, the two missing Nimbus
  faces, the theme table re-measured with tools/webshot.mjs

The settings agent (`a3fac18...`) reported finally (Profile page, dock
sheet, Nimbus shell, webshot.mjs); the functional Starling agent
(`a7e8376...`) and the startup agent (`ae2ae1e...`) have reported finally.
The user's 13:39 native window is gone since the crash; the 16:33 one, the
comparison web client and the native Starling on 64999 still run.

## Addendum, about 21:00

Finished since the last note: Starling security (final gates green: fmt,
clippy, 2,713 tests; everything uncommitted in vendor/starling; the user
has a review list in that agent's last report), Starling functional fixes,
the Voice settings page, screen share round two, the first stretch of
"settings made real", the old migration agent (handed over at Stage B).

Running now:
- `a39869c4cfea58c7d` client port to gpui-fast (Stage C) in
  `F:\fancy-migrate\client-2`, notes in `F:\fancy-migrate\notes\`
- `ae5dcc99a874ea391` settings made real: rest of the pages; flag colours;
  web fixes for number format and read receipts
- `ae2ae1e0e3551dda9` scrolling performance (page renderer per-frame layout,
  Nimbus marks); frame loop ruled out
- `a0d1da91d0f7e1a16` themes: hollow lettering, Nimbus faces and tracking,
  Nimbus window cannot be dragged (no band), theme table re-measured
- `a77e1a4ad99d6681b` YouTube: referrer identity, autoplay, paused CPU
- `a9c9f6170d755d1d3` web client defects: ban mask, profile fields kept,
  German labels, hidden window at start, --accent, data-dir isolation,
  last-channel column
- `a3061f96896afcaa7` admin pages as settings pages (Users, Bans, Roles,
  Channels/ACL, then Onboarding, Plugins, Marketplace, File server)

Build rules since 20:10: nothing builds on C:; CARGO_BUILD_JOBS=6; no
debug info in debug/test builds; one cargo command per agent.

Still unassigned: two Starling storage leaks (replaced livery art; a guest
who registers mid-session), six clippy findings in shared client files,
renaming the demo server away from the user's server name, every Linux
implementation owed (no Linux environment: Docker down, WSL not allowed yet).

## Final state, 15 Nov, about 01:30 (the user stopped at 95 % of the weekly limit)

All agents wrapped up and reported. Nothing is committed in any project
repository: vendor/client (native client, engine, web UI, protocol) and
vendor/starling hold everything uncommitted. Each agent left a PROGRESS.md
with exact next steps in its scratch folder; the private migration is in
F:\fancy-migrate (notes\PROGRESS.md, PORT-RECORD.md, ANDROID-PROGRESS.md,
PHONE-LAYOUT.md).

Done and verified tonight
- Memory: GPUI fork's DirectX path drawing (append buffer, 20-byte path
  vertices, path textures sized to the paths and released when unused);
  pictures decoded one at a time (picture::with_opened, picture::staged);
  guard tools/memory.ps1 and MEMORY.md. Default theme 72-79 MB commit,
  Nimbus server screen about 107 MB (168 maximised: its dot lattice).
- Crash fixes in the engine: read_sync, audio settings and purge spawned
  outside the runtime (registered users only); runtime adoption.
- Scrolling: page renderer lists its blocks, Nimbus paths built once,
  message bodies read off the main thread; idle CPU about 0.05 %.
- Settings: Voice, Profile, Personalize, Language & format, Notifications,
  Identities, Advanced, Account, Channels & roles, Plugins, Shortcuts;
  admin pages Users, Ban List, Roles, Channels / ACL (old dialogs gone).
- Pictures: legacy inline copy for plain Mumble clients (both clients),
  picture card with pill and link buttons, lightbox fetching the original,
  albums, staging tray, plated composer, upload row.
- Starling (uncommitted, gated): livery before login, ban enforcement,
  sessionless guard, permission floors, pins kept, strokes whole, guest
  content, comment limit, SFU bind, channel password, blob release, role
  looks kept, onboarding per instance. Web client fixes: ban masks, profile
  fields kept, German labels, window shown at once, --accent, data-dir
  isolation, last channel name, number/date format, read receipts.

In the tree, not verified in a real window or not measured
- Media Foundation flag for the YouTube player (settings.rs; PLAYER.md):
  halves CPU in a bare web view (9-12 % of a core); not run in the client.
- New link cards (poster look): compile, unit tests; no captures, not the
  bubble-attached form, not the YouTube card.
- Hover on the composer's attach plate; glow on filled buttons; ACL page
  and Roles tabs unmeasured; settings pages' final pixel measurement.
- Starling role looks and onboarding: tested in Starling, the native live
  tests not run; workspace gates not re-run after the last agent.

Not done
- Port to gpui-fast: client builds, looks identical (0.0005-0.04 %), suite
  green, rehearsal merge into the current tree worked; NO performance
  tables; the new renderer still has the path-buffer waste (port the fix
  first); real player and codec path never run there. Do not switch yet.
- Android: client starts on the emulator at 72 MB PSS (desktop layout);
  phone layout only planned.
- Admin pages: File server, Plugins, Marketplace, Onboarding, Server
  settings, Livery, Welcome, Audit log, Invites.
- Linux implementations of Windows-only features (no Linux environment).
- Nimbus memory remainder: 2x samples / lattice as quads prepared in
  scratchpad\agent-memory\variants, not built.
- Test of the legacy picture copy in the user's classic Mumble on their
  server; file shares in direct messages; two web Roles-page defects;
  Starling migrate-db does not import role looks; demo server still named
  after the user's server.

Open with the user
- Commit the work; review Starling before release (wrongly archived direct
  messages on unpatched servers; old IPv4 bans become active; ban check
  fails open when moderation is down).
- Docker restart or WSL for Linux; YouTube referrer identity
  (com.fancymumble.app); dual path off by default; fancy:// registration
  points at scratchpad\tauri-compare.

## After the wrap-up (15 Nov)

- vendor/client committed: `e6390c2c` (snapshot of the day's work; native
  suite 861 passed) and `7ecc0387` (the tree rearranged: crates/ gone; UIs
  in src/ui/{gpui,tauri,qt6}; other crates in src/crates). Not pushed.
  Paths in this file and in the agents' notes from before that commit use
  the old layout (crates/mumble-tauri = src/ui/tauri, and so on).
- Verified after the move: workspace and native client compile; native
  suite 861 passed; mumble-protocol 414, mumble-tauri lib 652, web UI
  4,494 tests pass; Starling's proto drift check passes. Not built: qt6,
  signal-bridge, Android, CI, packaging.
- Still uncommitted: vendor/starling (all of the day's server fixes plus 5
  path edits) and the parent repository (15 path edits, this file, the
  submodule pointers).
