#!/usr/bin/env node
// @ts-nocheck -- plain Node script, like generate.mjs (which tsconfig excludes).
/**
 * Intake / assemble corpus: small hand-written PDFs with one structural trait each,
 * reproducing what the real-world survey found (no third-party bytes are copied).
 *
 * Called by generate.mjs, or on its own: node tests/corpus/generate-intake.mjs
 *
 * Every file is written byte for byte by `rawPdf` below (objects, xref, trailer;
 * optional incremental updates), so each trait is exactly as described.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const enc = (s) => Buffer.from(s, 'latin1');

/**
 * A PDF from revisions. Each revision is a list of [num, gen, body] (body without
 * "obj"/"endobj"; a Buffer body is a stream: [num, gen, dictString, Buffer]). The first
 * revision gets a full xref; later ones are incremental updates with /Prev.
 */
export function rawPdf(revisions, { root = '1 0 R', size, info } = {}) {
	const parts = [enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
	let offset = parts[0].length;
	let prev = null;
	let maxNum = 0;
	for (const rev of revisions) {
		const offsets = [];
		for (const obj of rev) {
			const [num, gen, body, data] = obj;
			maxNum = Math.max(maxNum, num);
			offsets.push([num, gen, offset]);
			const chunks = data
				? [enc(`${num} ${gen} obj\n${body.replace('%LEN%', String(data.length))}\nstream\n`), data, enc('\nendstream\nendobj\n')]
				: [enc(`${num} ${gen} obj\n${body}\nendobj\n`)];
			for (const c of chunks) {
				parts.push(c);
				offset += c.length;
			}
		}
		const xrefAt = offset;
		let xref = 'xref\n';
		if (prev === null) {
			const byNum = new Map(offsets.map(([n, g, o]) => [n, [g, o]]));
			xref += `0 ${maxNum + 1}\n0000000000 65535 f \n`;
			for (let n = 1; n <= maxNum; n++) {
				const e = byNum.get(n);
				xref += e ? `${String(e[1]).padStart(10, '0')} ${String(e[0]).padStart(5, '0')} n \n` : '0000000000 00001 f \n';
			}
		} else {
			for (const [n, g, o] of offsets) xref += `${n} 1\n${String(o).padStart(10, '0')} ${String(g).padStart(5, '0')} n \n`;
		}
		const trailer = `trailer\n<< /Size ${size ?? maxNum + 1} /Root ${root}${info ? ` /Info ${info}` : ''}${prev !== null ? ` /Prev ${prev}` : ''} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
		const tail = enc(xref + trailer);
		parts.push(tail);
		offset += tail.length;
		prev = xrefAt;
	}
	return new Uint8Array(Buffer.concat(parts));
}

const FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
const text = (x, y, s, size = 24) => `BT /F1 ${size} Tf ${x} ${y} Td (${s}) Tj ET`;
const stream = (s) => Buffer.from(s, 'latin1');

/**
 * layers.pdf: one page with three blocks of text: plain, in layer "Hidden" (default OFF)
 * and in layer "Shown" (default ON). /OCProperties is an indirect object.
 */
function layers() {
	const content = [
		text(72, 700, 'layers p1'),
		'/OC /L1 BDC',
		text(72, 600, 'hidden layer text'),
		'EMC',
		'/OC /L2 BDC',
		text(72, 500, 'shown layer text'),
		'EMC'
	].join('\n');
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R /OCProperties 7 0 R >>'],
			[2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
			[3, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /Properties << /L1 6 0 R /L2 8 0 R >> >> >>'],
			[4, 0, '<< /Length %LEN% >>', stream(content)],
			[5, 0, FONT],
			[6, 0, '<< /Type /OCG /Name (Hidden) >>'],
			[7, 0, '<< /OCGs [6 0 R 8 0 R] /D << /Name (Default) /OFF [6 0 R] /Order [6 0 R 8 0 R] >> >>'],
			[8, 0, '<< /Type /OCG /Name (Shown) >>']
		]
	]);
}

/**
 * layers-base-off.pdf: two pages; /OCProperties direct in the catalog with /BaseState /OFF
 * and only "On" listed in /ON, so layer "Off" is hidden without being listed in /OFF.
 */
function layersBaseOff() {
	const page = (n) => [text(72, 700, `layers-base-off p${n}`), '/OC /A BDC', text(72, 600, 'base-off hidden'), 'EMC', '/OC /B BDC', text(72, 500, 'base-off shown'), 'EMC'].join('\n');
	const res = '/Resources << /Font << /F1 5 0 R >> /Properties << /A 6 0 R /B 7 0 R >> >>';
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R 7 0 R] /D << /BaseState /OFF /ON [7 0 R] >> >> >>'],
			[2, 0, '<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>'],
			[3, 0, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ${res} >>`],
			[4, 0, '<< /Length %LEN% >>', stream(page(1))],
			[5, 0, FONT],
			[6, 0, '<< /Type /OCG /Name (Off) >>'],
			[7, 0, '<< /Type /OCG /Name (On) >>'],
			[8, 0, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 9 0 R ${res} >>`],
			[9, 0, '<< /Length %LEN% >>', stream(page(2))]
		]
	]);
}

/**
 * gen-conflict.pdf: the page is object 3 generation 1, referenced as "3 1 R". An
 * incremental update redefines object 3 with generation 0 and adds an annotation (as some
 * mobile annotation apps do). qpdf follows the reference's generation (old page, no
 * annotation); PDF.js and MuPDF take the newest object 3 (with the annotation).
 */
function genConflict() {
	const page = (annots) =>
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>${annots} >>`;
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'],
			[2, 0, '<< /Type /Pages /Kids [3 1 R] /Count 1 >>'],
			[3, 1, page('')],
			[4, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'gen-conflict p1'))],
			[5, 0, FONT]
		],
		[
			[3, 0, page(' /Annots [6 0 R]')],
			[6, 0, '<< /Type /Annot /Subtype /Square /Rect [100 100 300 300] /C [1 0 0] /BS << /W 8 >> /F 4 >>']
		]
	]);
}

/**
 * gen-reuse.pdf: legitimate reuse of an object number. Object 6 gen 0 is an unused
 * leftover; an update frees it and defines object 6 generation 1 (the page's new content),
 * referenced as "6 1 R". Every reader agrees.
 */
function genReuse() {
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'],
			[2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
			[3, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
			[4, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'gen-reuse old'))],
			[5, 0, FONT],
			[6, 0, '<< /Unused true >>']
		],
		[
			[3, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 1 R /Resources << /Font << /F1 5 0 R >> >> >>'],
			[6, 1, '<< /Length %LEN% >>', stream(text(72, 700, 'gen-reuse p1'))]
		]
	]);
}


/**
 * form-split.pdf: field "Fine" has a text kid "Note" on page 1 and a checkbox kid "SA" on
 * page 2. The assemble step copies "Fine" once per page, each copy keeping both kids, so
 * each page's copy has an off-page widget.
 */
function formSplit() {
	const box = (ops) => stream(ops);
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>'],
			[2, 0, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'],
			[3, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 14 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [8 0 R] >>'],
			[4, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 15 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [9 0 R] >>'],
			[5, 0, FONT],
			[6, 0, '<< /T (Fine) /Kids [8 0 R 9 0 R] >>'],
			[8, 0, '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Note) /Parent 6 0 R /P 3 0 R /F 4 /Rect [72 600 372 624] /DA (/Helv 12 Tf 0 g) /V (old) /AP << /N 13 0 R >> >>'],
			[9, 0, '<< /Type /Annot /Subtype /Widget /FT /Btn /T (SA) /Parent 6 0 R /P 4 0 R /F 4 /Rect [72 600 90 618] /MK << /CA (4) >> /DA (/ZaDb 0 Tf 0 g) /AS /Off /AP << /N << /Yes 11 0 R /Off 12 0 R >> >> >>'],
			[11, 0, '<< /Type /XObject /Subtype /Form /BBox [0 0 18 18] /Length %LEN% >>', box('0 g 3 3 12 12 re f')],
			[12, 0, '<< /Type /XObject /Subtype /Form /BBox [0 0 18 18] /Length %LEN% >>', box('')],
			[13, 0, '<< /Type /XObject /Subtype /Form /BBox [0 0 300 24] /Resources << /Font << /Helv 5 0 R >> >> /Length %LEN% >>', box('/Tx BMC BT /Helv 12 Tf 0 g 2 7 Td (old) Tj ET EMC')],
			[14, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'form-split p1'))],
			[15, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'form-split p2'))]
		]
	]);
}


/**
 * damage-content.pdf: page 1's content stream has a stray ")" after its text (qpdf --check
 * warns "unexpected )"; viewers ignore it). Every export carries the same warning.
 */
function damageContent() {
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'],
			[2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
			[3, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
			[4, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'damage-content p1') + '\n)\n')],
			[5, 0, FONT]
		]
	]);
}

/**
 * damage-flate.pdf: a Flate stream zlib cannot decode (wrong header), hung off the page as
 * an unused piece of data, as in files whose embedded data is broken. Viewers never read it;
 * qpdf --recompress-flate stops at it.
 */
function damageFlate() {
	const bad = Buffer.concat([Buffer.from([0x12, 0x34]), zlib.deflateRawSync(Buffer.from('not a zlib header'))]);
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'],
			[2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
			[3, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /PieceInfo << /App << /Private 6 0 R >> >> >>'],
			[4, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'damage-flate p1'))],
			[5, 0, FONT],
			[6, 0, '<< /Filter /FlateDecode /Length %LEN% >>', bad]
		]
	]);
}

/**
 * damage-jpeg.pdf: page 2 draws a "JPEG" image whose data is not JPEG. Viewers draw nothing
 * for it; qpdf --check stops at it, so no export of this file can be checked.
 */
function damageJpeg() {
	const res = '/Resources << /Font << /F1 5 0 R >> /XObject << /Im 7 0 R >> >>';
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'],
			[2, 0, '<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>'],
			[3, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
			[4, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'damage-jpeg p1'))],
			[5, 0, FONT],
			[6, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'damage-jpeg p2') + '\nq 100 0 0 100 72 400 cm /Im Do Q')],
			[7, 0, '<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length %LEN% >>', Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 3, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9])],
			[8, 0, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R ${res} >>`]
		]
	]);
}

/** null-contents.pdf: page 2's /Contents is [null 6 0 R 99 0 R] (99 does not exist). */
function nullContents() {
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R >>'],
			[2, 0, '<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>'],
			[3, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
			[4, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'null-contents p1'))],
			[5, 0, FONT],
			[6, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'null-contents p2'))],
			[7, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [null 6 0 R 99 0 R] /Resources << /Font << /F1 5 0 R >> >> >>']
		]
	]);
}


/** form-as-string.pdf: a checkbox whose /AS is a string, not a name; MuPDF refuses to load the page. */
function formAsString() {
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>'],
			[2, 0, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
			[3, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>'],
			[4, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'form-as-string p1'))],
			[5, 0, FONT],
			[6, 0, '<< /Type /Annot /Subtype /Widget /FT /Btn /T (box) /P 3 0 R /F 4 /Rect [72 600 90 618] /AS (Off) /AP << /N << /Yes 7 0 R /Off 8 0 R >> >> >>'],
			[7, 0, '<< /Type /XObject /Subtype /Form /BBox [0 0 18 18] /Length %LEN% >>', stream('0 g 3 3 12 12 re f')],
			[8, 0, '<< /Type /XObject /Subtype /Form /BBox [0 0 18 18] /Length %LEN% >>', stream('')]
		]
	]);
}


/**
 * form-tree.pdf: an XFA-style form: one root field "form1" whose subforms "page<N>" hold
 * 25 text fields per page, on 24 pages (600 widgets). Copying pages one by one would
 * copy the whole tree per page (quadratic); exports must edit the file in place.
 */
function formTree(pagesCount = 24, perPage = 25) {
	const objs = [];
	let next = 10;
	const pageIds = [];
	const subIds = [];
	const objsAfter = [];
	for (let p = 0; p < pagesCount; p++) {
		const pageId = next++;
		const contentId = next++;
		const subId = next++;
		pageIds.push(pageId);
		subIds.push(subId);
		const widgets = [];
		for (let k = 0; k < perPage; k++) {
			const id = next++;
			widgets.push(id);
			const y = 740 - k * 17;
			objsAfter.push([id, 0, `<< /Type /Annot /Subtype /Widget /FT /Tx /T (f${k}[0]) /Parent ${subId} 0 R /P ${pageId} 0 R /F 4 /Rect [200 ${y} 400 ${y + 14}] /DA (/Helv 10 Tf 0 g) /V (v${p}.${k}) /AP << /N 6 0 R >> >>`]);
		}
		objsAfter.push([pageId, 0, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [${widgets.map((w) => `${w} 0 R`).join(' ')}] >>`]);
		objsAfter.push([contentId, 0, '<< /Length %LEN% >>', stream(text(72, 760, `form-tree p${p + 1}`, 12))]);
		objsAfter.push([subId, 0, `<< /T (page${p + 1}[0]) /Parent 4 0 R /Kids [${widgets.map((w) => `${w} 0 R`).join(' ')}] >>`]);
	}
	objs.push([1, 0, '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>']);
	objs.push([2, 0, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pagesCount} >>`]);
	objs.push([4, 0, `<< /T (form1[0]) /Kids [${subIds.map((i) => `${i} 0 R`).join(' ')}] >>`]);
	objs.push([5, 0, FONT]);
	objs.push([6, 0, '<< /Type /XObject /Subtype /Form /BBox [0 0 200 14] /Length %LEN% >>', stream('')]);
	return rawPdf([[...objs, ...objsAfter]]);
}

/**
 * form-catalog.pdf: a small form whose catalog has what a reduced catalog must not keep:
 * an outline entry and a structure element (with /Alt text) for page 2, an /OpenAction,
 * an Info dictionary and an XFA part. Page 2 says "SECRETPAGE2".
 */
function formCatalog() {
	return rawPdf([
		[
			[1, 0, '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R /Outlines 10 0 R /StructTreeRoot 12 0 R /OpenAction [4 0 R /Fit] /MarkInfo << /Marked true >> >>'],
			[2, 0, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'],
			[3, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [9 0 R] >>'],
			[4, 0, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
			[5, 0, FONT],
			[6, 0, '<< /Fields [9 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> /XFA 15 0 R >>'],
			[7, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'form-catalog p1'))],
			[8, 0, '<< /Length %LEN% >>', stream(text(72, 700, 'SECRETPAGE2'))],
			[9, 0, '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /P 3 0 R /F 4 /Rect [72 600 372 624] /DA (/Helv 12 Tf 0 g) /V (x) >>'],
			[10, 0, '<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>'],
			[11, 0, '<< /Title (SECRETOUTLINE) /Parent 10 0 R /Dest [4 0 R /Fit] >>'],
			[12, 0, '<< /Type /StructTreeRoot /K [13 0 R] >>'],
			[13, 0, '<< /Type /StructElem /S /Figure /P 12 0 R /Pg 4 0 R /Alt (SECRETALT) /K 0 >>'],
			[14, 0, '<< /Title (SECRETINFO) >>'],
			[15, 0, '<< /Length %LEN% >>', stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">SECRETXFA</xdp:xdp>')]
		]
	], { info: '14 0 R' });
}

export default async function generateIntake(write) {
	write('layers.pdf', layers(), { pages: 1, note: 'layer "Hidden" (6 0 R) default OFF via /D /OFF; layer "Shown" (8 0 R) ON; indirect /OCProperties' });
	write('layers-base-off.pdf', layersBaseOff(), { pages: 2, note: 'direct /OCProperties, /BaseState /OFF, /ON [On]: layer "Off" hidden by base state' });
	write('gen-conflict.pdf', genConflict(), { pages: 1, note: 'page 3 1 R redefined as 3 0 obj with an annotation in an update: readers disagree; intake refuses' });
	write('form-split.pdf', formSplit(), { pages: 2, note: 'field "Fine": text kid "Note" (p1, value "old"), checkbox kid "SA" (p2); the assemble step leaves off-page copies' });
	write('damage-content.pdf', damageContent(), { pages: 1, note: 'stray ")" in the content stream: qpdf --check warns; exports keep the same warning' });
	write('damage-flate.pdf', damageFlate(), { pages: 1, note: 'an unused Flate stream with a bad zlib header: --recompress-flate fails on it' });
	write('damage-jpeg.pdf', damageJpeg(), { pages: 2, note: 'page 2 draws a DCT image whose data is not JPEG: qpdf --check stops (exit 2)' });
	write('null-contents.pdf', nullContents(), { pages: 2, note: 'page 2 /Contents [null 6 0 R 99 0 R]: qpdf cannot copy the page until the non-streams are removed' });
	write('form-as-string.pdf', formAsString(), { pages: 1, note: 'checkbox /AS (Off) is a string: MuPDF cannot load the page; opens without a fillable form' });
	write('form-tree.pdf', formTree(), { pages: 24, note: 'one root field form1[0] > page<N>[0] > 25 text fields per page (600 widgets): copying pages one by one is quadratic' });
	write('form-catalog.pdf', formCatalog(), { pages: 2, note: 'form + outline, structure element (/Alt), OpenAction to page 2, Info, XFA; page 2 text SECRETPAGE2; markers SECRETOUTLINE/ALT/INFO/XFA' });
	write('gen-reuse.pdf', genReuse(), { pages: 1, note: 'object 6 reused with generation 1 (legitimate); opens; text "gen-reuse p1"' });
}

// Standalone: write only these files and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateIntake((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}

