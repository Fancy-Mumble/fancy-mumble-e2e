import type { Signal } from "./audio-fidelity";

/**
 * Does the playout path modulate what it plays?
 *
 * # Why this exists
 *
 * The 5 ms mix chunk shipped on a derivation - "it cuts 7.5 ms of playout
 * delay" - and was reverted after somebody *heard* it. The whole suite passed
 * it unchanged, and it could not have done otherwise: `voice-fidelity` scores a
 * short-term energy envelope, which is deaf to anything that leaves the rhythm
 * of speech intact, and it reads the *decoded* tap, which sits before the
 * playout ramps that were the actual fault. There was no oracle. This is one.
 *
 * # The mechanism it detects
 *
 * The mixer refills its output in chunks, and the underrun back-off and resume
 * ramp are absolute sample counts. Make the chunk small enough and a ramp
 * covers all of it: the gain never reaches unity between refills, so playout is
 * multiplied by a gain that repeats once per chunk. A periodic gain is
 * amplitude modulation, and amplitude modulation of a voice is heard as a
 * metallic ring.
 *
 * Modulation is not a subtle thing to look for if you know its period, and the
 * period is not a guess: it is the mix chunk, which the code chooses. A gain
 * repeating at `f = 1000 / chunkMs` Hz puts sidebands on every component of the
 * signal at `±f`. Against the latency rig's steady 440 Hz carrier those land in
 * otherwise empty spectrum - 440 Hz modulated at 200 Hz rings at 240 and
 * 640 Hz, which is not a harmonic of anything present and cannot arrive by
 * accident.
 *
 * # Reading the number
 *
 * `sidebandDb` is the louder sideband relative to the carrier. Clean playout
 * leaves the carrier alone and this sits in the noise floor; a chunk small
 * enough to ring lifts it tens of dB. `modulationDepth` is the same fault seen
 * in the time domain - the peak-to-peak swing of the carrier's own amplitude at
 * the chunk rate, as a fraction of its mean - and is the more intuitive of the
 * two, but it is the weaker detector because envelope estimation smears a fast
 * modulation. Both are reported; the assertion is on the sideband.
 *
 * # What it is not
 *
 * It does not judge speech. It needs a steady tone to modulate, which is what
 * the latency rig's carrier is for, and it says nothing about a fault that is
 * not periodic at the chunk rate. It is a detector for one mechanism, aimed at
 * the one that got through.
 */

/**
 * Burst energy, relative to the carrier, that disqualifies a window.
 *
 * Goertzel normalises by window length, so a 5 ms burst inside a 160 ms window
 * shows about 3% of its own amplitude - a few percent of the carrier, not a few
 * tenths. A threshold set by eye at "obviously loud" would therefore reject
 * nothing at all.
 */
const BURST_RATIO = 0.02;

/**
 * Hann coefficients for a window of `len`, cached: every measurement uses the
 * same length and recomputing a cosine per sample per frequency dominates the
 * run time otherwise.
 */
const hannCache = new Map<number, Float64Array>();
function hann(len: number): Float64Array {
  let w = hannCache.get(len);
  if (!w) {
    w = new Float64Array(len);
    for (let i = 0; i < len; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    hannCache.set(len, w);
  }
  return w;
}

/**
 * One Goertzel magnitude for `freq` over `[from, from+len)`, Hann-windowed.
 *
 * The window is not a refinement, it is the whole measurement. A rectangular
 * window leaks a strong carrier across the entire spectrum with a skirt that
 * decays as 1/f, and at the offsets this looks at that leakage is around
 * -43 dB - far louder than the sidebands being hunted, so every recording would
 * report the same floor and nothing else. Hann's skirt falls off three orders
 * faster and puts the floor below anything the client can produce.
 *
 * Scaled by 2/sum(w) so a full-amplitude sine still reads its own amplitude,
 * which keeps the sideband-to-carrier ratios - and therefore the modulation
 * depth - independent of window length.
 */
function goertzel(samples: Float32Array, from: number, len: number, freq: number, rate: number) {
  const w = hann(len);
  const k = (2 * Math.PI * freq) / rate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  let norm = 0;
  for (let i = 0; i < len; i++) {
    const s0 = samples[from + i]! * w[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
    norm += w[i]!;
  }
  return (Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) * 2) / norm;
}

export interface Modulation {
  /** Louder of the two sidebands, in dB relative to the carrier. */
  sidebandDb: number;
  /** Lower sideband alone, dB relative to carrier. */
  lowerDb: number;
  /** Upper sideband alone, dB relative to carrier. */
  upperDb: number;
  /**
   * Median over control frequencies that no mechanism should excite, in dB
   * relative to the carrier.
   *
   * This is the noise floor of the measurement itself, measured on the same
   * recording rather than assumed. A `sidebandDb` that is not clearly above it
   * is not evidence of anything.
   */
  floorDb: number;
  /** Carrier amplitude swing at the chunk rate, as a fraction of its mean. */
  modulationDepth: number;
  /** Carrier magnitude, so a recording with no carrier can be rejected. */
  carrier: number;
  /** Seconds of audio the measurement ran over. */
  analysedSeconds: number;
}

/**
 * Measure gain modulation at the mix-chunk rate against a steady carrier.
 *
 * `signal` should be playout containing the rig's continuous carrier. Windows
 * that do not contain it - silence before the stream starts, or a gap - are
 * skipped, so a recording that is half empty still measures the half that is
 * not.
 */
export function chunkModulation(
  signal: Signal,
  opts: { carrierHz: number; chunkMs: number; burstHz?: number },
): Modulation {
  const { samples, rate } = signal;
  const { carrierHz, chunkMs, burstHz } = opts;
  const modHz = 1000 / chunkMs;

  // A window long enough to resolve the carrier from its sidebands: they are
  // `modHz` apart, and Goertzel's resolution is 1/window. 8 cycles of the
  // modulation gives a bin width well inside the gap at every chunk size this
  // is used on, and still short enough that many windows fit in a recording.
  const win = Math.round((rate * 8) / modHz);
  const hop = Math.round(win / 2);

  // Control frequencies: the local noise just *outside* each sideband.
  //
  // The floor has to be measured somewhere the modulation cannot reach but
  // whose noise is the same noise the sideband sits in, and it has to be the
  // same geometry for every chunk size or two runs are not comparable. An
  // earlier version placed these at fixed multiples of `modHz` from the
  // carrier, which put the 20 ms probes at 320-610 Hz - the middle of the
  // speech band, where the denoiser and Opus leave real energy - and the 5 ms
  // probes at 960-1130 Hz, which is quiet. The floors that came back differed
  // by 22 dB for that reason alone, and a comparison between configurations
  // was measuring where it had looked rather than what was there.
  //
  // So: probe just beyond each sideband, at non-integer multiples of `modHz`
  // (nothing periodic can land on them) and at the same *relative* offsets
  // whatever the chunk size, which keeps the two runs on equal terms.
  const controls = [1.35, 1.65]
    .flatMap((k) => [carrierHz - modHz * k, carrierHz + modHz * k])
    .filter((f) => f > 20 && f < rate / 2);

  const carrierMags: number[] = [];
  const lower: number[] = [];
  const upper: number[] = [];
  const floors: number[] = [];

  let burstWindows = 0;
  for (let at = 0; at + win <= samples.length; at += hop) {
    const c = goertzel(samples, at, win, carrierHz, rate);
    // No carrier here: nothing to measure modulation of, and including it
    // would divide sideband energy by roughly zero.
    if (c < 1e-4) continue;

    // A click is broadband: it lands on the sidebands and on the control
    // frequencies alike, which does not bias the comparison but does bury it -
    // both rise together and the modulation stops standing out of its own
    // floor. Windows holding one are dropped rather than tolerated, which is
    // what buys the detector the sensitivity to see a few percent of swing.
    if (burstHz !== undefined && goertzel(samples, at, win, burstHz, rate) > c * BURST_RATIO) {
      burstWindows += 1;
      continue;
    }

    carrierMags.push(c);
    lower.push(goertzel(samples, at, win, carrierHz - modHz, rate) / c);
    upper.push(goertzel(samples, at, win, carrierHz + modHz, rate) / c);
    for (const f of controls) floors.push(goertzel(samples, at, win, f, rate) / c);
  }

  if (carrierMags.length === 0) {
    return {
      sidebandDb: -Infinity,
      lowerDb: -Infinity,
      upperDb: -Infinity,
      floorDb: -Infinity,
      modulationDepth: 0,
      carrier: 0,
      analysedSeconds: 0,
    };
  }

  // Median rather than mean throughout: the click bursts are broadband and
  // land in every bin, and a handful of them must not set the result. They are
  // 5 ms every 250 ms, so they can never be the median of anything.
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };

  const lowerRatio = med(lower);
  const upperRatio = med(upper);
  const db = (r: number) => 20 * Math.log10(Math.max(r, 1e-12));

  const meanCarrier = carrierMags.reduce((a, b) => a + b, 0) / carrierMags.length;

  // The same fault stated as a gain swing. For a carrier multiplied by
  // `1 + (m/2)·cos(2π·modHz·t)` each sideband stands at `m/4` of the carrier,
  // so the peak-to-peak swing is four times the sideband ratio. Derived from
  // the sidebands rather than measured separately: an envelope estimator fast
  // enough to see a 200 Hz modulation is also wide enough to be dominated by
  // the click bursts, and this arithmetic is exact for the shape being looked
  // for.
  const modulationDepth = 4 * Math.max(lowerRatio, upperRatio);

  return {
    sidebandDb: Math.max(db(lowerRatio), db(upperRatio)),
    lowerDb: db(lowerRatio),
    upperDb: db(upperRatio),
    floorDb: db(med(floors)),
    modulationDepth,
    carrier: meanCarrier,
    analysedSeconds: (carrierMags.length * hop) / rate,
  };
}

/**
 * Periodic gain modulation measured on the signal's own envelope.
 *
 * [`chunkModulation`] needs a steady carrier to put sidebands on, which the
 * latency rig provides - and which, it turns out, also prevents the fault it
 * was built to find. The ring appears *at talkspurt onset*: it is the resume
 * ramp failing to reach unity on a shallow buffer, so it needs a buffer that
 * keeps re-priming, which needs speech that stops and starts. A continuous
 * carrier holds the noise gate open and the buffer full, and nothing rings.
 *
 * So this measures the same mechanism on a signal that has onsets. A gain
 * `g(t)` multiplying speech `s(t)` leaves `|g(t)·s(t)| ≈ g(t)·|s(t)|`, so the
 * modulation appears as a periodic component of the *envelope*, whatever the
 * speech underneath is doing. Speech's own envelope lives below about 20 Hz,
 * so a peak at 50 or 200 Hz cannot be the talker.
 */
export interface EnvelopeModulation {
  /** Envelope energy at the chunk rate, dB relative to the envelope's mean. */
  atChunkDb: number;
  /** Median of non-harmonic neighbours, same units: the local floor. */
  floorDb: number;
  /** How far the chunk rate stands above that floor. */
  overFloorDb: number;
  /** Fraction of the signal loud enough to have been measured. */
  activeFraction: number;
  /** Seconds actually analysed. */
  analysedSeconds: number;
}

export function envelopeModulation(
  signal: Signal,
  opts: { chunkMs: number; onsetOnly?: boolean },
): EnvelopeModulation {
  const { samples, rate } = signal;
  const modHz = 1000 / opts.chunkMs;

  // Rectify to get the envelope. No smoothing: a low-pass here would attenuate
  // exactly the band being measured.
  const env = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) env[i] = Math.abs(samples[i]!);

  // 16 cycles of the modulation: enough resolution to separate it from its
  // neighbours, short enough that a window sits inside one talkspurt.
  const win = Math.round((rate * 16) / modHz);
  const hop = Math.round(win / 2);

  // Windows quiet enough to be silence carry no gain to modulate, and their
  // envelope is dominated by whatever the noise floor is doing.
  let loudest = 0;
  for (let i = 0; i < env.length; i++) if (env[i]! > loudest) loudest = env[i]!;
  const active = loudest * 0.05;

  const probes = [1, 0.62, 0.78, 1.31, 1.57].map((k) => modHz * k);
  const mags: number[][] = probes.map(() => []);
  let windows = 0;
  let considered = 0;

  for (let at = 0; at + win <= env.length; at += hop) {
    considered += 1;
    let sum = 0;
    for (let i = at; i < at + win; i++) sum += env[i]!;
    const mean = sum / win;
    if (mean < active) continue;

    // Onset windows only, when asked: the ring is a start-of-talkspurt fault,
    // and averaging it with steady speech dilutes it away.
    if (opts.onsetOnly === true) {
      let before = 0;
      const from = Math.max(0, at - win);
      for (let i = from; i < at; i++) before += env[i]!;
      const prev = at > from ? before / (at - from) : 0;
      if (!(prev < active && mean >= active)) continue;
    }

    windows += 1;
    probes.forEach((f, i) => mags[i]!.push(goertzel(env, at, win, f, rate) / mean));
  }

  if (windows === 0) {
    return {
      atChunkDb: -Infinity,
      floorDb: -Infinity,
      overFloorDb: 0,
      activeFraction: 0,
      analysedSeconds: 0,
    };
  }

  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const db = (r: number) => 20 * Math.log10(Math.max(r, 1e-12));
  const atChunkDb = db(med(mags[0]!));
  const floorDb = db(med(mags.slice(1).flat()));

  return {
    atChunkDb,
    floorDb,
    overFloorDb: atChunkDb - floorDb,
    activeFraction: windows / Math.max(1, considered),
    analysedSeconds: (windows * hop) / rate,
  };
}
