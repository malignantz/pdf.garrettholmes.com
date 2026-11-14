#!/usr/bin/env node
// @ts-nocheck -- plain Node script, like generate.mjs (which tsconfig excludes).
/**
 * Corpus for the title, document details and bookmarks kept in exports (engine/outline.ts).
 * Every file is written by hand (a tiny object writer below) so each construct is exactly as
 * described. Nothing is copied from elsewhere. Every page says "<file> p<N>".
 *
 *   outline-basic.pdf   4 pages. Info: /Title in UTF-16 (with a dash and an umlaut), /Author in
 *                       PDFDocEncoding, /Subject, /Keywords, /Creator, /Producer, /CreationDate,
 *                       /ModDate and a custom key; a catalog XMP packet; /Lang, /ViewerPreferences
 *                       (/DisplayDocTitle, /Direction, /PrintPageRange), /PageMode /UseOutlines,
 *                       an /OpenAction. Outline (13 items, 3 levels): explicit /Dest with /XYZ, /FitH,
 *                       /Fit, /FitR, /FitB; a GoTo action; a closed item with /C and /F; a
 *                       JavaScript action with a child (lifted), a Launch action (dropped), a URI
 *                       action, a heading without destination, an empty heading, a short /XYZ view
 *                       (padded), a destination to page number 99 (dropped), a PDFDocEncoding title.
 *                       Page 2 has a link with an explicit destination to page 4.
 *   outline-named.pdf   3 pages. Named destinations in both forms: /Dests (names /intro, /second as
 *                       a /D dictionary) and a /Names /Dests tree with two leaves and /Limits
 *                       (alpha, beta, gamma, a UTF-16 "zeta é"). Bookmarks use them through /Dest
 *                       names and strings and GoTo /D; one names a destination that does not exist.
 *                       Links: page 1 /Dest (gamma) and /A GoTo /D /second; page 2 /Dest "zeta é".
 *   outline-second.pdf  2 pages, its own outline and title; names (alpha), which outline-named.pdf
 *                       defines differently, and (delta).
 *   outline-cyclic.pdf  2 pages; the outline's second item points back at the first (/Next cycle).
 *   outline-damaged.pdf 2 pages; an item's /First is a number, not a dictionary.
 *   outline-form.pdf    2 pages, a text field on page 1 (the in-place assemble path), 2 bookmarks.
 *   outline-secret.pdf  2 pages; a bookmark title, a named destination, the Info title and subject
 *                       spell secrets; page 1 has the line to black out (geometry in the manifest).
 *
 * Called from generate.mjs (one line), or on its own: node tests/corpus/generate-outline.mjs
 * (writes only these files and merges their manifest entries).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

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
	stream(dict, data) {
		return this.add({ dict, stream: Buffer.from(data, 'latin1') });
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
		const id = '<4f55544c494e454f55544c494e45aa01>';
		xref += `trailer\n<< /Size ${this.objs.length + 1} /Root ${root} 0 R${info ? ` /Info ${info} 0 R` : ''} /ID [${id} ${id}] >>\nstartxref\n${pos}\n%%EOF\n`;
		parts.push(Buffer.from(xref, 'latin1'));
		return Buffer.concat(parts);
	}
}

const R = (n) => `${n} 0 R`;
export const utf16 = (s) => '<FEFF' + Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase() + '>';
const text = (size, x, y, s) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${s}) Tj ET`;
const helv = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

/** Pages saying "<name> p<N>", with optional extra content and annotations per page. */
function pagesOf(pdf, name, count, { extra = {}, annots = {} } = {}) {
	const font = pdf.add(helv);
	const pagesRef = pdf.alloc();
	const refs = Array.from({ length: count }, () => pdf.alloc());
	refs.forEach((ref, i) => {
		const c = pdf.stream('<< >>', [text(14, 72, 750, `${name} p${i + 1}`), ...(extra[i] ?? [])].join('\n'));
		const a = annots[i] ? ` /Annots [${annots[i].map(R).join(' ')}]` : '';
		pdf.set(ref, `<< /Type /Page /Parent ${R(pagesRef)} /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${R(font)} >> >> /Contents ${R(c)}${a} >>`);
	});
	pdf.set(pagesRef, `<< /Type /Pages /Kids [${refs.map(R).join(' ')}] /Count ${count} >>`);
	return { pagesRef, refs, font };
}

/**
 * Outline objects from a tree: [{ title (PDF string syntax), dest | a, open, c, f, kids }].
 * `dest`/`a` are PDF syntax. Returns the /Outlines object number.
 */
function outline(pdf, tree) {
	const root = pdf.alloc();
	const visible = (items) => items.reduce((n, it) => n + 1 + (it.open && it.kids ? visible(it.kids) : 0), 0);
	const level = (items, parent) => {
		const refs = items.map(() => pdf.alloc());
		items.forEach((it, i) => {
			let d = `<< /Title ${it.title} /Parent ${R(parent)}`;
			if (i > 0) d += ` /Prev ${R(refs[i - 1])}`;
			if (i < items.length - 1) d += ` /Next ${R(refs[i + 1])}`;
			if (it.kids?.length) {
				const sub = level(it.kids, refs[i]);
				const n = visible(it.kids);
				d += ` /First ${R(sub[0])} /Last ${R(sub[sub.length - 1])} /Count ${it.open ? n : -n}`;
			}
			if (it.dest) d += ` /Dest ${it.dest}`;
			if (it.a) d += ` /A ${it.a}`;
			if (it.c) d += ` /C ${it.c}`;
			if (it.f) d += ` /F ${it.f}`;
			pdf.set(refs[i], `${d} >>`);
		});
		return refs;
	};
	const top = level(tree, root);
	pdf.set(root, `<< /Type /Outlines /First ${R(top[0])} /Last ${R(top[top.length - 1])} /Count ${visible(tree)} >>`);
	return root;
}

const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP-ONLY-TITLE</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

export const BASIC_TITLE = 'Quarterly Report – Übersicht';
export const BASIC_CHAPTER2 = 'Chapitre 2 — Été';

function basic() {
	const pdf = new Pdf();
	const link = pdf.alloc();
	const { pagesRef, refs: p } = pagesOf(pdf, 'outline', 4, { annots: { 1: [link] } });
	pdf.set(link, `<< /Type /Annot /Subtype /Link /Rect [72 600 300 620] /Border [0 0 0] /Dest [${R(p[3])} /Fit] >>`);
	const js = pdf.add(`<< /S /JavaScript /JS (app.alert\\("SCRIPT-BODY"\\)) >>`);
	const ol = outline(pdf, [
		{
			title: '(Chapter 1)',
			dest: `[${R(p[0])} /XYZ 72 720 0]`,
			open: true,
			kids: [
				{ title: '(Section 1.1)', dest: `[${R(p[0])} /FitH 500]` },
				{ title: '(Section 1.2)', a: `<< /S /GoTo /D [${R(p[1])} /Fit] >>` }
			]
		},
		{
			title: utf16(BASIC_CHAPTER2),
			dest: `[${R(p[2])} /FitR 10 20 300 400.5]`,
			open: false,
			c: '[1 0 0]',
			f: 2,
			kids: [
				{ title: '(SCRIPTED-BOOKMARK)', a: R(js), kids: [{ title: '(Inside the script item)', dest: `[${R(p[2])} /Fit]` }] },
				{ title: '(LAUNCH-BOOKMARK)', a: '<< /S /Launch /F (calc.exe) >>' },
				{ title: '(Web page)', a: '<< /S /URI /URI (https://example.org/report) >>' }
			]
		},
		{
			title: '(Appendix)',
			open: true,
			kids: [
				{ title: '(Last page)', dest: `[${R(p[3])} /XYZ null null null]` },
				// PDFDocEncoding: \x8d and \x8e are curly double quotes, \x84 an em dash.
				{ title: '(\x8dQuoted\x8e \x84 PDFDoc)', dest: `[${R(p[3])} /FitB]` }
			]
		},
		{ title: '(Empty heading)' },
		{ title: '(Short view)', dest: `[${R(p[1])} /XYZ 72]` },
		{ title: '(Page ninety-nine)', dest: '[98 /Fit]' }
	]);
	const xmp = pdf.stream('<< /Type /Metadata /Subtype /XML >>', XMP);
	const info = pdf.add(
		`<< /Title ${utf16(BASIC_TITLE)} /Author (Ana Mar\xeda \x84 Ni\xf1o) /Subject (Outline corpus) /Keywords (bookmarks, title) /Creator (generate-outline.mjs) /Producer (Hand-written PDF) /CreationDate (D:20260102030405+01'00') /ModDate (D:20260203040506Z) /CustomSecret (CUSTOM-INFO-VALUE) >>`
	);
	const cat = pdf.add(
		`<< /Type /Catalog /Pages ${R(pagesRef)} /Outlines ${R(ol)} /PageMode /UseOutlines /Metadata ${R(xmp)} /Lang (en-GB) /ViewerPreferences << /DisplayDocTitle true /Direction /L2R /PrintPageRange [0 1] >> /OpenAction [${R(p[1])} /Fit] >>`
	);
	return pdf.bytes(cat, info);
}

export const ZETA = 'zeta é';

function named() {
	const pdf = new Pdf();
	const [l1, l2, l3] = [pdf.alloc(), pdf.alloc(), pdf.alloc()];
	const { pagesRef, refs: p } = pagesOf(pdf, 'outline-named', 3, { annots: { 0: [l1, l2], 1: [l3] } });
	pdf.set(l1, `<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /Border [0 0 0] /Dest (gamma) >>`);
	pdf.set(l2, `<< /Type /Annot /Subtype /Link /Rect [72 650 200 670] /Border [0 0 0] /A << /S /GoTo /D /second >> >>`);
	pdf.set(l3, `<< /Type /Annot /Subtype /Link /Rect [72 600 200 620] /Border [0 0 0] /Dest ${utf16(ZETA)} >>`);
	const secondDest = pdf.add(`<< /D [${R(p[1])} /XYZ 0 700 0] >>`);
	const dests = pdf.add(`<< /intro [${R(p[0])} /Fit] /second ${R(secondDest)} >>`);
	const leaf1 = pdf.add(`<< /Limits [(alpha) (beta)] /Names [(alpha) [${R(p[0])} /FitH 600] (beta) [${R(p[1])} /Fit]] >>`);
	const leaf2 = pdf.add(`<< /Limits [(gamma) ${utf16(ZETA)}] /Names [(gamma) [${R(p[2])} /Fit] ${utf16(ZETA)} [${R(p[2])} /XYZ 0 100 0]] >>`);
	const tree = pdf.add(`<< /Kids [${R(leaf1)} ${R(leaf2)}] >>`);
	const ol = outline(pdf, [
		{ title: '(Intro)', dest: '/intro' },
		{ title: '(Second)', a: '<< /S /GoTo /D /second >>' },
		{ title: '(Alpha)', dest: '(alpha)' },
		{ title: '(Gamma)', a: '<< /S /GoTo /D (gamma) >>' },
		{ title: '(Zeta)', dest: utf16(ZETA) },
		{ title: '(Missing)', dest: '(nothere)' }
	]);
	const info = pdf.add('<< /Title (Named destinations) >>');
	const cat = pdf.add(`<< /Type /Catalog /Pages ${R(pagesRef)} /Outlines ${R(ol)} /Dests ${R(dests)} /Names << /Dests ${R(tree)} >> >>`);
	return pdf.bytes(cat, info);
}

function second() {
	const pdf = new Pdf();
	const { pagesRef, refs: p } = pagesOf(pdf, 'outline-second', 2);
	const ol = outline(pdf, [
		{ title: '(Second file)', dest: `[${R(p[0])} /Fit]` },
		{ title: '(Second file, page 2)', dest: `[${R(p[1])} /XYZ 0 792 null]` }
	]);
	const tree = pdf.add(`<< /Names [(alpha) [${R(p[1])} /Fit] (delta) [${R(p[0])} /Fit]] >>`);
	const info = pdf.add('<< /Title (Second) /Author (Someone else) >>');
	const cat = pdf.add(`<< /Type /Catalog /Pages ${R(pagesRef)} /Outlines ${R(ol)} /Names << /Dests ${R(tree)} >> /Lang (en-GB) >>`);
	return pdf.bytes(cat, info);
}

function cyclic() {
	const pdf = new Pdf();
	const { pagesRef, refs: p } = pagesOf(pdf, 'outline-cyclic', 2);
	const [root, a, b] = [pdf.alloc(), pdf.alloc(), pdf.alloc()];
	pdf.set(root, `<< /Type /Outlines /First ${R(a)} /Last ${R(b)} /Count 2 >>`);
	pdf.set(a, `<< /Title (First) /Parent ${R(root)} /Next ${R(b)} /Dest [${R(p[0])} /Fit] >>`);
	pdf.set(b, `<< /Title (Second) /Parent ${R(root)} /Prev ${R(a)} /Next ${R(a)} /Dest [${R(p[1])} /Fit] >>`);
	const info = pdf.add('<< /Title (Cyclic outline) >>');
	const cat = pdf.add(`<< /Type /Catalog /Pages ${R(pagesRef)} /Outlines ${R(root)} >>`);
	return pdf.bytes(cat, info);
}

function damaged() {
	const pdf = new Pdf();
	const { pagesRef, refs: p } = pagesOf(pdf, 'outline-damaged', 2);
	const [root, a] = [pdf.alloc(), pdf.alloc()];
	const num = pdf.add('42');
	pdf.set(root, `<< /Type /Outlines /First ${R(a)} /Last ${R(a)} /Count 1 >>`);
	pdf.set(a, `<< /Title (Broken) /Parent ${R(root)} /First ${R(num)} /Last ${R(num)} /Count 1 /Dest [${R(p[0])} /Fit] >>`);
	const info = pdf.add('<< /Title (Damaged outline) >>');
	const cat = pdf.add(`<< /Type /Catalog /Pages ${R(pagesRef)} /Outlines ${R(root)} >>`);
	return pdf.bytes(cat, info);
}

function form() {
	const pdf = new Pdf();
	const widget = pdf.alloc();
	const { pagesRef, refs: p, font } = pagesOf(pdf, 'outline-form', 2, { annots: { 0: [widget] } });
	pdf.set(widget, `<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /P ${R(p[0])} /F 4 /Rect [72 600 372 624] /DA (/Helv 12 Tf 0 g) /V (Ada) >>`);
	const ol = outline(pdf, [
		{ title: '(Form page)', dest: `[${R(p[0])} /Fit]` },
		{ title: '(After the form)', dest: `[${R(p[1])} /Fit]` }
	]);
	const info = pdf.add('<< /Title (Outline form) >>');
	const cat = pdf.add(`<< /Type /Catalog /Pages ${R(pagesRef)} /Outlines ${R(ol)} /AcroForm << /Fields [${R(widget)}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv ${R(font)} >> >> >> >>`);
	return pdf.bytes(cat, info);
}

/** The line to black out on page 1 of outline-secret.pdf, user space. */
const SECRET_BOX = [72, 690, 330, 720];
export const SECRETS = ['SECRET-BOOKMARK-TITLE', 'SECRET-DEST-NAME', 'SECRET-INFO-TITLE', 'SECRET-INFO-SUBJECT'];

function secret() {
	const pdf = new Pdf();
	const { pagesRef, refs: p } = pagesOf(pdf, 'outline-secret', 2, { extra: { 0: [text(14, 76, 700, 'SECRET-WORD on this line')] } });
	const ol = outline(pdf, [
		{ title: '(SECRET-BOOKMARK-TITLE)', dest: `[${R(p[0])} /XYZ 72 720 0]` },
		{ title: '(Page two)', dest: `[${R(p[1])} /Fit]` }
	]);
	const tree = pdf.add(`<< /Names [(SECRET-DEST-NAME) [${R(p[0])} /Fit]] >>`);
	const info = pdf.add('<< /Title (SECRET-INFO-TITLE) /Subject (SECRET-INFO-SUBJECT) >>');
	const cat = pdf.add(`<< /Type /Catalog /Pages ${R(pagesRef)} /Outlines ${R(ol)} /Names << /Dests ${R(tree)} >> >>`);
	return pdf.bytes(cat, info);
}

export default async function generateOutlineCorpus(write) {
	write('outline-basic.pdf', basic(), { pages: 4, label: 'outline', title: BASIC_TITLE, note: 'Info in UTF-16 and PDFDocEncoding, XMP, /Lang, /ViewerPreferences, /PageMode; 13 bookmarks of every kind' });
	write('outline-named.pdf', named(), { pages: 3, label: 'outline', title: 'Named destinations', note: '/Dests and a /Names /Dests tree; bookmarks and links that use them' });
	write('outline-second.pdf', second(), { pages: 2, label: 'outline', title: 'Second', note: 'a second file to merge; name (alpha) clashes with outline-named.pdf' });
	write('outline-cyclic.pdf', cyclic(), { pages: 2, label: 'outline', expect: 'bookmarks not kept: damaged (cycle)' });
	write('outline-damaged.pdf', damaged(), { pages: 2, label: 'outline', expect: 'bookmarks not kept: damaged (a child is not a dictionary)' });
	write('outline-form.pdf', form(), { pages: 2, label: 'outline', fields: ['name'] });
	write('outline-secret.pdf', secret(), { pages: 2, label: 'outline', secretBox: SECRET_BOX, secrets: SECRETS });
}

// Standalone: write only these files and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(here, 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateOutlineCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
