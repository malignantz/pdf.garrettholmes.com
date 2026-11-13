/**
 * Pictures of every page of a PDF, for "Save pages as pictures" (JPG or PNG).
 *
 * Same engine as the page view (PDF.js through pdfjs-loader.ts, assets from our own
 * origin), but none of the page view's cache or width buckets: each page is drawn at
 * exactly the asked resolution (sizing.ts pictureSize), on a white, opaque canvas,
 * encoded by the browser, and the canvas is released before the next page. One page
 * is in memory as pixels at a time.
 *
 * The caller hands in a finished, verified export (multi-export.ts): this module never
 * draws stamps, redactions or form answers itself, so a picture shows exactly what the
 * exported PDF shows. Annotations with appearances are drawn, as the page view draws them.
 */

import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import type { PdfJsHandle } from './renderer';
import { abortError } from './queue';
import { pictureSize } from './sizing';

export interface PictureOptions {
	/** Resolution asked for, in dots per inch. */
	dpi: number;
	type: 'image/jpeg' | 'image/png';
	/** JPEG quality, 0..1. */
	quality?: number;
	signal?: AbortSignal;
	/** Tests only: another PDF.js build. */
	pdfjs?: () => Promise<PdfJsHandle>;
}

export interface PagePicture {
	/** 0-based page index. */
	index: number;
	/** Pages in the document. */
	count: number;
	blob: Blob;
	width: number;
	height: number;
	/** Resolution used (lower than asked when the page was too large; see `reduced`). */
	dpi: number;
	reduced: boolean;
}

async function defaultPdfJs(): Promise<PdfJsHandle> {
	const loader = await import('./pdfjs-loader');
	return { lib: await loader.loadPdfJs(), documentOptions: loader.documentAssetOptions };
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): Canvas {
	if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
	const c = document.createElement('canvas');
	c.width = width;
	c.height = height;
	return c;
}

function encode(canvas: Canvas, type: string, quality: number | undefined): Promise<Blob> {
	if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type, quality });
	return new Promise((resolve, reject) =>
		(canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be encoded.'))), type, quality)
	);
}

/** Renders and encodes the pages of `bytes` one at a time, in page order. */
export async function* renderPictures(bytes: Uint8Array, options: PictureOptions): AsyncGenerator<PagePicture> {
	const { signal } = options;
	const { lib, documentOptions } = await (options.pdfjs ?? defaultPdfJs)();
	if (signal?.aborted) throw abortError();
	// PDF.js transfers the buffer to its worker: hand it a copy.
	const task: PDFDocumentLoadingTask = lib.getDocument({ data: bytes.slice(), ...documentOptions });
	try {
		const doc = await task.promise;
		for (let i = 0; i < doc.numPages; i++) {
			if (signal?.aborted) throw abortError();
			const page = await doc.getPage(i + 1);
			let canvas: Canvas | undefined;
			try {
				const unit = page.getViewport({ scale: 1 });
				const size = pictureSize(unit.width, unit.height, options.dpi);
				const viewport = page.getViewport({ scale: size.width / unit.width });
				canvas = makeCanvas(size.width, size.height);
				const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
				if (!ctx) throw new Error('Could not create a 2D canvas context');
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, size.width, size.height);
				const render = page.render({
					canvas: canvas as HTMLCanvasElement,
					canvasContext: ctx as CanvasRenderingContext2D,
					viewport,
					background: '#ffffff'
				});
				const onAbort = () => render.cancel();
				signal?.addEventListener('abort', onAbort);
				try {
					await render.promise;
				} catch (e) {
					if (signal?.aborted || (e as Error)?.name === 'RenderingCancelledException') throw abortError();
					throw e;
				} finally {
					signal?.removeEventListener('abort', onAbort);
				}
				const blob = await encode(canvas, options.type, options.type === 'image/jpeg' ? (options.quality ?? 0.9) : undefined);
				yield { index: i, count: doc.numPages, blob, width: size.width, height: size.height, dpi: size.dpi, reduced: size.reduced };
			} finally {
				if (canvas) {
					canvas.width = 0;
					canvas.height = 0;
				}
				page.cleanup();
			}
		}
	} finally {
		await task.destroy().catch(() => undefined);
	}
}
