/**
 * Flat-form blank detector (forms-detect.ts), a measured prototype not wired into the
 * app. Corpus: tests/corpus/generate-forms-detect.mjs (positions are top-down points).
 * Real-world numbers: tools/forms-detect/ and the plan's "Stretch" section.
 */
import { describe, expect, it } from 'vitest';
import type * as MU from 'mupdf';
import { collectInk, detectBlanks, joinSegs, underscoreRuns, words, type BlankSuggestion, type InkGlyph, type Rect } from '../../src/lib/engine/forms-detect';
import { corpus } from './helpers';

const T = 60_000;

async function detect(name: string, pageIndex: number) {
	const m = (await import('mupdf')) as unknown as typeof MU;
	const doc = m.Document.openDocument(corpus(name), 'application/pdf');
	const page = doc.loadPage(pageIndex);
	const t0 = performance.now();
	const ink = collectInk(m as never, page);
	const out = detectBlanks(ink);
	return { out, ink, ms: performance.now() - t0 };
}

const centre = (r: Rect) => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
const near = (s: BlankSuggestion, r: Rect, tol: number) => {
	const [ax, ay] = centre(s.rect);
	const [bx, by] = centre(r);
	return Math.abs(ax - bx) <= tol && Math.abs(ay - by) <= tol && Math.abs(s.rect[2] - s.rect[0] - (r[2] - r[0])) <= 2 * tol;
};

describe('detectBlanks on a generated flat form', () => {
	it('finds each kind of blank with its label', async () => {
		const { out } = await detect('forms-detect-flat.pdf', 0);
		const expected: { kind: BlankSuggestion['kind']; source: string; rect: Rect; label: RegExp }[] = [
			{ kind: 'text', source: 'underscore', rect: [104, 86, 271, 101], label: /^Name$/ },
			{ kind: 'text', source: 'rule', rect: [130, 124, 400, 142], label: /^Address$/ },
			{ kind: 'text', source: 'cell-band', rect: [73, 181, 299, 202], label: /Employer name/ },
			{ kind: 'text', source: 'cell', rect: [73, 237, 199, 254], label: /.*/ },
			{ kind: 'text', source: 'cell', rect: [301, 255, 399, 272], label: /.*/ },
			{ kind: 'checkbox', source: 'square', rect: [130, 299, 139, 308], label: /^Yes$/ },
			{ kind: 'checkbox', source: 'square', rect: [180, 299, 189, 308], label: /^No$/ },
			{ kind: 'checkbox', source: 'glyph', rect: [72, 331, 79, 338], label: /^Married$/ },
			{ kind: 'checkbox', source: 'square', rect: [160, 330, 169, 339], label: /^Single$/ },
			{ kind: 'text', source: 'comb', rect: [130, 369, 198, 381], label: /ZIP code/ },
			{ kind: 'text', source: 'rule', rect: [72, 432, 300, 450], label: /Signature of applicant/ }
		];
		for (const e of expected) {
			const hit = out.find((s) => s.kind === e.kind && s.source === e.source && near(s, e.rect, 3));
			expect(hit, `${e.source} at ${e.rect}`).toBeDefined();
			expect(hit!.label).toMatch(e.label);
			expect(hit!.confidence).toBeGreaterThanOrEqual(0.5);
		}
		// Six empty table cells, no row of checkboxes inside the comb.
		expect(out.filter((s) => s.source === 'cell')).toHaveLength(6);
		expect(out.filter((s) => s.kind === 'checkbox' && s.rect[1] > 360 && s.rect[3] < 390)).toEqual([]);
	}, T);

	it('gives the heading rule, the footer rule and header cells low confidence at most', async () => {
		const { out } = await detect('forms-detect-flat.pdf', 0);
		const confident = out.filter((s) => s.confidence >= 0.6);
		expect(confident.filter((s) => s.rect[3] > 480 && s.rect[1] < 530)).toEqual([]); // "Part 2. Details" rule
		expect(out.filter((s) => s.rect[3] > 740)).toEqual([]); // footer
		expect(confident.filter((s) => s.rect[1] > 218 && s.rect[3] < 237)).toEqual([]); // header row
	}, T);

	it('stays quiet (nothing confident) on an ordinary page', async () => {
		const { out } = await detect('forms-detect-flat.pdf', 1);
		expect(out.filter((s) => s.confidence >= 0.6)).toEqual([]);
	}, T);

	it('is deterministic and fast', async () => {
		const a = await detect('forms-detect-flat.pdf', 0);
		const b = await detect('forms-detect-flat.pdf', 0);
		expect(b.out).toEqual(a.out);
		expect(a.ms).toBeLessThan(1000);
	}, T);

	it('ignores widget appearances (page contents only)', async () => {
		// forms-kinds.pdf has fields whose widgets draw boxes; the page itself has none.
		const { out, ink } = await detect('forms-kinds.pdf', 0);
		expect(ink.glyphs.length).toBeGreaterThan(0);
		expect(out.filter((s) => s.kind === 'checkbox')).toEqual([]);
	}, T);
});

describe('pure helpers', () => {
	const g = (ch: string, x: number, base = 100, size = 10): InkGlyph => ({ ch, font: 'Helvetica', size, r: [x, base - 8, x + 5, base + 2], base, light: 0, upright: true });

	it('joins underscores into runs and words around them', () => {
		const gl = [...'Name'].map((c, i) => g(c, 10 + i * 5)).concat([...'_____'].map((c, i) => g(c, 32 + i * 5)));
		expect(underscoreRuns(gl)).toEqual([{ x0: 32, x1: 57, base: 100, size: 10 }]);
		expect(words(gl).map((w) => w.text)).toEqual(['Name']);
	});

	it('joins collinear line pieces and keeps separate rows apart', () => {
		const r = joinSegs([
			{ at: 10, a: 0, b: 10, w: 1 },
			{ at: 10.2, a: 11, b: 20, w: 1 },
			{ at: 30, a: 0, b: 20, w: 1 }
		]);
		expect(r.map((x) => [Math.round(x.at), x.a, x.b, x.pieces])).toEqual([
			[10, 0, 20, 2],
			[30, 0, 20, 1]
		]);
	});
});
