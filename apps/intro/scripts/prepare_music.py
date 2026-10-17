"""Fit the supplied intro.mp3 to each film without changing tempo"""

from pathlib import Path
import shutil
import subprocess
import wave


project = Path(__file__).resolve().parent.parent
source = project / "public" / "intro.mp3"
ffmpeg = shutil.which("ffmpeg")
if not ffmpeg:
    raise SystemExit("FFmpeg must be available on PATH")
if not source.is_file():
    raise SystemExit(f"Music file missing: {source}")

# The supplied track runs at 120 BPM: a pad until 8 seconds, a riser at 14 and the drop at 16
# Its beat ends on a final hit at 48 seconds, then decays
# Each film keeps the opening, repeats the eight bar passage from 24 to 40 seconds and keeps that ending
# Every join falls immediately before a kick, with 20 ms to avoid a click
FILMS = {
    # The launch film: two repeats put the final hit at 80 seconds
    "intro-background.wav": (84, [(0, 40.02), (24, 40.02), (24, 52)]),
    # CapMac for VS Code: one repeat puts the final hit at 64 seconds
    "vscode-background.wav": (68, [(0, 40.02), (24, 52)]),
}

for name, (seconds, parts) in FILMS.items():
    destination = project / "public" / name
    trims = "".join(f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[p{i}];" for i, (start, end) in enumerate(parts))
    joined, label = "p0", "p0"
    for i in range(1, len(parts)):
        label = f"j{i}"
        trims += f"[{joined}][p{i}]acrossfade=d=0.02:c1=tri:c2=tri[{label}];"
        joined = label
    filters = trims + f"[{label}]afade=t=out:st={seconds - 1.5}:d=1.5[music]"
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
        "-filter_complex", filters, "-map", "[music]", "-ar", "48000",
        "-ac", "2", "-c:a", "pcm_s16le", str(destination),
    ], check=True)
    with wave.open(str(destination), "rb") as audio:
        duration = audio.getnframes() / audio.getframerate()
        if abs(audio.getnframes() - seconds * 48000) > 48 or audio.getnchannels() != 2:
            raise SystemExit(f"{name} must be {seconds} seconds and stereo, not {duration:.3f} seconds")
    print(f"Prepared {destination} ({duration:.3f} seconds)")
