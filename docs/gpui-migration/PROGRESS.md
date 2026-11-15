# Migration progress (kept current after each step)

Builds: Windows -> F:\fancy-build\migrate-target, Android -> F:\fancy-build\gpui-android. Every cargo command:
`. F:\fancy-migrate\notes\cargo-env.ps1` first (target dir, 6 jobs, no debug info, stable toolchain). One cargo at a time. Nothing on C:. `Get-PSDrive F` before every build; stop under 12 GB. One tree's output at a time in migrate-target (cargo keys by path: client-2-edit and client-3 builds double it). `migrate-target\debug` was deleted 00:15 (23.5 GB): the next test build starts from scratch (~6-10 min); delete `debug` again after the suite.

gpui-next has TWO writers (Android agent): `git status` + `git log -3` before committing; `git add` by path only; never amend/rebase/reset; commit only after `cargo check -p <crate>` on exactly what is committed.
The Android agent once committed in client-2-edit through a copied `.git` file (fixed, see below): check `git log -3` in client-2-edit / client-3 before relying on HEAD.

## State at hand-over (2026-11-15 ~00:20, agent 2 stopped for the usage limit)

### Trees
- `F:\fancy-migrate\gpui-next` branch `fancy`, HEAD 4058aaa (mine) + later Android commits. 4058aaa = feature `layout-rounding-0-2` (see FANCY_CHANGES "layout: Rounding as GPUI 0.2.2 rounded"). gpui lib tests: 851 ok without the feature; 849 ok + 2 upstream-rule tests ignored with it.
- `F:\fancy-migrate\client-2` (`baseline`, 20:01 tree) / `client-2-edit` (`port`): f71ddc0 table fix (mine), c52c4b2 (Android agent's stray commit = my tree incl. the rounding feature in Cargo.toml: KEPT, content is mine), 480e0e7 (Android library split + screenshare gate: REVERTED by a96102d; patches in notes\android, apply later as an own step with checks). Suite at f71ddc0 (suite-port3 + table fix): all pass but the 2 baseline translation tests.
- `F:\fancy-migrate\client-3` = rehearsal on the shared tree of 23:12 (see PORT-RECORD "Rehearsal"): branch `shared-2312` (844afec snapshot), `port-2312` (8b79489 = merge, the tree to measure as NEW); worktree `F:\fancy-migrate\client-3-shared` branch `old-2312` (844afec + knobs c5a1b4d = the OLD side, includes tonight's memory fix, page block listing, body read-back). check --all-targets clean on port-2312; suite port-2312 848 ok / 0 failed / 48 ignored (notes\suite-client3-port.txt; one stale-bounds test fixed in the merge commit); shared tree's own suite at 23:12: 847 ok / 0 failed (notes\suite-client3-shared.txt). NOT built in release yet (the old-2312 release build did not complete; a mislabelled copy was deleted).

### Done and verified
- Table width defect: cause = 0.2.2's text measure answered MinContent with its last cached (wrapped) size; gpui-next answers unwrapped. Fix in client (natural.rs `least_box`/`columns_least`, min_w on table and cells). tests_page 20/20.
- Pixel shifts: gpui-next feature `layout-rounding-0-2` (unrounded lengths/measures, Taffy 0.9 rounding rule, UNROUNDED LINE HEIGHT (the main cause: 0.2.2 never rounded line heights), glyph floor on a 1/128 grid). 12 captures port vs 0.2.2 (both 20:01 tree): 0.0005-0.04 % (notes\captures\r4, r4-noretain; same with retention off). Remainder: connect 0.03 % = 1-2 level noise; main-nimbus 0.04 % = hover pill + Nimbus dock hard shadow (0.2.2 at 20:01 never drew zero-blur shadows; the shared tree fixed it later in its fork; gpui-next draws it natively).
- Web parity, main screen (web preview on another agent's vite :5411, current web code): dark old 0.418 % / port 0.405 %; light old 0.419 % / port 0.415 % (notes\captures\web, diff\web-*).
- Rehearsal: under an hour of work; see PORT-RECORD.

### Measurements that exist (all from earlier; NOT the final tables)
- Idle CPU % of a core, 30 s single samples (21:26-21:45, old = 20:01 baseline, new = port before rounding): old 0.05 / 0.16 / 0.00-0.10 (connect / server / minimised); new 0.00 / 0.42 / 0.00-0.16; new no-retain 0.00 / 0.26 / 0.10-0.26. Commit 92-97 MB in all. Raw: notes\measure\{old,new,new-noretain}.tsv.
- Nothing else measured: no startup, memory guard, Nimbus GPU, scroll, flow, share, player, codec. Real WebView2 player and real codec path never run.

### Not done
- Clippy (both trees). Measurements (task 3). Regressions (task 4): Nimbus path buffer — gpui-next's DirectX path code (directx_renderer.rs draw_paths_to_intermediate, fast/frame.rs rasterize_paths) is the same per-batch WRITE_DISCARD with 104-byte PathRasterizationSprite as 0.2.2 before tonight's fix: expect the same Nimbus commit/shared-GPU growth; MEASURE, then port the old fork's AppendBuffer (shared tree vendor/gpui directx_renderer.rs lines ~1030-1290 + shaders.hlsl t1/t2) into both paths. Startup: font thread not ported.

## Exact next commands
1. `. F:\fancy-migrate\notes\cargo-env.ps1; cd F:\fancy-migrate\client-3-shared\src\ui\gpui; cargo build --release` -> copy release\fancy-gpui.exe to F:\fancy-migrate\bin\fancy-gpui-old-2312.exe
2. `cd F:\fancy-migrate\client-3\src\ui\gpui; cargo build --release` -> bin\fancy-gpui-new-2312.exe
3. captures: `measure\captures.ps1 -Exe <each> -Out notes\captures\{old,new}-2312` (+ `-Retain 0`), compare with tools\compare.py (measure\compare-all.ps1).
4. memory guard: `powershell -File C:\Users\Sebastian\Documents\Projects\Mumble\fancy-mumble-e2e\vendor\client\src\ui\gpui\tools\memory.ps1 -Exe <each>` (+ `$env:GPUI_VIEW_RETENTION=0` for the new).
5. Edit `$old`/`$new` in measure\run-all.ps1 to the 2312 binaries; `run-all.ps1 -Groups idle,memory,frames,flow,share *> notes\measure\run-all3.log`.
6. Scrolling: `measure\scroll2.ps1 -Exe <exe> -Label <b>-<scene>-<theme> -Scene conversation|channels|settings|welcome [-Theme nimbus] [-Retain 0]` (results notes\measure\scroll.tsv; frame stats from the TMP hooks of both GPUIs).
7. Startup: `measure\startup.ps1 -Old <old> -New <new>`.
8. Player (muted, scratchpad\agent-embeds\paused.ps1 / look-player.ps1 with FANCY_GPUI_PLAYER_MUTED=1) and codec (FANCY_GPUI_DEMO_SHARE_CODEC=1, measure.ps1 share group).
9. Clippy both trees; suite once; delete migrate-target\debug again.
