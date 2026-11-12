/**
 * Snap on tap, editor glue: asks the engine worker for a page's blanks when the Text
 * or Check tool is armed on it, keeps the answer per source page, and converts a tap
 * (page fractions) into a snapped text origin or tick box. Nothing here waits: a tap
 * before the answer arrives, or on a page that does not qualify, gets null and the
 * editor places as it always did. The decision itself is snap.ts (loaded with the
 * first request, like the detector it needs).
 *
 * A page qualifies when it is a PDF page shown upright (no PageRef.rotation: text
 * stays upright on screen, and a rotated blank would run across it), and it has no
 * fillable form widget (a form page is filled through its fields, never snapped),
 * and its fields are known (while the form is still being read: no snap).
 */
import type { Engine, FormField, PageBlanks, PageRef, Source, StampBlank, StampBox } from '../core/types';
import type { TapData } from '../engine/snap-tap';
import type * as Snap from './snap';

type Entry = { state: 'pending' } | { state: 'done'; blanks: PageBlanks } | { state: 'failed' };

/** Pages kept (most recent first); a page's data is tens to hundreds of KB. */
const MAX_PAGES = 24;
const cache = new Map<string, Entry>();
let snap: typeof Snap | null = null;
let loading: Promise<typeof Snap> | null = null;

const key = (sourceId: string, pageIndex: number) => `${sourceId}#${pageIndex}`;

/** Whether snapping may happen on this page at all. `fields`: the source's form fields, undefined while unknown. */
export function snapEligible(source: Source | undefined, ref: PageRef | undefined, fields: readonly FormField[] | undefined): boolean {
	if (!source || !ref || source.kind !== 'pdf' || ref.rotation !== 0) return false;
	if (!fields) return false;
	return !fields.some((f) => f.widgets.some((w) => w.pageIndex === ref.pageIndex));
}

/** Start reading a page's blanks (once; later calls are no-ops). Never throws; a failure means no snapping there. */
export function requestBlanks(engine: Pick<Engine, 'pageBlanks'>, source: Source, pageIndex: number): void {
	const k = key(source.id, pageIndex);
	if (cache.has(k)) return;
	cache.set(k, { state: 'pending' });
	while (cache.size > MAX_PAGES) cache.delete(cache.keys().next().value!);
	loading ??= import('./snap').then((m) => (snap = m));
	Promise.all([engine.pageBlanks(source, pageIndex), loading]).then(
		([blanks]) => {
			if (cache.has(k)) cache.set(k, { state: 'done', blanks });
		},
		() => {
			if (cache.has(k)) cache.set(k, { state: 'failed' });
		}
	);
}

/** The page's snap data, if it has arrived and the page was not declined. */
function ready(source: Source, pageIndex: number): { data: TapData; blanks: PageBlanks } | null {
	const e = cache.get(key(source.id, pageIndex));
	if (!e || e.state !== 'done' || e.blanks.declined || !e.blanks.data || !snap) return null;
	return { data: e.blanks.data as TapData, blanks: e.blanks };
}

const fraction = ([x0, y0, x1, y1]: readonly number[], W: number, H: number): StampBox => ({ x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H });

/**
 * Text stamp origin and size (page fractions, as the Text tool stores them) for a tap
 * at `f`, with the blank it snapped into (the stamp's `blank`), or null to place
 * plainly. Only for a page `snapEligible` accepted.
 */
export function snappedText(source: Source, ref: PageRef, f: { x: number; y: number }): { x: number; y: number; size: number; blank: StampBlank } | null {
	const r = ready(source, ref.pageIndex);
	if (!r || !snap) return null;
	const { width: W, height: H } = r.blanks;
	const at = snap.textAt(r.data, [f.x * W, f.y * H]);
	if (!at) return null;
	return { x: at.x / W, y: snap.lineTop(at) / H, size: at.size / H, blank: { kind: 'text', box: fraction(at.snap.rect, W, H) } };
}

/** Mark box (page fractions) for a Check tap at `f` on a drawn checkbox, with the checkbox (the stamp's `blank`), or null to place plainly. */
export function snappedTick(source: Source, ref: PageRef, f: { x: number; y: number }): { box: StampBox; blank: StampBlank } | null {
	const r = ready(source, ref.pageIndex);
	if (!r || !snap) return null;
	const { width: W, height: H } = r.blanks;
	const at = snap.tickAt(r.data, [f.x * W, f.y * H]);
	if (!at) return null;
	return { box: fraction(at.box, W, H), blank: { kind: 'check', box: fraction(at.snap.rect, W, H) } };
}

/** Tests: forget everything. */
export function resetSnapCache(): void {
	cache.clear();
}
