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

// ---------------------------------------------------------------------------------------
// redact-table.pdf: drawings next to and under boxes, to test which drawings may stay
// (plain rules, borders, backgrounds that run right through a box) and which must go.
// Every drawing is its own painting operation; `drawings` lists them with the box that
// covers them and whether the stage must keep it. Rects are user space, y up.
// ---------------------------------------------------------------------------------------
function table() {
	const pdf = new Pdf();
	const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
	const S = 12;
	const text = (x, y, t) => `BT /F1 ${S} Tf 0 0 0 rg 1 0 0 1 ${x} ${y} Tm (${t}) Tj ET`;
	const ops = [];
	const drawings = {};
	const boxes = {};
	// Table: 3 columns × 3 rows, grid stroked as one path of horizontal and vertical lines.
	const xs = [72, 222, 372, 522];
	const ys = [610, 640, 670, 700];
	let grid = '';
	for (const y of ys) grid += `72 ${y} m 522 ${y} l `;
	for (const x of xs) grid += `${x} 610 m ${x} 700 l `;
	// Shaded middle cell of row 2 (drawn before the grid).
	ops.push('q 0.85 g 222 640 150 30 re f Q');
	drawings.shadedCell = { rect: [222, 640, 372, 670], keep: true };
	ops.push(`q 0 G 1 w ${grid}S Q`);
	drawings.grid = { rect: [72, 610, 522, 700], keep: true };
	ops.push(text(80, 680, 'KEEP-CELL-A'), text(230, 680, 'SECRET-CELL-B'), text(380, 680, 'KEEP-CELL-C'));
	ops.push(text(230, 650, 'SECRET-SHADED'), text(80, 650, 'KEEP-CELL-D'));
	ops.push(text(152, 620, 'SECRET-RA'), text(226, 620, 'SECRET-RB'), text(380, 620, 'KEEP-CELL-F'));
	boxes.cell = { rect: [226, 674, 368, 696], hides: ['SECRET-CELL-B'] };
	boxes.shaded = { rect: [226, 644, 368, 666], hides: ['SECRET-SHADED'] };
	// Crosses the vertical grid line at x = 222, which runs right through it.
	boxes.row3 = { rect: [150, 615, 300, 635], hides: ['SECRET-RA', 'SECRET-RB'] };

	// Underline longer than the box on both sides: stays. Underline exactly under the word: goes.
	const longW = helvWidth('SECRET-UNDERLINED', S);
	ops.push(text(72, 560, 'SECRET-UNDERLINED'), 'q 0 G 0.75 w 50 557 m 300 557 l S Q');
	drawings.longUnderline = { rect: [50, 557, 300, 557], keep: true };
	boxes.underlined = { rect: [70, 554, 72 + longW + 3, 574], hides: ['SECRET-UNDERLINED'] };
	const shortW = helvWidth('SECRET-SHORTLINE', S);
	ops.push(text(330, 560, 'SECRET-SHORTLINE'), `q 0 G 0.75 w 330 557 m ${330 + shortW} 557 l S Q`);
	drawings.shortUnderline = { rect: [330, 557, 330 + shortW, 557], keep: false };
	boxes.shortline = { rect: [326, 553, 330 + shortW + 4, 574], hides: ['SECRET-SHORTLINE'] };

	// Barcode-like cluster: 30 thin filled bars inside one box: goes.
	let bars = '';
	for (let i = 0; i < 30; i++) bars += `${80 + i * 3} 470 ${i % 3 === 0 ? 2 : 1} 30 re `;
	ops.push(`q 0 g ${bars}f Q`);
	drawings.barcode = { rect: [80, 470, 169, 500], keep: false };
	boxes.barcode = { rect: [75, 465, 175, 505], hides: [] };
	// Diagonal line through a box: goes.
	ops.push('q 0 0 1 RG 1 w 300 450 m 500 520 l S Q');
	drawings.diagonal = { rect: [300, 450, 500, 520], keep: false };
	boxes.diagonal = { rect: [380, 470, 420, 500], hides: [] };
	// Bar of a chart ending under a box: goes.
	ops.push('q 0.2 0.4 0.8 rg 330 380 30 60 re f Q', text(400, 400, 'KEEP-BAR-LABEL'));
	drawings.bar = { rect: [330, 380, 360, 440], keep: false };
	boxes.bar = { rect: [320, 420, 370, 460], hides: [] };
	// A glyph outline ("O" drawn with curves): goes.
	const k = 0.5523 * 15;
	ops.push(
		`q 0 g 135 380 m ${135 + k} 380 150 ${395 - k} 150 395 c 150 ${395 + k} ${135 + k} 410 135 410 c ${135 - k} 410 120 ${395 + k} 120 395 c 120 ${395 - k} ${135 - k} 380 135 380 c h f Q`
	);
	drawings.outline = { rect: [120, 380, 150, 410], keep: false };
	boxes.outline = { rect: [110, 375, 160, 415], hides: [] };
	// A rule drawn as a thin filled rectangle across the page: stays.
	ops.push('q 0 g 50 300 510 1.5 re f Q', text(72, 320, 'KEEP-ABOVE-RULE'));
	drawings.rule = { rect: [50, 300, 560, 301.5], keep: true };
	boxes.rule = { rect: [200, 290, 260, 310], hides: [] };

	const c = pdf.stream('<< >>', ops.join('\n'), { flate: true });
	const pages = pdf.alloc();
	const page = pdf.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
	pdf.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
	const catalog = pdf.add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
	return {
		bytes: pdf.bytes(catalog),
		meta: { pages: 1, boxes, drawings, keep: ['KEEP-CELL-A', 'KEEP-CELL-C', 'KEEP-CELL-D', 'KEEP-CELL-F', 'KEEP-BAR-LABEL', 'KEEP-ABOVE-RULE'] }
	};
}

// ---------------------------------------------------------------------------------------
// redact-survey.pdf: ordinary constructs that broke the redact stage on real files
// (survey of 2026-11-10). Page 1: the box covers SECRET-SURVEY-LINE only, and
// everything else is away from it and must come through unchanged:
//  - an image whose /ColorSpace is an indirect object (MuPDF's garbage=compact save
//    dropped the stream data of such an image once it had been read through mupdf.js);
//  - a Form XObject with indirect /Resources;
//  - a smooth shading (`sh`) with an indirect /Function (the device pass's shade
//    wrapper freed a shade MuPDF still owned);
//  - a `null` entry in /Annots next to a link.
// ---------------------------------------------------------------------------------------
function survey() {
	const pdf = new Pdf();
	const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
	const text = (x, y, t, size = 12) => `BT /F1 ${size} Tf 0 0 0 rg 1 0 0 1 ${x} ${y} Tm (${t}) Tj ET`;
	const cs = pdf.add('[/CalRGB << /WhitePoint [0.9505 1 1.089] >>]');
	const img = pdf.stream(`<< /Type /XObject /Subtype /Image /Width 64 /Height 32 /ColorSpace ${cs} 0 R /BitsPerComponent 8 >>`, rgbBytes(64, 32, markerPixel), {
		flate: true
	});
	const formRes = pdf.add(`<< /Font << /F1 ${font} 0 R >> >>`);
	const form = pdf.stream(`<< /Type /XObject /Subtype /Form /BBox [0 0 300 40] /Resources ${formRes} 0 R >>`, text(5, 15, 'KEEP-FORM-TEXT'));
	const fn = pdf.add('<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>');
	const sh = pdf.add(`<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [72 0 372 0] /Function ${fn} 0 R >>`);
	const link = pdf.add('<< /Type /Annot /Subtype /Link /Rect [72 100 272 120] /Border [0 0 0] /A << /S /URI /URI (https://example.com/keep) >> >>');
	const secretW = helvWidth('SECRET-SURVEY-LINE', 12);
	const ops = [
		text(72, 700, 'SECRET-SURVEY-LINE'),
		text(72, 600, 'KEEP-SURVEY-TEXT'),
		'q 200 0 0 100 300 400 cm /I1 Do Q',
		'q 1 0 0 1 72 500 cm /Fm1 Do Q',
		'q 72 200 300 60 re W n /Sh1 sh Q'
	];
	const c = pdf.stream('<< >>', ops.join('\n'), { flate: true });
	const pages = pdf.alloc();
	const page = pdf.add(
		`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Annots [null ${link} 0 R] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /I1 ${img} 0 R /Fm1 ${form} 0 R >> /Shading << /Sh1 ${sh} 0 R >> >> >>`
	);
	// Page 2: tightly set lines. The box over SECRET-TIGHT-LINE (its line box plus 1 pt, as
	// a person draws it) reaches into the nominal (ascent/descent) boxes of the big title
	// above and of the next line, but not into their ink. Both must stay.
	const c2 = pdf.stream(
		'<< >>',
		[
			text(72, 520, 'KEEP-BIG-TITLE', 36),
			text(72, 505, 'SECRET-TIGHT-LINE'),
			text(72, 490, 'KEEP-NEXT-LINE'),
			text(72, 400, 'KEEP-FAR-LINE'),
			// Times, 20 pt: the box over SECRET-TIMES-LINE ends just above the capitals of
			// the next line (0.7 em above its baseline; Times capitals are 0.66 em tall).
			'BT /F2 20 Tf 0 0 0 rg 1 0 0 1 72 300 Tm (SECRET-TIMES-LINE) Tj ET',
			'BT /F2 20 Tf 0 0 0 rg 1 0 0 1 72 281 Tm (KEEP-TIMES-NEXT) Tj ET'
		].join('\n'),
		{ flate: true }
	);
	const times = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>');
	const page2 = pdf.add(
		`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c2} 0 R /Resources << /Font << /F1 ${font} 0 R /F2 ${times} 0 R >> >> >>`
	);
	// Page 3: "bold" drawn as fill plus a thin stroke (2 Tr, 0.3 w inside the text
	// object), as word processors do for fonts without a bold face. MuPDF's rewrite
	// dropped the line width, so this text came out much heavier.
	const c3 = pdf.stream(
		'<< >>',
		[
			text(72, 700, 'SECRET-BOLD-PAGE'),
			'BT /F1 28 Tf 0 0 0 rg 2 Tr 0.3 w 1 0 0 1 72 600 Tm (KEEP-PSEUDO-BOLD) Tj 0 Tr 0 w ET',
			'2 w 72 560 m 300 560 l S'
		].join('\n'),
		{ flate: true }
	);
	const page3 = pdf.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c3} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
	// Page 4: a page-wide colour gradient (a background) under white text.
	const bg = pdf.add('<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 0 792] /Function << /FunctionType 2 /Domain [0 1] /C0 [0.9 0.3 0.5] /C1 [0.3 0.3 0.9] /N 1 >> /Extend [true true] >>');
	const c4 = pdf.stream(
		'<< >>',
		['q 0 0 612 792 re W n /Bg sh Q', 'BT /F1 12 Tf 1 1 1 rg 1 0 0 1 72 700 Tm (SECRET-ON-GRADIENT) Tj ET', 'BT /F1 12 Tf 1 1 1 rg 1 0 0 1 72 600 Tm (KEEP-WHITE-TEXT) Tj ET'].join('\n'),
		{ flate: true }
	);
	const page4 = pdf.add(
		`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c4} 0 R /Resources << /Font << /F1 ${font} 0 R >> /Shading << /Bg ${bg} 0 R >> >> >>`
	);
	// Page 5: a line with horizontal scaling and TJ adjustments, far from the box: MuPDF's
	// rewrite of the page moves its glyphs, and the stage must notice and refuse.
	const c5 = pdf.stream(
		'<< >>',
		[text(80, 300, 'SECRET-NEAR-SCALED'), 'BT /F1 24 Tf 0 0 0 rg 50 Tz 1 0 0 1 72 200 Tm (KEEP-SCALED) Tj [( T)-200(J)-200(ADJUST)] TJ ET'].join('\n'),
		{ flate: true }
	);
	const page5 = pdf.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c5} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
	pdf.set(pages, `<< /Type /Pages /Kids [${page} 0 R ${page2} 0 R ${page3} 0 R ${page4} 0 R ${page5} 0 R] /Count 5 >>`);
	const catalog = pdf.add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
	return {
		bytes: pdf.bytes(catalog),
		meta: {
			pages: 5,
			box: { rect: [70, 695, 72 + secretW + 2, 712], hides: ['SECRET-SURVEY-LINE'] },
			tight: { line: 'SECRET-TIGHT-LINE', keep: ['KEEP-BIG-TITLE', 'KEEP-NEXT-LINE', 'KEEP-FAR-LINE'] },
			times: { line: 'SECRET-TIMES-LINE', keep: ['KEEP-TIMES-NEXT'] },
			bold: { line: 'SECRET-BOLD-PAGE', keep: 'KEEP-PSEUDO-BOLD', rect: [72, 590, 400, 625] },
			scaled: { line: 'SECRET-NEAR-SCALED' },
			gradient: { line: 'SECRET-ON-GRADIENT' },
			image: [300, 400, 500, 500],
			shading: [72, 200, 372, 260],
			keep: ['KEEP-SURVEY-TEXT', 'KEEP-FORM-TEXT']
		}
	};
}

/**
 * Second survey round (2026-11-11). Each page has the trait of a real file that went wrong;
 * `meta.cases[i]` gives page i+1's box (user space) and what must stay. Helvetica throughout.
 * 1. A lone space drawn as its own text object under the box, over a 40 pt lowercase line
 *    set 34 pt lower (Hebrew government report): MuPDF's first text pass leaves such a space,
 *    and the second pass, over its em box (a full line high), took glyphs of the big line.
 * 2. The same lines, the box 2 pt above the ink of the lowercase line (Arabic title, Greek
 *    dictionary): the glyph core band (0.6 em then) reached into the box, and the whole
 *    line went without a word in the warning.
 * 3. A line with 96.67 % horizontal scaling and TJ adjustments away from the box (Korean
 *    legal form): every MuPDF rewrite of the page moves its glyphs about 0.3 pt; the image
 *    pass rewrote the page a second time after the "moved text" check. The box over
 *    SECRET-OVER-IMAGE touches an image, the box over SECRET-NO-IMAGE does not.
 * 4. A highlight annotation over two lines and a note icon next to the box (pdf.js tests):
 *    both are removed whole, which the export did not say.
 * 5. A small colour gradient next to a label (axis legend): removed whole, unannounced.
 * 6. A filled circle clipped to a rectangle above the box; the circle's own outline runs
 *    under the box (garment drawing, rings clipped to a shirt): it was removed whole
 *    although nothing of it is painted near the box.
 */
function survey2() {
	const pdf = new Pdf();
	const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
	const text = (x, y, t, size = 12) => `BT /F1 ${size} Tf 0 0 0 rg 1 0 0 1 ${x} ${y} Tm (${t}) Tj ET`;
	const res = `/Font << /F1 ${font} 0 R >>`;
	const pagesRef = pdf.alloc();
	const kids = [];
	const metas = [];
	const page = (ops, meta, extra = '', resExtra = '') => {
		const c = pdf.stream('<< >>', ops.join('\n'), { flate: true });
		kids.push(pdf.add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << ${res} ${resExtra} >> ${extra} >>`));
		metas.push(meta);
	};
	const below = 'a new verse comes over';
	// 1. A lone space.
	page([text(72, 600, 'SECRET A B', 29), 'BT /F1 29 Tf 0 0 0 rg 1 0 0 1 150 600 Tm ( ) Tj ET', text(72, 566, below, 40), text(72, 300, 'KEEP-FAR-LINE')], {
		box: [71, 592, 260, 623],
		keep: [below, 'KEEP-FAR-LINE']
	});
	// 2. Core band.
	page([text(72, 600, 'SECRET LINE', 29), text(72, 566, below, 40), text(72, 300, 'KEEP-FAR-LINE')], {
		box: [71, 589, 72 + helvWidth('SECRET LINE', 29) + 1, 623],
		keep: [below, 'KEEP-FAR-LINE']
	});
	// 3. Scaled text and two rewrites.
	const img = pdf.stream('<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 >>', Buffer.alloc(64, 0x80), { flate: true });
	page(
		[
			'q 200 0 0 30 60 690 cm /Im1 Do Q',
			text(72, 700, 'SECRET-OVER-IMAGE'),
			text(72, 600, 'SECRET-NO-IMAGE'),
			'BT /F1 12 Tf 0 0 0 rg 96.67 Tz 1 0 0 1 72 400 Tm [(K)106.4(E)106.4(E)106.4(P)106.4(-TZ)] TJ ET'
		],
		{
			box: [71, 696, 72 + helvWidth('SECRET-OVER-IMAGE', 12) + 1, 712],
			noImage: [71, 596, 72 + helvWidth('SECRET-NO-IMAGE', 12) + 1, 612],
			scaled: 'KEEP-TZ'
		},
		'',
		`/XObject << /Im1 ${img} 0 R >>`
	);
	// 4. Annotations.
	const hl = pdf.add(
		'<< /Type /Annot /Subtype /Highlight /Rect [70 580 300 715] /QuadPoints [72 712 250 712 72 698 250 698 72 612 200 612 72 598 200 598] /C [1 1 0] /F 4 >>'
	);
	const note = pdf.add('<< /Type /Annot /Subtype /Text /Rect [60 690 80 710] /Contents (a comment) /F 4 >>');
	page([text(72, 700, 'SECRET-ANNOTATED'), text(72, 600, 'KEEP-HIGHLIGHTED')], { box: [71, 696, 72 + helvWidth('SECRET-ANNOTATED', 12) + 1, 712] }, `/Annots [${hl} 0 R ${note} 0 R]`);
	// 5. A small gradient next to a label.
	const sh = pdf.add('<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 600 0 720] /Function << /FunctionType 2 /Domain [0 1] /C0 [0 1 1] /C1 [0 0 0.5] /N 1 >> >>');
	page(['q 150 600 12 120 re W n /Sh1 sh Q', text(72, 700, 'SECRET-10-7')], { box: [71, 696, 72 + helvWidth('SECRET-10-7', 12) + 1 + 80, 712] }, '', `/Shading << /Sh1 ${sh} 0 R >>`);
	// 6. A clipped circle.
	const k = 0.5523 * 150;
	const circle = (cx, cy, r) =>
		`${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ` +
		`${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c f`;
	page(['q 100 400 200 200 re W n 0.9 0.5 0.1 rg ' + circle(200, 450, 150) + ' Q', text(72, 330, 'SECRET-UNDER-CLIPPED')], {
		box: [71, 326, 72 + helvWidth('SECRET-UNDER-CLIPPED', 12) + 1, 342],
		clip: [100, 400, 300, 600]
	});
	pdf.set(pagesRef, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
	const catalog = pdf.add(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);
	return { bytes: pdf.bytes(catalog), meta: { pages: metas.length, cases: metas } };
}

/**
 * A page with `mb` MB of drawing instructions (a short line repeated, so it compresses to
 * a few KB), drawn directly or (`inForm`) from a Form XObject, and SECRET-DENSE-LINE at
 * the top in a 12 pt line box [72 700 .. 72+w 712]. Not written to files/: corpus-wide
 * tests would have to draw it. The redaction size guard is tested with it.
 */
export function densePage(mb, { inForm = false } = {}) {
	const pdf = new Pdf();
	const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
	const unit = '0.5 w 100 100 m 110 120 l S\n';
	const dense = unit.repeat(Math.ceil((mb * 1024 * 1024) / unit.length));
	const head = 'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (SECRET-DENSE-LINE) Tj ET\n';
	let res = `/Font << /F1 ${font} 0 R >>`;
	let body = head + dense;
	if (inForm) {
		const form = pdf.stream('<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] >>', dense, { flate: true });
		res += ` /XObject << /Fm1 ${form} 0 R >>`;
		body = `${head}/Fm1 Do\n`;
	}
	const c = pdf.stream('<< >>', body, { flate: true });
	const pages = pdf.alloc();
	const page = pdf.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << ${res} >> >>`);
	pdf.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
	const catalog = pdf.add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
	return { bytes: pdf.bytes(catalog), line: [72, 700, 72 + helvWidth('SECRET-DENSE-LINE', 12), 712] };
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
	const t = table();
	write('redact-table.pdf', t.bytes, { label: null, ...t.meta });
	const s = survey();
	write('redact-survey.pdf', s.bytes, { label: null, ...s.meta });
	const s2 = survey2();
	write('redact-survey-2.pdf', s2.bytes, { label: null, ...s2.meta });
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
