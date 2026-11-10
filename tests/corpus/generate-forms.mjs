#!/usr/bin/env node
// @ts-nocheck -- plain Node script, like generate.mjs (which tsconfig excludes).
/**
 * AcroForm corpus for the forms stage (src/lib/engine/forms.ts).
 *
 * Called by generate.mjs (`await generateForms(...)`), or run on its own to rebuild
 * only these files without touching the rest of the corpus (the encrypted files of
 * the main generator change on every run):
 *
 *   node tests/corpus/generate-forms.mjs
 *
 * pdf-lib builds the fields; whatever pdf-lib cannot express (on-states other than
 * "Yes", export values, calculation order, scripts, signature fields, XFA) is written
 * as raw objects. Every page carries the text label "<name> p<N>".
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
	PDFDocument,
	PDFName,
	PDFNumber,
	PDFString,
	PDFHexString,
	PDFDict,
	PDFArray,
	PDFBool,
	StandardFonts,
	rgb
} from '@cantoo/pdf-lib';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'files');

async function runQpdf(args, inputs) {
	const createQpdf = require('@neslinesli93/qpdf-wasm');
	const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
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

const N = (n) => PDFName.of(n);

async function newDoc() {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	return { doc, font };
}

function label(page, font, text) {
	const box = page.getCropBox();
	page.drawText(text, { x: box.x + 6, y: box.y + box.height - 22, size: 14, font, color: rgb(0, 0, 0) });
}

async function save(doc) {
	return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

/** The field's single widget dictionary (pdf-lib merges field and widget for one widget). */
const widgets = (field) => field.acroField.getWidgets().map((w) => w.dict);

/** Rename an appearance state (keys of /AP /N and /D, and /AS). */
function renameState(widget, from, to) {
	const ap = widget.lookup(N('AP'), PDFDict);
	for (const key of ['N', 'D']) {
		const d = ap.lookupMaybe(N(key), PDFDict);
		if (!d) continue;
		const v = d.get(N(from));
		if (v) {
			d.delete(N(from));
			d.set(N(to), v);
		}
	}
	const as = widget.get(N('AS'));
	if (as && as.asString() === `/${from}`) widget.set(N('AS'), N(to));
}

function setFlag(field, bit) {
	const d = field.acroField.dict;
	const ff = d.lookupMaybe(N('Ff'), PDFNumber)?.asNumber() ?? 0;
	d.set(N('Ff'), PDFNumber.of(ff | bit));
}

/** A raw widget-field dictionary added to a page and to /AcroForm /Fields. */
function rawField(doc, page, entries, rect) {
	const ctx = doc.context;
	const dict = ctx.obj({ Type: 'Annot', Subtype: 'Widget', Rect: rect, F: 4, P: page.ref, ...entries });
	const ref = ctx.register(dict);
	page.node.addAnnot(ref);
	doc.getForm().acroForm.addField(ref);
	return { ref, dict };
}

const js = (doc, code) => doc.context.obj({ S: 'JavaScript', JS: PDFString.of(code) });

// --- forms-kinds.pdf: every field kind, two pages ----------------------------------------
async function kinds() {
	const { doc, font } = await newDoc();
	const p1 = doc.addPage([612, 792]);
	const p2 = doc.addPage([612, 792]);
	label(p1, font, 'kinds p1');
	label(p2, font, 'kinds p2');
	const f = doc.getForm();
	const at = (y, w = 200, h = 20, x = 72) => ({ x, y, width: w, height: h, font, borderWidth: 1 });

	const name = f.createTextField('name');
	name.setText('Ada Lovelace');
	name.addToPage(p1, at(700));
	name.acroField.dict.set(N('TU'), PDFString.of('Full name'));

	const notes = f.createTextField('notes');
	notes.enableMultiline();
	notes.addToPage(p1, at(600, 250, 80));
	notes.setFontSize(10);

	const zip = f.createTextField('zip');
	zip.setMaxLength(5);
	zip.addToPage(p1, at(560, 80));

	const code = f.createTextField('code');
	code.setMaxLength(6);
	code.enableCombing();
	code.addToPage(p1, at(520, 132));

	const ro = f.createTextField('ro');
	ro.setText('Fixed');
	ro.enableReadOnly();
	ro.addToPage(p1, at(480));

	const agree = f.createCheckBox('agree');
	agree.addToPage(p1, at(440, 16, 16));
	agree.check();

	// Checkbox whose on-state is "On", not "Yes".
	const optIn = f.createCheckBox('opt_in');
	optIn.addToPage(p1, at(440, 16, 16, 120));
	for (const w of widgets(optIn)) renameState(w, 'Yes', 'On');

	// Radio group on one page, pdf-lib style: states "0","1","2" plus /Opt.
	const color = f.createRadioGroup('color');
	color.addOptionToPage('red', p1, at(400, 16, 16, 72));
	color.addOptionToPage('green', p1, at(400, 16, 16, 100));
	color.addOptionToPage('blue', p1, at(400, 16, 16, 128));
	color.select('green');

	// Radio group across both pages, named states, no /Opt.
	const size = f.createRadioGroup('size');
	size.addOptionToPage('S', p1, at(360, 16, 16, 72));
	size.addOptionToPage('M', p1, at(360, 16, 16, 100));
	size.addOptionToPage('L', p2, at(360, 16, 16, 72));
	size.acroField.dict.delete(N('Opt'));
	['S', 'M', 'L'].forEach((s, i) => renameState(size.acroField.getWidgets()[i].dict, String(i), s));

	// One text field, a widget on each page.
	const shared = f.createTextField('shared');
	shared.addToPage(p1, at(320));
	shared.addToPage(p2, at(320));

	// Hierarchical names: person.first, person.last.
	const first = f.createTextField('person.first');
	first.addToPage(p2, at(700));
	const last = f.createTextField('person.last');
	last.addToPage(p2, at(660));

	// Combo box with export values that differ from the labels.
	const country = f.createDropdown('country');
	country.addOptions(['United States', 'Canada']);
	country.addToPage(p2, at(620));
	country.acroField.dict.set(
		N('Opt'),
		doc.context.obj([
			[PDFString.of('us'), PDFString.of('United States')],
			[PDFString.of('ca'), PDFString.of('Canada')]
		])
	);
	country.acroField.dict.set(N('V'), PDFString.of('ca'));

	// Multi-select list box.
	const langs = f.createOptionList('langs');
	langs.addOptions(['English', 'French', 'German']);
	langs.enableMultiselect();
	langs.addToPage(p2, at(520, 120, 60));
	langs.acroField.dict.set(N('V'), doc.context.obj([PDFString.of('English'), PDFString.of('German')]));

	// Not listed: password, rich text, file select, push button, signature, hidden, zero size.
	const pw = f.createTextField('pw');
	pw.addToPage(p2, at(480));
	setFlag(pw, 1 << 13);
	const rt = f.createTextField('rt');
	rt.addToPage(p2, at(440));
	setFlag(rt, 1 << 25);
	const file = f.createTextField('file');
	file.addToPage(p2, at(400));
	setFlag(file, 1 << 20);
	const btn = f.createButton('btn');
	btn.addToPage('Press', p2, at(280, 80));
	rawField(doc, p2, { FT: 'Sig', T: PDFString.of('sig') }, [72, 200, 272, 240]);
	const hidden = f.createTextField('hidden');
	hidden.addToPage(p2, at(160));
	for (const w of widgets(hidden)) w.set(N('F'), PDFNumber.of(4 | 2));
	const noview = f.createTextField('noview');
	noview.addToPage(p2, at(130));
	for (const w of widgets(noview)) w.set(N('F'), PDFNumber.of(32));
	const zero = f.createTextField('zero');
	zero.addToPage(p2, at(100));
	for (const w of widgets(zero)) w.set(N('Rect'), doc.context.obj([300, 100, 300, 100]));

	return save(doc);
}

// --- forms-calc.pdf: calculated total (/CO), format scripts, document JavaScript ----------
async function calc() {
	const { doc, font } = await newDoc();
	const p = doc.addPage([612, 792]);
	label(p, font, 'calc p1');
	const f = doc.getForm();
	const at = (y) => ({ x: 72, y, width: 150, height: 20, font, borderWidth: 1 });
	const qty = f.createTextField('qty');
	qty.setText('2');
	qty.addToPage(p, at(700));
	const price = f.createTextField('price');
	price.setText('10.00');
	price.addToPage(p, at(660));
	price.acroField.dict.set(
		N('AA'),
		doc.context.obj({
			F: js(doc, 'AFNumber_Format(2, 0, 0, 0, "", true);'),
			K: js(doc, 'AFNumber_Keystroke(2, 0, 0, 0, "", true);')
		})
	);
	const total = f.createTextField('total');
	total.setText('20.00');
	total.addToPage(p, at(620));
	total.acroField.dict.set(N('AA'), doc.context.obj({ C: js(doc, 'AFSimple_Calculate("PRD", new Array ("qty", "price"));') }));
	const date = f.createTextField('date');
	date.addToPage(p, at(580));
	date.acroField.dict.set(
		N('AA'),
		doc.context.obj({ F: js(doc, 'AFDate_FormatEx("yyyy-mm-dd");'), K: js(doc, 'AFDate_KeystrokeEx("yyyy-mm-dd");') })
	);
	// A ticked checkbox whose appearance has an empty /BBox (as some LiveCycle forms have).
	const empty = f.createCheckBox('emptybox');
	empty.addToPage(p, { x: 300, y: 700, width: 16, height: 16 });
	empty.check();
	for (const w of widgets(empty)) {
		const on = w.lookup(N('AP'), PDFDict).lookup(N('N'), PDFDict).lookup(N('Yes'));
		on.dict.set(N('BBox'), doc.context.obj([0, 0, 0, 0]));
	}
	f.acroForm.dict.set(N('CO'), doc.context.obj([total.acroField.ref]));
	doc.catalog.set(N('OpenAction'), js(doc, 'this.calculateNow();'));
	return save(doc);
}

// --- forms-geometry.pdf: rotated pages and an offset CropBox -------------------------------
export const GEOMETRY = [
	{ media: [0, 0, 612, 792], crop: [50, 60, 562, 732], rotate: 90 },
	{ media: [0, 0, 612, 792], crop: null, rotate: 180 },
	{ media: [100, 200, 712, 992], crop: [150, 250, 600, 900], rotate: 0 },
	{ media: [0, 0, 612, 792], crop: [36, 72, 456, 672], rotate: 270 }
];
/** Widget rects in PDF user space, one text field and one checkbox per page. */
export const GEOMETRY_RECTS = [
	{ text: [100, 200, 300, 224], check: [400, 500, 416, 516] },
	{ text: [72, 600, 272, 624], check: [500, 100, 520, 120] },
	{ text: [200, 300, 400, 330], check: [500, 800, 516, 816] },
	{ text: [100, 400, 300, 424], check: [60, 100, 76, 116] }
];
async function geometry() {
	const { doc, font } = await newDoc();
	const f = doc.getForm();
	GEOMETRY.forEach((g, i) => {
		const p = doc.addPage([612, 792]);
		p.node.set(N('MediaBox'), doc.context.obj(g.media));
		if (g.crop) p.node.set(N('CropBox'), doc.context.obj(g.crop));
		if (g.rotate) p.node.set(N('Rotate'), PDFNumber.of(g.rotate));
		label(p, font, `geometry p${i + 1}`);
		const r = GEOMETRY_RECTS[i];
		const t = f.createTextField(`t${i + 1}`);
		t.addToPage(p, { x: r.text[0], y: r.text[1], width: r.text[2] - r.text[0], height: r.text[3] - r.text[1], font, borderWidth: 1 });
		const c = f.createCheckBox(`c${i + 1}`);
		c.addToPage(p, { x: r.check[0], y: r.check[1], width: r.check[2] - r.check[0], height: r.check[3] - r.check[1], borderWidth: 1 });
		// pdf-lib draws rotated appearances when the page is rotated (/MK /R); the rect stays as given.
	});
	return save(doc);
}

// --- forms-xfa.pdf: AcroForm with an XFA packet ------------------------------------------
async function xfa() {
	const { doc, font } = await newDoc();
	const p = doc.addPage([612, 792]);
	label(p, font, 'xfa p1');
	const f = doc.getForm();
	const t = f.createTextField('name');
	t.addToPage(p, { x: 72, y: 600, width: 200, height: 20, font });
	const xdp = doc.context.flateStream(
		'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"><field name="name"/></subform></template></xdp:xdp>'
	);
	f.acroForm.dict.set(N('XFA'), doc.context.register(xdp));
	return save(doc);
}

// --- forms-needapp.pdf: values without appearances, /NeedAppearances true ------------------
async function needapp() {
	const { doc, font } = await newDoc();
	const p = doc.addPage([612, 792]);
	label(p, font, 'needapp p1');
	const f = doc.getForm();
	const a = f.createTextField('filled');
	a.addToPage(p, { x: 72, y: 600, width: 200, height: 20, font });
	a.acroField.dict.set(N('V'), PDFHexString.fromText('Set by a script'));
	for (const w of widgets(a)) w.delete(N('AP'));
	const b = f.createTextField('empty');
	b.addToPage(p, { x: 72, y: 560, width: 200, height: 20, font });
	f.acroForm.dict.set(N('NeedAppearances'), PDFBool.True);
	return save(doc);
}

export default async function generateForms({ write, qpdf = runQpdf }) {
	const kindsBytes = await kinds();
	write('forms-kinds.pdf', kindsBytes, {
		pages: 2,
		label: 'kinds',
		listed: ['name', 'notes', 'zip', 'code', 'ro', 'agree', 'opt_in', 'color', 'size', 'shared', 'person.first', 'person.last', 'country', 'langs'],
		notListed: ['pw', 'rt', 'file', 'btn', 'sig', 'hidden', 'noview', 'zero']
	});
	write('forms-calc.pdf', await calc(), { pages: 1, label: 'calc', calculated: ['total'], formatted: ['price', 'date'] });
	write('forms-geometry.pdf', await geometry(), { pages: GEOMETRY.length, label: 'geometry', pagesGeometry: GEOMETRY, rects: GEOMETRY_RECTS });
	write('forms-xfa.pdf', await xfa(), { pages: 1, label: 'xfa', expect: 'XFA: hasForm false, note' });
	write('forms-needapp.pdf', await needapp(), { pages: 1, label: 'needapp' });
	write(
		'forms-enc.pdf',
		await qpdf(['--encrypt', '--user-password=form', '--owner-password=form', '--bits=256', '--', '/in.pdf', '/out.pdf'], {
			'/in.pdf': kindsBytes
		}),
		{ pages: 2, label: 'kinds', password: 'form' }
	);
}

// Standalone: rebuild only the forms files and merge them into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateForms({
		write: (name, bytes, meta) => {
			fs.writeFileSync(path.join(outDir, name), bytes);
			manifest[name] = meta;
		}
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	console.log('Wrote the forms corpus.');
}
