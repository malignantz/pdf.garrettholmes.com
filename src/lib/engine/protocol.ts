/**
 * Messages between the main thread (client.ts) and the engine worker (worker.ts).
 * Kept free of engine imports so the client stays tiny.
 */

import type { Engine, EngineErrorShape } from '../core/types';

export const TAG = 'pdf-engine/1';

export type EngineMethod = keyof Engine;

export interface EngineRequest {
	tag: typeof TAG;
	id: number;
	method: EngineMethod;
	args: unknown[];
}

export type EngineResponse =
	| { tag: typeof TAG; id: number; ok: true; value: unknown }
	| { tag: typeof TAG; id: number; ok: false; error: EngineErrorShape };

/**
 * Sent by the worker after its reply when it must not be used again (MuPDF faulted
 * and cannot be re-created inside this worker; see mupdf.ts). The client starts a
 * new worker and sends it every request this one has not answered.
 */
export interface EngineRestart {
	tag: typeof TAG;
	restart: true;
}

export function isRestart(data: unknown): data is EngineRestart {
	const d = data as EngineRestart | null;
	return !!d && d.tag === TAG && d.restart === true;
}

export const METHODS: readonly EngineMethod[] = [
	'openPdf',
	'openImage',
	'blankPage',
	'exportPlan',
	'unsupportedChars',
	'formFields',
	'pageBlanks'
];

export function isRequest(data: unknown): data is EngineRequest {
	const d = data as EngineRequest | null;
	return !!d && d.tag === TAG && typeof d.id === 'number' && METHODS.includes(d.method) && Array.isArray(d.args);
}

export function isResponse(data: unknown): data is EngineResponse {
	const d = data as EngineResponse | null;
	return !!d && d.tag === TAG && typeof d.id === 'number' && typeof d.ok === 'boolean';
}

/**
 * The `bytes` buffer of a result (Source or ExportResult) can be transferred: the
 * worker created it and keeps no reference. If the view does not span its whole
 * buffer, it is copied first so nothing else is detached or leaked.
 */
export function prepareResultTransfer(value: unknown): { value: unknown; transfer: Transferable[] } {
	if (typeof value !== 'object' || value === null || !('bytes' in value)) return { value, transfer: [] };
	const v = value as { bytes: unknown };
	if (!(v.bytes instanceof Uint8Array)) return { value, transfer: [] };
	let bytes = v.bytes;
	if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength || !(bytes.buffer instanceof ArrayBuffer)) {
		bytes = bytes.slice();
	}
	return { value: { ...value, bytes }, transfer: [bytes.buffer as ArrayBuffer] };
}
