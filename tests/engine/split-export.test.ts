/**
 * Split export through the real engine: every part is an ordinary verified export with
 * the user's options (password on each part; page numbers continuing across parts).
 * The planning is the dialog's own (workspace/split-plan.ts, workspace/multi-export.ts).
 */
import { describe, expect, it } from 'vitest';
import type { ExportPlan, PageNumbering } from '../../src/lib/core/types';
import { exportSplit, partIds } from '../../src/lib/workspace/multi-export';
import { partNumbering, planSplit } from '../../src/lib/workspace/split-plan';
import { defaultOptions, engine, openCorpus, pageTexts, ref } from './helpers';

const T = 120_000;

describe('split export', () => {
	it(
		'every 2 pages of 6, with a password and Bates numbers continuing: 3 verified files',
		async () => {
			const src = await openCorpus('multi.pdf');
			const pages = src.pages.map((_, i) => ref(src, i));
			const split = planSplit(pages, [src], 'every', '4', '');
			if (!split.ok) throw new Error(split.problem);
			expect(split.parts.map((p) => p.length)).toEqual([4, 2]);
			const plain = planSplit(pages, [src], 'every', '2', '');
			if (!plain.ok) throw new Error(plain.problem);
			const numbering: PageNumbering = { style: 'bates', position: 'bottom-right', start: 1, skip: 0, size: 9, bates: { prefix: 'ACME-', digits: 4 } };
			const per = partNumbering(numbering, plain.parts);
			const plans: ExportPlan[] = partIds(pages, plain.parts).map((ids, i) => ({
				pages: pages.filter((p) => ids.includes(p.id)),
				options: { ...defaultOptions, password: 'open sesame', numbering: per[i] }
			}));
			const e = engine();
			const out = await exportSplit({ exportPlan: e.exportPlan.bind(e), plans, parts: plain.parts, sources: [src], assets: [], base: 'multi' });
			expect(out.parts.map((p) => p.result.pageCount)).toEqual([2, 2, 2]);
			const labels: string[] = [];
			for (const p of out.parts) {
				expect(p.result.checks.find((c) => c.name === 'encryption')?.ok).toBe(true);
				await expect(pageTexts(p.result.bytes)).rejects.toThrow();
				for (const t of await pageTexts(p.result.bytes, 'open sesame')) labels.push(t.match(/ACME-\d{4}/)?.[0] ?? '');
			}
			expect(labels).toEqual(['ACME-0001', 'ACME-0002', 'ACME-0003', 'ACME-0004', 'ACME-0005', 'ACME-0006']);
			expect(out.checks.every((c) => c.ok)).toBe(true);
		},
		T
	);

	it(
		'"Page n of total" in a part prints the whole export\'s total',
		async () => {
			const src = await openCorpus('multi.pdf');
			const pages = src.pages.map((_, i) => ref(src, i));
			const parts = [[0, 1, 2], [3, 4, 5]];
			const per = partNumbering({ style: 'page-n-of-total', position: 'bottom-center', start: 1, skip: 1, size: 10 }, parts);
			const res = await engine().exportPlan({ pages: pages.slice(3), options: { ...defaultOptions, numbering: per[1] } }, [src], []);
			expect(res.checks.find((c) => c.name === 'numbering')?.ok).toBe(true);
			const texts = await pageTexts(res.bytes);
			expect(texts.map((t) => t.match(/Page \d+ of \d+/)?.[0])).toEqual(['Page 3 of 5', 'Page 4 of 5', 'Page 5 of 5']);
		},
		T
	);
});
