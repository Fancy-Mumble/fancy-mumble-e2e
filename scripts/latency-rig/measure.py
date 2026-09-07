"""Measure any voice client's mouth-to-ear delay through the virtual cables.

Both cables are recorded by **one** ffmpeg process into a two-channel file, and
that is the whole trick: channel 0 is what the client's microphone is being fed
and channel 1 is what the client played, sharing one sample clock. The delay is
then the distance between the same burst on the two channels - no wall clocks,
no cross-process timestamps, and no need to know when playback started.

What the number contains
------------------------
The client's own pipeline, plus its input and output device buffering, plus the
delay of the AUX cable and of the two capture paths. Everything after the first
term is identical for every client measured this way, so comparisons between
clients are sound even though the absolute figure is inflated. Our own client
can also be measured from the inside (``voice-latency.multiclient.test.ts``), and
the difference between its two numbers is what the rig and the real devices add.

Usage
-----
    python measure.py --seconds 20 [--out run.wav]

with the client under test already connected to a server, its microphone set to
the VAIO cable and its output to the AUX cable, and something on the far end to
echo the audio back (stock Mumble's server loopback, or a second client).
"""

from __future__ import annotations

import argparse
import math
import struct
import subprocess
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rig import RECORD_FROM_MIC, RECORD_FROM_SPEAKER  # noqa: E402
import inject  # noqa: E402

FFMPEG = Path(
    r"C:\Users\Sebastian\Downloads\ffmpeg-2025-05-29-git-75960ac270-full_build\bin\ffmpeg.exe"
)
BURST_HZ = 2_000.0


def record_both(out: Path, seconds: float) -> None:
    """Capture both cables into one stereo file, on a single clock."""
    subprocess.run(
        [
            str(FFMPEG), "-hide_banner", "-y",
            "-f", "dshow", "-i", f"audio={RECORD_FROM_MIC}",
            "-f", "dshow", "-i", f"audio={RECORD_FROM_SPEAKER}",
            "-filter_complex",
            "[0:a]aresample=48000[a0];[1:a]aresample=48000[a1];[a0][a1]amerge=inputs=2[a]",
            "-map", "[a]", "-ac", "2", "-t", str(seconds), str(out),
        ],
        check=True,
        capture_output=True,
    )


def read_stereo(path: Path) -> tuple[list[float], list[float], int]:
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 2, "expected the two cables interleaved"
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())
    vals = struct.unpack(f"<{len(raw) // 2}h", raw)
    return [v / 32768.0 for v in vals[0::2]], [v / 32768.0 for v in vals[1::2]], rate


def goertzel(x: list[float], start: int, n: int, freq: float, rate: int) -> float:
    k = 2 * math.pi * freq / rate
    coeff = 2 * math.cos(k)
    s1 = s2 = 0.0
    for i in range(start, start + n):
        s0 = x[i] + coeff * s1 - s2
        s2, s1 = s1, s0
    return math.sqrt(max(0.0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n


def onsets(x: list[float], rate: int, period_ms: float) -> list[float]:
    """Seconds at which a burst starts. Rising edges only, one per period."""
    win = int(rate * 0.005)
    hop = int(rate * 0.001)
    refractory = period_ms / 1000.0 * 0.8
    mags = [(i / rate, goertzel(x, i, win, BURST_HZ, rate)) for i in range(0, len(x) - win, hop)]
    if not mags:
        return []
    peak = max(m for _, m in mags)
    floor = sorted(m for _, m in mags)[len(mags) // 2]
    threshold = floor + (peak - floor) * 0.5
    found: list[float] = []
    was_above = False
    for t, m in mags:
        above = m >= threshold
        if above and not was_above and (not found or t - found[-1] >= refractory):
            found.append(t)
        was_above = above
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--period-ms", type=float, default=250.0)
    ap.add_argument("--out", type=Path, default=Path("rig-run.wav"))
    ap.add_argument("--click", type=Path, default=Path("click.wav"))
    args = ap.parse_args()

    if not args.click.exists():
        print(f"no click train at {args.click} - run make_click.py first")
        return 2

    inject.start(args.click)
    try:
        record_both(args.out, args.seconds)
    finally:
        inject.stop()

    sent, heard, rate = read_stereo(args.out)
    sent_at = onsets(sent, rate, args.period_ms)
    heard_at = onsets(heard, rate, args.period_ms)
    print(f"rig: {len(sent_at)} bursts injected, {len(heard_at)} played back")
    if len(sent_at) < 5 or len(heard_at) < 5:
        print(
            "rig: not enough bursts to measure. Check that the client is connected, "
            "that its microphone is the VAIO cable and its output the AUX cable, and "
            "that the far end is echoing audio back."
        )
        return 1

    # Pair each arrival with the last injection before it.
    deltas: list[float] = []
    for h in heard_at:
        earlier = [s for s in sent_at if s <= h]
        if not earlier:
            continue
        d = (h - earlier[-1]) * 1000.0
        if 5.0 <= d <= args.period_ms:
            deltas.append(d)
    if len(deltas) < 5:
        print(
            f"rig: only {len(deltas)} bursts could be paired - if the real delay "
            f"exceeds {args.period_ms:.0f} ms, regenerate the click train with a "
            "longer period"
        )
        return 1

    deltas.sort()
    median = deltas[len(deltas) // 2]
    p95 = deltas[min(len(deltas) - 1, int(0.95 * len(deltas)))]
    print(
        f"rig: median {median:.1f} ms, p95 {p95:.1f} ms over {len(deltas)} bursts "
        f"(min {deltas[0]:.1f}, max {deltas[-1]:.1f})"
    )
    print("rig: includes device buffering and the cable path, unlike the in-client number")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
