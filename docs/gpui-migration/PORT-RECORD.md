# Port record: fancy-gpui from GPUI 0.2.2 (vendored fork) to gpui-next

What changed in the client's sources to build on `gpui-next` (gpui-fast
0.1.15 + Fancy Mumble's commits, branch `fancy`), kept so the port can be
replayed on the shared tree once it is frozen. The private copy is
`F:\fancy-migrate\client-2` (branch `baseline` = the shared tree at
2026-11-14 20:01:38; branch `port` = this port, edited in the worktree
`F:\fancy-migrate\client-2-edit`). `git diff baseline port -- src/ui/gpui`
there is the whole port; the scripts are in `notes\port-scripts\`.

## Replaying it (the method the rehearsal of 23:12 proved; see "Rehearsal")

A three-way merge does most of it: the port is a branch off a snapshot of
the shared tree, so a newer snapshot committed on the same parent and the
port merged into it brings every port change across and stops only where
the shared tree changed the same lines.

1. Snapshot the shared tree when its crate compiles:
   `powershell -File F:\fancy-migrate\measure\snapshot.ps1 -Dest <stage>`
   (copies `git ls-files -co --exclude-standard` of `vendor/client`,
   reading the shared repository only).
2. In a clone of `client-2` (or `client-3`): a branch at the previous
   snapshot commit (`4d59b3e`, or `844afec` for the 23:12 one), the stage
   mirrored over it (`robocopy <stage> <clone> /MIR /XD .git`), `git add -A`,
   commit "Snapshot ...". Make it a new branch: the merge must not land on
   the snapshot branch.
3. `git merge --no-ff --no-commit <port branch>`. Expect: every file of
   `vendor/gpui` the shared tree touched as modify/delete (delete them all,
   `vendor/gpui` goes whole); `Cargo.toml` (keep the shared tree's new
   dependencies, take the port's `gpui`/`gpui_platform` lines, features and
   `[patch]`); `Cargo.lock` (take the port's; cargo fills in the rest);
   `player/mod.rs`, `player/web_view.rs` (anything the shared tree added to
   the `Screen` trait goes into `player/composed.rs`); `stage/*` (the port's
   files whole, then re-read the shared tree's diff of them).
4. `python -I notes\port-scripts\mech1.py <crate>`, `mech2.py`, `mech3.py`,
   `mech4.py`, `add_field.py <crate>\src TextRun letter_spacing 0.0`: they
   convert the places the shared tree added since the last snapshot.
5. `rg "window\.focus\(&[^,]*\)\s*;"` for focus calls the scripts do not
   know; then `cargo check --all-targets` names the rest (the compiler error
   for each kind is in the table).
6. The suite: a test that presses a control the frame no longer draws
   relied on 0.2.2's stale debug bounds (kind 30).

## Kinds of change

| # | Old API (0.2.2 fork) | New API (gpui-next) | Places | How they are found | How changed |
| --- | --- | --- | --- | --- | --- |
| 1 | `gpui::Application::new()` | `gpui_platform::application()` | 1 | error E0599 "no function `new` ... Application"; `rg "Application::new"` | by hand (main.rs; drop `Application` from the `use`) |
| 2 | `cx.on_window_closed(\|cx\| ..)` | `cx.on_window_closed(\|cx, _window_id\| ..)` | 2 | E0593 "closure is expected to take 2 arguments"; `rg "on_window_closed"` | by hand |
| 3 | `window.focus(&handle)` | `window.focus(&handle, cx)` | 6 | E0061 "takes 2 arguments"; `rg "window\.focus\(&"` | by hand: `cx` is in scope at each |
| 4 | `entity.read(cx).focus(window)` (TextInput) | `window.focus(&entity.focus_handle(cx), cx)` | 28 | `rg "\.read\(cx\)\.focus\(window\)"` | `mech2.py` |
| 5 | `FocusHandle::focus(window)`, `TextInput::focus(window)` | `.focus(window, cx)` | 5 | `rg "(composer\|self\.end\(way\)\|self\.head)\.focus\(window\)"` | `mech2.py`; `TextInput::focus` takes `cx: &mut gpui::App` |
| 6 | `window.blur()`, `focus_next()`, `focus_prev()` | `..(cx)` | 5 | E0061 "takes 1 argument but 0"; `rg "\.blur\(\)\|focus_next\(\)\|focus_prev\(\)"` | by hand (kit/focus.rs: `Way::step` takes `cx`; tests.rs) |
| 7 | `BoxShadow { color, offset, blur_radius, spread_radius }` | + `inset: false` | 10 | E0063 "missing field `inset`"; `rg "BoxShadow \{"` | `mech1.py` |
| 8 | `window.paint_shadows(b, c, s)` | `window.paint_drop_shadows(b, c, s)` | 2 | E0599; `rg "paint_shadows"` | by hand |
| 9 | `window.paint_image(b, corners, img, frame, grey)` | `window.paint_image(b, b, corners, img, frame, grey)` (bounds, image bounds) | 4 | E0061 "takes 6 arguments"; `rg "paint_image\("` | by hand |
| 10 | `.flex_shrink()` | `.flex_shrink_1()` | 5 | E0061; `rg "\.flex_shrink\(\)"` | `mech1.py` |
| 11 | `scroll.max_offset().height` (Size) | `.max_offset().y` (Point) | 2 | E0609 "no field `height`"; `rg "max_offset\(\)\.(height\|width)"` | `mech1.py` |
| 12 | `.track_scroll(handle.clone())` | `.track_scroll(&handle)` | 2 | E0308; `rg "track_scroll\("` | `mech1.py` |
| 13 | `window.defer_draw(el, at, prio)` | `window.defer_draw(el, at, prio, None)` (content mask) | 1 | E0061; `rg "defer_draw"` | by hand |
| 14 | `window.text_system()` → `&Arc<WindowTextSystem>` | `&Rc<WindowTextSystem>` | 1 | E0308 at `kit/page/mod.rs`; field type | by hand (`Painter::text: Rc<..>`) |
| 15 | `ClipboardEntry` {String, Image} | + `ExternalPaths(_)` | 1 | E0004 non-exhaustive; `rg "ClipboardEntry::String"` | by hand (text_input.rs) |
| 16 | `KeyDownEvent { keystroke, is_held }` | + `prefer_character_input: false` | 2 | E0063; `rg "KeyDownEvent \{"` (tests) | by hand |
| 17 | `ScrollWheelEvent { .. }` (full initializer) | + `..ScrollWheelEvent::default()` (new `source`) | 1 | E0063 "missing field `source`"; tests | by hand |
| 18 | `Keystroke::parse(&str)` | `Keystroke::parse(&'static str)` | 3 | E0521 "borrowed data escapes"; tests' `press`/`walk` helpers | by hand: helper takes `&'static str` |
| 19 | `Window::update_image` (0.2.2 fork) | dynamic textures: `create_dynamic_texture`, `update_dynamic_texture`, `paint_dynamic_texture`, `remove_dynamic_texture` | 1 file | `rg "update_image"` | redesign: `src/ui/stage/screen.rs` (whole file), `stage/mod.rs` (`retired: Vec<screen::Picture>`), `stage/view.rs` (`copy_frame`) |
| 20 | `Window::paint_mark`, `painted_over`, `on_frame_painted`, `PaintMark` (0.2.2 fork) | window composition: `enable_window_composition`, `create_native_surface`, `on_input`, `with_composition_surface`, `overlay_surface`, `remove_surface` | player + shell | `rg "paint_mark\|painted_over\|on_frame_painted\|PaintMark"` | redesign: `src/player/` (mod.rs, place.rs, new composed.rs; web_view.rs and win32.rs deleted), `src/ui/playing.rs`, new `src/ui/kit/floating.rs`, `src/ui/mod.rs` (`Shell::floating`) |
| 21 | wry 0.54 (`build_as_child`), windows 0.61 | webview2-com 0.39 + windows 0.62 (as gpui_windows), raw-window-handle 0.6 | Cargo.toml | — | by hand |
| 22 | tests reading paint marks (`tests_page.rs`) | `Window::painted_quads()` (test-support) | 1 helper | `rg "paint_mark"` in tests | by hand |
| 23 | `ScrollWheelEvent`, `on_scroll_wheel` (deprecated aliases) | `ScrollEvent`, `on_scroll` | 15 | warnings "use of deprecated" | `mech4.py` |
| 24 | `Entity::focus_handle` without `Focusable` in scope | `use gpui::Focusable as _;` | 12 files | E0599 "no method named `focus_handle`" after `mech2.py` | `mech3.py` |
| 25 | `KeyBinding::new(&str, ..)` with a user's chosen keys, `Keystroke::parse(&str)` | `KeyBinding::load(keys, Box<dyn Action>, None, false, None, cx)`; `Keystroke::parse_with_os` in a test | 2 | E0521 "borrowed data escapes" (`parse`/`new` take `&'static str`) | by hand (`ui/keys.rs` `binding`, `store/shortcuts.rs` test) |
| 26 | `cx.on_action(..)` returned `()` | returns `&mut App` (`unused_results` is denied) | 4 | "unused result of type `&mut App`" | by hand: `let _ =` |
| 27 | `gpui::Corner` (anchored) | `gpui::Anchor` | 1 | E0433 | by hand (`ui/menu.rs`) |
| 28 | `TextRun { .. }` | + `letter_spacing: 0.0` (gpui-next's letter spacing commit) | 2 | E0063 | `add_field.py <crate>/src TextRun letter_spacing 0.0` |
| 29 | text drawn in grey levels (0.2.2 always) | `cx.set_text_rendering_mode(TextRenderingMode::Grayscale)` at start (else ClearType where the system has it) | 1 | captures: coloured glyph edges | by hand (`main.rs`) |
| 30 | stale `debug_bounds` in tests (0.2.2 never cleared them) | bounds of the frame drawn only | 2 tests | "nothing on screen is tagged" | by hand: press the saved point / the control now there |
| 31 | hover only on pointer moves | hover recomputed when content moves under a still pointer | 1 test | `hovered_message` Some where None was expected | by hand: move the pointer away, let the pill's grace pass |
| 32 | real threads waking the test executor (allowed in 0.2.2) | `cx.executor().allow_parking()` | 1 (the `shell_on` helper) | panic "Detected activity on thread ... not deterministic", and a crash (0xc0000409) of the whole test binary | by hand (`ui/tests.rs`) |
| 33 | no dynamic textures in GPUI's test platform | an accepting backend installed by the test helper (`stage::textures_for_tests`) | 1 | share tests show no picture | redesign file `stage/screen.rs` |

| 34 | `max_offset_for_scrollbar().height` | `.y` | 1 (shared tree after 20:01) | E0609 | `mech1.py` (rule widened 2026-11-15) |
| 35 | text measured at min-content: 0.2.2 answered with the last wrapped size | gpui-next measures it on one line | page renderer tables | `a_table_nobody_gave_a_width...` (986 wide) | by hand: `natural.rs` `least_box`, `columns_least`; `min_w` on a shrinking table and its cells (port f71ddc0) |
| 36 | 0.2.2's pixel grid | gpui feature `layout-rounding-0-2` (gpui-next 4058aaa) | Cargo.toml | captures 0.2-0.8 % off | by hand: add the feature to the `gpui` dependency |

## Redesigned (take whole)

- `src/ui/stage/screen.rs`, and `stage/mod.rs` (`retired: Vec<screen::Picture>`,
  `give_back_pictures`), `stage/view.rs` (`copy_frame` reads the kept pixels).
- `src/player/mod.rs`, `src/player/place.rs` (no `covered`),
  `src/player/composed.rs` (new; replaces `web_view.rs` and `win32.rs`, deleted),
  `src/ui/playing.rs` (`video_stage`, `video_layer`, `video_overlay`).
- `src/ui/kit/floating.rs` (new) and `src/ui/mod.rs` (`Shell::floating`,
  `with_panels` takes and returns `kit::floating::Floating`).
- `src/ui/mod.rs` `conversation_list`: redraw when the list's scroll changes
  what the view shows (a defect found in the Cell audit).
- Tests: `tests_player.rs` (made-up screens take `&mut Window`, give an
  overlay; the "hidden under what covers it" test is now "what floats is
  drawn over it, and it stays"), `tests_page.rs` (paint marks replaced by
  `Window::painted_quads`), `tests_share.rs` (new
  `the_frame_copied_is_the_one_on_screen_now`).

## Manifest

`Cargo.toml`: `gpui` and `gpui_platform` as path dependencies on gpui-next's
`crates/gpui` and `crates/gpui_platform` (the relative path from the shared
tree will differ: `vendor/client/src/ui/gpui` to wherever gpui-next lives, or
a git dependency on its `fancy` branch); features `wayland`/`x11` forward to
both; `[patch.crates-io]` repeats gpui-next's (async-process, async-task,
calloop); `windows` 0.61 to 0.62 with `Win32_UI_Input_KeyboardAndMouse`,
`Win32_UI_Shell`, `Win32_System_Com`; `wry` removed; `webview2-com = "0.39"`
and `raw-window-handle = "0.6"` added (Windows only). `Cargo.lock` regenerated
by cargo.

## Counts

66 files of the crate changed (+1310/-714, `vendor/gpui` and `Cargo.lock`
aside); `vendor/gpui` deleted (195 files). Scripted: 5+2+2+10 (`mech1`),
28+5 (`mech2`), 12 files (`mech3`), 15 (`mech4`), 2 (`add_field`). By hand:
about 40 places. Redesigned: 9 files, 2 new.

## Measurement-only (both builds)

`F:\fancy-migrate\client-2` commit `cf5dde8`: `FANCY_GPUI_DEMO_CHAT` and
`FANCY_GPUI_DEMO_FLOW` (`src/demo/chatter.rs`), on the baseline and the port
alike. gpui-next carries the 0.2.2 fork's `TMP-FRAMESTATS` hook as commit
`2031d31`, to be dropped with the old one.

## Since the copy (shared tree after 20:01; to bring over when re-applying)

| Change in the shared tree | How it comes across |
| --- | --- |
| Old fork: `WindowKind::Overlay` layered after creation, no frame insets | Ported: gpui-next 6575f8a. |
| Old fork: press-taking elements mark their hitbox; drag area yields to them | Ported: gpui-next 078d49b (+ test). |
| Old fork: top resize edge answered before drag areas (Windows) | Not needed: gpui-next's `handle_hit_test_msg` already answers the top edge first. |
| Old fork: `TextStyle::letter_spacing` | Ported: gpui-next f428363 (spacing travels beside `FontRun`; truncation spacing owed). The shell root applying the theme's tracking is client code: re-apply as is. |
| Old fork: path vertex buffer WRITE_DISCARD per batch (commit up to 228 MB, Nimbus); 20-byte path vertices | Not ported: the new DirectX renderer is different code. Measure on the new base (Nimbus server screen: commit, GPU shared/dedicated) first. |
| Old fork: 4x MSAA window-sized path texture (~20 MB) | Not examined on the new base yet. |
| Old fork: no frames while nothing changes (Windows) | Not ported: gpui-fast schedules frames only when dirty; idle CPU new 0.00-0.42 % vs old 0.05-0.16 % of a core (single samples). |
| Old fork: system fonts read on a thread | Not ported; start time on the new base not measured yet. |
| Client: `kit/built.rs`, dot lattice as one path, `polygon` as a triangle fan, page renderer listing its blocks | Client code on `Path`/`PathBuilder`/`paint_path`, same API on gpui-next: re-apply, `cargo check`. |
| Old fork TMP-FRAMESTATS (scroll agent) | gpui-next 2031d31 carries the same hook; drop both together. |
| Old fork: zero-blur box shadows painted as a filled quad (`window.rs` `paint_shadows`; 0.2.2's shader drew nothing for them: Nimbus dock buttons' hard plate, the spread rings in livery, wall, focus_point, lit). Not in its FANCY_CHANGES.md. | Not needed: old fork fixed it, new base has it natively (gpui-next `shaders.hlsl` `shadow.blur_radius == 0.` branch). Seen in the captures: the 20:01 baseline lacks the dock shadow, gpui-next draws it. |

## Found while porting

- Shared tree: "Copy frame" copied the stream's first frame, not the one on screen (reported; fixed in the port, test `the_frame_copied_is_the_one_on_screen_now`).
- Shared tree: the "N new below" pill could stay after scrolling back to the newest message (Cells set by the list's scroll handler after the view was drawn). Fixed in the port (`ui/mod.rs` `conversation_list`).
- gpui-fast: text measured with the line height snapped half toward zero, painted rounded half away (f3d4458).
- gpui-fast: no CPU upload backend for dynamic textures on wgpu (0cc6e13); uploads copied tight rows every frame (1363bab).

## Rehearsal (2026-11-14 23:12 to 00:10)

Snapshot of the shared tree at 23:12:56 (182 files of the crate changed
since 20:01, +21k/-2.3k lines) in `F:\fancy-migrate\client-3`: branch
`shared-2312` (844afec, the snapshot), `port-2312` (8b79489, the merge),
`old-2312` in the worktree `client-3-shared` (snapshot + the measuring
knobs, the old side of the measurements).

- Time: snapshot 1 min, merge and conflicts about 15 min, scripts 1 min,
  hand fixes and `cargo check --all-targets` about 10 min (two compiler
  rounds), suite and one test fix about 10 min: under an hour of work,
  plus build time (a check about 3 min, the test build about 6).
- Conflicts (22): 13 modify/delete in `vendor/gpui` (deleted), `ban_editor.rs`
  (deleted by the shared tree: kept deleted), `player/web_view.rs` (the
  shared tree added `Screen::play_on`: implemented in `composed.rs` with
  `ExecuteScript("play()")`), `player/mod.rs` (doc lines), `kit/mod.rs`
  (two module lines), `Cargo.toml` (new dev-dependencies hmac, sha1,
  data-encoding beside the gpui lines), `Cargo.lock` (port's), `stage/mod.rs`
  (an import), `stage/screen.rs` and `stage/view.rs` (the shared tree fixed
  "Copy frame" its own way, through `update_image`: the port's files taken,
  which fix it with dynamic textures).
- Scripts covered: 2 `flex_shrink`, 1 `max_offset`, 1 `BoxShadow`, 5 focus
  calls, 3 `Focusable` imports. Not covered: 2 `window.focus(&h)` in
  `settings/jumps.rs` and `settings/whispers.rs` (by hand), 1
  `max_offset_for_scrollbar().height` in a test (`mech1.py` widened), the
  new `Screen::play_on` (by hand), one test pressing a row the frame no
  longer draws (`tests_admin_pages::a_role_is_deleted_with_its_rule`).
- Result: `cargo check --all-targets` clean; suite 848 passed, 0 failed
  of 896 after the test fix (`tests_shared_picture::opened_large...` failed
  once in the parallel run, a temporary folder; passes alone and in the
  rerun). The shared tree's own suite at 23:12: 847 passed, 0 failed (notes\suite-client3-shared.txt): the port is as green.
- The real hand-over: the same steps on the frozen tree; expect the same
  kinds, an hour of work, and whatever the shared tree adds to the player's
  and the stage's files in the meantime.

## Cell/RefCell audit (retained mode)

30 uses outside tests. State read in render and changed outside an entity: `at_tail`/`below` (list scroll handler; fixed, redraws on change), `dock` bounds (written in paint, read when the sheet opens: fine), `formats::IN_FORCE` and `words::SPOKEN` (changes end in `cx.refresh_windows()`: fine), `settings seek` (paint to paint: fine). The rest are paint-internal (page painter, ink stack), caches keyed by content (lettering), event-side state (text input layout, focus holder, asides map), or the player/stage handles (frames notify the shell). No other missing `cx.notify()` found.
