"""Play the click train onto the mic cable, using VoiceMeeter's own player.

Targeting a specific Windows playback endpoint from a command-line tool turns
out to be unreliable - ffplay accepts ``SDL_AUDIODEVICE`` and then opens the
default device anyway, which puts the measurement signal through whatever
speakers happen to be attached and nothing at all into the cable.

VoiceMeeter's built-in recorder sidesteps the question: it plays a file onto its
buses from inside the engine, so there is no endpoint to select and no chance of
the signal escaping to a real output. Its routing is set to B1 alone, which is
the cable the client under test uses as its microphone.
"""

from __future__ import annotations

import ctypes
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rig import Rig  # noqa: E402


def load(rig: Rig, wav: Path) -> None:
    rig.dll.VBVMR_SetParameterStringA.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    rc = rig.dll.VBVMR_SetParameterStringA(
        b"Recorder.load", str(wav.resolve()).encode()
    )
    if rc != 0:
        raise RuntimeError(f"Recorder.load({wav}) failed: {rc}")


def route_to_mic_cable(rig: Rig) -> None:
    """B1 only: the click train must not reach a speaker or the other cable."""
    for a in range(1, 6):
        rig.set(f"Recorder.A{a}", 0)
    for b, on in (("B1", 1), ("B2", 0), ("B3", 0)):
        rig.set(f"Recorder.{b}", on)
    rig.set("Recorder.gain", 0.0)


def start(wav: Path, loop: bool = True) -> None:
    with Rig() as rig:
        load(rig, wav)
        route_to_mic_cable(rig)
        try:
            rig.set("Recorder.mode.Loop", 1 if loop else 0)
        except RuntimeError:
            pass
        time.sleep(0.3)
        rig.set("Recorder.play", 1)


def stop() -> None:
    with Rig() as rig:
        rig.set("Recorder.stop", 1)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "stop":
        stop()
        print("inject: stopped")
    elif len(sys.argv) >= 3 and sys.argv[1] == "start":
        start(Path(sys.argv[2]))
        print(f"inject: playing {sys.argv[2]} onto B1 (the mic cable)")
    else:
        print("usage: inject.py start <wav> | inject.py stop")
        sys.exit(2)
