/**
 * The saved session record ("pick up where you left off"): what is stored, and the
 * strict reader that turns a stored value back into it. Pure TypeScript, no storage.
 *
 * One record per device (key "current") plus one blob per source file and asset,
 * keyed by the SHA-256 of its bytes (storage.ts). The record never holds file bytes,
 * a password or undo history. See the plan, "Saving progress", for the migration rule:
 * any change to the shape below (or to the stamp kinds it copies) bumps SCHEMA.
 */
import type { Asset, FormValue, FormValues, PageRef, PageSize, Rotation, Source, Stamp, StampBlank, StampBox } from '../core/types';
import { DEFAULT_FORM, type ExportForm } from '../workspace/logic';

/**
 * Bump on any change to SessionRecord or to the stamp shapes copied below.
 * 2 (2026-11-12): text and check stamps may carry `blank` (snap on tap's link to the
 * blank, for "Keep filled blanks editable"). Schema 1 records are the same shape
 * without it and are still read (READS); drop 1 from READS after 2026-11-26.
 */
export const SCHEMA = 2;
/** Schemas this build reads: older ones only where they are a subset of SCHEMA. */
const READS: readonly number[] = [1, SCHEMA];

/** A saved session is deleted this long after its last change. */
export const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Export options as the dialog holds them, without the file name and never the password. */
export type SavedExportForm = Omit<ExportForm, 'filename' | 'password'>;

export interface SavedSource {
	id: string;
	name: string;
	kind: Source['kind'];
	pages: PageSize[];
	originalSize: number;
	wasEncrypted: boolean;
	notes: string[];
	hasForm?: boolean;
	/** SHA-256 (hex) of the stored bytes. */
	hash: string;
	/** Length of the stored bytes. */
	size: number;
	/**
	 * 'normalized': Source.bytes as the engine made them (restored as they are).
	 * 'original': the file exactly as it was given, still encrypted (password-protected
	 * files); reopened by the engine on restore.
	 */
	stored: 'normalized' | 'original';
	/** 'original' only: the file needs its open password again (never stored). */
	needsPassword: boolean;
}

export interface SavedAsset {
	id: string;
	kind: Asset['kind'];
	width: number;
	height: number;
	hash: string;
	size: number;
}

export interface SessionRecord {
	schema: typeof SCHEMA;
	/** Random id of the tab (page load) that wrote it; guards against two writers. */
	writer: string;
	/** Random id of this write: a tab may replace only the exact record it was offered. */
	rev: string;
	/** Time of the last change that was saved (ms since epoch, device clock). */
	savedAt: number;
	/** App build that wrote it (information only). */
	app: string;
	/** The document had been exported as it is (DocState.isDirty was false). */
	clean: boolean;
	sources: SavedSource[];
	pages: PageRef[];
	assets: SavedAsset[];
	formValues: FormValues;
	exportForm: SavedExportForm;
}

export interface SessionSummary {
	/** Opened files (blank pages do not count). */
	files: number;
	pages: number;
	savedAt: number;
}

export class SessionFormatError extends Error {
	constructor(
		readonly reason: 'version' | 'damaged',
		message: string
	) {
		super(message);
		this.name = 'SessionFormatError';
	}
}

// ---------------------------------------------------------------- stamp shapes

type StampOf<K extends Stamp['kind']> = Extract<Stamp, { kind: K }>;
type Keys<K extends Stamp['kind']> = readonly (keyof StampOf<K>)[];

/**
 * Every key of every stamp kind. `npm run check` fails here when a stamp gains a key
 * the session does not copy: add it below, to `readStamp`, and bump SCHEMA.
 */
const STAMP_KEYS = {
	image: ['id', 'kind', 'assetId', 'box'],
	text: ['id', 'kind', 'text', 'x', 'y', 'size', 'color', 'blank'],
	mark: ['id', 'kind', 'mark', 'box', 'blank'],
	highlight: ['id', 'kind', 'color', 'box', 'pen', 'rects'],
	redact: ['id', 'kind', 'box']
} as const satisfies { [K in Stamp['kind']]: Keys<K> };

type Missing<K extends Stamp['kind']> = Exclude<keyof StampOf<K>, (typeof STAMP_KEYS)[K][number]>;
type AllCovered = { [K in Stamp['kind']]: Missing<K> extends never ? true : Missing<K> };
const covered: AllCovered = { image: true, text: true, mark: true, highlight: true, redact: true };
void covered;

const PAGE_REF_KEYS = ['id', 'sourceId', 'pageIndex', 'rotation', 'stamps'] as const satisfies readonly (keyof PageRef)[];
const pageRefCovered: Exclude<keyof PageRef, (typeof PAGE_REF_KEYS)[number]> extends never ? true : false = true;
void pageRefCovered;

const SOURCE_KEYS = ['id', 'name', 'kind', 'bytes', 'pages', 'originalSize', 'wasEncrypted', 'notes', 'hasForm'] as const satisfies readonly (keyof Source)[];
const sourceCovered: Exclude<keyof Source, (typeof SOURCE_KEYS)[number]> extends never ? true : false = true;
void sourceCovered;

// ---------------------------------------------------------------- writing

export interface RecordInput {
	writer: string;
	rev: string;
	savedAt: number;
	app: string;
	clean: boolean;
	sources: readonly Source[];
	/** Stored-blob facts per source id. */
	blobs: ReadonlyMap<string, { hash: string; size: number; stored: SavedSource['stored']; needsPassword: boolean }>;
	pages: readonly PageRef[];
	assets: readonly Asset[];
	assetBlobs: ReadonlyMap<string, { hash: string; size: number }>;
	formValues: FormValues;
	exportForm: SavedExportForm;
}

/** Build the record to store. Copies only known keys; never a password. */
export function buildRecord(input: RecordInput): SessionRecord {
	const sources: SavedSource[] = input.sources.map((s) => {
		const b = input.blobs.get(s.id);
		if (!b) throw new Error(`session: no stored bytes for ${s.id}`);
		const out: SavedSource = {
			id: s.id,
			name: s.name,
			kind: s.kind,
			pages: s.pages.map((p) => ({ width: p.width, height: p.height })),
			originalSize: s.originalSize,
			wasEncrypted: s.wasEncrypted,
			notes: [...s.notes],
			hash: b.hash,
			size: b.size,
			stored: b.stored,
			needsPassword: b.needsPassword
		};
		if (s.hasForm !== undefined) out.hasForm = s.hasForm;
		return out;
	});
	const assets: SavedAsset[] = input.assets.map((a) => {
		const b = input.assetBlobs.get(a.id);
		if (!b) throw new Error(`session: no stored bytes for asset ${a.id}`);
		return { id: a.id, kind: a.kind, width: a.width, height: a.height, hash: b.hash, size: b.size };
	});
	const formValues: FormValues = {};
	for (const [id, fields] of Object.entries(input.formValues)) {
		const f: Record<string, FormValue> = {};
		for (const [k, v] of Object.entries(fields)) f[k] = Array.isArray(v) ? [...v] : v;
		formValues[id] = f;
	}
	return {
		schema: SCHEMA,
		writer: input.writer,
		rev: input.rev,
		savedAt: input.savedAt,
		app: input.app,
		clean: input.clean,
		sources,
		pages: input.pages.map((p) => ({
			id: p.id,
			sourceId: p.sourceId,
			pageIndex: p.pageIndex,
			rotation: p.rotation,
			stamps: p.stamps.map(copyStamp)
		})),
		assets,
		formValues,
		exportForm: cleanExportForm(input.exportForm)
	};
}

function copyBox(b: StampBox): StampBox {
	return { x: b.x, y: b.y, w: b.w, h: b.h };
}

function copyStamp(s: Stamp): Stamp {
	switch (s.kind) {
		case 'image':
			return { id: s.id, kind: 'image', assetId: s.assetId, box: copyBox(s.box) };
		case 'text': {
			const t: Stamp = { id: s.id, kind: 'text', text: s.text, x: s.x, y: s.y, size: s.size, color: s.color };
			if (s.blank) t.blank = { kind: s.blank.kind, box: copyBox(s.blank.box) };
			return t;
		}
		case 'mark': {
			const m: Stamp = { id: s.id, kind: 'mark', mark: s.mark, box: copyBox(s.box) };
			if (s.blank) m.blank = { kind: s.blank.kind, box: copyBox(s.blank.box) };
			return m;
		}
		case 'redact':
			return { id: s.id, kind: 'redact', box: copyBox(s.box) };
		case 'highlight': {
			const h: Stamp = { id: s.id, kind: 'highlight', color: s.color, box: copyBox(s.box) };
			if (s.pen) h.pen = { width: s.pen.width, points: s.pen.points.map((p) => ({ x: p.x, y: p.y })) };
			if (s.rects) h.rects = s.rects.map(copyBox);
			return h;
		}
	}
}

/** Export options to keep: the dialog's form minus file name and password. */
export function cleanExportForm(form: Partial<ExportForm>): SavedExportForm {
	const out = { ...DEFAULT_FORM } as SavedExportForm & { password?: unknown; filename?: unknown };
	for (const key of Object.keys(DEFAULT_FORM) as (keyof SavedExportForm)[]) {
		const v = form[key];
		if (typeof v === typeof DEFAULT_FORM[key]) (out as Record<string, unknown>)[key] = v;
	}
	delete out.password;
	delete out.filename;
	return out;
}

// ---------------------------------------------------------------- reading

const HASH = /^[0-9a-f]{64}$/;

function fail(what: string): never {
	throw new SessionFormatError('damaged', `saved session: ${what}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';

function readBox(v: unknown): StampBox {
	if (!isObj(v) || !fin(v.x) || !fin(v.y) || !fin(v.w) || !fin(v.h)) fail('bad box');
	return { x: v.x, y: v.y, w: v.w, h: v.h };
}

function readBlank(v: unknown, kind: StampBlank['kind']): StampBlank {
	if (!isObj(v) || v.kind !== kind) fail('bad blank');
	return { kind, box: readBox(v.box) };
}

function readStamp(v: unknown): Stamp {
	if (!isObj(v) || !str(v.id) || !v.id) fail('bad stamp');
	const id = v.id;
	switch (v.kind) {
		case 'image':
			if (!str(v.assetId)) fail('bad image stamp');
			return { id, kind: 'image', assetId: v.assetId, box: readBox(v.box) };
		case 'text': {
			if (!str(v.text) || !fin(v.x) || !fin(v.y) || !fin(v.size) || !['black', 'blue', 'red'].includes(v.color as string)) fail('bad text stamp');
			const t: Stamp = { id, kind: 'text', text: v.text, x: v.x, y: v.y, size: v.size, color: v.color as 'black' | 'blue' | 'red' };
			if (v.blank !== undefined) t.blank = readBlank(v.blank, 'text');
			return t;
		}
		case 'mark': {
			if (!['check', 'cross', 'dot'].includes(v.mark as string)) fail('bad mark stamp');
			const m: Stamp = { id, kind: 'mark', mark: v.mark as 'check' | 'cross' | 'dot', box: readBox(v.box) };
			if (v.blank !== undefined) m.blank = readBlank(v.blank, 'check');
			return m;
		}
		case 'redact':
			return { id, kind: 'redact', box: readBox(v.box) };
		case 'highlight': {
			if (!['yellow', 'green', 'pink'].includes(v.color as string)) fail('bad highlight colour');
			const h: Stamp = { id, kind: 'highlight', color: v.color as 'yellow' | 'green' | 'pink', box: readBox(v.box) };
			if (v.pen !== undefined) {
				const pen = v.pen;
				if (!isObj(pen) || !fin(pen.width) || !Array.isArray(pen.points)) fail('bad pen stroke');
				h.pen = {
					width: pen.width,
					points: pen.points.map((p) => {
						if (!isObj(p) || !fin(p.x) || !fin(p.y)) fail('bad pen point');
						return { x: p.x, y: p.y };
					})
				};
			}
			if (v.rects !== undefined) {
				if (!Array.isArray(v.rects)) fail('bad highlight rectangles');
				h.rects = v.rects.map(readBox);
			}
			return h;
		}
		default:
			fail('unknown stamp kind');
	}
}

function readPage(v: unknown): PageRef {
	if (!isObj(v) || !str(v.id) || !str(v.sourceId) || !Number.isInteger(v.pageIndex) || !Array.isArray(v.stamps)) fail('bad page');
	if (![0, 90, 180, 270].includes(v.rotation as number)) fail('bad rotation');
	return {
		id: v.id,
		sourceId: v.sourceId,
		pageIndex: v.pageIndex as number,
		rotation: v.rotation as Rotation,
		stamps: v.stamps.map(readStamp)
	};
}

function readSource(v: unknown): SavedSource {
	if (!isObj(v) || !str(v.id) || !v.id || !str(v.name) || !['pdf', 'image', 'blank'].includes(v.kind as string)) fail('bad source');
	if (!Array.isArray(v.pages) || v.pages.length === 0) fail('source without pages');
	const pages = v.pages.map((p) => {
		if (!isObj(p) || !fin(p.width) || !fin(p.height) || p.width <= 0 || p.height <= 0) fail('bad page size');
		return { width: p.width, height: p.height };
	});
	if (!fin(v.originalSize) || v.originalSize < 0 || typeof v.wasEncrypted !== 'boolean') fail('bad source facts');
	if (!Array.isArray(v.notes) || !v.notes.every(str)) fail('bad source notes');
	if (v.hasForm !== undefined && typeof v.hasForm !== 'boolean') fail('bad form flag');
	if (!str(v.hash) || !HASH.test(v.hash) || !Number.isInteger(v.size) || (v.size as number) <= 0) fail('bad source hash');
	if (v.stored !== 'normalized' && v.stored !== 'original') fail('bad storage kind');
	if (typeof v.needsPassword !== 'boolean') fail('bad password flag');
	// A protected file is only ever stored as it was given (still encrypted).
	if (v.wasEncrypted && v.stored !== 'original') fail('protected file stored decrypted');
	if (v.needsPassword && v.stored !== 'original') fail('password flag on a normalized file');
	const out: SavedSource = {
		id: v.id,
		name: v.name,
		kind: v.kind as Source['kind'],
		pages,
		originalSize: v.originalSize,
		wasEncrypted: v.wasEncrypted,
		notes: [...(v.notes as string[])],
		hash: v.hash,
		size: v.size as number,
		stored: v.stored,
		needsPassword: v.needsPassword
	};
	if (v.hasForm !== undefined) out.hasForm = v.hasForm as boolean;
	return out;
}

function readAsset(v: unknown): SavedAsset {
	if (!isObj(v) || !str(v.id) || !['signature', 'initials', 'image'].includes(v.kind as string)) fail('bad asset');
	if (!fin(v.width) || !fin(v.height) || !str(v.hash) || !HASH.test(v.hash) || !Number.isInteger(v.size) || (v.size as number) <= 0) fail('bad asset facts');
	return { id: v.id, kind: v.kind as Asset['kind'], width: v.width, height: v.height, hash: v.hash, size: v.size as number };
}

function readFormValues(v: unknown): FormValues {
	if (v === undefined) return {};
	if (!isObj(v)) fail('bad form answers');
	const out: FormValues = {};
	for (const [id, fields] of Object.entries(v)) {
		if (!isObj(fields)) fail('bad form answers');
		const f: Record<string, FormValue> = {};
		for (const [k, x] of Object.entries(fields)) {
			if (typeof x === 'string' || typeof x === 'boolean') f[k] = x;
			else if (Array.isArray(x) && x.every(str)) f[k] = [...x];
			else fail('bad form answer');
		}
		out[id] = f;
	}
	return out;
}

/** The record's schema number, or null when the value is not a record at all. */
export function schemaOf(raw: unknown): number | null {
	return isObj(raw) && typeof raw.schema === 'number' ? raw.schema : null;
}

/**
 * Read a stored value back into a SessionRecord. Throws SessionFormatError:
 * 'version' for any schema this build does not read (READS), 'damaged' for
 * anything that does not parse. Cross-references (page index in range, assets
 * used by stamps, form answers of known sources) are checked here too, so a
 * record that parses can be handed to DocStore.restore.
 */
export function parseRecord(raw: unknown): SessionRecord {
	const schema = schemaOf(raw);
	if (schema === null) fail('not a session record');
	if (!READS.includes(schema)) throw new SessionFormatError('version', `saved session: schema ${schema}, this app reads ${READS.join(' and ')}`);
	const v = raw as Record<string, unknown>;
	if (!str(v.writer) || !str(v.rev) || !fin(v.savedAt) || !str(v.app) || typeof v.clean !== 'boolean') fail('bad header');
	if (!Array.isArray(v.sources) || !Array.isArray(v.pages) || !Array.isArray(v.assets)) fail('bad lists');
	const sources = v.sources.map(readSource);
	const pages = v.pages.map(readPage);
	const assets = v.assets.map(readAsset);
	const formValues = readFormValues(v.formValues);
	const byId = new Map(sources.map((s) => [s.id, s]));
	if (byId.size !== sources.length) fail('duplicate source');
	const assetIds = new Set(assets.map((a) => a.id));
	if (assetIds.size !== assets.length) fail('duplicate asset');
	if (pages.length === 0) fail('no pages');
	const pageIds = new Set<string>();
	for (const p of pages) {
		const s = byId.get(p.sourceId);
		if (!s) fail('page of an unknown source');
		if (p.pageIndex < 0 || p.pageIndex >= s.pages.length) fail('page index out of range');
		if (pageIds.has(p.id)) fail('duplicate page');
		pageIds.add(p.id);
		for (const st of p.stamps) if (st.kind === 'image' && !assetIds.has(st.assetId)) fail('stamp of an unknown asset');
	}
	for (const id of Object.keys(formValues)) if (!byId.has(id)) fail('answers of an unknown source');
	const exportForm = cleanExportForm(isObj(v.exportForm) ? (v.exportForm as Partial<ExportForm>) : {});
	return {
		schema: SCHEMA,
		writer: v.writer,
		rev: v.rev as string,
		savedAt: v.savedAt,
		app: v.app,
		clean: v.clean,
		sources,
		pages,
		assets,
		formValues,
		exportForm
	};
}

// ---------------------------------------------------------------- summary and time

export function summarize(rec: Pick<SessionRecord, 'sources' | 'pages' | 'savedAt'>): SessionSummary {
	return { files: rec.sources.filter((s) => s.kind !== 'blank').length, pages: rec.pages.length, savedAt: rec.savedAt };
}

export function isExpired(savedAt: number, now: number): boolean {
	return !(now - savedAt < EXPIRY_MS);
}

const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;

/** "saved just now", "saved 5 minutes ago", "saved 2 hours ago", "saved yesterday", "saved 3 days ago". */
export function savedAgo(savedAt: number, now: number): string {
	const s = Math.max(0, now - savedAt) / 1000;
	if (s < 60) return 'saved just now';
	if (s < 3600) return `saved ${n(Math.floor(s / 60), 'minute')} ago`;
	if (s < 86400) return `saved ${n(Math.floor(s / 3600), 'hour')} ago`;
	if (s < 2 * 86400) return 'saved yesterday';
	return `saved ${n(Math.floor(s / 86400), 'day')} ago`;
}

/** "3 files, 12 pages, saved 2 hours ago". */
export function describeSummary(sum: SessionSummary, now: number): string {
	const parts: string[] = [];
	if (sum.files > 0) parts.push(n(sum.files, 'file'));
	parts.push(n(sum.pages, 'page'));
	parts.push(savedAgo(sum.savedAt, now));
	return parts.join(', ');
}
