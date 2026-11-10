import { describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { createEngine, type WorkerLike } from '../../src/lib/engine/client';
import { serveEngine } from '../../src/lib/engine/host';
import { EngineError } from '../../src/lib/engine/errors';
import { corpus, defaultOptions, engine } from './helpers';

/** A "worker" made of a MessageChannel, served in this thread by the real core engine. */
function channelWorker(): WorkerLike & { crash(): void; terminated: boolean } {
	const { port1, port2 } = new MessageChannel();
	serveEngine(
		{
			postMessage: (m, t) => port2.postMessage(m, t as never),
			addEventListener: (_type, fn) => port2.on('message', (data) => fn({ data } as MessageEvent))
		},
		engine()
	);
	const errorListeners: ((e: Event) => void)[] = [];
	const w = {
		terminated: false,
		postMessage: (m: unknown) => port1.postMessage(m),
		addEventListener: (type: string, fn: (e: never) => void) => {
			if (type === 'message') port1.on('message', (data) => (fn as (e: MessageEvent) => void)({ data } as MessageEvent));
			else if (type === 'error') errorListeners.push(fn as (e: Event) => void);
		},
		terminate: () => {
			w.terminated = true;
			port1.close();
			port2.close();
		},
		crash: () => errorListeners.forEach((fn) => fn(new Event('error')))
	};
	return w as WorkerLike & { crash(): void; terminated: boolean };
}

describe('client ↔ worker protocol', () => {
	it('creates the worker lazily and round-trips every method', async () => {
		let spawned = 0;
		const client = createEngine({
			createWorker: () => {
				spawned++;
				return channelWorker();
			}
		});
		expect(spawned).toBe(0);
		const input = corpus('multi.pdf');
		const src = await client.openPdf(input, 'multi.pdf');
		expect(spawned).toBe(1);
		expect(src.pages).toHaveLength(6);
		expect(src.bytes).toBeInstanceOf(Uint8Array);
		// The caller's input is not detached.
		expect(input.byteLength).toBeGreaterThan(0);

		const img = await client.openImage(corpus('alpha.png'), 'image/png', 'a.png');
		const blank = await client.blankPage({ width: 100, height: 100 });
		expect(await client.unsupportedChars('a✓')).toBe('✓');

		const sourceBytes = src.bytes.byteLength;
		const res = await client.exportPlan(
			{
				pages: [
					{ id: 'a', sourceId: src.id, pageIndex: 0, rotation: 90, stamps: [] },
					{ id: 'b', sourceId: img.id, pageIndex: 0, rotation: 0, stamps: [] },
					{ id: 'c', sourceId: blank.id, pageIndex: 0, rotation: 0, stamps: [] }
				],
				options: defaultOptions
			},
			[src, img, blank],
			[]
		);
		expect(res.pageCount).toBe(3);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		// Sources the store holds survive the call intact.
		expect(src.bytes.byteLength).toBe(sourceBytes);
		expect(await client.formFields(src)).toEqual([]);
		expect(spawned).toBe(1);
		client.terminate();
	}, 60_000);

	it('delivers engine errors as EngineError with the code and plain message', async () => {
		const client = createEngine({ createWorker: channelWorker });
		const e = await client.openPdf(corpus('enc-aes-256.pdf'), 'x').catch((err) => err);
		expect(e).toBeInstanceOf(EngineError);
		expect(e.code).toBe('password-required');
		expect(e.message).toMatch(/password/);
		const v = await client.exportPlan({ pages: [], options: defaultOptions }, [], []).catch((err) => err);
		expect(v.code).toBe('unsupported');
		client.terminate();
	}, 30_000);

	it('rejects pending calls when the worker dies, then starts a fresh one', async () => {
		const workers: ReturnType<typeof channelWorker>[] = [];
		const client = createEngine({
			createWorker: () => {
				const w = channelWorker();
				workers.push(w);
				return w;
			}
		});
		const p = client.openPdf(corpus('multi.pdf'), 'x');
		workers[0].crash();
		const e = await p.catch((err) => err);
		expect(e).toBeInstanceOf(EngineError);
		expect(e.code).toBe('internal');
		expect(workers[0].terminated).toBe(true);
		const s = await client.blankPage({ width: 50, height: 50 });
		expect(s.pages).toEqual([{ width: 50, height: 50 }]);
		expect(workers).toHaveLength(2);
		client.terminate();
	}, 30_000);
});
