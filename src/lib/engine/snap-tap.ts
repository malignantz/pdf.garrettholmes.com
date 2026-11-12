/**
 * Snap on tap, engine side: reads one page's blanks for the editor's Text and Check
 * tools on flat forms (decision and placement: editor/snap.ts; the method and the
 * numbers: the plan, "Snap on tap (built)").
 *
 * Runs in the engine worker, lazily (the editor asks when the Text or Check tool is
 * armed on a page), and never fails for an odd page: it declines instead ("avoid,
 * don't fail"), and the editor places text as it always did. Declined: a scan or a
 * page with more than the detector's path budget (forms-detect `declines`), page
 * content over MAX_SNAP_CONTENT_BYTES (checked before reading it), reading that
 * took longer than MAX_SNAP_MS, or a MuPDF page size that differs from the
 * source's page size (CropBox oddities: the coordinates would not line up).
 */
import type * as MU from 'mupdf';
import type { PageBlanks, Source } from '../core/types';
import type { EngineDeps } from './deps';
import { collectInk, declines, type PageInk } from './forms-detect';
import { cueInk, type CueInk } from './forms-cue';
import { prepareSnap, type SnapPage } from './forms-snap';
import { isRetired, rethrowFault, type Mupdf } from './mupdf';
import { EngineError } from './errors';

/** What editor/snap.ts reads: the snap candidates and page geometry, and the ink of visible cues. */
export interface TapData {
	snap: SnapPage;
	cue: CueInk;
}

/**
 * Decoded drawing instructions (page content plus its forms and patterns) above
 * which a page is not read. The detector's survey pages (1,733 form pages) read in
 * at most 0.6 s in Node; a page this size is a map or a drawing, not a form.
 */
export const MAX_SNAP_CONTENT_BYTES = 4 * 1024 * 1024;
/** Reading slower than this (collecting ink and preparing): the page is declined, so a slow device never snaps on a page it struggles with. */
export const MAX_SNAP_MS = 2000;
/** Page sizes (MuPDF and the source) must agree within this many points. */
const SIZE_TOLERANCE = 1;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Snap data from collected ink (pure; the measurement in tools/forms-snap/ calls this too). */
export function tapData(ink: PageInk): TapData | null {
	if (declines(ink)) return null;
	return { snap: prepareSnap(ink), cue: cueInk(ink) };
}

const declined = (width: number, height: number): PageBlanks => ({ width, height, declined: true, data: null });

export async function pageBlanks(deps: EngineDeps, source: Source, pageIndex: number): Promise<PageBlanks> {
	const size = source.pages[pageIndex];
	if (!size) throw new EngineError('internal', 'That page is not in the file.');
	if (source.kind !== 'pdf') return declined(size.width, size.height);
	const m = await deps.mupdf();
	const t0 = now();
	let doc: MU.PDFDocument | null = null;
	let page: MU.PDFPage | null = null;
	let out: PageBlanks;
	try {
		doc = new m.PDFDocument(source.bytes);
		if (doc.needsPassword() || pageIndex >= doc.countPages() || contentBytes(doc, pageIndex) > MAX_SNAP_CONTENT_BYTES) {
			out = declined(size.width, size.height);
		} else {
			page = doc.loadPage(pageIndex);
			const ink = collectInk(m as Mupdf, page);
			const sameSize = Math.abs(ink.width - size.width) <= SIZE_TOLERANCE && Math.abs(ink.height - size.height) <= SIZE_TOLERANCE;
			const data = sameSize ? tapData(ink) : null;
			out = data && now() - t0 <= MAX_SNAP_MS ? { width: size.width, height: size.height, declined: false, data } : declined(size.width, size.height);
		}
	} catch (e) {
		rethrowFault(e);
		out = declined(size.width, size.height);
	} finally {
		destroy(page);
		destroy(doc);
	}
	if (isRetired(m)) throw new EngineError('internal', 'The PDF engine had to restart. Try again.');
	return out;
}

/** Decoded size of a page's content streams and the form XObjects and patterns it uses, stopping once over the budget. */
function contentBytes(doc: MU.PDFDocument, pageIndex: number): number {
	const pageObj = doc.findPage(pageIndex);
	let total = 0;
	const seen = new Set<number>();
	const add = (ref: MU.PDFObject): boolean => {
		if (total > MAX_SNAP_CONTENT_BYTES || !ref.isStream()) return false;
		if (ref.isIndirect()) {
			if (seen.has(ref.asIndirect())) return false;
			seen.add(ref.asIndirect());
		}
		const buf = ref.readStream();
		try {
			total += buf.getLength();
		} finally {
			destroy(buf);
		}
		return true;
	};
	const walk = (res: MU.PDFObject, depth: number) => {
		if (res.isNull() || depth > 20 || total > MAX_SNAP_CONTENT_BYTES) return;
		const r = res.resolve();
		if (!r.isDictionary()) return;
		for (const kind of ['XObject', 'Pattern']) {
			const dict = r.get(kind);
			if (dict.isNull() || !dict.resolve().isDictionary()) continue;
			dict.resolve().forEach((v) => {
				const sub = v.get('Subtype');
				if (kind === 'XObject' && (!sub.isName() || sub.asName() !== 'Form')) return;
				if (add(v)) walk(v.get('Resources'), depth + 1);
			});
		}
	};
	const contents = pageObj.get('Contents');
	if (contents.isArray()) {
		const a = contents.resolve();
		for (let i = 0; i < a.length; i++) add(a.get(i));
	} else add(contents);
	walk(pageObj.getInheritable('Resources'), 0);
	return total;
}

function destroy(o: unknown) {
	try {
		(o as { destroy?: () => void } | null)?.destroy?.();
	} catch (e) {
		rethrowFault(e);
	}
}
