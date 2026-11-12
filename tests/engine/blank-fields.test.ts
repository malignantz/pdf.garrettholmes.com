/**
 * Keep filled blanks editable (engine/blank-fields.ts, the stamp stage, core.ts): snapped
 * text and ticks become form fields that look like the stamps would (MuPDF, PDF.js and
 * poppler renders against the same export drawn the ordinary way), read back in MuPDF
 * and PDF.js, fall back to plain stamps when they cannot be made or proved, and reopen
 * as a fillable form here. Corpus: tests/corpus/generate-forms-snap.mjs (forms-snap.pdf)
 * and generate-fill-fields.mjs (fill-fields-*.pdf); taps in points, top-down.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from '@cantoo/pdf-lib';
import type { Asset, ExportOptions, ExportResult, FormValues, PageRef, Source, Stamp } from '../../src/lib/core/types';
import type { TapData } from '../../src/lib/engine/snap-tap';
import { lineTop, textAt, tickAt } from '../../src/lib/editor/snap';
import { mupdf } from '../../src/lib/engine/mupdf';
import { engine, loadPdfjs, openCorpus, ref } from './helpers';
import { proveFields, verifyBlankFields, type MadeField } from '../../src/lib/engine/blank-fields';
import type { EngineDeps } from '../../src/lib/engine/deps';
import { compareThree } from './three-renders';

const T = 180_000;

type Tap = { data: TapData; W: number; H: number };
const taps = new Map<string, Promise<Tap>>();
function tapData(source: Source, pageIndex = 0): Promise<Tap> {
	const k = `${source.id}#${pageIndex}`;
	let p = taps.get(k);
	if (!p) {
		p = engine()
			.pageBlanks(source, pageIndex)
			.then((b) => {
				expect(b.declined).toBe(false);
				return { data: b.data as TapData, W: b.width, H: b.height };
			});
		taps.set(k, p);
	}
	return p;
}

const frac = ([x0, y0, x1, y1]: readonly number[], W: number, H: number) => ({ x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H });

/** A snapped text stamp for a tap at `p`, as the editor makes it. */
function snapText(d: Tap, p: [number, number], text: string, id: string): Extract<Stamp, { kind: 'text' }> {
	const at = textAt(d.data, p);
	expect(at, `text tap ${p}`).not.toBeNull();
	return { id, kind: 'text', text, color: 'black', x: at!.x / d.W, y: lineTop(at!) / d.H, size: at!.size / d.H, blank: { kind: 'text', box: frac(at!.snap.rect, d.W, d.H) } };
}

function snapTick(d: Tap, p: [number, number], id: string): Extract<Stamp, { kind: 'mark' }> {
	const at = tickAt(d.data, p);
	expect(at, `tick tap ${p}`).not.toBeNull();
	return { id, kind: 'mark', mark: 'check', box: frac(at!.box, d.W, d.H), blank: { kind: 'check', box: frac(at!.snap.rect, d.W, d.H) } };
}

const opts = (blankFields: boolean, extra: Partial<ExportOptions> = {}): ExportOptions => ({ filename: 'x.pdf', compress: false, stripMetadata: false, blankFields, ...extra });

async function both(pages: PageRef[], sources: Source[], extra: Partial<ExportOptions> = {}, assets: Asset[] = [], formValues?: FormValues) {
	const withFields = await engine().exportPlan({ pages, options: opts(true, extra), formValues }, sources, assets);
	const plain = await engine().exportPlan({ pages, options: opts(false, extra), formValues }, sources, assets);
	return { withFields, plain };
}

interface ReadField {
	name: string;
	type: string;
	value: string;
	page: number;
	rect: number[];
}

/** Every widget MuPDF finds, page by page. */
async function widgets(bytes: Uint8Array, password?: string): Promise<ReadField[]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes.slice());
	if (password) doc.authenticatePassword(password);
	const out: ReadField[] = [];
	try {
		for (let i = 0; i < doc.countPages(); i++) {
			const page = doc.loadPage(i);
			for (const w of page.getWidgets()) {
				const r = w.getObject().get('Rect');
				out.push({ name: w.getName(), type: w.getFieldType(), value: w.getValue(), page: i, rect: [0, 1, 2, 3].map((k) => r.get(k).asNumber()) });
			}
		}
	} finally {
		doc.destroy();
	}
	return out;
}

/** Renders of every page of both exports, per renderer: no pixel differs by more than the harness's level, beyond rounding. */
async function looksSame(a: ExportResult, b: ExportResult, password?: string) {
	for (let p = 0; p < a.pageCount; p++) {
		const r = await compareThree(a.bytes, b.bytes, p, 144, password);
		for (const [who, d] of Object.entries(r)) expect(d.count, `page ${p + 1}, ${who}: ${d.count} pixels differ (max ${d.max})`).toBeLessThan(4);
	}
}

describe('filled blanks as form fields: what is made', () => {
	it('text on lines, in cells, comb rows, underscores, short and tall boxes, and ticks: fields that look like the stamps', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const stamps: Stamp[] = [
			snapText(d, [150, 95], 'Jane Émile', 'first'),
			snapText(d, [400, 97], 'Øster-Lund', 'last'),
			snapText(d, [200, 147], '12 Rue des Écoles', 'addr2'),
			snapText(d, [150, 205], 'Café crème', 'cell'),
			snapText(d, [125, 315], '493021', 'comb'),
			snapText(d, [380, 315], '555 0199', 'phone'),
			snapText(d, [380, 557], 'JÉ', 'short'),
			{ ...snapText(d, [100, 609], 'Two lines\nin a tall box', 'tall') },
			snapTick(d, [134, 263], 'yes'),
			snapTick(d, [304, 268], 'green')
		];
		const page = ref(source, 0, 0, stamps);
		const { withFields, plain } = await both([page], [source]);
		expect(withFields.blankFields).toEqual({ fields: 10, plain: 0 });
		expect(plain.blankFields).toBeUndefined();
		const check = withFields.checks.find((c) => c.name === 'blank-fields')!;
		expect(check.ok).toBe(true);
		expect(check.detail).toMatch(/10 filled blanks are form fields/);

		const ws = await widgets(withFields.bytes);
		expect(ws.map((w) => w.name)).toEqual(Array.from({ length: 10 }, (_, k) => `blank_p1_${k + 1}`));
		const byValue = new Map(ws.map((w) => [w.value, w]));
		for (const s of stamps) {
			if (s.kind === 'text') {
				const w = byValue.get(s.text)!;
				expect(w, s.text).toBeDefined();
				expect(w.type).toBe('text');
				// The rectangle covers the blank from 2 pt before the text (PDF space: y up from the bottom of the 792 pt page).
				const b = s.blank!.box;
				// (Corners are rounded outward to quarter points.)
				const left = Math.max(b.x * 612, s.x * 612 - 2);
				expect(w.rect[0]).toBeLessThanOrEqual(left + 1e-6);
				expect(w.rect[0]).toBeGreaterThan(left - 0.25);
				expect(w.rect.every((v) => Number.isInteger(v * 4))).toBe(true);
				expect(w.rect[2]).toBeGreaterThanOrEqual((b.x + b.w) * 612 - 1e-3);
				expect(w.rect[1]).toBeLessThanOrEqual(792 - (b.y + b.h) * 792 + 1e-3);
				expect(w.rect[3]).toBeGreaterThanOrEqual(792 - b.y * 792 - 1e-3);
			}
		}
		expect(ws.filter((w) => w.type === 'checkbox').map((w) => w.value)).toEqual(['Yes', 'Yes']);
		// Plain stamps' page has no form at all.
		expect(await widgets(plain.bytes)).toEqual([]);
		await looksSame(withFields, plain);
	}, T);

	it('writes no border, no background, its own /DA in the stamp size and colour, and never /NeedAppearances', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const t = { ...snapText(d, [150, 95], 'Azure', 't'), color: 'blue' as const };
		const res = await engine().exportPlan({ pages: [ref(source, 0, 0, [t, snapTick(d, [134, 263], 'c')])], options: opts(true) }, [source], []);
		const doc = await PDFDocument.load(res.bytes);
		const af = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
		expect(af.has(PDFName.of('NeedAppearances'))).toBe(false);
		const fonts = af.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
		expect(String(fonts.lookup(PDFName.of('Helv'), PDFDict).lookup(PDFName.of('BaseFont')))).toBe('/Helvetica');
		expect(String(fonts.lookup(PDFName.of('ZaDb'), PDFDict).lookup(PDFName.of('BaseFont')))).toBe('/ZapfDingbats');
		const fields = af.lookup(PDFName.of('Fields'), PDFArray);
		expect(fields.size()).toBe(2);
		const [tx, ck] = [0, 1].map((k) => fields.lookup(k, PDFDict));
		for (const w of [tx, ck]) {
			const mk = w.lookup(PDFName.of('MK'), PDFDict);
			expect(mk.has(PDFName.of('BC'))).toBe(false);
			expect(mk.has(PDFName.of('BG'))).toBe(false);
			expect(String(w.lookup(PDFName.of('BS'), PDFDict).lookup(PDFName.of('W')))).toBe('0');
		}
		expect(String(tx.lookup(PDFName.of('DA')))).toBe('(/Helv 11 Tf 0.051 0.227 0.62 rg)');
		expect(String(ck.lookup(PDFName.of('DA')))).toBe('(/ZaDb 0 Tf 0 g)');
		expect(String(ck.lookup(PDFName.of('AS')))).toBe('/Yes');
		// The page's own content no longer holds the text: only the field shows it.
		const m = await mupdf();
		const md = new m.PDFDocument(res.bytes.slice());
		const contentOnly = md.loadPage(0).toDisplayList(false).toStructuredText('preserve-whitespace').asText();
		expect(contentOnly).not.toContain('Azure');
		md.destroy();
	}, T);

	it('leaves the file as before with the option off', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const page = ref(source, 0, 0, [snapText(d, [150, 95], 'Jane', 't'), snapTick(d, [134, 263], 'c')]);
		const off = await engine().exportPlan({ pages: [page], options: opts(false) }, [source], []);
		const unset = await engine().exportPlan({ pages: [page], options: { filename: 'x.pdf', compress: false, stripMetadata: false } }, [source], []);
		// Same bytes but for the file identifier (/ID), which every export makes afresh.
		const noId = (b: Uint8Array) => Buffer.from(b).toString('latin1').replace(/\/ID\s*\[[^\]]*\]/g, '');
		expect(noId(off.bytes)).toBe(noId(unset.bytes));
		expect(off.blankFields).toBeUndefined();
	}, T);

	it('ignores the option when forms are flattened (and so when redacting)', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const page = ref(source, 0, 0, [snapText(d, [150, 95], 'Jane', 't')]);
		const flat = await engine().exportPlan({ pages: [page], options: opts(true, { flattenForms: true }) }, [source], []);
		expect(flat.blankFields).toBeUndefined();
		expect(await widgets(flat.bytes)).toEqual([]);
		const redacted = await engine().exportPlan({ pages: [{ ...page, stamps: [...page.stamps, { id: 'r', kind: 'redact', box: { x: 0.7, y: 0.9, w: 0.1, h: 0.03 } }] }], options: opts(true) }, [source], []);
		expect(redacted.blankFields).toBeUndefined();
		expect(await widgets(redacted.bytes)).toEqual([]);
	}, T);
});

describe('filled blanks as form fields: several answers on one blank', () => {
	it('side by side fields that do not overlap; text running into the next answer, and a second tick, stay plain', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		// "First name" line, x 130-290: two answers on it.
		const a = snapText(d, [150, 95], 'Ann', 'a');
		const b = snapText(d, [230, 95], 'Lee', 'b');
		expect(a.blank).toEqual(b.blank);
		const { withFields, plain } = await both([ref(source, 0, 0, [b, a])], [source]);
		expect(withFields.blankFields).toEqual({ fields: 2, plain: 0 });
		const ws = (await widgets(withFields.bytes)).sort((p, q) => p.rect[0] - q.rect[0]);
		expect(ws.map((w) => w.value)).toEqual(['Ann', 'Lee']);
		expect(ws[0].rect[0]).toBeCloseTo(148, 3);
		expect(ws[0].rect[2]).toBeCloseTo(228, 3);
		expect(ws[1].rect[0]).toBeCloseTo(228, 3);
		expect(ws[1].rect[2]).toBeCloseTo(290, 0);
		await looksSame(withFields, plain);

		const long = snapText(d, [150, 95], 'A name long enough to run on', 'long');
		const tick1 = snapTick(d, [134, 263], 't1');
		const tick2 = snapTick(d, [133, 262], 't2');
		const crowded = await both([ref(source, 0, 0, [long, b, tick1, tick2])], [source]);
		expect(crowded.withFields.blankFields).toEqual({ fields: 2, plain: 2 });
		expect((await widgets(crowded.withFields.bytes)).map((w) => w.value)).toEqual(['A name long enough to run on', 'Yes']);
		await looksSame(crowded.withFields, crowded.plain);
	}, T);
});

describe('filled blanks as form fields: what stays a plain stamp', () => {
	it('text a redrawing viewer could not show, several lines in a one-line blank, a stamp off its blank', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const ok = snapText(d, [150, 95], 'Jane', 'ok');
		const polish = snapText(d, [400, 97], 'Łódź', 'polish'); // Ł is in the stamp font, not in WinAnsi
		const lines = { ...snapText(d, [200, 147], 'one', 'lines'), text: 'one\ntwo' };
		const moved = { ...snapText(d, [150, 205], 'moved', 'moved'), y: 0.8 };
		const { withFields, plain } = await both([ref(source, 0, 0, [ok, polish, lines, moved])], [source]);
		expect(withFields.blankFields).toEqual({ fields: 1, plain: 3 });
		expect((await widgets(withFields.bytes)).map((w) => w.value)).toEqual(['Jane']);
		await looksSame(withFields, plain);
	}, T);

	it('a character outside the stamp font refuses the export as it always did', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const bad = snapText(d, [150, 95], 'Jane 中', 'bad');
		await expect(engine().exportPlan({ pages: [ref(source, 0, 0, [bad])], options: opts(true) }, [source], [])).rejects.toMatchObject({ code: 'unsupported' });
	}, T);

	it('a field whose look cannot be proved (an image stamp over the text) is drawn instead', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const t = snapText(d, [150, 95], 'Hidden under ink', 't');
		const keep = snapTick(d, [134, 263], 'c');
		// A white 2×2 PNG over the text: drawn on the page, it hides the text; a field would paint above it.
		const png = await whitePng();
		const asset: Asset = { id: 'ink', kind: 'image', png, width: 2, height: 2 };
		const img: Stamp = { id: 'img', kind: 'image', assetId: 'ink', box: { x: t.x, y: t.y, w: 0.15, h: 0.02 } };
		const { withFields, plain } = await both([ref(source, 0, 0, [t, img, keep])], [source], {}, [asset]);
		expect(withFields.blankFields).toEqual({ fields: 1, plain: 1 });
		expect((await widgets(withFields.bytes)).map((w) => w.type)).toEqual(['checkbox']);
		await looksSame(withFields, plain);
	}, T);
});

describe('filled blanks as form fields: pages and files', () => {
	it('a page turned by /Rotate, and a page the plan turns: upright fields that look the same', async () => {
		const source = await openCorpus('fill-fields-rotated.pdf');
		expect(source.pages[0]).toEqual({ width: 792, height: 612 });
		const d = await tapData(source);
		const stamps = [snapText(d, [200, 96], 'Rotated Ann', 'n'), snapTick(d, [134, 236], 'y')];
		const { withFields, plain } = await both([ref(source, 0, 0, stamps)], [source]);
		expect(withFields.blankFields).toEqual({ fields: 2, plain: 0 });
		await looksSame(withFields, plain);
		const doc = await PDFDocument.load(withFields.bytes);
		const f = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('Fields'), PDFArray).lookup(0, PDFDict);
		expect(String(f.lookup(PDFName.of('MK'), PDFDict).lookup(PDFName.of('R')))).toBe('90');
		// A plan that turns a page with linked stamps (the store drops links on rotate; the engine
		// still draws a correct field when given one).
		const forms = await openCorpus('forms-snap.pdf');
		const fd = await tapData(forms);
		const turned = await both([ref(forms, 0, 270, [snapText(fd, [150, 95], 'Turned', 't')])], [forms]);
		expect(turned.withFields.blankFields?.fields).toBe(1);
		await looksSame(turned.withFields, turned.plain);
	}, T);

	it('a duplicated page: independent fields with their own names', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const a = ref(source, 0, 0, [snapText(d, [150, 95], 'Copy one', 'a1'), snapTick(d, [134, 263], 'a2')]);
		const b = ref(source, 0, 0, [snapText(d, [150, 95], 'Copy two', 'b1'), snapTick(d, [134, 263], 'b2')]);
		const { withFields, plain } = await both([a, b], [source]);
		expect(withFields.blankFields).toEqual({ fields: 4, plain: 0 });
		const ws = await widgets(withFields.bytes);
		expect(ws.map((w) => [w.page, w.name, w.value])).toEqual([
			[0, 'blank_p1_1', 'Copy one'],
			[0, 'blank_p1_2', 'Yes'],
			[1, 'blank_p2_1', 'Copy two'],
			[1, 'blank_p2_2', 'Yes']
		]);
		const doc = await PDFDocument.load(withFields.bytes);
		const annots = doc.getPages().map((p) => p.node.lookup(PDFName.of('Annots'), PDFArray));
		const ids = annots.flatMap((arr) => [0, 1].map((k) => (arr.get(k) as PDFRef).toString()));
		expect(new Set(ids).size).toBe(4);
		await looksSame(withFields, plain);
	}, T);

	it('a file that already has a form: the new fields join it, the old answers still save', async () => {
		const source = await openCorpus('fill-fields-form.pdf');
		expect(source.hasForm).toBe(true);
		const d = await tapData(source, 1);
		const stamps = [snapText(d, [200, 96], 'New Field', 'n'), snapTick(d, [184, 236], 'no')];
		const values: FormValues = { [source.id]: { Name: 'Old Field', Agree: true } };
		const { withFields, plain } = await both([ref(source, 0), ref(source, 1, 0, stamps)], [source], {}, [], values);
		expect(withFields.blankFields).toEqual({ fields: 2, plain: 0 });
		expect(withFields.checks.find((c) => c.name === 'forms')?.ok).toBe(true);
		const ws = await widgets(withFields.bytes);
		expect(ws.map((w) => [w.page, w.name, w.value])).toEqual([
			[0, 'Name', 'Old Field'],
			[0, 'Agree', 'Yes'],
			[1, 'blank_p2_1', 'New Field'],
			[1, 'blank_p2_2', 'Yes']
		]);
		await looksSame(withFields, plain);
	}, T);

	it('a form with a field named like ours and another font as /Helv: a fresh name and font name', async () => {
		const source = await openCorpus('fill-fields-clash.pdf');
		const d = await tapData(source, 1);
		const { withFields, plain } = await both([ref(source, 0), ref(source, 1, 0, [snapText(d, [200, 96], 'Clash', 'n')])], [source]);
		expect(withFields.blankFields).toEqual({ fields: 1, plain: 0 });
		const ws = await widgets(withFields.bytes);
		expect(ws.filter((w) => w.page === 1).map((w) => w.name)).toEqual(['blank_p2_1_2']);
		const doc = await PDFDocument.load(withFields.bytes);
		const af = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
		const fonts = af.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
		expect(String(fonts.lookup(PDFName.of('Helv'), PDFDict).lookup(PDFName.of('BaseFont')))).toBe('/Courier');
		expect(String(fonts.lookup(PDFName.of('PgsHelv0'), PDFDict).lookup(PDFName.of('BaseFont')))).toBe('/Helvetica');
		await looksSame(withFields, plain);
	}, T);

	it('a form that asks viewers to redraw its fields: every stamp stays plain', async () => {
		const source = await openCorpus('fill-fields-redraw.pdf');
		const d = await tapData(source, 1);
		const res = await engine().exportPlan({ pages: [ref(source, 0), ref(source, 1, 0, [snapText(d, [200, 96], 'Plain', 'n')])], options: opts(true) }, [source], []);
		expect(res.blankFields).toEqual({ fields: 0, plain: 1 });
		expect((await widgets(res.bytes)).map((w) => w.name)).toEqual(['Name', 'Agree']);
	}, T);

	it('several sources merged, compressed and with a password', async () => {
		const a = await openCorpus('forms-snap.pdf');
		const b = await openCorpus('fill-fields-form.pdf');
		const blank = await engine().blankPage({ width: 612, height: 792 });
		const da = await tapData(a);
		const db = await tapData(b, 1);
		const pages = [ref(blank, 0), ref(a, 0, 0, [snapText(da, [150, 95], 'From A', 'a')]), ref(b, 1, 0, [snapText(db, [200, 96], 'From B', 'b'), snapTick(db, [134, 236], 'bt')])];
		const { withFields, plain } = await both(pages, [a, b, blank], { compress: true, password: 'secret-pass' });
		expect(withFields.blankFields).toEqual({ fields: 3, plain: 0 });
		expect(withFields.checks.every((c) => c.ok)).toBe(true);
		const ws = await widgets(withFields.bytes, 'secret-pass');
		expect(ws.filter((w) => w.name.startsWith('blank_')).map((w) => [w.page, w.name, w.value])).toEqual([
			[1, 'blank_p2_1', 'From A'],
			[2, 'blank_p3_1', 'From B'],
			[2, 'blank_p3_2', 'Yes']
		]);
		await looksSame(withFields, plain, 'secret-pass');
	}, T);
});

describe('filled blanks as form fields: with a size target', () => {
	it('the fields survive the shrink stage and its own checks', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const res = await engine().exportPlan({ pages: [ref(source, 0, 0, [snapText(d, [150, 95], 'Small', 't')]), ref(source, 1)], options: opts(true, { compress: true, targetBytes: 60_000 }) }, [source], []);
		expect(res.blankFields).toEqual({ fields: 1, plain: 0 });
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(res.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['visual', 'target-size', 'blank-fields']));
		expect((await widgets(res.bytes)).map((w) => w.value)).toEqual(['Small']);
	}, T);
});

describe('filled blanks as form fields: the proof itself', () => {
	it('notices a wrong value, a wrong rectangle, a missing field and a different look', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const page = ref(source, 0, 0, [snapText(d, [150, 95], 'Proof', 't'), snapTick(d, [134, 263], 'c')]);
		const { withFields, plain } = await both([page], [source]);
		const ws = await widgets(withFields.bytes);
		const made: MadeField[] = ws.map((w, k) => ({
			stampId: `s${k}`,
			page: 0,
			name: w.name,
			kind: w.type === 'text' ? 'text' : 'check',
			value: w.type === 'text' ? w.value : '',
			rect: { x0: w.rect[0], y0: w.rect[1], x1: w.rect[2], y1: w.rect[3] },
			shown: { x0: w.rect[0] / 612, y0: 1 - w.rect[3] / 792, x1: w.rect[2] / 612, y1: 1 - w.rect[1] / 792 }
		}));
		const deps = { mupdf, pdfjs: loadPdfjs } as unknown as EngineDeps;
		expect((await proveFields(deps, plain.bytes, withFields.bytes, made)).size).toBe(0);
		expect((await verifyBlankFields(deps, withFields.bytes, made)).ok).toBe(true);
		const wrongValue = made.map((f) => (f.kind === 'text' ? { ...f, value: 'Other' } : f));
		expect([...(await proveFields(deps, plain.bytes, withFields.bytes, wrongValue)).values()].join()).toMatch(/value reads back differently/);
		expect((await verifyBlankFields(deps, withFields.bytes, wrongValue)).ok).toBe(false);
		const wrongRect = made.map((f) => ({ ...f, rect: { ...f.rect, x1: f.rect.x1 + 3 } }));
		expect((await proveFields(deps, plain.bytes, withFields.bytes, wrongRect)).size).toBe(2);
		// No fields at all (the plain file given as the one with fields).
		expect((await proveFields(deps, plain.bytes, plain.bytes, made)).size).toBe(2);
		// A look that differs: the fields file compared with an export without the stamps.
		const bare = await engine().exportPlan({ pages: [ref(source, 0)], options: opts(false) }, [source], []);
		const looks = await proveFields(deps, bare.bytes, withFields.bytes, made);
		expect([...looks.values()].join()).toMatch(/looks different|did not lose/);
	}, T);
});

describe('filled blanks as form fields: opened here again', () => {
	it('lists the fields with their answers, refills them and exports verified', async () => {
		const source = await openCorpus('forms-snap.pdf');
		const d = await tapData(source);
		const first = await engine().exportPlan(
			{ pages: [ref(source, 0, 0, [snapText(d, [150, 95], 'Jane', 't'), snapTick(d, [134, 263], 'c'), snapText(d, [100, 609], 'Line one\nLine two', 'tall')])], options: opts(true, { compress: true }) },
			[source],
			[]
		);
		const again = await engine().openPdf(first.bytes, 'again.pdf');
		expect(again.hasForm).toBe(true);
		const fields = await engine().formFields(again);
		expect(fields.map((f) => [f.name, f.kind, f.value, f.readOnly, f.multiline ?? false])).toEqual([
			['blank_p1_1', 'text', 'Jane', false, false],
			['blank_p1_2', 'checkbox', true, false, false],
			['blank_p1_3', 'text', 'Line one\nLine two', false, true]
		]);
		// No snapping there any more: the page has widgets now (editor/snap-cache.ts snapEligible).
		const values: FormValues = { [again.id]: { blank_p1_1: 'Janet Müller', blank_p1_2: false, blank_p1_3: 'Changed' } };
		const second = await engine().exportPlan({ pages: [ref(again, 0)], options: opts(false), formValues: values }, [again], []);
		expect(second.checks.find((c) => c.name === 'forms')?.ok).toBe(true);
		const reread = await engine().formFields(await engine().openPdf(second.bytes, 'second.pdf'));
		expect(reread.map((f) => f.value)).toEqual(['Janet Müller', false, 'Changed']);
	}, T);
});

async function whitePng(): Promise<Uint8Array> {
	const zlib = await import('node:zlib');
	const crc = (buf: Buffer) => {
		let c = ~0;
		for (const b of buf) {
			c ^= b;
			for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
		}
		return ~c >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(2, 0);
	ihdr.writeUInt32BE(2, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.from([0, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255]);
	return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
