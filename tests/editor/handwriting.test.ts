import { describe, expect, it } from 'vitest';
import { cropToInk, missingChars, textCanvasSize, PROBE_FALLBACKS, HAND_FONTS } from '../../src/lib/editor/handwriting';

/** Fake measurer: the font "has" the characters in `has`; others fall back with fallback-specific widths. */
function fakeMeasure(has: string) {
	const fb: Record<string, number> = { monospace: 60, serif: 47, 'sans-serif': 53 };
	return (ch: string, fallback: string) => (has.includes(ch) ? 40 + (ch.codePointAt(0)! % 7) : fb[fallback] + (ch.codePointAt(0)! % 3));
}

describe('missing-glyph check', () => {
	it('reports nothing when the font has every character', () => {
		expect(missingChars('Jane Doe', fakeMeasure('JaneDo'))).toBe('');
	});
	it('reports missing characters once, in order of first use', () => {
		expect(missingChars('Łukasz Żółw Ł', fakeMeasure('ukaszółw'))).toBe('ŁŻ');
	});
	it('ignores whitespace and flags control characters', () => {
		expect(missingChars(' a\tb\u0007', fakeMeasure('ab\u0007'))).toBe('\u0007');
	});
	it('normalizes to NFC first (e + combining accent is é)', () => {
		expect(missingChars('Renée', fakeMeasure('Reneé'))).toBe('');
	});
	it('probes with three different fallbacks', () => {
		expect(new Set(PROBE_FALLBACKS).size).toBe(3);
	});
	it('ships three distinct fonts, each with two subsets', () => {
		expect(new Set(HAND_FONTS.map((f) => f.family)).size).toBe(3);
		for (const f of HAND_FONTS) expect(f.files).toHaveLength(2);
	});
});

describe('typed signature crop', () => {
	it('leaves room for swashes around the text', () => {
		const s = textCanvasSize(500, 100);
		expect(s.x).toBeGreaterThanOrEqual(80);
		expect(s.width).toBe(500 + 2 * s.x);
		expect(s.baseline).toBeLessThan(s.height);
	});
	it('crops to the ink with padding', () => {
		const w = 20;
		const h = 10;
		const d = new Uint8ClampedArray(w * h * 4);
		for (const [x, y] of [
			[5, 3],
			[12, 6]
		])
			d[(y * w + x) * 4 + 3] = 200;
		const c = cropToInk(d, w, h, 1)!;
		expect(c.rect).toEqual({ x: 4, y: 2, width: 10, height: 6 });
		expect(c.data.length).toBe(10 * 6 * 4);
		expect(c.data[(1 * 10 + 1) * 4 + 3]).toBe(200);
	});
	it('returns null for an empty canvas', () => {
		expect(cropToInk(new Uint8ClampedArray(16), 2, 2)).toBeNull();
	});
});
