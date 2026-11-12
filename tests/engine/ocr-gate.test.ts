/**
 * The OCR page gate (src/lib/engine/ocr/gate.ts) must be the measurement's gate
 * exactly: the same signals as tools/ocr/lib/score.ts and the thresholds tools/ocr/gate.ts
 * chose ("at most 5% bad among accepted on dev": minConf 84, minStop 0.08).
 */
import { describe, expect, it } from 'vitest';
import { GATE, WORD_MIN_CONF, gateAccepts, norm, signals, type OcrWord } from '../../src/lib/engine/ocr/gate';
import { judge } from '../../src/lib/engine/ocr/stage';
import { norm as harnessNorm, signals as harnessSignals } from '../../tools/ocr/lib/score';
import { accept as harnessAccept } from '../../tools/ocr/report';

const TOKENS = ['the', 'The', 'of', 'house,', 'land.', '“Dear', 'Sir”', 'I-9', '!-9', '|', '—', '12.5%', '$40', 'é', 'Needies', 'xq', 'zkv', "don't", '(see', 'a)', 'ﬁle', 'O', '0', '…', ''];

function rng(seed: number) {
	let s = seed;
	return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function randomPage(r: () => number): OcrWord[] {
	const n = Math.floor(r() * 60);
	return Array.from({ length: n }, () => {
		const x = r() * 2000;
		const y = r() * 3000;
		return [TOKENS[Math.floor(r() * TOKENS.length)], x, y, x + 10 + r() * 200, y + 10 + r() * 60, Math.round(r() * 1000) / 10] as OcrWord;
	});
}

describe('OCR gate', () => {
	it('computes the same signals as the measurement harness', () => {
		const r = rng(20261112);
		for (let i = 0; i < 400; i++) {
			const page = randomPage(r);
			expect(signals(page)).toEqual(harnessSignals(page));
		}
		for (const t of TOKENS) expect(norm(t)).toBe(harnessNorm(t));
	});

	it('accepts exactly what the measured gate accepts', () => {
		const measured = { minConf: 84, maxLow60: 1, minStop: 0.08, minWordy: 0, minWords: 0 };
		expect(GATE).toEqual({ minConf: 84, minStop: 0.08 });
		const r = rng(7);
		let accepted = 0;
		for (let i = 0; i < 2000; i++) {
			const s = { ...signals([]), words: Math.floor(r() * 50), meanConf: 70 + r() * 30, stop: r() * 0.2, low60: r(), wordy: r(), medH: r() * 50 };
			expect(gateAccepts(s)).toBe(harnessAccept(measured, s));
			if (gateAccepts(s)) accepted++;
		}
		expect(accepted).toBeGreaterThan(100);
	});

	it('gates on every word, then drops words under confidence 50 from what is written', () => {
		const line = (words: OcrWord[]) => ({ baseline: [0, 50, 900, 50] as [number, number, number, number], words });
		const good: OcrWord[] = ['the', 'house', 'on', 'the', 'hill', 'is', 'old'].map((t, i) => [t, i * 100, 10, i * 100 + 80, 50, 95]);
		const read = { width: 1000, height: 100, rotate: 0, lines: [line([...good, ['zq', 800, 10, 850, 50, 40]])] };
		const o = judge(read);
		expect(o.ok).toBe(true);
		if (!o.ok) return;
		// The low word counted towards the signals (8 words) but is not written.
		expect(o.signals.words).toBe(8);
		expect(o.read.lines[0].words.map((w) => w[0])).toEqual(good.map((w) => w[0]));
		expect(o.read.lines[0].words.every((w) => w[5] >= WORD_MIN_CONF)).toBe(true);

		// Confident made-up words: no common English, declined.
		const junk: OcrWord[] = ['xqv', 'zrlp', 'bdkw', 'grtf'].map((t, i) => [t, i * 100, 10, i * 100 + 80, 50, 96]);
		expect(judge({ width: 1000, height: 100, rotate: 0, lines: [line(junk)] })).toMatchObject({ ok: false, why: 'gate' });
		// Common words read with low confidence: declined.
		const unsure: OcrWord[] = good.map((w) => [w[0], w[1], w[2], w[3], w[4], 70]);
		expect(judge({ width: 1000, height: 100, rotate: 0, lines: [line(unsure)] })).toMatchObject({ ok: false, why: 'gate' });
		expect(judge({ width: 1000, height: 100, rotate: 0, lines: [] })).toMatchObject({ ok: false, why: 'gate' });
	});
});
