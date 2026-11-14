import { describe, expect, it } from 'vitest';
import type { PageRef, Source } from '../../src/lib/core/types';
import { cleanExportForm } from '../../src/lib/session/format';
import {
	BILEVEL_HINT,
	BILEVEL_LABEL,
	bilevelCandidates,
	bilevelProgressText,
	bilevelSummary
} from '../../src/lib/workspace/bilevel-option';
import { progressText } from '../../src/lib/workspace/export-progress';
import { DEFAULT_FORM, buildExportOptions, moreOptionsOn, plainCheck } from '../../src/lib/workspace/logic';

describe('Make scanned pages black and white: dialog words', () => {
	it('says what it does, upfront about the look', () => {
		expect(BILEVEL_LABEL).toBe('Make scanned pages black and white');
		expect(BILEVEL_HINT).toBe(
			'Much smaller files for printed pages. They will look like a photocopy: sharp black and white, no grey. Pages with colour, photos or faint marks are left as they are.'
		);
	});

	it('shows progress', () => {
		expect(bilevelProgressText(null)).toBeNull();
		expect(bilevelProgressText({ stage: 'bilevel', done: 2, total: 12 })).toBe('Making page 3 of 12 black and white');
		expect(bilevelProgressText({ stage: 'bilevel', done: 0, total: 1 })).toBe('Making the scanned page black and white');
		expect(bilevelProgressText({ stage: 'bilevel', done: 12, total: 12 })).toBeNull();
		expect(progressText({ stage: 'bilevel', done: 0, total: 4 })).toBe('Making page 1 of 4 black and white');
	});

	it('says what happened after export in plain words; none converted is not an error', () => {
		const r = (made: number, left: number) => ({
			eligible: made + left,
			converted: Array.from({ length: made }, (_, i) => i + 1),
			left: Array.from({ length: left }, (_, i) => i + 40)
		});
		expect(bilevelSummary(undefined)).toEqual([]);
		expect(bilevelSummary(r(0, 0))).toEqual([]);
		expect(bilevelSummary(r(3, 2))).toEqual(['3 pages made black and white.', '2 pages were left as they were because they have colour, photos or faint marks.']);
		expect(bilevelSummary(r(1, 1))).toEqual(['1 page made black and white.', '1 page was left as it was because it has colour, photos or faint marks.']);
		expect(bilevelSummary(r(4, 0))).toEqual(['4 pages made black and white.']);
		expect(bilevelSummary(r(0, 1))).toEqual(['No page was made black and white: the scanned page has colour, photos or faint marks, so it was left as it was.']);
		expect(bilevelSummary(r(0, 3))).toEqual(['No pages were made black and white: the scanned pages have colour, photos or faint marks, so they were left as they were.']);
	});

	it('names its check plainly', () => {
		expect(plainCheck({ name: 'bilevel', ok: true, detail: '' }, 3)).toBe('Black and white pages: passed.');
		expect(plainCheck({ name: 'bilevel', ok: false, detail: '' }, 3)).toBe('Some black and white pages did not read back exactly.');
	});

	it('lists the candidate pages of the plan in order, without redaction pages, asking each source once', async () => {
		let asks = 0;
		const engine = {
			bilevelPages: async (s: Source) => {
				asks++;
				return s.id === 'a' ? [0, 2] : [];
			}
		};
		const src = (id: string, kind: Source['kind'] = 'pdf') => ({ id, kind }) as Source;
		const page = (sourceId: string, pageIndex: number, redact = false) =>
			({ id: `${sourceId}${pageIndex}${redact}`, sourceId, pageIndex, rotation: 0, stamps: redact ? [{ id: 'r', kind: 'redact', box: { x: 0, y: 0, w: 0.1, h: 0.1 } }] : [] }) as PageRef;
		const pages = [page('a', 2), page('a', 1), page('a', 0, true), page('a', 0), page('b', 0), page('c', 0)];
		const sources = [src('a'), src('b'), src('c', 'image')];
		expect((await bilevelCandidates(engine, pages, sources)).map((p) => p.id)).toEqual(['a2false', 'a0false']);
		await bilevelCandidates(engine, pages, sources);
		expect(asks).toBe(2);
	});

	it('is off by default, asked for only when a page could qualify, and named when on', () => {
		expect(DEFAULT_FORM.bilevel).toBe(false);
		const f = { ...DEFAULT_FORM, filename: 'x.pdf', bilevel: true };
		const ctx = { pageCount: 3, redactions: 0, hasForm: false };
		const on = buildExportOptions(f, { ...ctx, bilevel: 2 });
		expect(on.ok && on.options.bilevel).toBe(true);
		const none = buildExportOptions(f, { ...ctx, bilevel: 0 });
		expect(none.ok && none.options.bilevel).toBeFalsy();
		const off = buildExportOptions({ ...f, bilevel: false }, { ...ctx, bilevel: 2 });
		expect(off.ok && off.options.bilevel).toBeFalsy();
		const shown = { pictures: false, canSplit: true, redacting: false, scanned: 0 };
		expect(moreOptionsOn(f, { ...shown, bilevel: 2 })).toEqual(['Black and white']);
		expect(moreOptionsOn(f, { ...shown, bilevel: 0 })).toEqual([]);
		expect(moreOptionsOn(f, { ...shown, pictures: true, bilevel: 2 })).toEqual([]);
	});

	it('is never saved with the work, nor restored on', () => {
		expect(cleanExportForm({ ...DEFAULT_FORM, bilevel: true }).bilevel).toBe(false);
		expect(cleanExportForm({ ...DEFAULT_FORM, watermark: true }).watermark).toBe(true);
	});
});
