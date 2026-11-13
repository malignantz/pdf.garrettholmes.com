/**
 * "Reduce oversized pictures" (ExportOptions.printCap) in the export dialog: when it is
 * offered and what it says. The engine decides which pictures qualify
 * (Engine.oversizedPictures, asked once per source, only a hint) and reports what it
 * changed (ExportResult.printCap); this file only words it.
 */
import type { Engine, ExportProgress, ExportResult, PageRef, Source, SourceId } from '../core/types';
import { formatBytes, plural } from './logic';

export const PRINT_CAP_LABEL = 'Reduce oversized pictures';

export function printCapHint(count: number): string {
	return count === 1
		? 'One picture holds more detail than a printer can use. It is brought down to 300 dpi; text stays sharp.'
		: `${count} pictures hold more detail than a printer can use. They are brought down to 300 dpi; text stays sharp.`;
}

/** Oversized pictures per source (each with the pages it is drawn on), asked once per source. */
const asked = new Map<SourceId, Promise<number[][]>>();

export function oversizedOf(engine: Pick<Engine, 'oversizedPictures'>, source: Source): Promise<number[][]> {
	let p = asked.get(source.id);
	if (!p) {
		p = source.kind === 'blank' ? Promise.resolve([]) : engine.oversizedPictures(source).catch(() => []);
		asked.set(source.id, p);
	}
	return p;
}

/** Oversized pictures drawn on at least one of `pages` (a picture used on several pages counts once). */
export async function countOversized(
	engine: Pick<Engine, 'oversizedPictures'>,
	pages: readonly PageRef[],
	sources: readonly Source[]
): Promise<number> {
	const byId = new Map(sources.map((s) => [s.id, s]));
	const used = new Map<SourceId, Set<number>>();
	for (const p of pages) {
		let set = used.get(p.sourceId);
		if (!set) used.set(p.sourceId, (set = new Set()));
		set.add(p.pageIndex);
	}
	let n = 0;
	for (const [id, set] of used) {
		const s = byId.get(id);
		if (!s) continue;
		for (const pics of await oversizedOf(engine, s)) if (pics.some((i) => set.has(i))) n++;
	}
	return n;
}

export function printCapProgressText(p: ExportProgress | null): string | null {
	if (!p || p.stage !== 'pictures' || p.done >= p.total) return null;
	return `Reducing picture ${p.done + 1} of ${p.total}`;
}

/** The result line after export, or null when no picture changed. */
export function printCapLine(r: Pick<ExportResult, 'printCap'>): string | null {
	const c = r.printCap;
	if (!c || c.images === 0) return null;
	return `${plural(c.images, 'picture')} reduced to ${c.ppi} dpi, ${formatBytes(Math.max(0, c.savedBytes))} saved.`;
}
