/** Serves an Engine over a message port (the worker side of the protocol). */

import type { Engine } from '../core/types';
import { toErrorShape } from './errors';
import { TAG, isRequest, prepareResultTransfer, type EngineResponse } from './protocol';

export interface PortLike {
	postMessage(message: unknown, transfer: Transferable[]): void;
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export function serveEngine(port: PortLike, engine: Engine): void {
	port.addEventListener('message', async (event: MessageEvent) => {
		const req = event.data;
		if (!isRequest(req)) return;
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
		port.postMessage(response, transfer);
	});
}
