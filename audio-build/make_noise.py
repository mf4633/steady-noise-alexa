"""Generate seamlessly looping white, pink, and brown noise MP3s.

Usage:  python audio-build/make_noise.py [--seconds 3600] [--out audio]

Each file is built so its last sample flows into its first: the stream is
generated as s[0 .. N+F), the file is s[F .. N+F), and the file's final F
samples are equal-power crossfaded into the stored s[0 .. F). When Alexa
replays the file back to back, the join is just more noise rather than a
click. (MP3 encoder padding can still leave a few ms of gap at the device;
long files keep that to once an hour.)

Spectra:
  white  flat, Gaussian
  pink   -3 dB/octave, Robert Bristow-Johnson's 3-pole/3-zero IIR
         approximation (within +/-0.3 dB from ~10 Hz to Nyquist at 44.1 kHz)
  brown  -6 dB/octave, leaky integrator (pole 0.9995, corner ~3.5 Hz) so it
         cannot wander off to DC

All three are normalized to the same RMS (-20 dBFS), so switching colors
does not jump in loudness more than the spectral shape itself implies.
"""
import argparse
import os
import subprocess
import sys

import numpy as np
from scipy.signal import lfilter, lfilter_zi

FS = 44100
CHUNK = FS * 10          # 10 s blocks
XFADE = FS * 5           # 5 s loop crossfade
WARMUP = FS * 3          # let the filters settle before sample 0
TARGET_RMS_DB = -20.0

FILTERS = {
    "white": None,
    "pink": (np.array([0.049922035, -0.095993537, 0.050612699, -0.004408786]),
             np.array([1.0, -2.494956002, 2.017265875, -0.522189400])),
    "brown": (np.array([1.0]), np.array([1.0, -0.9995])),
}


class Source:
    """Endless, filtered, unit-RMS noise, produced in blocks."""

    def __init__(self, color, seed):
        self.rng = np.random.default_rng(seed)
        self.filt = FILTERS[color]
        self.zi = None
        if self.filt is not None:
            b, a = self.filt
            self.zi = lfilter_zi(b, a) * 0.0
        self.gain = 1.0
        self.read(WARMUP)                       # discard filter start-up
        probe = self.read(FS * 30)              # 30 s to measure RMS
        self.gain = 1.0 / np.sqrt(np.mean(probe ** 2))

    def read(self, n):
        x = self.rng.standard_normal(n)
        if self.filt is not None:
            b, a = self.filt
            x, self.zi = lfilter(b, a, x, zi=self.zi)
        return x * self.gain


def build(color, seconds, out_dir, bitrate):
    n = int(seconds * FS)
    src = Source(color, seed={"white": 1, "pink": 2, "brown": 3}[color])
    scale = 10 ** (TARGET_RMS_DB / 20.0)
    head = src.read(XFADE) * scale              # s[0 .. F)

    path = os.path.join(out_dir, f"{color}.mp3")
    enc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "s16le", "-ar", str(FS), "-ac", "1", "-i", "pipe:0",
         "-c:a", "libmp3lame", "-b:a", bitrate,
         "-metadata", f"title={color.capitalize()} noise",
         "-metadata", "artist=Steady Noise", path],
        stdin=subprocess.PIPE)

    t = np.arange(XFADE) / XFADE
    fade_out = np.cos(t * np.pi / 2)
    fade_in = np.sin(t * np.pi / 2)

    written = 0
    peak = 0.0
    while written < n:
        m = min(CHUNK, n - written)
        block = src.read(m) * scale             # s[F+written .. F+written+m)
        # Crossfade region: output index k in [n-F, n) pairs with head[k-(n-F)]
        lo = max(written, n - XFADE)
        if lo < written + m:
            i0, i1 = lo - written, m
            h0 = lo - (n - XFADE)
            h1 = h0 + (i1 - i0)
            block[i0:i1] = block[i0:i1] * fade_out[h0:h1] + head[h0:h1] * fade_in[h0:h1]
        peak = max(peak, float(np.max(np.abs(block))))
        pcm = np.clip(block, -0.98, 0.98)
        enc.stdin.write((pcm * 32767).astype("<i2").tobytes())
        written += m
    enc.stdin.close()
    if enc.wait() != 0:
        sys.exit(f"ffmpeg failed for {color}")
    size = os.path.getsize(path) / 1e6
    print(f"{color:6s} {seconds:6.0f} s  peak {20*np.log10(peak):6.1f} dBFS  {size:6.1f} MB  {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=3600)
    ap.add_argument("--out", default="docs/audio")
    ap.add_argument("--bitrate", default="96k")
    ap.add_argument("--colors", default="white,pink,brown")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for c in args.colors.split(","):
        build(c, args.seconds, args.out, args.bitrate)


if __name__ == "__main__":
    main()
