/**
 * Keep filled blanks editable (ExportOptions.blankFields; the plan, "Filled blanks as
 * form fields"). A text or tick stamp that snap on tap put into a drawn blank, and that
 * is still linked to it (Stamp `blank`), becomes an AcroForm field over the blank: a
 * text field with the typed text as its value, or a checkbox, ticked. The stamp is then
 * not drawn as page content.
 *
 * Appearance. The field's appearance stream holds exactly the operators the stamp
 * stage would have drawn on the page (stamps.ts textOps / markOps, the same embedded
 * Noto Sans subset), moved into the form's own space, so it renders as the stamp
 * would. No border, no background. The field's /DA names standard Helvetica
 * (ZapfDingbats for ticks) from /AcroForm /DR, in the stamp's size and colour: a viewer
 * that redraws the field after an edit (and MuPDF in the forms stage, when the file is
 * opened here again) uses that. Values are therefore WinAnsi only (as for every form
 * answer here: forms.ts `undrawableChars`); other text stays a plain stamp.
 * /NeedAppearances is never set (the forms stage removes it too).
 *
 * Rectangle: the blank's, grown to hold the stamp's line boxes (ascent to descent of
 * every line, 1 pt more each way) so nothing is clipped. Names `blank_p<page>_<n>`
 * (output page, 1-based), made unique against the file's own field names; every
 * widget is its own field, so duplicated pages give independent fields.
 *
 * Proof, before the file goes on (core.ts): the same pages are also built the ordinary
 * way (every stamp drawn) and each page with fields is rendered by MuPDF from both
 * (widgets included) and compared; MuPDF and PDF.js read every field back (type,
 * name, value or state, rectangle, page, the text its appearance draws) and the page
 * content must have lost exactly the field's characters. A field that fails any of it
 * is drawn as a plain stamp instead; the final file is read back again ('blank-fields').
 *
 * Declined for the whole file (every stamp drawn): a form that asks viewers to redraw
 * its fields (/NeedAppearances true) or an XFA form; flatten (and so redaction) is
 * handled by the caller.
 */

import type * as PdfLib from '@cantoo/pdf-lib';
import type { Stamp, StampBlank, VerifyCheck } from '../core/types';
import type { EngineDeps } from './deps';
import { undrawableChars } from './forms';
import { normalizeStampText, type Box } from './geometry';
import type { Mupdf } from './mupdf';

/** Why a linked stamp was drawn as a plain stamp. */
export type PlainReason = 'characters' | 'lines' | 'off-blank' | 'form-redraws' | 'not-verified';

/** A field the stamp stage made. */
export interface MadeField {
	stampId: string;
	/** 0-based output page. */
	page: number;
	name: string;
	kind: 'text' | 'check';
	/** text: the value (normalized stamp text); check: ''. */
	value: string;
	/** Widget /Rect, PDF user space (as written). */
	rect: Box;
	/** The rectangle as fractions of the displayed page (origin top-left), for render comparison. */
	shown: { x0: number; y0: number; x1: number; y1: number };
}

/** What the stamp stage is asked to do and reports back. */
export interface BlankFieldsJob {
	/** Stamps to make into fields (already checked by `candidates`). */
	ids: ReadonlySet<string>;
	/** Filled in by the stamp stage. */
	made: MadeField[];
	/** Stamps asked for but drawn as plain stamps, with why. */
	plain: Map<string, PlainReason>;
}

/** A blank this tall holds two lines of 11 pt text (editor/snap.ts TALL, doc/store.ts TALL_BLANK_PT). */
const TALL_BLANK_PT = 2 * 1.2 * 11;
/** The stamp must start (text) or be centred (tick) on its blank, within this many points. */
const ON_BLANK_PT = 1.5;
/** Room around the text's line boxes in the widget rectangle, points. */
export const TEXT_MARGIN_PT = 1;
/** Text field flag Multiline. */
const FF_MULTILINE = 1 << 12;
/** Annotation flag Print. */
const AF_PRINT = 4;
/** Name of the checkbox on-state. */
export const ON_STATE = 'Yes';

/** Linked stamp kinds. */
export type LinkedStamp = Extract<Stamp, { kind: 'text' | 'mark' }> & { blank: StampBlank };

export function linked(s: Stamp): s is LinkedStamp {
	if (s.kind === 'text') return s.blank?.kind === 'text' && normalizeStampText(s.text).replace(/\n/g, '').trim() !== '';
	if (s.kind === 'mark') return s.mark === 'check' && s.blank?.kind === 'check';
	return false;
}

/**
 * Linked stamps of one output page and whether each may become a field before anything
 * is built: WinAnsi text only (what a redrawing viewer can show), several lines only in
 * a blank at least two lines tall. `pageHeight`: the displayed page height in points.
 */
export function precheck(s: LinkedStamp, pageHeight: number): PlainReason | null {
	if (s.kind !== 'text') return null;
	const text = normalizeStampText(s.text);
	if (undrawableChars(text) !== '') return 'characters';
	if (text.includes('\n') && s.blank.box.h * pageHeight < TALL_BLANK_PT) return 'lines';
	return null;
}

/** Whether a stamp sits on its blank (display space, user units). `start`: text start / tick centre. */
export function onBlank(blank: { left: number; top: number; right: number; bottom: number }, start: [number, number]): boolean {
	const t = ON_BLANK_PT;
	return start[0] >= blank.left - t && start[0] <= blank.right + t && start[1] >= blank.top - t && start[1] <= blank.bottom + t;
}

// ---------------------------------------------------------------------------
// Building (called by the stamp stage with pdf-lib).

type Lib = typeof PdfLib;

/** Full names of every field in the file's AcroForm, and the AcroForm's redraw flags. */
export function readAcroForm(lib: Lib, doc: PdfLib.PDFDocument): { names: Set<string>; redraws: boolean } {
	const { PDFArray, PDFBool, PDFDict, PDFName, PDFHexString, PDFString } = lib;
	const names = new Set<string>();
	const af = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
	if (!af) return { names, redraws: false };
	const need = af.lookup(PDFName.of('NeedAppearances'));
	const redraws = (need instanceof PDFBool && need.asBoolean()) || af.has(PDFName.of('XFA'));
	const seen = new Set<PdfLib.PDFDict>();
	const walk = (arr: PdfLib.PDFArray | undefined, prefix: string, depth: number) => {
		if (!arr || depth > 32) return;
		for (let k = 0; k < arr.size(); k++) {
			let d: PdfLib.PDFDict | undefined;
			try {
				d = arr.lookupMaybe(k, PDFDict);
			} catch {
				continue;
			}
			if (!d || seen.has(d)) continue;
			seen.add(d);
			const t = d.lookup(PDFName.of('T'));
			const part = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : null;
			const full = part === null ? prefix : prefix ? `${prefix}.${part}` : part;
			if (part !== null) names.add(full);
			let kids: PdfLib.PDFArray | undefined;
			try {
				kids = d.lookupMaybe(PDFName.of('Kids'), PDFArray);
			} catch {
				kids = undefined;
			}
			walk(kids, full, depth + 1);
		}
	};
	try {
		walk(af.lookupMaybe(PDFName.of('Fields'), PDFArray), '', 0);
	} catch {
		// A broken /Fields: names stay as found; ours get a suffix only on a clash.
	}
	return { names, redraws };
}

export interface FieldInput {
	kind: 'text' | 'check';
	name: string;
	page: number;
	pageRef: PdfLib.PDFRef;
	rect: Box;
	/** Page rotation as displayed (/Rotate), for /MK /R. */
	rotation: number;
	/** The stamp's operators, in page user space (as the stamp stage would draw them). */
	ops: PdfLib.PDFOperator[];
	/** Resources those operators name (font, graphics state). */
	resources: Record<string, Record<string, PdfLib.PDFRef>>;
	/** text */
	value?: string;
	multiline?: boolean;
	fontSize?: number;
	color?: readonly [number, number, number];
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** The widget annotation (a merged field and widget) for one linked stamp. Returns its reference. */
export function makeWidget(lib: Lib, ctx: PdfLib.PDFContext, f: FieldInput, fonts: { helv: string; zadb: string }): PdfLib.PDFRef {
	const { PDFHexString, PDFName, PDFString } = lib;
	const { x0, y0, x1, y1 } = f.rect;
	const bbox = [0, 0, r4(x1 - x0), r4(y1 - y0)];
	const res = ctx.obj({});
	for (const [cat, entries] of Object.entries(f.resources)) {
		const d = ctx.obj({});
		for (const [k, ref] of Object.entries(entries)) d.set(PDFName.of(k), ref);
		res.set(PDFName.of(cat), d);
	}
	const shift = lib.concatTransformationMatrix(1, 0, 0, 1, r4(-x0), r4(-y0));
	const stream = (ops: PdfLib.PDFOperator[]) => ctx.register(ctx.formXObject(ops, { BBox: bbox, Resources: res }));
	const mk = ctx.obj({});
	const rot = ((f.rotation % 360) + 360) % 360;
	if (rot) mk.set(PDFName.of('R'), ctx.obj(rot));
	const dict: Record<string, unknown> = {
		Type: 'Annot',
		Subtype: 'Widget',
		F: AF_PRINT,
		Rect: [r4(x0), r4(y0), r4(x1), r4(y1)],
		P: f.pageRef,
		BS: { W: 0 },
		MK: mk
	};
	const w = ctx.obj(dict as never) as unknown as PdfLib.PDFDict;
	w.set(PDFName.of('T'), PDFHexString.fromText(f.name));
	if (f.kind === 'text') {
		const [r, g, b] = f.color ?? [0, 0, 0];
		w.set(PDFName.of('FT'), PDFName.of('Tx'));
		w.set(PDFName.of('V'), PDFHexString.fromText(f.value ?? ''));
		w.set(PDFName.of('DA'), PDFString.of(`/${fonts.helv} ${r4(f.fontSize ?? 11)} Tf ${r4(r)} ${r4(g)} ${r4(b)} rg`));
		if (f.multiline) w.set(PDFName.of('Ff'), ctx.obj(FF_MULTILINE));
		w.set(PDFName.of('AP'), ctx.obj({ N: stream([shift, ...f.ops]) }));
	} else {
		w.set(PDFName.of('FT'), PDFName.of('Btn'));
		w.set(PDFName.of('V'), PDFName.of(ON_STATE));
		w.set(PDFName.of('AS'), PDFName.of(ON_STATE));
		w.set(PDFName.of('DA'), PDFString.of(`/${fonts.zadb} 0 Tf 0 g`));
		// ZapfDingbats "4" is a tick: what a viewer draws if it redraws the box.
		mk.set(PDFName.of('CA'), PDFString.of('4'));
		const on = stream([shift, ...f.ops]);
		const off = stream([]);
		w.set(PDFName.of('AP'), ctx.obj({ N: { [ON_STATE]: on, Off: off } }));
	}
	return ctx.register(w);
}

/**
 * Adds the new fields to the catalog's /AcroForm (made when missing) and the standard
 * fonts their /DA names to /AcroForm /DR. Existing fields, /DA and /DR entries are left
 * as they are; a /DR font name already used for another font is not reused.
 */
export function registerFields(lib: Lib, doc: PdfLib.PDFDocument, refs: PdfLib.PDFRef[], fonts: { helv: string; zadb: string }): void {
	const { PDFArray, PDFDict, PDFName } = lib;
	const ctx = doc.context;
	let af = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
	if (!af) {
		af = ctx.obj({});
		doc.catalog.set(PDFName.of('AcroForm'), ctx.register(af));
	}
	let fields = af.lookupMaybe(PDFName.of('Fields'), PDFArray);
	if (!fields) {
		fields = ctx.obj([]);
		af.set(PDFName.of('Fields'), fields);
	}
	for (const r of refs) fields.push(r);
	let dr = af.lookupMaybe(PDFName.of('DR'), PDFDict);
	if (!dr) {
		dr = ctx.obj({});
		af.set(PDFName.of('DR'), dr);
	}
	let font = dr.lookupMaybe(PDFName.of('Font'), PDFDict);
	if (!font) {
		font = ctx.obj({});
		dr.set(PDFName.of('Font'), font);
	}
	const ensure = (key: string, base: string, winAnsi: boolean) => {
		if (font!.has(PDFName.of(key))) return;
		font!.set(PDFName.of(key), ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: base, ...(winAnsi ? { Encoding: 'WinAnsiEncoding' } : {}) })));
	};
	ensure(fonts.helv, 'Helvetica', true);
	ensure(fonts.zadb, 'ZapfDingbats', false);
}

/**
 * /DR font names for the new fields' /DA: `Helv` and `ZaDb` when free or already the
 * standard font we need, else a fresh name.
 */
export function drFontNames(lib: Lib, doc: PdfLib.PDFDocument): { helv: string; zadb: string } {
	const { PDFDict, PDFName } = lib;
	const af = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
	const font = af?.lookupMaybe(PDFName.of('DR'), PDFDict)?.lookupMaybe(PDFName.of('Font'), PDFDict);
	const fits = (key: string, base: string, winAnsi: boolean) => {
		if (!font || !font.has(PDFName.of(key))) return true;
		let d: PdfLib.PDFDict | undefined;
		try {
			d = font.lookupMaybe(PDFName.of(key), PDFDict);
		} catch {
			return false;
		}
		if (!d) return false;
		const name = (k: string) => {
			const v = d!.lookup(PDFName.of(k));
			return v instanceof PDFName ? v.decodeText() : null;
		};
		return name('Subtype') === 'Type1' && name('BaseFont') === base && !d.has(PDFName.of('FontDescriptor')) && (!winAnsi || name('Encoding') === 'WinAnsiEncoding');
	};
	const pick = (key: string, base: string, winAnsi: boolean) => {
		if (fits(key, base, winAnsi)) return key;
		for (let k = 0; ; k++) if (!font!.has(PDFName.of(`Pgs${key}${k}`))) return `Pgs${key}${k}`;
	};
	return { helv: pick('Helv', 'Helvetica', true), zadb: pick('ZaDb', 'ZapfDingbats', false) };
}

/** A field name not in `taken` (and then taken). */
export function uniqueName(taken: Set<string>, page: number, n: number): string {
	const base = `blank_p${page + 1}_${n}`;
	let name = base;
	for (let k = 2; taken.has(name); k++) name = `${base}_${k}`;
	taken.add(name);
	return name;
}

// ---------------------------------------------------------------------------
// Proof (MuPDF render comparison, MuPDF and PDF.js read-back).

/** A pixel differs when a channel differs by more than this (the survey harness's PIXEL_LEVEL). */
export const PIXEL_LEVEL = 48;
/** Fewer differing pixels than this in a field's area are rounding (the harness's MIN_DIFF_PIXELS). */
export const MIN_DIFF_PIXELS = 4;
/** Render resolution for the comparison, pixels per point, and a cap per page. */
const RENDER_SCALE = 2;
const RENDER_MAX_PIXELS = 6_000_000;

type MDoc = InstanceType<Mupdf['PDFDocument']>;
type MObj = InstanceType<Mupdf['PDFObject']>;

const destroy = (x: { destroy?: () => void } | null | undefined) => {
	try {
		x?.destroy?.();
	} catch {
		// gone
	}
};

const squash = (s: string) => s.replace(/\s+/g, '');

function rectNumbers(o: MObj): Box | null {
	const r = o.get('Rect');
	if (!r || !r.isArray() || r.length !== 4) return null;
	const v: number[] = [];
	for (let i = 0; i < 4; i++) {
		const n = r.get(i);
		if (!n.isNumber()) return null;
		v.push(n.asNumber());
	}
	return { x0: Math.min(v[0], v[2]), y0: Math.min(v[1], v[3]), x1: Math.max(v[0], v[2]), y1: Math.max(v[1], v[3]) };
}

const sameRect = (a: Box, b: Box, tol = 0.01) =>
	Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;

/** Characters (not spaces) MuPDF's structured text finds inside `r` (fractions of the page) of a display list. */
function charsIn(m: Mupdf, dl: InstanceType<Mupdf['DisplayList']>, bounds: number[], r: MadeField['shown']): string {
	const st = dl.toStructuredText('preserve-whitespace');
	const W = bounds[2] - bounds[0];
	const H = bounds[3] - bounds[1];
	let out = '';
	try {
		st.walk({
			onChar(c: string, origin: number[]) {
				const fx = (origin[0] - bounds[0]) / W;
				const fy = (origin[1] - bounds[1]) / H;
				if (c.trim() !== '' && fx >= r.x0 && fx <= r.x1 && fy >= r.y0 && fy <= r.y1) out += c;
			}
		});
	} finally {
		destroy(st);
	}
	void m;
	return out;
}

/** Problems with the fields as MuPDF reads them from `doc` (one list entry per field that is wrong). */
function mupdfReadBack(m: Mupdf, doc: MDoc, made: MadeField[]): Map<string, string> {
	const bad = new Map<string, string>();
	const byPage = new Map<number, MadeField[]>();
	for (const f of made) byPage.set(f.page, [...(byPage.get(f.page) ?? []), f]);
	for (const [p, list] of byPage) {
		if (p >= doc.countPages()) {
			for (const f of list) bad.set(f.stampId, `page ${p + 1} is missing`);
			continue;
		}
		const page = doc.loadPage(p);
		try {
			const widgets = page.getWidgets();
			for (const f of list) {
				const w = widgets.filter((x) => x.getName() === f.name);
				if (w.length !== 1) {
					bad.set(f.stampId, `${f.name}: ${w.length} widgets on page ${p + 1} (MuPDF)`);
					continue;
				}
				const o = w[0].getObject();
				const r = rectNumbers(o);
				const type = w[0].getFieldType();
				if (!r || !sameRect(r, f.rect)) bad.set(f.stampId, `${f.name}: rectangle differs (MuPDF)`);
				else if (type !== (f.kind === 'text' ? 'text' : 'checkbox')) bad.set(f.stampId, `${f.name}: type ${type} (MuPDF)`);
				else if (f.kind === 'text' && w[0].getValue() !== f.value) bad.set(f.stampId, `${f.name}: value reads back differently (MuPDF)`);
				else if (f.kind === 'check' && (w[0].getValue() !== ON_STATE || !o.get('AS').isName() || o.get('AS').asName() !== ON_STATE)) bad.set(f.stampId, `${f.name}: not ticked (MuPDF)`);
				else if (f.kind === 'text') {
					// The appearance draws the value.
					const dl = w[0].toDisplayList();
					try {
						const st = dl.toStructuredText('preserve-whitespace');
						let drawn = '';
						try {
							st.walk({ onChar: (c: string) => void (drawn += c) });
						} finally {
							destroy(st);
						}
						if (squash(drawn) !== squash(f.value)) bad.set(f.stampId, `${f.name}: appearance does not show the value (MuPDF)`);
					} finally {
						destroy(dl);
					}
				}
			}
			for (const w of widgets) destroy(w);
		} finally {
			destroy(page);
		}
	}
	return bad;
}

interface PdfjsAnnot {
	subtype?: string;
	fieldName?: string;
	fieldType?: string;
	fieldValue?: unknown;
	exportValue?: unknown;
	checkBox?: boolean;
	rect?: number[];
	hidden?: boolean;
	noView?: boolean;
	hasAppearance?: boolean;
}

/** Problems with the fields as PDF.js reads them. */
async function pdfjsReadBack(deps: EngineDeps, bytes: Uint8Array, made: MadeField[], password?: string): Promise<Map<string, string>> {
	const bad = new Map<string, string>();
	const lib = await deps.pdfjs();
	const task = lib.getDocument({
		data: bytes.slice(),
		password,
		useWasm: false,
		useWorkerFetch: false,
		useSystemFonts: false,
		disableFontFace: true,
		enableXfa: false,
		verbosity: 0
	});
	try {
		const pdf = await task.promise;
		const byPage = new Map<number, MadeField[]>();
		for (const f of made) byPage.set(f.page, [...(byPage.get(f.page) ?? []), f]);
		for (const [p, list] of byPage) {
			const page = await pdf.getPage(p + 1);
			const annots = ((await page.getAnnotations()) as PdfjsAnnot[]).filter((a) => a.subtype === 'Widget');
			for (const f of list) {
				const a = annots.filter((x) => x.fieldName === f.name);
				if (a.length !== 1) {
					bad.set(f.stampId, `${f.name}: ${a.length} widgets on page ${p + 1} (PDF.js)`);
					continue;
				}
				const x = a[0];
				const r = x.rect;
				if (!Array.isArray(r) || !sameRect({ x0: r[0], y0: r[1], x1: r[2], y1: r[3] }, f.rect)) bad.set(f.stampId, `${f.name}: rectangle differs (PDF.js)`);
				else if (x.hidden || x.noView || x.hasAppearance === false) bad.set(f.stampId, `${f.name}: not shown (PDF.js)`);
				else if (f.kind === 'text' && (x.fieldType !== 'Tx' || x.fieldValue !== f.value)) bad.set(f.stampId, `${f.name}: value reads back differently (PDF.js)`);
				else if (f.kind === 'check' && (x.fieldType !== 'Btn' || !x.checkBox || x.fieldValue !== ON_STATE || x.exportValue !== ON_STATE))
					bad.set(f.stampId, `${f.name}: not a ticked checkbox (PDF.js)`);
			}
		}
	} finally {
		await task.destroy().catch(() => undefined);
	}
	return bad;
}

/**
 * Proof before use: `withFields` (the stamp stage with fields) against `ordinary` (the
 * same stage drawing every stamp). Returns the stamps whose fields failed, with why.
 */
export async function proveFields(deps: EngineDeps, ordinary: Uint8Array, withFields: Uint8Array, made: MadeField[]): Promise<Map<string, string>> {
	const m = await deps.mupdf();
	const a = new m.PDFDocument(ordinary);
	const b = new m.PDFDocument(withFields);
	let bad: Map<string, string>;
	try {
		bad = mupdfReadBack(m, b, made);
		const pages = [...new Set(made.map((f) => f.page))];
		for (const p of pages) {
			const list = made.filter((f) => f.page === p);
			for (const [id, why] of comparePage(m, a, b, p, list)) if (!bad.has(id)) bad.set(id, why);
		}
	} finally {
		destroy(a);
		destroy(b);
		m.emptyStore();
	}
	for (const [id, why] of await pdfjsReadBack(deps, withFields, made)) if (!bad.has(id)) bad.set(id, why);
	return bad;
}

/** Render page `p` of both (with widgets) and compare; and the page content must have lost exactly each text field's characters. */
function comparePage(m: Mupdf, a: MDoc, b: MDoc, p: number, list: MadeField[]): Map<string, string> {
	const bad = new Map<string, string>();
	const pa = a.loadPage(p);
	const pb = b.loadPage(p);
	let xa: InstanceType<Mupdf['Pixmap']> | null = null;
	let xb: InstanceType<Mupdf['Pixmap']> | null = null;
	let da: InstanceType<Mupdf['DisplayList']> | null = null;
	let db: InstanceType<Mupdf['DisplayList']> | null = null;
	try {
		const bounds = pa.getBounds();
		const area = Math.max(1, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]));
		const s = Math.min(RENDER_SCALE, Math.sqrt(RENDER_MAX_PIXELS / area));
		const mtx = m.Matrix.scale(s, s);
		xa = pa.toPixmap(mtx, m.ColorSpace.DeviceRGB, false, true);
		xb = pb.toPixmap(mtx, m.ColorSpace.DeviceRGB, false, true);
		const w = xa.getWidth();
		const h = xa.getHeight();
		if (w !== xb.getWidth() || h !== xb.getHeight() || xa.getStride() !== w * 3 || xb.getStride() !== w * 3) {
			for (const f of list) bad.set(f.stampId, `page ${p + 1} renders at another size`);
			return bad;
		}
		const A = xa.getPixels();
		const B = xb.getPixels();
		const grow = 2;
		const boxes = list.map((f) => ({
			id: f.stampId,
			x0: Math.floor(f.shown.x0 * w) - grow,
			y0: Math.floor(f.shown.y0 * h) - grow,
			x1: Math.ceil(f.shown.x1 * w) + grow,
			y1: Math.ceil(f.shown.y1 * h) + grow,
			n: 0
		}));
		let stray = 0;
		for (let y = 0; y < h; y++) {
			let o = y * w * 3;
			for (let x = 0; x < w; x++, o += 3) {
				const d = Math.max(Math.abs(A[o] - B[o]), Math.abs(A[o + 1] - B[o + 1]), Math.abs(A[o + 2] - B[o + 2]));
				if (d <= PIXEL_LEVEL) continue;
				let hit = false;
				for (const bx of boxes) {
					if (x >= bx.x0 && x < bx.x1 && y >= bx.y0 && y < bx.y1) {
						bx.n++;
						hit = true;
					}
				}
				if (!hit) stray++;
			}
		}
		if (stray >= MIN_DIFF_PIXELS) {
			for (const f of list) bad.set(f.stampId, `page ${p + 1} looks different outside the fields (${stray} pixels)`);
			return bad;
		}
		for (const bx of boxes) if (bx.n >= MIN_DIFF_PIXELS) bad.set(bx.id, `looks different from the plain stamp (${bx.n} pixels)`);
		// Not drawn twice: the page's own content (no widgets) lost the field's characters.
		da = pa.toDisplayList(false);
		db = pb.toDisplayList(false);
		for (const f of list) {
			if (f.kind !== 'text' || bad.has(f.stampId)) continue;
			const before = squash(charsIn(m, da, bounds, f.shown));
			const after = squash(charsIn(m, db, bounds, f.shown));
			if (before.length - after.length !== squash(f.value).length) bad.set(f.stampId, 'the page content still has the text');
		}
	} finally {
		destroy(xa);
		destroy(xb);
		destroy(da);
		destroy(db);
		destroy(pa);
		destroy(pb);
	}
	return bad;
}

/** 'blank-fields' check on the final file: every field reads back in MuPDF and PDF.js. */
export async function verifyBlankFields(deps: EngineDeps, finalBytes: Uint8Array, made: MadeField[], password?: string): Promise<VerifyCheck> {
	const problems: string[] = [];
	try {
		const m = await deps.mupdf();
		const doc = new m.PDFDocument(finalBytes);
		try {
			if (doc.needsPassword() && (password === undefined || doc.authenticatePassword(password) === 0)) problems.push('MuPDF could not open the file');
			else {
				for (const why of mupdfReadBack(m, doc, made).values()) problems.push(why);
				const need = doc.getTrailer().get('Root').get('AcroForm').get('NeedAppearances');
				if (need.isBoolean() && need.asBoolean()) problems.push('the file asks viewers to redraw its fields');
			}
		} finally {
			destroy(doc);
		}
		for (const why of (await pdfjsReadBack(deps, finalBytes, made, password)).values()) problems.push(why);
	} catch (e) {
		problems.push(`the fields could not be read back (${e instanceof Error ? e.message : String(e)})`);
	}
	if (problems.length) {
		return { name: 'blank-fields', ok: false, detail: `Filled blanks did not read back as form fields: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; …' : ''}.` };
	}
	const n = made.length;
	return { name: 'blank-fields', ok: true, detail: `${n} filled ${n === 1 ? 'blank is a form field' : 'blanks are form fields'}, read back by MuPDF and PDF.js.` };
}
