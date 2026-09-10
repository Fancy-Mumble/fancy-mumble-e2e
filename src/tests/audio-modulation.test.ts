import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkModulation } from "../util/audio-modulation";

/**
 * The ringing detector, checked against modulation it was told to find.
 *
 * `voice-latency` asserts that playout is not modulated at the mix-chunk rate.
 * That assertion is only worth anything if the detector behind it would notice
 * when it is - and the reason this file exists is that the suite has been wrong
 * about exactly this once already: the 5 ms mix chunk rang audibly and every
 * test passed, because nothing was looking. An oracle nobody has seen fail is
 * in the same position.
 *
 * So: synthesise a carrier, multiply it by a gain that repeats at the chunk
 * rate, and check the number that comes back is the depth that went in. No
 * client, no server, no rig - if this fails, the detector is wrong, and that is
 * a different problem from the client being wrong.
 */

const RATE = 48_000;
const CARRIER_HZ = 440;
const SECONDS = 14;

/**
 * A carrier under a gain that swings `depth` peak-to-peak at `modHz`.
 *
 * The noise is not decoration: without it the control frequencies sit at
 * exactly zero, the floor reads -240 dB, and every comparison against it
 * succeeds for a reason that has nothing to do with the signal.
 */
function modulated(depth: number, modHz: number, noise = 0.001) {
  const n = RATE * SECONDS;
  const samples = new Float32Array(n);
  // A fixed sequence, so a failure is reproducible.
  let seed = 12_345;
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    return seed / 0x3fff_ffff - 1;
  };
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const gain = 1 + (depth / 2) * Math.cos(2 * Math.PI * modHz * t);
    samples[i] = 0.3 * gain * Math.sin(2 * Math.PI * CARRIER_HZ * t) + noise * rand();
  }
  return { samples, rate: RATE };
}

/** The click train the real recording carries, which must not be mistaken for a ring. */
function withClicks(signal: { samples: Float32Array; rate: number }) {
  const period = Math.round(RATE * 0.25);
  const burst = Math.round(RATE * 0.005);
  for (let at = period; at + burst < signal.samples.length; at += period) {
    for (let i = 0; i < burst; i++) {
      signal.samples[at + i]! += 0.5 * Math.sin((2 * Math.PI * 2_000 * i) / RATE);
    }
  }
  return signal;
}

describe("chunk-rate modulation detector", () => {
  for (const chunkMs of [20, 5]) {
    const modHz = 1000 / chunkMs;

    it(`reports a clean ${chunkMs} ms carrier as unmodulated`, () => {
      const m = chunkModulation(withClicks(modulated(0, modHz)), { carrierHz: CARRIER_HZ, chunkMs, burstHz: 2_000 });
      const overFloor = m.sidebandDb - m.floorDb;
      assert.ok(
        overFloor < 6,
        `an unmodulated carrier reported ${overFloor.toFixed(1)} dB of sideband over its own ` +
          `noise floor - the detector is finding modulation that is not there, and the ` +
          `assertion in voice-latency would fail a healthy build`,
      );
    });

    it(`recovers a known modulation depth at ${modHz} Hz`, () => {
      // 10% is well under the swing a ramp-covered chunk produces and already
      // audible as a ring, so a detector that resolves this resolves the fault.
      const m = chunkModulation(withClicks(modulated(0.1, modHz)), {
        carrierHz: CARRIER_HZ,
        chunkMs,
        burstHz: 2_000,
      });
      assert.ok(
        Math.abs(m.modulationDepth - 0.1) < 0.02,
        `10% modulation was reported as ${(m.modulationDepth * 100).toFixed(1)}% - the ` +
          `sideband-to-depth arithmetic is wrong`,
      );
      assert.ok(
        m.sidebandDb - m.floorDb > 12,
        `10% modulation stood only ${(m.sidebandDb - m.floorDb).toFixed(1)} dB over the floor, ` +
          `which is under the threshold voice-latency asserts on: real ringing would pass`,
      );
    });

    it(`separates a ringing ${chunkMs} ms chunk from a clean one`, () => {
      const clean = chunkModulation(withClicks(modulated(0, modHz)), {
        carrierHz: CARRIER_HZ,
        chunkMs,
        burstHz: 2_000,
      });
      // The swing a chunk fully covered by a resume ramp produces: the gain
      // never reaches unity, so it is tens of percent, not a few.
      const ringing = chunkModulation(withClicks(modulated(0.4, modHz)), {
        carrierHz: CARRIER_HZ,
        chunkMs,
        burstHz: 2_000,
      });
      assert.ok(
        ringing.sidebandDb - clean.sidebandDb > 20,
        `ringing and clean playout differ by only ` +
          `${(ringing.sidebandDb - clean.sidebandDb).toFixed(1)} dB - not a margin any ` +
          `threshold can sit inside`,
      );
    });
  }

  it("reports nothing rather than dividing by a carrier that is not there", () => {
    const silence = { samples: new Float32Array(RATE * 3), rate: RATE };
    const m = chunkModulation(silence, { carrierHz: CARRIER_HZ, chunkMs: 20 });
    assert.equal(m.analysedSeconds, 0);
    assert.equal(m.carrier, 0);
  });
});
