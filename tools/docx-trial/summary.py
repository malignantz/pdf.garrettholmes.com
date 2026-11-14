"""Summarise results.tsv + compare.tsv per candidate as Markdown.

Usage (trial venv): python summary.py OUT_ROOT SET CAND [CAND ...]
  OUT_ROOT/SET/CAND/{results.tsv,compare.tsv,load.json}
Per candidate: converted, median / p90 / max time, page count match, lines identical (mean, files
>= 0.95), pages that look the same (ink_shift >= 0.9, share of all reference pages).
With --accepted DECLINE_TSV (or --declined), only the files decline.py accepted (or declined).
With --families, also a per-family table (file names start with a two-letter family code).
"""

import csv
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path


def load(p):
	if not p.exists():
		return []
	return list(csv.DictReader(open(p), delimiter="\t"))


def pct(x):
	return f"{100 * x:.0f}%"


def main():
	root, sset, cands = Path(sys.argv[1]), sys.argv[2], [c for c in sys.argv[3:] if not c.startswith("--")]
	fam = "--families" in sys.argv
	keep = None
	if "--accepted" in sys.argv or "--declined" in sys.argv:
		flag = "--accepted" if "--accepted" in sys.argv else "--declined"
		rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[sys.argv.index(flag) + 1])]
		keep = {r[0] for r in rows if (r[1] == "ok") == (flag == "--accepted")}
		cands = [c for c in cands if not c.endswith(".tsv")]
	print(f"| {sset} | converted | time median / p90 / max | same page count | lines identical (mean) | files with >= 95% lines identical | pages with the same text | pages that look the same |")
	print("|---|---:|---:|---:|---:|---:|---:|---:|")
	per_family = {}
	for c in cands:
		res = load(root / sset / c / "results.tsv")
		cmp_ = {r["name"]: r for r in load(root / sset / c / "compare.tsv") if keep is None or r["name"] in keep}
		if keep is not None:
			res = [r for r in res if r["file"] in keep]
		ok = [r for r in res if r["status"] == "ok"]
		times = sorted(int(r["ms"]) for r in ok)
		n = len(cmp_) or len(res)
		pm = sum(int(r["page_match"]) for r in cmp_.values())
		ls = [float(r["lines_same"]) for r in cmp_.values()]
		ref_pages = sum(int(r["pages_ref"]) for r in cmp_.values())
		good_pages = sum(float(r["pages_good"]) * int(r["pages_ref"]) for r in cmp_.values())
		text_pages = sum(float(r["pages_text"]) * int(r["pages_ref"]) for r in cmp_.values())
		t = (f"{times[len(times) // 2] / 1000:.1f} / {times[int(len(times) * 0.9) - 1] / 1000:.1f} / {times[-1] / 1000:.1f} s"
			if times else "-")
		print(f"| {c} | {len(ok)}/{len(res)} | {t} | {pm}/{n} | {pct(statistics.mean(ls)) if ls else '-'} | "
			f"{sum(x >= 0.95 for x in ls)}/{n} | {pct(text_pages / ref_pages) if ref_pages else '-'} | "
			f"{pct(good_pages / ref_pages) if ref_pages else '-'} |")
		if fam:
			d = defaultdict(list)
			for name, r in cmp_.items():
				d[name[:2]].append(r)
			per_family[c] = d
	if fam:
		fams = sorted({f for d in per_family.values() for f in d})
		print()
		print("| family | files | " + " | ".join(f"{c}: page count / lines / look same" for c in cands) + " |")
		print("|---|---:|" + "---:|" * len(cands))
		for f in fams:
			cells = []
			nfiles = 0
			for c in cands:
				rows = per_family[c].get(f, [])
				nfiles = max(nfiles, len(rows))
				if not rows:
					cells.append("-")
					continue
				pm = sum(int(r["page_match"]) for r in rows)
				ls = statistics.mean(float(r["lines_same"]) for r in rows)
				rp = sum(int(r["pages_ref"]) for r in rows)
				gp = sum(float(r["pages_good"]) * int(r["pages_ref"]) for r in rows)
				cells.append(f"{pm}/{len(rows)} / {pct(ls)} / {pct(gp / rp) if rp else '-'}")
			print(f"| {f} | {nfiles} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
	main()
