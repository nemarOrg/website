"""Reference activity metrics for the on006136 level-0 slice, computed with SciPy and NumPy.

Run from this directory:
  uv run --no-project --with scipy --with numpy python reference.py
Reads the raw little-endian float32 slice (channels x samples, volts) and writes
reference.json (values in microvolts). Independent of the TypeScript module it checks.
"""

import json

import numpy as np
from scipy.signal import welch

RATE = 1000.0
N_CHANNELS = 14
SLICE = "on006136_sub-P5_ieeg_1000hz_300s_2s.f32le"
BANDS = {
    "delta": (1.0, 4.0),
    "theta": (4.0, 8.0),
    "alpha": (8.0, 13.0),
    "beta": (13.0, 30.0),
    "low_gamma": (30.0, 70.0),
    "high_gamma": (70.0, 150.0),
}

raw = np.fromfile(SLICE, dtype="<f4").astype(np.float64).reshape(N_CHANNELS, -1)
x_uv = raw * 1e6  # volts to microvolts

out = {"unit": "uV", "rate_hz": RATE, "n_samples": int(x_uv.shape[1]), "channels": []}
for row in x_uv:
    f, psd = welch(
        row, fs=RATE, window="hann", nperseg=1024, noverlap=512,
        detrend="constant", scaling="density", return_onesided=True,
    )
    df = f[1] - f[0]
    band_power = {
        name: float(np.sum(psd[(f >= lo) & (f < hi)]) * df) for name, (lo, hi) in BANDS.items()
    }
    broadband = float(np.sum(psd[(f >= 1.0) & (f < 150.0)]) * df)
    centered = row - row.mean()
    out["channels"].append(
        {
            "rms": float(np.sqrt(np.mean(centered**2))),
            "line_length": float(np.mean(np.abs(np.diff(row))) * RATE),
            "band_power": band_power,
            "broadband_1_150": broadband,
        }
    )

with open("reference.json", "w") as fh:
    json.dump(out, fh, indent=1)
print("wrote reference.json")
