/**
 * "Make scanned pages black and white" in the export dialog (ExportOptions.bilevel): when
 * it is offered, its preview and what it says afterwards. The engine decides which pages
 * could qualify (Engine.bilevelPages, asked once per source, a cheap structural pass), shows
 * one page before and after (Engine.bilevelPreview) and reports what it did at export
 * (ExportResult.bilevel); this file only asks and words it.
 */
import type { BilevelReport, Engine, ExportProgress, PageRef, Source, SourceId } from '../core/types';
import { plural } from './logic';

export const BILEVEL_LABEL = 'Make scanned pages black and white';
export const BILEVEL_HINT = 'Much smaller files for printed pages. They will look like a photocopy: sharp black and white, no grey. Pages with colour, photos or faint marks are left as they are.';
/** The collapsed "More options" button's name for it (logic.ts moreOptionsOn). */
export const BILEVEL_SHORT = 'Black and white';

/** Pages that could qualify, per source, asked once per source (sources never change once opened). */
const asked = new Map<SourceId, Promise<number[]>>();

export function bilevelPagesOf(engine: Pick<Engine, 'bilevelPages'>, source: Source): Promise<number[]> {
	let p = asked.get(source.id);
	if (!p) {
		p = source.kind === 'pdf' ? engine.bilevelPages(source).catch(() => []) : Promise.resolve([]);
		asked.set(source.id, p);
	}
	return p;
}

/**
 * The pages of the job that could be made black and white, in order (pages with a
 * redaction box are left as they are, so they do not count).
 */
export async function bilevelCandidates(engine: Pick<Engine, 'bilevelPages'>, pages: readonly PageRef[], sources: readonly Source[]): Promise<PageRef[]> {
	const byId = new Map(sources.map((s) => [s.id, s]));
	const sets = new Map<SourceId, Set<number>>();
	for (const id of new Set(pages.map((p) => p.sourceId))) {
		const s = byId.get(id);
		if (s?.kind === 'pdf') sets.set(id, new Set(await bilevelPagesOf(engine, s)));
	}
	return pages.filter((p) => !p.stamps.some((s) => s.kind === 'redact') && sets.get(p.sourceId)?.has(p.pageIndex));
}

export interface PreviewImages {
	before: string;
	after: string;
	width: number;
	height: number;
}

/** Previews already made, by source and page (the answer never changes). */
const previews = new Map<string, Promise<PreviewImages | null>>();

/** How many candidate pages the preview tries before giving up (each is a full judgement of one picture). */
export const PREVIEW_TRIES = 3;

/**
 * The before/after crop of the first candidate page that will convert (of the first
 * PREVIEW_TRIES), as object URLs; null when none of them would. Cached per page.
 */
export async function firstPreview(engine: Pick<Engine, 'bilevelPreview'>, candidates: readonly PageRef[], sources: readonly Source[]): Promise<PreviewImages | null> {
	const byId = new Map(sources.map((s) => [s.id, s]));
	const seen = new Set<string>();
	let tries = 0;
	for (const ref of candidates) {
		const key = `${ref.sourceId}:${ref.pageIndex}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (tries++ >= PREVIEW_TRIES) break;
		const source = byId.get(ref.sourceId);
		if (!source) continue;
		let p = previews.get(key);
		if (!p) {
			p = engine
				.bilevelPreview(source, ref.pageIndex)
				.then((r) => {
					if (!r) return null;
					const url = (b: Uint8Array) => URL.createObjectURL(new Blob([b as BlobPart], { type: 'image/png' }));
					return { before: url(r.before), after: url(r.after), width: r.width, height: r.height };
				})
				.catch(() => null);
			previews.set(key, p);
		}
		const r = await p;
		if (r) return r;
	}
	return null;
}

export function bilevelProgressText(p: ExportProgress | null): string | null {
	if (!p || p.stage !== 'bilevel' || p.done >= p.total) return null;
	return p.total === 1 ? 'Making the scanned page black and white' : `Making page ${p.done + 1} of ${p.total} black and white`;
}

/** The result lines after export ([] when the option was off or no page could qualify). */
export function bilevelSummary(r: BilevelReport | undefined): string[] {
	if (!r || r.eligible === 0) return [];
	const made = r.converted.length;
	const left = r.left.length;
	const why = 'because they have colour, photos or faint marks';
	if (made === 0) {
		return [left === 1 ? 'No page was made black and white: the scanned page has colour, photos or faint marks, so it was left as it was.' : `No pages were made black and white: the scanned pages have colour, photos or faint marks, so they were left as they were.`];
	}
	const lines = [`${plural(made, 'page')} made black and white.`];
	if (left) lines.push(left === 1 ? `1 page was left as it was ${why.replace('they have', 'it has')}.` : `${left} pages were left as they were ${why}.`);
	return lines;
}
