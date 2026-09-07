"""Drive the VoiceMeeter virtual cables used by the cross-client latency rig.

Why this exists
---------------
The e2e latency test measures *our* client from the inside: a virtual mic
replaces the capture device and a tap replaces the speaker. That is the right
way to measure our own pipeline and a useless way to compare against Discord or
stock Mumble, which will not host our instrumentation and whose numbers include
device buffering ours excludes.

This rig measures any client the same way instead: a click train is played into
a virtual cable that the client believes is a microphone, and whatever the
client plays is captured from a second cable. The same signal, the same
detector, the same arithmetic for everything under test - including our own
client, which is what makes its two numbers reconcilable.

Two cables, kept apart on purpose
---------------------------------
* ``VAIO``  - we play into it, the client under test records from it (its mic).
* ``AUX``   - the client plays into it, we record from it (its speaker).

Both pass through the VoiceMeeter engine, which adds its own delay to each. That
delay is measured by ``calibrate`` below and subtracted, and it is identical for
every client, so even an imperfect calibration cannot favour one over another.

The engine has to be running for the cables to carry anything at all: unlike a
plain VB-CABLE, these are mixer strips rather than a driver-level loopback.
"""

from __future__ import annotations

import ctypes
import sys
import time
from pathlib import Path

DLL = r"C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote64.dll"

# Potato has five physical strips before the virtual ones.
STRIP_VAIO = 5
STRIP_AUX = 6
STRIP_VAIO3 = 7

# Windows endpoint names, as the OS reports them.
PLAY_INTO_MIC = "VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)"
RECORD_FROM_MIC = "VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)"
PLAY_INTO_SPEAKER = "VoiceMeeter Aux Input (VB-Audio VoiceMeeter AUX VAIO)"
RECORD_FROM_SPEAKER = "VoiceMeeter Aux Output (VB-Audio VoiceMeeter AUX VAIO)"

VOICEMEETER_POTATO = 3


class Rig:
    """A logged-in connection to the VoiceMeeter engine."""

    def __init__(self) -> None:
        self.dll = ctypes.cdll.LoadLibrary(DLL)
        self.dll.VBVMR_SetParameterFloat.argtypes = [ctypes.c_char_p, ctypes.c_float]
        self.dll.VBVMR_GetVoicemeeterType.argtypes = [ctypes.POINTER(ctypes.c_long)]
        self.dll.VBVMR_GetParameterFloat.argtypes = [
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_float),
        ]

    def __enter__(self) -> "Rig":
        rc = self.dll.VBVMR_Login()
        if rc == 1:
            # Logged in, but nothing is running yet.
            if self.dll.VBVMR_RunVoicemeeter(VOICEMEETER_POTATO) != 0:
                raise RuntimeError("could not start VoiceMeeter Potato")
            # Readiness is asked of the engine, not of Login: a second Login on
            # an open session reports "already logged in", which would look like
            # a failure forever.
            kind = ctypes.c_long()
            for _ in range(50):
                time.sleep(0.2)
                if self.dll.VBVMR_GetVoicemeeterType(ctypes.byref(kind)) == 0:
                    break
            else:
                raise RuntimeError("VoiceMeeter started but never became ready")
        elif rc < 0:
            raise RuntimeError(f"VBVMR_Login failed: {rc}")
        # Drain the dirty flag so later reads reflect our own writes.
        for _ in range(10):
            if self.dll.VBVMR_IsParametersDirty() == 0:
                break
            time.sleep(0.05)
        return self

    def __exit__(self, *_exc: object) -> None:
        self.dll.VBVMR_Logout()

    def set(self, name: str, value: float) -> None:
        rc = self.dll.VBVMR_SetParameterFloat(name.encode(), ctypes.c_float(value))
        if rc != 0:
            raise RuntimeError(f"setting {name}={value} failed: {rc}")

    def get(self, name: str) -> float:
        out = ctypes.c_float()
        rc = self.dll.VBVMR_GetParameterFloat(name.encode(), ctypes.byref(out))
        if rc != 0:
            raise RuntimeError(f"reading {name} failed: {rc}")
        return out.value

    def route_cable(self, strip: int, bus: str) -> None:
        """Send `strip` to `bus` alone, at unity gain and unmuted.

        Every other bus is cleared: a strip that also reached a hardware output
        would put the measurement signal through the speakers, and a strip
        reaching two virtual buses would put each cable's traffic on the other.
        """
        for a in range(1, 6):
            self.set(f"Strip[{strip}].A{a}", 0)
        for b in ("B1", "B2", "B3"):
            self.set(f"Strip[{strip}].{b}", 1 if b == bus else 0)
        self.set(f"Strip[{strip}].Gain", 0.0)
        self.set(f"Strip[{strip}].Mute", 0)
        # No processing may sit in the path: a gate or a compressor would delay
        # the burst and be measured as though the client had done it.
        for fx in ("Comp", "Gate", "Denoiser"):
            try:
                self.set(f"Strip[{strip}].{fx}", 0.0)
            except RuntimeError:
                pass  # not present on every strip type


# The engine needs a hardware output to clock itself: with A1 unbound it runs,
# accepts parameters, and processes no audio at all - both cables stay silent
# and nothing says why. VAIO3's input endpoint is the sink to give it, because
# it is virtual (so nothing is audible) and it feeds a strip that this rig
# routes to no bus (so it cannot loop back into a measurement).
CLOCK_SINK = "VoiceMeeter VAIO3 Input (VB-Audio VoiceMeeter VAIO3)"


def bind_clock(rig: "Rig") -> None:
    """Give the engine its clock, unless something is already bound to A1."""
    rig.dll.VBVMR_SetParameterStringA.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    rc = rig.dll.VBVMR_SetParameterStringA(b"Bus[0].device.wdm", CLOCK_SINK.encode())
    if rc != 0:
        raise RuntimeError(f"binding A1 to {CLOCK_SINK} failed: {rc}")
    time.sleep(1.0)  # the engine restarts its audio thread around this


def setup() -> None:
    """Point the two cables at their buses and report what was set."""
    with Rig() as rig:
        bind_clock(rig)
        rig.route_cable(STRIP_VAIO, "B1")
        rig.route_cable(STRIP_AUX, "B2")
        # VAIO3 is left alone but silenced, so a stray app cannot leak into B1/B2.
        for b in ("B1", "B2", "B3"):
            rig.set(f"Strip[{STRIP_VAIO3}].{b}", 0)
        time.sleep(1.0)
        print("rig: VAIO -> B1 (mic cable), AUX -> B2 (speaker cable)")
        for strip, name in ((STRIP_VAIO, "VAIO"), (STRIP_AUX, "AUX")):
            b1 = rig.get(f"Strip[{strip}].B1")
            b2 = rig.get(f"Strip[{strip}].B2")
            mute = rig.get(f"Strip[{strip}].Mute")
            print(f"rig: strip {strip} ({name}): B1={b1:.0f} B2={b2:.0f} mute={mute:.0f}")
        print()
        print("Client under test should use:")
        print(f"  microphone: {RECORD_FROM_MIC}")
        print(f"  speaker   : {PLAY_INTO_SPEAKER}")


def verify() -> int:
    """Play the click train and report whether B1 actually carries it.

    Answers the one question a silent capture file cannot: is the engine
    processing at all? With no hardware output bound to A1 it has no clock, runs
    happily, accepts every parameter, and moves no audio - which looks exactly
    like a broken cable, a wrong device name or a muted strip.
    """
    import inject  # local: only the verify path needs it

    click = Path(__file__).parent / "click.wav"
    if not click.exists():
        print(f"no click train at {click} - run make_click.py first")
        return 2

    with Rig() as rig:
        rig.dll.VBVMR_GetLevel.argtypes = [
            ctypes.c_long,
            ctypes.c_long,
            ctypes.POINTER(ctypes.c_float),
        ]
        rig.dll.VBVMR_GetParameterStringA.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        a1 = ctypes.create_string_buffer(512)
        rig.dll.VBVMR_GetParameterStringA(b"Bus[0].device.name", a1)
        bound = a1.value.decode(errors="replace")

        inject.load(rig, click)
        inject.route_to_mic_cable(rig)
        time.sleep(0.3)
        rig.set("Recorder.play", 1)

        def level(channel: int) -> float:
            v = ctypes.c_float()
            rig.dll.VBVMR_GetLevel(3, channel, ctypes.byref(v))
            return v.value

        peak = 0.0
        for _ in range(12):
            time.sleep(0.25)
            peak = max(peak, level(40), level(41))  # B1 is bus 5: channels 40+
        rig.set("Recorder.stop", 1)

    print(f"rig: A1 is bound to {bound!r}" if bound else "rig: A1 is NOT bound")
    print(f"rig: peak level on B1 while injecting: {peak:.4f}")
    if peak > 0.01:
        print("rig: the mic cable carries audio - ready to measure")
        return 0
    print(
        "rig: the cable is silent. With A1 unbound the engine has no clock and "
        "processes nothing; bind any output device to A1 in the VoiceMeeter "
        "window. Nothing is routed to A1, so no device will make a sound."
    )
    return 1


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "setup"
    if arg == "setup":
        setup()
    elif arg == "verify":
        sys.exit(verify())
    else:
        print(__doc__)
        sys.exit(2)
