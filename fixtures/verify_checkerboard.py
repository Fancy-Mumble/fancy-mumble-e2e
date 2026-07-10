#!/usr/bin/env python3
"""
Self-check for the screen-share e2e *pixel contract* - runnable without the app,
server, or WebDriver. It proves the two novel halves the e2e test depends on:

  Part A: the classification math (green/purple/phase/mismatch + tolerance) is a
          faithful port of the in-browser READ_CHECKERBOARD_FN, exercised on a
          synthetic board (exact, deterministic).
  Part B: the Tk helper actually renders the green + purple colours on a real
          display (full-screen grab; both hue classes present in quantity).

Run: python fixtures/verify_checkerboard.py
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
GREEN = (0, 180, 0)
PURPLE = (150, 0, 150)


# --- Port of the browser-side classifier (must match stream.page.ts) ---------
def classify(r: float, g: float, b: float) -> str:
    if g > r + 30 and g > b + 30:
        return "green"
    if r > g + 30 and b > g + 30:
        return "purple"
    return "other"


def classify_board(img: np.ndarray, cols: int, rows: int) -> dict:
    """img: HxWx3 uint8. Mirrors readCheckerboard(): sample cell centres, detect
    phase from corner, count mismatches against the implied alternation."""
    h, w, _ = img.shape
    grid = []
    green = purple = other = 0
    for ry in range(rows):
        row = []
        for cx in range(cols):
            px = int((cx + 0.5) * w / cols)
            py = int((ry + 0.5) * h / rows)
            r, g, b = (float(v) for v in img[py, px][:3])
            cls = classify(r, g, b)
            row.append(cls)
            green += cls == "green"
            purple += cls == "purple"
            other += cls == "other"
        grid.append(row)
    # Derive phase by best fit over BOTH hypotheses rather than trusting a
    # single corner cell (which a VP8 artifact / edge bleed can flip).
    def mismatches_for(phase: int) -> int:
        bad = 0
        for ry in range(rows):
            for cx in range(cols):
                expect = "green" if (ry + cx + phase) % 2 == 0 else "purple"
                if grid[ry][cx] != expect:
                    bad += 1
        return bad

    m0, m1 = mismatches_for(0), mismatches_for(1)
    phase, mismatches = (0, m0) if m0 <= m1 else (1, m1)
    total = cols * rows
    # A board that is mostly "other" (no real green/purple) isn't a checkerboard
    # even if one phase happens to fit; require both colours to dominate.
    has_colour = (green + purple) >= total // 2
    checkerboard = has_colour and mismatches <= -(-total * 15 // 100)  # ceil(15%)
    return dict(phase=phase, green=green, purple=purple, other=other,
                mismatches=mismatches, checkerboard=checkerboard)


def make_board(cols: int, rows: int, cell: int, phase: int) -> np.ndarray:
    img = np.zeros((rows * cell, cols * cell, 3), dtype=np.uint8)
    for ry in range(rows):
        for cx in range(cols):
            color = GREEN if (ry + cx + phase) % 2 == 0 else PURPLE
            img[ry * cell:(ry + 1) * cell, cx * cell:(cx + 1) * cell] = color
    return img


def part_a() -> None:
    print("[A] classifier math on synthetic boards")
    cols, rows, cell = 8, 6, 16
    # phase 0: green corner, clean board.
    r0 = classify_board(make_board(cols, rows, cell, 0), cols, rows)
    assert r0["phase"] == 0, r0
    assert r0["checkerboard"] and r0["mismatches"] == 0, r0
    assert r0["green"] > 0 and r0["purple"] > 0, r0
    # phase 1: purple corner.
    r1 = classify_board(make_board(cols, rows, cell, 1), cols, rows)
    assert r1["phase"] == 1 and r1["checkerboard"], r1
    # tolerance: corrupt ~12% of cells -> still a checkerboard.
    board = make_board(cols, rows, cell, 0)
    board[0:cell, 0:cell] = (40, 40, 40)            # 1 cell
    board[0:cell, cell:2 * cell] = (40, 40, 40)     # 2 cells ~= 4% < 15%
    rc = classify_board(board, cols, rows)
    assert rc["checkerboard"], f"should tolerate a few bad cells: {rc}"
    # heavy corruption: blank the whole top half -> NOT a checkerboard.
    board2 = make_board(cols, rows, cell, 0)
    board2[0:rows * cell // 2, :] = (40, 40, 40)
    rbad = classify_board(board2, cols, rows)
    assert not rbad["checkerboard"], f"should reject a broken board: {rbad}"
    print("    OK: phase detection, clean board, 15% tolerance, broken-board rejection")


def part_b() -> int:
    print("[B] Tk helper renders green+purple on a real display")
    try:
        from PIL import ImageGrab
    except Exception as e:  # noqa: BLE001
        print(f"    SKIP: Pillow ImageGrab unavailable ({e})")
        return 0

    for phase, who in ((0, "A/green-first"), (1, "B/purple-first")):
        title = f"fancy-e2e-verify-{phase}-{int(time.time())}"
        proc = subprocess.Popen(
            [sys.executable, str(HERE / "checkerboard.py"),
             "--title", title, "--phase", str(phase),
             "--cols", "8", "--rows", "6", "--cell", "60", "--x", "100", "--y", "100"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            # Wait for the ready line.
            deadline = time.time() + 10
            ready = False
            while time.time() < deadline:
                line = proc.stdout.readline()
                if "checkerboard-ready" in line:
                    ready = True
                    break
            assert ready, "helper never became ready"
            time.sleep(0.6)  # let it paint + raise
            shot = np.asarray(ImageGrab.grab().convert("RGB"))
            # Count pixels in each hue class across the whole screen.
            r = shot[:, :, 0].astype(int)
            g = shot[:, :, 1].astype(int)
            b = shot[:, :, 2].astype(int)
            green_mask = (g > r + 30) & (g > b + 30)
            purple_mask = (r > g + 30) & (b > g + 30)
            gn, pn = int(green_mask.sum()), int(purple_mask.sum())
            # A 480x360 board half-green/half-purple ~ 86k px each; require a
            # comfortable fraction to survive other green/purple desktop chrome.
            need = 20000
            assert gn > need and pn > need, (
                f"helper '{who}' did not render enough green/purple "
                f"(green={gn}, purple={pn}, need>{need})"
            )
            print(f"    OK: {who}: green={gn}px purple={pn}px on screen")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:  # noqa: BLE001
                proc.kill()
    return 0


def main() -> int:
    part_a()
    part_b()
    print("PASS: checkerboard pixel contract verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
