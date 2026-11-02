"""Kelly Page app icons (PNG) for the web app manifest and iOS, rendered from assets/kelly-mark.svg.

  python kelly-page/brand/make_icons.py        (needs pymupdf -- requirements.txt)

Writes assets/icons/:
  kelly-192.png, kelly-512.png            the app icon as drawn (rounded square, transparent corners): purpose "any"
  kelly-maskable-192.png, -512.png        full-bleed square, the artwork shrunk into the 80 % safe zone: purpose "maskable"
  apple-touch-icon.png (180)              the full-bleed one again: iOS rounds the corners itself
Run make_logos.py first if the mark changed. Not shipped (package_kelly.py NEVER); the PNGs are.
"""
import re
from pathlib import Path

import pymupdf

KP = Path(__file__).resolve().parent.parent
MARK = (KP / "assets" / "kelly-mark.svg").read_text(encoding="utf-8")
OUT = KP / "assets" / "icons"


def maskable_svg() -> str:
    defs = re.search(r"<defs>.*?</defs>", MARK, re.S).group(0)
    art = re.search(r'<g clip-path="url\(#clip\)">(.*)</g>\s*</svg>', MARK, re.S).group(1)
    # scaled to 72 % and anchored at the bottom: the coat still runs off the bottom edge, and the radio arcs
    # (top left) stay inside the safe circle (radius 40 % of the icon) that Android masks to
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">{defs}'
            f'<rect width="200" height="200" fill="url(#bg)"/><g transform="translate(28 56) scale(.72)">{art}</g></svg>')


def flat(svg: str) -> str:
    """MuPDF fills an SVG gradient black: swap each url(#gradient) for the average of its stops."""
    for gid, body in re.findall(r'<linearGradient id="([^"]+)"[^>]*>(.*?)</linearGradient>', svg, re.S):
        cols = [tuple(int(c[i:i + 2], 16) for i in (0, 2, 4)) for c in re.findall(r'stop-color="#([0-9A-Fa-f]{6})"', body)]
        avg = "#" + "".join(f"{round(sum(c[i] for c in cols) / len(cols)):02X}" for i in range(3))
        svg = svg.replace(f"url(#{gid})", avg)
    return svg


def render(svg: str, size: int, path: Path):
    doc = pymupdf.open(stream=flat(svg).encode("utf-8"), filetype="svg")
    page = doc[0]
    pix = page.get_pixmap(matrix=pymupdf.Matrix(size / page.rect.width, size / page.rect.height), alpha=True)
    pix.save(path)
    print(f"{path.relative_to(KP).as_posix()}  {pix.width}x{pix.height}")


def main():
    OUT.mkdir(exist_ok=True)
    mask = maskable_svg()
    for size in (192, 512):
        render(MARK, size, OUT / f"kelly-{size}.png")
        render(mask, size, OUT / f"kelly-maskable-{size}.png")
    render(mask, 180, OUT / "apple-touch-icon.png")


if __name__ == "__main__":
    main()
