/**
 * ExportProgress stages added for the remaining-time estimate (2026-11-13): the final
 * check reports how much of the file qpdf has read, fit under a size reports its
 * pictures and pages, compress its stream pass; reports are throttled.
 */
import { describe, expect, it } from 'vitest';
import type { ExportOptions, ExportProgress } from '../../src/lib/core/types';
import { throttleProgress } from '../../src/lib/engine/core';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { corpus, defaultOptions, engine, nodeAssets, openCorpus, ref } from './helpers';

async function exportWith(name: string, options: Partial<ExportOptions>) {
	const src = await openCorpus(name);
	const pages = src.pages.map((_, i) => ref(src, i));
	const progress: ExportProgress[] = [];
	const res = await engine().exportPlan({ pages, options: { ...defaultOptions, ...options } }, [src], [], { onProgress: (p) => progress.push(p) });
	return { res, progress, stages: [...new Set(progress.map((p) => p.stage))] };
}

describe('qpdf read progress', () => {
	it('counts the blocks of the watched input that qpdf read, never past its size', async () => {
		const qpdf = new Qpdf(nodeAssets().qpdf);
		const bytes = corpus('shrink-photos.pdf');
		const seen: [number, number][] = [];
		const res = await qpdf.run({ args: ['--check', '/v.pdf'], inputs: { '/v.pdf': bytes }, readProgress: { path: '/v.pdf', everyMs: 0, report: (d, t) => seen.push([d, t]) } });
		expect(res.code).toBe(0);
		expect(seen.length).toBeGreaterThan(3);
		for (const [i, [d, t]] of seen.entries()) {
			expect(t).toBe(bytes.length);
			expect(d).toBeLessThanOrEqual(t);
			if (i) expect(d).toBeGreaterThanOrEqual(seen[i - 1][0]);
		}
		// By the end qpdf has read (nearly) every block.
		expect(seen[seen.length - 1][0]).toBeGreaterThan(0.9 * bytes.length);
	});
});

describe('export progress stages', () => {
	it('a plain export reports its final check as the last slow part', async () => {
		const { res, progress } = await exportWith('shrink-photos.pdf', {});
		expect(res.checks.every((c) => c.ok)).toBe(true);
		const checks = progress.filter((p) => p.stage === 'check');
		expect(checks[0]).toEqual({ stage: 'check', done: 0, total: res.bytes.length, last: true });
	});

	it('the check is not the last slow part when page numbers are checked after it', async () => {
		const { progress } = await exportWith('multi.pdf', { numbering: { style: 'n', position: 'bottom-center', size: 10, start: 1, skip: 0 } });
		const checks = progress.filter((p) => p.stage === 'check');
		expect(checks.length).toBeGreaterThan(0);
		expect(checks.every((p) => p.stage === 'check' && !p.last)).toBe(true);
	});

	it('compress reports its stream pass; fit under a size its pictures and pages', async () => {
		const packed = await exportWith('shrink-photos.pdf', { compress: true });
		expect(packed.stages).toContain('pack');
		const fit = await exportWith('shrink-photos.pdf', { compress: true, targetBytes: 300 * 1024 });
		expect(fit.res.shrink?.imagesChanged).toBeGreaterThan(0);
		expect(fit.stages).toEqual(expect.arrayContaining(['pack', 'reduce', 'compare', 'check']));
		for (const p of fit.progress) if ('done' in p) expect(p.done).toBeLessThanOrEqual(p.total);
		// The pages compared: every page, counted from 0.
		const compare = fit.progress.filter((p) => p.stage === 'compare');
		expect(compare[0]).toMatchObject({ done: 0, total: 12 });
	}, 120_000);
});

describe('throttleProgress', () => {
	it('passes a new stage, its start and its end at once, the rest at most every 100 ms', () => {
		let t = 0;
		const out: ExportProgress[] = [];
		const on = throttleProgress((p) => out.push(p), 100, () => t);
		on({ stage: 'pack', done: 0, total: 10 });
		for (let i = 1; i < 10; i++) {
			t += 30;
			on({ stage: 'pack', done: i, total: 10 });
		}
		on({ stage: 'pack', done: 10, total: 10 });
		on({ stage: 'check', done: 5, total: 10, last: true });
		expect(out.map((p) => ('done' in p ? `${p.stage}${p.done}` : p.stage))).toEqual(['pack0', 'pack4', 'pack8', 'pack10', 'check5']);
	});
});
