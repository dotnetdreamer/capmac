"""Fit the supplied intro.mp3 to the 68 second film without changing tempo"""

from pathlib import Path
import shutil
import subprocess
import wave


project = Path(__file__).resolve().parent.parent
source = project / "public" / "intro.mp3"
destination = project / "public" / "intro-background.wav"
ffmpeg = shutil.which("ffmpeg")
if not ffmpeg:
    raise SystemExit("FFmpeg must be available on PATH")
if not source.is_file():
    raise SystemExit(f"Music file missing: {source}")

# The supplied track has a long fade beginning around 48 seconds
# Repeat an eight bar middle passage on its 120 BPM grid and retain that fade
# Both parts join immediately before a kick, with 20 ms to avoid a click
filters = (
    "[0:a]atrim=start=0:end=40.02,asetpts=PTS-STARTPTS[first];"
    "[0:a]atrim=start=24:end=52,asetpts=PTS-STARTPTS[repeat];"
    "[first][repeat]acrossfade=d=0.02:c1=tri:c2=tri,"
    "afade=t=out:st=66.5:d=1.5[music]"
)
subprocess.run([
    ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
    "-filter_complex", filters, "-map", "[music]", "-ar", "48000",
    "-ac", "2", "-c:a", "pcm_s16le", str(destination),
], check=True)

with wave.open(str(destination), "rb") as audio:
    duration = audio.getnframes() / audio.getframerate()
    if audio.getnframes() != 68 * 48000 or audio.getnchannels() != 2:
        raise SystemExit("Prepared music must be exactly 68 seconds and stereo")
print(f"Prepared {destination} ({duration:.3f} seconds)")
