# The drawing overlay on Linux: what the platform permits, and what we do about it

Research and implementation notes, 2026-09-05. The feature: a viewer annotates the picture
they receive from a screen share, and the streamer opens a transparent, click-through window
pinned over the real shared screen so those marks appear where the viewer drew them. Windows
and macOS give an app everything that needs. Linux gives some of it, and this records exactly
which parts, why, and what the client now does instead of pretending otherwise.

Verified against the working tree of `vendor/client` (Tauri 2.10.3 / `tao` 0.34.6 / GTK 3,
`xcap` 0.6.2, `ashpd` 0.13) on Ubuntu 26.04 / GNOME (Wayland session, `XWayland` default), and
by running the client against a nested `sway` for the layer-shell path.

## 0. TL;DR

1. **The overlay was blank on every platform** for an unrelated reason: the `draw-overlay`
   capability lacked `store:default`, so `UiRoot` could not read the UI pack out of
   preferences and rendered nothing. Fixed; the same gap blanked image popouts and the
   updater window, and a test now guards every capability.
2. **Placement was wrong on the shipped Linux path.** Capture goes through
   xdg-desktop-portal, where the *compositor's* dialog picks the source and the in-app source
   id never reaches it. The overlay fell back to "the monitor under the cursor". The portal
   does report which output it streams (`position`/`size`, logical coordinates), and that is
   now what places the overlay.
3. **A shared window can be followed on X11, never on Wayland.** `_NET_CLIENT_LIST_STACKING`
   plus `GetGeometry` is cheap enough to poll at 100 ms; Wayland exposes no window geometry to
   anyone (xdg-desktop-portal#571, open since 2021).
4. **A native-Wayland toplevel cannot be placed or raised at all.** `gtk_window_move` and
   `gtk_window_set_keep_above` are silent no-ops there. The only mechanism is
   `zwlr_layer_shell_v1`, which KDE, sway, Hyprland, COSMIC and niri implement and
   GNOME/Mutter has declined for years (mutter#973). The client now uses layer-shell where it
   exists and *says so* where it does not, instead of opening a window nobody can see.
5. **Nothing on Linux can keep the overlay out of a monitor capture.** There is no equivalent
   of Windows' `WDA_EXCLUDEFROMCAPTURE` or macOS' `NSWindowSharingNone`. Sharing a *window*
   sidesteps it (the compositor streams that window's own surface, not the screen), and
   compositor-side user rules can black the overlay out. The UI stops claiming otherwise.

## 1. How Linux capture actually works here

`pipeline.rs` tries `GpuPipelineLinux` first for both screens and windows, and it is on by
default, so the portal path is the shipped one:

```
xdg-desktop-portal ScreenCast  ->  PipeWire node  ->  VA-API / NVENC / openh264
```

Two consequences drive everything below:

- **The compositor picks the source.** `PortalSession::open` calls `SelectSources` + `Start`;
  the dialog that appears is the compositor's. `GpuPipelineLinux::new` takes the in-app
  `source_id` and ignores it. On GNOME the in-app picker is skipped entirely
  (`native_portal_picker`). So the id the overlay used to resolve was advisory - usually `0`,
  resolving to nothing.
- **A window stream is that window's surface.** The portal hands back one PipeWire node bound
  to the window, not a screen region, so overlapping windows are not in it. A monitor stream
  is the full composited output, overlay included.

`xcap` enumeration (`Monitor::all()`, `Window::all()`) is X11-only: under a Wayland session it
sees `XWayland` clients at best, often nothing.

## 2. What the portal does tell us

`Start` returns per-stream properties; `ashpd` exposes them on `Stream`:

| Property | Type | Available for | Meaning |
|---|---|---|---|
| `position()` | `(i32, i32)` | **monitor streams only** | origin in the compositor's *logical* space |
| `size()` | `(i32, i32)` | monitor streams only | logical extent; advisory |
| `source_type()` | `SourceType` | v3+ | Monitor / Window / Virtual |
| `pipe_wire_node_id()` | `u32` | always | the node to connect to |

The negotiated PipeWire `VideoInfoRaw` size is the authoritative pixel geometry and follows
resizes. The client keeps both in `ACTIVE_PORTAL_SOURCE` (`linux/portal.rs`), cleared when the
session drops, and exposes them as `fancy_screenshare::active_portal_source()`.

Monitor matching uses the **origin**, not the size: origins are unique, sizes routinely are not
(two identical screens side by side). Logical origins are compared against each monitor's
physical origin divided by its scale factor, within 1.5 px. When only a size is known and it
singles one monitor out, that is used; when it does not, the picker declines rather than
guessing, and the old cursor/primary fallback applies.

## 3. Following a shared window

X11 makes this cheap: `Window::all()` walks `_NET_CLIENT_LIST_STACKING` once (hundreds of ms,
paid at open), and thereafter `x()/y()/width()/height()` are one `GetGeometry` +
`TranslateCoordinates` round trip each, polled at 100 ms. The window is identified by the size
the stream negotiated, within 4 px, preferring the top-most match - the portal does not say
which window it picked, so size is the only handle.

Wayland offers no equivalent, and no proposal is close: xdg-desktop-portal#571 ("expose
position and size of WINDOW streams") has been open and undecided since March 2021.

The polling loop is platform-neutral (`draw_overlay/tracker.rs`), with the policy as a pure
function - minimize hides the overlay and a restore brings it back, a destroyed source closes
it - and the Win32 and X11 halves reduced to "where is that window now".

## 4. Placing a window on Wayland

A Wayland client may not position itself, and may not request a z-order. In `tao` 0.34 both
calls exist and both do nothing:

```rust
WindowRequest::Position((x, y)) => window.move_(x, y),          // gtk_window_move: no-op
WindowRequest::AlwaysOnTop(on) => window.set_keep_above(on),    // likewise
```

`zwlr_layer_shell_v1` is the protocol that grants exactly what an overlay needs: a surface
anchored to a chosen output, in the `OVERLAY` layer, with an input region we can empty.

| Compositor | layer-shell | Overlay outcome |
|---|---|---|
| KWin (Plasma 6) | yes | works natively |
| wlroots - sway, Hyprland | yes | works natively (verified on sway) |
| COSMIC, niri | yes | works natively |
| **GNOME / Mutter** | **no** (mutter#973 open) | unavailable; use `GDK_BACKEND=x11` |

The client binds `libgtk-layer-shell.so.0` at runtime with `dlopen` rather than linking it: the
Rust binding crate is archived (RUSTSEC-2024-0422), the C library is an optional distro package
(`libgtk-layer-shell0` on Debian/Ubuntu), and a missing library must degrade to "unsupported",
not to a binary that will not start. `gtk_layer_is_supported()` answers for the compositor.

Two ordering constraints, both learned the hard way:

- `gtk_layer_init_for_window` must run **before the window is realized**, so the overlay is
  built `visible(false)` and shown only after the layer surface is configured.
- `set_ignore_cursor_events(true)` must run **after** the window is on screen: `tao` reaches
  for the `GdkWindow` to install an empty input region and `unwrap()`s it
  (`event_loop.rs:448`), and an unrealized window has none - which aborts the process, not
  just the call.

The app defaults itself to `GDK_BACKEND=x11` (`platform/linux/webview.rs::pre_init`), so a
normal launch gets `XWayland`, where positioning and `_NET_WM_STATE_ABOVE` work. The Wayland
backend is reached when the environment already exports `GDK_BACKEND=wayland` - **VS Code's
integrated terminal does exactly this**, which is how a dev-launched client silently loses the
overlay - or inside the `AppImage`, which forces it on Wayland sessions by design.

## 5. Keeping the overlay out of the stream

There is no per-window capture exclusion on Linux. Not in X11 (any client can `XGetImage` any
drawable), and not in Wayland (capture is mediated by the portal, which has no per-surface
opt-out). What exists is **compositor-side, user-configured** exclusion:

| Compositor | Mechanism |
|---|---|
| KDE Plasma 6.6+ | title-bar menu -> More actions -> *Hide from ScreenCast*, or a window rule |
| niri | `window-rule { block-out-from "screencast" }`, and `layer-rule` for layer surfaces |
| Hyprland | `windowrulev2 = no_screen_share, ...` |
| GNOME | nothing |

For those rules to be writable, the overlay needs a stable identity, so it sets
`WM_WINDOW_ROLE = fancy-mumble-draw-overlay` on X11 and the layer-shell namespace
`fancy-mumble-draw-overlay` on Wayland.

In practice the echo is mild - the burned-in stroke lands under the one the viewer's own client
draws - but it is real, and the honest advice is: **share a window rather than a whole screen**
and the overlay is out of the stream by construction.

## 6. Support matrix

| Session | Share | Overlay placed | Follows the window | Out of the stream |
|---|---|---|---|---|
| X11 / `XWayland` (default) | monitor | yes, on the portal's output | n/a | **no** |
| X11 / `XWayland` | window | yes, on the window | yes | yes (window stream) |
| Wayland + layer-shell | monitor | yes, layer surface | n/a | **no** |
| Wayland + layer-shell | window | **no** - refused, no geometry | no | - |
| Wayland, GNOME | any | **no** - refused, use `GDK_BACKEND=x11` | no | - |
| Windows / macOS | either | yes | yes (Windows) | yes |

The `drawing_overlay_support` command reports this row to the UI, which disables the toggle
with the reason rather than opening a window the user cannot see.

## 7. Sources

- xdg-desktop-portal ScreenCast, `Start` stream properties -
  <https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html>
- "Expose position and size of PipeWire streams for source type WINDOW", open since 2021-03-27 -
  <https://github.com/flatpak/xdg-desktop-portal/issues/571>
- `wlr-layer-shell-unstable-v1` - <https://wayland.app/protocols/wlr-layer-shell-unstable-v1>
- gtk-layer-shell (GTK3 C library, maintenance mode) - <https://github.com/wmww/gtk-layer-shell>
- RUSTSEC-2024-0422, `gtk-layer-shell` crate unmaintained -
  <https://rustsec.org/advisories/RUSTSEC-2024-0422.html>
- "implement layer_shell protocol", Mutter, open -
  <https://gitlab.gnome.org/GNOME/mutter/-/work_items/973>
- tao: `set_outer_position` / `always_on_top` do nothing on Wayland -
  <https://github.com/tauri-apps/tao/issues/566>, <https://github.com/tauri-apps/tao/issues/1134>
- KDE Plasma 6.6 "Hide from ScreenCast" -
  <https://ostechnix.com/exclude-certain-windows-from-screen-recording-in-plasma-6-6/>
- niri `block-out-from` - <https://github.com/niri-wm/niri/wiki/Screencasting>
- Hyprland screen-sharing rules - <https://wiki.hypr.land/Useful-Utilities/Screen-Sharing/>

## 8. Reproducing the three paths

```bash
# XWayland (the default): overlay pinned to the portal's monitor, above, click-through
env -u GDK_BACKEND FANCY_E2E_PORTAL_SOURCE=screen:0,0,2560,1440 ./mumble-tauri
xwininfo -root -tree | grep -A1 fancymumble     # expect the seeded rect + _NET_WM_STATE_ABOVE

# GNOME Wayland: refused, with a reason the UI shows
GDK_BACKEND=wayland ./mumble-tauri              # drawing_overlay_support -> wayland-no-layer-shell

# layer-shell, nested sway
WLR_BACKENDS=headless WLR_RENDERER=pixman sway -c sway.conf   # output HEADLESS-1 2560x1440
WAYLAND_DISPLAY=wayland-1 GDK_BACKEND=wayland ./mumble-tauri
grim shot.png                                   # the strokes cover the output, above the app
```

`FANCY_E2E_PORTAL_SOURCE` (`screen:<x>,<y>,<w>,<h>` or `window:<w>x<h>`) seeds the portal answer,
because no `WebDriver` can drive the compositor's own dialog.
