"""Compare candidate PDFs against reference PDFs, page by page.

Usage (trial venv):  python compare.py REF_DIR CAND_DIR OUT_TSV [--names a,b,c]
REF_DIR and CAND_DIR hold <name>.pdf. For every name in REF_DIR:
  pages_ref, pages_cand, page_match (equal counts),
  lines_same: share of reference text lines (pdftotext -layout, whitespace collapsed, per page) that
              appear as the same line on the same page of the candidate -> "line breaks match"
  words_same: share of reference words found on the same page (multiset), a looser text check
  pages_text: share of reference pages whose words (95% both ways) are on the same candidate page,
              i.e. the page breaks fall in the same places
  ink_f1:     mean over reference pages of an ink overlap score at 60 dpi: dark pixels of each page
              compared with a 1-pixel tolerance (F1 of ink pixels within 1 px of ink in the other);
              pages missing from the candidate score 0
  ink_shift:  the same score, best over whole-page shifts of up to 8 px (3.4 mm) each way, so a page
              that is the same but sits a little lower still counts as the same
  pages_good: share of reference pages with ink_shift >= 0.9
"""

import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

DPI = 60


def pages(pdf):
	out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
	for ln in out.splitlines():
		if ln.startswith("Pages:"):
			return int(ln.split()[1])
	return 0


def page_lines(pdf):
	txt = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True).stdout
	res = []
	for pg in txt.split("\f"):
		lines = [" ".join(l.split()) for l in pg.splitlines()]
		res.append([l for l in lines if l])
	if res and not res[-1]:
		res.pop()
	return res


def render(pdf, tmp, tag):
	prefix = Path(tmp) / tag
	subprocess.run(["pdftoppm", "-r", str(DPI), "-gray", "-png", str(pdf), str(prefix)], check=False,
		capture_output=True)
	files = sorted(Path(tmp).glob(f"{tag}-*.png"), key=lambda p: int(p.stem.split("-")[-1]))
	return files


def ink(path, shape=None):
	im = Image.open(path).convert("L")
	if shape and im.size != shape:
		im = im.resize(shape)
	return np.asarray(im) < 160


def dilate(a):
	b = a.copy()
	b[1:, :] |= a[:-1, :]
	b[:-1, :] |= a[1:, :]
	b[:, 1:] |= a[:, :-1]
	b[:, :-1] |= a[:, 1:]
	return b


def ink_f1(a, b):
	if not a.any() and not b.any():
		return 1.0
	if not a.any() or not b.any():
		return 0.0
	p = (b & dilate(a)).sum() / b.sum()
	r = (a & dilate(b)).sum() / a.sum()
	return 0.0 if p + r == 0 else 2 * p * r / (p + r)


def shifted_f1(a, b):
	best = ink_f1(a, b)
	if best > 0.98:
		return best
	da = dilate(a)
	for dy in range(-8, 9, 2):
		for dx in range(-8, 9, 2):
			if dx == 0 and dy == 0:
				continue
			bs = np.roll(np.roll(b, dy, axis=0), dx, axis=1)
			if not bs.any() or not a.any():
				continue
			p = (bs & da).sum() / bs.sum()
			r = (a & dilate(bs)).sum() / a.sum()
			if p + r:
				best = max(best, 2 * p * r / (p + r))
	return best


def compare(ref, cand):
	row = {"pages_ref": pages(ref), "pages_cand": pages(cand) if cand.exists() else 0}
	row["page_match"] = int(row["pages_ref"] == row["pages_cand"])
	if not cand.exists():
		row.update(lines_same=0.0, words_same=0.0, pages_text=0.0, ink_f1=0.0, ink_shift=0.0, pages_good=0.0, per_page="")
		return row
	rl, cl = page_lines(ref), page_lines(cand)
	tot = same = wt = ws = 0
	text_pages = 0
	for i, lines in enumerate(rl):
		other = cl[i] if i < len(cl) else []
		oc = Counter(other)
		for l in lines:
			tot += 1
			if oc[l] > 0:
				same += 1
				oc[l] -= 1
		rw = Counter(w for l in lines for w in l.split())
		cw = Counter(w for l in other for w in l.split())
		wt += sum(rw.values())
		ws += sum((rw & cw).values())
		common = sum((rw & cw).values())
		nr, nc = sum(rw.values()), sum(cw.values())
		if (nr == 0 and nc == 0) or (nr and common >= 0.95 * nr and common >= 0.95 * nc):
			text_pages += 1
	row["lines_same"] = same / tot if tot else 1.0
	row["words_same"] = ws / wt if wt else 1.0
	row["pages_text"] = text_pages / len(rl) if rl else 1.0
	with tempfile.TemporaryDirectory() as tmp:
		rf = render(ref, tmp, "r")
		cf = render(cand, tmp, "c")
		scores, shifted = [], []
		for i, f in enumerate(rf):
			a = ink(f)
			if i < len(cf):
				b = ink(cf[i], (a.shape[1], a.shape[0]))
				scores.append(ink_f1(a, b))
				shifted.append(shifted_f1(a, b))
			else:
				scores.append(0.0)
				shifted.append(0.0)
	row["ink_f1"] = float(np.mean(scores)) if scores else 0.0
	row["ink_shift"] = float(np.mean(shifted)) if shifted else 0.0
	row["pages_good"] = float(np.mean([s >= 0.9 for s in shifted])) if shifted else 0.0
	row["per_page"] = ",".join(f"{s:.2f}" for s in shifted)
	return row


def main():
	ref_dir, cand_dir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
	names = None
	if "--names" in sys.argv:
		names = sys.argv[sys.argv.index("--names") + 1].split(",")
	cols = ["name", "pages_ref", "pages_cand", "page_match", "lines_same", "words_same", "pages_text", "ink_f1", "ink_shift", "pages_good", "per_page"]
	with open(out, "w") as fh:
		fh.write("\t".join(cols) + "\n")
		for ref in sorted(ref_dir.glob("*.pdf")):
			if names and ref.stem not in names:
				continue
			r = compare(ref, cand_dir / ref.name)
			r["name"] = ref.stem
			fh.write("\t".join(f"{r[c]:.3f}" if isinstance(r[c], float) else str(r[c]) for c in cols) + "\n")
			print(ref.stem, r["pages_ref"], r["pages_cand"], f"{r['lines_same']:.2f}", f"{r['ink_f1']:.2f}", f"{r['ink_shift']:.2f}", flush=True)


if __name__ == "__main__":
	main()
