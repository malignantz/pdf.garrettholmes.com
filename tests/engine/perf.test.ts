import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import type { PageRef, Source } from '../../src/lib/core/types';
import { corpus, defaultOptions, engine, ref } from './helpers';

/** 20 files × 10 pages: text, vector art and a shared PNG on every page. */
async function buildSources(): Promise<Source[]> {
	const out: Source[] = [];
	const png = corpus('alpha.png');
	for (let f = 0; f < 20; f++) {
		const doc = await PDFDocument.create({ updateMetadata: false });
		const font = await doc.embedFont(StandardFonts.Helvetica);
		const img = await doc.embedPng(png);
		for (let p = 0; p < 10; p++) {
			const page = doc.addPage([612, 792]);
			page.drawText(`perf f${f} p${p + 1}`, { x: 40, y: 750, size: 14, font });
			for (let l = 0; l < 40; l++) {
				page.drawText(`Line ${l}: the quick brown fox jumps over the lazy dog ${f}-${p}-${l}`, { x: 40, y: 720 - l * 16, size: 9, font });
			}
			for (let r = 0; r < 30; r++) page.drawRectangle({ x: 20 + r * 18, y: 40, width: 12, height: 12 + r, color: rgb(r / 30, 0.2, 0.5) });
			page.drawImage(img, { x: 400, y: 60, width: 160, height: 80 });
		}
		const bytes = await doc.save();
		out.push(await engine().openPdf(bytes, `perf-${f}.pdf`));
	}
	return out;
}

describe('performance', () => {
	it('merges 200 pages', async () => {
		const sources = await buildSources();
		const pages: PageRef[] = [];
		for (let p = 0; p < 10; p++) for (const s of sources) pages.push(ref(s, p, (p % 4) * 90 as 0));
		const inputBytes = sources.reduce((n, s) => n + s.bytes.length, 0);

		const t0 = performance.now();
		const plain = await engine().exportPlan({ pages, options: defaultOptions }, sources, []);
		const t1 = performance.now();
		const stamped = pages.map((p, i) =>
			i % 20 === 0
				? { ...p, stamps: [{ id: 's', kind: 'text' as const, text: 'Approved', x: 0.1, y: 0.1, size: 0.03, color: 'red' as const }] }
				: p
		);
		const full = await engine().exportPlan(
			{ pages: stamped, options: { filename: 'x.pdf', compress: true, stripMetadata: true, password: 'pw' } },
			sources,
			[]
		);
		const t2 = performance.now();

		expect(plain.pageCount).toBe(200);
		expect(full.pageCount).toBe(200);
		console.log(
			`[perf] 200-page merge from ${(inputBytes / 1e6).toFixed(2)} MB: plain ${(t1 - t0).toFixed(0)} ms → ${(plain.bytes.length / 1e6).toFixed(2)} MB; ` +
				`stamps(10)+compress+strip+AES-256 ${(t2 - t1).toFixed(0)} ms → ${(full.bytes.length / 1e6).toFixed(2)} MB`
		);
		expect(t1 - t0).toBeLessThan(60_000);
	}, 300_000);
});
