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
 *
 * FORM ANSWERS
 * `RenderRequest.formValues` (field name -> FormValue, names as Engine.formFields)
 * is drawn into the widgets of a page through PDF.js annotation storage; see
 * form-values.ts for what is drawn and what is left as stored. The widgets of a
 * page are read once (`getAnnotations`) and cached. The bitmap cache key gets the
 * storage entries of that page only, so an answer invalidates just the pages
 * that show its field, and a page whose answers change nothing it shows shares
 * the plain render's entry and is drawn exactly as without answers.
 * PDF.js keeps one AnnotationStorage per document and reads it synchronously
 * inside `page.render()` (it copies the entries into a new map that is sent to
 * the worker). So each render fills the storage, calls `render()` and empties it
 * again in one synchronous block: renders with different answers never see each
 * other's values, and the storage is empty at every `await`.
 */

import type { Rotation, Renderer, RenderRequest, Source, SourceId } from '../core/types';
import { ByteLru } from './lru';
import { abortError, RenderQueue } from './queue';
import { bitmapBytes, bucketWidth, computeRenderSize } from './sizing';
import type { PdfJs } from './pdfjs-loader';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import { entriesKey, fillableWidgets, storageEntries, type FillableWidget, type StorageEntry, type WidgetAnnotation } from './form-values';

interface OpenDoc {
	lib: PdfJs;
	task: PDFDocumentLoadingTask;
	doc: PDFDocumentProxy;
}

/** PDF.js plus the getDocument() options that route its asset loads. */
export interface PdfJsHandle {
	lib: PdfJs;
	documentOptions: Record<string, unknown>;
}

export interface RendererOptions {
	concurrency?: number;
	cacheBytes?: number;
	/** Tests only: another PDF.js build (Node needs the legacy one). Default: pdfjs-loader.ts. */
	pdfjs?: () => Promise<PdfJsHandle>;
}

async function defaultPdfJs(): Promise<PdfJsHandle> {
	const loader = await import('./pdfjs-loader');
	return { lib: await loader.loadPdfJs(), documentOptions: loader.documentAssetOptions };
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

	let pdfjs: Promise<PdfJsHandle> | undefined;
	const lib = () => (pdfjs ??= (options.pdfjs ?? defaultPdfJs)());
	/** Fillable widgets per source page, keyed like the bitmap cache (`<id>\0<page>`). */
	const widgets = new Map<string, Promise<FillableWidget[]>>();

	function openDoc(source: Source): Promise<OpenDoc> {
		let p = docs.get(source.id);
		if (!p) {
			p = (async () => {
				const { lib: pdf, documentOptions } = await lib();
				// PDF.js transfers the buffer to its worker, which would detach Source.bytes.
				const data = source.bytes.slice();
				const task = pdf.getDocument({ data, ...documentOptions });
				return { lib: pdf, task, doc: await task.promise };
			})();
			docs.set(source.id, p);
			p.catch(() => {
				if (docs.get(source.id) === p) docs.delete(source.id);
			});
		}
		return p;
	}

	const keyPrefix = (id: SourceId) => `${id}\u0000`;
	const cacheKey = (id: SourceId, page: number, width: number, rot: Rotation, form: string) =>
		`${keyPrefix(id)}${page}\u0000${width}\u0000${rot}${form ? `\u0000${form}` : ''}`;

	function pageWidgets(source: Source, pageIndex: number): Promise<FillableWidget[]> {
		const key = `${keyPrefix(source.id)}${pageIndex}`;
		let p = widgets.get(key);
		if (!p) {
			p = (async () => {
				const { doc } = await openDoc(source);
				const page = await doc.getPage(pageIndex + 1);
				return fillableWidgets((await page.getAnnotations()) as WidgetAnnotation[]);
			})();
			widgets.set(key, p);
			p.catch(() => {
				if (widgets.get(key) === p) widgets.delete(key);
			});
		}
		return p;
	}

	/** Storage entries the answers give this page; [] when they change nothing it shows. */
	async function formEntries(req: RenderRequest): Promise<StorageEntry[]> {
		const values = req.formValues;
		if (!req.source.hasForm || !values || Object.keys(values).length === 0) return [];
		if (!req.source.pages[req.pageIndex]) return [];
		return storageEntries(await pageWidgets(req.source, req.pageIndex), values);
	}

	async function renderMaster(
		req: RenderRequest,
		width: number,
		entries: StorageEntry[],
		signal: AbortSignal
	): Promise<ImageBitmap> {
		const { source, pageIndex, rotation } = req;
		const size0 = source.pages[pageIndex];
		if (!size0) throw new RangeError(`Page ${pageIndex} out of range for ${source.name}`);
		const { lib: pdf, doc } = await openDoc(source);
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
			const params = {
				canvas: canvas as HTMLCanvasElement,
				canvasContext: ctx as CanvasRenderingContext2D,
				viewport,
				background: '#ffffff'
			};
			let task: ReturnType<typeof page.render>;
			if (entries.length === 0) {
				task = page.render(params);
			} else {
				// Fill, render, empty: one synchronous block (see FORM ANSWERS above).
				const storage = doc.annotationStorage;
				for (const [k] of [...storage]) storage.remove(k);
				try {
					for (const [id, value] of entries) storage.setValue(id, { ...value });
					task = page.render({ ...params, annotationMode: pdf.AnnotationMode.ENABLE_STORAGE });
				} finally {
					for (const [k] of [...storage]) storage.remove(k);
				}
			}
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
			const startGen = gen(source.id);
			const entries = await formEntries(req);
			if (req.signal?.aborted) throw abortError();
			const key = cacheKey(source.id, pageIndex, width, rotation, entriesKey(entries));

			const hit = cache.get(key);
			if (hit) return createImageBitmap(hit);

			const master = await queue.add(async (signal) => {
				// An earlier identical request may have finished while this one waited.
				const again = cache.get(key);
				if (again) return { bmp: again, fresh: false };
				return { bmp: await renderMaster(req, width, entries, signal), fresh: true };
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
			for (const k of [...widgets.keys()]) if (k.startsWith(keyPrefix(sourceId))) widgets.delete(k);
			const p = docs.get(sourceId);
			docs.delete(sourceId);
			p?.then((d) => d.task.destroy()).catch(() => {});
		}
	};
}
