# Speech fixture

`speech.wav` is one of the **Open Speech Repository**'s American-English
Harvard-sentence recordings, fetched by `scripts/make-speech-fixture.mts`
from:

    https://www.voiptroubleshooter.com/open_speech/american/OSR_us_000_0010_8k.wav

## Attribution

Source of the speech materials: **Open Speech Repository**
(<https://www.voiptroubleshooter.com/open_speech/>), developed by Telchemy.

Their conditions of use: the material is freely available for use in VoIP
testing, research, development, marketing and any other reasonable
application, and may be copied, downloaded, broadcast, modified or
incorporated into web sites or test equipment. The only requirement is that
the source is identified as the Open Speech Repository — which is what this
file is for.

## Why this recording

Harvard sentences are phonetically balanced and were recorded for exactly
this purpose: measuring what a speech codec does to speech. It is 8 kHz
telephone band, so the virtual mic declares `file:<path>:8000` and the
client's own resampler takes it to 48 kHz — which drives the resampling
path with the same fixture.

Regenerate (or replace with your own mono WAV) with:

    node --import tsx scripts/make-speech-fixture.mts
