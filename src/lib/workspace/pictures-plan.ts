/**
 * "Save pages as pictures" in the export dialog: choices, file names, the memory check
 * before starting, and the words of the result. Pure; the export is multi-export.ts and
 * the drawing render/pictures.ts.
 */

import type { ExportOptions, PageRef, Rotation, Source } from '../core/types';
import { pictureSize } from '../render/sizing';
import { formatBytes, plural } from './logic';

export type OutputKind = 'pdf' | 'jpg' | 'png';
export type PictureQuality = 'screen' | 'print';

export const OUTPUT_CHOICES: readonly { value: OutputKind; label: string }[] = [
	{ value: 'pdf', label: 'PDF' },
	{ value: 'jpg', label: 'JPG pictures' },
	{ value: 'png', label: 'PNG pictures' }
];

export const QUALITY_CHOICES: readonly { value: PictureQuality; label: string; dpi: number }[] = [
	{ value: 'screen', label: 'Screen (150 dpi)', dpi: 150 },
	{ value: 'print', label: 'Print (300 dpi)', dpi: 300 }
];

export const JPEG_QUALITY = 0.9;

export function qualityDpi(q: PictureQuality): number {
	return QUALITY_CHOICES.find((c) => c.value === q)?.dpi ?? 150;
}

export const mimeOf = (kind: 'jpg' | 'png') => (kind === 'jpg' ? 'image/jpeg' : 'image/png');

/** "report-001.jpg" … in page order (at least three digits, more past 999 pages). */
export function pictureName(base: string, index: number, count: number, kind: 'jpg' | 'png'): string {
	return `${base}-${String(index + 1).padStart(Math.max(3, String(count).length), '0')}.${kind}`;
}

/**
 * Encoded bytes per pixel used for the estimate before starting. Measured on the
 * corpus and generated pages at 150 dpi (plan, "Pictures and split export"): text pages
 * come out far smaller; photo and scan pages are near these figures.
 */
export const BYTES_PER_PIXEL = { jpg: 0.35, png: 1.2 } as const;

/**
 * How much of the finished pictures this device may hold at once (they wait in memory
 * until the zip is made). An eighth of the device's memory, from 256 MB to 1.5 GB;
 * where the browser does not say (Safari, Firefox), 3 GB is assumed for phones and
 * tablets and 8 GB otherwise.
 */
export function pictureBudget(env: { deviceMemoryGB?: number; coarse: boolean }): number {
	const gb = env.deviceMemoryGB && env.deviceMemoryGB > 0 ? env.deviceMemoryGB : env.coarse ? 3 : 8;
	return Math.round(Math.min(1.5 * 1024 ** 3, Math.max(256 * 1024 ** 2, (gb * 1024 ** 3) / 8)));
}

export function deviceBudget(): number {
	const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
	let coarse = false;
	try {
		coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	} catch {
		// No media queries: a desktop is assumed.
	}
	return pictureBudget({ deviceMemoryGB: nav?.deviceMemory, coarse });
}

/** Page sizes of the export as they will come out (user rotation applied), in points. */
function outputSize(p: Pick<PageRef, 'sourceId' | 'pageIndex' | 'rotation'>, byId: Map<string, Source>): { w: number; h: number } {
	const s = byId.get(p.sourceId)?.pages[p.pageIndex] ?? { width: 612, height: 792 };
	const swap = (p.rotation as Rotation) % 180 !== 0;
	return swap ? { w: s.height, h: s.width } : { w: s.width, h: s.height };
}

export interface PictureEstimate {
	pixels: number;
	/** Estimated bytes of all pictures. */
	bytes: number;
	/** Pages whose resolution will be lowered to stay within the per-picture cap. */
	reduced: number;
	/** Most pages of this kind the budget allows (at least 1). */
	fit: number;
}

export function estimatePictures(
	pages: readonly Pick<PageRef, 'sourceId' | 'pageIndex' | 'rotation'>[],
	sources: readonly Source[],
	kind: 'jpg' | 'png',
	dpi: number,
	budget: number
): PictureEstimate {
	const byId = new Map(sources.map((s) => [s.id, s]));
	let pixels = 0;
	let reduced = 0;
	for (const p of pages) {
		const o = outputSize(p, byId);
		const size = pictureSize(o.w, o.h, dpi);
		pixels += size.width * size.height;
		if (size.reduced) reduced++;
	}
	const bytes = pixels * BYTES_PER_PIXEL[kind];
	const perPage = pages.length ? bytes / pages.length : 0;
	return { pixels, bytes, reduced, fit: Math.max(1, perPage > 0 ? Math.floor(budget / perPage) : pages.length) };
}

/** The sentence that stops the export before it starts, or null when it fits. */
export function tooManyPictures(count: number, est: PictureEstimate, budget: number, kind: 'jpg' | 'png', dpi: number): string | null {
	if (est.bytes <= budget) return null;
	const lower = dpi > 150 ? ' or choose Screen quality' : kind === 'png' ? ' or choose JPG' : '';
	const need = est.bytes >= 1024 ** 3 ? `${(est.bytes / 1024 ** 3).toFixed(1)} GB` : formatBytes(est.bytes);
	return `${plural(count, 'picture')} at this quality would need about ${need}, more than this device can hold at once. Save up to ${est.fit} pages at a time${lower}.`;
}

/** The same, when the pictures turn out bigger than estimated while saving. */
export function ranOutMessage(done: number, total: number): string {
	return `Stopped after ${done} of ${total} pictures: they need more memory than this device can hold at once. Nothing was saved. Save about ${Math.max(1, Math.floor(done * 0.8))} pages at a time.`;
}

/** "12 pictures in one zip, 3.4 MB" / "1 picture, 420 KB". */
export function picturesLine(count: number, bytes: number): string {
	return count === 1 ? `1 picture, ${formatBytes(bytes)}` : `${count} pictures in one zip, ${formatBytes(bytes)}`;
}

/** The note about pages drawn at a lower resolution than asked, or null. */
export function reducedLine(reduced: readonly { page: number; dpi: number }[], dpi: number): string | null {
	if (reduced.length === 0) return null;
	if (reduced.length === 1) {
		const r = reduced[0];
		return `Page ${r.page} is very large, so it was saved at ${Math.round(r.dpi)} dpi instead of ${dpi} to stay within what this device can draw.`;
	}
	const low = Math.round(Math.min(...reduced.map((r) => r.dpi)));
	const pages = reduced.length <= 5 ? `Pages ${reduced.map((r) => r.page).join(', ')} are` : `${reduced.length} pages are`;
	return `${pages} very large, so they were saved at a lower resolution (down to ${low} dpi) instead of ${dpi} to stay within what this device can draw.`;
}

/**
 * The options of the PDF the pictures are drawn from: what changes how pages look
 * (page numbers; forms locked and metadata removed as the PDF export would, which
 * redaction forces), nothing that only matters to a PDF file (password, Optimize, size
 * target, searchable text, editable blanks, picture reduction).
 */
export function pictureExportOptions(o: ExportOptions): ExportOptions {
	const out: ExportOptions = { filename: o.filename, compress: false, stripMetadata: o.stripMetadata };
	if (o.flattenForms) out.flattenForms = true;
	if (o.numbering) out.numbering = o.numbering;
	if (o.watermark) out.watermark = o.watermark;
	return out;
}
