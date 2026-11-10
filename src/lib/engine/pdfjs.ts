/**
 * PDF.js as an independent parser: page geometry at intake (so sizes match what the
 * renderer shows) and the re-open check at export.
 */

import type { PageSize } from '../core/types';
import { EngineError } from './errors';

export type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

export interface PdfjsInfo {
	numPages: number;
	pages: PageSize[];
	hasSignatures: boolean;
	hasXfa: boolean;
}

export type PdfjsOpenFailure = 'password-required' | 'password-wrong' | 'unreadable';

export class PdfjsOpenError extends Error {
	readonly kind: PdfjsOpenFailure;
	constructor(kind: PdfjsOpenFailure, message: string) {
		super(message);
		this.kind = kind;
	}
}

/**
 * Opens a copy of `bytes` (PDF.js transfers the buffer it is given) and reads every
 * page's displayed size from its viewport at scale 1.
 */
export async function inspectWithPdfjs(lib: PdfjsLib, bytes: Uint8Array, password?: string): Promise<PdfjsInfo> {
	const task = lib.getDocument({
		data: bytes.slice(),
		password,
		isEvalSupported: false,
		useWasm: false,
		useWorkerFetch: false,
		useSystemFonts: false,
		disableFontFace: true,
		enableXfa: false,
		stopAtErrors: true,
		verbosity: 0
	});
	try {
		let doc;
		try {
			doc = await task.promise;
		} catch (e) {
			const err = e as { name?: string; code?: number; message?: string };
			if (err?.name === 'PasswordException') {
				throw new PdfjsOpenError(
					err.code === lib.PasswordResponses.INCORRECT_PASSWORD ? 'password-wrong' : 'password-required',
					String(err.message)
				);
			}
			throw new PdfjsOpenError('unreadable', String(err?.message ?? e));
		}
		const numPages = doc.numPages;
		const pages = await Promise.all(
			Array.from({ length: numPages }, async (_, i) => {
				const page = await doc.getPage(i + 1);
				const vp = page.getViewport({ scale: 1 });
				return { width: vp.width, height: vp.height };
			})
		);
		const meta = await doc.getMetadata().catch(() => null);
		const info = (meta?.info ?? {}) as Record<string, unknown>;
		return {
			numPages,
			pages,
			hasSignatures: info.IsSignaturesPresent === true,
			hasXfa: info.IsXFAPresent === true
		};
	} finally {
		await task.destroy().catch(() => undefined);
	}
}

export function pdfjsFailureToEngineError(e: unknown): EngineError {
	if (e instanceof PdfjsOpenError && e.kind === 'password-required') {
		return new EngineError('password-required', 'This file is protected with a password. Enter it to open the file.');
	}
	if (e instanceof PdfjsOpenError && e.kind === 'password-wrong') {
		return new EngineError('password-wrong', 'That password did not open the file. Check it and try again.');
	}
	return new EngineError('unreadable', 'This file could not be read as a PDF.');
}
