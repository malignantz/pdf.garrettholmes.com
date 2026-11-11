/** Serves an Engine over a message port (the worker side of the protocol). */

import type { Engine } from '../core/types';
import { toErrorShape } from './errors';
import { TAG, isRequest, prepareResultTransfer, type EngineResponse, type EngineRestart } from './protocol';

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
	port.addEventListener('message', async (event: MessageEvent) => {
		const req = event.data;
		if (!isRequest(req) || retiring) return;
		let response: EngineResponse;
		let transfer: Transferable[] = [];
		try {
			const fn = engine[req.method] as (...args: unknown[]) => Promise<unknown>;
			const result = await fn.apply(engine, req.args);
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
