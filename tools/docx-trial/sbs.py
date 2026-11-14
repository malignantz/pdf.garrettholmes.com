"""Side-by-side page image: reference | candidate(s), labelled.

Usage (trial venv): python sbs.py OUT_PNG PAGE LABEL=PDF [LABEL=PDF ...]   (PAGE is 1-based)
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw


def page_png(pdf, page, tmp, tag):
	prefix = Path(tmp) / tag
	subprocess.run(["pdftoppm", "-r", "70", "-f", str(page), "-l", str(page), "-png", "-singlefile", pdf, str(prefix)],
		capture_output=True)
	p = prefix.with_suffix(".png")
	if p.exists():
		return Image.open(p).convert("RGB")
	im = Image.new("RGB", (595, 770), (230, 230, 230))
	ImageDraw.Draw(im).text((20, 380), "no such page", fill=(200, 0, 0))
	return im


def main():
	out, page = sys.argv[1], int(sys.argv[2])
	pairs = [a.split("=", 1) for a in sys.argv[3:]]
	with tempfile.TemporaryDirectory() as tmp:
		ims = [(lab, page_png(pdf, page, tmp, f"i{i}")) for i, (lab, pdf) in enumerate(pairs)]
	h = max(im.height for _, im in ims) + 24
	w = sum(im.width for _, im in ims) + 10 * (len(ims) - 1)
	canvas = Image.new("RGB", (w, h), (255, 255, 255))
	d = ImageDraw.Draw(canvas)
	x = 0
	for lab, im in ims:
		d.text((x + 4, 4), f"{lab} - page {page}", fill=(0, 0, 160))
		canvas.paste(im, (x, 24))
		d.rectangle([x, 24, x + im.width - 1, 24 + im.height - 1], outline=(120, 120, 120))
		x += im.width + 10
	canvas.save(out)


if __name__ == "__main__":
	main()
