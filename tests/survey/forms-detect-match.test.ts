/** Blank-detector measurement: matching suggestions to true widgets (tools/forms-detect/match.ts). */
import { describe, expect, it } from 'vitest';
import { good, scorePage, type Sugg, type Truth } from '../../tools/forms-detect/match';

const text = (rect: Truth['rect'], cue = true): Truth => ({ type: 'text', rect, cue });
const s = (kind: Sugg['kind'], rect: Sugg['rect'], confidence = 0.9): Sugg => ({ kind, rect, confidence });

describe('scorePage', () => {
	it('accepts a line-height suggestion on a one-line field, rejects a misplaced one', () => {
		const t = text([100, 100, 300, 114]);
		expect(good(t, s('text', [102, 101, 298, 114]))).toBe(true);
		expect(good(t, s('text', [100, 100, 200, 114]))).toBe(false); // half the length
		expect(good(t, s('text', [100, 80, 300, 94]))).toBe(false); // a line too high
		expect(good(text([100, 100, 300, 160]), s('text', [100, 146, 300, 160]))).toBe(false); // one line of a tall box
	});

	it('scores one-to-one: a second suggestion on a widget is a duplicate', () => {
		const sc = scorePage([text([100, 100, 300, 114])], [s('text', [100, 100, 300, 114]), s('text', [110, 101, 290, 114]), s('text', [100, 300, 300, 314])]);
		expect(sc.truth[0]).toEqual({ s: 0, good: true });
		expect(sc.sugg.map((x) => x.verdict)).toEqual(['correct', 'duplicate', 'false-positive']);
	});

	it('counts a text suggestion on a checkbox as the wrong type, and a box on a push button as neutral', () => {
		const sc = scorePage([{ type: 'checkbox', rect: [50, 50, 60, 60], cue: true }], [s('text', [50, 50, 60, 60]), s('checkbox', [200, 200, 210, 210])], [[198, 198, 212, 212]]);
		expect(sc.sugg.map((x) => x.verdict)).toEqual(['wrong-type', 'neutral']);
	});

	it('accepts a printed box inside a larger checkbox widget', () => {
		expect(good({ type: 'checkbox', rect: [433, 226, 448, 241], cue: true }, s('checkbox', [437, 232, 444, 239]))).toBe(true);
		expect(good({ type: 'checkbox', rect: [433, 226, 448, 241], cue: true }, s('checkbox', [433, 226, 436, 229]))).toBe(false);
	});
});
