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
import { TAG, isResponse, type EngineMethod, type EngineRequest } from './protocol';

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

export function createEngine(options: { createWorker?: () => WorkerLike } = {}): EngineClient {
	const spawn = options.createWorker ?? defaultWorker;
	let worker: WorkerLike | null = null;
	let nextId = 1;
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

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

	const ensure = (): WorkerLike => {
		if (worker) return worker;
		const w = spawn();
		w.addEventListener('message', (event: MessageEvent) => {
			const msg = event.data;
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
			let w: WorkerLike;
			try {
				w = ensure();
			} catch {
				reject(new EngineError('internal', 'The PDF engine could not start in this browser.'));
				return;
			}
			const id = nextId++;
			pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			const req: EngineRequest = { tag: TAG, id, method, args };
			try {
				w.postMessage(req);
			} catch {
				pending.delete(id);
				reject(new EngineError('internal', 'The PDF engine could not receive this file.'));
			}
		});

	return {
		openPdf: (bytes, name, password) => call('openPdf', [bytes, name, password]),
		openImage: (bytes, mime, name) => call('openImage', [bytes, mime, name]),
		blankPage: (size) => call('blankPage', [size]),
		exportPlan: (plan, sources, assets) => call('exportPlan', [plan, sources, assets]),
		unsupportedChars: (text) => call('unsupportedChars', [text]),
		formFields: (source) => call('formFields', [source]),
		terminate: () => reset('The PDF engine was stopped.')
	};
}
