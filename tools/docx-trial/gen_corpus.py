"""Generate the synthetic .docx test set for the Word-to-PDF trial.

Run with the trial venv (python-docx, Pillow):
    $VENV/bin/python tools/docx-trial/gen_corpus.py OUT_DIR

Each file exercises one feature family. File names start with a two-letter family code so the
report can group results: lt letter, hf headers/footers, tb tables, im images, co columns,
fn footnotes, tc tracked changes, cm comments, tx text boxes, li lists, ls landscape,
rp long report, nl non-Latin, fo fonts, mi misc.
"""

import io
import random
import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT, WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Cm, Inches, Pt, RGBColor
from PIL import Image, ImageDraw

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
rnd = random.Random(20261114)

WORDS = (
	"the of and to in a is that for it as was with be by on not he this are or his from at which "
	"but have an they you were her she there been one all we their has would when if so no will "
	"more can who about out up into them some could time these two may then do first any my now "
	"such like our over man me even most made after also did many before must through back years "
	"where much your way well down should because each just those people how too little state good "
	"very make world still own see men work long get here between both life being under never day "
	"same another know while last might us great old year off come since against go came right used "
	"take three council budget report committee service project contract payment schedule notice"
).split()


def sentence(n=None):
	n = n or rnd.randint(8, 22)
	w = [rnd.choice(WORDS) for _ in range(n)]
	w[0] = w[0].capitalize()
	return " ".join(w) + "."


def para_text(s=None):
	return " ".join(sentence() for _ in range(s or rnd.randint(3, 7)))


def new_doc(font="Calibri", size=11):
	d = Document()
	st = d.styles["Normal"]
	st.font.name = font
	st.font.size = Pt(size)
	rpr = st.element.get_or_add_rPr()
	rf = rpr.find(qn("w:rFonts"))
	for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
		rf.set(qn(a), font)
	for h in ("Heading 1", "Heading 2", "Heading 3", "Title"):
		hs = d.styles[h]
		hr = hs.element.get_or_add_rPr()
		f = hr.find(qn("w:rFonts"))
		if f is None:
			f = parse_xml(f"<w:rFonts {nsdecls('w')}/>")
			hr.insert(0, f)
		for a in ("w:asciiTheme", "w:hAnsiTheme", "w:cstheme", "w:eastAsiaTheme"):
			if f.get(qn(a)) is not None:
				del f.attrib[qn(a)]
		for a in ("w:ascii", "w:hAnsi", "w:cs"):
			f.set(qn(a), font)
	sec = d.sections[0]
	sec.page_width, sec.page_height = Inches(8.5), Inches(11)
	sec.left_margin = sec.right_margin = Inches(1)
	sec.top_margin = sec.bottom_margin = Inches(1)
	return d


def add_field(paragraph, instr, cached="1"):
	"""Complex field (PAGE, NUMPAGES, DATE...) with a cached result."""
	r = paragraph.add_run()
	r._r.append(parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="begin"/>'))
	r = paragraph.add_run()
	r._r.append(parse_xml(f'<w:instrText {nsdecls("w")} xml:space="preserve"> {instr} </w:instrText>'))
	r = paragraph.add_run()
	r._r.append(parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="separate"/>'))
	paragraph.add_run(cached)
	r = paragraph.add_run()
	r._r.append(parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="end"/>'))


def page_x_of_y(paragraph):
	paragraph.add_run("Page ")
	add_field(paragraph, "PAGE")
	paragraph.add_run(" of ")
	add_field(paragraph, "NUMPAGES")


def picture(w=800, h=500, seed=0, label="Figure"):
	r = random.Random(seed)
	im = Image.new("RGB", (w, h), (r.randint(180, 255), r.randint(180, 255), r.randint(180, 255)))
	dr = ImageDraw.Draw(im)
	for _ in range(25):
		x0, y0 = r.randint(0, w), r.randint(0, h)
		dr.ellipse([x0, y0, x0 + r.randint(20, 200), y0 + r.randint(20, 200)],
			fill=(r.randint(0, 200), r.randint(0, 200), r.randint(0, 200)))
	dr.rectangle([0, 0, w - 1, h - 1], outline=(0, 0, 0), width=4)
	dr.text((20, 20), label, fill=(0, 0, 0))
	b = io.BytesIO()
	im.save(b, "PNG")
	b.seek(0)
	return b


def body(d, paras=6, heading=None):
	if heading:
		d.add_heading(heading, level=1)
	for _ in range(paras):
		d.add_paragraph(para_text())


def save(d, name):
	d.save(OUT / f"{name}.docx")
	print(name)


# ---------------------------------------------------------------- letters and plain text

def letter(name, font, size):
	d = new_doc(font, size)
	for line in ("Riverside County Planning Office", "1200 Main Street, Suite 400",
			"Springfield, CO 80202", "", "November 14, 2026", "", "Ms. Jordan Avery",
			"44 Elm Avenue", "Springfield, CO 80203", ""):
		p = d.add_paragraph(line)
		p.paragraph_format.space_after = Pt(0)
	d.add_paragraph("Re: Application 2026-0412, variance request")
	d.add_paragraph("Dear Ms. Avery,")
	for _ in range(5):
		d.add_paragraph(para_text())
	d.add_paragraph("Sincerely,")
	d.add_paragraph("\n\nPat Morgan\nSenior Planner")
	save(d, name)


letter("lt01-letter-calibri", "Calibri", 11)
letter("lt02-letter-times", "Times New Roman", 12)
letter("lt03-letter-arial", "Arial", 10)
letter("lt04-letter-cambria", "Cambria", 11)
letter("lt05-letter-aptos", "Aptos", 11)  # Office's default since 2024: no metric-compatible free font

d = new_doc("Calibri", 11)
d.add_heading("Meeting minutes", 0)
for i in range(8):
	d.add_heading(f"Item {i + 1}: {sentence(4)[:-1]}", level=2)
	d.add_paragraph(para_text())
save(d, "lt06-minutes-headings")

# ---------------------------------------------------------------- headers / footers

d = new_doc()
sec = d.sections[0]
sec.header.paragraphs[0].text = "Annual Service Review 2026 — Draft for consultation"
sec.header.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
fp = sec.footer.paragraphs[0]
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
page_x_of_y(fp)
for i in range(5):
	body(d, 7, f"Section {i + 1}")
save(d, "hf01-page-x-of-y")

d = new_doc("Times New Roman", 12)
sec = d.sections[0]
sec.different_first_page_header_footer = True
sec.first_page_header.paragraphs[0].text = "CONFIDENTIAL — FIRST PAGE"
sec.header.paragraphs[0].text = "Continuation"
add_field(sec.footer.paragraphs[0], "PAGE")
body(d, 20)
save(d, "hf02-different-first-page")

d = new_doc()
d.settings.odd_and_even_pages_header_footer = True
sec = d.sections[0]
sec.header.paragraphs[0].text = "Odd page header"
sec.header.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
sec.even_page_header.paragraphs[0].text = "Even page header"
add_field(sec.footer.paragraphs[0], "PAGE")
add_field(sec.even_page_footer.paragraphs[0], "PAGE")
body(d, 25)
save(d, "hf03-odd-even")

d = new_doc()
sec = d.sections[0]
t = sec.header.add_table(1, 3, Inches(6.5))
for c, txt in zip(t.rows[0].cells, ("Logo Ltd", "Policy HR-12", "Rev. 4")):
	c.text = txt
sec.header.add_paragraph().add_run().add_picture(picture(600, 80, 7, "LOGO"), width=Inches(2))
p = sec.footer.paragraphs[0]
p.text = "Printed copies are uncontrolled\t"
p.paragraph_format.tab_stops.add_tab_stop(Inches(6.5), WD_TAB_ALIGNMENT.RIGHT)
add_field(p, "PAGE")
body(d, 14, "Purpose")
save(d, "hf04-header-table-logo")

d = new_doc()
s0 = d.sections[0]
s0.footer.paragraphs[0].text = "Part A footer"
body(d, 8, "Part A")
s1 = d.add_section(WD_SECTION.NEW_PAGE)
s1.footer.is_linked_to_previous = False
s1.footer.paragraphs[0].text = "Part B footer, restarted numbering: "
add_field(s1.footer.paragraphs[0], "PAGE")
pg = parse_xml(f'<w:pgNumType {nsdecls("w")} w:start="1" w:fmt="lowerRoman"/>')
s1._sectPr.append(pg)
body(d, 8, "Part B")
save(d, "hf05-sections-restart-numbering")

# ---------------------------------------------------------------- tables

d = new_doc()
d.add_heading("Quarterly figures", 1)
t = d.add_table(rows=1, cols=5)
t.style = "Table Grid"
for c, h in zip(t.rows[0].cells, ("Region", "Q1", "Q2", "Q3", "Q4")):
	c.text = h
for r in ("North", "South", "East", "West", "Central", "Overseas"):
	row = t.add_row().cells
	row[0].text = r
	for c in row[1:]:
		c.text = f"{rnd.randint(1000, 99999):,}"
d.add_paragraph(para_text())
save(d, "tb01-simple-grid")

d = new_doc()
t = d.add_table(rows=6, cols=4)
t.style = "Table Grid"
t.cell(0, 0).merge(t.cell(0, 3)).text = "Merged title row"
t.cell(1, 0).merge(t.cell(3, 0)).text = "Vertically merged"
for r in range(1, 6):
	for c in range(1, 4):
		t.cell(r, c).text = sentence(3)
for c in t.rows[0].cells:
	c._tc.get_or_add_tcPr().append(parse_xml(f'<w:shd {nsdecls("w")} w:val="clear" w:color="auto" w:fill="1F4E79"/>'))
d.add_paragraph(para_text())
save(d, "tb02-merged-shaded")

d = new_doc()
d.add_heading("Asset register", 1)
t = d.add_table(rows=1, cols=4)
t.style = "Light Grid Accent 1"
for c, h in zip(t.rows[0].cells, ("ID", "Description", "Location", "Value")):
	c.text = h
t.rows[0]._tr.get_or_add_trPr().append(parse_xml(f'<w:tblHeader {nsdecls("w")}/>'))
for i in range(140):
	row = t.add_row().cells
	row[0].text = f"A-{1000 + i}"
	row[1].text = sentence(rnd.randint(3, 12))
	row[2].text = rnd.choice(("Depot", "Town Hall", "Library", "Pool"))
	row[3].text = f"${rnd.randint(100, 90000):,}"
save(d, "tb03-long-repeat-header")

d = new_doc()
t = d.add_table(rows=2, cols=2)
t.style = "Table Grid"
inner = t.cell(1, 1).add_table(rows=3, cols=3)
inner.style = "Table Grid"
for r in inner.rows:
	for c in r.cells:
		c.text = "in"
t.cell(0, 0).text = "Outer"
t.cell(0, 1).text = sentence()
t.cell(1, 0).text = para_text(2)
save(d, "tb04-nested")

d = new_doc("Arial", 9)
d.add_heading("Application form", 1)
t = d.add_table(rows=0, cols=2)
t.style = "Table Grid"
t.alignment = WD_TABLE_ALIGNMENT.CENTER
for lab in ("Full name", "Date of birth", "Address", "Phone", "Email", "Employer", "Signature", "Date"):
	row = t.add_row()
	row.cells[0].text = lab
	row.height = Cm(1)
	row.cells[0].width = Inches(2)
	row.cells[1].width = Inches(4.5)
d.add_paragraph()
p = d.add_paragraph("I agree to the terms ")
p.add_run("☐ Yes  ☐ No")
save(d, "tb05-form-boxes")

d = new_doc("Calibri", 8)
sec = d.sections[0]
t = d.add_table(rows=1, cols=12)
t.style = "Table Grid"
for i, c in enumerate(t.rows[0].cells):
	c.text = f"Col {i + 1}"
for _ in range(30):
	for c in t.add_row().cells:
		c.text = str(rnd.randint(0, 99999))
save(d, "tb06-wide-12-columns")

# ---------------------------------------------------------------- images

d = new_doc()
body(d, 2, "Site photos")
for i in range(4):
	d.add_picture(picture(900, 600, i, f"Photo {i + 1}"), width=Inches(5.5))
	d.add_paragraph(f"Figure {i + 1}. {sentence(6)}", style="Caption")
	d.add_paragraph(para_text(3))
save(d, "im01-inline-pictures")


def anchored_pic(doc, img, wrap="square", width_in=2.5, height_in=1.6, x_in=4.0, y_in=0.2):
	"""Insert an inline picture, then rewrite it as a floating anchor with text wrap."""
	run = doc.paragraphs[-1].add_run()
	inline_shape = run.add_picture(img, width=Inches(width_in), height=Inches(height_in))
	inline = inline_shape._inline
	graphic = inline.find(qn("a:graphic"))
	emu = 914400
	wrap_xml = {"square": '<wp:wrapSquare wrapText="bothSides"/>', "tight": '<wp:wrapTopAndBottom/>',
		"behind": '<wp:wrapNone/>'}[wrap]
	behind = "1" if wrap == "behind" else "0"
	anchor = parse_xml(
		f'<wp:anchor {nsdecls("wp", "a", "pic", "r")} distT="0" distB="0" distL="114300" distR="114300" '
		f'simplePos="0" relativeHeight="2" behindDoc="{behind}" locked="0" layoutInCell="1" allowOverlap="1">'
		f'<wp:simplePos x="0" y="0"/>'
		f'<wp:positionH relativeFrom="column"><wp:posOffset>{int(x_in * emu)}</wp:posOffset></wp:positionH>'
		f'<wp:positionV relativeFrom="paragraph"><wp:posOffset>{int(y_in * emu)}</wp:posOffset></wp:positionV>'
		f'<wp:extent cx="{int(width_in * emu)}" cy="{int(height_in * emu)}"/>'
		f'<wp:effectExtent l="0" t="0" r="0" b="0"/>{wrap_xml}'
		f'<wp:docPr id="{rnd.randint(100, 9999)}" name="Picture"/><wp:cNvGraphicFramePr/></wp:anchor>')
	anchor.append(graphic)
	inline.getparent().replace(inline, anchor)


d = new_doc()
d.add_heading("Floating pictures", 1)
d.add_paragraph(para_text(2))
anchored_pic(d, picture(500, 320, 11, "float right"))
for _ in range(3):
	d.add_paragraph(para_text(6))
anchored_pic(d, picture(500, 320, 12, "float left"), x_in=0.0)
for _ in range(3):
	d.add_paragraph(para_text(6))
save(d, "im02-floating-square-wrap")

d = new_doc()
d.add_paragraph(para_text(2))
anchored_pic(d, picture(1200, 1500, 13, "background"), wrap="behind", width_in=6.0, height_in=7.5, x_in=0.2)
for _ in range(6):
	d.add_paragraph(para_text(5))
save(d, "im03-behind-text")

d = new_doc()
d.add_heading("Large photo", 1)
big = Image.new("RGB", (3000, 2000))
px = big.load()
for y in range(0, 2000, 4):
	for x in range(0, 3000, 4):
		v = (x * 7 + y * 3) % 256
		for dy in range(4):
			for dx in range(4):
				px[x + dx, y + dy] = (v, (v * 3) % 256, 255 - v)
b = io.BytesIO()
big.save(b, "JPEG", quality=85)
b.seek(0)
d.add_picture(b, width=Inches(6.5))
d.add_paragraph(para_text())
save(d, "im04-big-jpeg")

# ---------------------------------------------------------------- columns


def set_columns(section, n, sep=False):
	cols = section._sectPr.find(qn("w:cols"))
	if cols is None:
		cols = parse_xml(f'<w:cols {nsdecls("w")}/>')
		section._sectPr.append(cols)
	cols.set(qn("w:num"), str(n))
	cols.set(qn("w:space"), "720")
	if sep:
		cols.set(qn("w:sep"), "1")


d = new_doc("Cambria", 10)
set_columns(d.sections[0], 2)
d.add_heading("Newsletter", 0)
for _ in range(14):
	d.add_paragraph(para_text())
save(d, "co01-two-columns")

d = new_doc("Calibri", 9)
set_columns(d.sections[0], 3, sep=True)
for i in range(3):
	d.add_heading(f"Column story {i + 1}", 2)
	for _ in range(4):
		d.add_paragraph(para_text(4))
	if i < 2:
		d.add_paragraph().add_run().add_break(WD_BREAK.COLUMN)
save(d, "co02-three-columns-breaks")

d = new_doc()
body(d, 3, "Introduction (one column)")
s = d.add_section(WD_SECTION.CONTINUOUS)
set_columns(s, 2)
for _ in range(6):
	d.add_paragraph(para_text())
s = d.add_section(WD_SECTION.CONTINUOUS)
set_columns(s, 1)
body(d, 3, "Back to one column")
save(d, "co03-mixed-continuous")

# ---------------------------------------------------------------- footnotes / endnotes

FN_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"
EN_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"


def notes_part(d, kind, notes):
	tag = "footnote" if kind == "footnotes" else "endnote"
	ref = "FootnoteReference" if kind == "footnotes" else "EndnoteReference"
	items = [
		f'<w:{tag} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:{tag}>',
		f'<w:{tag} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:{tag}>',
	]
	for i, text in enumerate(notes, start=1):
		items.append(
			f'<w:{tag} w:id="{i}"><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'
			f'<w:{tag}Ref/></w:r><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve"> {text}</w:t></w:r></w:p></w:{tag}>')
	xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:{kind} {nsdecls("w")}>'
		+ "".join(items) + f"</w:{kind}>")
	part = Part(PackURI(f"/word/{kind}.xml"), FN_CT if kind == "footnotes" else EN_CT, xml.encode(), d.part.package)
	d.part.relate_to(part, RT.FOOTNOTES if kind == "footnotes" else RT.ENDNOTES)
	return tag


def note_ref(paragraph, kind, nid):
	tag = "footnote" if kind == "footnotes" else "endnote"
	r = paragraph.add_run()
	r._r.append(parse_xml(f'<w:rPr {nsdecls("w")}><w:vertAlign w:val="superscript"/></w:rPr>'))
	r._r.append(parse_xml(f'<w:{tag}Reference {nsdecls("w")} w:id="{nid}"/>'))


for kind, name, count in (("footnotes", "fn01-footnotes", 18), ("endnotes", "fn02-endnotes", 10)):
	d = new_doc("Times New Roman", 12)
	notes_part(d, kind, [sentence(rnd.randint(6, 30)) for _ in range(count)])
	d.add_heading("Legal memorandum", 1)
	n = 1
	for _ in range(12):
		p = d.add_paragraph(para_text(3))
		if n <= count:
			note_ref(p, kind, n)
			n += 1
		p.add_run(" " + para_text(2))
		if n <= count and rnd.random() < 0.5:
			note_ref(p, kind, n)
			n += 1
	save(d, name)

# ---------------------------------------------------------------- tracked changes and comments

d = new_doc()
d.add_heading("Contract draft with tracked changes", 1)
for i in range(6):
	p = d.add_paragraph(sentence() + " ")
	p._p.append(parse_xml(
		f'<w:ins {nsdecls("w")} w:id="{100 + i}" w:author="Reviewer" w:date="2026-11-01T10:00:00Z">'
		f'<w:r><w:t xml:space="preserve">Inserted clause {i + 1}: {sentence(8)} </w:t></w:r></w:ins>'))
	p._p.append(parse_xml(
		f'<w:del {nsdecls("w")} w:id="{200 + i}" w:author="Reviewer" w:date="2026-11-01T10:05:00Z">'
		f'<w:r><w:delText xml:space="preserve">Deleted wording {sentence(6)} </w:delText></w:r></w:del>'))
	p.add_run(sentence())
save(d, "tc01-tracked-changes")

d = new_doc()
d.add_heading("Report with comments", 1)
for i in range(8):
	p = d.add_paragraph()
	r1 = p.add_run(sentence() + " ")
	r2 = p.add_run(sentence())
	if i % 2 == 0:
		d.add_comment([r2], text=f"Please check this figure ({i}). " + sentence(10), author="A. Reviewer", initials="AR")
	p.add_run(" " + para_text(2))
save(d, "cm01-comments")

# ---------------------------------------------------------------- text boxes


def text_box(d, text, x_in=4.2, y_in=0.0, w_in=2.2, h_in=1.4):
	emu = 914400
	p = d.paragraphs[-1]
	r = p.add_run()
	r._r.append(parse_xml(
		f'<w:drawing {nsdecls("w", "wp", "a")} xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
		f'<wp:anchor distT="45720" distB="45720" distL="114300" distR="114300" simplePos="0" relativeHeight="3" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
		f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>{int(x_in * emu)}</wp:posOffset></wp:positionH>'
		f'<wp:positionV relativeFrom="paragraph"><wp:posOffset>{int(y_in * emu)}</wp:posOffset></wp:positionV>'
		f'<wp:extent cx="{int(w_in * emu)}" cy="{int(h_in * emu)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
		f'<wp:wrapSquare wrapText="bothSides"/><wp:docPr id="{rnd.randint(1000, 9999)}" name="Text Box"/><wp:cNvGraphicFramePr/>'
		f'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
		f'<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{int(w_in * emu)}" cy="{int(h_in * emu)}"/></a:xfrm>'
		f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill>'
		f'<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></wps:spPr>'
		f'<wps:txbx><w:txbxContent><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Key point</w:t></w:r></w:p>'
		f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p></w:txbxContent></wps:txbx>'
		f'<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t"><a:noAutofit/></wps:bodyPr>'
		f'</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>'))


d = new_doc()
d.add_heading("Fact sheet", 1)
d.add_paragraph(para_text(2))
text_box(d, sentence(16))
for _ in range(4):
	d.add_paragraph(para_text(5))
text_box(d, sentence(20), x_in=0.0)
for _ in range(4):
	d.add_paragraph(para_text(5))
save(d, "tx01-text-boxes")

# ---------------------------------------------------------------- lists

d = new_doc()
d.add_heading("Procedure", 1)
for i in range(12):
	d.add_paragraph(sentence(), style="List Number")
	if i % 4 == 0:
		for _ in range(2):
			d.add_paragraph(sentence(7), style="List Number 2")
d.add_heading("Checklist", 1)
for i in range(10):
	d.add_paragraph(sentence(), style="List Bullet")
	if i % 3 == 0:
		d.add_paragraph(sentence(6), style="List Bullet 2")
		d.add_paragraph(sentence(6), style="List Bullet 3")
save(d, "li01-bullets-numbers")

d = new_doc("Arial", 10)
d.add_heading("Leader dots and tabs", 1)
for i in range(25):
	p = d.add_paragraph()
	p.paragraph_format.tab_stops.add_tab_stop(Inches(6.5), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
	p.add_run(f"{i + 1}. {sentence(5)[:-1]}\t{rnd.randint(1, 120)}")
save(d, "li02-tab-leaders")

# ---------------------------------------------------------------- landscape and page sizes

d = new_doc()
body(d, 5, "Portrait part")
s = d.add_section(WD_SECTION.NEW_PAGE)
s.orientation = WD_ORIENT.LANDSCAPE
s.page_width, s.page_height = Inches(11), Inches(8.5)
t = d.add_table(rows=1, cols=8)
t.style = "Table Grid"
for i, c in enumerate(t.rows[0].cells):
	c.text = f"Heading {i + 1}"
for _ in range(15):
	for c in t.add_row().cells:
		c.text = sentence(3)
s = d.add_section(WD_SECTION.NEW_PAGE)
s.orientation = WD_ORIENT.PORTRAIT
s.page_width, s.page_height = Inches(8.5), Inches(11)
body(d, 5, "Portrait again")
save(d, "ls01-landscape-section")

d = new_doc()
s = d.sections[0]
s.page_width, s.page_height = Cm(21), Cm(29.7)
s.left_margin = s.right_margin = Cm(2.5)
body(d, 16, "A4 document")
save(d, "ls02-a4-page")

# ---------------------------------------------------------------- long report


def report(name, pages_paras, font):
	d = new_doc(font, 11)
	sec = d.sections[0]
	sec.header.paragraphs[0].text = "Strategic Plan 2026–2030"
	page_x_of_y(sec.footer.paragraphs[0])
	sec.footer.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
	d.add_heading("Strategic Plan 2026–2030", 0)
	d.add_paragraph("Prepared by the Office of Planning and Performance")
	d.add_page_break()
	ch = 0
	paras = 0
	while paras < pages_paras:
		ch += 1
		d.add_heading(f"{ch}. {sentence(4)[:-1]}", 1)
		for sub in range(3):
			d.add_heading(f"{ch}.{sub + 1} {sentence(3)[:-1]}", 2)
			for _ in range(rnd.randint(3, 6)):
				d.add_paragraph(para_text())
				paras += 1
			if rnd.random() < 0.3:
				d.add_paragraph(sentence(), style="List Bullet")
				d.add_paragraph(sentence(), style="List Bullet")
			if rnd.random() < 0.25:
				t = d.add_table(rows=4, cols=3)
				t.style = "Table Grid"
				for r in t.rows:
					for c in r.cells:
						c.text = str(rnd.randint(1, 999))
			if rnd.random() < 0.15:
				d.add_picture(picture(800, 400, ch * 10 + sub, f"Chart {ch}.{sub}"), width=Inches(5))
		d.add_page_break()
	save(d, name)


report("rp01-report-50-pages", 230, "Calibri")
report("rp02-report-20-pages-cambria", 90, "Cambria")

# ---------------------------------------------------------------- non-Latin


def script_doc(name, font, lines, rtl=False):
	d = new_doc(font, 12)
	for ln in lines:
		p = d.add_paragraph()
		r = p.add_run(ln)
		r.font.name = font
		rpr = r._r.get_or_add_rPr()
		rpr.rFonts.set(qn("w:eastAsia"), font)
		rpr.rFonts.set(qn("w:cs"), font)
		if rtl:
			p._p.get_or_add_pPr().append(parse_xml(f'<w:bidi {nsdecls("w")}/>'))
			rpr.append(parse_xml(f'<w:rtl {nsdecls("w")}/>'))
	save(d, name)


ZH = "本报告概述了市政府在二零二六年度的主要工作成果，包括城市规划、公共交通、教育、卫生和环境保护等方面的进展。我们将继续努力提高公共服务质量。"
JA = "この報告書は、二〇二六年度における市の主な取り組みと成果をまとめたものです。公共交通、教育、福祉の各分野で改善が進みました。"
AR = "يقدم هذا التقرير ملخصاً لأهم إنجازات البلدية خلال عام ٢٠٢٦، بما في ذلك التخطيط العمراني والنقل العام والتعليم والصحة وحماية البيئة."
HE = "דוח זה מסכם את עיקר פעולות העירייה בשנת 2026, כולל תכנון עירוני, תחבורה ציבורית, חינוך ובריאות."
RU = "В настоящем докладе представлены основные результаты работы муниципалитета в 2026 году, включая городское планирование и транспорт."
EL = "Η παρούσα έκθεση συνοψίζει τα κύρια επιτεύγματα του δήμου κατά το έτος 2026, συμπεριλαμβανομένου του πολεοδομικού σχεδιασμού."
HI = "यह रिपोर्ट वर्ष 2026 में नगर निगम की प्रमुख उपलब्धियों का सारांश प्रस्तुत करती है, जिसमें शहरी नियोजन और सार्वजनिक परिवहन शामिल हैं।"
script_doc("nl01-chinese-simsun", "SimSun", [ZH] * 14)
script_doc("nl02-japanese-msmincho", "MS Mincho", [JA] * 14)
script_doc("nl03-arabic-rtl", "Arial", [AR] * 14, rtl=True)
script_doc("nl04-hebrew-rtl", "Arial", [HE] * 14, rtl=True)
script_doc("nl05-cyrillic-greek", "Calibri", [RU, EL] * 8)
script_doc("nl06-devanagari", "Mangal", [HI] * 12)

# ---------------------------------------------------------------- fonts

for name, font in (("fo01-segoe-ui", "Segoe UI"), ("fo02-georgia", "Georgia"), ("fo03-verdana", "Verdana"),
		("fo04-courier-new", "Courier New"), ("fo05-garamond", "Garamond")):
	d = new_doc(font, 11)
	body(d, 10, f"Set in {font}")
	save(d, name)

d = new_doc()
p = d.add_paragraph()
for style in ("bold", "italic", "underline", "strike", "smallcaps", "allcaps", "super", "sub", "highlight", "color"):
	r = p.add_run(f" {style} sample text ")
	if style == "bold": r.bold = True
	if style == "italic": r.italic = True
	if style == "underline": r.underline = True
	if style == "strike": r.font.strike = True
	if style == "smallcaps": r.font.small_caps = True
	if style == "allcaps": r.font.all_caps = True
	if style == "super": r.font.superscript = True
	if style == "sub": r.font.subscript = True
	if style == "highlight": r._r.get_or_add_rPr().append(parse_xml(f'<w:highlight {nsdecls("w")} w:val="yellow"/>'))
	if style == "color": r.font.color.rgb = RGBColor(0xC0, 0x00, 0x00)
for _ in range(8):
	q = d.add_paragraph(para_text())
	q.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
	q.paragraph_format.first_line_indent = Inches(0.5)
	q.paragraph_format.line_spacing = 1.5
save(d, "fo06-run-formatting-justified")

# ---------------------------------------------------------------- misc

d = new_doc()
d.add_heading("Equations", 1)
for i in range(5):
	p = d.add_paragraph(sentence() + " ")
	p._p.append(parse_xml(
		f'<m:oMath {nsdecls("m", "w")}><m:f><m:num><m:r><m:t>a+b</m:t></m:r></m:num><m:den><m:r><m:t>c{i}</m:t></m:r></m:den></m:f>'
		f'<m:r><m:t>=</m:t></m:r><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>'))
	d.add_paragraph(para_text(2))
save(d, "mi01-equations")

d = new_doc()
d.add_heading("Hyperlinks and fields", 1)
for i in range(6):
	p = d.add_paragraph(sentence() + " See ")
	rid = d.part.relate_to(f"https://example.gov/page{i}", RT.HYPERLINK, is_external=True)
	p._p.append(parse_xml(
		f'<w:hyperlink {nsdecls("w", "r")} r:id="{rid}"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>'
		f'<w:t>example.gov/page{i}</w:t></w:r></w:hyperlink>'))
	p.add_run(". Printed ")
	add_field(p, 'DATE \\@ "MMMM d, yyyy"', "November 14, 2026")
save(d, "mi02-hyperlinks-date-field")

d = new_doc()
d.add_heading("Content controls", 1)
for lab in ("Name", "Department", "Start date"):
	p = d.add_paragraph(f"{lab}: ")
	p._p.append(parse_xml(
		f'<w:sdt {nsdecls("w")}><w:sdtPr><w:alias w:val="{lab}"/><w:showingPlcHdr/></w:sdtPr>'
		f'<w:sdtContent><w:r><w:rPr><w:color w:val="808080"/></w:rPr><w:t>Click or tap here to enter text.</w:t></w:r></w:sdtContent></w:sdt>'))
p = d.add_paragraph("Approved: ")
p._p.append(parse_xml(
	f'<w:sdt {nsdecls("w")} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:sdtPr><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr>'
	f'<w:sdtContent><w:r><w:rPr><w:rFonts w:ascii="MS Gothic" w:hAnsi="MS Gothic" w:eastAsia="MS Gothic"/></w:rPr><w:t>☐</w:t></w:r></w:sdtContent></w:sdt>'))
body(d, 3)
save(d, "mi03-content-controls")

d = new_doc()
sp = d.sections[0]._sectPr
sp.append(parse_xml(f'<w:lnNumType {nsdecls("w")} w:countBy="1" w:restart="newPage"/>'))
sp.append(parse_xml(
	f'<w:pgBorders {nsdecls("w")} w:offsetFrom="page"><w:top w:val="double" w:sz="6" w:space="24" w:color="auto"/>'
	f'<w:left w:val="double" w:sz="6" w:space="24" w:color="auto"/><w:bottom w:val="double" w:sz="6" w:space="24" w:color="auto"/>'
	f'<w:right w:val="double" w:sz="6" w:space="24" w:color="auto"/></w:pgBorders>'))
body(d, 10, "Pleading paper style")
save(d, "mi04-line-numbers-page-border")

d = new_doc()
for i in range(10):
	h = d.add_heading(f"Chapter {i + 1}", 1)
	h.paragraph_format.page_break_before = i > 0
	for _ in range(rnd.randint(2, 9)):
		p = d.add_paragraph(para_text())
		p.paragraph_format.keep_together = True
	k = d.add_paragraph(sentence())
	k.paragraph_format.keep_with_next = True
	d.add_paragraph(para_text())
save(d, "mi05-page-breaks-keep")

d = new_doc()
d.add_heading("Contents", 1)
p = d.add_paragraph()
add_field(p, 'TOC \\o "1-3" \\h \\z \\u', "1. Background ........ 2")
d.add_page_break()
for i in range(6):
	d.add_heading(f"{i + 1}. {sentence(3)[:-1]}", 1)
	body(d, 5)
save(d, "mi06-toc-field")

d = new_doc()
sec = d.sections[0]
hp = sec.header.paragraphs[0]
hr = hp.add_run()
hr._r.append(parse_xml(
	f'<w:pict {nsdecls("w")} xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><v:shape id="PowerPlusWaterMarkObject" o:spid="_x0000_s2049" type="#_x0000_t136" '
	f'style="position:absolute;margin-left:0;margin-top:0;width:468pt;height:117pt;rotation:315;z-index:-251654144;'
	f'mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" '
	f'fillcolor="silver" stroked="f"><v:fill opacity=".5"/><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="DRAFT"/></v:shape></w:pict>'))
body(d, 12, "Watermarked draft")
save(d, "mi07-watermark-vml")

print("done")
