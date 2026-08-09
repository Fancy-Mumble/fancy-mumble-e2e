/**
 * Environment that makes OS screen/window capture *drivable by a test* on a
 * Linux desktop.
 *
 * # Why this is needed
 *
 * The client's Linux capture ladder is Chromium's: xdg-desktop-portal
 * ScreenCast -> PipeWire -> VA-API/NVENC, with an xcap/X11 CPU pipeline as the
 * fallback when the portal is unavailable. That ladder is right for users and
 * unusable for a test, because both of its rungs assume a human:
 *
 *   - **The portal shows the COMPOSITOR's own source dialog.** It is a
 *     Wayland-security requirement that the app cannot enumerate or preselect
 *     sources, and the dialog is not part of the app - WebDriver cannot see or
 *     click it. `PortalSession::open` deliberately leaves the user-interaction
 *     phase unbounded, so a suite that reaches it hangs rather than fails.
 *   - **On Wayland, native enumeration returns nothing**, so the in-app picker
 *     falls back to two synthetic cards ("Entire screen (system picker)",
 *     "Application window (system picker)") whose ids are advisory. A test
 *     asking for a window *by title* can never match one.
 *
 * Both symptoms are the same missing capability - a test cannot answer a
 * compositor dialog - and neither is a defect in the product.
 *
 * # What this changes
 *
 * It runs the client as an X11 client on the session's XWayland server, where
 * enumeration and capture need no dialog:
 *
 *   - `XDG_SESSION_TYPE=x11` + empty `WAYLAND_DISPLAY` flip xcap's
 *     `wayland_detect()` to the xcb path, so `Window::all()`/`Monitor::all()`
 *     enumerate real windows and monitors.
 *   - `GDK_BACKEND=x11` puts the client's own window on XWayland too, so it
 *     shares one coordinate space with the windows it captures.
 *   - `DBUS_SESSION_BUS_ADDRESS` points at nothing, so the portal fails inside
 *     its 5 s pre-dialog timeout and the pipeline falls back to xcap *before*
 *     any dialog can appear. This is the only lever the client offers: there
 *     is no "skip the portal" flag, and a reachable bus would hang the share.
 *
 * The tests still exercise real OS capture, a real encoder, the real SFU and a
 * real decoder - only the source-selection dialog is taken out of the path.
 *
 * Companion requirement: the source window must be WM-managed, or no
 * enumerator can see it either (see `fixtures/checkerboard.py`, which is why
 * it is a splash-type window rather than override-redirect).
 */
import { captureDisplay } from "./xvfb";

export function captureEnv(): Record<string, string> {
  if (process.platform !== "linux") return {};
  const env: Record<string, string> = {
    XDG_SESSION_TYPE: "x11",
    WAYLAND_DISPLAY: "",
    GDK_BACKEND: "x11",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-e2e-no-portal",
  };
  // A private X server when one is available (see `util/xvfb.ts`): it isolates
  // the capture from whatever else is on the desktop, and its root window can
  // actually be read, which XWayland's cannot.
  const display = captureDisplay();
  if (display) env.DISPLAY = display;
  return env;
}
