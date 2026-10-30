"""Build the extension icons (HermesNag style: cream paper card, dark frame, terracotta badge).

  python3 scripts/make-icons.py <portrait.png>

128/48 px: the portrait on a card with a terracotta cursor badge. 16/32 px: the card with
just the cursor, because a portrait turns to mush at toolbar size.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

CREAM, FRAME, TERRA, LIGHT = (237, 228, 217), (53, 48, 42), (186, 88, 61), (251, 241, 230)
OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
S = 1024  # work at high resolution, downsample at the end


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    return m


def cursor(draw, cx, cy, h, fill, outline=None, width=0):
    """Arrow pointer, tip at the top left, roughly h tall, centred near (cx, cy)."""
    pts = [(0, 0), (0, 0.78), (0.2, 0.6), (0.34, 0.92), (0.47, 0.86), (0.33, 0.55), (0.58, 0.55)]
    x0, y0 = cx - h * 0.27, cy - h * 0.48
    poly = [(x0 + x * h, y0 + y * h) for x, y in pts]
    draw.polygon(poly, fill=fill, outline=outline, width=width)


def card(inner: Image.Image | None) -> Image.Image:
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    frame = Image.new("RGBA", (S, S), FRAME)
    base.paste(frame, (0, 0), rounded_mask(S, 220))
    pad = 44
    paper = Image.new("RGBA", (S - 2 * pad, S - 2 * pad), CREAM)
    if inner is not None:
        paper.paste(inner.resize(paper.size, Image.LANCZOS), (0, 0))
    base.paste(paper, (pad, pad), rounded_mask(S - 2 * pad, 180))
    return base


def badge(img: Image.Image, cx, cy, r):
    d = ImageDraw.Draw(img)
    d.ellipse([cx - r - 14, cy - r - 14, cx + r + 14, cy + r + 14], fill=LIGHT)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=TERRA)
    cursor(d, cx + r * 0.06, cy + r * 0.04, r * 1.15, LIGHT)


def main(src: str):
    OUT.mkdir(parents=True, exist_ok=True)
    src_img = Image.open(src).convert("RGBA")
    bg = src_img.getpixel((1040, 480))  # paper colour next to the bell
    ImageDraw.Draw(src_img).ellipse([848, 178, 1102, 432], fill=bg)  # remove HermesNag's bell badge
    portrait = src_img.crop((205, 112, 1055, 962))  # head and shoulders, no title text
    big = card(portrait)
    badge(big, 760, 265, 125)  # top right, where HermesNag's bell sits, kept inside the card
    small = card(None)
    cursor(ImageDraw.Draw(small), S / 2 + 20, S / 2 + 10, 640, TERRA)
    for size, img in ((128, big), (48, big), (32, small), (16, small)):
        img.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
        print(OUT / f"icon{size}.png")
    # round face crop for the cursor's name tag
    face = src_img.crop((380, 230, 780, 630)).resize((96, 96), Image.LANCZOS)
    mask = Image.new("L", (96, 96), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, 95, 95], fill=255)
    avatar = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    avatar.paste(face, (0, 0), mask)
    avatar.save(OUT / "avatar.png")
    print(OUT / "avatar.png")


if __name__ == "__main__":
    main(sys.argv[1])
