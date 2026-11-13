import { describe, expect, it } from 'vitest';
import type { PageNumbering } from '../../src/lib/core/types';
import { numberingLabels } from '../../src/lib/engine/numbering';
import {
	openedFileCount,
	parseEvery,
	parseStarts,
	partName,
	partNumbering,
	partPages,
	planSplit,
	splitSummary
} from '../../src/lib/workspace/split-plan';

const sources = [
	{ id: 'a', kind: 'pdf' as const },
	{ id: 'b', kind: 'pdf' as const },
	{ id: 'img', kind: 'image' as const },
	{ id: 'blank1', kind: 'blank' as const },
	{ id: 'blank2', kind: 'blank' as const }
];
const pagesOf = (ids: string[]) => ids.map((sourceId) => ({ sourceId }));
const five = pagesOf(['a', 'a', 'a', 'a', 'a']);

function parts(r: ReturnType<typeof planSplit>) {
	if (!r.ok) throw new Error(r.problem);
	return r.parts;
}

describe('planSplit', () => {
	it('every page on its own', () => {
		expect(parts(planSplit(five, sources, 'each', '', ''))).toEqual([[0], [1], [2], [3], [4]]);
	});

	it('every N pages: the last part may be shorter', () => {
		expect(parts(planSplit(five, sources, 'every', '2', ''))).toEqual([[0, 1], [2, 3], [4]]);
		expect(parts(planSplit(five, sources, 'every', ' 4 ', ''))).toEqual([[0, 1, 2, 3], [4]]);
	});

	it('every N pages: explains what makes no sense', () => {
		expect(planSplit(five, sources, 'every', '5', '')).toEqual({ ok: false, problem: 'That makes one file. Choose fewer than 5 pages.' });
		expect(planSplit(five, sources, 'every', '0', '').ok).toBe(false);
		expect(planSplit(five, sources, 'every', '2.5', '').ok).toBe(false);
		expect(planSplit(five, sources, 'every', '', '').ok).toBe(false);
	});

	it('at these pages', () => {
		const twenty = pagesOf(Array(20).fill('a'));
		const p = parts(planSplit(twenty, sources, 'at', '', '12, 5'));
		expect(p.map((x) => [x[0] + 1, x[x.length - 1] + 1])).toEqual([
			[1, 4],
			[5, 11],
			[12, 20]
		]);
		expect(parts(planSplit(five, sources, 'at', '', '1 3;3'))).toEqual([[0, 1], [2, 3, 4]]);
		expect(planSplit(five, sources, 'at', '', '9')).toEqual({ ok: false, problem: 'There is no page 9. Use pages 2 to 5.' });
		expect(planSplit(five, sources, 'at', '', 'x')).toMatchObject({ ok: false });
		expect(planSplit(five, sources, 'at', '', '1')).toMatchObject({ ok: false });
		expect(planSplit(five, sources, 'at', '', '')).toMatchObject({ ok: false });
	});

	it('one file per original file: grouped by first appearance, blanks go with the page before', () => {
		const pages = pagesOf(['blank1', 'a', 'a', 'b', 'blank2', 'a', 'img', 'b']);
		// blank1 has nothing before it: it goes with the first opened file (a).
		expect(parts(planSplit(pages, sources, 'files', '', ''))).toEqual([[0, 1, 2, 5], [3, 4, 7], [6]]);
		expect(openedFileCount(pages, sources)).toBe(3);
		expect(planSplit(pagesOf(['a', 'blank1', 'a']), sources, 'files', '', '')).toMatchObject({ ok: false });
		expect(openedFileCount(pagesOf(['a', 'blank1', 'a']), sources)).toBe(1);
	});

	it('needs two pages', () => {
		expect(planSplit(pagesOf(['a']), sources, 'each', '', '')).toMatchObject({ ok: false });
	});

	it('caps the number of files', () => {
		const many = pagesOf(Array(1001).fill('a'));
		expect(planSplit(many, sources, 'each', '', '')).toMatchObject({ ok: false });
		expect(parts(planSplit(many, sources, 'every', '2', '')).length).toBe(501);
	});
});

describe('parsers', () => {
	it('parseEvery / parseStarts', () => {
		expect(parseEvery('3', 10)).toEqual({ n: 3 });
		expect(parseStarts('5, 12', 20)).toEqual({ starts: [5, 12] });
	});
});

describe('partNumbering: numbers continue across files', () => {
	const base: PageNumbering = { style: 'page-n-of-total', position: 'bottom-center', start: 1, skip: 0, size: 10 };

	function labels(numbering: PageNumbering, partsList: number[][]): (string | null)[] {
		const per = partNumbering(numbering, partsList);
		return partsList.flatMap((p, i) => (per[i] ? numberingLabels(per[i]!, p.length) : p.map(() => null)));
	}

	it('gives exactly the labels of the unsplit export', () => {
		const cases: [PageNumbering, number[][]][] = [
			[base, [[0, 1], [2, 3], [4]]],
			[{ ...base, start: 7 }, [[0], [1, 2, 3], [4]]],
			[{ ...base, skip: 1 }, [[0, 1], [2, 3], [4]]],
			[{ ...base, skip: 3 }, [[0], [1], [2], [3], [4]]],
			[{ ...base, style: 'bates', bates: { prefix: 'ACME-', digits: 6 }, start: 100, skip: 2 }, [[0, 1, 2], [3, 4]]],
			[{ ...base, style: 'n-of-total' }, [[0, 1, 2], [3, 4]]]
		];
		for (const [n, p] of cases) expect(labels(n, p)).toEqual(numberingLabels(n, 5));
	});

	it('leaves a file of cover pages unnumbered, and prints the whole total', () => {
		const per = partNumbering({ ...base, skip: 2 }, [[0], [1], [2, 3, 4]]);
		expect(per[0]).toBeUndefined();
		expect(per[1]).toBeUndefined();
		expect(per[2]).toMatchObject({ skip: 0, start: 1, total: 3 });
		expect(partNumbering(base, [[0, 1], [2]])[1]).toMatchObject({ start: 3, total: 3 });
	});
});

describe('names and words', () => {
	it('part names are zero-padded', () => {
		expect(partName('report', 0, 3)).toBe('report-part-01.pdf');
		expect(partName('report', 11, 12)).toBe('report-part-12.pdf');
		expect(partName('report', 4, 150)).toBe('report-part-005.pdf');
	});

	it('pages and summaries', () => {
		expect(partPages([4])).toBe('page 5');
		expect(partPages([2, 3])).toBe('pages 3–4');
		expect(partPages([0, 2, 5])).toBe('3 pages');
		expect(splitSummary([[0], [1], [2]])).toBe('Makes 3 files, one page each, in one zip.');
		expect(splitSummary([[0, 1], [2, 3], [4]])).toBe('Makes 3 files in one zip: pages 1–2, pages 3–4, page 5.');
		expect(splitSummary([[0, 1], [2]], ['a.pdf', 'b.pdf'])).toBe('Makes 2 files in one zip: a.pdf (2 pages), b.pdf (1 page).');
		const long = Array.from({ length: 10 }, (_, i) => [2 * i, 2 * i + 1]);
		expect(splitSummary(long)).toBe('Makes 10 files in one zip: pages 1–2, pages 3–4, pages 5–6, …, pages 17–18, pages 19–20.');
	});
});
