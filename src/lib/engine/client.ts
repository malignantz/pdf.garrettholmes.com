/**
 * Main-thread Engine: a proxy to the engine Web Worker. The worker (and with it
 * qpdf, pdf-lib and PDF.js) is created on the first call, so importing this module
 * costs only a few kilobytes.
 *
 * Buffers: arguments are structured-cloned (copied), never transferred, because the
 * caller keeps them (Source.bytes lives in the store). Results are transferred from
 * the worker, which keeps no reference to them.
 */

import type { Engine } from '../core/types';
import { EngineError, fromErrorShape } from './errors';
import { NEED_BYTES, TAG, isResponse, isRestart, type EngineMethod, type EngineRequest } from './protocol';

export interface WorkerLike {
	postMessage(message: unknown): void;
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
	addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
	terminate(): void;
}

export interface EngineClient extends Engine {
	/** Stops the worker and rejects pending calls. The next call starts a new worker. */
	terminate(): void;
}

function defaultWorker(): WorkerLike {
	return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'pdf-engine' });
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
	req: EngineRequest;
	/** Times this request was sent again to a replacement worker. */
	resent: number;
}

export function createEngine(options: { createWorker?: () => WorkerLike } = {}): EngineClient {
	const spawn = options.createWorker ?? defaultWorker;
	let worker: WorkerLike | null = null;
	let nextId = 1;
	const pending = new Map<number, Pending>();
	/** Sources whose bytes the current worker was sent by pageText. */
	let textSent = new Set<string>();

	const failAll = (message: string) => {
		const err = new EngineError('internal', message);
		for (const p of pending.values()) p.reject(err);
		pending.clear();
	};

	const reset = (message: string) => {
		const w = worker;
		worker = null;
		try {
			w?.terminate();
		} catch {
			// Already gone.
		}
		failAll(message);
	};

	// The worker asked to be replaced (see protocol.ts EngineRestart): requests it has not
	// answered go to a new worker, each at most twice.
	const replace = (w: WorkerLike) => {
		worker = null;
		try {
			w.terminate();
		} catch {
			// Already gone.
		}
		for (const [id, p] of [...pending]) {
			if (p.resent >= 2) {
				pending.delete(id);
				p.reject(new EngineError('internal', 'The PDF engine stopped unexpectedly. Try again.'));
				continue;
			}
			p.resent++;
			send(id, p);
		}
	};

	const send = (id: number, p: Pending) => {
		let w: WorkerLike;
		try {
			w = ensure();
		} catch {
			pending.delete(id);
			p.reject(new EngineError('internal', 'The PDF engine could not start in this browser.'));
			return;
		}
		try {
			w.postMessage(p.req);
		} catch {
			pending.delete(id);
			p.reject(new EngineError('internal', 'The PDF engine could not receive this file.'));
		}
	};

	const ensure = (): WorkerLike => {
		if (worker) return worker;
		const w = spawn();
		textSent = new Set();
		w.addEventListener('message', (event: MessageEvent) => {
			if (worker !== w) return;
			const msg = event.data;
			if (isRestart(msg)) {
				replace(w);
				return;
			}
			if (!isResponse(msg)) return;
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			if (msg.ok) p.resolve(msg.value);
			else p.reject(fromErrorShape(msg.error));
		});
		w.addEventListener('error', (event: Event) => {
			event.preventDefault?.();
			if (worker === w) reset('The PDF engine stopped unexpectedly. Try again.');
		});
		w.addEventListener('messageerror', () => {
			if (worker === w) reset('The PDF engine could not read a message. Try again.');
		});
		worker = w;
		return w;
	};

	const call = <T>(method: EngineMethod, args: unknown[]): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const id = nextId++;
			const p: Pending = { resolve: resolve as (v: unknown) => void, reject, req: { tag: TAG, id, method, args }, resent: 0 };
			pending.set(id, p);
			send(id, p);
		});

	return {
		openPdf: (bytes, name, password) => call('openPdf', [bytes, name, password]),
		openImage: (bytes, mime, name) => call('openImage', [bytes, mime, name]),
		blankPage: (size) => call('blankPage', [size]),
		exportPlan: (plan, sources, assets) => call('exportPlan', [plan, sources, assets]),
		unsupportedChars: (text) => call('unsupportedChars', [text]),
		formFields: (source) => call('formFields', [source]),
		pageText: async (source, pageIndex) => {
			if (textSent.has(source.id)) {
				try {
					return await call('pageText', [{ ...source, bytes: undefined }, pageIndex]);
				} catch (e) {
					if (!(e instanceof EngineError && e.message === NEED_BYTES)) throw e;
				}
			}
			const sent = textSent;
			const res = await call<Awaited<ReturnType<EngineClient['pageText']>>>('pageText', [source, pageIndex]);
			sent.add(source.id);
			return res;
		},
		terminate: () => reset('The PDF engine was stopped.')
	};
}
