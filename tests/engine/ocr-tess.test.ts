/** The tesseract.js worker client (src/lib/engine/ocr/tess.ts): replies, failures, time-outs, results. */
import { describe, expect, it } from 'vitest';
import { TessWorker, parseRead, type TessPort } from '../../src/lib/engine/ocr/tess';

function fakePort(answer: (m: { jobId: string; action: string; payload: unknown }) => unknown | 'never' | Error) {
	let onMsg: (d: unknown) => void = () => {};
	let onErr: (e: unknown) => void = () => {};
	const port = {
		terminated: false,
		crash: (e: unknown) => onErr(e),
		post: (m: unknown) => {
			const msg = m as { jobId: string; action: string; payload: unknown };
			const a = answer(msg);
			if (a === 'never') return;
			setTimeout(() => onMsg({ jobId: msg.jobId, action: msg.action, status: a instanceof Error ? 'reject' : 'resolve', data: a instanceof Error ? a.message : a }), 1);
		},
		onMessage: (fn: (d: unknown) => void) => void (onMsg = fn),
		onError: (fn: (e: unknown) => void) => void (onErr = fn),
		terminate: () => void (port.terminated = true)
	};
	return port as TessPort & { terminated: boolean; crash(e: unknown): void };
}

describe('OCR worker client', () => {
	it('matches replies to jobs and passes rejections on', async () => {
		const port = fakePort((m) => (m.action === 'detect' ? new Error('RuntimeError: memory access out of bounds') : { ok: m.action }));
		const w = new TessWorker(port);
		expect(await w.call('load', {})).toEqual({ ok: 'load' });
		await expect(w.call('detect', {})).rejects.toThrow(/memory access out of bounds/);
		expect(w.alive).toBe(true);
	});

	it('kills a worker that takes too long, and every later call fails at once', async () => {
		const port = fakePort(() => 'never');
		const w = new TessWorker(port);
		await expect(w.call('recognize', {}, 30)).rejects.toThrow(/took longer/);
		expect(port.terminated).toBe(true);
		expect(w.alive).toBe(false);
		await expect(w.call('recognize', {})).rejects.toThrow(/stopped/);
	});

	it('fails pending calls when the worker dies', async () => {
		const port = fakePort(() => 'never');
		const w = new TessWorker(port);
		const p = w.call('recognize', {});
		port.crash(new Error('worker died'));
		await expect(p).rejects.toThrow(/worker died/);
		expect(w.alive).toBe(false);
	});

	it('reads lines, baselines, confidences and the deskew angle from a result', () => {
		const r = parseRead(
			{
				rotateRadians: 0.0124,
				blocks: [
					{
						paragraphs: [
							{
								lines: [
									{ baseline: { x0: 10, y0: 50, x1: 300, y1: 52, has_baseline: true }, words: [{ text: 'Dear', confidence: 96.04, bbox: { x0: 10, y0: 20, x1: 60, y1: 50 } }, { text: ' ', confidence: 90, bbox: { x0: 61, y0: 20, x1: 62, y1: 50 } }] },
									{ baseline: null, words: [{ text: '   ', confidence: 10, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] }
								]
							}
						]
					}
				]
			},
			1800,
			1200
		);
		expect(r).toEqual({ width: 1800, height: 1200, rotate: 0.0124, lines: [{ baseline: [10, 50, 300, 52], words: [['Dear', 10, 20, 60, 50, 96]] }] });
		expect(parseRead(null, 10, 10)).toEqual({ width: 10, height: 10, rotate: 0, lines: [] });
	});
});
