/**
 * MuPDF robustness found by the survey of 600 real files (2026-11-10):
 * - redact-survey.pdf: constructs that made the redact stage lose image data, free a
 *   shade MuPDF still owned, or throw on a null annotation;
 * - a WebAssembly trap becomes a plain refusal and the MuPDF instance is replaced;
 * - many redactions and exports in one long-lived process (the browser's engine
 *   worker lives as long as the tab) keep working.
 */

import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { PageRef, Source, Stamp, StampBox } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import { EngineError } from '../../src/lib/engine/errors';
import { discardMupdf, isRetired, isWasmFault, mupdf, type Mupdf } from '../../src/lib/engine/mupdf';
import { corpus, defaultOptions, engine, manifest, nodeAssets, openCorpus, pageTexts, ref } from './helpers';

const T = 180_000;

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

type UserRect = [number, number, number, number];
const meta = manifest['redact-survey.pdf'] as unknown as {
	box: { rect: UserRect; hides: string[] };
	image: UserRect;
	shading: UserRect;
	keep: string[];
	tight: { line: string; keep: string[] };
	times: { line: string; keep: string[] };
};

function frac([x0, y0, x1, y1]: UserRect, w = 612, h = 792): StampBox {
	return { x: x0 / w, y: (h - y1) / h, w: (x1 - x0) / w, h: (y1 - y0) / h };
}
let sid = 0;
const redact = (box: StampBox): Stamp => ({ id: `r${sid++}`, kind: 'redact', box });

async function redactSurvey(eng = engine()) {
	const src = await openCorpus('redact-survey.pdf');
	return eng.exportPlan({ pages: [ref(src, 0, 0, [redact(frac(meta.box.rect))])], options: defaultOptions }, [src], []);
}

/** Mean RGB of a user-space rect of page 1, rendered by MuPDF at 1 px/pt. */
async function meanColour(bytes: Uint8Array, [x0, y0, x1, y1]: UserRect): Promise<number[]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	const page = doc.loadPage(0);
	const pix = page.toPixmap(m.Matrix.identity, m.ColorSpace.DeviceRGB, false, true);
	try {
		const stride = pix.getStride();
		const px = pix.getPixels();
		const sum = [0, 0, 0];
		let n = 0;
		for (let y = Math.ceil(792 - y1) + 2; y < Math.floor(792 - y0) - 2; y++) {
			for (let x = Math.ceil(x0) + 2; x < Math.floor(x1) - 2; x++) {
				for (let k = 0; k < 3; k++) sum[k] += px[y * stride + x * 3 + k];
				n++;
			}
		}
		return sum.map((s) => s / n);
	} finally {
		pix.destroy();
		page.destroy();
		doc.destroy();
	}
}

describe('MuPDF: constructs from the survey (redact-survey.pdf)', () => {
	it('keeps an image with an indirect colour space, a form, a shading and a link; skips a null annotation', async () => {
		const res = await redactSurvey();
		expect(res.checks.every((c) => c.ok)).toBe(true);
		const text = (await pageTexts(res.bytes))[0];
		for (const k of meta.keep) expect(text).toContain(k);
		expect(text).not.toContain('SECRET-SURVEY-LINE');
		// The image still has its pixels (it was saved as an empty dictionary before).
		const img = await meanColour(res.bytes, meta.image);
		expect(img[0]).toBeGreaterThan(150);
		expect(Math.max(...img) - Math.min(...img)).toBeGreaterThan(20);
		// The shading still paints (red to blue).
		const sh = await meanColour(res.bytes, meta.shading);
		expect(sh[1]).toBeLessThan(60);
		const m = await mupdf();
		const doc = new m.PDFDocument(res.bytes);
		try {
			const annots = doc.loadPage(0).getObject().get('Annots');
			expect(annots.isArray() ? annots.length : 0).toBe(1);
			const xo = doc.loadPage(0).getObject().get('Resources').get('XObject');
			xo.forEach((v) => expect(v.isStream()).toBe(true));
		} finally {
			doc.destroy();
		}
	}, T);

	it('a shading on a redacted page is not freed behind MuPDF’s back (garbage collection between runs)', async () => {
		const before = await mupdf();
		for (let i = 0; i < 6; i++) {
			const res = await redactSurvey();
			expect(res.checks.every((c) => c.ok)).toBe(true);
			gc();
			await new Promise((r) => setTimeout(r, 20));
			gc();
			(await mupdf()).emptyStore();
		}
		// No trap anywhere: the instance was never replaced.
		expect(await mupdf()).toBe(before);
		expect(isRetired(before)).toBe(false);
	}, T);
});

/** The box a person (and the survey) draws over a line: its MuPDF line box plus 1 pt. */
async function lineBox(src: Source, pageIndex: number, line: string): Promise<StampBox> {
	const m = await mupdf();
	const doc = new m.PDFDocument(src.bytes);
	try {
		const page = doc.loadPage(pageIndex);
		const st = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
			blocks: { lines?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] }[];
		};
		for (const b of st.blocks) {
			for (const l of b.lines ?? []) {
				if (l.text.includes(line)) return { x: (l.bbox.x - 1) / 612, y: (l.bbox.y - 1) / 792, w: (l.bbox.w + 2) / 612, h: (l.bbox.h + 2) / 792 };
			}
		}
	} finally {
		doc.destroy();
	}
	throw new Error(`no line ${line}`);
}

describe('redaction: text next to the box (redact-survey.pdf page 2)', () => {
	it('keeps the lines above and below whose nominal boxes, not their ink, reach into the box', async () => {
		// The 36 pt title above and the next line have ascent/descent boxes that reach into
		// the box. Redacting with the box (or growing it over touched glyphs) took in whole
		// neighbouring lines: text outside the box vanished.
		const src = await openCorpus('redact-survey.pdf');
		const box = await lineBox(src, 1, meta.tight.line);
		const res = await engine().exportPlan({ pages: [ref(src, 1, 0, [redact(box)])], options: defaultOptions }, [src], []);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		const text = (await pageTexts(res.bytes))[0];
		expect(text).not.toContain(meta.tight.line);
		for (const k of [...meta.tight.keep, ...meta.times.keep]) expect(text).toContain(k);
	}, T);

	it('is not refused when only the PDF.js band above the capitals of the next line reaches the box', async () => {
		// Times capitals are 0.66 em tall; the box ends 0.7 em above the next baseline.
		const src = await openCorpus('redact-survey.pdf');
		const box = await lineBox(src, 1, meta.times.line);
		const res = await engine().exportPlan({ pages: [ref(src, 1, 0, [redact(box)])], options: defaultOptions }, [src], []);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		const text = (await pageTexts(res.bytes))[0];
		expect(text).not.toContain(meta.times.line);
		for (const k of [...meta.tight.keep, ...meta.times.keep]) expect(text).toContain(k);
	}, T);
});

describe('MuPDF: a WebAssembly trap', () => {
	it('is recognised by kind, not by any error', () => {
		expect(isWasmFault(new WebAssembly.RuntimeError('memory access out of bounds'))).toBe(true);
		expect(isWasmFault(Object.assign(new Error('null function or function signature mismatch'), { name: 'RuntimeError' }))).toBe(true);
		expect(isWasmFault(new Error('memory access out of bounds'))).toBe(false);
		expect(isWasmFault(new TypeError('x'))).toBe(false);
		expect(isWasmFault(null)).toBe(false);
	});

	it('becomes a plain refusal, retires the instance, and the next export gets a new working one', async () => {
		const real = await mupdf();
		class Trap {
			constructor() {
				throw new WebAssembly.RuntimeError('memory access out of bounds');
			}
		}
		const trapping = new Proxy(real, { get: (t, k) => (k === 'PDFDocument' ? Trap : Reflect.get(t, k)) }) as Mupdf;
		const eng = createCoreEngine({ ...nodeAssets(), mupdf: async () => trapping });
		const src = await eng.openPdf(corpus('redact-survey.pdf'), 'redact-survey.pdf');
		const err = await eng
			.exportPlan({ pages: [ref(src, 0, 0, [redact(frac(meta.box.rect))])], options: defaultOptions }, [src], [])
			.then(() => null, (e: unknown) => e);
		expect(err).toBeInstanceOf(EngineError);
		expect((err as EngineError).code).toBe('unsupported');
		expect((err as EngineError).message).toMatch(/nothing was saved/i);
		expect(isRetired(real)).toBe(true);

		const fresh = await mupdf();
		expect(fresh).not.toBe(real);
		expect(fresh.PDFDocument).not.toBe(real.PDFDocument);
		const res = await redactSurvey();
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(await mupdf()).toBe(fresh);
	}, T);

	it('discardMupdf on an idle loader is harmless', async () => {
		discardMupdf();
		const m = await mupdf();
		const doc = new m.PDFDocument(corpus('multi.pdf'));
		expect(doc.countPages()).toBe(6);
		doc.destroy();
	}, T);
});

describe('MuPDF: one long-lived process', () => {
	it('many redactions and exports in a row, then a good file still opens and redacts', async () => {
		const start = await mupdf();
		const eng = engine();
		const sources: Source[] = await Promise.all(['redact-basic.pdf', 'redact-hard.pdf', 'redact-survey.pdf', 'shrink-photos.pdf'].map((n) => openCorpus(n)));
		const [basic, hard, survey, photos] = sources;
		const basicBoxes = Object.values((manifest['redact-basic.pdf'] as unknown as { boxes: Record<string, { rect: UserRect }> }).boxes).map((b) =>
			redact(frac(b.rect))
		);
		const hardMeta = manifest['redact-hard.pdf'] as unknown as { box: UserRect; cases: string[] };
		// Every hard case except the soft mask with text, which is refused on purpose.
		const hardPages = hardMeta.cases.flatMap((name, i) => (name === 'soft-mask' ? [] : [i]));
		const runs: (() => Promise<unknown>)[] = [
			() => eng.exportPlan({ pages: [ref(basic, 0, 0, basicBoxes)], options: defaultOptions }, [basic], []),
			() => eng.exportPlan({ pages: hardPages.map((i) => ref(hard, i, 0, [redact(frac(hardMeta.box))])), options: defaultOptions }, [hard], []),
			() => redactSurvey(eng),
			() =>
				eng.exportPlan(
					{ pages: photos.pages.map((_, i) => ref(photos, i)), options: { ...defaultOptions, targetBytes: Math.round(photos.bytes.length / 2) } },
					[photos],
					[]
				)
		];
		for (let round = 0; round < 6; round++) {
			for (const run of runs) await run();
			if (round % 2 === 1) gc();
		}
		const multi = await eng.openPdf(corpus('multi.pdf'), 'multi.pdf');
		const pages: PageRef[] = multi.pages.map((_, i) => ref(multi, i, 0, i === 0 ? [redact({ x: 0.1, y: 0.1, w: 0.5, h: 0.1 })] : []));
		const res = await eng.exportPlan({ pages, options: defaultOptions }, [multi], []);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(res.pageCount).toBe(multi.pages.length);
		// No trap happened along the way.
		expect(await mupdf()).toBe(start);
	}, 600_000);
});
