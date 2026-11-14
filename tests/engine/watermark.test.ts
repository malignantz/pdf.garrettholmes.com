/**
 * Watermark (ExportOptions.watermark) through exportPlan with the real engines: every
 * page carries the text, upright as displayed, whatever /Rotate, the app's rotation,
 * box origin and UserUnit; with page numbers, redaction, accessibility tags and a
 * password; refused when the font cannot draw it or a page is too small. Read back
 * independently with PDF.js (angle on screen and position), and with pdf-lib for the
 * artifact marking.
 */
import { describe, expect, it } from 'vitest';
import * as PdfLib from '@cantoo/pdf-lib';
import type { ExportOptions, PageRef, Rotation, Source, Stamp, Watermark } from '../../src/lib/core/types';
import { verifyWatermark, watermarkLayout } from '../../src/lib/engine/watermark';
import { defaultOptions, engine, loadPdfjs, openCorpus, ref } from './helpers';
import { makeSource, render } from './render-helpers';
import type { EngineDeps } from '../../src/lib/engine/deps';

const T = 120_000;
const wm: Watermark = { text: 'CONFIDENTIAL', look: 'diagonal', strength: 'medium', color: 'grey' };

async function exportWith(pages: PageRef[], sources: Source[], options: Partial<ExportOptions> = {}) {
	const res = await engine().exportPlan({ pages, options: { ...defaultOptions, watermark: wm, ...options } }, sources, []);
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
	expect(res.checks.find((c) => c.name === 'watermark')?.ok).toBe(true);
	return res;
}

interface Run {
	/** Direction on screen, degrees counter-clockwise from level. */
	deg: number;
	/** Middle of the run (half a cap height above the baseline), as fractions of the page shown. */
	mx: number;
	my: number;
}

/** The watermark run of every page, read with PDF.js. */
async function runs(bytes: Uint8Array, text: string, password?: string): Promise<Run[]> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), password, verbosity: 0, useWasm: false });
	const doc = await task.promise;
	const out: Run[] = [];
	try {
		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const vp = page.getViewport({ scale: 1 });
			const tc = await page.getTextContent();
			const it = tc.items.find((x) => 'str' in x && x.str.replace(/\s/g, '') === text.replace(/\s/g, ''));
			expect(it, `page ${i}`).toBeTruthy();
			if (!it || !('str' in it)) continue;
			const [a, b, c, d, e, f] = it.transform as number[];
			const h = Math.hypot(a, b);
			const p0 = vp.convertToViewportPoint(e, f) as number[];
			const p1 = vp.convertToViewportPoint(e + (it.width * a) / h, f + (it.width * b) / h) as number[];
			const pu = vp.convertToViewportPoint(e + c * 0.357, f + d * 0.357) as number[];
			const mx = (p0[0] + p1[0]) / 2 + (pu[0] - p0[0]);
			const my = (p0[1] + p1[1]) / 2 + (pu[1] - p0[1]);
			out.push({ deg: (Math.atan2(-(p1[1] - p0[1]), p1[0] - p0[0]) * 180) / Math.PI, mx: mx / vp.width, my: my / vp.height });
		}
	} finally {
		await task.destroy();
	}
	return out;
}

/** Expected angle on screen of a diagonal watermark on a page shown W × H. */
const diag = (W: number, H: number) => (Math.atan2(H, W) * 180) / Math.PI;

describe('watermark layout', () => {
	it('fits inside the page on every shape and never grows past a fifth of the shorter side', () => {
		for (const [W, H] of [[612, 792], [792, 612], [300, 2000], [2000, 300], [100, 100]]) {
			for (const look of ['diagonal', 'straight'] as const) {
				for (const adv of [1, 3, 7, 25]) {
					const l = watermarkLayout(W, H, adv, look);
					const c = Math.cos(l.angle);
					const s = Math.sin(l.angle);
					expect(l.width * c + l.size * s).toBeLessThanOrEqual(0.8 * W + 1e-9);
					expect(l.width * s + l.size * c).toBeLessThanOrEqual(0.8 * H + 1e-9);
					expect(l.size).toBeLessThanOrEqual(0.2 * Math.min(W, H) + 1e-9);
				}
			}
		}
	});
});

describe('watermark in exports', () => {
	it('every /Rotate and user rotation: upright on screen, along the shown diagonal, centred', async () => {
		const specs = [0, 90, 180, 270].map((rotate) => ({ w: 612, h: 792, rotate }));
		const src = await makeSource(specs);
		const pages: PageRef[] = [];
		for (let i = 0; i < 4; i++) for (const r of [0, 90, 180, 270] as Rotation[]) pages.push(ref(src, i, r));
		const res = await exportWith(pages, [src]);
		const got = await runs(res.bytes, wm.text);
		expect(got).toHaveLength(16);
		pages.forEach((p, k) => {
			const turned = ((specs[p.pageIndex].rotate + p.rotation) / 90) % 2 === 1;
			const [W, H] = turned ? [792, 612] : [612, 792];
			expect(got[k].deg, `page ${k + 1}`).toBeCloseTo(diag(W, H), 0);
			expect(got[k].mx).toBeCloseTo(0.5, 1);
			expect(got[k].my).toBeCloseTo(0.5, 1);
		});
	}, T);

	it('straight, red, light; odd boxes (non-zero origin crop), UserUnit and mixed sizes', async () => {
		const src = await makeSource([
			{ w: 612, h: 792, crop: [100, 150, 500, 600] },
			{ w: 400, h: 400, userUnit: 2 },
			{ w: 2000, h: 300 },
			{ w: 300, h: 2000, rotate: 90, crop: [20, 40, 280, 1900] }
		]);
		const pages = [0, 1, 2, 3].map((i) => ref(src, i));
		const res = await exportWith(pages, [src], { watermark: { text: 'Copy for Ana Núñez', look: 'straight', strength: 'light', color: 'red' } });
		const got = await runs(res.bytes, 'Copy for Ana Núñez');
		expect(got).toHaveLength(4);
		for (const r of got) {
			expect(Math.abs(r.deg)).toBeLessThan(0.5);
			expect(r.mx).toBeCloseTo(0.5, 1);
			expect(r.my).toBeCloseTo(0.5, 1);
		}
	}, T);

	it('with page numbers, a password, and drawn as a see-through pagination artifact', async () => {
		const src = await makeSource([{ w: 612, h: 792 }, { w: 612, h: 792 }]);
		const res = await exportWith([ref(src, 0), ref(src, 1)], [src], {
			numbering: { style: 'page-n', position: 'bottom-center', start: 1, skip: 0, size: 10 },
			password: 'pw'
		});
		expect(res.checks.find((c) => c.name === 'numbering')?.ok).toBe(true);
		expect(await runs(res.bytes, wm.text, 'pw')).toHaveLength(2);
		// The content of an export without a password: the marking and the see-through state.
		const plain = await exportWith([ref(src, 0)], [src]);
		const doc = await PdfLib.PDFDocument.load(plain.bytes, { updateMetadata: false });
		const page = doc.getPages()[0];
		const contents = page.node.lookup(PdfLib.PDFName.of('Contents'));
		const list = contents instanceof PdfLib.PDFArray ? contents.asArray() : [page.node.get(PdfLib.PDFName.of('Contents'))];
		const text = list
			.map((r) => doc.context.lookup(r))
			.map((s) => new TextDecoder('latin1').decode(PdfLib.decodePDFRawStream(s as PdfLib.PDFRawStream).decode()))
			.join('\n');
		expect(text).toContain('/Artifact << /Type /Pagination /Subtype /Watermark >> BDC');
		const name = /\/(PgsWm\d+) gs/.exec(text)?.[1];
		expect(name).toBeTruthy();
		const gs = page.node.Resources()!.lookup(PdfLib.PDFName.of('ExtGState'), PdfLib.PDFDict);
		const wmGs = gs.lookup(PdfLib.PDFName.of(name!), PdfLib.PDFDict);
		expect((wmGs.lookup(PdfLib.PDFName.of('ca')) as PdfLib.PDFNumber).asNumber()).toBeCloseTo(0.38, 2);
	}, T);

	it('with redaction: the box stays solid black and the redaction check passes', async () => {
		const src = await makeSource([{ w: 612, h: 792 }]);
		const box = { x: 0.15, y: 0.33, w: 0.6, h: 0.14 };
		const stamps: Stamp[] = [{ id: 'r1', kind: 'redact', box }];
		const res = await exportWith([ref(src, 0, 0, stamps)], [src]);
		expect(res.checks.find((c) => c.name === 'redaction')?.ok).toBe(true);
		const r = await render(res.bytes, 0, 1);
		for (let fy = box.y + 0.01; fy < box.y + box.h - 0.01; fy += 0.01) {
			for (let fx = box.x + 0.01; fx < box.x + box.w - 0.01; fx += 0.01) {
				expect(Math.max(...r.at(fx, fy))).toBeLessThanOrEqual(40);
			}
		}
		// Outside the box the watermark still shows: grey pixels along the diagonal.
		let grey = 0;
		for (let t = 0; t < 1; t += 0.002) {
			const [v] = r.at(0.1 + 0.8 * t, 0.9 - 0.8 * t);
			if (v > 60 && v < 240) grey++;
		}
		expect(grey).toBeGreaterThan(5);
	}, T);

	it('keeps accessibility tags', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const res = await exportWith(src.pages.map((_, i) => ref(src, i)), [src]);
		expect(res.tags).toEqual({ kept: true });
		expect(res.checks.find((c) => c.name === 'tags')?.ok).toBe(true);
	}, T);

	it('refuses characters the font cannot draw, long text and pages too small; the check catches a missing or different one', async () => {
		const src = await makeSource([{ w: 612, h: 792 }]);
		const tiny = await makeSource([{ w: 30, h: 30 }]);
		const fail = (pages: PageRef[], sources: Source[], w: Watermark) =>
			engine()
				.exportPlan({ pages, options: { ...defaultOptions, watermark: w } }, sources, [])
				.then(
					() => null,
					(e) => e as { code: string; message: string }
				);
		const cjk = await fail([ref(src, 0)], [src], { ...wm, text: '秘密' });
		expect(cjk?.code).toBe('unsupported');
		expect(cjk?.message).toContain('秘 密');
		expect((await fail([ref(src, 0)], [src], { ...wm, text: 'x'.repeat(41) }))?.code).toBe('unsupported');
		expect((await fail([ref(src, 0)], [src], { ...wm, text: '   ' }))?.message).toBe('Type the watermark text.');
		expect((await fail([ref(tiny, 0)], [tiny], wm))?.message).toContain('too small for this watermark');

		const deps = { pdfjs: loadPdfjs } as unknown as EngineDeps;
		const plain = await engine().exportPlan({ pages: [ref(src, 0)], options: defaultOptions }, [src], []);
		expect((await verifyWatermark(deps, plain.bytes, wm, 1)).ok).toBe(false);
		const draft = await exportWith([ref(src, 0)], [src], { watermark: { ...wm, text: 'DRAFT' } });
		expect((await verifyWatermark(deps, draft.bytes, wm, 1)).ok).toBe(false);
		expect((await verifyWatermark(deps, draft.bytes, { ...wm, text: 'DRAFT', look: 'straight' }, 1)).ok).toBe(false);
		expect((await verifyWatermark(deps, draft.bytes, { ...wm, text: 'DRAFT' }, 1)).ok).toBe(true);
	}, T);
});
