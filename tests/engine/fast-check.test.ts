/**
 * The fast final check (final-check.ts) must reach the same verdict as a plain
 * `qpdf --check` on every file: good exports and exports damaged in many ways
 * (fault-inject.ts). The raw fast run (prelude + check in one instance, no fallback) is
 * compared with the full check output for output, and `finalCheck` for verdict.
 */
import { describe, expect, it } from 'vitest';
import type { ExportOptions, PageRef, Source, Stamp } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import { checkIsClean, FAST_CHECK_PRELUDE, finalCheck } from '../../src/lib/engine/final-check';
import { Qpdf, type QpdfResult } from '../../src/lib/engine/qpdf';
import { FAULTS } from './fault-inject';
import { defaultOptions, engine, nodeAssets, openCorpus, ref } from './helpers';

const T = 240_000;
const qpdf = new Qpdf(nodeAssets().qpdf);

async function exported(name: string, options: Partial<ExportOptions> = {}, stamps: Stamp[] = []): Promise<Uint8Array> {
	const src = await openCorpus(name);
	const pages: PageRef[] = src.pages.map((_, i) => ref(src, i, 0, i === 0 ? stamps : []));
	const res = await engine().exportPlan({ pages, options: { ...defaultOptions, ...options } }, [src], []);
	return res.bytes;
}

/** The same file with every stream uncompressed and no object streams (so content syntax can be damaged). */
async function uncompressed(bytes: Uint8Array): Promise<Uint8Array> {
	const r = await qpdf.run({ args: ['--stream-data=uncompress', '--object-streams=disable', '/a.pdf', '/b.pdf'], inputs: { '/a.pdf': bytes }, outputs: ['/b.pdf'] });
	return r.files.get('/b.pdf')!;
}

const full = (bytes: Uint8Array, password?: string) =>
	qpdf.run({ args: [...(password ? [`--password=${password}`] : []), '--check', '--show-npages', '/v.pdf'], inputs: { '/v.pdf': bytes } });
const fastRaw = (bytes: Uint8Array, password?: string) =>
	qpdf.run({ args: [...(password ? [`--password=${password}`] : []), '--check', '--show-npages', '/v.pdf'], inputs: { '/v.pdf': bytes }, prelude: FAST_CHECK_PRELUDE });

const text: Stamp = { id: 't1', kind: 'text', text: 'Checked', color: 'black', x: 0.1, y: 0.1, size: 0.02 };

describe('final check: fast vs full', () => {
	it('the prelude sets the Flate level for the next run in the same instance', async () => {
		const src = await exported('shrink-text.pdf');
		const args = ['--recompress-flate', '--compress-streams=y', '--object-streams=disable', '/a.pdf', '/b.pdf'];
		const normal = await qpdf.run({ args, inputs: { '/a.pdf': src }, outputs: ['/b.pdf'] });
		const stored = await qpdf.run({ args, inputs: { '/a.pdf': src }, outputs: ['/b.pdf'], prelude: FAST_CHECK_PRELUDE });
		expect(stored.prelude).toBe(0);
		expect(stored.code).toBe(0);
		// Level 0 stores: the same file comes out larger.
		expect(stored.files.get('/b.pdf')!.length).toBeGreaterThan(normal.files.get('/b.pdf')!.length * 1.2);
		// A fresh instance is back at the default level.
		const again = await qpdf.run({ args, inputs: { '/a.pdf': src }, outputs: ['/b.pdf'] });
		expect(again.files.get('/b.pdf')!.length).toBe(normal.files.get('/b.pdf')!.length);
	}, T);

	it('a prelude that fails stops the run and says so', async () => {
		const r = await qpdf.run({ args: ['--version'], prelude: ['--no-such-option'] });
		expect(r.code).toBe(-1);
		expect(r.prelude).not.toBe(0);
	});

	it('falls back to the full check when the prelude fails or the fast check is not clean', async () => {
		const calls: string[] = [];
		const good: QpdfResult = { code: 0, stdout: 'No syntax or stream encoding errors found\n3\n', stderr: '', files: new Map() };
		const fake = (fast: Partial<QpdfResult>) =>
			({
				run: async (o: { prelude?: string[] }) => {
					calls.push(o.prelude ? 'fast' : 'full');
					return o.prelude ? { ...good, ...fast } : good;
				}
			}) as unknown as Qpdf;
		const b = new Uint8Array(10);
		expect((await finalCheck(fake({ prelude: 0 }), b)).mode).toBe('fast');
		expect((await finalCheck(fake({ prelude: 2, code: -1 }), b)).mode).toBe('full-after-fast');
		expect((await finalCheck(fake({ prelude: 0, code: 3 }), b)).mode).toBe('full-after-fast');
		expect((await finalCheck(fake({ prelude: 0, stdout: 'odd' }), b)).mode).toBe('full-after-fast');
		expect((await finalCheck(fake({ prelude: 0 }), b, { full: true })).mode).toBe('full');
		expect(calls).toEqual(['fast', 'fast', 'full', 'fast', 'full', 'fast', 'full', 'full']);
	});

	it('rejects every damaged export the full check rejects, with the same output', async () => {
		const bases: { name: string; bytes: Uint8Array; password?: string }[] = [];
		const photos = await exported('shrink-photos.pdf');
		bases.push({ name: 'photos plain', bytes: photos });
		bases.push({ name: 'photos compressed', bytes: await exported('shrink-photos.pdf', { compress: true }) });
		bases.push({ name: 'photos password', bytes: await exported('shrink-photos.pdf', { password: 'pw' }), password: 'pw' });
		bases.push({ name: 'jpeg kinds compressed', bytes: await exported('jpeg-kinds.pdf', { compress: true }) });
		bases.push({ name: 'skips + stamp', bytes: await exported('shrink-skips.pdf', {}, [text]) });
		bases.push({ name: 'photos uncompressed', bytes: await uncompressed(photos) });

		let tried = 0;
		let rejectedFull = 0;
		let rejectedFast = 0;
		const differ: string[] = [];
		const kinds = new Set<string>();
		for (const base of bases) {
			// Good files: clean both ways.
			const ok = await finalCheck(qpdf, base.bytes, { password: base.password, npages: true });
			expect(ok.mode, base.name).toBe('fast');
			expect(checkIsClean(ok), base.name).toBe(true);
			for (const f of FAULTS) {
				const bad = f.apply(base.bytes);
				if (!bad) continue;
				tried++;
				const a = await full(bad, base.password);
				const b = await fastRaw(bad, base.password);
				// finalCheck itself on two of the bases (the rest: its verdict follows from b and a).
				const c = base.name === 'photos password' || base.name === 'photos uncompressed' ? await finalCheck(qpdf, bad, { password: base.password, npages: true }) : b.prelude === 0 && checkIsClean(b) ? b : a;
				const oldOk = checkIsClean(a);
				if (!oldOk) {
					rejectedFull++;
					kinds.add(f.name);
				}
				if (!checkIsClean(c)) rejectedFast++;
				if (b.prelude !== 0 || b.code !== a.code || b.stdout !== a.stdout || b.stderr !== a.stderr) differ.push(`${base.name} / ${f.name}: full ${a.code} ${a.stderr.slice(0, 120)} | fast ${b.code} ${b.stderr.slice(0, 120)}`);
				expect(checkIsClean(c), `${base.name} / ${f.name}`).toBe(oldOk);
			}
		}
		console.log(`fault injection: ${tried} damaged files, full check rejected ${rejectedFull}, fast check rejected ${rejectedFast}, ${kinds.size} of ${FAULTS.length} kinds caught`);
		expect(differ).toEqual([]);
		expect(rejectedFast).toBe(rejectedFull);
		// The damage really is damage: most faults are caught (some, such as a byte in a
		// JPEG's entropy data or a dangling reference qpdf reads as null, pass both checks).
		expect(tried).toBeGreaterThan(150);
		expect(rejectedFull).toBeGreaterThan(tried / 2);
		for (const k of ['corrupt JPEG: bad marker in the entropy data', 'truncated stream: image data shortened, /Length kept', 'corrupt Flate: content stream, zlib header', 'content syntax: stray ) in a content stream', 'encryption dict: /U damaged']) {
			expect([...kinds], k).toContain(k);
		}
	}, 600_000);

	it('the engine uses the fast check, and fullCheck forces the old one, with the same result', async () => {
		const notes: string[] = [];
		const fast = createCoreEngine(nodeAssets(), { debug: (n) => notes.push(n) });
		const old = createCoreEngine(nodeAssets(), { debug: (n) => notes.push(n), fullCheck: true });
		const run = async (e: typeof fast) => {
			const s: Source = await e.openPdf((await import('./helpers')).corpus('shrink-photos.pdf'), 'p.pdf');
			return e.exportPlan({ pages: s.pages.map((_, i) => ref(s, i)), options: { ...defaultOptions } }, [s], []);
		};
		const a = await run(fast);
		expect(notes.filter((n) => n.startsWith('final-check:'))).toEqual([expect.stringMatching(/^final-check: fast, fast \d+ ms$/)]);
		notes.length = 0;
		const b = await run(old);
		expect(notes.filter((n) => n.startsWith('final-check:'))).toEqual([expect.stringMatching(/^final-check: full, full \d+ ms$/)]);
		expect(a.checks.map((c) => [c.name, c.ok, c.detail])).toEqual(b.checks.map((c) => [c.name, c.ok, c.detail]));
		expect(a.bytes.length).toBe(b.bytes.length);
	}, T);

	it('damaged sources copied unchanged are still refused or accepted as before', async () => {
		// damage-content: a warning the original has (accepted, with a warning); damage-jpeg: refused.
		for (const [name, expectCode] of [['damage-content.pdf', null], ['damage-jpeg.pdf', 'unreadable']] as const) {
			const notes: string[] = [];
			const results: string[] = [];
			for (const fullCheck of [false, true]) {
				const e = createCoreEngine(nodeAssets(), { debug: (n) => notes.push(n), fullCheck });
				const s = await e.openPdf((await import('./helpers')).corpus(name), name);
				try {
					const r = await e.exportPlan({ pages: s.pages.map((_, i) => ref(s, i)), options: { ...defaultOptions } }, [s], []);
					results.push(`ok ${r.checks.map((c) => `${c.name}:${c.ok}:${c.detail}`).join('|')} ${r.warnings.join('|')}`);
				} catch (err) {
					results.push(`error ${(err as { code?: string }).code}`);
				}
			}
			expect(results[0], name).toBe(results[1]);
			if (expectCode) expect(results[0]).toBe(`error ${expectCode}`);
			else expect(results[0]).toMatch(/^ok /);
			if (name === 'damage-content.pdf') expect(notes.some((n) => n.startsWith('final-check: full-after-fast'))).toBe(true);
		}
	}, T);
});
