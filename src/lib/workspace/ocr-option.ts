/**
 * "Make scanned pages searchable" in the export dialog: when it is offered and what it
 * says. The engine decides which pages qualify (Engine.scannedPages) and reports what
 * happened (ExportResult.ocr); this file only words it.
 */
import type { Engine, ExportProgress, OcrReport, PageRef, Source, SourceId } from '../core/types';
import { plural } from './logic';

/** Most pages one export reads (the engine's OCR_CAP; checked by a test). */
export const OCR_PAGE_CAP = 20;

export const OCR_LABEL = 'Make scanned pages searchable';
export const OCR_HINT = 'Reads typed English on scanned pages so you can search and copy the text. The pages look the same.';

/**
 * Desktop only: a mouse or trackpad as the main pointer, with hover. Phones and tablets
 * used by touch report a coarse pointer and no hover, so they never see the option
 * (OCR there would take minutes; measured as a CPU-limited proxy only).
 */
export function isDesktop(): boolean {
	if (typeof matchMedia !== 'function') return false;
	return matchMedia('(pointer: fine) and (hover: hover)').matches && !matchMedia('(pointer: coarse)').matches;
}

/** Scanned pages per source, asked once per source (sources never change once opened). */
const asked = new Map<SourceId, Promise<number[]>>();

export function scannedPagesOf(engine: Pick<Engine, 'scannedPages'>, source: Source): Promise<number[]> {
	let p = asked.get(source.id);
	if (!p) {
		p = source.kind === 'pdf' ? engine.scannedPages(source).catch(() => []) : Promise.resolve([]);
		asked.set(source.id, p);
	}
	return p;
}

/** How many of `pages` the option would try (before the cap). */
export async function countScanned(engine: Pick<Engine, 'scannedPages'>, pages: readonly PageRef[], sources: readonly Source[]): Promise<number> {
	const byId = new Map(sources.map((s) => [s.id, s]));
	const sets = new Map<SourceId, Set<number>>();
	for (const id of new Set(pages.map((p) => p.sourceId))) {
		const s = byId.get(id);
		if (s?.kind === 'pdf') sets.set(id, new Set(await scannedPagesOf(engine, s)));
	}
	return pages.filter((p) => !p.stamps.some((s) => s.kind === 'redact') && sets.get(p.sourceId)?.has(p.pageIndex)).length;
}

/** Said before export when there are more scanned pages than one export reads. */
export function ocrCapNotice(scanned: number): string | null {
	return scanned > OCR_PAGE_CAP ? `This file has ${scanned} scanned pages. The first ${OCR_PAGE_CAP} will be made searchable.` : null;
}

export function ocrProgressText(p: ExportProgress | null): string | null {
	if (!p) return null;
	if (p.stage === 'ocr-load') return 'Getting the text reader ready…';
	return `Reading page ${Math.min(p.done + 1, p.total)} of ${p.total}`;
}

/** The result lines after export. */
export function ocrSummary(r: OcrReport | undefined): string[] {
	if (!r || r.eligible === 0) return [];
	const made = r.searchable.length;
	const left = r.declined.length;
	const out: string[] = [];
	if (made > 0) {
		out.push(
			`${plural(made, 'page')} made searchable.${left ? ` ${plural(left, 'page was', 'pages were')} left as ${left === 1 ? 'it was' : 'they were'} because the text could not be read well enough.` : ''}`
		);
	} else {
		out.push(`No pages were made searchable: the text could not be read well enough. ${left === 1 ? 'The page is' : 'The pages are'} unchanged.`);
	}
	if (r.eligible > r.cap) out.push(`This file has ${r.eligible} scanned pages. Only the first ${r.cap} were read.`);
	return out;
}
