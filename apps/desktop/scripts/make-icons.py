"""Draws the app icon as PNGs (resources/icons/<size>.png) to match resources/icon.svg."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "resources" / "icons"
SCALE = 4
BLUE = (31, 95, 168, 255)


def icon(size: int) -> Image.Image:
    s = size * SCALE
    unit = s / 256
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle([0, 0, s - 1, s - 1], radius=56 * unit, fill=BLUE)
    c = s / 2
    for radius, alpha in ((74, 0.35), (49, 0.7)):
        ring = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        r = radius * unit
        ImageDraw.Draw(ring).ellipse([c - r, c - r, c + r, c + r], outline=(255, 255, 255, round(255 * alpha)), width=round(14 * unit))
        img = Image.alpha_composite(img, ring)
    r = 22.5 * unit
    ImageDraw.Draw(img).ellipse([c - r, c - r, c + r, c + r], fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 64, 128, 256, 512):
    icon(size).save(OUT / f"{size}.png")

# macOS draws app icons inside Apple's icon grid: the shape is 824px of a 1024px canvas, centred,
# so lamsa sits the same size as other apps in the Dock. electron-builder turns this into an .icns.
mac = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
mac.paste(icon(824), (100, 100))
mac.save(OUT.parent / "icon-mac.png")
