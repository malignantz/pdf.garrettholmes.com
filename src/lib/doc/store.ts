/**
 * DocStore: the single source of truth for the workspace. Framework-free.
 * See ./README.md for the API reference and index semantics.
 */
import type {
	Asset,
	AssetId,
	ExportOptions,
	ExportPlan,
	FormValue,
	FormValues,
	PageId,
	PageRef,
	PageSize,
	Rotation,
	Source,
	SourceId,
	Stamp,
	StampBox
} from '../core/types';
import { newId } from './ids';

export { newId };

// ---------------------------------------------------------------- types

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
/** Type of key K in whichever members of the union T have it (optional keys included). */
type ValueOfKey<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;

/** A stamp to add; `id` is generated when omitted. */
export type NewStamp = DistributiveOmit<Stamp, 'id'> & { id?: string };

/**
 * Fields of a stamp that may change. Keys that do not belong to the stamp's
 * kind are ignored; `id` and `kind` can never change.
 */
export type StampPatch = {
	[K in Exclude<KeysOfUnion<Stamp>, 'id' | 'kind'>]?: Exclude<ValueOfKey<Stamp, K>, undefined>;
};

export interface HistoryEvent {
	kind: 'do' | 'undo' | 'redo';
	label: string;
}

/** Immutable snapshot. A new object is produced on every change. */
export interface DocState {
	/** Open sources (those that have at least one page), in the order first added. */
	readonly sources: readonly Source[];
	readonly pages: readonly PageRef[];
	readonly assets: readonly Asset[];
	/**
	 * Form answers per open source (source id -> field name -> value). Only sources in
	 * `sources` appear; a source's answers leave with its last page and come back on undo.
	 */
	readonly formValues: FormValues;
	/** Selected page ids. Not part of undo history. */
	readonly selection: ReadonlySet<PageId>;
	/** Anchor for shift-range selection, or null. */
	readonly anchor: PageId | null;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	/** Label of the step `undo()` would revert, e.g. "Rotate 3 pages". */
	readonly undoLabel: string | null;
	readonly redoLabel: string | null;
	/** The most recent do/undo/redo, for "Undid: ..." toasts. */
	readonly lastEvent: HistoryEvent | null;
	/** True when the document differs from the last `markClean()` (or the empty start). */
	readonly isDirty: boolean;
}

/** The document part of the state, as `restore` takes it. */
export interface DocSnapshot {
	readonly sources: readonly Source[];
	readonly pages: readonly PageRef[];
	readonly assets: readonly Asset[];
	readonly formValues: FormValues;
}

export interface DocStoreOptions {
	/** Max undo steps kept. Default 200. */
	maxHistory?: number;
	/** Called once per source when nothing (document, undo or redo) references it any more. */
	onSourceReleased?: (sourceId: SourceId) => void;
	/** Override id generation (tests). */
	generateId?: () => string;
}

export interface DocStore {
	readonly state: DocState;
	/** Called after every change (not on subscribe). Returns an unsubscribe function. */
	subscribe(listener: (state: DocState) => void): () => void;

	// derived
	readonly pageCount: number;
	readonly totalOriginalBytes: number;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	readonly undoLabel: string | null;
	readonly redoLabel: string | null;
	readonly isDirty: boolean;
	markClean(): void;
	sourceOf(pageId: PageId): Source | undefined;
	displayedSize(ref: PageRef): PageSize | undefined;
	toExportPlan(options: ExportOptions, ids?: Iterable<PageId>): ExportPlan;
	assetUsage(id: AssetId): number;

	// commands (each is one undo step; return value tells whether anything changed)
	addSource(source: Source, at?: number): PageId[];
	insertPages(refs: readonly PageRef[], at: number): PageId[];
	removePages(ids: Iterable<PageId>): boolean;
	movePages(ids: Iterable<PageId>, toIndex: number): boolean;
	rotatePages(ids: Iterable<PageId>, delta: number): boolean;
	duplicatePages(ids: Iterable<PageId>): PageId[];
	reversePages(ids?: Iterable<PageId>): boolean;
	sortBySource(): boolean;
	addStamp(pageId: PageId, stamp: NewStamp): string;
	updateStamp(pageId: PageId, stampId: string, patch: StampPatch): boolean;
	removeStamp(pageId: PageId, stampId: string): boolean;
	addAsset(asset: Asset): void;
	removeAsset(id: AssetId, opts?: { cascade?: boolean }): boolean;
	/**
	 * Answer one form field of an open source. One step "Fill form field"; consecutive
	 * calls for the same field merge into that step. Throws on an unknown source.
	 */
	setFormValue(sourceId: SourceId, fieldName: string, value: FormValue): boolean;
	/** Drop every answer typed into one source's form. One step "Clear form answers". */
	clearFormValues(sourceId: SourceId): boolean;
	clear(): boolean;
	/** Drop everything including history; releases all sources. Not undoable. */
	reset(): void;
	/**
	 * Replace everything with a saved document ("pick up where you left off"). History
	 * is cleared and the step is not undoable. Validated like the commands (sources,
	 * page refs, stamps, assets, form answers); on any problem it throws and the store
	 * is unchanged. `clean`: the saved document had been exported (isDirty false).
	 */
	restore(snapshot: DocSnapshot, opts?: { clean?: boolean }): void;

	// selection
	select(id: PageId): void;
	toggle(id: PageId): void;
	selectRange(toId: PageId, opts?: { additive?: boolean }): void;
	selectAll(): void;
	setSelection(ids: Iterable<PageId>): void;
	clearSelection(): void;

	// history
	undo(): boolean;
	redo(): boolean;
	transaction<T>(label: string, fn: () => T): T;
	beginGesture(label: string): void;
	commitGesture(): void;
	cancelGesture(): void;
	readonly gestureActive: boolean;
	/**
	 * Opaque identity of the step `undo()` / `redo()` would revert next (null when
	 * none). Save them to scope history to a session, e.g. the page editor: undo
	 * is in scope while `undoToken` differs from the one saved at the start.
	 */
	readonly undoToken: object | null;
	readonly redoToken: object | null;
}

// ---------------------------------------------------------------- internals

interface Doc {
	readonly sources: readonly Source[];
	readonly pages: readonly PageRef[];
	readonly assets: readonly Asset[];
	readonly formValues: FormValues;
}

interface Entry {
	label: string;
	before: Doc;
	after: Doc;
	selBefore: ReadonlySet<PageId>;
	selAfter: ReadonlySet<PageId>;
}

const EMPTY_VALUES: FormValues = Object.freeze({});
const EMPTY_DOC: Doc = Object.freeze({ sources: [], pages: [], assets: [], formValues: EMPTY_VALUES });

const HIGHLIGHT_COLORS = ['yellow', 'green', 'pink'];

function isFormValue(v: unknown): v is FormValue {
	return typeof v === 'string' || typeof v === 'boolean' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

function copyValue(v: FormValue): FormValue {
	return Array.isArray(v) ? Object.freeze([...v]) as string[] : v;
}
const EMPTY_SET: ReadonlySet<PageId> = new Set();

function plural(n: number, one: string, many: string): string {
	return n === 1 ? one : `${n} ${many}`;
}
const pagesLabel = (verb: string, n: number) => `${verb} ${plural(n, 'page', 'pages')}`;

function cloneStamp(s: Stamp, id: string): Stamp {
	if ((s.kind === 'text' || s.kind === 'mark') && s.blank) {
		const blank = { kind: s.blank.kind, box: { ...s.blank.box } };
		return s.kind === 'text' ? { ...s, id, blank } : { ...s, id, box: { ...s.box }, blank };
	}
	if (s.kind === 'highlight' && (s.pen || s.rects)) {
		const c: Stamp = { ...s, id, box: { ...s.box } };
		if (s.pen) c.pen = { width: s.pen.width, points: s.pen.points.map((p) => ({ x: p.x, y: p.y })) };
		if (s.rects) c.rects = s.rects.map((r) => ({ ...r }));
		return c;
	}
	return 'box' in s ? { ...s, id, box: { ...s.box } } : { ...s, id };
}

/**
 * Snap on tap's link from a stamp to the blank it was snapped into (Stamp `blank`).
 * The link says "this text (or tick) is the answer for that blank"; it is dropped as
 * soon as that is in doubt:
 * - text: x, y or size changes (moved, nudged, resized, kept inside the page), or the
 *   text gets a line break while the blank is under two lines tall (TALL_BLANK_PT);
 * - mark: box or mark changes;
 * - the page is rotated (stamps keep their place on the displayed page, so they no
 *   longer sit on the blank);
 * - copies made by the editor (duplicate, copy to pages) never carry it.
 * Editing the text itself and changing its colour keep it. Undo brings it back.
 */
const TEXT_GEOMETRY = ['x', 'y', 'size'];
const MARK_GEOMETRY = ['box', 'mark'];
/** A blank this tall holds two lines of 11 pt text (editor/snap.ts TALL). */
export const TALL_BLANK_PT = 2 * 1.2 * 11;

function withoutBlank(s: Stamp): Stamp {
	if ((s.kind !== 'text' && s.kind !== 'mark') || !s.blank) return s;
	const { blank: _blank, ...rest } = s;
	return rest as Stamp;
}

/** A link to a blank: the right kind for the stamp and a box with a positive size on the page. */
function checkBlank(s: Stamp): void {
	if (s.kind !== 'text' && s.kind !== 'mark') {
		if ('blank' in s) throw new Error('DocStore: only text and ticks can be linked to a blank');
		return;
	}
	if (s.blank === undefined) return;
	const b = s.blank as { kind?: unknown; box?: StampBox } | null;
	const want = s.kind === 'text' ? 'text' : s.mark === 'check' ? 'check' : null;
	if (!b || typeof b !== 'object' || b.kind !== want) throw new Error('DocStore: a stamp linked to the wrong kind of blank');
	const r = b.box;
	const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
	const eps = 1e-6;
	if (!r || !fin(r.x) || !fin(r.y) || !fin(r.w) || !fin(r.h) || !(r.w > 0) || !(r.h > 0)) throw new Error('DocStore: bad blank rectangle');
	if (r.x < -eps || r.y < -eps || r.x + r.w > 1 + eps || r.y + r.h > 1 + eps) throw new RangeError('DocStore: blank outside the page');
}

/** Most rectangles one text highlight may hold (one per line; a full page has about 60). */
const MAX_RECTS = 1000;

/** Text highlight rectangles: 1+ finite boxes with a positive size, inside the stamp's box. */
function checkRects(rects: unknown, box: StampBox): void {
	const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
	if (!Array.isArray(rects) || rects.length < 1 || rects.length > MAX_RECTS) throw new Error('DocStore: a text highlight needs 1 or more rectangles');
	const eps = 1e-6;
	for (const r of rects as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }[]) {
		if (!r || !fin(r.x) || !fin(r.y) || !fin(r.w) || !fin(r.h) || !(r.w > 0) || !(r.h > 0)) throw new Error('DocStore: bad highlight rectangle');
		if (r.x < box.x - eps || r.y < box.y - eps || r.x + r.w > box.x + box.w + eps || r.y + r.h > box.y + box.h + eps)
			throw new RangeError('DocStore: highlight rectangle outside its box');
	}
}

/** Most points one pen stroke may hold (the editor stores tens). */
const MAX_PEN_POINTS = 2000;

/** A pen stroke: 2+ finite points on the page and inside the stamp's box, a positive width. */
function checkPen(pen: unknown, box: StampBox): void {
	const p = pen as { points?: unknown; width?: unknown } | null;
	const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
	if (!p || typeof p !== 'object' || !Array.isArray(p.points) || p.points.length < 2 || p.points.length > MAX_PEN_POINTS)
		throw new Error('DocStore: a pen highlight needs 2 or more points');
	if (!fin(p.width) || !(p.width > 0) || p.width > 0.5) throw new Error('DocStore: bad pen width');
	const eps = 1e-6;
	for (const q of p.points as { x?: unknown; y?: unknown }[]) {
		if (!q || !fin(q.x) || !fin(q.y)) throw new Error('DocStore: bad pen point');
		if (q.x < box.x - eps || q.x > box.x + box.w + eps || q.y < box.y - eps || q.y > box.y + box.h + eps)
			throw new RangeError('DocStore: pen point outside its box');
	}
}

function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	return ka.every((k) =>
		valuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
	);
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

const toSet = (ids: Iterable<string>): Set<string> => new Set(ids);

function normRotation(deg: number): Rotation {
	return (((deg % 360) + 360) % 360) as Rotation;
}

// ---------------------------------------------------------------- store

export function createDocStore(options: DocStoreOptions = {}): DocStore {
	const maxHistory = Math.max(1, options.maxHistory ?? 200);
	const gen = options.generateId ?? newId;

	let doc: Doc = EMPTY_DOC;
	let cleanDoc: Doc = EMPTY_DOC;
	let selection: ReadonlySet<PageId> = EMPTY_SET;
	let anchor: PageId | null = null;
	let undoStack: Entry[] = [];
	let redoStack: Entry[] = [];
	let lastEvent: HistoryEvent | null = null;
	/** Every source that is alive (referenced by the doc or by any history entry). */
	const registry = new Map<SourceId, Source>();
	const listeners = new Set<(s: DocState) => void>();

	let gesture: { label: string; doc: Doc; sel: ReadonlySet<PageId> } | null = null;
	/** The undo entry the last setFormValue created, and for which field, so the next edit of it can merge. */
	let fillStep: { entry: Entry; sourceId: SourceId; field: string } | null = null;
	let batchDepth = 0;
	let pendingNotify = false;

	let snap: DocState = buildSnap();

	function buildSnap(): DocState {
		const u = undoStack[undoStack.length - 1];
		const r = redoStack[redoStack.length - 1];
		return Object.freeze({
			sources: doc.sources,
			pages: doc.pages,
			assets: doc.assets,
			formValues: doc.formValues,
			selection,
			anchor,
			canUndo: !!u && !gesture,
			canRedo: !!r && !gesture,
			undoLabel: u?.label ?? null,
			redoLabel: r?.label ?? null,
			lastEvent,
			isDirty: doc !== cleanDoc
		});
	}

	function changed(): void {
		snap = buildSnap();
		if (batchDepth > 0) {
			pendingNotify = true;
			return;
		}
		for (const l of [...listeners]) l(snap);
	}

	function freshId(taken: (id: string) => boolean): string {
		for (let i = 0; i < 100; i++) {
			const id = gen();
			if (!taken(id)) return id;
		}
		throw new Error('DocStore: could not generate a unique id');
	}
	const pageIdTaken = (d: Doc) => {
		const s = new Set(d.pages.map((p) => p.id));
		return (id: string) => s.has(id);
	};

	/**
	 * Drop sources without pages (and their form answers), add back registry sources
	 * that pages need.
	 */
	function normalize(d: Doc): Doc {
		const used = new Set(d.pages.map((p) => p.sourceId));
		let sources = d.sources;
		if (sources.some((s) => !used.has(s.id))) sources = sources.filter((s) => used.has(s.id));
		const have = new Set(sources.map((s) => s.id));
		const missing = [...used].filter((id) => !have.has(id));
		if (missing.length) sources = [...sources, ...missing.map((id) => registry.get(id)!)];
		let formValues = d.formValues;
		const stale = Object.keys(formValues).filter((id) => !used.has(id));
		if (stale.length) {
			const next: FormValues = {};
			for (const [id, v] of Object.entries(formValues)) if (used.has(id)) next[id] = v;
			formValues = Object.freeze(next);
		}
		return sources === d.sources && formValues === d.formValues ? d : { ...d, sources, formValues };
	}

	/** Release sources that neither the document nor any history entry references. */
	function sweep(): void {
		const live = new Set<SourceId>();
		const add = (d: Doc) => d.sources.forEach((s) => live.add(s.id));
		add(doc);
		if (gesture) add(gesture.doc);
		for (const e of undoStack) (add(e.before), add(e.after));
		for (const e of redoStack) (add(e.before), add(e.after));
		const released = [...registry.keys()].filter((id) => !live.has(id));
		for (const id of released) registry.delete(id);
		for (const id of released) {
			try {
				options.onSourceReleased?.(id);
			} catch (err) {
				console.error('DocStore: onSourceReleased threw', err);
			}
		}
	}

	function pruneSelection(): void {
		const ids = new Set(doc.pages.map((p) => p.id));
		if ([...selection].some((id) => !ids.has(id)))
			selection = new Set([...selection].filter((x) => ids.has(x)));
		if (anchor !== null && !ids.has(anchor)) anchor = null;
	}

	function pushEntry(label: string, before: Doc, selBefore: ReadonlySet<PageId>): void {
		fillStep = null;
		redoStack = [];
		undoStack.push({ label, before, after: doc, selBefore, selAfter: selection });
		if (undoStack.length > maxHistory) undoStack.splice(0, undoStack.length - maxHistory);
		lastEvent = { kind: 'do', label };
	}

	/** Core of every command. `fn` returns the new doc, or null/same doc for a no-op. */
	function run(label: string, fn: (d: Doc) => Doc | null): boolean {
		const next = fn(doc);
		if (!next || next === doc) return false;
		const before = doc;
		const selBefore = selection;
		doc = normalize(next);
		for (const s of doc.sources) registry.set(s.id, s);
		pruneSelection();
		if (!gesture) pushEntry(label, before, selBefore);
		sweep();
		changed();
		return true;
	}

	// ---- lookups and validation

	const pageIndexById = (d: Doc, id: PageId) => d.pages.findIndex((p) => p.id === id);

	function mapPage(d: Doc, id: PageId, f: (p: PageRef) => PageRef): Doc | null {
		const i = pageIndexById(d, id);
		if (i < 0) return null;
		const np = f(d.pages[i]);
		if (np === d.pages[i]) return null;
		const pages = d.pages.slice();
		pages[i] = np;
		return { ...d, pages };
	}

	function checkRef(d: Doc, ref: PageRef): void {
		const src = d.sources.find((s) => s.id === ref.sourceId) ?? registry.get(ref.sourceId);
		if (!src) throw new Error(`DocStore: unknown source ${ref.sourceId}`);
		if (!Number.isInteger(ref.pageIndex) || ref.pageIndex < 0 || ref.pageIndex >= src.pages.length)
			throw new RangeError(`DocStore: pageIndex ${ref.pageIndex} out of range for ${src.name}`);
		if (![0, 90, 180, 270].includes(ref.rotation))
			throw new RangeError(`DocStore: invalid rotation ${ref.rotation}`);
		for (const s of ref.stamps) checkStamp(d, s);
	}

	function checkStamp(d: Doc, s: Stamp): void {
		if (s.kind === 'image' && !d.assets.some((a) => a.id === s.assetId))
			throw new Error(`DocStore: unknown asset ${s.assetId}`);
		if (s.kind === 'highlight' && !HIGHLIGHT_COLORS.includes(s.color))
			throw new Error(`DocStore: unknown highlight colour ${s.color}`);
		if (s.kind === 'highlight' && s.pen !== undefined) checkPen(s.pen, s.box);
		if (s.kind === 'highlight' && s.rects !== undefined) {
			if (s.pen !== undefined) throw new Error('DocStore: a highlight is a pen stroke or text rectangles, not both');
			checkRects(s.rects, s.box);
		}
		checkBlank(s);
	}

	function spliceIn(d: Doc, refs: PageRef[], at: number): Doc {
		const i = Math.min(Math.max(Math.trunc(at), 0), d.pages.length);
		const pages = d.pages.slice();
		pages.splice(i, 0, ...refs);
		return { ...d, pages };
	}

	// ---- commands

	function addSource(source: Source, at?: number): PageId[] {
		if (at !== undefined && Number.isNaN(at)) throw new RangeError('DocStore: bad insert index');
		if (doc.sources.some((s) => s.id === source.id))
			throw new Error(`DocStore: source ${source.id} is already open`);
		const existing = registry.get(source.id);
		if (existing && existing !== source)
			throw new Error(`DocStore: source id ${source.id} is still in use by history`);
		if (source.pages.length === 0) return [];
		const taken = pageIdTaken(doc);
		const used = new Set<string>();
		const refs: PageRef[] = source.pages.map((_, pageIndex) => {
			const id = freshId((x) => taken(x) || used.has(x));
			used.add(id);
			return { id, sourceId: source.id, pageIndex, rotation: 0, stamps: [] };
		});
		run(`Add ${source.name}`, (d) =>
			spliceIn({ ...d, sources: [...d.sources, source] }, refs, at ?? d.pages.length)
		);
		return refs.map((r) => r.id);
	}

	function insertPages(refs: readonly PageRef[], at: number): PageId[] {
		if (typeof at !== 'number' || Number.isNaN(at))
			throw new RangeError('DocStore: insert index must be a number');
		if (refs.length === 0) return [];
		const seen = new Set<string>();
		const copies = refs.map((r) => {
			if (seen.has(r.id) || doc.pages.some((p) => p.id === r.id))
				throw new Error(`DocStore: duplicate page id ${r.id}`);
			seen.add(r.id);
			checkRef(doc, r);
			return { ...r, stamps: r.stamps.map((s) => cloneStamp(s, s.id)) };
		});
		run(pagesLabel('Insert', copies.length), (d) => spliceIn(d, copies, at));
		return copies.map((r) => r.id);
	}

	function removePages(ids: Iterable<PageId>): boolean {
		const set = toSet(ids);
		const n = doc.pages.filter((p) => set.has(p.id)).length;
		if (n === 0) return false;
		return run(pagesLabel('Delete', n), (d) => ({
			...d,
			pages: d.pages.filter((p) => !set.has(p.id))
		}));
	}

	function movePages(ids: Iterable<PageId>, toIndex: number): boolean {
		if (typeof toIndex !== 'number' || Number.isNaN(toIndex))
			throw new RangeError('DocStore: move index must be a number');
		const set = toSet(ids);
		const moved = doc.pages.filter((p) => set.has(p.id));
		if (moved.length === 0) return false;
		return run(pagesLabel('Move', moved.length), (d) => {
			const to = Math.min(Math.max(Math.trunc(toIndex), 0), d.pages.length);
			let before = 0;
			for (let i = 0; i < to; i++) if (set.has(d.pages[i].id)) before++;
			const pages = d.pages.filter((p) => !set.has(p.id));
			pages.splice(to - before, 0, ...moved);
			return sameArray(pages, d.pages) ? null : { ...d, pages };
		});
	}

	function rotatePages(ids: Iterable<PageId>, delta: number): boolean {
		if (!Number.isInteger(delta) || delta % 90 !== 0)
			throw new RangeError('DocStore: rotation delta must be a multiple of 90');
		if (delta % 360 === 0) return false;
		const set = toSet(ids);
		const n = doc.pages.filter((p) => set.has(p.id)).length;
		if (n === 0) return false;
		return run(pagesLabel('Rotate', n), (d) => ({
			...d,
			pages: d.pages.map((p) =>
				// Stamps keep their place on the displayed page, so links to blanks go.
				set.has(p.id) ? { ...p, rotation: normRotation(p.rotation + delta), stamps: p.stamps.map(withoutBlank) } : p
			)
		}));
	}

	function duplicatePages(ids: Iterable<PageId>): PageId[] {
		const set = toSet(ids);
		const n = doc.pages.filter((p) => set.has(p.id)).length;
		if (n === 0) return [];
		const created: PageId[] = [];
		run(pagesLabel('Duplicate', n), (d) => {
			const taken = pageIdTaken(d);
			const used = new Set<string>();
			const fresh = () => {
				const id = freshId((x) => taken(x) || used.has(x));
				used.add(id);
				return id;
			};
			const pages: PageRef[] = [];
			for (const p of d.pages) {
				pages.push(p);
				if (set.has(p.id)) {
					const id = fresh();
					created.push(id);
					pages.push({ ...p, id, stamps: p.stamps.map((s) => cloneStamp(s, fresh())) });
				}
			}
			return { ...d, pages };
		});
		return created;
	}

	function reversePages(ids?: Iterable<PageId>): boolean {
		const set = ids === undefined ? null : toSet(ids);
		const n = set ? doc.pages.filter((p) => set.has(p.id)).length : doc.pages.length;
		return run(pagesLabel('Reverse', n), (d) => {
			const slots: number[] = [];
			d.pages.forEach((p, i) => {
				if (!set || set.has(p.id)) slots.push(i);
			});
			if (slots.length < 2) return null;
			const pages = d.pages.slice();
			const picked = slots.map((i) => d.pages[i]).reverse();
			slots.forEach((slot, k) => (pages[slot] = picked[k]));
			return sameArray(pages, d.pages) ? null : { ...d, pages };
		});
	}

	function sortBySource(): boolean {
		return run('Sort pages by file', (d) => {
			const order = new Map(d.sources.map((s, i) => [s.id, i]));
			const pages = d.pages
				.map((p, i) => [p, i] as const)
				.sort((a, b) => order.get(a[0].sourceId)! - order.get(b[0].sourceId)! || a[1] - b[1])
				.map(([p]) => p);
			return sameArray(pages, d.pages) ? null : { ...d, pages };
		});
	}

	function addStamp(pageId: PageId, stamp: NewStamp): string {
		if (pageIndexById(doc, pageId) < 0) throw new Error(`DocStore: unknown page ${pageId}`);
		const id = stamp.id ?? gen();
		if (doc.pages.some((p) => p.stamps.some((s) => s.id === id)))
			throw new Error(`DocStore: duplicate stamp id ${id}`);
		const full = cloneStamp({ ...stamp, id } as Stamp, id);
		checkStamp(doc, full);
		run('Add stamp', (d) => mapPage(d, pageId, (p) => ({ ...p, stamps: [...p.stamps, full] })));
		return id;
	}

	function updateStamp(pageId: PageId, stampId: string, patch: StampPatch): boolean {
		return run('Edit stamp', (d) =>
			mapPage(d, pageId, (p) => {
				const si = p.stamps.findIndex((s) => s.id === stampId);
				if (si < 0) return p;
				const old = p.stamps[si];
				const next: Record<string, unknown> = { ...old };
				let diff = false;
				for (const [k, v] of Object.entries(patch)) {
					if (k === 'id' || k === 'kind' || !(k in old) || v === undefined) continue;
					if (!valuesEqual((old as Record<string, unknown>)[k], v)) {
						next[k] = Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? { ...x } : x)) : v && typeof v === 'object' ? { ...v } : v;
						diff = true;
					}
				}
				if (!diff) return p;
				if (next.blank !== undefined && !('blank' in patch) && blankInDoubt(d, p, old, next)) delete next.blank;
				const ns = next as unknown as Stamp;
				checkStamp(d, ns);
				const stamps = p.stamps.slice();
				stamps[si] = ns;
				return { ...p, stamps };
			})
		);
	}

	/** Whether an edit leaves it in doubt that the stamp still belongs to its blank (see TEXT_GEOMETRY). */
	function blankInDoubt(d: Doc, p: PageRef, old: Stamp, next: Record<string, unknown>): boolean {
		const o = old as unknown as Record<string, unknown>;
		const keys = old.kind === 'text' ? TEXT_GEOMETRY : MARK_GEOMETRY;
		if (keys.some((k) => !valuesEqual(o[k], next[k]))) return true;
		if (old.kind === 'text' && /[\r\n]/.test(String(next.text))) {
			const size = registry.get(p.sourceId)?.pages[p.pageIndex] ?? d.sources.find((s) => s.id === p.sourceId)?.pages[p.pageIndex];
			if (!size) return true;
			const shownH = p.rotation === 90 || p.rotation === 270 ? size.width : size.height;
			return (next.blank as { box: StampBox }).box.h * shownH < TALL_BLANK_PT;
		}
		return false;
	}

	function removeStamp(pageId: PageId, stampId: string): boolean {
		return run('Remove stamp', (d) =>
			mapPage(d, pageId, (p) =>
				p.stamps.some((s) => s.id === stampId)
					? { ...p, stamps: p.stamps.filter((s) => s.id !== stampId) }
					: p
			)
		);
	}

	function assetUsage(id: AssetId): number {
		let n = 0;
		for (const p of doc.pages)
			for (const s of p.stamps) if (s.kind === 'image' && s.assetId === id) n++;
		return n;
	}

	function addAsset(asset: Asset): void {
		if (doc.assets.some((a) => a.id === asset.id))
			throw new Error(`DocStore: duplicate asset id ${asset.id}`);
		run(`Add ${asset.kind}`, (d) => ({ ...d, assets: [...d.assets, asset] }));
	}

	function removeAsset(id: AssetId, opts: { cascade?: boolean } = {}): boolean {
		const asset = doc.assets.find((a) => a.id === id);
		if (!asset) return false;
		const uses = assetUsage(id);
		if (uses > 0 && !opts.cascade) return false;
		const label =
			uses > 0
				? `Remove ${asset.kind} and ${plural(uses, 'stamp', 'stamps')}`
				: `Remove ${asset.kind}`;
		return run(label, (d) => ({
			...d,
			assets: d.assets.filter((a) => a.id !== id),
			pages: d.pages.map((p) =>
				p.stamps.some((s) => s.kind === 'image' && s.assetId === id)
					? { ...p, stamps: p.stamps.filter((s) => !(s.kind === 'image' && s.assetId === id)) }
					: p
			)
		}));
	}

	function setFormValue(sourceId: SourceId, fieldName: string, value: FormValue): boolean {
		if (!doc.sources.some((s) => s.id === sourceId)) throw new Error(`DocStore: unknown source ${sourceId}`);
		if (typeof fieldName !== 'string' || fieldName === '') throw new Error('DocStore: form field name must be a non-empty string');
		if (!isFormValue(value)) throw new TypeError('DocStore: a form value is a string, a boolean or a list of strings');
		const current = doc.formValues[sourceId]?.[fieldName];
		if (current !== undefined && valuesEqual(current, value)) return false;
		const top = undoStack[undoStack.length - 1];
		const merge =
			!gesture &&
			fillStep !== null &&
			fillStep.entry === top &&
			top.after === doc &&
			redoStack.length === 0 &&
			fillStep.sourceId === sourceId &&
			fillStep.field === fieldName;
		const apply = (d: Doc): Doc => ({
			...d,
			formValues: Object.freeze({
				...d.formValues,
				[sourceId]: Object.freeze({ ...d.formValues[sourceId], [fieldName]: copyValue(value) })
			})
		});
		if (merge) {
			// Same field again: extend the existing step instead of adding one.
			doc = apply(doc);
			top.after = doc;
			top.selAfter = selection;
			lastEvent = { kind: 'do', label: top.label };
			changed();
			return true;
		}
		const ok = run('Fill form field', apply);
		if (ok && !gesture) fillStep = { entry: undoStack[undoStack.length - 1], sourceId, field: fieldName };
		return ok;
	}

	function clearFormValues(sourceId: SourceId): boolean {
		return run('Clear form answers', (d) => {
			const values = d.formValues[sourceId];
			if (!values || Object.keys(values).length === 0) return null;
			const next: FormValues = { ...d.formValues };
			delete next[sourceId];
			return { ...d, formValues: Object.freeze(next) };
		});
	}

	function clear(): boolean {
		return run('Clear workspace', (d) => (d.pages.length || d.assets.length ? EMPTY_DOC : null));
	}

	function reset(): void {
		gesture = null;
		doc = EMPTY_DOC;
		cleanDoc = EMPTY_DOC;
		undoStack = [];
		redoStack = [];
		selection = EMPTY_SET;
		anchor = null;
		lastEvent = null;
		fillStep = null;
		sweep();
		changed();
	}

	function restore(snapshot: DocSnapshot, opts: { clean?: boolean } = {}): void {
		if (gesture) throw new Error('DocStore: cannot restore during a gesture');
		const sources = [...snapshot.sources];
		const srcIds = new Set<string>();
		for (const s of sources) {
			if (!s || typeof s.id !== 'string' || !s.id || srcIds.has(s.id)) throw new Error('DocStore: bad or duplicate source in a saved document');
			if (!(s.bytes instanceof Uint8Array) || !Array.isArray(s.pages) || s.pages.length === 0)
				throw new Error(`DocStore: saved source ${s.id} has no bytes or pages`);
			srcIds.add(s.id);
		}
		const assets = [...snapshot.assets];
		const assetIds = new Set<string>();
		for (const a of assets) {
			if (!a || typeof a.id !== 'string' || assetIds.has(a.id) || !(a.png instanceof Uint8Array))
				throw new Error('DocStore: bad or duplicate asset in a saved document');
			assetIds.add(a.id);
		}
		const probe: Doc = { sources, pages: [], assets, formValues: EMPTY_VALUES };
		const pageIds = new Set<string>();
		const stampIds = new Set<string>();
		const pages = snapshot.pages.map((r) => {
			if (!r || typeof r.id !== 'string' || !r.id || pageIds.has(r.id)) throw new Error('DocStore: bad or duplicate page id in a saved document');
			pageIds.add(r.id);
			if (!srcIds.has(r.sourceId)) throw new Error(`DocStore: unknown source ${r.sourceId}`);
			if (!Array.isArray(r.stamps)) throw new Error('DocStore: page stamps must be a list');
			for (const s of r.stamps) {
				if (!s || typeof s.id !== 'string' || stampIds.has(s.id)) throw new Error('DocStore: bad or duplicate stamp id in a saved document');
				stampIds.add(s.id);
			}
			const copy: PageRef = { ...r, stamps: r.stamps.map((s) => cloneStamp(s, s.id)) };
			checkRef(probe, copy);
			return copy;
		});
		const used = new Set(pages.map((p) => p.sourceId));
		if (sources.some((s) => !used.has(s.id))) throw new Error('DocStore: a saved source has no pages');
		const values: FormValues = {};
		for (const [id, fields] of Object.entries(snapshot.formValues ?? {})) {
			if (!srcIds.has(id)) throw new Error(`DocStore: form answers for unknown source ${id}`);
			const out: Record<string, FormValue> = {};
			for (const [name, v] of Object.entries(fields ?? {})) {
				if (!name || !isFormValue(v)) throw new Error('DocStore: bad form answer in a saved document');
				out[name] = copyValue(v);
			}
			if (Object.keys(out).length) values[id] = Object.freeze(out);
		}

		gesture = null;
		doc = { sources, pages, assets, formValues: Object.freeze(values) };
		cleanDoc = opts.clean ? doc : EMPTY_DOC;
		undoStack = [];
		redoStack = [];
		selection = EMPTY_SET;
		anchor = null;
		lastEvent = null;
		fillStep = null;
		sweep();
		for (const s of sources) {
			const old = registry.get(s.id);
			registry.set(s.id, s);
			if (old && old !== s) {
				try {
					options.onSourceReleased?.(s.id);
				} catch (err) {
					console.error('DocStore: onSourceReleased threw', err);
				}
			}
		}
		changed();
	}

	// ---- selection

	function setSel(next: ReadonlySet<PageId>, a: PageId | null): void {
		const sameSel = setsEqual(next, selection);
		if (sameSel && a === anchor) return;
		if (!sameSel) selection = next;
		anchor = a;
		changed();
	}
	const hasPage = (id: PageId) => pageIndexById(doc, id) >= 0;

	function select(id: PageId): void {
		if (hasPage(id)) setSel(new Set([id]), id);
	}
	function toggle(id: PageId): void {
		if (!hasPage(id)) return;
		const next = new Set(selection);
		if (!next.delete(id)) next.add(id);
		setSel(next, id);
	}
	function selectRange(toId: PageId, opts: { additive?: boolean } = {}): void {
		const to = pageIndexById(doc, toId);
		if (to < 0) return;
		const from = anchor === null ? -1 : pageIndexById(doc, anchor);
		if (from < 0) return select(toId);
		const [lo, hi] = from <= to ? [from, to] : [to, from];
		const next = new Set(opts.additive ? selection : []);
		for (let i = lo; i <= hi; i++) next.add(doc.pages[i].id);
		setSel(next, anchor);
	}
	function selectAll(): void {
		setSel(new Set(doc.pages.map((p) => p.id)), anchor ?? doc.pages[0]?.id ?? null);
	}
	function setSelection(ids: Iterable<PageId>): void {
		const next = new Set([...ids].filter(hasPage));
		setSel(
			next,
			anchor !== null && next.has(anchor) ? anchor : (next.values().next().value ?? null)
		);
	}
	function clearSelection(): void {
		setSel(EMPTY_SET, null);
	}

	// ---- history

	function restoreSelection(sel: ReadonlySet<PageId>): void {
		const ids = new Set(doc.pages.map((p) => p.id));
		const next = new Set([...sel].filter((x) => ids.has(x)));
		if (!setsEqual(next, selection)) selection = next;
		if (anchor === null || !ids.has(anchor)) anchor = next.values().next().value ?? null;
	}

	function undo(): boolean {
		if (gesture) return false;
		const e = undoStack.pop();
		if (!e) return false;
		fillStep = null;
		redoStack.push(e);
		doc = e.before;
		restoreSelection(e.selBefore);
		lastEvent = { kind: 'undo', label: e.label };
		sweep();
		changed();
		return true;
	}

	function redo(): boolean {
		if (gesture) return false;
		const e = redoStack.pop();
		if (!e) return false;
		fillStep = null;
		undoStack.push(e);
		doc = e.after;
		restoreSelection(e.selAfter);
		lastEvent = { kind: 'redo', label: e.label };
		sweep();
		changed();
		return true;
	}

	function beginGesture(label: string): void {
		if (gesture) throw new Error('DocStore: a gesture is already active');
		gesture = { label, doc, sel: selection };
		changed();
	}
	function commitGesture(): void {
		if (!gesture) return;
		const g = gesture;
		gesture = null;
		if (doc !== g.doc) pushEntry(g.label, g.doc, g.sel);
		sweep();
		changed();
	}
	function cancelGesture(): void {
		if (!gesture) return;
		doc = gesture.doc;
		gesture = null;
		pruneSelection();
		sweep();
		changed();
	}

	function transaction<T>(label: string, fn: () => T): T {
		if (gesture) return fn(); // already coalescing into the outer step
		batchDepth++;
		try {
			beginGesture(label);
			try {
				const out = fn();
				commitGesture();
				return out;
			} catch (err) {
				cancelGesture();
				throw err;
			}
		} finally {
			batchDepth--;
			if (batchDepth === 0 && pendingNotify) {
				pendingNotify = false;
				changed();
			}
		}
	}

	// ---- derived

	function sourceOf(pageId: PageId): Source | undefined {
		const p = doc.pages.find((x) => x.id === pageId);
		return p && registry.get(p.sourceId);
	}

	function displayedSize(ref: PageRef): PageSize | undefined {
		const size = registry.get(ref.sourceId)?.pages[ref.pageIndex];
		if (!size) return undefined;
		return ref.rotation === 90 || ref.rotation === 270
			? { width: size.height, height: size.width }
			: { width: size.width, height: size.height };
	}

	function toExportPlan(opts: ExportOptions, ids?: Iterable<PageId>): ExportPlan {
		const set = ids === undefined ? null : toSet(ids);
		const pages = doc.pages.filter((p) => !set || set.has(p.id));
		const plan: ExportPlan = { pages, options: { ...opts } };
		// Answers of the sources this plan uses; omitted when there are none.
		const used = new Set(pages.map((p) => p.sourceId));
		const formValues: FormValues = {};
		for (const [id, v] of Object.entries(doc.formValues)) {
			if (used.has(id) && Object.keys(v).length) formValues[id] = v;
		}
		if (Object.keys(formValues).length) plan.formValues = formValues;
		return plan;
	}

	return {
		get state() {
			return snap;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		get pageCount() {
			return doc.pages.length;
		},
		get totalOriginalBytes() {
			return doc.sources.reduce((n, s) => n + s.originalSize, 0);
		},
		get canUndo() {
			return snap.canUndo;
		},
		get canRedo() {
			return snap.canRedo;
		},
		get undoLabel() {
			return snap.undoLabel;
		},
		get redoLabel() {
			return snap.redoLabel;
		},
		get isDirty() {
			return snap.isDirty;
		},
		get undoToken() {
			return undoStack[undoStack.length - 1] ?? null;
		},
		get redoToken() {
			return redoStack[redoStack.length - 1] ?? null;
		},
		get gestureActive() {
			return gesture !== null;
		},
		markClean() {
			cleanDoc = doc;
			fillStep = null;
			changed();
		},
		sourceOf,
		displayedSize,
		toExportPlan,
		assetUsage,
		addSource,
		insertPages,
		removePages,
		movePages,
		rotatePages,
		duplicatePages,
		reversePages,
		sortBySource,
		addStamp,
		updateStamp,
		removeStamp,
		addAsset,
		removeAsset,
		setFormValue,
		clearFormValues,
		clear,
		reset,
		restore,
		select,
		toggle,
		selectRange,
		selectAll,
		setSelection,
		clearSelection,
		undo,
		redo,
		transaction,
		beginGesture,
		commitGesture,
		cancelGesture
	};
}

/** Convenience for building a PageRef for `insertPages`. */
export function newPageRef(sourceId: SourceId, pageIndex: number, rotation: Rotation = 0): PageRef {
	return { id: newId(), sourceId, pageIndex, rotation, stamps: [] };
}
