"""Generate seamlessly looping noise and ambience MP3s (white, pink, brown, rain, ocean, fan).

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

  rain   high-passed pink bed + Poisson drops (see Rain)
  ocean  brown/pink surf with 7-13 s wave envelopes (see Ocean)
  fan    low-passed air noise, 120 Hz hum, blade flutter (see Fan)

All are synthesized (no recordings, nothing licensed) and normalized to the same RMS (-20 dBFS), so switching colors
does not jump in loudness more than the spectral shape itself implies.
"""
import argparse
import os
import subprocess
import sys

import numpy as np
from scipy.signal import butter, lfilter, lfilter_zi

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


class Filt:
    """Stateful IIR filter, so block boundaries are seamless."""

    def __init__(self, b, a):
        self.b, self.a = np.asarray(b, float), np.asarray(a, float)
        self.zi = lfilter_zi(self.b, self.a) * 0.0

    def __call__(self, x):
        y, self.zi = lfilter(self.b, self.a, x, zi=self.zi)
        return y


class Noise:
    """Endless colored noise (unnormalized), produced in blocks."""

    def __init__(self, color, rng):
        self.rng = rng
        self.f = Filt(*FILTERS[color]) if FILTERS.get(color) else None

    def read(self, n):
        x = self.rng.standard_normal(n)
        return self.f(x) if self.f else x


class Rain:
    """Steady rain: high-passed pink hiss plus a Poisson shower of drops.

    Each drop is a short burst of band-passed noise (1.5-6 kHz) with a fast
    exponential decay; ~300 drops/s at random levels blur into the patter.
    """

    DROPS_PER_S = 300
    DROP_LEN = int(0.012 * FS)

    def __init__(self, rng):
        self.rng = rng
        self.bed = Noise("pink", rng)
        self.hp = Filt(*butter(2, 150 / (FS / 2), "high"))
        self.drop_bp = Filt(*butter(2, [1500 / (FS / 2), 6000 / (FS / 2)], "band"))
        self.tail = np.zeros(self.DROP_LEN)     # drop energy spilling into the next block
        self.env = np.exp(-np.arange(self.DROP_LEN) / (0.0025 * FS))

    def read(self, n):
        bed = self.hp(self.bed.read(n))
        imp = np.zeros(n + self.DROP_LEN)
        k = self.rng.poisson(self.DROPS_PER_S * n / FS)
        pos = self.rng.integers(0, n, k)
        np.add.at(imp, pos, self.rng.lognormal(0.0, 0.6, k))
        drops = np.convolve(imp, self.env)[: n + self.DROP_LEN]
        drops[: self.DROP_LEN] += self.tail
        self.tail = drops[n: n + self.DROP_LEN].copy()
        burst = self.drop_bp(drops[:n] * self.rng.standard_normal(n))
        return bed / 0.2 + 0.8 * burst / 0.35


class Ocean:
    """Surf: brown/pink noise swelling and receding every 7-13 s.

    Each wave's envelope rises over ~40% of its period and falls over the
    rest; the brightness follows the envelope (a crash is brighter than the
    draw-back), done by mixing a brown bed with a pink layer.
    """

    def __init__(self, rng):
        self.rng = rng
        self.brown = Noise("brown", rng)
        self.pink = Noise("pink", rng)
        self.lp = Filt(*butter(1, 2500 / (FS / 2), "low"))
        self.queue = np.zeros(0)                # envelope samples not yet used

    def _wave(self):
        period = self.rng.uniform(7.0, 13.0)
        peak = self.rng.uniform(0.6, 1.0)
        n = int(period * FS)
        rise = int(n * self.rng.uniform(0.3, 0.45))
        t1 = np.linspace(0, 1, rise, endpoint=False)
        t2 = np.linspace(0, 1, n - rise, endpoint=False)
        up = np.sin(t1 * np.pi / 2) ** 2
        down = np.cos(t2 * np.pi / 2) ** 1.5
        return 0.18 + peak * np.concatenate([up, down])

    def read(self, n):
        while len(self.queue) < n:
            self.queue = np.concatenate([self.queue, self._wave()])
        env, self.queue = self.queue[:n], self.queue[n:]
        b = self.brown.read(n) / 30.0
        p = self.lp(self.pink.read(n)) / 0.25
        return env * (0.7 * b + 0.6 * env * p)


class Fan:
    """Box fan: low-passed brown/pink air noise, a faint motor hum, and a
    gentle blade-rate flutter. Phases carry across blocks."""

    def __init__(self, rng):
        self.rng = rng
        self.air = Noise("pink", rng)
        self.lp = Filt(*butter(2, 1800 / (FS / 2), "low"))
        self.rumble = Noise("brown", rng)
        self.t = 0                              # sample clock for the hum and flutter

    def read(self, n):
        t = (self.t + np.arange(n)) / FS
        self.t += n
        air = self.lp(self.air.read(n)) / 0.2
        rum = self.rumble.read(n) / 30.0
        hum = 0.04 * np.sin(2 * np.pi * 120 * t) + 0.02 * np.sin(2 * np.pi * 240 * t + 1.0)
        flutter = 1.0 + 0.06 * np.sin(2 * np.pi * 14.0 * t)   # ~3 blades at 280 rpm
        return flutter * (air + 0.6 * rum) + hum


SOUNDS = ["white", "pink", "brown", "rain", "ocean", "fan"]
SEEDS = {name: i + 1 for i, name in enumerate(SOUNDS)}


class Source:
    """Endless, unit-RMS sound of one kind, produced in blocks."""

    def __init__(self, name, seed):
        rng = np.random.default_rng(seed)
        self.gen = {"rain": Rain, "ocean": Ocean, "fan": Fan}.get(name)
        self.gen = self.gen(rng) if self.gen else Noise(name, rng)
        self.gain = 1.0
        self.soft = False
        self.read(WARMUP)                       # discard filter start-up
        probe = self.read(FS * 60)              # 60 s to measure RMS (covers several waves)
        self.gain = 1.0 / np.sqrt(np.mean(probe ** 2))
        self.soft = name == "rain"
        self.post = 1.0
        if self.soft:                           # re-level after the limiter
            probe = self.read(FS * 30)
            self.post = 1.0 / np.sqrt(np.mean(probe ** 2))

    def read(self, n):
        x = self.gen.read(n) * self.gain
        # Rain drops are spiky; a soft knee at 4x RMS (-8 dBFS after scaling)
        # keeps them from clipping. Gaussian noise almost never gets there.
        return 4.0 * np.tanh(x / 4.0) * self.post if self.soft else x


def build(color, seconds, out_dir, bitrate):
    n = int(seconds * FS)
    src = Source(color, seed=SEEDS[color])
    scale = 10 ** (TARGET_RMS_DB / 20.0)
    head = src.read(XFADE) * scale              # s[0 .. F)

    path = os.path.join(out_dir, f"{color}.mp3")
    enc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "s16le", "-ar", str(FS), "-ac", "1", "-i", "pipe:0",
         "-c:a", "libmp3lame", "-b:a", bitrate,
         "-metadata", f"title={color.capitalize()}",
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
    ap.add_argument("--colors", default=",".join(SOUNDS))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for c in args.colors.split(","):
        build(c, args.seconds, args.out, args.bitrate)


if __name__ == "__main__":
    main()
