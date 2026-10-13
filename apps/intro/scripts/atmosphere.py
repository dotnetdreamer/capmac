"""Render the three original cloud backplates used by the launch film."""

from pathlib import Path
import tempfile

import numpy as np
from PIL import Image, ImageFilter, ImageOps, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "atmosphere"
SIZE = (1920, 1080)
FIELD_SIZE = (480, 270)


def soft_noise(rng, columns, rows):
    """Continuous multiscale fields, without visible cellular boundaries."""
    knots = rng.normal(0.0, 1.0, (rows, columns)).astype(np.float32)
    image = Image.fromarray(knots, mode="F")
    image = image.resize(FIELD_SIZE, Image.Resampling.BICUBIC)
    field = np.asarray(image, dtype=np.float32)
    return (field - field.mean()) / max(float(field.std()), 0.001)


def sample(field, x, y):
    """Bilinear domain warping bends layered haze into long cloud forms."""
    height, width = field.shape
    x = np.clip(x, 0, width - 1.001)
    y = np.clip(y, 0, height - 1.001)
    x0, y0 = x.astype(np.int32), y.astype(np.int32)
    fx, fy = x - x0, y - y0
    return (
        field[y0, x0] * (1 - fx) * (1 - fy)
        + field[y0, x0 + 1] * fx * (1 - fy)
        + field[y0 + 1, x0] * (1 - fx) * fy
        + field[y0 + 1, x0 + 1] * fx * fy
    )


def render(seed, low, shadow, haze, sky_tint):
    rng = np.random.default_rng(seed)
    width, height = FIELD_SIZE
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    x, y = xx / width, yy / height

    broad = soft_noise(rng, 5, 4)
    folds = soft_noise(rng, 10, 7)
    fine = soft_noise(rng, 24, 14)
    warp_x = soft_noise(rng, 6, 4)
    warp_y = soft_noise(rng, 7, 5)
    cloud = sample(
        broad * 0.78 + folds * 0.32 + fine * 0.045,
        xx + warp_x * 24,
        yy + warp_y * 13,
    )

    # Wispy layers retain coherent structure after the heavy lens defocus
    layer = np.sin(y * 4.5 + x * 1.25 + warp_y * 0.37)
    density = 1 / (1 + np.exp(-(cloud * 1.35 + layer * 0.28 - 0.1)))
    density = np.clip((density - 0.10) / 0.90, 0, 1)
    pale = np.power(density, 1.62) * 0.67
    body = np.clip(density * 0.55 + (1 - y) * 0.13, 0, 1)

    low = np.asarray(low, dtype=np.float32)
    shadow = np.asarray(shadow, dtype=np.float32)
    haze = np.asarray(haze, dtype=np.float32)
    sky_tint = np.asarray(sky_tint, dtype=np.float32)
    rgb = low[None, None, :] * (1 - body[:, :, None])
    rgb += shadow[None, None, :] * body[:, :, None]
    rgb = rgb * (1 - pale[:, :, None]) + haze[None, None, :] * pale[:, :, None]
    rgb += sky_tint[None, None, :] * ((0.5 - y) * 0.20)[:, :, None]

    # Optical falloff is mild, with irregular atmosphere doing most of the work
    distance = ((x - 0.5) / 0.8) ** 2 + ((y - 0.5) / 1.1) ** 2
    rgb *= (1 - np.clip(distance, 0, 1) * 0.16)[:, :, None]
    image = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), mode="RGB")
    image = image.resize(SIZE, Image.Resampling.BICUBIC)
    image = image.filter(ImageFilter.GaussianBlur(23))

    # Fine photographic grain prevents banding in the rendered H264 backplate
    pixels = np.asarray(image, dtype=np.float32)
    grain = rng.normal(0.0, 0.63, (SIZE[1], SIZE[0], 1)).astype(np.float32)
    pixels = np.clip(pixels + grain, 0, 255).astype(np.uint8)
    return Image.fromarray(pixels, mode="RGB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    palettes = {
        "cool": (39, (17, 28, 43), (57, 80, 102), (168, 177, 172), (15, 23, 34)),
        "warm": (82, (31, 26, 31), (96, 69, 60), (198, 158, 119), (27, 9, -9)),
        "violet": (127, (23, 24, 43), (67, 64, 100), (170, 159, 184), (10, 3, 21)),
    }
    images = []
    for name, parameters in palettes.items():
        image = render(*parameters)
        destination = OUT / f"{name}.jpg"
        image.save(destination, quality=95, subsampling=0, optimize=True)
        print(f"{destination}  {destination.stat().st_size // 1024} KB")
        thumb = ImageOps.fit(image, (960, 540))
        ImageDraw.Draw(thumb).text((24, 22), name.upper(), fill=(230, 230, 230))
        images.append(thumb)

    contact = Image.new("RGB", (960, 1620))
    for index, image in enumerate(images):
        contact.paste(image, (0, index * 540))
    contact_path = Path(tempfile.gettempdir()) / "capmac-atmosphere-contact.jpg"
    contact.save(contact_path, quality=94)
    print(f"Contact sheet: {contact_path}")


if __name__ == "__main__":
    main()
