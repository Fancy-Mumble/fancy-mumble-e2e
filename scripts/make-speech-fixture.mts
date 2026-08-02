/**
 * Obtain the speech fixture the voice-fidelity e2e feeds into the client.
 *
 * # Why real recorded speech, and not a tone or a synthesiser
 *
 * A tone cannot exercise Opus's SILK path, discontinuous transmission, a noise
 * gate's behaviour on onsets, or a denoiser on its design target
 * (`vendor/client/.../virtual_mic.rs` has the long version). So the fixture has
 * to be speech.
 *
 * It is a **real human recording** rather than text-to-speech, for two reasons
 * that both turned out to matter:
 *
 * * Synthesised speech is unnaturally clean — absolute digital silence between
 *   sentences, no breath, no room tone. A denoiser and a noise gate are built
 *   for the opposite of that, so judging them on TTS flatters them.
 * * A recording committed to the repository is byte-identical everywhere,
 *   which is what makes a *threshold* meaningful. Locally synthesised audio
 *   differs per machine (a different installed voice), so any absolute figure
 *   has to be loose enough to survive the variation.
 *
 * # Provenance and licence
 *
 * The Open Speech Repository's Harvard sentences — recorded by Telchemy
 * specifically for VoIP and speech-codec testing, which is exactly this use.
 * Their conditions: *"freely available for use in VoIP testing, research,
 * development... may be copied, downloaded, broadcast, modified, incorporated
 * into web sites or test equipment. We do require that you identify the source
 * of the speech materials as 'Open Speech Repository'."* — recorded in
 * `fixtures/audio/README.md`, which is the attribution that condition asks for.
 *
 * It is **8 kHz telephone band**, which is the one thing it is not ideal for:
 * nothing above 4 kHz, so Opus's fullband path is under-exercised. In exchange
 * the virtual mic declares it at 8 kHz and the pipeline's own `StreamResampler`
 * does a 6× upsample to 48 kHz — the resampling contract gets driven hard by
 * the same fixture. Wideband tone coverage already exists in
 * `audio.resample.test.ts`.
 *
 * # Order of preference
 *
 * 1. Whatever is already at the fixture path — including a file of your own,
 *    via `E2E_SPEECH_FIXTURE`.
 * 2. Downloaded from the Open Speech Repository.
 * 3. Synthesised locally, so an offline machine is not simply stuck. Marked in
 *    the log, because it is the weaker fixture and a surprising result should
 *    not be blamed on the pipeline before it is blamed on this.
 *
 * Usage:
 *   node --import tsx scripts/make-speech-fixture.mts [outPath]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One of the Open Speech Repository's American-English Harvard-sentence sets:
 * ten phonetically balanced sentences read by one speaker, about 34 seconds.
 */
const OSR_URL =
  process.env.E2E_SPEECH_URL ??
  "https://www.voiptroubleshooter.com/open_speech/american/OSR_us_000_0010_8k.wav";

/** The rate the recording is at, and what the mic spec must declare. */
export const FIXTURE_RATE = 8_000;

/**
 * Phonetically varied enough to be worth speaking, if it comes to synthesis:
 * plosives, fricatives, nasals and a spread of vowels, with sentence breaks for
 * the pauses that exercise discontinuous transmission.
 */
const SCRIPT_TEXT = [
  "The quick brown fox jumps over the lazy dog.",
  "Pack my box with five dozen liquor jugs.",
  "She sells sea shells by the sea shore.",
].join(" ");

export function fixturePath(): string {
  return process.env.E2E_SPEECH_FIXTURE ?? path.join(repoRoot, "fixtures", "audio", "speech.wav");
}

/** Enough bytes to be audio rather than an error page saved to disk. */
function looksLikeAudio(file: string): boolean {
  return existsSync(file) && statSync(file).size > 16 * 1024;
}

/**
 * Produce the fixture if it is not already there.
 *
 * Idempotent, so a test's `before` hook can call it unconditionally.
 */
export function ensureSpeechFixture(): string {
  const out = fixturePath();
  if (looksLikeAudio(out)) return out;

  mkdirSync(path.dirname(out), { recursive: true });
  const errors: string[] = [];

  try {
    download(OSR_URL, out);
    if (looksLikeAudio(out)) {
      writeAttribution(path.dirname(out));
      return out;
    }
    errors.push("download: produced nothing usable");
  } catch (error) {
    errors.push(`download: ${(error as Error).message.split("\n")[0]}`);
  }

  for (const attempt of [synthWindows, synthEspeak, synthMac]) {
    try {
      attempt(out);
      if (looksLikeAudio(out)) {
        console.warn(
          `speech fixture: fell back to synthesised speech (${attempt.name}). It is cleaner ` +
            `than a real recording — no room tone, absolute silence between sentences — so a ` +
            `denoiser or gate result from this run is weaker evidence than usual.`,
        );
        return out;
      }
      errors.push(`${attempt.name}: produced nothing`);
    } catch (error) {
      errors.push(`${attempt.name}: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  throw new Error(
    `could not obtain a speech fixture at ${out}. Tried:\n  ${errors.join("\n  ")}\n` +
      `Point E2E_SPEECH_FIXTURE at a mono WAV of your own, or fetch ${OSR_URL} by hand.`,
  );
}

/** Fetch over HTTPS with curl, which every platform running this suite has. */
function download(url: string, out: string): void {
  execFileSync("curl", ["-sSfL", "--max-time", "120", "-o", out, url], {
    stdio: "pipe",
    timeout: 180_000,
  });
}

/** The attribution the Open Speech Repository's terms require. */
function writeAttribution(dir: string): void {
  writeFileSync(
    path.join(dir, "README.md"),
    [
      "# Speech fixture",
      "",
      "`speech.wav` is one of the **Open Speech Repository**'s American-English",
      "Harvard-sentence recordings, fetched by `scripts/make-speech-fixture.mts`",
      "from:",
      "",
      `    ${OSR_URL}`,
      "",
      "## Attribution",
      "",
      "Source of the speech materials: **Open Speech Repository**",
      "(<https://www.voiptroubleshooter.com/open_speech/>), developed by Telchemy.",
      "",
      "Their conditions of use: the material is freely available for use in VoIP",
      "testing, research, development, marketing and any other reasonable",
      "application, and may be copied, downloaded, broadcast, modified or",
      "incorporated into web sites or test equipment. The only requirement is that",
      "the source is identified as the Open Speech Repository — which is what this",
      "file is for.",
      "",
      "## Why this recording",
      "",
      "Harvard sentences are phonetically balanced and were recorded for exactly",
      "this purpose: measuring what a speech codec does to speech. It is 8 kHz",
      "telephone band, so the virtual mic declares `file:<path>:8000` and the",
      "client's own resampler takes it to 48 kHz — which drives the resampling",
      "path with the same fixture.",
      "",
      "Regenerate (or replace with your own mono WAV) with:",
      "",
      "    node --import tsx scripts/make-speech-fixture.mts",
      "",
    ].join("\n"),
  );
}

/** Windows SAPI, via the .NET speech synthesiser. */
function synthWindows(out: string): void {
  const ps = `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${FIXTURE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $s.SetOutputToWaveFile(${JSON.stringify(out)}, $fmt)
    $s.Rate = -1
    $s.Speak(${JSON.stringify(SCRIPT_TEXT)})
    $s.Dispose()
  `;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: "pipe",
    timeout: 60_000,
  });
}

/** espeak-ng, the usual Linux/CI route. */
function synthEspeak(out: string): void {
  execFileSync("espeak-ng", ["-w", out, "-s", "150", SCRIPT_TEXT], {
    stdio: "pipe",
    timeout: 60_000,
  });
}

/** macOS `say`, which writes AIFF, then `afconvert` to WAV. */
function synthMac(out: string): void {
  const aiff = `${out}.aiff`;
  execFileSync("say", ["-o", aiff, SCRIPT_TEXT], { stdio: "pipe", timeout: 60_000 });
  execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${FIXTURE_RATE}`, "-c", "1", aiff, out], {
    stdio: "pipe",
    timeout: 60_000,
  });
}

// Run directly: `node --import tsx scripts/make-speech-fixture.mts`
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const written = ensureSpeechFixture();
  console.log(`speech fixture: ${written} (${statSync(written).size} bytes)`);
}
