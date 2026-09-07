"""Generate the click train the rig injects.

The same signal the client's own ``click:`` virtual mic produces, so a number
from this rig and a number from the in-process e2e measurement are about the
same stimulus: a 5 ms 2 kHz burst every period, over a continuous 440 Hz carrier
that holds the noise gate open, so no client's gate decision is ever mistaken
for buffering.
"""

from __future__ import annotations

import math
import struct
import sys
import wave
from pathlib import Path

RATE = 48_000
CARRIER_HZ = 440.0
BURST_HZ = 2_000.0
BURST_SECS = 0.005
CARRIER_AMP = 0.3
BURST_AMP = 0.9


def click_train(seconds: float, period_ms: float) -> bytes:
    period = int(period_ms / 1000.0 * RATE)
    burst = int(BURST_SECS * RATE)
    out = bytearray()
    for i in range(int(seconds * RATE)):
        phase_in_period = i % period
        s = math.sin(2 * math.pi * CARRIER_HZ * i / RATE) * CARRIER_AMP
        if phase_in_period < burst:
            s += math.sin(2 * math.pi * BURST_HZ * phase_in_period / RATE) * BURST_AMP
        out += struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767))
    return bytes(out)


def write(path: Path, seconds: float = 60.0, period_ms: float = 250.0) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(click_train(seconds, period_ms))
    print(f"{path}: {seconds:.0f} s, one 2 kHz burst every {period_ms:.0f} ms")


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "click.wav")
    write(out, float(sys.argv[2]) if len(sys.argv) > 2 else 60.0)
