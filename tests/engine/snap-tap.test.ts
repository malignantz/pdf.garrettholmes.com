/**
 * Snap on tap as the editor ships it: the engine's pageBlanks (engine/snap-tap.ts,
 * through the core engine like the worker serves it) and the editor's decision
 * (editor/snap.ts textAt / tickAt, editor/snap-cache.ts). Corpus:
 * tests/corpus/generate-forms-snap.mjs (positions top-down, points; p2 a scan).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import type { FormField, PageRef, Source } from '../../src/lib/core/types';
import type { TapData } from '../../src/lib/engine/snap-tap';
import { MAX_SNAP_CONTENT_BYTES } from '../../src/lib/engine/snap-tap';
import { lineTop, textAt, tickAt, PAD } from '../../src/lib/editor/snap';
import { requestBlanks, resetSnapCache, snapEligible, snappedText, snappedTick } from '../../src/lib/editor/snap-cache';
import type * as MU from 'mupdf';
import { collectInk } from '../../src/lib/engine/forms-detect';
import { engine, openCorpus, ref as pageRef } from './helpers';

const T = 60_000;

let cached: TapData | null = null;
async function data(): Promise<TapData> {
	if (cached) return cached;
	const b = await engine().pageBlanks(await openCorpus('forms-snap.pdf'), 0);
	expect(b.declined).toBe(false);
	expect([b.width, b.height]).toEqual([612, 792]);
	cached = b.data as TapData;
	return cached;
}

describe('snap on tap: text', () => {
	it('puts text on the line the tap was near: baseline 2 pt above it, start at the tap', async () => {
		const d = await data();
		// Sloppy taps above "First name ____" (line at y 102, x 130-290).
		for (const p of [[140, 90], [150, 97], [200, 85], [260, 101]] as [number, number][]) {
			const t = textAt(d, p)!;
			expect(t, `tap ${p}`).not.toBeNull();
			expect(t.baseline).toBeCloseTo(102 - PAD, 1);
			expect(t.x).toBeCloseTo(p[0], 6);
			expect(t.size).toBe(11);
		}
		// The second line of the row, and the second of two stacked address lines.
		expect(textAt(d, [400, 97])!.baseline).toBeCloseTo(100, 1);
		expect(textAt(d, [200, 147])!.baseline).toBeCloseTo(150, 0);
	}, T);

	it('clamps the start 2 pt inside the blank', async () => {
		const d = await data();
		// Just left of the line's start (tap 3 pt outside, still beside it).
		const t = textAt(d, [128, 96])!;
		expect(t.x).toBeCloseTo(132, 1);
		const end = textAt(d, [289.5, 96])!;
		expect(end.x).toBeCloseTo(288, 1);
	}, T);

	it('fills empty cells, comb rows and underscore runs at their bottom', async () => {
		const d = await data();
		expect(textAt(d, [150, 205])!.baseline).toBeCloseTo(213.5 - PAD, 1);
		expect(textAt(d, [125, 315])!.baseline).toBeCloseTo(321 - PAD, 1);
		expect(textAt(d, [380, 315])!.baseline).toBeCloseTo(321.2 - PAD, 1);
		expect(textAt(d, [120, 360])!.baseline).toBeCloseTo(371.5 - PAD, 1);
	}, T);

	it('steps text down in a short box, never below 8 pt', async () => {
		const d = await data();
		const t = textAt(d, [380, 557])!;
		expect(t.size).toBe(8);
		expect(t.baseline).toBeCloseTo(560.5 - PAD, 1);
		// Capitals (0.72 em) stay inside the 7.5 pt box.
		expect(t.baseline - 0.72 * t.size).toBeGreaterThanOrEqual(552.5);
	}, T);

	it('keeps the tapped line in a tall box: plain in its middle, kept inside near its edges', async () => {
		const d = await data();
		// Comments box: y 553-611.5 (60 pt tall).
		expect(textAt(d, [100, 580])).toBeNull();
		const low = textAt(d, [100, 609])!;
		expect(low.baseline).toBeCloseTo(611.5 - PAD, 1);
		const high = textAt(d, [100, 554])!;
		expect(high.baseline).toBeCloseTo(553 + 10, 1);
	}, T);

	it('does not snap on a paragraph, in the margin, on a filled table or on a checkbox', async () => {
		const d = await data();
		for (const p of [[150, 418], [200, 432], [30, 600], [560, 700], [85, 482], [232, 497], [134, 263], [184, 264]] as [number, number][])
			expect(textAt(d, p), `tap ${p}`).toBeNull();
		// (Free space beside a number in a data cell, [300, 497], scores 0.44: above the cutoff it snaps.
		// The plan's backlog lists data tables as a known limit.)
	}, T);

	it('stores the snapped position as an ordinary text stamp origin', async () => {
		const d = await data();
		const t = textAt(d, [150, 95])!;
		// Line top = baseline − 0.988 em (STAMP_BASELINE_EM): the export draws the baseline there.
		expect(lineTop(t)).toBeCloseTo(100 - 0.988 * 11, 2);
	}, T);
});

describe('snap on tap: check', () => {
	it('centres and sizes the tick to a drawn square tapped on or beside', async () => {
		const d = await data();
		for (const p of [[134, 263], [141, 263], [128, 266]] as [number, number][]) expect(tickAt(d, p)!.box, `tap ${p}`).toEqual([130, 259, 139, 268]);
		expect(tickAt(d, [304, 268])!.box).toEqual([300, 263, 309, 272]);
	}, T);

	it('leaves a tap between two stacked boxes, and taps off any box, where they are', async () => {
		const d = await data();
		expect(tickAt(d, [304, 261])).toBeNull();
		for (const p of [[150, 95], [150, 205], [125, 315], [150, 418], [30, 600]] as [number, number][]) expect(tickAt(d, p), `tap ${p}`).toBeNull();
	}, T);
});

describe('snap on tap: which pages', () => {
	it('declines a scanned page, even with a line drawn over the scan', async () => {
		const b = await engine().pageBlanks(await openCorpus('forms-snap.pdf'), 1);
		expect(b.declined).toBe(true);
		expect(b.data).toBeNull();
	}, T);

	it('declines a page over the content budget before reading it', async () => {
		const doc = await PDFDocument.create();
		const page = doc.addPage([612, 792]);
		const op = '10 10 m 20 20 l S\n';
		const content = op.repeat(Math.ceil((MAX_SNAP_CONTENT_BYTES + 1024) / op.length));
		page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
		const src = await engine().openPdf(await doc.save(), 'big.pdf');
		const t0 = performance.now();
		const b = await engine().pageBlanks(src, 0);
		expect(b.declined).toBe(true);
		expect(performance.now() - t0).toBeLessThan(5000);
	}, T);

	it('declines an image source', async () => {
		const src = await engine().blankPage({ width: 612, height: 792 });
		const b = await engine().pageBlanks({ ...src, kind: 'image' }, 0);
		expect(b.declined).toBe(true);
	}, T);

	const ref = (over: Partial<PageRef> = {}): PageRef => ({ id: 'p', sourceId: 's', pageIndex: 0, rotation: 0, stamps: [], ...over });
	const src = { id: 's', kind: 'pdf' } as Source;
	const field = (pageIndex: number) => ({ widgets: [{ pageIndex, box: { x: 0, y: 0, w: 0.1, h: 0.1 } }] }) as FormField;

	it('snaps only on upright PDF pages without form fields, once the fields are known', () => {
		expect(snapEligible(src, ref(), [])).toBe(true);
		expect(snapEligible(src, ref(), [field(1)])).toBe(true);
		expect(snapEligible(src, ref(), [field(0)])).toBe(false);
		expect(snapEligible(src, ref(), undefined)).toBe(false);
		expect(snapEligible(src, ref({ rotation: 90 }), [])).toBe(false);
		expect(snapEligible({ ...src, kind: 'image' }, ref(), [])).toBe(false);
		expect(snapEligible(undefined, ref(), [])).toBe(false);
	});

	it('answers null until the page has been read, then converts to page fractions', async () => {
		resetSnapCache();
		const source = await openCorpus('forms-snap.pdf');
		const r = ref({ sourceId: source.id });
		const f = { x: 150 / 612, y: 95 / 792 };
		let release!: () => void;
		const gate = new Promise<void>((res) => (release = res));
		requestBlanks({ pageBlanks: async (s, i) => (await gate, engine().pageBlanks(s, i)) }, source, 0);
		expect(snappedText(source, r, f)).toBeNull();
		release();
		await expect.poll(() => snappedText(source, r, f), { timeout: 20_000 }).not.toBeNull();
		const t = snappedText(source, r, f)!;
		expect(t.x).toBeCloseTo(150 / 612, 6);
		expect(t.size).toBeCloseTo(11 / 792, 6);
		expect(t.y * 792 + 0.988 * 11).toBeCloseTo(100, 1);
		const tick = snappedTick(source, r, { x: 134 / 612, y: 263 / 792 })!;
		expect(tick.x * 612).toBeCloseTo(130, 3);
		expect(tick.w * 612).toBeCloseTo(9, 3);
		expect(tick.h * 792).toBeCloseTo(9, 3);
		// A failed read: no snapping there, no error.
		requestBlanks({ pageBlanks: async () => Promise.reject(new Error('boom')) }, source, 1);
		await new Promise((res) => setTimeout(res, 10));
		expect(snappedText(source, ref({ sourceId: source.id, pageIndex: 1 }), f)).toBeNull();
	}, T);
});

describe('snap on tap: preview matches export', () => {
	it('a snapped text stamp is drawn on the line in the exported file', async () => {
		resetSnapCache();
		const source = await openCorpus('forms-snap.pdf');
		const r = pageRef(source, 0);
		requestBlanks(engine(), source, 0);
		const f = { x: 150 / 612, y: 93 / 792 };
		await expect.poll(() => snappedText(source, r, f), { timeout: 20_000 }).not.toBeNull();
		const at = snappedText(source, r, f)!;
		const tick = snappedTick(source, r, { x: 141 / 612, y: 264 / 792 })!;
		r.stamps = [
			{ id: 't', kind: 'text', text: 'JANE', color: 'black', ...at },
			{ id: 'c', kind: 'mark', mark: 'check', box: tick }
		];
		const res = await engine().exportPlan({ pages: [r], options: { filename: 'x.pdf', compress: false, stripMetadata: false } }, [source], []);
		const m = (await import('mupdf')) as unknown as typeof MU;
		const doc = m.Document.openDocument(res.bytes, 'application/pdf');
		const ink = collectInk(m as never, doc.loadPage(0));
		const jane = ink.glyphs.filter((g) => 'JANE'.includes(g.ch) && g.size > 10.9 && g.size < 11.1);
		expect(jane).toHaveLength(4);
		for (const g of jane) expect(g.base).toBeCloseTo(100, 1);
		expect(Math.min(...jane.map((g) => g.r[0]))).toBeCloseTo(150, 0);
		// The tick is drawn too (its box is the square, tested above; marks export like any mark).
		const before = collectInk(m as never, (m.Document.openDocument(source.bytes, 'application/pdf')).loadPage(0)).paths;
		expect(ink.paths).toBeGreaterThan(before);
	}, T);
});

