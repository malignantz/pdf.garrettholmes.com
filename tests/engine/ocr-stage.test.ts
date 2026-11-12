/**
 * The export stage of "Make scanned pages searchable" (ocr/stage.ts wired into
 * Engine.exportPlan) with a stand-in OCR backend, so the rules can be tested quickly:
 * the page cap, progress, cancel, replacing failed workers, redaction pages, and pages
 * that are declined being left exactly as they were. tests/engine/ocr-export.test.ts
 * runs the real OCR engine.
 */
import { describe, expect, it } from 'vitest';
import * as PL from '@cantoo/pdf-lib';
import { createCoreEngine } from '../../src/lib/engine/core';
import { EngineError } from '../../src/lib/engine/errors';
import { mupdf } from '../../src/lib/engine/mupdf';
import { pageTextOf } from '../../src/lib/engine/page-text';
import { renderAndCompare } from '../../src/lib/engine/shrink';
import { OCR_CAP, REPLACE_AFTER, verifyTextLayer, type OcrBackend, type OcrReader } from '../../src/lib/engine/ocr/stage';
import type { OcrWord } from '../../src/lib/engine/ocr/gate';
import type { OcrRead, Orientation } from '../../src/lib/engine/ocr/tess';
import type { ExportProgress, PageRef, Source } from '../../src/lib/core/types';
import { corpus, loadPdfjs, manifest, nodeAssets } from './helpers';

const meta = manifest['ocr-scans.pdf'] as { words: { t: string; box: [number, number, number, number] }[] };
const K = 300 / 72;

/** What OCR would read on the letter (pixels at 300 dpi). */
function letterRead(width: number, height: number): OcrRead {
	const lines = new Map<number, OcrWord[]>();
	for (const w of meta.words) {
		const li = Math.round(((w.box[1] + w.box[3]) / 2 - 35) / 28);
		lines.set(li, [...(lines.get(li) ?? []), [w.t, w.box[0] * K, w.box[1] * K, w.box[2] * K, w.box[3] * K, 95]]);
	}
	return {
		width,
		height,
		rotate: 0,
		lines: [...lines.values()].map((words) => ({ baseline: [words[0][1], words[0][4], words[words.length - 1][3], words[words.length - 1][4]], words }))
	};
}

const pngSize = (png: Uint8Array) => {
	const v = new DataView(png.buffer, png.byteOffset);
	return { w: v.getUint32(16), h: v.getUint32(20) };
};

interface Fake {
	backend: () => Promise<OcrBackend>;
	readers: number;
	reads: number;
	alive: Set<object>;
}

/** Upright landscape pages read as the letter; portrait ones are "sideways". `fail(n)` makes the n-th read throw. */
function fake(opts: { slots?: number; fail?: (n: number) => boolean; junk?: boolean } = {}): Fake {
	const f: Fake = { readers: 0, reads: 0, alive: new Set(), backend: async () => backend };
	const backend: OcrBackend = {
		slots: opts.slots ?? 1,
		reader: async () => {
			f.readers++;
			const r: OcrReader = {
				read: async (png, w, h) => {
					const n = ++f.reads;
					await new Promise((res) => setTimeout(res, 5));
					if (opts.fail?.(n)) throw new Error('RuntimeError: memory access out of bounds');
					expect(pngSize(png)).toEqual({ w, h });
					return letterRead(w, h);
				},
				terminate: () => void f.alive.delete(r)
			};
			f.alive.add(r);
			return r;
		},
		orienter: async () => {
			const o = {
				detect: async (png: Uint8Array): Promise<Orientation> => {
					const { w, h } = pngSize(png);
					return { angle: h > w ? 90 : 0, script: 'Latin' };
				},
				terminate: () => void f.alive.delete(o)
			};
			f.alive.add(o);
			return o;
		}
	};
	return f;
}

let n = 0;
const ref = (s: Source, pageIndex: number, extra: Partial<PageRef> = {}): PageRef => ({ id: `r${n++}`, sourceId: s.id, pageIndex, rotation: 0, stamps: [], ...extra });
const opts = (ocr = true) => ({ filename: 'o.pdf', compress: false, stripMetadata: false, ocr });

async function setup(f: Fake) {
	const eng = createCoreEngine({ ...nodeAssets(), ocr: f.backend });
	const src = await eng.openPdf(corpus('ocr-scans.pdf'), 'ocr-scans.pdf');
	return { eng, src };
}

async function words(bytes: Uint8Array, p: number) {
	const m = await mupdf();
	const doc = m.Document.openDocument(bytes, 'application/pdf');
	try {
		return pageTextOf(doc, p).words.map((w) => w.text);
	} finally {
		doc.destroy();
	}
}

/** The page's own content (decoded, joined), to compare two exports. */
async function contentOf(bytes: Uint8Array, p: number): Promise<string> {
	const doc = await PL.PDFDocument.load(bytes);
	const c = doc.getPage(p).node.Contents();
	const list = c instanceof PL.PDFArray ? c.asArray() : c ? [c] : [];
	return list
		.map((r) => {
			const s = doc.context.lookup(r);
			return s instanceof PL.PDFRawStream ? new TextDecoder('latin1').decode(PL.decodePDFRawStream(s).decode()) : '';
		})
		.join('\n');
}

describe('OCR stage', () => {
	it('writes layers for the pages OCR accepts and leaves declined and other pages exactly as they were', async () => {
		const f = fake();
		const { eng, src } = await setup(f);
		const pages = src.pages.map((_, i) => ref(src, i));
		const progress: ExportProgress[] = [];
		const res = await eng.exportPlan({ pages, options: opts() }, [src], [], { onProgress: (p) => progress.push(p) });
		// p2 is portrait ("sideways" to the stand-in); p3 reads as the letter here, so it passes too.
		expect(res.ocr).toEqual({ eligible: 4, cap: OCR_CAP, searchable: [1, 3, 8], declined: [2] });
		expect(res.checks.find((c) => c.name === 'text-layer')).toMatchObject({ ok: true });
		expect(progress[0]).toEqual({ stage: 'ocr-load' });
		expect(progress.filter((p) => p.stage === 'ocr').map((p) => (p.stage === 'ocr' ? p.done : -1))).toEqual([0, 1, 2, 3, 4]);
		expect(f.alive.size).toBe(0);

		const plain = await eng.exportPlan({ pages, options: opts(false) }, [src], [], {});
		expect(plain.ocr).toBeUndefined();
		const m = await mupdf();
		const a = new m.PDFDocument(plain.bytes);
		const b = new m.PDFDocument(res.bytes);
		try {
			for (let p = 0; p < 8; p++) expect(renderAndCompare(m, a, b, p)).toMatchObject({ pageMean: 0, blockMean: 0 });
		} finally {
			a.destroy();
			b.destroy();
		}
		for (const p of [1, 3, 4, 5, 6]) {
			expect(await contentOf(res.bytes, p)).toBe(await contentOf(plain.bytes, p));
			expect(await words(res.bytes, p)).toEqual(await words(plain.bytes, p));
		}
		expect((await words(res.bytes, 0)).length).toBe(meta.words.length);
	});

	it('tries at most 20 pages, in document order', async () => {
		const f = fake();
		const { eng, src } = await setup(f);
		const pages = Array.from({ length: 25 }, () => ref(src, 0));
		const res = await eng.exportPlan({ pages, options: opts() }, [src], [], {});
		expect(res.ocr).toEqual({ eligible: 25, cap: 20, searchable: Array.from({ length: 20 }, (_, i) => i + 1), declined: [] });
		// The same source page is read once.
		expect(f.reads).toBe(1);
		expect(await words(res.bytes, 20)).toEqual([]);
	});

	it('does not read pages with redaction boxes, and reads nothing when no page qualifies', async () => {
		const f = fake();
		const { eng, src } = await setup(f);
		const res = await eng.exportPlan({ pages: [ref(src, 0, { stamps: [{ id: 'x', kind: 'redact', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } }] }), ref(src, 4)], options: opts() }, [src], [], {});
		expect(res.ocr).toEqual({ eligible: 0, cap: 20, searchable: [], declined: [] });
		expect(f.readers + f.reads).toBe(0);
	});

	it('replaces a worker that fails and tries the page once more, then declines it', async () => {
		const f = fake({ fail: (k) => k === 1 });
		const { eng, src } = await setup(f);
		const ok = await eng.exportPlan({ pages: [ref(src, 0)], options: opts() }, [src], [], {});
		expect(ok.ocr?.searchable).toEqual([1]);
		expect(f.readers).toBe(2);
		expect(f.alive.size).toBe(0);

		const g = fake({ fail: () => true });
		const s2 = await setup(g);
		const bad = await s2.eng.exportPlan({ pages: [ref(s2.src, 0), ref(s2.src, 4)], options: opts() }, [s2.src], [], {});
		expect(bad.ocr).toEqual({ eligible: 1, cap: 20, searchable: [], declined: [1] });
		expect(g.reads).toBe(2);
		expect(await words(bad.bytes, 0)).toEqual([]);
		expect(g.alive.size).toBe(0);
	});

	it('replaces each reader after 10 pages', async () => {
		const f = fake();
		const eng = createCoreEngine({ ...nodeAssets(), ocr: f.backend });
		const pages: PageRef[] = [];
		const sources: Source[] = [];
		for (let k = 0; k < 6; k++) {
			const s = await eng.openPdf(corpus('ocr-scans.pdf'), `copy-${k}.pdf`);
			sources.push(s);
			pages.push(ref(s, 0), ref(s, 2));
		}
		const res = await eng.exportPlan({ pages, options: opts() }, sources, [], {});
		expect(res.ocr?.searchable.length).toBe(12);
		expect(f.reads).toBe(12);
		expect(f.readers).toBe(Math.ceil(12 / REPLACE_AFTER));
	});

	it('stops when cancelled: no file, every worker stopped', async () => {
		const f = fake({ slots: 2 });
		const { eng, src } = await setup(f);
		const abort = new AbortController();
		const pages = src.pages.map((_, i) => ref(src, i));
		const err = await eng
			.exportPlan({ pages, options: opts() }, [src], [], {
				signal: abort.signal,
				onProgress: (p) => {
					if (p.stage === 'ocr' && p.done === 1) abort.abort();
				}
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(EngineError);
		expect((err as EngineError).code).toBe('cancelled');
		expect(f.alive.size).toBe(0);
		// The engine still works afterwards.
		const again = await eng.exportPlan({ pages: [ref(src, 0)], options: opts() }, [src], [], {});
		expect(again.ocr?.searchable).toEqual([1]);
	});

	it('combines with fitting under a size (the layer is text; shrinking changes pictures only) and with a password', { timeout: 120_000 }, async () => {
		const f = fake();
		const { eng, src } = await setup(f);
		const pages = [ref(src, 0), ref(src, 7), ref(src, 6)];
		const fit = await eng.exportPlan({ pages, options: { ...opts(), targetBytes: 60_000 } }, [src], [], {});
		expect(fit.ocr?.searchable).toEqual([1, 2]);
		expect(fit.shrink?.imagesChanged).toBeGreaterThan(0);
		expect(fit.checks.every((c) => c.ok)).toBe(true);
		expect(fit.checks.find((c) => c.name === 'text-layer')?.ok).toBe(true);
		expect((await words(fit.bytes, 0)).length).toBe(meta.words.length);
		const locked = await eng.exportPlan({ pages, options: { ...opts(), password: 'open sesame 1' } }, [src], [], {});
		expect(locked.ocr?.searchable).toEqual([1, 2]);
		expect(locked.checks.find((c) => c.name === 'text-layer')?.ok).toBe(true);
		expect(locked.checks.find((c) => c.name === 'encryption')?.ok).toBe(true);
	});

	it('refuses when no OCR engine is available', async () => {
		const eng = createCoreEngine(nodeAssets());
		const src = await eng.openPdf(corpus('ocr-scans.pdf'), 'ocr-scans.pdf');
		await expect(eng.exportPlan({ pages: [ref(src, 0)], options: opts() }, [src], [], {})).rejects.toMatchObject({ code: 'unsupported' });
		expect(await eng.scannedPages(src)).toEqual([0, 1, 2, 7]);
		expect(await eng.scannedPages({ ...src, kind: 'image' })).toEqual([]);
	});

	it('the final check fails when written words are not in the file', async () => {
		const lib = await loadPdfjs();
		const bytes = corpus('ocr-scans.pdf');
		const check = await verifyTextLayer(lib, bytes, new Map([[6, [{ text: 'thank', line: 0, quad: [] }]]]), undefined);
		expect(check).toMatchObject({ name: 'text-layer', ok: true });
		const bad = await verifyTextLayer(lib, bytes, new Map([[0, [{ text: 'thank', line: 0, quad: [] }]]]), undefined);
		expect(bad).toMatchObject({ name: 'text-layer', ok: false });
	});
});
