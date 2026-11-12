/** Serves an Engine over a message port (the worker side of the protocol). */

import type { Engine } from '../core/types';
import { toErrorShape } from './errors';
import type { ExportControl } from '../core/types';
import { TAG, isCancel, isRequest, prepareResultTransfer, type EngineProgress, type EngineResponse, type EngineRestart } from './protocol';

export interface PortLike {
	postMessage(message: unknown, transfer: Transferable[]): void;
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface ServeOptions {
	/**
	 * True when this worker must be replaced (mupdf.ts `mupdfRestartNeeded`). From then
	 * on only error replies are sent (a result computed next to a faulted engine is not
	 * trusted; the client sends that request again to the new worker), then one
	 * restart message.
	 */
	restartNeeded?: () => boolean;
}

export function serveEngine(port: PortLike, engine: Engine, options: ServeOptions = {}): void {
	let retiring = false;
	/** Running exportPlan requests, so a cancel message can stop them. */
	const running = new Map<number, AbortController>();
	port.addEventListener('message', async (event: MessageEvent) => {
		const req = event.data;
		if (isCancel(req)) {
			running.get(req.cancel)?.abort();
			return;
		}
		if (!isRequest(req) || retiring) return;
		let response: EngineResponse;
		let transfer: Transferable[] = [];
		try {
			const fn = engine[req.method] as (...args: unknown[]) => Promise<unknown>;
			let args = req.args;
			if (req.method === 'exportPlan') {
				// The 4th argument (ExportControl) cannot cross the boundary: it is rebuilt here.
				const abort = new AbortController();
				running.set(req.id, abort);
				const control: ExportControl = {
					signal: abort.signal,
					onProgress: (progress) => {
						if (!retiring) port.postMessage({ tag: TAG, id: req.id, progress } satisfies EngineProgress, []);
					}
				};
				args = [...req.args.slice(0, 3), control];
			}
			const result = await fn.apply(engine, args).finally(() => running.delete(req.id));
			const prepared = prepareResultTransfer(result);
			transfer = prepared.transfer;
			response = { tag: TAG, id: req.id, ok: true, value: prepared.value };
		} catch (e) {
			const cause = (e as { cause?: unknown })?.cause;
			if (cause) console.error('[pdf-engine]', cause);
			response = { tag: TAG, id: req.id, ok: false, error: toErrorShape(e) };
		}
		const restart = options.restartNeeded?.() === true;
		if (retiring) return;
		if (!restart || !response.ok) port.postMessage(response, transfer);
		if (restart) {
			retiring = true;
			port.postMessage({ tag: TAG, restart: true } satisfies EngineRestart, []);
		}
	});
}
