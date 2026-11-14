/**
 * Exports that make more than one PDF's worth of output: pages as pictures, and a split
 * into several files. Both stand on Engine.exportPlan, which verifies or throws:
 *
 * - Pictures: one ordinary export (the verified PDF, in memory, without password or
 *   compression) and then its pages drawn by render/pictures.ts. Nothing is drawn from
 *   the workspace's own pages, so redactions are the applied ones, and form answers,
 *   stamps, numbers and rotation are what the PDF shows.
 * - Split: one ordinary export per part, one after the other, each with the user's
 *   options. If any part fails, nothing is delivered and the error says which part.
 *
 * Progress goes through ExportProgress ('picture', 'part'); the engine's own progress
 * inside a part is passed on separately (`onStep`).
 */

import type { Asset, EngineErrorShape, ExportControl, ExportPlan, ExportProgress, ExportResult, PageId, VerifyCheck, Source } from '../core/types';
import { isEngineErrorShape } from '../engine/errors';
import { plural, tagsLine } from './logic';
import { JPEG_QUALITY, mimeOf, pictureName, ranOutMessage } from './pictures-plan';
import { partName, partPages, type Part } from './split-plan';
import { crc32, ZipWriter } from './zip';

type ExportFn = (plan: ExportPlan, sources: Source[], assets: Asset[], control?: ExportControl) => Promise<ExportResult>;

const cancelled = (): EngineErrorShape => ({ code: 'cancelled', message: 'Export cancelled. Nothing was saved.' });

export interface MultiOutput {
	blob: Blob;
	filename: string;
	/** What was verified: the PDF the pictures come from, or every part merged. */
	checks: VerifyCheck[];
	pageCount: number;
	warnings: string[];
}

export interface PicturesOutput extends MultiOutput {
	count: number;
	/** 1-based pages saved below the asked resolution. */
	reduced: { page: number; dpi: number }[];
	/** The verified PDF's result (for its checks). */
	result: ExportResult;
}

export async function exportPictures(args: {
	exportPlan: ExportFn;
	plan: ExportPlan;
	sources: Source[];
	assets: Asset[];
	base: string;
	kind: 'jpg' | 'png';
	dpi: number;
	/** Most bytes of pictures to hold (pictures-plan.ts pictureBudget). */
	budget: number;
	signal?: AbortSignal;
	onProgress?: (p: ExportProgress) => void;
	/** Tests only: another renderer entry point. */
	render?: typeof import('../render/pictures').renderPictures;
}): Promise<PicturesOutput> {
	const { signal } = args;
	const result = await args.exportPlan(args.plan, args.sources, args.assets, { signal, onProgress: args.onProgress });
	if (signal?.aborted) throw cancelled();
	const render = args.render ?? (await import('../render/pictures')).renderPictures;
	const total = result.pageCount;
	args.onProgress?.({ stage: 'picture', done: 0, total });
	const zip = new ZipWriter();
	const reduced: { page: number; dpi: number }[] = [];
	let single: Blob | null = null;
	let held = 0;
	try {
		for await (const pic of render(result.bytes, { dpi: args.dpi, type: mimeOf(args.kind), quality: JPEG_QUALITY, signal })) {
			if (pic.reduced) reduced.push({ page: pic.index + 1, dpi: pic.dpi });
			held += pic.blob.size;
			if (held > args.budget && pic.index + 1 < total) throw { code: 'too-large', message: ranOutMessage(pic.index + 1, total) } satisfies EngineErrorShape;
			if (total === 1) single = pic.blob;
			else zip.add(pictureName(args.base, pic.index, total, args.kind), { blob: pic.blob, crc: crc32(new Uint8Array(await pic.blob.arrayBuffer())) });
			args.onProgress?.({ stage: 'picture', done: pic.index + 1, total });
			// Let the page breathe (and the Cancel button be heard) between pictures.
			await new Promise((r) => setTimeout(r, 0));
		}
	} catch (e) {
		if (signal?.aborted || (e as Error)?.name === 'AbortError') throw cancelled();
		throw e;
	}
	if (signal?.aborted) throw cancelled();
	const blob = single ?? zip.finish();
	return {
		blob,
		filename: total === 1 ? `${args.base}.${args.kind}` : `${args.base}.zip`,
		count: total,
		reduced,
		result,
		checks: result.checks,
		pageCount: result.pageCount,
		warnings: result.warnings
	};
}

export interface SplitOutput extends MultiOutput {
	parts: { name: string; pages: string; bytes: number; result: ExportResult }[];
}

/**
 * Exports each part with its own plan (`plans[i]`, built by the caller from the same
 * options) and zips them. `parts` say which pages each holds (for the words).
 */
export async function exportSplit(args: {
	exportPlan: ExportFn;
	plans: ExportPlan[];
	parts: readonly Part[];
	sources: Source[];
	assets: Asset[];
	base: string;
	signal?: AbortSignal;
	onProgress?: (p: ExportProgress) => void;
	/** The engine's progress within the current part. */
	onStep?: (p: ExportProgress) => void;
}): Promise<SplitOutput> {
	const { signal, plans } = args;
	const total = plans.length;
	const done: SplitOutput['parts'] = [];
	for (let i = 0; i < total; i++) {
		if (signal?.aborted) throw cancelled();
		args.onProgress?.({ stage: 'part', done: i, total });
		let result: ExportResult;
		try {
			result = await args.exportPlan(plans[i], args.sources, args.assets, { signal, onProgress: args.onStep });
		} catch (e) {
			if (signal?.aborted || (isEngineErrorShape(e) && e.code === 'cancelled')) throw cancelled();
			const err: EngineErrorShape = isEngineErrorShape(e) ? e : { code: 'internal', message: 'Something went wrong while building the file.' };
			throw {
				...err,
				message: `File ${i + 1} of ${total} (${partPages(args.parts[i])}) could not be made: ${err.message.replace(/\s*Nothing was saved\.?$/i, '')} No files were saved.`
			} satisfies EngineErrorShape;
		}
		done.push({ name: partName(args.base, i, total), pages: partPages(args.parts[i]), bytes: result.bytes.length, result });
	}
	if (signal?.aborted) throw cancelled();
	args.onProgress?.({ stage: 'part', done: total, total });
	const zip = new ZipWriter();
	for (const p of done) zip.add(p.name, p.result.bytes);
	const results = done.map((p) => p.result);
	return {
		blob: zip.finish(),
		filename: `${args.base}.zip`,
		parts: done,
		checks: mergeChecks(results),
		pageCount: results.reduce((n, r) => n + r.pageCount, 0),
		warnings: mergeWarnings(results)
	};
}

/** One check per kind: ok when every part passed it; the details name the parts. */
export function mergeChecks(results: readonly Pick<ExportResult, 'checks'>[]): VerifyCheck[] {
	const order: VerifyCheck['name'][] = [];
	const by = new Map<VerifyCheck['name'], { ok: boolean; details: string[] }>();
	results.forEach((r, i) => {
		for (const c of r.checks) {
			let m = by.get(c.name);
			if (!m) {
				by.set(c.name, (m = { ok: true, details: [] }));
				order.push(c.name);
			}
			m.ok &&= c.ok;
			m.details.push(`File ${i + 1}: ${c.detail}`);
		}
	});
	return order.map((name) => ({ name, ok: by.get(name)!.ok, detail: by.get(name)!.details.join(' ') }));
}

/** Warnings of all parts, each said once; a warning only some files have names them. */
export function mergeWarnings(results: readonly Pick<ExportResult, 'warnings'>[]): string[] {
	const files = new Map<string, number[]>();
	results.forEach((r, i) => {
		for (const w of r.warnings) {
			const list = files.get(w) ?? [];
			if (!list.includes(i + 1)) list.push(i + 1);
			files.set(w, list);
		}
	});
	return [...files].map(([w, list]) =>
		list.length === results.length ? w : `${list.length === 1 ? `File ${list[0]}` : `Files ${list.join(', ')}`}: ${w}`
	);
}

/** Lines about the parts' sizes for the result view (size targets, pictures capped). */
export function splitNotes(out: Pick<SplitOutput, 'parts'>): string[] {
	const notes: string[] = [];
	const shrink = out.parts.filter((p) => p.result.shrink);
	if (shrink.length) {
		const missed = shrink.filter((p) => !p.result.shrink!.reached);
		const target = shrink[0].result.shrink!.targetBytes;
		const mb = `${+(target / 1024 / 1024).toFixed(1)} MB`;
		notes.push(
			missed.length === 0
				? `Every file fits under ${mb}.`
				: `${missed.length === 1 ? `File ${out.parts.indexOf(missed[0]) + 1} is` : `${missed.length} files are`} still over ${mb}: that is the smallest they can get without damaging text.`
		);
	}
	const capped = out.parts.reduce((n, p) => n + (p.result.printCap?.images ?? 0), 0);
	if (capped) notes.push(`${plural(capped, 'oversized picture')} brought down to 300 dpi.`);
	const ocr = out.parts.reduce((n, p) => n + (p.result.ocr?.searchable.length ?? 0), 0);
	if (out.parts.some((p) => p.result.ocr)) notes.push(`${plural(ocr, 'scanned page')} made searchable.`);
	// Accessibility tags not kept: one line per reason, naming the files when not all of them.
	const tagged = out.parts.filter((p) => p.result.tags);
	const lines = new Map<string, number[]>();
	out.parts.forEach((p, i) => {
		const line = tagsLine(p.result);
		if (line) lines.set(line, [...(lines.get(line) ?? []), i + 1]);
	});
	for (const [line, files] of lines) {
		notes.push(files.length === tagged.length ? line : `${files.length === 1 ? `File ${files[0]}` : `Files ${files.join(', ')}`}: ${line}`);
	}
	return notes;
}

/** Page ids of each part, from the export's pages. */
export function partIds(pages: readonly { id: PageId }[], parts: readonly Part[]): PageId[][] {
	return parts.map((p) => p.map((i) => pages[i].id));
}
