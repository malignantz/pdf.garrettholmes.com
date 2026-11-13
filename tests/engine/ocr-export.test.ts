/**
 * "Make scanned pages searchable" end to end in Node with the real OCR engine
 * (tesseract.js workers, the app's own data and settings; tests/engine/ocr-node.ts).
 * Corpus: tests/corpus/generate-ocr.mjs.
 */
import { describe, expect, it } from 'vitest';
import { createCoreEngine } from '../../src/lib/engine/core';
import { mupdf } from '../../src/lib/engine/mupdf';
import { pageTextOf } from '../../src/lib/engine/page-text';
import { renderAndCompare } from '../../src/lib/engine/shrink';
import type { PageRef } from '../../src/lib/core/types';
import { corpus, manifest, nodeAssets, pageTexts } from './helpers';
import { nodeOcr } from './ocr-node';

const meta = manifest['ocr-scans.pdf'] as { words: { t: string; box: [number, number, number, number] }[] };

describe('OCR export (real OCR engine)', () => {
	it('makes the readable scans searchable and leaves every other page as it was', { timeout: 180_000 }, async () => {
		const eng = createCoreEngine({ ...nodeAssets(), ocr: nodeOcr({ slots: 2 }) });
		const src = await eng.openPdf(corpus('ocr-scans.pdf'), 'ocr-scans.pdf');
		const pages: PageRef[] = src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0, stamps: [] }));
		const options = { filename: 'o.pdf', compress: true, stripMetadata: false };
		const res = await eng.exportPlan({ pages, options: { ...options, ocr: true } }, [src], [], {});
		expect(res.ocr).toEqual({ eligible: 4, cap: 20, searchable: [1, 8], declined: [2, 3] });
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(res.checks.find((c) => c.name === 'text-layer')?.ok).toBe(true);

		const plain = await eng.exportPlan({ pages, options }, [src], [], {});
		const m = await mupdf();
		const a = new m.PDFDocument(plain.bytes);
		const b = new m.PDFDocument(res.bytes);
		try {
			for (let p = 0; p < 8; p++) expect(renderAndCompare(m, a, b, p), `page ${p + 1}`).toMatchObject({ pageMean: 0, blockMean: 0 });
			// The highlighter offers the letter's words where the picture shows them (p1 and p8 as displayed).
			for (const p of [0, 7]) {
				const pw = 432;
				const ph = 288;
				const hl = pageTextOf(b, p).words.map((w) => ({ t: w.text, x0: w.box.x * pw, y0: w.box.y * ph, x1: (w.box.x + w.box.w) * pw, y1: (w.box.y + w.box.h) * ph }));
				let placed = 0;
				for (const w of meta.words) {
					const cx = (w.box[0] + w.box[2]) / 2;
					const cy = (w.box[1] + w.box[3]) / 2;
					if (hl.some((h) => h.t === w.t && cx >= h.x0 && cx <= h.x1 && cy >= h.y0 && cy <= h.y1)) placed++;
				}
				expect(placed / meta.words.length, `page ${p + 1}`).toBeGreaterThanOrEqual(0.95);
			}
			// Declined and untried pages: no new text.
			for (const p of [1, 2, 3]) expect(pageTextOf(b, p).words).toEqual([]);
		} finally {
			a.destroy();
			b.destroy();
		}
		const [t1, , , , t5, t6, t7, t8] = await pageTexts(res.bytes);
		const [, , , , p5, p6, p7] = await pageTexts(plain.bytes);
		for (const w of ['Dear', 'house', 'offer.', 'builder.', 'Smith']) {
			expect(t1).toContain(w);
			expect(t8).toContain(w);
		}
		expect([t5, t6, t7]).toEqual([p5, p6, p7]);
	});
});
