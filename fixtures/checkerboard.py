#!/usr/bin/env python3
"""
Deterministic green/purple checkerboard window for the screen-share e2e test.

The screen-share suite needs a *capturable OS window* with content it can verify
pixel-for-pixel after the picture has travelled through:

    Rust capture -> VP8 encode -> server SFU -> browser viewer -> <video>

We therefore paint a high-contrast checkerboard of two pure-ish colours
(green vs purple) whose *hue class* survives VP8's lossy compression and any DPI
rescaling. The test asserts the recovered frame is a checkerboard and that its
cells fall into the green-dominant / purple-dominant classes - never exact RGB.

Two distinguishing knobs let the suite tell *whose* window it is looking at
(so "each client sees its own" and "both clients see the same window" are
provable):

  --phase 0   cell (0,0) is GREEN   (e.g. Alice)
  --phase 1   cell (0,0) is PURPLE  (e.g. Bob)

The window is borderless, fixed-size, always-on-top and titled so the Rust
window enumerator can match it by title.

Usage:
    python checkerboard.py --title "fancy-e2e-checker-A" --phase 0
    python checkerboard.py --title "fancy-e2e-checker-B" --phase 1 \
        --cols 8 --rows 6 --cell 64 --x 100 --y 100

Requires Tkinter (stdlib; on Debian/Ubuntu install `python3-tk`).
"""
from __future__ import annotations

import argparse
import sys
import tkinter as tk

# Pure-ish, high-saturation colours. Chosen so that after VP8 the green cells
# stay G-dominant and the purple cells stay (R+B)-dominant with a wide margin.
GREEN = (0, 180, 0)
PURPLE = (150, 0, 150)


def _hex(rgb: tuple[int, int, int]) -> str:
    return "#%02x%02x%02x" % rgb


def _enable_crisp_dpi() -> None:
    """Avoid Windows DPI virtualization so 1 logical px == 1 device px and the
    captured cells line up exactly with the geometry we requested."""
    if sys.platform == "win32":
        try:
            import ctypes

            # PROCESS_PER_MONITOR_DPI_AWARE = 2
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass


def build(args: argparse.Namespace) -> tk.Tk:
    _enable_crisp_dpi()
    root = tk.Tk()
    root.title(args.title)
    width = args.cols * args.cell
    height = args.rows * args.cell
    root.geometry(f"{width}x{height}+{args.x}+{args.y}")
    root.resizable(False, False)
    # Borderless so no title-bar/chrome pixels pollute the captured frame, and
    # topmost so window capture is reliable even on a busy desktop / under a
    # bare X server (no compositor) in CI.
    root.overrideredirect(True)
    root.attributes("-topmost", True)

    canvas = tk.Canvas(root, width=width, height=height, highlightthickness=0, bd=0)
    canvas.pack()

    green = _hex(GREEN)
    purple = _hex(PURPLE)
    for r in range(args.rows):
        for c in range(args.cols):
            # `phase` flips which colour lands on cell (0,0) so two instances
            # produce inverted boards that the test can tell apart.
            is_green = ((r + c + args.phase) % 2) == 0
            x0, y0 = c * args.cell, r * args.cell
            canvas.create_rectangle(
                x0, y0, x0 + args.cell, y0 + args.cell,
                fill=green if is_green else purple,
                width=0,
                outline="",
            )

    # Print a machine-readable line so the harness can confirm the window is up
    # (and learn the exact geometry it should expect back).
    print(
        f"checkerboard-ready title={args.title} phase={args.phase} "
        f"cols={args.cols} rows={args.rows} cell={args.cell} "
        f"width={width} height={height}",
        flush=True,
    )
    return root


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description="Green/purple checkerboard e2e window")
    p.add_argument("--title", required=True, help="Window title (used to match the capture source)")
    p.add_argument("--phase", type=int, default=0, choices=(0, 1),
                   help="0 = green at cell(0,0), 1 = purple at cell(0,0)")
    p.add_argument("--cols", type=int, default=8)
    p.add_argument("--rows", type=int, default=6)
    p.add_argument("--cell", type=int, default=64, help="Cell edge length in pixels")
    p.add_argument("--x", type=int, default=120, help="Window left position")
    p.add_argument("--y", type=int, default=120, help="Window top position")
    args = p.parse_args(argv)

    root = build(args)
    try:
        root.mainloop()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
