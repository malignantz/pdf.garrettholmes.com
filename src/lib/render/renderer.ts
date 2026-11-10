/**
 * Renderer: PDF.js behind the `Renderer` interface from core/types.ts.
 *
 * BITMAP OWNERSHIP RULE
 * The cache owns its master bitmaps and closes them on eviction. `render()`
 * never hands out a master: every call returns a fresh copy made with
 * `createImageBitmap(master)`. The caller owns that copy for ever, may draw it
 * whenever it likes, and should `close()` it when finished (or transfer it to a
 * `bitmaprenderer` canvas, which consumes it). Cache eviction can never
 * invalidate a bitmap a caller holds. The copy is cheap (browsers share or
 * GPU-copy the pixels; no PDF.js work is repeated).
 *
 * WIDTH SEMANTICS
 * `RenderRequest.width` is the device-pixel width of the page *before* the
 * user rotation (the intrinsic-rotation page as in `Source.pages`). The output
 * bitmap is then rotated, so for 90/270 its width is the page's height at that
 * scale. Requested widths are rounded up to a bucket (sizing.bucketWidth) so
 * nearby sizes share a cache entry; callers scale the bitmap with CSS.
 *
 * ASSETS
 * PDF.js, its worker, cMaps, standard fonts and wasm decoders come from our own
 * origin; see pdfjs-loader.ts. Nothing here touches the network.
 */

import type { Rotation, Renderer, RenderRequest, Source, SourceId } from '../core/types';
import { ByteLru } from './lru';
import { abortError, RenderQueue } from './queue';
import { bitmapBytes, bucketWidth, computeRenderSize } from './sizing';
import type { PdfJs } from './pdfjs-loader';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';

interface OpenDoc {
	task: PDFDocumentLoadingTask;
	doc: PDFDocumentProxy;
}

export interface RendererOptions {
	concurrency?: number;
	cacheBytes?: number;
}

function isCoarse(): boolean {
	try {
		return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	} catch {
		return false;
	}
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): Canvas {
	if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
	const c = document.createElement('canvas');
	c.width = width;
	c.height = height;
	return c;
}

async function canvasToBitmap(canvas: Canvas): Promise<ImageBitmap> {
	if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
		return canvas.transferToImageBitmap();
	}
	return createImageBitmap(canvas as HTMLCanvasElement);
}

export function createRenderer(options: RendererOptions = {}): Renderer {
	const mobile = isCoarse();
	const queue = new RenderQueue(options.concurrency ?? (mobile ? 2 : 4));
	const cache = new ByteLru<ImageBitmap>({
		maxBytes: options.cacheBytes ?? (mobile ? 64 : 256) * 1024 * 1024,
		onEvict: (bmp) => bmp.close()
	});
	const docs = new Map<SourceId, Promise<OpenDoc>>();
	/** Bumped by release() so in-flight renders for a removed source do not repopulate the cache. */
	const generations = new Map<SourceId, number>();
	const gen = (id: SourceId) => generations.get(id) ?? 0;

	let pdfjs: Promise<PdfJs> | undefined;
	const lib = () => (pdfjs ??= import('./pdfjs-loader').then((m) => m.loadPdfJs()));

	function openDoc(source: Source): Promise<OpenDoc> {
		let p = docs.get(source.id);
		if (!p) {
			p = (async () => {
				const [pdf, loader] = await Promise.all([lib(), import('./pdfjs-loader')]);
				// PDF.js transfers the buffer to its worker, which would detach Source.bytes.
				const data = source.bytes.slice();
				const task = pdf.getDocument({ data, ...loader.documentAssetOptions });
				return { task, doc: await task.promise };
			})();
			docs.set(source.id, p);
			p.catch(() => {
				if (docs.get(source.id) === p) docs.delete(source.id);
			});
		}
		return p;
	}

	const keyPrefix = (id: SourceId) => `${id}\u0000`;
	const cacheKey = (id: SourceId, page: number, width: number, rot: Rotation) =>
		`${keyPrefix(id)}${page}\u0000${width}\u0000${rot}`;

	async function renderMaster(req: RenderRequest, width: number, signal: AbortSignal): Promise<ImageBitmap> {
		const { source, pageIndex, rotation } = req;
		const size0 = source.pages[pageIndex];
		if (!size0) throw new RangeError(`Page ${pageIndex} out of range for ${source.name}`);
		const { doc } = await openDoc(source);
		if (signal.aborted) throw abortError();
		const page = await doc.getPage(pageIndex + 1);
		let canvas: Canvas | undefined;
		try {
			if (signal.aborted) throw abortError();
			const size = computeRenderSize(size0.width, size0.height, rotation, width);
			const viewport = page.getViewport({ scale: size.scale, rotation: (page.rotate + rotation) % 360 });
			canvas = makeCanvas(size.width, size.height);
			const ctx = canvas.getContext('2d', { alpha: false }) as
				| CanvasRenderingContext2D
				| OffscreenCanvasRenderingContext2D
				| null;
			if (!ctx) throw new Error('Could not create a 2D canvas context');
			const task = page.render({
				canvas: canvas as HTMLCanvasElement,
				canvasContext: ctx as CanvasRenderingContext2D,
				viewport,
				background: '#ffffff'
			});
			const onAbort = () => task.cancel();
			signal.addEventListener('abort', onAbort);
			try {
				await task.promise;
			} catch (e) {
				if (signal.aborted || (e as Error)?.name === 'RenderingCancelledException') throw abortError();
				throw e;
			} finally {
				signal.removeEventListener('abort', onAbort);
			}
			if (signal.aborted) throw abortError();
			return await canvasToBitmap(canvas);
		} finally {
			if (canvas) {
				canvas.width = 0;
				canvas.height = 0;
			}
			page.cleanup();
		}
	}

	return {
		async render(req) {
			if (req.signal?.aborted) throw abortError();
			const { source, pageIndex, rotation } = req;
			const width = bucketWidth(req.width);
			const key = cacheKey(source.id, pageIndex, width, rotation);

			const hit = cache.get(key);
			if (hit) return createImageBitmap(hit);

			const startGen = gen(source.id);
			const master = await queue.add(async (signal) => {
				// An earlier identical request may have finished while this one waited.
				const again = cache.get(key);
				if (again) return { bmp: again, fresh: false };
				return { bmp: await renderMaster(req, width, signal), fresh: true };
			}, req.signal);

			if (!master.fresh) return createImageBitmap(master.bmp);
			// Source released while rendering: hand the result over uncached.
			if (gen(source.id) !== startGen) return master.bmp;
			// Copy first: the cache closes the master at once if it is over budget.
			const copy = await createImageBitmap(master.bmp);
			cache.set(key, master.bmp, bitmapBytes(master.bmp.width, master.bmp.height));
			return copy;
		},

		release(sourceId) {
			generations.set(sourceId, gen(sourceId) + 1);
			cache.deletePrefix(keyPrefix(sourceId));
			const p = docs.get(sourceId);
			docs.delete(sourceId);
			p?.then((d) => d.task.destroy()).catch(() => {});
		}
	};
}
