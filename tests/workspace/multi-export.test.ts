import { describe, expect, it } from 'vitest';
import type { ExportPlan, ExportProgress, ExportResult, PageRef, VerifyCheck } from '../../src/lib/core/types';
import { exportPictures, exportSplit, mergeChecks, mergeWarnings, partIds, splitNotes } from '../../src/lib/workspace/multi-export';
import type { PagePicture } from '../../src/lib/render/pictures';

const ok = (name: VerifyCheck['name'], detail = 'fine'): VerifyCheck => ({ name, ok: true, detail });

function result(pages: number, extra: Partial<ExportResult> = {}): ExportResult {
	return {
		bytes: new TextEncoder().encode(`%PDF pages=${pages}`),
		pageCount: pages,
		checks: [ok('structure'), ok('page-count'), ok('reopen')],
		warnings: [],
		elapsedMs: 1,
		...extra
	};
}

const page = (id: string): PageRef => ({ id, sourceId: 's', pageIndex: 0, rotation: 0, stamps: [] });

/** Names in a zip, from its central directory. */
async function zipNames(blob: Blob): Promise<string[]> {
	const b = new Uint8Array(await blob.arrayBuffer());
	const v = new DataView(b.buffer);
	const end = b.length - 22;
	let at = v.getUint32(end + 16, true);
	const out: string[] = [];
	for (let i = 0; i < v.getUint16(end + 10, true); i++) {
		const n = v.getUint16(at + 28, true);
		out.push(new TextDecoder().decode(b.subarray(at + 46, at + 46 + n)));
		at += 46 + n;
	}
	return out;
}

describe('exportSplit', () => {
	const pages = ['p1', 'p2', 'p3', 'p4', 'p5'].map(page);
	const parts = [[0, 1], [2, 3], [4]];
	const plans: ExportPlan[] = partIds(pages, parts).map((ids) => ({
		pages: pages.filter((p) => ids.includes(p.id)),
		options: { filename: 'x.zip', compress: false, stripMetadata: false, password: 'pw' }
	}));

	it('exports every part in order, reports progress, and zips them', async () => {
		const seen: number[] = [];
		const progress: ExportProgress[] = [];
		const out = await exportSplit({
			exportPlan: async (plan) => {
				expect(plan.options.password).toBe('pw');
				seen.push(plan.pages.length);
				return result(plan.pages.length, { warnings: seen.length === 2 ? ['Something on file 2.'] : ['Everywhere.'] });
			},
			plans,
			parts,
			sources: [],
			assets: [],
			base: 'report',
			onProgress: (p) => progress.push(p)
		});
		expect(seen).toEqual([2, 2, 1]);
		expect(progress).toEqual([
			{ stage: 'part', done: 0, total: 3 },
			{ stage: 'part', done: 1, total: 3 },
			{ stage: 'part', done: 2, total: 3 },
			{ stage: 'part', done: 3, total: 3 }
		]);
		expect(out.filename).toBe('report.zip');
		expect(out.pageCount).toBe(5);
		expect(await zipNames(out.blob)).toEqual(['report-part-01.pdf', 'report-part-02.pdf', 'report-part-03.pdf']);
		expect(out.parts.map((p) => p.pages)).toEqual(['pages 1–2', 'pages 3–4', 'page 5']);
		expect(out.warnings).toEqual(['Files 1, 3: Everywhere.', 'File 2: Something on file 2.']);
	});

	it('a part that fails delivers nothing and names the part', async () => {
		let calls = 0;
		await expect(
			exportSplit({
				exportPlan: async (plan) => {
					calls++;
					if (calls === 2) throw { code: 'verification-failed', message: 'The file did not pass its checks. Nothing was saved.', checks: [{ name: 'structure', ok: false, detail: 'bad' }] };
					return result(plan.pages.length);
				},
				plans,
				parts,
				sources: [],
				assets: [],
				base: 'report'
			})
		).rejects.toMatchObject({
			code: 'verification-failed',
			message: 'File 2 of 3 (pages 3–4) could not be made: The file did not pass its checks. No files were saved.',
			checks: [{ name: 'structure', ok: false }]
		});
		expect(calls).toBe(2);
	});

	it('cancel stops before the next part', async () => {
		const ctl = new AbortController();
		let calls = 0;
		await expect(
			exportSplit({
				exportPlan: async (plan) => {
					calls++;
					ctl.abort();
					return result(plan.pages.length);
				},
				plans,
				parts,
				sources: [],
				assets: [],
				base: 'r',
				signal: ctl.signal
			})
		).rejects.toMatchObject({ code: 'cancelled' });
		expect(calls).toBe(1);
	});

	it('merges checks and notes', () => {
		const m = mergeChecks([{ checks: [ok('structure', 'a'), ok('reopen')] }, { checks: [{ name: 'structure', ok: false, detail: 'b' }, ok('reopen')] }]);
		expect(m).toEqual([
			{ name: 'structure', ok: false, detail: 'File 1: a File 2: b' },
			{ name: 'reopen', ok: true, detail: 'File 1: fine File 2: fine' }
		]);
		expect(mergeWarnings([{ warnings: ['x'] }, { warnings: ['x'] }])).toEqual(['x']);
		const shrink = { targetBytes: 10 * 1024 * 1024, reached: true, imagesChanged: 0, dpi: 0 };
		expect(
			splitNotes({
				parts: [
					{ name: 'a', pages: '', bytes: 1, result: result(1, { shrink }) },
					{ name: 'b', pages: '', bytes: 1, result: result(1, { shrink: { ...shrink, reached: false }, printCap: { images: 2, savedBytes: 1, ppi: 300 } }) }
				]
			})
		).toEqual(['File 2 is still over 10 MB: that is the smallest they can get without damaging text.', '2 oversized pictures brought down to 300 dpi.']);
	});

	it('says once why accessibility tags were not kept, naming the files when not all', () => {
		const part = (tags: ExportResult['tags']) => ({ name: 'a', pages: '', bytes: 1, result: result(1, tags ? { tags } : {}) });
		const why = 'Accessibility tags (used by screen readers) were not kept because a page is used more than once.';
		expect(splitNotes({ parts: [part({ kept: true }), part({ kept: false, reason: 'repeated' })] })).toEqual([`File 2: ${why}`]);
		expect(splitNotes({ parts: [part({ kept: false, reason: 'repeated' }), part({ kept: false, reason: 'repeated' })] })).toEqual([why]);
		// Parts without a tagged file do not count.
		expect(splitNotes({ parts: [part(undefined), part({ kept: false, reason: 'repeated' })] })).toEqual([why]);
		expect(splitNotes({ parts: [part({ kept: true }), part({ kept: true })] })).toEqual([]);
	});
});

describe('exportPictures', () => {
	function fakeRender(sizes: number[], reducedAt = -1) {
		return async function* (_bytes: Uint8Array, opts: { dpi: number }): AsyncGenerator<PagePicture> {
			for (let i = 0; i < sizes.length; i++) {
				yield { index: i, count: sizes.length, blob: new Blob([new Uint8Array(sizes[i]).fill(i)]), width: 10, height: 10, dpi: i === reducedAt ? opts.dpi - 10 : opts.dpi, reduced: i === reducedAt };
			}
		};
	}
	const plan: ExportPlan = { pages: [page('a')], options: { filename: 'x', compress: false, stripMetadata: false } };

	it('renders the verified export only, names pictures in page order, zips several', async () => {
		const exported: ExportPlan[] = [];
		const progress: ExportProgress[] = [];
		const out = await exportPictures({
			exportPlan: async (p) => {
				exported.push(p);
				return result(3);
			},
			plan,
			sources: [],
			assets: [],
			base: 'scan',
			kind: 'jpg',
			dpi: 150,
			budget: 1e9,
			render: fakeRender([10, 20, 30], 1) as never,
			onProgress: (p) => progress.push(p)
		});
		expect(exported).toEqual([plan]);
		expect(out.filename).toBe('scan.zip');
		expect(out.count).toBe(3);
		expect(out.reduced).toEqual([{ page: 2, dpi: 140 }]);
		expect(await zipNames(out.blob)).toEqual(['scan-001.jpg', 'scan-002.jpg', 'scan-003.jpg']);
		expect(progress.filter((p) => p.stage === 'picture').map((p) => ('done' in p ? p.done : -1))).toEqual([0, 1, 2, 3]);
	});

	it('one page: the picture itself', async () => {
		const out = await exportPictures({
			exportPlan: async () => result(1),
			plan,
			sources: [],
			assets: [],
			base: 'scan',
			kind: 'png',
			dpi: 300,
			budget: 1e9,
			render: fakeRender([42]) as never
		});
		expect(out.filename).toBe('scan.png');
		expect(out.blob.size).toBe(42);
	});

	it('stops with a plain message when the pictures outgrow the budget', async () => {
		await expect(
			exportPictures({
				exportPlan: async () => result(4),
				plan,
				sources: [],
				assets: [],
				base: 'scan',
				kind: 'png',
				dpi: 300,
				budget: 50,
				render: fakeRender([20, 20, 20, 20]) as never
			})
		).rejects.toMatchObject({ code: 'too-large', message: expect.stringMatching(/^Stopped after 3 of 4 pictures/) });
	});

	it('an export that fails its checks never reaches the renderer', async () => {
		let rendered = false;
		await expect(
			exportPictures({
				exportPlan: async () => {
					throw { code: 'verification-failed', message: 'Redaction could not be verified.' };
				},
				plan,
				sources: [],
				assets: [],
				base: 'scan',
				kind: 'png',
				dpi: 150,
				budget: 1e9,
				render: (async function* () {
					rendered = true;
				}) as never
			})
		).rejects.toMatchObject({ code: 'verification-failed' });
		expect(rendered).toBe(false);
	});
});
