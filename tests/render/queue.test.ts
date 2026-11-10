import { describe, expect, it } from 'vitest';
import { RenderQueue } from '../../src/lib/render/queue';

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RenderQueue', () => {
	it('limits concurrency', async () => {
		const q = new RenderQueue(2);
		const gates = [deferred(), deferred(), deferred(), deferred()];
		let active = 0;
		let peak = 0;
		const ps = gates.map((g) =>
			q.add(async () => {
				active++;
				peak = Math.max(peak, active);
				await g.promise;
				active--;
			})
		);
		await tick();
		expect(q.running).toBe(2);
		expect(q.pending).toBe(2);
		gates.forEach((g) => g.resolve());
		await Promise.all(ps);
		expect(peak).toBe(2);
	});

	it('runs the most recent request first', async () => {
		const q = new RenderQueue(1);
		const order: string[] = [];
		const gate = deferred();
		const first = q.add(async () => {
			await gate.promise;
			order.push('first');
		});
		const ps = ['a', 'b', 'c'].map((n) => q.add(async () => void order.push(n)));
		await tick();
		gate.resolve();
		await Promise.all([first, ...ps]);
		expect(order).toEqual(['first', 'c', 'b', 'a']);
	});

	it('an aborted pending task never runs and rejects with AbortError', async () => {
		const q = new RenderQueue(1);
		const gate = deferred();
		const busy = q.add(() => gate.promise);
		const ac = new AbortController();
		let ran = false;
		const p = q.add(async () => void (ran = true), ac.signal);
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
		gate.resolve();
		await busy;
		expect(ran).toBe(false);
		expect(q.pending).toBe(0);
	});

	it('already-aborted signal rejects immediately', async () => {
		const q = new RenderQueue(1);
		const ac = new AbortController();
		ac.abort();
		await expect(q.add(async () => 1, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('aborting a running task signals it and maps its failure to AbortError', async () => {
		const q = new RenderQueue(1);
		const ac = new AbortController();
		const started = deferred();
		const p = q.add(
			(signal) =>
				new Promise((_res, rej) => {
					started.resolve();
					signal.addEventListener('abort', () => rej(new Error('cancelled')));
				}),
			ac.signal
		);
		await started.promise;
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
		await tick();
		expect(q.running).toBe(0);
	});

	it('a failing task frees its slot', async () => {
		const q = new RenderQueue(1);
		const bad = q.add(async () => {
			throw new Error('boom');
		});
		const good = q.add(async () => 'ok');
		await expect(bad).rejects.toThrow('boom');
		await expect(good).resolves.toBe('ok');
	});

	it('clearPending rejects queued work', async () => {
		const q = new RenderQueue(1);
		const gate = deferred();
		const busy = q.add(() => gate.promise);
		const queued = q.add(async () => 1);
		q.clearPending();
		await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
		gate.resolve();
		await busy;
	});
});
