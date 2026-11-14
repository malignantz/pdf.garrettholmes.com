"""Up-front checks a converter could run on a .docx before converting ("avoid, don't fail").

Usage (run with python3 -I on untrusted files): python3 -I decline.py FILE.docx [...]
Prints one TSV line per file: name, verdict (ok / decline), reasons.

Reasons (each from the package XML only; nothing is rendered):
  font:<name>   a font used by text that has no metric-compatible font in the converter
                (allowed: Calibri, Cambria, Arial, Times New Roman, Courier New and the symbol fonts)
  columns       a section with more than one column
  revisions     tracked insertions, deletions or moves (Word may print them as markup)
  comments      a comments part with comments
  script        text outside Latin, Greek and Cyrillic (CJK, Arabic, Hebrew, Indic, Ethiopic...)
  textbox / chart / smartart / math / embedded-object / vml-shape   floating or drawn content
"""

import re
import sys
import zipfile
from pathlib import Path

ALLOWED = {
	"calibri", "calibri light", "cambria", "cambria math", "arial", "times new roman", "courier new",
	"symbol", "wingdings", "wingdings 2", "wingdings 3", "liberation sans", "liberation serif",
	"liberation mono", "carlito", "caladea", "arial narrow",
}
NON_LATIN = re.compile("[֐-ࣿऀ-෿฀-໿ᄀ-ᇿሀ-᎟　-鿿가-힯豈-﫿]")


def theme_fonts(z):
	try:
		t = z.read("word/theme/theme1.xml").decode("utf8", "ignore")
	except KeyError:
		return {}
	out = {}
	for kind in ("major", "minor"):
		m = re.search(rf"<a:{kind}Font>.*?<a:latin typeface=\"([^\"]*)\"", t, re.S)
		if m:
			out[kind] = m.group(1)
	return out


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _font_of(rpr, theme):
	"""The Latin font an rPr names, directly or through a theme slot, or None."""
	if rpr is None:
		return None
	rf = rpr.find(W + "rFonts")
	if rf is None:
		return None
	for k in ("ascii", "hAnsi"):
		v = rf.get(W + k)
		if v:
			return v
	for k in ("asciiTheme", "hAnsiTheme"):
		v = rf.get(W + k)
		if v:
			return theme.get("major" if v.startswith("major") else "minor")
	return None


def used_fonts(z):
	"""Fonts that text in the document actually resolves to (run, run style, paragraph style chain,
	document defaults, theme), in the body, headers, footers and notes. Styles nobody uses do not count."""
	import xml.etree.ElementTree as ET
	theme = theme_fonts(z)
	styles = {}
	default_p = None
	doc_default = None
	try:
		st = ET.fromstring(z.read("word/styles.xml"))
		dd = st.find(f"{W}docDefaults/{W}rPrDefault/{W}rPr")
		doc_default = _font_of(dd, theme)
		for s_ in st.findall(W + "style"):
			sid = s_.get(W + "styleId")
			based = s_.find(W + "basedOn")
			styles[sid] = (_font_of(s_.find(W + "rPr"), theme), based.get(W + "val") if based is not None else None)
			if s_.get(W + "type") == "paragraph" and s_.get(W + "default") == "1":
				default_p = sid
	except KeyError:
		pass

	def style_font(sid, depth=0):
		while sid and depth < 20:
			f, based = styles.get(sid, (None, None))
			if f:
				return f
			sid, depth = based, depth + 1
		return None

	fonts = set()
	parts = [n for n in z.namelist() if re.match(r"word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$", n)]
	for n in parts:
		root = ET.fromstring(z.read(n))
		for p in root.iter(W + "p"):
			ppr = p.find(W + "pPr")
			ps = ppr.find(W + "pStyle") if ppr is not None else None
			pstyle = ps.get(W + "val") if ps is not None else default_p
			for r in p.iter(W + "r"):
				if not "".join(t.text or "" for t in r.findall(W + "t")).strip():
					continue
				rpr = r.find(W + "rPr")
				f = _font_of(rpr, theme)
				if not f and rpr is not None and rpr.find(W + "rStyle") is not None:
					f = style_font(rpr.find(W + "rStyle").get(W + "val"))
				f = f or style_font(pstyle) or doc_default or theme.get("minor")
				if f:
					fonts.add(f)
	return fonts


def check(path):
	reasons = []
	with zipfile.ZipFile(path) as z:
		names = z.namelist()
		doc = z.read("word/document.xml").decode("utf8", "ignore")
		for f in sorted(used_fonts(z)):
			if f.lower() not in ALLOWED:
				reasons.append(f"font:{f}")
		if re.search(r"<w:cols\b[^>]*w:num=\"([2-9])", doc):
			reasons.append("columns")
		if re.search(r"<w:(ins|del|moveFrom|moveTo)\b", doc):
			reasons.append("revisions")
		if "word/comments.xml" in names and "<w:comment " in z.read("word/comments.xml").decode("utf8", "ignore"):
			reasons.append("comments")
		text = " ".join(re.findall(r"<w:t(?:\s[^>]*)?>([^<]*)</w:t>", doc))
		if NON_LATIN.search(text):
			reasons.append("script")
		if "<w:txbxContent" in doc:
			reasons.append("textbox")
		if any(n.startswith("word/charts/") for n in names):
			reasons.append("chart")
		if any(n.startswith("word/diagrams/") for n in names):
			reasons.append("smartart")
		if "<m:oMath" in doc:
			reasons.append("math")
		if "<w:object" in doc or any(n.startswith("word/embeddings/") for n in names):
			reasons.append("embedded-object")
		if re.search(r"<v:(shape|rect|roundrect|line|oval)\b", doc) and "<w:pict" in doc:
			reasons.append("vml-shape")
	return reasons


if __name__ == "__main__":
	for p in sys.argv[1:]:
		try:
			r = check(p)
		except Exception as e:  # damaged package: decline
			r = [f"unreadable:{type(e).__name__}"]
		print(f"{Path(p).stem}\t{'decline' if r else 'ok'}\t{','.join(r)}")
