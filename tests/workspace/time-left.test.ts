import { describe, expect, it } from 'vitest';
import { TimeLeft, describeSeconds } from '../../src/lib/workspace/time-left';
import { progressFraction, progressSample, progressText } from '../../src/lib/workspace/export-progress';

const check = (fraction: number, final = true) => ({ step: 'check', fraction, final });

/** A step that runs at a steady rate from `from` ms, taking `ms` in all; samples every 200 ms until `until`. */
function steady(t: TimeLeft, from: number, ms: number, until: number, final = true) {
	for (let now = from; now <= until; now += 200) t.update(now, check((now - from) / ms, final));
}

describe('describeSeconds', () => {
	it('is coarse and plain', () => {
		expect(describeSeconds(0)).toBe('Less than 10 seconds left');
		expect(describeSeconds(9.9)).toBe('Less than 10 seconds left');
		expect(describeSeconds(11)).toBe('About 20 seconds left');
		expect(describeSeconds(30)).toBe('About 30 seconds left');
		expect(describeSeconds(44)).toBe('About 50 seconds left');
		expect(describeSeconds(55)).toBe('About a minute left');
		expect(describeSeconds(89)).toBe('About a minute left');
		expect(describeSeconds(100)).toBe('About 2 minutes left');
		expect(describeSeconds(200)).toBe('About 3 minutes left');
		expect(describeSeconds(45 * 60)).toBe('About 45 minutes left');
		expect(describeSeconds(2 * 3600)).toBe('More than an hour left');
	});
});

describe('TimeLeft', () => {
	it('says nothing before 10 seconds, then extrapolates a steady step', () => {
		const t = new TimeLeft(0);
		// The check starts at 3 s and takes 50 s (ends at 53 s).
		steady(t, 3000, 50_000, 9800);
		expect(t.text(9800)).toBeNull();
		steady(t, 3000, 50_000, 10_000);
		expect(t.text(10_000)).toBe('About 50 seconds left'); // 43 s left, rounded up
		steady(t, 3000, 50_000, 25_000);
		expect(t.text(25_000)).toBe('About 30 seconds left'); // 28 s
		steady(t, 3000, 50_000, 46_000);
		expect(t.text(46_000)).toBe('Less than 10 seconds left'); // 7 s
	});

	it('the threshold can be changed (tests, a quicker dialog)', () => {
		const t = new TimeLeft(0, { showAfterMs: 0 });
		steady(t, 0, 100_000, 4000);
		expect(t.text(4000)).toBe('About 2 minutes left'); // 96 s
	});

	it('says nothing without a fraction or too early in a step; a step that is not the last is named', () => {
		const t = new TimeLeft(0);
		t.update(20_000, null);
		expect(t.text(20_000)).toBeNull();
		steady(t, 20_000, 60_000, 30_000, false);
		expect(t.text(30_000)).toBe('About 50 seconds left for this step');
		// The final step begins: under 2 s of it is not enough to measure.
		t.update(30_000, check(0));
		t.update(31_500, check(0.1));
		expect(t.text(31_500)).toBeNull();
		t.update(32_100, check(0.14));
		expect(t.text(32_100)).not.toBeNull();
	});

	it('does not jump about with uneven progress', () => {
		const t = new TimeLeft(0);
		// 60 s step in bursts: fast, stalled, fast...; true end at 60 s.
		const seen: string[] = [];
		let f = 0;
		for (let now = 0; now <= 50_000; now += 250) {
			if (Math.floor(now / 1000) % 2 === 0) f += 0.25 / 30; // all the work in alternate seconds
			t.update(now, check(Math.min(f, 0.999)));
			const s = t.text(now);
			if (s && seen[seen.length - 1] !== s) seen.push(s);
		}
		// Only ever counting down, never back up.
		const secs = seen.map((s) => (s.includes('minute') ? 60 : s.startsWith('Less') ? 5 : Number(s.match(/\d+/)![0])));
		for (let i = 1; i < secs.length; i++) expect(secs[i]).toBeLessThanOrEqual(secs[i - 1]);
		expect(seen.length).toBeLessThanOrEqual(6);
	});

	it('goes up again only when the estimate clearly grew', () => {
		const t = new TimeLeft(0, { showAfterMs: 0, smoothing: 1 });
		let f = 0;
		const run = (from: number, to: number, perSecond: number) => {
			for (let now = from; now <= to; now += 200) {
				t.update(now, check(f));
				f += perSecond / 5;
			}
		};
		run(0, 10_000, 0.025); // 30 s left
		expect(t.text(10_000)).toBe('About 30 seconds left');
		run(10_200, 11_000, 0.02); // a little slower: about 31 s, still "30"
		expect(t.text(11_000)).toBe('About 30 seconds left');
		run(11_200, 25_000, 0.005); // much slower: about 2 minutes
		expect(t.text(25_000)).toBe('About 2 minutes left');
	});

	it('measures the rate over the latter half of the step, not its quick start', () => {
		const t = new TimeLeft(0, { showAfterMs: 0, smoothing: 1 });
		// The first second does 10%, then 1% a second: at 20 s, 29% done, 71 s left.
		for (let now = 0; now <= 20_000; now += 200) t.update(now, check(now <= 1000 ? now / 10_000 : 0.1 + (now - 1000) / 100_000));
		expect(t.text(20_000)).toBe('About a minute left'); // from the start it would say 49 s
	});

	it('starts over for a new step or when the fraction goes back (a retried check)', () => {
		const t = new TimeLeft(0, { showAfterMs: 0 });
		steady(t, 0, 20_000, 10_000);
		expect(t.text(10_000)).toBe('Less than 10 seconds left');
		t.update(10_200, check(0.01));
		expect(t.text(10_200)).toBeNull();
		t.update(10_400, { step: 'compare', fraction: 0.5, final: false });
		expect(t.text(10_400)).toBeNull();
		steady(t, 10_400, 20_000, 14_000, false);
		expect(t.text(14_000)).toBe('About 20 seconds left for this step');
	});

	it('stops talking when well past its own estimate (a stall)', () => {
		const t = new TimeLeft(0, { showAfterMs: 0 });
		steady(t, 0, 20_000, 18_000);
		expect(t.text(18_000)).toBe('Less than 10 seconds left');
		expect(t.text(29_000)).toBe('Less than 10 seconds left');
		expect(t.text(31_000)).toBeNull();
	});
});

describe('export progress for the dialog', () => {
	it('gives a fraction only while a counted stage runs', () => {
		expect(progressFraction(null)).toBeUndefined();
		expect(progressFraction({ stage: 'ocr-load' })).toBeUndefined();
		expect(progressFraction({ stage: 'pictures', done: 5, total: 20 })).toBe(0.25);
		expect(progressFraction({ stage: 'check', done: 30, total: 120, last: true })).toBe(0.25);
		expect(progressFraction({ stage: 'check', done: 120, total: 120, last: true })).toBeUndefined();
		expect(progressFraction({ stage: 'pack', done: 0, total: 0 })).toBeUndefined();
	});

	it('words each stage plainly', () => {
		expect(progressText({ stage: 'ocr', done: 2, total: 12 })).toBe('Reading page 3 of 12');
		expect(progressText({ stage: 'pictures', done: 2, total: 20 })).toBe('Reducing picture 3 of 20');
		expect(progressText({ stage: 'pictures-read', done: 4, total: 260 })).toBe('Looking at picture 5 of 260');
		expect(progressText({ stage: 'reduce', done: 0, total: 260 })).toBe('Reducing picture 1 of 260');
		expect(progressText({ stage: 'compare', done: 9, total: 260 })).toBe('Comparing page 10 of 260');
		expect(progressText({ stage: 'pack', done: 10, total: 100 })).toBe('Optimizing…');
		expect(progressText({ stage: 'check', done: 10, total: 100, last: false })).toBe('Checking the finished file…');
		expect(progressText({ stage: 'check', done: 100, total: 100, last: true })).toBeNull();
	});

	it('only the last check counts as the end of the export; the stream pass gives no estimate', () => {
		expect(progressSample({ stage: 'check', done: 1, total: 4, last: true })).toEqual({ step: 'check', fraction: 0.25, final: true });
		expect(progressSample({ stage: 'check', done: 1, total: 4, last: false })?.final).toBe(false);
		expect(progressSample({ stage: 'pictures', done: 1, total: 4 })?.final).toBe(false);
		expect(progressSample({ stage: 'ocr-load' })).toBeNull();
		expect(progressSample({ stage: 'pack', done: 1, total: 4 })).toBeNull();
	});
});
