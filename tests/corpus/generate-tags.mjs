#!/usr/bin/env node
// @ts-nocheck -- plain Node script, like generate.mjs (which tsconfig excludes).
/**
 * Corpus for accessibility tags kept in exports (engine/tags.ts). Every file is written
 * by hand (a tiny object writer below) so each structure construct is exactly as
 * described; the encrypted one goes through qpdf's own --encrypt. Nothing is copied
 * from elsewhere.
 *
 *   tags-basic.pdf    3 pages. /Lang, /MarkInfo, /ViewerPreferences /DisplayDocTitle,
 *                     RoleMap (/Heading1 → /H1), ClassMap, IDTree, /Tabs /S. Document →
 *                     Sect → Heading1, P (runs from page 1 onto page 2: MCR dictionaries
 *                     with their own /Pg), Figure with /Alt (an image on page 2), Span with
 *                     /ActualText, H2, a Table (TR, TH with /ID, TD with /Headers), a Link
 *                     with an OBJR to a link annotation (/StructParent) on page 3. A
 *                     pagination artifact on every page; page 1 uses a named marked-content
 *                     property (/Properties /MC0) for one MCID.
 *   tags-form.pdf     1 page, a tagged form: two text fields and a checkbox, each widget
 *                     with /StructParent and a Form element holding its OBJR.
 *   tags-locked.pdf   tags-basic.pdf, owner-locked (AES-256, no open password, copying
 *                     and editing not allowed).
 *   tags-secret.pdf   2 pages. Page 1: a line of visible text whose struct element has
 *                     secrets in /Alt, /ActualText, /E and /T, a marked-content sequence
 *                     with an inline /ActualText secret around visible glyphs, and a named
 *                     property with an /ActualText secret. Page 2: ordinary tagged text.
 *                     Geometry of the secret line in the manifest (user space).
 *   tags-second.pdf   2 pages, another tagged file (its own RoleMap, IDs "t2-…"), for merges.
 *   tags-broken.pdf   tags-basic.pdf's layout with a ParentTree that names the wrong
 *                     elements for page 1 (and none for page 2): must export without tags.
 *   tags-xobject.pdf  1 page whose tagged paragraph sits inside a Form XObject (MCR with
 *                     /Stm, the form has /StructParents).
 *   tags-scan.pdf     page 1 of ocr-scans.pdf (a typed letter scanned at 300 ppi), its whole
 *                     content one Figure with /Alt: for OCR with tags kept.
 *   tags-photo.pdf    page 1 of print-cap.pdf (a 500 ppi photo JPEG and a label), its whole
 *                     content one Figure with /Alt: for the print-size cap and JPEG repack.
 *
 * Called from generate.mjs (one line), or on its own: node tests/corpus/generate-tags.mjs
 * (writes only these files and merges their manifest entries).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const createQpdf = require('@neslinesli93/qpdf-wasm');
const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');

async function qpdf(args, inputs) {
	const err = [];
	const q = await createQpdf({
		locateFile: () => wasmPath,
		noInitialRun: true,
		preRun: [(m) => m.FS.init(() => null, () => {}, (c) => c !== null && err.push(c))]
	});
	for (const [p, d] of Object.entries(inputs)) q.FS.writeFile(p, d);
	const saved = process.exitCode;
	const code = q.callMain([...args]);
	process.exitCode = saved;
	if (code !== 0 && code !== 3) throw new Error(`qpdf ${args.join(' ')} failed (${code}): ${Buffer.from(err).toString()}`);
	return q.FS.readFile('/out.pdf');
}

/** Minimal PDF writer: objects are strings or { dict, stream }. */
class Pdf {
	constructor() {
		this.objs = [];
	}
	alloc() {
		this.objs.push(null);
		return this.objs.length;
	}
	set(n, body) {
		this.objs[n - 1] = body;
		return n;
	}
	add(body) {
		return this.set(this.alloc(), body);
	}
	stream(dict, data, { flate = true } = {}) {
		let bytes = Buffer.from(data, 'latin1');
		let d = dict;
		if (flate) {
			bytes = zlib.deflateSync(bytes);
			d = `${dict.replace(/>>\s*$/, '')} /Filter /FlateDecode >>`;
		}
		return this.add({ dict: d, stream: bytes });
	}
	bytes(root, info) {
		const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
		let pos = parts[0].length;
		const offsets = [];
		this.objs.forEach((o, i) => {
			if (o === null) throw new Error(`object ${i + 1} not set`);
			offsets.push(pos);
			const chunk =
				typeof o === 'string'
					? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
					: Buffer.concat([
							Buffer.from(`${i + 1} 0 obj\n${o.dict.replace(/>>\s*$/, '')} /Length ${o.stream.length} >>\nstream\n`, 'latin1'),
							o.stream,
							Buffer.from('\nendstream\nendobj\n', 'latin1')
						]);
			parts.push(chunk);
			pos += chunk.length;
		});
		let xref = `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`;
		for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
		const id = '<5441475354414753544147535441475f>';
		xref += `trailer\n<< /Size ${this.objs.length + 1} /Root ${root} 0 R${info ? ` /Info ${info} 0 R` : ''} /ID [${id} ${id}] >>\nstartxref\n${pos}\n%%EOF\n`;
		parts.push(Buffer.from(xref, 'latin1'));
		return Buffer.concat(parts);
	}
}

const R = (n) => `${n} 0 R`;
const utf16 = (s) => '<FEFF' + Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase() + '>';
const text = (size, x, y, s) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${s}) Tj ET`;
const footer = (n) => `/Artifact << /Type /Pagination /Subtype /Footer >> BDC ${text(9, 290, 30, `page ${n}`)} EMC`;
const helv = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

/** Lays out tags-basic (and, with `broken`, tags-broken). */
function basic({ broken = false } = {}) {
	const pdf = new Pdf();
	const font = pdf.add(helv);
	const pages = pdf.alloc();
	const [p1, p2, p3] = [pdf.alloc(), pdf.alloc(), pdf.alloc()];
	const root = pdf.alloc();
	const doc = pdf.alloc();
	const sect = pdf.alloc();
	const h1 = pdf.alloc();
	const para = pdf.alloc();
	const fig = pdf.alloc();
	const span = pdf.alloc();
	const h2 = pdf.alloc();
	const table = pdf.alloc();
	const tr1 = pdf.alloc();
	const tr2 = pdf.alloc();
	const th1 = pdf.alloc();
	const th2 = pdf.alloc();
	const td1 = pdf.alloc();
	const td2 = pdf.alloc();
	const link = pdf.alloc();
	const linkText = pdf.alloc();
	const annot = pdf.alloc();
	const parentTree = pdf.alloc();
	const idTree = pdf.alloc();
	const attr = pdf.add('<< /O /Layout /Placement /Block /SpaceAfter 6 >>');
	const im = pdf.stream('<< /Type /XObject /Subtype /Image /Width 8 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 >>', String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 37) & 255)));

	const c1 = pdf.stream(
		'<< >>',
		[
			`/H1 << /MCID 0 >> BDC ${text(24, 72, 720, 'Heading One')} EMC`,
			`/P << /MCID 1 >> BDC ${text(12, 72, 690, 'The first paragraph starts on page one')} EMC`,
			`/P /MC0 BDC ${text(12, 72, 672, 'and goes on in a second line.')} EMC`,
			footer(1)
		].join('\n')
	);
	const c2 = pdf.stream(
		'<< >>',
		[
			`/P << /MCID 0 >> BDC ${text(12, 72, 720, 'Here the paragraph from page one ends.')} EMC`,
			`/Figure << /MCID 1 >> BDC q 200 0 0 100 72 560 cm /Im1 Do Q EMC`,
			`/Span << /MCID 2 >> BDC ${text(12, 72, 520, 'H2O')} EMC`,
			footer(2)
		].join('\n')
	);
	const c3 = pdf.stream(
		'<< >>',
		[
			`/H2 << /MCID 0 >> BDC ${text(18, 72, 720, 'A Small Table')} EMC`,
			`/TH << /MCID 1 >> BDC ${text(12, 72, 680, 'Name')} EMC`,
			`/TH << /MCID 2 >> BDC ${text(12, 250, 680, 'Value')} EMC`,
			`/TD << /MCID 3 >> BDC ${text(12, 72, 660, 'Alpha')} EMC`,
			`/TD << /MCID 4 >> BDC ${text(12, 250, 660, 'Seven')} EMC`,
			`/Link << /MCID 5 >> BDC ${text(12, 72, 600, 'Back to the start')} EMC`,
			footer(3)
		].join('\n')
	);
	const res1 = `<< /Font << /F1 ${R(font)} >> /Properties << /MC0 << /MCID 2 >> >> >>`;
	const res = `<< /Font << /F1 ${R(font)} >> /XObject << /Im1 ${R(im)} >> >>`;
	pdf.set(pages, `<< /Type /Pages /Kids [${R(p1)} ${R(p2)} ${R(p3)}] /Count 3 >>`);
	const page = (n, c, r, sp, extra = '') =>
		`<< /Type /Page /Parent ${R(pages)} /MediaBox [0 0 612 792] /Resources ${r} /Contents ${R(c)} /StructParents ${sp} /Tabs /S${extra} >>`;
	pdf.set(p1, page(1, c1, res1, 0));
	pdf.set(p2, page(2, c2, res, 1));
	pdf.set(p3, page(3, c3, res, 2, ` /Annots [${R(annot)}]`));
	pdf.set(annot, `<< /Type /Annot /Subtype /Link /Rect [70 595 200 615] /Border [0 0 0] /StructParent 3 /P ${R(p3)} /A << /S /GoTo /D [${R(p1)} /XYZ 0 792 0] >> >>`);

	pdf.set(doc, `<< /Type /StructElem /S /Document /P ${R(root)} /K [${R(sect)}] /Lang (en-US) >>`);
	pdf.set(sect, `<< /Type /StructElem /S /Sect /P ${R(doc)} /K [${R(h1)} ${R(para)} ${R(fig)} ${R(span)} ${R(h2)} ${R(table)} ${R(link)}] /T (Introduction) >>`);
	pdf.set(h1, `<< /Type /StructElem /S /Heading1 /P ${R(sect)} /Pg ${R(p1)} /K 0 /C /Big >>`);
	pdf.set(
		para,
		`<< /Type /StructElem /S /P /P ${R(sect)} /Pg ${R(p1)} /A ${R(attr)} /K [1 2 << /Type /MCR /Pg ${R(p2)} /MCID 0 >>] >>`
	);
	pdf.set(fig, `<< /Type /StructElem /S /Figure /P ${R(sect)} /Pg ${R(p2)} /K 1 /Alt (A grey test picture) /A << /O /Layout /BBox [72 560 272 660] >> >>`);
	pdf.set(span, `<< /Type /StructElem /S /Span /P ${R(sect)} /Pg ${R(p2)} /K [2] /ActualText (H two O) /E (water) >>`);
	pdf.set(h2, `<< /Type /StructElem /S /H2 /P ${R(sect)} /Pg ${R(p3)} /K 0 >>`);
	pdf.set(table, `<< /Type /StructElem /S /Table /P ${R(sect)} /K [${R(tr1)} ${R(tr2)}] /A << /O /Table /Summary (Names and values) >> >>`);
	pdf.set(tr1, `<< /Type /StructElem /S /TR /P ${R(table)} /K [${R(th1)} ${R(th2)}] >>`);
	pdf.set(tr2, `<< /Type /StructElem /S /TR /P ${R(table)} /K [${R(td1)} ${R(td2)}] >>`);
	pdf.set(th1, `<< /Type /StructElem /S /TH /P ${R(tr1)} /Pg ${R(p3)} /K 1 /ID (th-name) /A << /O /Table /Scope /Column >> >>`);
	pdf.set(th2, `<< /Type /StructElem /S /TH /P ${R(tr1)} /Pg ${R(p3)} /K 2 /ID (th-value) /A << /O /Table /Scope /Column >> >>`);
	pdf.set(td1, `<< /Type /StructElem /S /TD /P ${R(tr2)} /Pg ${R(p3)} /K 3 /A << /O /Table /Headers [(th-name)] >> >>`);
	pdf.set(td2, `<< /Type /StructElem /S /TD /P ${R(tr2)} /Pg ${R(p3)} /K 4 /A << /O /Table /Headers [(th-value)] >> >>`);
	pdf.set(link, `<< /Type /StructElem /S /Link /P ${R(sect)} /Pg ${R(p3)} /K [${R(linkText)} << /Type /OBJR /Obj ${R(annot)} >>] /Alt (Go back to page one) >>`);
	pdf.set(linkText, `<< /Type /StructElem /S /Span /P ${R(link)} /Pg ${R(p3)} /K 5 >>`);

	const nums = broken
		? `[0 [${R(fig)} ${R(h2)}] 2 [${R(h2)} ${R(th1)} ${R(th2)} ${R(td1)} ${R(td2)} ${R(linkText)}] 3 ${R(link)}]`
		: `[0 [${R(h1)} ${R(para)} ${R(para)}] 1 [${R(para)} ${R(fig)} ${R(span)}] 2 [${R(h2)} ${R(th1)} ${R(th2)} ${R(td1)} ${R(td2)} ${R(linkText)}] 3 ${R(link)}]`;
	pdf.set(parentTree, `<< /Nums ${nums} >>`);
	pdf.set(idTree, `<< /Names [(th-name) ${R(th1)} (th-value) ${R(th2)}] >>`);
	pdf.set(
		root,
		`<< /Type /StructTreeRoot /K ${R(doc)} /ParentTree ${R(parentTree)} /ParentTreeNextKey 4 /IDTree ${R(idTree)} /RoleMap << /Heading1 /H1 >> /ClassMap << /Big << /O /Layout /LineHeight 30 >> >> >>`
	);
	const info = pdf.add(`<< /Title (Tagged test file) /Producer (pdf.garrettholmes.com corpus) >>`);
	const cat = pdf.add(
		`<< /Type /Catalog /Pages ${R(pages)} /StructTreeRoot ${R(root)} /MarkInfo << /Marked true >> /Lang (en-US) /ViewerPreferences << /DisplayDocTitle true >> >>`
	);
	return pdf.bytes(cat, info);
}

function form() {
	const pdf = new Pdf();
	const font = pdf.add(helv);
	const pages = pdf.alloc();
	const p1 = pdf.alloc();
	const root = pdf.alloc();
	const doc = pdf.alloc();
	const label = pdf.alloc();
	const f1 = pdf.alloc();
	const f2 = pdf.alloc();
	const f3 = pdf.alloc();
	const [w1, w2, w3] = [pdf.alloc(), pdf.alloc(), pdf.alloc()];
	const ap = (s) => pdf.stream('<< /Type /XObject /Subtype /Form /BBox [0 0 200 20] >>', s, { flate: false });
	const apText = ap('/Tx BMC EMC');
	const apOn = pdf.stream('<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] >>', '0 g 2 2 10 10 re f', { flate: false });
	const apOff = pdf.stream('<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] >>', '', { flate: false });
	const c = pdf.stream(
		'<< >>',
		[
			`/P << /MCID 0 >> BDC ${text(12, 72, 720, 'Your name:')} ${text(12, 72, 690, 'Your city:')} ${text(12, 72, 660, 'Subscribe:')} EMC`,
			'q 0.5 G 160 715 200 20 re S 160 685 200 20 re S 160 655 14 14 re S Q'
		].join('\n')
	);
	pdf.set(pages, `<< /Type /Pages /Kids [${R(p1)}] /Count 1 >>`);
	pdf.set(p1, `<< /Type /Page /Parent ${R(pages)} /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${R(font)} >> >> /Contents ${R(c)} /Annots [${R(w1)} ${R(w2)} ${R(w3)}] /StructParents 0 /Tabs /S >>`);
	const da = '(/Helv 12 Tf 0 g)';
	pdf.set(w1, `<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /TU (Your name) /Rect [160 715 360 735] /F 4 /DA ${da} /AP << /N ${R(apText)} >> /P ${R(p1)} /StructParent 1 >>`);
	pdf.set(w2, `<< /Type /Annot /Subtype /Widget /FT /Tx /T (city) /TU (Your city) /Rect [160 685 360 705] /F 4 /DA ${da} /AP << /N ${R(apText)} >> /P ${R(p1)} /StructParent 2 >>`);
	pdf.set(w3, `<< /Type /Annot /Subtype /Widget /FT /Btn /T (subscribe) /TU (Subscribe to the letter) /Rect [160 655 174 669] /F 4 /V /Off /AS /Off /MK << /CA (4) >> /DA (/ZaDb 0 Tf 0 g) /AP << /N << /Yes ${R(apOn)} /Off ${R(apOff)} >> >> /P ${R(p1)} /StructParent 3 >>`);
	pdf.set(doc, `<< /Type /StructElem /S /Document /P ${R(root)} /K [${R(label)} ${R(f1)} ${R(f2)} ${R(f3)}] >>`);
	pdf.set(label, `<< /Type /StructElem /S /P /P ${R(doc)} /Pg ${R(p1)} /K 0 >>`);
	pdf.set(f1, `<< /Type /StructElem /S /Form /P ${R(doc)} /Pg ${R(p1)} /K << /Type /OBJR /Obj ${R(w1)} >> /Alt (Your name) >>`);
	pdf.set(f2, `<< /Type /StructElem /S /Form /P ${R(doc)} /Pg ${R(p1)} /K << /Type /OBJR /Obj ${R(w2)} >> /Alt (Your city) >>`);
	pdf.set(f3, `<< /Type /StructElem /S /Form /P ${R(doc)} /Pg ${R(p1)} /K << /Type /OBJR /Obj ${R(w3)} >> /Alt (Subscribe to the letter) >>`);
	const pt = pdf.add(`<< /Nums [0 [${R(label)}] 1 ${R(f1)} 2 ${R(f2)} 3 ${R(f3)}] >>`);
	pdf.set(root, `<< /Type /StructTreeRoot /K ${R(doc)} /ParentTree ${R(pt)} /ParentTreeNextKey 4 >>`);
	const zadb = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>');
	const acro = pdf.add(`<< /Fields [${R(w1)} ${R(w2)} ${R(w3)}] /DA ${da} /DR << /Font << /Helv ${R(font)} /ZaDb ${R(zadb)} >> >> >>`);
	const cat = pdf.add(`<< /Type /Catalog /Pages ${R(pages)} /AcroForm ${R(acro)} /StructTreeRoot ${R(root)} /MarkInfo << /Marked true >> /Lang (en-GB) >>`);
	return pdf.bytes(cat);
}

/** The secret line on page 1 of tags-secret.pdf, user space. */
const SECRET_BOX = [72, 700, 330, 730];

function secret() {
	const pdf = new Pdf();
	const font = pdf.add(helv);
	const pages = pdf.alloc();
	const [p1, p2] = [pdf.alloc(), pdf.alloc()];
	const root = pdf.alloc();
	const doc = pdf.alloc();
	const line = pdf.alloc();
	const keep = pdf.alloc();
	const named = pdf.alloc();
	const other = pdf.alloc();
	const c1 = pdf.stream(
		'<< >>',
		[
			`/P << /MCID 0 >> BDC ${text(14, 72, 710, 'XXXX blacked out XXXX')} EMC`,
			`/Span << /ActualText (SECRET-INLINE-ACTUAL) /MCID 1 >> BDC ${text(14, 260, 710, 'YYYY')} EMC`,
			`/Span /MC0 BDC ${text(14, 72, 600, 'ZZZZ')} EMC`,
			`/P << /MCID 3 >> BDC ${text(12, 72, 500, 'KEEP-THIS-LINE stays')} EMC`
		].join('\n')
	);
	const c2 = pdf.stream('<< >>', `/P << /MCID 0 >> BDC ${text(12, 72, 720, 'KEEP-PAGE-TWO text')} EMC`);
	pdf.set(pages, `<< /Type /Pages /Kids [${R(p1)} ${R(p2)}] /Count 2 >>`);
	pdf.set(p1, `<< /Type /Page /Parent ${R(pages)} /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${R(font)} >> /Properties << /MC0 << /MCID 2 /ActualText ${utf16('SECRET-NAMED-PROPERTY')} >> >> >> /Contents ${R(c1)} /StructParents 0 >>`);
	pdf.set(p2, `<< /Type /Page /Parent ${R(pages)} /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${R(font)} >> >> /Contents ${R(c2)} /StructParents 1 >>`);
	pdf.set(doc, `<< /Type /StructElem /S /Document /P ${R(root)} /K [${R(line)} ${R(named)} ${R(keep)} ${R(other)}] >>`);
	pdf.set(
		line,
		`<< /Type /StructElem /S /P /P ${R(doc)} /Pg ${R(p1)} /K [0 1] /Alt (SECRET-STRUCT-ALT) /ActualText ${utf16('SECRET-STRUCT-ACTUAL')} /E (SECRET-STRUCT-EXPANSION) /T (SECRET-STRUCT-TITLE) >>`
	);
	pdf.set(named, `<< /Type /StructElem /S /Span /P ${R(doc)} /Pg ${R(p1)} /K 2 >>`);
	pdf.set(keep, `<< /Type /StructElem /S /P /P ${R(doc)} /Pg ${R(p1)} /K 3 >>`);
	pdf.set(other, `<< /Type /StructElem /S /P /P ${R(doc)} /Pg ${R(p2)} /K 0 /Alt (KEEP-ALT-TWO) >>`);
	const pt = pdf.add(`<< /Nums [0 [${R(line)} ${R(line)} ${R(named)} ${R(keep)}] 1 [${R(other)}]] >>`);
	pdf.set(root, `<< /Type /StructTreeRoot /K ${R(doc)} /ParentTree ${R(pt)} /ParentTreeNextKey 2 >>`);
	const cat = pdf.add(`<< /Type /Catalog /Pages ${R(pages)} /StructTreeRoot ${R(root)} /MarkInfo << /Marked true >> /Lang (en) >>`);
	return pdf.bytes(cat);
}

function second() {
	const pdf = new Pdf();
	const font = pdf.add(helv);
	const pages = pdf.alloc();
	const [p1, p2] = [pdf.alloc(), pdf.alloc()];
	const root = pdf.alloc();
	const doc = pdf.alloc();
	const h = pdf.alloc();
	const a = pdf.alloc();
	const b = pdf.alloc();
	const c1 = pdf.stream('<< >>', [`/Title << /MCID 0 >> BDC ${text(20, 72, 720, 'Second File')} EMC`, `/P << /MCID 1 >> BDC ${text(12, 72, 690, 'Text of the second file, page one.')} EMC`, footer(1)].join('\n'));
	const c2 = pdf.stream('<< >>', [`/P << /MCID 0 >> BDC ${text(12, 72, 720, 'Text of the second file, page two.')} EMC`, footer(2)].join('\n'));
	pdf.set(pages, `<< /Type /Pages /Kids [${R(p1)} ${R(p2)}] /Count 2 >>`);
	const res = `<< /Font << /F1 ${R(font)} >> >>`;
	pdf.set(p1, `<< /Type /Page /Parent ${R(pages)} /MediaBox [0 0 612 792] /Resources ${res} /Contents ${R(c1)} /StructParents 0 >>`);
	pdf.set(p2, `<< /Type /Page /Parent ${R(pages)} /MediaBox [0 0 612 792] /Resources ${res} /Contents ${R(c2)} /StructParents 1 >>`);
	pdf.set(doc, `<< /Type /StructElem /S /Document /P ${R(root)} /K [${R(h)} ${R(a)} ${R(b)}] >>`);
	pdf.set(h, `<< /Type /StructElem /S /Title /P ${R(doc)} /Pg ${R(p1)} /K 0 /ID (t2-title) >>`);
	pdf.set(a, `<< /Type /StructElem /S /P /P ${R(doc)} /Pg ${R(p1)} /K 1 >>`);
	pdf.set(b, `<< /Type /StructElem /S /P /P ${R(doc)} /Pg ${R(p2)} /K 0 /ActualText (Second file, second page) >>`);
	const pt = pdf.add(`<< /Nums [0 [${R(h)} ${R(a)}] 1 [${R(b)}]] >>`);
	const ids = pdf.add(`<< /Names [(t2-title) ${R(h)}] >>`);
	pdf.set(root, `<< /Type /StructTreeRoot /K [${R(doc)}] /ParentTree ${R(pt)} /ParentTreeNextKey 2 /IDTree ${R(ids)} /RoleMap << /Title /H1 >> >>`);
	const cat = pdf.add(`<< /Type /Catalog /Pages ${R(pages)} /StructTreeRoot ${R(root)} /MarkInfo << /Marked true >> /Lang (en-US) >>`);
	return pdf.bytes(cat);
}

function xobject() {
	const pdf = new Pdf();
	const font = pdf.add(helv);
	const pages = pdf.alloc();
	const p1 = pdf.alloc();
	const root = pdf.alloc();
	const doc = pdf.alloc();
	const h = pdf.alloc();
	const para = pdf.alloc();
	const fx = pdf.alloc();
	pdf.set(
		fx,
		{
			dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 400 40] /Resources << /Font << /F1 ${R(font)} >> >> /StructParents 1 /Filter /FlateDecode >>`,
			stream: zlib.deflateSync(Buffer.from(`/P << /MCID 0 >> BDC ${text(12, 0, 15, 'Text drawn inside a form XObject.')} EMC`, 'latin1'))
		}
	);
	const c = pdf.stream('<< >>', [`/H1 << /MCID 0 >> BDC ${text(20, 72, 720, 'Form XObject Test')} EMC`, 'q 1 0 0 1 72 640 cm /Fx1 Do Q'].join('\n'));
	pdf.set(pages, `<< /Type /Pages /Kids [${R(p1)}] /Count 1 >>`);
	pdf.set(p1, `<< /Type /Page /Parent ${R(pages)} /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${R(font)} >> /XObject << /Fx1 ${R(fx)} >> >> /Contents ${R(c)} /StructParents 0 >>`);
	pdf.set(doc, `<< /Type /StructElem /S /Document /P ${R(root)} /K [${R(h)} ${R(para)}] >>`);
	pdf.set(h, `<< /Type /StructElem /S /H1 /P ${R(doc)} /Pg ${R(p1)} /K 0 >>`);
	pdf.set(para, `<< /Type /StructElem /S /P /P ${R(doc)} /Pg ${R(p1)} /K << /Type /MCR /Stm ${R(fx)} /MCID 0 >> >>`);
	const pt = pdf.add(`<< /Nums [0 [${R(h)}] 1 [${R(para)}]] >>`);
	pdf.set(root, `<< /Type /StructTreeRoot /K ${R(doc)} /ParentTree ${R(pt)} /ParentTreeNextKey 2 >>`);
	const cat = pdf.add(`<< /Type /Catalog /Pages ${R(pages)} /StructTreeRoot ${R(root)} /MarkInfo << /Marked true >> /Lang (en-US) >>`);
	return pdf.bytes(cat);
}

/**
 * `bytes` (one page) with its whole content as one tagged Figure: the page's content
 * streams joined into one, wrapped in `/Figure << /MCID 0 >> BDC … EMC`, and a structure
 * tree (Document → Figure with /Alt) added. Made with qpdf's JSON update.
 */
async function tagWholePage(bytes, alt) {
	const json = async (extra) => JSON.parse(Buffer.from(await qpdfOut(['--json=2', '--json-key=qpdf', '--json-key=pages', ...extra, '/in.pdf', '/out.pdf'], { '/in.pdf': bytes })).toString());
	const first = await json(['--json-stream-data=none']);
	const page = first.pages[0];
	const contents = page.contents;
	const data = await json(['--json-stream-data=inline', '--decode-level=generalized', ...contents.map((c) => `--json-object=${c.replace(/ (\d+) R$/, ',$1')}`)]);
	const joined = Buffer.concat(contents.flatMap((c) => [Buffer.from(data.qpdf[1][`obj:${c}`].stream.data, 'base64'), Buffer.from('\n')]));
	const body = Buffer.concat([Buffer.from('/Figure << /MCID 0 >> BDC\n'), joined, Buffer.from('\nEMC\n')]);
	const objs = first.qpdf[1];
	const trailer = objs.trailer.value;
	const catRef = trailer['/Root'];
	let next = first.qpdf[0].maxobjectid + 1;
	const ref = () => `${next++} 0 R`;
	const [content, root, doc, fig, pt] = [ref(), ref(), ref(), ref(), ref()];
	const pageDict = { ...objs[`obj:${page.object}`].value, '/Contents': content, '/StructParents': 0 };
	const updates = {
		[`obj:${content}`]: { stream: { dict: {}, data: body.toString('base64') } },
		[`obj:${page.object}`]: { value: pageDict },
		[`obj:${root}`]: { value: { '/Type': '/StructTreeRoot', '/K': doc, '/ParentTree': pt, '/ParentTreeNextKey': 1 } },
		[`obj:${doc}`]: { value: { '/Type': '/StructElem', '/S': '/Document', '/P': root, '/K': [fig] } },
		[`obj:${fig}`]: { value: { '/Type': '/StructElem', '/S': '/Figure', '/P': doc, '/Pg': page.object, '/K': 0, '/Alt': `u:${alt}` } },
		[`obj:${pt}`]: { value: { '/Nums': [0, [fig]] } },
		[`obj:${catRef}`]: { value: { ...objs[`obj:${catRef}`].value, '/StructTreeRoot': root, '/MarkInfo': { '/Marked': true }, '/Lang': 'u:en-US' } }
	};
	return qpdf(['/in.pdf', '--update-from-json=/u.json', '/out.pdf'], { '/in.pdf': bytes, '/u.json': Buffer.from(JSON.stringify({ qpdf: [first.qpdf[0], updates] })) });
}

async function qpdfOut(args, inputs) {
	const out = args[args.length - 1];
	const q = await createQpdf({ locateFile: () => wasmPath, noInitialRun: true, preRun: [(m) => m.FS.init(() => null, () => {}, () => {})] });
	for (const [p, d] of Object.entries(inputs)) q.FS.writeFile(p, d);
	const saved = process.exitCode;
	const code = q.callMain([...args]);
	process.exitCode = saved;
	if (code !== 0 && code !== 3) throw new Error(`qpdf ${args.join(' ')} failed (${code})`);
	return q.FS.readFile(out);
}

export default async function generateTagsCorpus(write, outDir = path.join(here, 'files')) {
	const basicBytes = basic();
	const counts = { elements: 16, alt: 2, actualText: 1 };
	write('tags-basic.pdf', basicBytes, { pages: 3, label: 'tags', tagged: true, ...counts, lang: 'en-US' });
	write('tags-form.pdf', form(), { pages: 1, label: 'tags', tagged: true, elements: 5, alt: 3, actualText: 0, fields: ['name', 'city', 'subscribe'] });
	write(
		'tags-locked.pdf',
		await qpdf(['/in.pdf', '--encrypt', '--user-password=', '--owner-password=owner', '--bits=256', '--extract=n', '--modify=none', '--', '/out.pdf'], { '/in.pdf': basicBytes }),
		{ pages: 3, label: 'tags', tagged: true, ...counts, password: null }
	);
	write('tags-secret.pdf', secret(), {
		pages: 2,
		label: 'tags',
		tagged: true,
		secretBox: SECRET_BOX,
		secrets: ['SECRET-STRUCT-ALT', 'SECRET-STRUCT-ACTUAL', 'SECRET-STRUCT-EXPANSION', 'SECRET-STRUCT-TITLE', 'SECRET-INLINE-ACTUAL'],
		namedSecret: 'SECRET-NAMED-PROPERTY'
	});
	write('tags-second.pdf', second(), { pages: 2, label: 'tags', tagged: true, elements: 4, alt: 0, actualText: 1 });
	write('tags-broken.pdf', basic({ broken: true }), { pages: 3, label: 'tags', tagged: true, expect: 'tags dropped: ParentTree names the wrong elements' });
	write('tags-xobject.pdf', xobject(), { pages: 1, label: 'tags', tagged: true, elements: 3 });
	// Pages made by the other generators (they run first), tagged here as one Figure each.
	const one = async (file) => qpdf(['--empty', '--pages', '/in.pdf', '1', '--', '/out.pdf'], { '/in.pdf': fs.readFileSync(path.join(outDir, file)) });
	write('tags-scan.pdf', await tagWholePage(await one('ocr-scans.pdf'), 'A scanned typed letter'), {
		pages: 1,
		label: 'tags',
		tagged: true,
		elements: 2,
		note: 'ocr-scans.pdf page 1 (a readable typed letter, 300 ppi) as one tagged Figure: OCR makes it searchable'
	});
	write('tags-photo.pdf', await tagWholePage(await one('print-cap.pdf'), 'A test photo'), {
		pages: 1,
		label: 'tags',
		tagged: true,
		elements: 2,
		note: 'print-cap.pdf page 1 (a 500 ppi photo JPEG) as one tagged Figure: the print-size cap and the JPEG repack change it'
	});
}

// Standalone: write only these files and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(here, 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateTagsCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
