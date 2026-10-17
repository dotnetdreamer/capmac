"""Synthesize the films' interface sounds: a mouse click and a key press, quiet and short"""

from pathlib import Path
import wave

import numpy as np
from scipy.signal import butter, sosfilt


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "sfx"
RATE = 48000


def band(signal, low, high):
    return sosfilt(butter(4, [low, high], btype="bandpass", fs=RATE, output="sos"), signal)


def envelope(length, decay, attack=0.0004):
    t = np.arange(length) / RATE
    return np.minimum(1, t / attack) * np.exp(-t / decay)


def click(rng):
    """A trackpad-like tick: a bright transient over a short resonance"""
    length = int(0.03 * RATE)
    t = np.arange(length) / RATE
    tick = band(rng.normal(0, 1, length), 1800, 6500) * envelope(length, 0.0011)
    body = np.sin(2 * np.pi * 2300 * t) * envelope(length, 0.0035) * 0.35
    return tick + body


def key(rng):
    """A keyboard key going down and coming back up"""
    length = int(0.16 * RATE)
    sound = np.zeros(length)
    for start, gain in ((0, 1.0), (int(0.085 * RATE), 0.55)):
        part = int(0.05 * RATE)
        t = np.arange(part) / RATE
        tap = band(rng.normal(0, 1, part), 900, 4200) * envelope(part, 0.0018)
        thump = np.sin(2 * np.pi * 190 * t) * envelope(part, 0.009) * 0.6
        sound[start:start + part] += (tap + thump) * gain
    return sound


def save(name, sound, peak_db=-6.0):
    sound = sound - sound.mean()
    sound = sound / np.max(np.abs(sound)) * 10 ** (peak_db / 20)
    fade = int(0.004 * RATE)
    sound[-fade:] *= np.linspace(1, 0, fade)
    stereo = np.repeat((sound * 32767).astype(np.int16)[:, None], 2, axis=1)
    destination = OUT / f"{name}.wav"
    with wave.open(str(destination), "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(RATE)
        audio.writeframes(stereo.tobytes())
    print(f"{destination}  {len(sound) / RATE * 1000:.0f} ms")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    save("click", click(rng))
    save("key", key(rng))


if __name__ == "__main__":
    main()
