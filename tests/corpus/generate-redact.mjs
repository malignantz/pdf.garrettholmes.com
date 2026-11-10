#!/usr/bin/env node
// @ts-nocheck -- plain Node script; checked by running it.
/**
 * Redaction corpus: PDFs with unique secret marker strings in every place a
 * redaction must reach (page text, Form XObjects, hex strings, ActualText,
 * invisible OCR text, images, inline images, line art, annotations, links,
 * form fields, metadata), plus constructs the redact stage must refuse.
 *
 * Called from generate.mjs (`generateRedact(write)`), or on its own:
 * `node tests/corpus/generate-redact.mjs` writes only these files and merges their
 * entries into manifest.json (so the encrypted corpus files keep their bytes).
 *
 * The files are written by hand (a tiny object writer below) so every construct is
 * exactly as described. Geometry of every secret is recorded in the manifest in PDF
 * user space; the tests convert it to stamp fractions.
 *
 * Every secret string starts with "SECRET-" and every text that must survive with
 * "KEEP-", so tests can search for them.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Helvetica advance widths (WinAnsi, per 1000 em) for the characters used here.
const HELV = {
	' ': 278, '-': 333, '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
	A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722,
	O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611
};
export function helvWidth(text, size) {
	let w = 0;
	for (const ch of text) {
		if (!(ch in HELV)) throw new Error(`no width for ${ch}`);
		w += HELV[ch];
	}
	return (w * size) / 1000;
}

/** Minimal PDF writer: objects are strings or { dict, stream } with raw stream bytes. */
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
	stream(dict, data, { flate = false } = {}) {
		let bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : Buffer.from(data);
		let d = dict;
		if (flate) {
			bytes = zlib.deflateSync(bytes);
			d = `${dict.replace(/>>\s*$/, '')} /Filter /FlateDecode >>`;
		}
		return this.add({ dict: d, stream: bytes });
	}
	bytes(rootRef, infoRef) {
		const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
		let pos = parts[0].length;
		const offsets = [];
		this.objs.forEach((o, i) => {
			offsets.push(pos);
			let chunk;
			if (typeof o === 'string') {
				chunk = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
			} else {
				const dict = o.dict.replace(/>>\s*$/, '') + ` /Length ${o.stream.length} >>`;
				chunk = Buffer.concat([
					Buffer.from(`${i + 1} 0 obj\n${dict}\nstream\n`, 'latin1'),
					o.stream,
					Buffer.from('\nendstream\nendobj\n', 'latin1')
				]);
			}
			parts.push(chunk);
			pos += chunk.length;
		});
		let xref = `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`;
		for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
		xref += `trailer\n<< /Size ${this.objs.length + 1} /Root ${rootRef} 0 R${infoRef ? ` /Info ${infoRef} 0 R` : ''} >>\nstartxref\n${pos}\n%%EOF\n`;
		parts.push(Buffer.from(xref, 'latin1'));
		return Buffer.concat(parts);
	}
}

const hex = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
const utf16 = (s) => 'FEFF' + Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase();
/** Raw RGB pixels as a hex string (for inline images). */
function rgbBytes(w, h, px) {
	const out = Buffer.alloc(w * h * 3);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(px(x, y), (y * w + x) * 3);
	return out;
}
/** Image marker: never black, never white, varies in x and y (a "secret" picture). */
const markerPixel = (x, y) => [200, (x * 7 + 40) & 255 | 64, (y * 11 + 30) & 255 | 64];

/** [x0, y0, x1, y1] in user space, PDF y-up. */
const rect = (x0, y0, x1, y1) => [x0, y0, x1, y1];

// ---------------------------------------------------------------------------------------
// redact-basic.pdf
//   p1: every everyday construct under its own box (boxes listed in the manifest).
//   p2: shares p1's content stream and resources, and has no annotations.
//   p3: other content; draws the same Form XObject (shared with p1) and the same image.
// ---------------------------------------------------------------------------------------
function basic() {
	const pdf = new Pdf();
	const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
	const S = 12;

	// Form XObject: a secret and a keeper, 300×50.
	const fx = pdf.stream(
		'<< /Type /XObject /Subtype /Form /BBox [0 0 300 50] /Resources << /Font << /F1 ' + font + ' 0 R >> >> >>',
		`BT /F1 ${S} Tf 0 0 0 rg 1 0 0 1 5 20 Tm (SECRET-FORM-TWO) Tj 1 0 0 1 190 20 Tm (KEEP-CHARLIE) Tj ET`,
		{ flate: true }
	);
	// Image: 64×32 RGB marker picture.
	const im = pdf.stream(
		'<< /Type /XObject /Subtype /Image /Width 64 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>',
		rgbBytes(64, 32, markerPixel),
		{ flate: true }
	);
	const inline = rgbBytes(8, 8, (x, y) => [210, 60 + x * 20, 60 + y * 20]).toString('hex').toUpperCase();

	const l1 = 'KEEP-ALPHA SECRET-LINE-ONE KEEP-BRAVO';
	const l1x = 72 + helvWidth('KEEP-ALPHA ', S);
	const l1w = helvWidth('SECRET-LINE-ONE', S);
	const content = [
		`BT /F1 ${S} Tf 0 0 0 rg 1 0 0 1 72 700 Tm (${l1}) Tj ET`,
		'q 1 0 0 1 72 620 cm /Fx1 Do Q',
		`BT /F1 ${S} Tf 1 0 0 1 72 560 Tm <${hex('SECRET-HEX-THREE')}> Tj ET`,
		`/Span << /ActualText (SECRET-ACTUAL-FOUR) >> BDC BT /F1 ${S} Tf 1 0 0 1 72 520 Tm (XXXX) Tj ET EMC`,
		`/Span << /ActualText <${utf16('SECRET-UTFSIXTEEN-FIVE')}> >> BDC BT /F1 ${S} Tf 1 0 0 1 72 480 Tm (YYYY) Tj ET EMC`,
		`/Span /MC0 BDC BT /F1 ${S} Tf 1 0 0 1 72 500 Tm (ZZZZ) Tj ET EMC`,
		'q 200 0 0 100 300 380 cm /Im1 Do Q',
		`q BT 3 Tr /F1 ${S} Tf 1 0 0 1 310 420 Tm (SECRET-OCR-SIX) Tj ET Q`,
		`q 60 0 0 60 72 380 cm BI /W 8 /H 8 /CS /RGB /BPC 8 /F /AHx ID ${inline}> EI Q`,
		'q 0 0 1 RG 2 w 50 340 m 560 340 l S Q',
		'q 1 0 0 rg 220 335 20 10 re f Q',
		'q 0 0.6 0 rg 470 330 20 20 re f Q',
		`BT /F1 ${S} Tf 0 0 0 rg 1 0 0 1 72 300 Tm (KEEP-DELTA) Tj ET`,
		`BT /F1 ${S} Tf 0 0 0 rg 1 0 0 1 430 700 Tm (KEEP-GOLF) Tj ET`
	].join('\n');
	const c1 = pdf.stream('<< >>', content, { flate: true });
	const res = pdf.add(
		`<< /Font << /F1 ${font} 0 R >> /XObject << /Fx1 ${fx} 0 R /Im1 ${im} 0 R >> /Properties << /MC0 << /ActualText (SECRET-NAMED-ACTUAL) /MCID 0 >> >> >>`
	);

	// p3 content: the same form (unboxed), the same image, and its own secret.
	const c3 = pdf.stream(
		'<< >>',
		[
			`BT /F1 ${S} Tf 0 0 0 rg 1 0 0 1 72 700 Tm (KEEP-ECHO) Tj ET`,
			`BT /F1 ${S} Tf 0 0 0 rg 1 0 0 1 72 600 Tm (SECRET-PTHREE-TWELVE) Tj ET`,
			'q 1 0 0 1 72 400 cm /Fx1 Do Q',
			'q 200 0 0 100 300 200 cm /Im1 Do Q'
		].join('\n'),
		{ flate: true }
	);

	// Annotations of p1.
	const pages = pdf.alloc();
	const p1 = pdf.alloc();
	const apSq = pdf.stream('<< /Type /XObject /Subtype /Form /BBox [0 0 50 60] >>', '1 0 0 RG 2 w 1 1 48 58 re S');
	const square = pdf.add(
		`<< /Type /Annot /Subtype /Square /Rect [405 595 455 655] /Contents (SECRET-ANNOT-SEVEN) /T (SECRET-AUTHOR-SEVENB) /C [1 0 0] /AP << /N ${apSq} 0 R >> /P ${p1} 0 R >>`
	);
	const popup = pdf.add(`<< /Type /Annot /Subtype /Popup /Rect [405 595 455 655] /Parent ${square} 0 R /P ${p1} 0 R >>`);
	pdf.objs[square - 1] = pdf.objs[square - 1].replace(/>>$/, `/Popup ${popup} 0 R >>`);
	const link = pdf.add(
		`<< /Type /Annot /Subtype /Link /Rect [410 600 450 620] /Border [0 0 0] /A << /S /URI /URI (https://example.com/SECRET-LINK-EIGHT) >> >>`
	);
	const note = pdf.add(`<< /Type /Annot /Subtype /Text /Rect [520 200 540 220] /Contents (KEEP-NOTE) /P ${p1} 0 R >>`);
	// A reply to the square, placed away from every box: it quotes the thread, so it goes with it.
	const reply = pdf.add(
		`<< /Type /Annot /Subtype /Text /Rect [520 150 540 170] /Contents (SECRET-REPLY-SEVENC) /IRT ${square} 0 R /P ${p1} 0 R >>`
	);
	// A page thumbnail: 8-bit grey "pixels" that spell a secret.
	const thumbData = 'SECRET-THUMB-FOURTEEN';
	const thumb = pdf.stream(`<< /Width ${thumbData.length} /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 >>`, thumbData);
	// Text field under a box and one outside every box.
	const apField = pdf.stream(
		`<< /Type /XObject /Subtype /Form /BBox [0 0 180 20] /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
		`/Tx BMC BT /F1 10 Tf 0 0 0 rg 2 6 Td (SECRET-FIELD-NINE) Tj ET EMC`
	);
	const field = pdf.add(
		`<< /Type /Annot /Subtype /Widget /FT /Tx /T (ssn) /V (SECRET-FIELD-NINE) /DA (/F1 10 Tf 0 g) /Rect [72 230 252 250] /F 4 /AP << /N ${apField} 0 R >> /P ${p1} 0 R >>`
	);
	const apKeep = pdf.stream(
		`<< /Type /XObject /Subtype /Form /BBox [0 0 180 20] /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
		`/Tx BMC BT /F1 10 Tf 0 0 0 rg 2 6 Td (KEEP-FIELD) Tj ET EMC`
	);
	const keepField = pdf.add(
		`<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (KEEP-FIELD) /DA (/F1 10 Tf 0 g) /Rect [320 230 500 250] /F 4 /AP << /N ${apKeep} 0 R >> /P ${p1} 0 R >>`
	);

	pdf.set(
		p1,
		`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents [${c1} 0 R] /Resources ${res} 0 R /Annots [${square} 0 R ${popup} 0 R ${link} 0 R ${note} 0 R ${reply} 0 R ${field} 0 R ${keepField} 0 R] /Thumb ${thumb} 0 R /StructParents 0 >>`
	);
	const p2 = pdf.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents [${c1} 0 R] /Resources ${res} 0 R >>`);
	const p3 = pdf.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c3} 0 R /Resources ${res} 0 R >>`);
	pdf.set(pages, `<< /Type /Pages /Kids [${p1} 0 R ${p2} 0 R ${p3} 0 R] /Count 3 >>`);
	const xmp = pdf.stream(
		'<< /Type /Metadata /Subtype /XML >>',
		'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>SECRET-XMP-ELEVEN</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
	);
	// Tagged structure: the element for the ZZZZ span says what it means in /Alt.
	const structRoot = pdf.alloc();
	const elem = pdf.add(`<< /Type /StructElem /S /Span /P ${structRoot} 0 R /Pg ${p1} 0 R /K 0 /Alt (SECRET-STRUCT-ALT-FIFTEEN) >>`);
	pdf.set(structRoot, `<< /Type /StructTreeRoot /K [${elem} 0 R] /ParentTree << /Nums [0 [${elem} 0 R]] >> >>`);
	const catalog = pdf.add(
		`<< /Type /Catalog /Pages ${pages} 0 R /MarkInfo << /Marked true >> /StructTreeRoot ${structRoot} 0 R /Metadata ${xmp} 0 R /AcroForm << /Fields [${field} 0 R ${keepField} 0 R] /DA (/F1 10 Tf 0 g) /DR << /Font << /F1 ${font} 0 R >> >> >> >>`
	);
	const info = pdf.add('<< /Title (SECRET-TITLE-TEN) /Author (SECRET-AUTHOR-TEN) >>');

	// Boxes of p1 in user space (y-up) and what each one hides.
	const boxes = {
		line: { rect: rect(l1x - 1, 697, l1x + l1w + 1, 712), hides: ['SECRET-LINE-ONE'] },
		form: { rect: rect(76, 637, 72 + 5 + helvWidth('SECRET-FORM-TWO', S) + 1, 652), hides: ['SECRET-FORM-TWO'] },
		texts: {
			rect: rect(70, 476, 260, 575),
			hides: ['SECRET-HEX-THREE', 'SECRET-ACTUAL-FOUR', 'SECRET-UTFSIXTEEN-FIVE', 'SECRET-NAMED-ACTUAL', 'XXXX', 'YYYY', 'ZZZZ']
		},
		image: { rect: rect(298, 378, 412, 482), hides: ['SECRET-OCR-SIX'], image: rect(300, 380, 500, 480) },
		inline: { rect: rect(66, 374, 138, 446), hides: [], image: rect(72, 380, 132, 440) },
		lineart: { rect: rect(200, 328, 300, 352), hides: [] },
		annots: { rect: rect(400, 590, 460, 660), hides: ['SECRET-ANNOT-SEVEN', 'SECRET-AUTHOR-SEVENB', 'SECRET-REPLY-SEVENC', 'SECRET-LINK-EIGHT'] },
		field: { rect: rect(66, 226, 256, 254), hides: ['SECRET-FIELD-NINE'] }
	};
	return {
		bytes: pdf.bytes(catalog, info),
		meta: {
			pages: 3,
			size: [612, 792],
			boxes,
			keep: ['KEEP-ALPHA', 'KEEP-BRAVO', 'KEEP-CHARLIE', 'KEEP-DELTA', 'KEEP-GOLF'],
			metadataSecrets: ['SECRET-TITLE-TEN', 'SECRET-AUTHOR-TEN', 'SECRET-XMP-ELEVEN'],
			/** Not under any box, but about the redacted page: thumbnail and structure tree. */
			pageSecrets: ['SECRET-THUMB-FOURTEEN', 'SECRET-STRUCT-ALT-FIFTEEN'],
			inlineHex: inline.slice(6, 30),
			p3: { secret: 'SECRET-PTHREE-TWELVE', keep: ['KEEP-ECHO', 'KEEP-CHARLIE'] },
			note: 'p2 shares p1 content stream and resources; p3 shares the Form XObject and image'
		}
	};
}

// ---------------------------------------------------------------------------------------
// redact-geom.pdf: one secret per page at a known user-space spot, pages with /Rotate
// 0/90/180/270, an offset CropBox, and UserUnit 2. Secret "SECRET-GEO-<n>" at
// (secret.x, secret.y) in user space, 12 pt Helvetica; "KEEP-GEO-<n>" elsewhere.
// ---------------------------------------------------------------------------------------
const GEOM = [
	{ media: [0, 0, 400, 600], rotate: 0 },
	{ media: [0, 0, 400, 600], rotate: 90 },
	{ media: [0, 0, 400, 600], rotate: 180 },
	{ media: [0, 0, 400, 600], rotate: 270 },
	{ media: [0, 0, 612, 792], crop: [100, 150, 500, 700], rotate: 0 },
	{ media: [0, 0, 612, 792], crop: [100, 150, 500, 700], rotate: 90 },
	{ media: [0, 0, 300, 400], rotate: 0, userUnit: 2 }
];
function geom() {
	const pdf = new Pdf();
	const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
	const pages = pdf.alloc();
	const kids = [];
	const specs = [];
	GEOM.forEach((g, i) => {
		const n = i + 1;
		const box = g.crop ?? g.media;
		const sx = box[0] + 30;
		const sy = box[1] + (box[3] - box[1]) * 0.6;
		const kx = box[0] + 30;
		const ky = box[1] + (box[3] - box[1]) * 0.3;
		const secret = `SECRET-GEO-${n}`;
		const keep = `KEEP-GEO-${n}`;
		const c = pdf.stream(
			'<< >>',
			`BT /F1 12 Tf 0 0 0 rg 1 0 0 1 ${sx} ${sy} Tm (${secret}) Tj 1 0 0 1 ${kx} ${ky} Tm (${keep}) Tj ET`
		);
		kids.push(
			pdf.add(
				`<< /Type /Page /Parent ${pages} 0 R /MediaBox [${g.media.join(' ')}]${g.crop ? ` /CropBox [${g.crop.join(' ')}]` : ''}${g.rotate ? ` /Rotate ${g.rotate}` : ''}${g.userUnit ? ` /UserUnit ${g.userUnit}` : ''} /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`
			)
		);
		specs.push({
			...g,
			secret,
			keep,
			// Secret text box in user space (y-up): baseline-3 .. baseline+12.
			secretRect: [sx - 1, sy - 3, sx + helvWidth(secret, 12) + 1, sy + 12],
			keepRect: [kx - 1, ky - 3, kx + helvWidth(keep, 12) + 1, ky + 12]
		});
	});
	pdf.set(pages, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
	const catalog = pdf.add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
	return { bytes: pdf.bytes(catalog), meta: { pages: GEOM.length, geom: specs } };
}

// ---------------------------------------------------------------------------------------
// redact-hard.pdf: one construct per page, all with the secret inside the same user-space
// box [200 350 400 450] on a 612×792 page, and "KEEP-HARD-<n>" at the top.
// ---------------------------------------------------------------------------------------
const HARD_BOX = [200, 350, 400, 450];
function hard(jpeg) {
	const pdf = new Pdf();
	const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
	const pages = pdf.alloc();
	const kids = [];
	const cases = [];
	const keep = (n) => `BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 740 Tm (KEEP-HARD-${n}) Tj ET`;
	const page = (name, content, resources, extra = '', fonts = '') => {
		const n = kids.length + 1;
		const c = pdf.stream('<< >>', `${keep(n)}\n${content}`, { flate: true });
		kids.push(
			pdf.add(
				`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R ${fonts}>> ${resources} >>${extra} >>`
			)
		);
		cases.push(name);
	};

	// 1. Type 3 font: every glyph is a filled square; ToUnicode maps codes to letters.
	{
		const proc = pdf.stream('<< >>', '600 0 0 0 600 700 d1 0 0 600 700 re f');
		const tu = pdf.stream(
			'<< >>',
			'/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T3 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <20> <7E> <0020> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end'
		);
		const t3 = pdf.add(
			`<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /sq ${proc} 0 R >> /Encoding << /Type /Encoding /Differences [32 ${Array(95).fill('/sq').join(' ')}] >> /FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(600).join(' ')}] /ToUnicode ${tu} 0 R >>`
		);
		page('type3', 'BT /T3 12 Tf 0 0 0 rg 1 0 0 1 210 400 Tm (SECRET-TYPETHREE) Tj ET', '', '', `/T3 ${t3} 0 R`);
	}
	// 2. Tiling pattern whose cell holds text; a rect larger than the box is filled with it.
	{
		const cell = pdf.stream(
			`<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 150 30] /XStep 150 /YStep 30 /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
			'BT /F1 10 Tf 0 0 0 rg 1 0 0 1 2 10 Tm (SECRET-PATTERN) Tj ET'
		);
		page('pattern', '/Pattern cs /P1 scn 150 300 300 200 re f', `/Pattern << /P1 ${cell} 0 R >>`);
	}
	// 3. Smooth shading painted with `sh`, clipped to a rect larger than the box.
	{
		const sh = pdf.add(
			'<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [150 0 450 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>'
		);
		page('shading', 'q 150 300 300 200 re W n /Sh1 sh Q', `/Shading << /Sh1 ${sh} 0 R >>`);
	}
	// 4. Text in an optional content group that is off by default.
	{
		const ocg = pdf.add('<< /Type /OCG /Name (Hidden layer) >>');
		cases.ocg = ocg;
		page('hidden-layer', '/OC /oc1 BDC BT /F1 12 Tf 0 0 0 rg 1 0 0 1 210 400 Tm (SECRET-HIDDEN-LAYER) Tj ET EMC', `/Properties << /oc1 ${ocg} 0 R >>`);
	}
	// 5. Soft mask whose group draws text (the text shapes the mask).
	{
		const group = pdf.stream(
			`<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Group << /S /Transparency /CS /DeviceGray >> /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
			'0 g 0 0 612 792 re f BT /F1 24 Tf 1 g 1 0 0 1 205 390 Tm (SECRET-SMASK) Tj ET'
		);
		page('soft-mask', '/GS1 gs 0 0 0.5 rg 150 300 300 200 re f', `/ExtGState << /GS1 << /SMask << /S /Luminosity /G ${group} 0 R >> >> >>`);
	}
	// 6. Text used as a clip (render mode 7), then a fill through it.
	page('clip-text', 'q BT 7 Tr /F1 24 Tf 1 0 0 1 205 390 Tm (SECRET-CLIPTEXT) Tj ET 0 0 1 rg 150 300 300 200 re f Q', '');
	// 7. Stencil image mask (1 bit), 64×32, drawn over the box and beyond.
	{
		const bits = Buffer.alloc(8 * 32);
		for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) if ((x * 3 + y * 5) % 7 < 3) bits[y * 8 + (x >> 3)] |= 0x80 >> (x & 7);
		const mask = pdf.stream('<< /Type /XObject /Subtype /Image /Width 64 /Height 32 /ImageMask true /BitsPerComponent 1 /Decode [1 0] >>', bits);
		page('image-mask', 'q 0 0.4 0 rg 150 0 0 150 250 325 cm /M1 Do Q', `/XObject << /M1 ${mask} 0 R >>`);
	}
	// 8. RGB image with a soft mask (alpha) that carries its own picture.
	{
		const alpha = Buffer.alloc(64 * 32);
		for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) alpha[y * 64 + x] = 100 + ((x * 13 + y * 7) % 150);
		const sm = pdf.stream('<< /Type /XObject /Subtype /Image /Width 64 /Height 32 /ColorSpace /DeviceGray /BitsPerComponent 8 >>', alpha, { flate: true });
		const img = pdf.stream(
			`<< /Type /XObject /Subtype /Image /Width 64 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${sm} 0 R >>`,
			rgbBytes(64, 32, markerPixel),
			{ flate: true }
		);
		page('smask-image', 'q 300 0 0 150 150 325 cm /I1 Do Q', `/XObject << /I1 ${img} 0 R >>`);
	}
	// 9. JPEG (DCT) image (the corpus photo, 400×240), partly under the box.
	{
		const img = pdf.stream('<< /Type /XObject /Subtype /Image /Width 400 /Height 240 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', jpeg);
		page('jpeg-image', 'q 300 0 0 150 150 325 cm /J1 Do Q', `/XObject << /J1 ${img} 0 R >>`);
	}
	// 10. Image drawn rotated by 30 degrees across the box.
	{
		const img = pdf.stream(
			'<< /Type /XObject /Subtype /Image /Width 64 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>',
			rgbBytes(64, 32, markerPixel),
			{ flate: true }
		);
		const c = Math.cos(Math.PI / 6);
		const s = Math.sin(Math.PI / 6);
		page('rotated-image', `q ${(240 * c).toFixed(4)} ${(240 * s).toFixed(4)} ${(-120 * s).toFixed(4)} ${(120 * c).toFixed(4)} 260 300 cm /R1 Do Q`, `/XObject << /R1 ${img} 0 R >>`);
	}
	// 11. Text outlined as one vector path that runs beyond the box (a "glyph outline").
	{
		let d = '';
		for (let x = 120; x < 480; x += 12) d += `${x} 395 m ${x + 8} 395 l ${x + 8} 410 l ${x} 410 l h `;
		page('outline-text', `q 0 0 0 rg ${d} f Q`, '');
	}
	// 12. Stroked text (render mode 1) and text with a large character spacing.
	page('stroked-text', 'BT 1 Tr 0.5 w /F1 12 Tf 1 0 0 1 210 420 Tm (SECRET-STROKED) Tj 0 Tr 20 Tc 1 0 0 1 120 380 Tm (SECRET-SPACED) Tj ET', '');

	pdf.set(pages, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
	const catalog = pdf.add(
		`<< /Type /Catalog /Pages ${pages} 0 R /OCProperties << /OCGs [${cases.ocg} 0 R] /D << /OFF [${cases.ocg} 0 R] /Order [${cases.ocg} 0 R] >> >> >>`
	);
	return { bytes: pdf.bytes(catalog), meta: { pages: kids.length, box: HARD_BOX, cases: [...cases] } };
}

// ---------------------------------------------------------------------------------------
// redact-cid.pdf: text in an embedded, subset TrueType font (Type 0, Identity-H), as
// word processors and browsers write it. One line "KEEP-FOXTROT SECRET-CID-THIRTEEN
// KEEP-HOTEL" at (72, 700), 14 pt; the box covers the middle word.
// ---------------------------------------------------------------------------------------
async function cid() {
	const { PDFDocument, rgb } = await import('@cantoo/pdf-lib');
	const fontkit = (await import('@cantoo/fontkit')).default;
	const here = path.dirname(fileURLToPath(import.meta.url));
	const fontBytes = fs.readFileSync(path.join(here, '../../src/lib/engine/fonts/NotoSans-Regular.ttf'));
	const doc = await PDFDocument.create({ updateMetadata: false });
	doc.registerFontkit(fontkit);
	const font = await doc.embedFont(fontBytes, { subset: true });
	const page = doc.addPage([612, 792]);
	const size = 14;
	const before = 'KEEP-FOXTROT ';
	const secret = 'SECRET-CID-THIRTEEN';
	page.drawText(`${before}${secret} KEEP-HOTEL`, { x: 72, y: 700, size, font, color: rgb(0, 0, 0) });
	const x0 = 72 + font.widthOfTextAtSize(before, size);
	const x1 = x0 + font.widthOfTextAtSize(secret, size);
	const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false });
	return { bytes, meta: { pages: 1, secret, keep: ['KEEP-FOXTROT', 'KEEP-HOTEL'], box: [x0 - 1, 695, x1 + 1, 716] } };
}

/** `write(name, bytes, meta)` as in generate.mjs; `outDir` must already hold photo-plain.jpg. */
export async function generateRedact({ write, outDir }) {
	const b = basic();
	write('redact-basic.pdf', b.bytes, { label: null, ...b.meta });
	const g = geom();
	write('redact-geom.pdf', g.bytes, { label: null, ...g.meta });
	const h = hard(fs.readFileSync(path.join(outDir, 'photo-plain.jpg')));
	write('redact-hard.pdf', h.bytes, { label: null, ...h.meta });
	const c = await cid();
	write('redact-cid.pdf', c.bytes, { label: null, ...c.meta });
}

// Standalone run: write only these files and merge their manifest entries.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateRedact({
		outDir,
		write: (name, bytes, meta) => {
			fs.writeFileSync(path.join(outDir, name), bytes);
			manifest[name] = meta;
		}
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
