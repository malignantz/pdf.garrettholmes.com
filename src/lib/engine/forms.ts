/**
 * AcroForm fields: detect at intake, list for the UI, write answers (and
 * optionally flatten) at export, read them back from the final file.
 *
 * What is fillable ("avoid, don't fail"; tests in tests/engine/forms*.test.ts):
 *
 * - text: plain single-line, multiline, MaxLen and comb fields. MuPDF draws every text
 *   appearance with a non-embedded standard font in WinAnsiEncoding, whatever font the
 *   form names, and switches to fallback fonts other viewers lack for anything else. So
 *   answers may only use WinAnsi characters (Latin-1 plus a few typographic ones). After
 *   drawing, the appearance's own text is extracted and must equal the answer: text the
 *   box cuts off (fixed font size, too many lines) is refused. Fields with format or
 *   keystroke scripts (dates, numbers) are filled with the text as typed; their scripts
 *   stay in the file but are not run, and the export says so.
 * - checkbox, radio: written as /V and /AS, using the widgets' own on/off appearances
 *   (never redrawn). Radio option names follow PDF.js (the /Opt export value when there is
 *   one, else the appearance state name), so the preview, `FormWidget.option` and
 *   `FormField.value` share one vocabulary.
 * - choice: combo boxes. MuPDF draws the export value, so it is given the option's label
 *   to draw and /V is set to the export value afterwards. List boxes are read-only: MuPDF
 *   draws them empty.
 * - read-only: the read-only flag, a calculate action (/AA /C), listed in /AcroForm /CO,
 *   list boxes, comb fields without MaxLen or with a rotated widget (/MK /R), choice
 *   fields without options or with repeated export values.
 * - not listed: signature fields, push buttons, password, file-select and rich-text
 *   fields, fields whose widgets are all hidden, NoView, zero-size or off the page, fields
 *   whose widgets disagree about type or field object, buttons without exactly one
 *   on-state appearance stream per widget. XFA forms list nothing (hasForm false, intake note).
 *
 * The assemble step (assemble.ts) edits a single source with a form in place when each
 * page is used at most once: the field tree and names stay as they are (/XFA and document
 * scripts are dropped). Otherwise qpdf `--empty --pages` copies form fields page by page: a
 * field with widgets on several pages becomes one field per page ("shared", "shared+1"),
 * a repeated page or a second copy of the same file gets renamed copies, and /CO, /XFA and
 * document scripts are not carried over. Either way assembled widgets are mapped back to source fields by
 * position, never by name: output page i shows source page ctx.pages[i], and its widgets
 * must match that page's widgets one for one, in order, by field type and /Rect, or the
 * export stops (EngineError 'internal'). Every copy of a widget of an answered source
 * field gets the answer.
 */

import type { FormField, FormValue, FormValues, FormWidget, Rotation, Source, StampBox, VerifyCheck } from '../core/types';
import type { EngineDeps } from './deps';
import { EngineError } from './errors';
import { displayedUserSize, normalizeRotation, visibleBox, type Box } from './geometry';
import type { Mupdf } from './mupdf';
import type { PdfjsLib } from './pdfjs';
import { QPDF_OK, QPDF_WARNINGS } from './qpdf';

/** One output page of the plan, in order: page i of the assembled file. */
export interface FormsPage {
	source: Source;
	/** 0-based index into source.pages. */
	pageIndex: number;
	/** PageRef.rotation the assemble step applied. */
	rotation: Rotation;
}

export interface FormsContext {
	pages: FormsPage[];
	/** plan.formValues limited to the sources this plan uses ({} when none). */
	formValues: FormValues;
	/** Turn fields into page content: options.flattenForms, or forced because the plan has a redaction. */
	flatten: boolean;
	/**
	 * Redaction boxes per output page (fractions of the displayed page). A flattened answer
	 * under one is meant to be gone, so the final check does not look for it on the page.
	 */
	redactions?: StampBox[][];
}

export const FORM_UNREADABLE_NOTE = 'This file’s form fields are malformed, so they cannot be filled here.';
export const XFA_NOTE = 'This is an XFA form. Its fields cannot be filled here.';
export const CALC_WARNING = 'This form calculates some fields itself. Totals were not recalculated; check them.';
export const FORMAT_WARNING =
	'Some form answers were saved exactly as typed; the form’s own formatting of dates and numbers was not applied. Check them.';

/** True when the forms stage has anything to do for this plan. */
export function formsNeeded(ctx: FormsContext): boolean {
	return ctx.flatten || Object.values(ctx.formValues).some((v) => Object.keys(v).length > 0);
}

// ---------------------------------------------------------------------------
// MuPDF types and small helpers.

type M = Mupdf;
type MDoc = InstanceType<M['PDFDocument']>;
type MObj = InstanceType<M['PDFObject']>;
type MWidget = InstanceType<M['PDFWidget']>;

// Field flags (ISO 32000-1, 12.7.3.1, 12.7.4).
const FF_READ_ONLY = 1;
const FF_MULTILINE = 1 << 12;
const FF_PASSWORD = 1 << 13;
const FF_FILE_SELECT = 1 << 20;
const FF_MULTI_SELECT = 1 << 21;
const FF_COMB = 1 << 24;
const FF_RICH_TEXT = 1 << 25;
// Annotation flags.
const AF_HIDDEN = 2;
const AF_NO_VIEW = 32;

const RECT_TOLERANCE = 0.01;

function get(o: MObj | null | undefined, ...keys: string[]): MObj | null {
	let cur: MObj | null | undefined = o;
	for (const k of keys) {
		if (!cur || !cur.isDictionary()) return null;
		cur = cur.get(k);
		if (cur.isNull()) return null;
	}
	return cur ?? null;
}

function text(o: MObj | null): string | null {
	if (!o) return null;
	if (o.isString()) return o.asString();
	if (o.isName()) return o.asName();
	return null;
}

function numbers(o: MObj | null): number[] | null {
	if (!o || !o.isArray()) return null;
	const out: number[] = [];
	for (let i = 0; i < o.length; i++) {
		const v = o.get(i);
		if (!v.isNumber()) return null;
		out.push(v.asNumber());
	}
	return out;
}

function arrayItems(o: MObj | null): MObj[] {
	if (!o || !o.isArray()) return [];
	const out: MObj[] = [];
	for (let i = 0; i < o.length; i++) out.push(o.get(i));
	return out;
}

function rectOf(o: MObj): Box | null {
	const r = numbers(get(o, 'Rect'));
	if (!r || r.length !== 4 || !r.every(Number.isFinite)) return null;
	return { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) };
}

/** The terminal field a widget belongs to: the widget itself when it carries /T, else its /Parent. */
function terminalOf(o: MObj): MObj {
	if (get(o, 'T')) return o;
	return get(o, 'Parent') ?? o;
}

function objId(o: MObj): number {
	return o.isIndirect() ? o.asIndirect() : 0;
}

/** Appearance states of a widget's normal appearance (keys of /AP /N when it is a dictionary). */
function apStates(o: MObj): string[] | null {
	const n = get(o, 'AP', 'N');
	if (!n || n.isStream() || !n.isDictionary()) return null;
	const keys: string[] = [];
	n.forEach((_v, k) => keys.push(String(k)));
	return keys;
}

/** The widget's normal appearance for `state` is a stream (not missing, null or a name). */
function stateDrawn(o: MObj, state: string): boolean {
	const s = get(o, 'AP', 'N', state);
	return s !== null && s.isStream();
}

/** The normal appearance stream a widget currently shows, or null. */
function normalStream(o: MObj): MObj | null {
	const n = get(o, 'AP', 'N');
	if (!n) return null;
	if (n.isStream()) return n;
	const as = text(get(o, 'AS'));
	const s = n.isDictionary() && as !== null ? get(n, as) : null;
	return s && s.isStream() ? s : null;
}

function hasNormalStream(o: MObj): boolean {
	return normalStream(o) !== null;
}

/** The current appearance has an area to draw in (/BBox with a positive width and height). */
function hasDrawableAppearance(o: MObj): boolean {
	const s = normalStream(o);
	const b = numbers(get(s, 'BBox'));
	return b !== null && b.length === 4 && Math.abs(b[2] - b[0]) > 0 && Math.abs(b[3] - b[1]) > 0;
}

function action(o: MObj, key: string): boolean {
	return get(o, 'AA', key) !== null;
}

function sameBox(a: Box, b: Box): boolean {
	return (
		Math.abs(a.x0 - b.x0) <= RECT_TOLERANCE &&
		Math.abs(a.y0 - b.y0) <= RECT_TOLERANCE &&
		Math.abs(a.x1 - b.x1) <= RECT_TOLERANCE &&
		Math.abs(a.y1 - b.y1) <= RECT_TOLERANCE
	);
}

type MPage = ReturnType<MDoc['loadPage']>;
const loadedPages = new WeakMap<MDoc, MPage[]>();

/**
 * Page i of a MuPDF document, loaded once and kept for the document's lifetime. A widget
 * stays usable only while its page object is alive: MuPDF.js frees a page whose JS object
 * was garbage-collected, and the page's widgets then fail ("annotation not bound to any
 * page"), depending on when the collector runs.
 */
function pageOf(doc: MDoc, i: number): MPage {
	let pages = loadedPages.get(doc);
	if (!pages) loadedPages.set(doc, (pages = []));
	return (pages[i] ??= doc.loadPage(i));
}

/** Frees a document and the pages pageOf kept for it (pages first). */
function closeDoc(doc: MDoc | null) {
	if (!doc) return;
	for (const p of loadedPages.get(doc) ?? []) destroy(p);
	loadedPages.delete(doc);
	destroy(doc);
}

function destroy(x: { destroy?: () => void } | null | undefined) {
	try {
		x?.destroy?.();
	} catch {
		// already gone
	}
}

// ---------------------------------------------------------------------------
// Characters MuPDF's text appearances draw in every viewer: WinAnsiEncoding.

const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

function drawable(ch: string): boolean {
	const c = ch.codePointAt(0)!;
	if (c >= 0x20 && c <= 0x7e) return true;
	if (c >= 0xa0 && c <= 0xff && c !== 0xad) return true;
	return WINANSI_EXTRA.includes(ch);
}

/** Characters of `s` (line breaks aside) a form text appearance cannot draw, each listed once. */
export function undrawableChars(s: string): string {
	const bad = new Set<string>();
	for (const ch of s) if (ch !== '\n' && !drawable(ch)) bad.add(ch);
	return [...bad].join(' ');
}

// ---------------------------------------------------------------------------
// Analysis of a source's form.

interface WidgetRec {
	/** MuPDF field type of the widget. */
	type: string;
	rect: Box | null;
	/** Name of the listed field this widget belongs to, or null. */
	field: string | null;
	/** Shown on the page: not hidden, and some of it is on the page. */
	visible: boolean;
	/** checkbox/radio: this widget's on-state name. */
	state?: string;
	/** radio: the option this widget selects. */
	option?: string;
}

interface FieldRec {
	field: FormField;
	/** checkbox: on-state name. */
	onState?: string;
	/** radio: option -> on-state name. */
	stateOf?: Map<string, string>;
	/** choice: export value -> label. */
	labelOf?: Map<string, string>;
	comb: boolean;
	/** Has format or keystroke scripts. */
	formatted: boolean;
}

interface FormAnalysis {
	xfa: boolean;
	/** The form computes some fields itself (/CO or a calculate action). */
	calculates: boolean;
	fields: FieldRec[];
	byName: Map<string, FieldRec>;
	/** Every widget of every page, in MuPDF getWidgets() order. */
	pages: WidgetRec[][];
}

const EMPTY: FormAnalysis = { xfa: false, calculates: false, fields: [], byName: new Map(), pages: [] };

interface RawWidget {
	w: MWidget;
	o: MObj;
	term: MObj;
	pageIndex: number;
	rec: WidgetRec;
	box: FormWidget['box'] | null;
}

/** Fractions of the displayed page covered by a PDF-space rect, clipped to the page; null if nothing shows. */
export function widgetBox(r: Box, page: Box, rotation: Rotation): FormWidget['box'] | null {
	const toDisplay = (x: number, y: number): [number, number] => {
		switch (rotation) {
			case 0:
				return [x - page.x0, page.y1 - y];
			case 90:
				return [y - page.y0, x - page.x0];
			case 180:
				return [page.x1 - x, y - page.y0];
			case 270:
				return [page.y1 - y, page.x1 - x];
		}
	};
	const size = displayedUserSize(page, rotation);
	const [ax, ay] = toDisplay(r.x0, r.y0);
	const [bx, by] = toDisplay(r.x1, r.y1);
	const clip = (v: number, max: number) => Math.min(Math.max(v, 0), max);
	const x0 = clip(Math.min(ax, bx), size.width);
	const x1 = clip(Math.max(ax, bx), size.width);
	const y0 = clip(Math.min(ay, by), size.height);
	const y1 = clip(Math.max(ay, by), size.height);
	if (x1 - x0 < 1 || y1 - y0 < 1) return null;
	const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
	return { x: r6(x0 / size.width), y: r6(y0 / size.height), w: r6((x1 - x0) / size.width), h: r6((y1 - y0) / size.height) };
}

function analyzeDoc(doc: MDoc): FormAnalysis {
	const af = get(doc.getTrailer(), 'Root', 'AcroForm');
	if (!af) return EMPTY;
	const xfa = get(af, 'XFA') !== null;
	const co = new Set(arrayItems(get(af, 'CO')).map(objId).filter((n) => n > 0));
	let calculates = co.size > 0;

	const pages: WidgetRec[][] = [];
	const groups = new Map<string, RawWidget[]>();
	const n = doc.countPages();
	for (let i = 0; i < n; i++) {
		const page = pageOf(doc, i);
		const pobj = page.getObject();
		const box = visibleBox(numbers(pobj.getInheritable('MediaBox')), numbers(pobj.getInheritable('CropBox')));
		const rot = pobj.getInheritable('Rotate');
		const rotation = normalizeRotation(rot.isNumber() ? rot.asNumber() : 0);
		const recs: WidgetRec[] = [];
		for (const w of page.getWidgets()) {
			const o = w.getObject();
			const rect = rectOf(o);
			const shown = rect && (w.getFlags() & (AF_HIDDEN | AF_NO_VIEW)) === 0 ? widgetBox(rect, box, rotation) : null;
			const rec: WidgetRec = { type: w.getFieldType(), rect, field: null, visible: shown !== null };
			recs.push(rec);
			const term = terminalOf(o);
			if (action(term, 'C') || action(o, 'C')) calculates = true;
			const name = w.getName();
			const list = groups.get(name) ?? [];
			list.push({ w, o, term, pageIndex: i, rec, box: shown });
			groups.set(name, list);
		}
		pages.push(recs);
	}

	const fields: FieldRec[] = [];
	for (const [name, ws] of groups) {
		const rec = fieldOf(name, ws, co);
		if (!rec) continue;
		for (const raw of ws) raw.rec.field = name;
		fields.push(rec);
	}
	return { xfa, calculates, fields, byName: new Map(fields.map((f) => [f.field.name, f])), pages };
}

const KINDS: Record<string, FormField['kind']> = {
	text: 'text',
	checkbox: 'checkbox',
	radiobutton: 'radio',
	combobox: 'choice',
	listbox: 'choice'
};

/** The listed field for the widgets sharing one name, or null when the app does not list it. */
function fieldOf(name: string, ws: RawWidget[], co: Set<number>): FieldRec | null {
	if (name === '') return null;
	const first = ws[0];
	const type = first.rec.type;
	const kind = KINDS[type];
	if (!kind) return null; // signature, push button, unknown
	const termId = objId(first.term);
	if (termId === 0 || ws.some((x) => x.rec.type !== type || objId(x.term) !== termId || x.rec.rect === null)) return null;
	const flags = first.w.getFieldFlags();
	if (kind === 'text' && flags & (FF_PASSWORD | FF_FILE_SELECT | FF_RICH_TEXT)) return null;
	if (!ws.some((x) => x.box !== null)) return null;

	const term = first.term;
	let readOnly = (flags & FF_READ_ONLY) !== 0 || ws.some((x) => action(x.term, 'C') || action(x.o, 'C'));
	let t: MObj | null = term;
	for (let depth = 0; t && depth < 32; depth++) {
		if (co.has(objId(t))) readOnly = true;
		t = get(t, 'Parent');
	}
	const formatted = ws.some((x) => ['F', 'K'].some((k) => action(x.term, k) || action(x.o, k)));
	const tu = text(get(term, 'TU'));
	const label = tu !== null && tu.trim() !== '' && tu !== name ? tu : undefined;
	const widgets = (option?: (x: RawWidget) => string): FormWidget[] =>
		ws.flatMap((x) => (x.box ? [{ pageIndex: x.pageIndex, box: x.box, ...(option ? { option: option(x) } : {}) }] : []));
	const base = (value: FormValue, extra: Partial<FormField> = {}): FormField => ({
		name,
		kind,
		...(label !== undefined ? { label } : {}),
		value,
		readOnly,
		...extra,
		widgets: []
	});

	if (kind === 'text') {
		const maxLen = first.w.getMaxLen();
		const comb = (flags & FF_COMB) !== 0 && (flags & FF_MULTILINE) === 0;
		if (comb) {
			const rotated = ws.some((x) => {
				const r = get(x.o, 'MK', 'R');
				return r !== null && r.isNumber() && r.asNumber() % 360 !== 0;
			});
			if (maxLen <= 0 || rotated) readOnly = true;
		}
		const field = base(first.w.getValue().replace(/\r\n?/g, '\n'), {
			readOnly,
			multiline: (flags & FF_MULTILINE) !== 0,
			...(maxLen > 0 ? { maxLength: maxLen } : {})
		});
		field.widgets = widgets();
		return { field, comb, formatted };
	}

	if (kind === 'checkbox') {
		const on = new Set<string>();
		for (const x of ws) {
			const states = apStates(x.o)?.filter((s) => s !== 'Off') ?? [];
			if (states.length !== 1 || !stateDrawn(x.o, states[0])) return null;
			on.add(states[0]);
			x.rec.state = states[0];
		}
		if (on.size !== 1) return null;
		const onState = [...on][0];
		// Ticked when the value is the on-state; any other value (e.g. /0 beside an on-state
		// /1) shows the box clear.
		const field = base(first.w.getValue() === onState);
		field.widgets = widgets();
		return { field, onState, comb: false, formatted };
	}

	if (kind === 'radio') {
		for (const x of ws) {
			const states = apStates(x.o)?.filter((s) => s !== 'Off') ?? [];
			if (states.length !== 1 || !stateDrawn(x.o, states[0])) return null;
			x.rec.state = states[0];
		}
		// Export values by the rules of PDF.js (ButtonWidgetAnnotation._getExportValue), so the
		// preview and this list agree: the widget's position in /Kids indexes /Opt, then the
		// first kid with the same state, then a state name that is a number.
		const opt = get(term, 'Opt');
		const optTexts = opt && opt.isArray() ? arrayItems(opt).map((o) => text(o.isArray() ? o.get(0) : o)) : null;
		const kids = arrayItems(get(term, 'Kids')).map(objId);
		const inOpt = (i: number) => optTexts !== null && i >= 0 && i < optTexts.length;
		const kidIndex = (x: RawWidget) => kids.indexOf(objId(x.o));
		const stateToIndex = new Map<string, number>();
		for (const x of ws) {
			const i = kidIndex(x);
			if (inOpt(i) && !stateToIndex.has(x.rec.state!)) stateToIndex.set(x.rec.state!, i);
		}
		const fromIndex = (i: number | undefined) => (i !== undefined && inOpt(i) ? optTexts![i] : null);
		const exportOf = (state: string, current?: number): string => {
			if (!optTexts) return state;
			const idx = Number.parseInt(state, 10);
			return fromIndex(current) || fromIndex(stateToIndex.get(state)) || (String(idx) === state && fromIndex(idx)) || state;
		};
		const stateOf = new Map<string, string>();
		for (const x of ws) {
			const option = exportOf(x.rec.state!, kidIndex(x));
			x.rec.option = option;
			const prev = stateOf.get(option);
			if (prev !== undefined && prev !== x.rec.state) return null; // one option, two states: ambiguous
			stateOf.set(option, x.rec.state!);
		}
		const optionOfState = new Map([...stateOf].map(([o, s]) => [s, o]));
		if (optionOfState.size !== stateOf.size) return null; // one state, two options
		const field = base(optionOfState.get(first.w.getValue()) ?? '');
		field.widgets = widgets((x) => x.rec.option!);
		return { field, stateOf, comb: false, formatted };
	}

	// choice
	const labels = first.w.getOptions(false);
	const values = first.w.getOptions(true);
	if (labels.length !== values.length) return null;
	const listBox = type === 'listbox';
	const options = values.map((value, i) => ({ value, label: labels[i] }));
	const labelOf = new Map(options.map((o) => [o.value, o.label]));
	if (listBox || options.length === 0 || labelOf.size !== options.length) readOnly = true;
	const field = base(choiceValue(term), {
		readOnly,
		options,
		...(listBox && flags & FF_MULTI_SELECT ? { multiSelect: true } : {})
	});
	field.widgets = widgets();
	return { field, labelOf, comb: false, formatted };
}

/** Selected export values of a choice field: /V as one string or an array of strings. */
function choiceValue(term: MObj): string[] {
	const v = term.getInheritable('V');
	const all = v.isArray() ? arrayItems(v).map(text) : [text(v)];
	return all.filter((x): x is string => x !== null && x !== '');
}

const analyses = new WeakMap<Uint8Array, Promise<FormAnalysis>>();

/** Form analysis of a source's bytes, computed once per byte array. */
function analyzeSource(deps: EngineDeps, bytes: Uint8Array): Promise<FormAnalysis> {
	let p = analyses.get(bytes);
	if (!p) {
		p = (async () => {
			const m = await deps.mupdf();
			const doc = new m.PDFDocument(bytes);
			try {
				return analyzeDoc(doc);
			} finally {
				closeDoc(doc);
			}
		})();
		p.catch(() => analyses.delete(bytes));
		analyses.set(bytes, p);
	}
	return p;
}

/**
 * Cheap check with qpdf: does the file have an /AcroForm with at least one text, button
 * or choice widget on a page? (A form without such widgets cannot have a fillable field;
 * an XFA form without them gets no XFA note from here, only PDF.js's intake note.)
 */
async function mayHaveForm(deps: EngineDeps, bytes: Uint8Array): Promise<boolean> {
	const res = await deps.qpdf.run({
		args: ['--json=2', '--json-key=acroform', '/f.pdf', '/f.json'],
		inputs: { '/f.pdf': bytes },
		outputs: ['/f.json']
	});
	const file = res.files.get('/f.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return true; // unsure: let MuPDF look
	try {
		type QpdfField = { istext?: boolean; ischeckbox?: boolean; isradiobutton?: boolean; ischoice?: boolean };
		const json = JSON.parse(new TextDecoder().decode(file)) as { acroform?: { hasacroform?: boolean; fields?: QpdfField[] } };
		const af = json.acroform;
		if (!af || af.hasacroform !== true) return false;
		return (af.fields ?? []).some((f) => f.istext || f.ischeckbox || f.isradiobutton || f.ischoice);
	} catch {
		return true;
	}
}

// ---------------------------------------------------------------------------
// Intake and listing.

/**
 * Called by openPdf on the normalized bytes. Cheap: qpdf says whether there is an
 * /AcroForm with form widgets, and MuPDF is loaded only when there is.
 */
export async function detectForm(deps: EngineDeps, bytes: Uint8Array): Promise<{ hasForm: boolean; notes: string[] }> {
	if (!(await mayHaveForm(deps, bytes))) return { hasForm: false, notes: [] };
	let an: FormAnalysis;
	try {
		an = await analyzeSource(deps, bytes);
	} catch (e) {
		if (e instanceof EngineError) throw e;
		// MuPDF cannot read the form's pages (malformed field or page objects). The pages
		// themselves may still open and export; the form is just not offered for filling.
		return { hasForm: false, notes: [FORM_UNREADABLE_NOTE] };
	}
	if (an.xfa) return { hasForm: false, notes: [XFA_NOTE] };
	return { hasForm: an.fields.some((f) => !f.field.readOnly), notes: [] };
}

/** Fillable fields of a source (Engine.formFields). */
export async function listFormFields(deps: EngineDeps, source: Source): Promise<FormField[]> {
	if (source.kind !== 'pdf') return [];
	const an = await analyzeSource(deps, source.bytes);
	if (an.xfa) return [];
	return an.fields.map((f) => structuredClone(f.field));
}

// ---------------------------------------------------------------------------
// Answers.

interface Answer {
	rec: FieldRec;
	/** Normalized value. */
	value: FormValue;
	/** False when the value equals what the file already has: nothing is written. */
	write: boolean;
}

interface SourceAnswers {
	an: FormAnalysis;
	answers: Map<string, Answer>;
}

function fieldTitle(f: FormField) {
	return `“${f.label ?? f.name}”`;
}

function sameValue(a: FormValue, b: FormValue): boolean {
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
	return a === b;
}

function normalizeAnswer(rec: FieldRec, raw: FormValue, source: Source): FormValue {
	const f = rec.field;
	const where = `${fieldTitle(f)} in ${source.name}`;
	const wrongType = () => new EngineError('unsupported', `The answer for ${where} is not the right kind of value.`);
	switch (f.kind) {
		case 'text': {
			if (typeof raw !== 'string') throw wrongType();
			const v = raw.normalize('NFC').replace(/\r\n?/g, '\n');
			if (!f.multiline && v.includes('\n')) {
				throw new EngineError('unsupported', `${where} takes a single line. Remove the line breaks.`);
			}
			if (/\p{Cc}/u.test(v.replace(/\n/g, ''))) {
				throw new EngineError('unsupported', `The answer for ${where} contains invisible characters. Remove them.`);
			}
			const bad = undrawableChars(v);
			if (bad) throw new EngineError('unsupported', `${where} cannot show these characters: ${bad}`);
			if (f.maxLength !== undefined && [...v].length > f.maxLength) {
				throw new EngineError('unsupported', `${where} takes at most ${f.maxLength} characters.`);
			}
			return v;
		}
		case 'checkbox':
			if (typeof raw !== 'boolean') throw wrongType();
			return raw;
		case 'radio':
			if (typeof raw !== 'string') throw wrongType();
			if (raw !== '' && !rec.stateOf!.has(raw)) throw new EngineError('unsupported', `“${raw}” is not one of the choices of ${where}.`);
			return raw;
		case 'choice': {
			if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) throw wrongType();
			const values = [...new Set(raw)];
			if (values.length > 1 && !f.multiSelect) throw new EngineError('unsupported', `${where} takes only one choice.`);
			for (const v of values) {
				if (!rec.labelOf!.has(v)) throw new EngineError('unsupported', `“${v}” is not one of the choices of ${where}.`);
			}
			return values;
		}
	}
}

/** Answers per source, checked against the source's own fields. */
async function collectAnswers(deps: EngineDeps, ctx: FormsContext): Promise<Map<Source, SourceAnswers>> {
	const out = new Map<Source, SourceAnswers>();
	const sources = new Map<string, Source>();
	for (const p of ctx.pages) sources.set(p.source.id, p.source);
	for (const [id, values] of Object.entries(ctx.formValues)) {
		const names = Object.keys(values);
		const source = sources.get(id);
		if (names.length === 0 || !source) continue;
		const an = source.kind === 'pdf' ? await analyzeSource(deps, source.bytes) : EMPTY;
		if (an.xfa) throw new EngineError('unsupported', `${source.name}: ${XFA_NOTE}`);
		const answers = new Map<string, Answer>();
		for (const name of names) {
			const rec = an.byName.get(name);
			if (!rec) throw new EngineError('unsupported', `${source.name} has no form field named “${name}”.`);
			const value = normalizeAnswer(rec, values[name], source);
			const write = !sameValue(value, rec.field.value);
			if (write && rec.field.readOnly) {
				throw new EngineError('unsupported', `${fieldTitle(rec.field)} in ${source.name} cannot be changed.`);
			}
			answers.set(name, { rec, value, write });
		}
		out.set(source, { an, answers });
	}
	return out;
}

/** True when the widgets of an output page are exactly those of its source page. */
function sameWidgets(widgets: MWidget[], src: WidgetRec[]): boolean {
	return (
		widgets.length === src.length &&
		widgets.every((w, k) => {
			const r = rectOf(w.getObject());
			return w.getFieldType() === src[k].type && r !== null && src[k].rect !== null && sameBox(r, src[k].rect!);
		})
	);
}

interface Target {
	/** Output page index. */
	page: number;
	widget: MWidget;
	rec: WidgetRec;
	answer: Answer;
	/** The source field (source id + name): answers of two sources never share one. */
	key: string;
}

/** Widgets of the assembled file that show source fields with an answer to write. */
function mapTargets(doc: MDoc, ctx: FormsContext, answers: Map<Source, SourceAnswers>): Target[] {
	const targets: Target[] = [];
	ctx.pages.forEach((p, i) => {
		const job = answers.get(p.source);
		if (!job) return;
		const src = job.an.pages[p.pageIndex] ?? [];
		const wanted = (r: WidgetRec) => (r.field !== null && job.answers.get(r.field)?.write === true ? job.answers.get(r.field)! : null);
		if (!src.some(wanted)) return;
		const widgets = pageOf(doc, i).getWidgets();
		if (!sameWidgets(widgets, src)) {
			throw new EngineError(
				'internal',
				`The form fields on page ${i + 1} could not be matched to the original file, so the form was not filled.`
			);
		}
		widgets.forEach((w, k) => {
			const answer = wanted(src[k]);
			if (answer) targets.push({ page: i, widget: w, rec: src[k], answer, key: `${p.source.id}\u0000${src[k].field}` });
		});
	});
	return targets;
}

/**
 * Targets grouped by the output field object they belong to. Throws when an output field
 * would mix widgets of different source fields, or has a widget on a page that we did not
 * map. (qpdf gives every per-page copy of a field all of the field's kids; the kids that
 * are on no page are invisible orphans and are left alone.)
 */
function byTerminal(doc: MDoc, targets: Target[]): Target[][] {
	const groups = new Map<number, Target[]>();
	for (const t of targets) {
		const id = objId(terminalOf(t.widget.getObject()));
		if (id === 0) throw new EngineError('internal', 'A form field in the assembled file has an unexpected structure.');
		const list = groups.get(id) ?? [];
		if (list.length && list[0].key !== t.key) {
			throw new EngineError('internal', 'Two form fields were merged when the pages were combined, so the form was not filled.');
		}
		list.push(t);
		groups.set(id, list);
	}
	const onPages = new Set<number>();
	for (let i = 0; i < doc.countPages(); i++) {
		for (const w of pageOf(doc, i).getWidgets()) onPages.add(objId(w.getObject()));
	}
	for (const list of groups.values()) {
		const ours = new Set(list.map((t) => objId(t.widget.getObject())));
		const term = terminalOf(list[0].widget.getObject());
		for (const kid of arrayItems(get(term, 'Kids'))) {
			const id = objId(kid);
			if (onPages.has(id) && !ours.has(id)) {
				throw new EngineError('internal', 'A form field in the assembled file has widgets that could not be matched, so the form was not filled.');
			}
		}
	}
	return [...groups.values()];
}

interface StextChar {
	c: string;
	quad: number[];
}

/** Characters a widget's appearance draws (clipped to what shows), in MuPDF page space. */
function appearanceChars(w: MWidget): StextChar[] {
	const dl = w.toDisplayList();
	const st = dl.toStructuredText('preserve-whitespace');
	const chars: StextChar[] = [];
	try {
		st.walk({
			onChar(c: string, _origin: unknown, _font: unknown, _size: unknown, quad: number[]) {
				if (c.trim() !== '') chars.push({ c, quad: [...quad] });
			}
		});
	} finally {
		destroy(st);
		destroy(dl);
	}
	return chars;
}

const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * What is wrong with a drawn text appearance, or null when it shows exactly `want`:
 * the same characters (line breaks aside), every glyph inside the widget, and for comb
 * fields one character per cell in consecutive cells.
 */
function appearanceProblem(w: MWidget, want: string, comb: number | null): 'does-not-fit' | 'comb' | null {
	const chars = appearanceChars(w);
	if (squash(chars.map((x) => x.c).join('')) !== squash(want)) return 'does-not-fit';
	const [x0, y0, x1, y1] = w.getRect();
	const tol = 1;
	for (const { quad } of chars) {
		// Along the line the glyph box must be inside; across it (the box is the font's full
		// ascent to descent) at least its middle half.
		const xs = [quad[0], quad[2], quad[4], quad[6]];
		const ys = [quad[1], quad[3], quad[5], quad[7]];
		const along = Math.abs(quad[2] - quad[0]) >= Math.abs(quad[3] - quad[1]);
		const inside = (vs: number[], lo: number, hi: number, strict: boolean) => {
			const a = Math.min(...vs);
			const b = Math.max(...vs);
			const q = strict ? 0 : (b - a) / 4;
			return a + q >= lo - tol && b - q <= hi + tol;
		};
		if (!inside(xs, x0, x1, along) || !inside(ys, y0, y1, !along)) return 'does-not-fit';
	}
	if (comb !== null && chars.length > 0) {
		// Cells run along the line of text (which is vertical in page space on a rotated page).
		const q0 = chars[0].quad;
		const horizontal = Math.abs(q0[2] - q0[0]) >= Math.abs(q0[3] - q0[1]);
		const start = horizontal ? x0 : y0;
		const cell = (horizontal ? x1 - x0 : y1 - y0) / comb;
		const cells = chars.map(({ quad }) => {
			const vs = horizontal ? [quad[0], quad[2], quad[4], quad[6]] : [quad[1], quad[3], quad[5], quad[7]];
			const lo = Math.floor((Math.min(...vs) - start + 0.5) / cell);
			const hi = Math.floor((Math.max(...vs) - start - 0.5) / cell);
			return lo === hi ? lo : -1;
		});
		// Each drawn character sits in the cell of its position in the answer (spaces take a
		// cell but draw nothing).
		const pos = [...want].flatMap((ch, i) => (ch.trim() !== '' ? [i] : []));
		const dir = cells.length > 1 && cells[1] < cells[0] ? -1 : 1;
		if (pos.length !== cells.length) return 'comb';
		if (cells.some((c, i) => c < 0 || c >= comb || c - cells[0] !== dir * (pos[i] - pos[0]))) return 'comb';
	}
	return null;
}

const DA_SIZE = /(\/\S+\s+)(-?[\d.]+)(\s+Tf)/;
const MIN_AUTO_SIZE = 4;

/**
 * A text field with an automatic font size (/DA "... 0 Tf") is drawn at whatever size fits,
 * as Acrobat does. MuPDF draws multiline auto-size fields at a fixed 12 pt, so an answer that
 * does not fit is redrawn at smaller sizes (half a point at a time, down to 4 pt) until it
 * does. The field keeps its automatic size for later edits: only the appearance is drawn at
 * the chosen size. Fields with a fixed size are left as drawn.
 */
function shrinkAutoSize(doc: MDoc, w: MWidget, want: string, comb: number | null): 'does-not-fit' | 'comb' | null {
	const o = w.getObject();
	const own = get(o, 'DA');
	const da = text(own) ?? text(o.getInheritable('DA')) ?? text(get(doc.getTrailer(), 'Root', 'AcroForm', 'DA'));
	const m = da !== null ? DA_SIZE.exec(da) : null;
	if (!da || !m || Number(m[2]) !== 0) return 'does-not-fit';
	const [x0, y0, x1, y1] = w.getRect();
	const start = Math.min(12, Math.floor(Math.min(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) / 2);
	let result: 'does-not-fit' | 'comb' | null = 'does-not-fit';
	try {
		for (let size = start; size >= MIN_AUTO_SIZE; size -= 0.5) {
			o.put('DA', doc.newString(da.replace(DA_SIZE, `$1${size}$3`)));
			// MuPDF redraws only a changed field: set the value again to mark it changed.
			w.setTextValue(`${want} `);
			w.setTextValue(want);
			w.update();
			result = appearanceProblem(w, want, comb);
			if (result === null) break;
		}
	} finally {
		// Keep the automatic size in the field itself.
		if (own) o.put('DA', own);
		else o.delete('DA');
	}
	return result;
}

/** The appearance uses only standard, non-embedded Type1 fonts in WinAnsiEncoding. */
function appearanceFontsOk(o: MObj): boolean {
	const n = get(o, 'AP', 'N');
	if (!n || !n.isStream()) return false;
	const fonts = get(n, 'Resources', 'Font');
	if (!fonts) return true;
	let ok = true;
	fonts.forEach((f) => {
		const d = f.resolve();
		if (text(get(d, 'Subtype')) !== 'Type1' || text(get(d, 'Encoding')) !== 'WinAnsiEncoding' || get(d, 'FontDescriptor')) ok = false;
	});
	return ok;
}

/** The text a text or choice answer shows in its box. */
function shownText(a: Answer): string {
	const f = a.rec.field;
	if (f.kind === 'text') return a.value as string;
	if (f.kind === 'choice') {
		const v = a.value as string[];
		return v.length ? (a.rec.labelOf!.get(v[0]) ?? '') : '';
	}
	return '';
}

/**
 * The forms stage: writes ctx.formValues into the assembled file (`bytes`), draws real
 * appearances, and flattens when ctx.flatten. Export warnings (calculated fields,
 * scripted formats) are pushed onto `warnings`.
 */
export async function applyForms(
	deps: EngineDeps,
	bytes: Uint8Array,
	ctx: FormsContext,
	warnings: string[] = []
): Promise<Uint8Array> {
	const answers = await collectAnswers(deps, ctx);
	const writes = [...answers.values()].some((j) => [...j.answers.values()].some((a) => a.write));
	if (!writes && !ctx.flatten) return bytes;

	const m = await deps.mupdf();
	const doc = new m.PDFDocument(bytes);
	try {
		const groups = byTerminal(doc, mapTargets(doc, ctx, answers));
		const updated = new Set<number>();

		for (const list of groups) {
			const { rec, value } = list[0].answer;
			const f = rec.field;
			const term = terminalOf(list[0].widget.getObject());
			if (f.kind === 'text') {
				for (const t of list) {
					if (t.widget.setTextValue(value as string) !== 1) {
						throw new EngineError('unsupported', `${fieldTitle(f)} could not be filled in.`);
					}
				}
				for (const t of list) t.widget.update();
			} else if (f.kind === 'choice') {
				// MuPDF draws the value it is given: give it the label, then store the export value.
				const v = value as string[];
				const label = v.length ? rec.labelOf!.get(v[0])! : '';
				for (const t of list) t.widget.setChoiceValue(label);
				for (const t of list) t.widget.update();
				if (v.length) term.put('V', doc.newString(v[0]));
				else term.delete('V');
				term.delete('I');
			} else if (f.kind === 'checkbox') {
				const state = value === true ? rec.onState! : 'Off';
				term.put('V', doc.newName(state));
				for (const t of list) t.widget.getObject().put('AS', doc.newName(state));
			} else {
				let v = 'Off';
				for (const t of list) {
					const on = t.rec.option === value;
					if (on) v = t.rec.state!;
					t.widget.getObject().put('AS', doc.newName(on ? t.rec.state! : 'Off'));
				}
				term.put('V', doc.newName(v));
			}
			for (const t of list) updated.add(objId(t.widget.getObject()));
		}

		syncOffPageCopies(doc, groups);

		// Every drawn text appearance must show the whole answer.
		for (const list of groups) {
			const { rec } = list[0].answer;
			const f = rec.field;
			if (f.kind !== 'text' && f.kind !== 'choice') continue;
			for (const t of list) {
				if (!t.rec.visible) continue;
				if (!appearanceFontsOk(t.widget.getObject())) {
					throw new EngineError('unsupported', `${fieldTitle(f)} uses a font this app cannot fill in.`);
				}
				const comb = rec.comb ? (f.maxLength ?? null) : null;
				let problem = appearanceProblem(t.widget, shownText(t.answer), comb);
				if (problem === 'does-not-fit' && f.kind === 'text') problem = shrinkAutoSize(doc, t.widget, shownText(t.answer), comb);
				if (problem === 'comb') throw new EngineError('unsupported', `${fieldTitle(f)} could not be laid out in its boxes.`);
				if (problem) throw new EngineError('unsupported', `The answer for ${fieldTitle(f)} does not fit in its box. Shorten it.`);
			}
		}

		// Appearances must be real: draw the ones viewers were asked to make, then drop the request.
		const af = get(doc.getTrailer(), 'Root', 'AcroForm');
		const need = get(af, 'NeedAppearances');
		if (af && need) {
			if (need.isBoolean() && need.asBoolean()) drawRequested(doc, updated);
			af.delete('NeedAppearances');
		}

		if (ctx.flatten) flattenAll(doc);

		for (const job of answers.values()) {
			const wrote = [...job.answers.values()].filter((a) => a.write);
			if (wrote.length && job.an.calculates) warnings.push(CALC_WARNING);
			if (wrote.some((a) => a.rec.formatted)) warnings.push(FORMAT_WARNING);
		}
		// Not garbage=compact: renumbering copies objects that MuPDF.js still holds from JS and
		// writes copied streams without their data (docs/research/2026-11-10-mupdf-api.md).
		// Unreferenced objects are still dropped; qpdf renumbers at finalize.
		return doc.saveToBuffer('garbage=yes').asUint8Array().slice();
	} catch (e) {
		// MuPDF rejects malformed form or page objects with a plain Error (a WebAssembly trap is
		// a RuntimeError and is left to the engine's guard).
		if (e instanceof Error && !(e instanceof EngineError) && e.name === 'Error') {
			const err = new EngineError('unsupported', 'This file’s form fields are malformed, so they cannot be filled in or flattened. Nothing was saved.');
			(err as { cause?: unknown }).cause = e;
			throw err;
		}
		throw e;
	} finally {
		closeDoc(doc);
	}
}

/** Fully qualified field name of a field node, with qpdf's "+N" copy suffixes removed. */
function sourceName(o: MObj): string {
	const parts: string[] = [];
	let t: MObj | null = o;
	for (let depth = 0; t && depth < 32; depth++) {
		const name = text(get(t, 'T'));
		if (name !== null) parts.unshift(name.replace(/\+\d+$/, ''));
		t = get(t, 'Parent');
	}
	return parts.join('.');
}

/**
 * When a field has widgets on several pages, the assemble step gives each page its own
 * copy of the field ("name", "name+1"), and every copy keeps all the field's widgets: the
 * ones of other pages stay in the field tree, on no page. They are invisible, but a form
 * reader that looks fields up by name finds them, still holding the old answer. Give those
 * off-page copies of an answered field the same answer.
 */
function syncOffPageCopies(doc: MDoc, groups: Target[][]) {
	const af = get(doc.getTrailer(), 'Root', 'AcroForm');
	const fields = get(af, 'Fields');
	if (!fields || !fields.isArray() || groups.length === 0) return;
	const onPages = new Set<number>();
	for (let i = 0; i < doc.countPages(); i++) {
		for (const a of arrayItems(get(pageOf(doc, i).getObject(), 'Annots'))) onPages.add(objId(a));
	}
	// Answers by source field name; a name answered differently by two sources is left alone.
	const byName = new Map<string, Target[] | null>();
	const written = new Set<number>();
	for (const list of groups) {
		const term = terminalOf(list[0].widget.getObject());
		written.add(objId(term));
		const name = sourceName(term);
		const prev = byName.get(name);
		byName.set(name, prev === undefined || (prev !== null && sameValue(prev[0].answer.value, list[0].answer.value)) ? list : null);
	}
	const isWidget = (o: MObj) => text(get(o, 'Subtype')) === 'Widget';
	const visit = (node: MObj, depth: number) => {
		if (depth > 32 || !node.isDictionary()) return;
		const kids = arrayItems(get(node, 'Kids'));
		const fieldKids = kids.filter((k) => get(k, 'T') !== null);
		if (fieldKids.length) {
			for (const k of fieldKids) visit(k, depth + 1);
			return;
		}
		// A terminal field: its widgets are its kids, or the node itself.
		const widgets = kids.length ? kids : isWidget(node) ? [node] : [];
		if (written.has(objId(node)) || widgets.length === 0 || widgets.some((w) => onPages.has(objId(w)))) return;
		const list = byName.get(sourceName(node));
		if (!list) return;
		const { rec, value } = list[0].answer;
		const f = rec.field;
		if (f.kind === 'text') {
			node.put('V', doc.newString(value as string));
		} else if (f.kind === 'choice') {
			const v = value as string[];
			if (v.length) node.put('V', doc.newString(v[0]));
			else node.delete('V');
			node.delete('I');
		} else if (f.kind === 'checkbox') {
			const on = value === true;
			let state = 'Off';
			for (const w of widgets) {
				const s = apStates(w)?.filter((x) => x !== 'Off') ?? [];
				const ws = on && s.length === 1 ? s[0] : 'Off';
				if (ws !== 'Off') state = ws;
				w.put('AS', doc.newName(ws));
			}
			node.put('V', doc.newName(state));
		} else {
			const chosen = (value !== '' && rec.stateOf?.get(value as string)) || 'Off';
			for (const w of widgets) {
				const s = apStates(w)?.filter((x) => x !== 'Off') ?? [];
				w.put('AS', doc.newName(s.length === 1 && s[0] === chosen ? chosen : 'Off'));
			}
			node.put('V', doc.newName(chosen));
		}
	};
	for (const f of arrayItems(fields)) visit(f, 0);
}

/**
 * /NeedAppearances was set: viewers were asked to draw the fields themselves. Draw
 * plain text fields and combo boxes now, where MuPDF draws the value faithfully.
 */
function drawRequested(doc: MDoc, done: Set<number>) {
	for (let i = 0; i < doc.countPages(); i++) {
		for (const w of pageOf(doc, i).getWidgets()) {
			if (done.has(objId(w.getObject()))) continue;
			const type = w.getFieldType();
			const value = w.getValue();
			if (undrawableChars(value)) continue;
			if (type === 'text' && !(w.getFieldFlags() & (FF_PASSWORD | FF_FILE_SELECT | FF_RICH_TEXT))) {
				w.setTextValue(value);
				w.update();
			} else if (type === 'combobox') {
				const k = w.getOptions(true).indexOf(value);
				if (value !== '' && (k < 0 || w.getOptions(false)[k] !== value)) continue;
				w.setChoiceValue(value);
				w.update();
			}
		}
	}
}

/** Bake every shown widget into its page; drop the others and the form itself. */
function flattenAll(doc: MDoc) {
	for (let i = 0; i < doc.countPages(); i++) {
		const page = pageOf(doc, i);
		for (const w of page.getWidgets()) {
			// Hidden widgets and widgets without a usable appearance show nothing. Left in, MuPDF
			// would draw its own for the first and scale an empty /BBox to infinity for the second.
			if (w.getFlags() & (AF_HIDDEN | AF_NO_VIEW) || !hasDrawableAppearance(w.getObject())) page.deleteAnnotation(w);
		}
	}
	doc.bake(false, true);
	const root = get(doc.getTrailer(), 'Root');
	if (get(root, 'AcroForm')) root!.delete('AcroForm');
	// (MuPDF's loaded pages still list the baked widgets; the page objects are what is saved.)
	for (let i = 0; i < doc.countPages(); i++) {
		const annots = arrayItems(get(pageOf(doc, i).getObject(), 'Annots'));
		if (annots.some((a) => text(get(a, 'Subtype')) === 'Widget')) {
			throw new EngineError('internal', 'Some form fields could not be turned into page content.');
		}
	}
}

// ---------------------------------------------------------------------------
// Verification.

interface PdfjsAnnotation {
	subtype?: string;
	rect?: number[];
	fieldValue?: unknown;
	exportValue?: unknown;
	buttonValue?: unknown;
}

function openFinal(m: M, bytes: Uint8Array, password?: string): MDoc {
	const doc = new m.PDFDocument(bytes);
	if (doc.needsPassword() && (password === undefined || doc.authenticatePassword(password) === 0)) {
		closeDoc(doc);
		throw new EngineError('internal', 'MuPDF could not open the exported file.');
	}
	return doc;
}

/** The rendered appearance has contrast where its glyphs are. */
function inkUnder(m: M, w: MWidget, chars: StextChar[]): boolean {
	if (chars.length === 0) return false;
	const xs = chars.flatMap((c) => [c.quad[0], c.quad[2], c.quad[4], c.quad[6]]);
	const ys = chars.flatMap((c) => [c.quad[1], c.quad[3], c.quad[5], c.quad[7]]);
	const s = 2;
	const pix = w.toPixmap(m.Matrix.scale(s, s), m.ColorSpace.DeviceRGB, false);
	try {
		const px = pix.getPixels();
		const stride = pix.getStride();
		const nc = pix.getNumberOfComponents();
		const left = Math.max(0, Math.floor(Math.min(...xs) * s - pix.getX()));
		const right = Math.min(pix.getWidth(), Math.ceil(Math.max(...xs) * s - pix.getX()));
		const top = Math.max(0, Math.floor(Math.min(...ys) * s - pix.getY()));
		const bottom = Math.min(pix.getHeight(), Math.ceil(Math.max(...ys) * s - pix.getY()));
		let lo = 255;
		let hi = 0;
		for (let y = top; y < bottom; y++) {
			for (let x = left; x < right; x++) {
				const o = y * stride + x * nc;
				const lum = (px[o] * 3 + px[o + 1] * 6 + px[o + 2]) / 10;
				lo = Math.min(lo, lum);
				hi = Math.max(hi, lum);
			}
		}
		return hi - lo >= 64;
	} finally {
		destroy(pix);
	}
}

interface Expected {
	page: number;
	index: number;
	rec: WidgetRec;
	answer: Answer;
}

/** 'forms' check on the final file. Runs only when the forms stage ran. */
export async function verifyForms(
	deps: EngineDeps,
	finalBytes: Uint8Array,
	ctx: FormsContext,
	password?: string
): Promise<VerifyCheck[]> {
	const problems: string[] = [];
	const failed = (detail: string): VerifyCheck[] => [{ name: 'forms', ok: false, detail }];
	let answers: Map<Source, SourceAnswers>;
	try {
		answers = await collectAnswers(deps, ctx);
	} catch (e) {
		return failed(`The form answers could not be checked: ${e instanceof Error ? e.message : String(e)}`);
	}

	// Widgets of answered fields on each output page, from the source's own analysis.
	const expected: Expected[] = [];
	ctx.pages.forEach((p, i) => {
		const job = answers.get(p.source);
		(job?.an.pages[p.pageIndex] ?? []).forEach((rec, index) => {
			const answer = rec.field !== null ? job!.answers.get(rec.field) : undefined;
			if (answer) expected.push({ page: i, index, rec, answer });
		});
	});
	const answered = new Set(expected.map((e) => `${ctx.pages[e.page].source.id}\u0000${e.rec.field}`)).size;

	const [m, lib] = await Promise.all([deps.mupdf(), deps.pdfjs()]);
	let doc: MDoc | null = null;
	let task: ReturnType<PdfjsLib['getDocument']> | null = null;
	const found = new Set<string>();
	try {
		doc = openFinal(m, finalBytes, password);
		task = lib.getDocument({
			data: finalBytes.slice(),
			password,
			useWasm: false,
			useWorkerFetch: false,
			useSystemFonts: false,
			disableFontFace: true,
			enableXfa: false,
			verbosity: 0
		});
		const pdf = await task.promise;
		if (ctx.flatten) {
			if (get(doc.getTrailer(), 'Root', 'AcroForm')) problems.push('the file still has a form');
			for (let i = 0; i < doc.countPages(); i++) {
				if (pageOf(doc, i).getWidgets().length) problems.push(`page ${i + 1} still has form fields (MuPDF)`);
			}
			for (let i = 0; i < pdf.numPages; i++) {
				const page = await pdf.getPage(i + 1);
				if (((await page.getAnnotations()) as PdfjsAnnotation[]).some((a) => a.subtype === 'Widget')) {
					problems.push(`page ${i + 1} still has form fields (PDF.js)`);
				}
				const boxes = ctx.redactions?.[i] ?? [];
				let frame: { box: Box; rotation: Rotation } | null = null;
				if (boxes.length) {
					const pobj = pageOf(doc, i).getObject();
					const rot = pobj.getInheritable('Rotate');
					frame = {
						box: visibleBox(numbers(pobj.getInheritable('MediaBox')), numbers(pobj.getInheritable('CropBox'))),
						rotation: normalizeRotation(rot.isNumber() ? rot.asNumber() : 0)
					};
				}
				// An answer whose widget touches a redaction box is meant to be gone from the page.
				const redacted = (e: Expected) => {
					const wb = frame && e.rec.rect ? widgetBox(e.rec.rect, frame.box, frame.rotation) : null;
					return wb !== null && boxes.some((b) => b.x < wb.x + wb.w && wb.x < b.x + b.w && b.y < wb.y + wb.h && wb.y < b.y + b.h);
				};
				const mine = expected.filter((e) => e.page === i && e.rec.visible && squash(shownText(e.answer)) !== '' && !redacted(e));
				if (mine.length === 0) continue;
				const items = (await page.getTextContent()).items.flatMap((it) =>
					'str' in it ? [{ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number }] : []
				);
				for (const e of mine) {
					const r = e.rec.rect!;
					const pad = 2;
					const near = items
						.filter((it) => it.x >= r.x0 - pad && it.x <= r.x1 + pad && it.y >= r.y0 - pad && it.y <= r.y1 + pad)
						.map((it) => it.str)
						.join('');
					if (squash(near).includes(squash(shownText(e.answer)))) found.add(`${ctx.pages[i].source.id}\u0000${e.rec.field}`);
					else problems.push(`page ${i + 1}: the answer for ${fieldTitle(e.answer.rec.field)} is not on the page`);
				}
			}
		} else {
			const pages = [...new Set(expected.map((e) => e.page))];
			for (const i of pages) {
				const p = ctx.pages[i];
				const src = answers.get(p.source)!.an.pages[p.pageIndex];
				const widgets = pageOf(doc, i).getWidgets();
				if (!sameWidgets(widgets, src)) {
					problems.push(`page ${i + 1}: the form fields do not match the original page (MuPDF)`);
					continue;
				}
				const page = await pdf.getPage(i + 1);
				const pw = ((await page.getAnnotations()) as PdfjsAnnotation[]).filter((a) => a.subtype === 'Widget');
				const pdfjsOk =
					pw.length === src.length &&
					pw.every((a, k) => Array.isArray(a.rect) && sameBox({ x0: a.rect[0], y0: a.rect[1], x1: a.rect[2], y1: a.rect[3] }, src[k].rect!));
				if (!pdfjsOk) problems.push(`page ${i + 1}: the form fields do not match the original page (PDF.js)`);
				for (const e of expected.filter((x) => x.page === i)) {
					checkWidget(m, widgets[e.index], pdfjsOk ? pw[e.index] : undefined, e, (s) => problems.push(`page ${i + 1}: ${s}`));
				}
			}
			const need = get(doc.getTrailer(), 'Root', 'AcroForm', 'NeedAppearances');
			if (need && need.isBoolean() && need.asBoolean()) problems.push('the file still asks viewers to draw its fields');
		}
	} catch (e) {
		problems.push(`the file could not be read back (${e instanceof Error ? e.message : String(e)})`);
	} finally {
		closeDoc(doc);
		await task?.destroy().catch(() => undefined);
	}
	if (problems.length) {
		return failed(`Form answers did not read back: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; …' : ''}.`);
	}
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const detail = ctx.flatten
		? `Form fields turned into page content; ${plural(found.size, 'typed answer', 'typed answers')} found on the page.`
		: answered === 0
			? 'No form answers fall on the exported pages.'
			: `${plural(answered, 'form answer', 'form answers')} saved and read back.`;
	return [{ name: 'forms', ok: true, detail }];
}

/** Read one answered widget back with MuPDF and PDF.js; report each problem. */
function checkWidget(m: M, w: MWidget, pj: PdfjsAnnotation | undefined, e: Expected, problem: (s: string) => void) {
	const o = w.getObject();
	const f = e.answer.rec.field;
	const v = e.answer.value;
	const name = fieldTitle(f);
	const nl = (s: unknown) => String(s ?? '').replace(/\r\n?/g, '\n');
	if (f.kind === 'text') {
		if (nl(w.getValue()) !== v) problem(`${name} reads back differently (MuPDF)`);
		if (pj && nl(pj.fieldValue) !== v) problem(`${name} reads back differently (PDF.js)`);
	} else if (f.kind === 'checkbox') {
		const on = e.answer.rec.onState!;
		if ((text(get(o, 'AS')) === on) !== v || (w.getValue() === on) !== v) problem(`${name} is not ${v ? 'ticked' : 'clear'} (MuPDF)`);
		if (pj && (pj.fieldValue === pj.exportValue) !== v) problem(`${name} is not ${v ? 'ticked' : 'clear'} (PDF.js)`);
	} else if (f.kind === 'radio') {
		const on = e.rec.option === v;
		if ((text(get(o, 'AS')) === e.rec.state) !== on) problem(`${name} shows the wrong choice (MuPDF)`);
		if (pj && (pj.fieldValue === pj.buttonValue) !== on) problem(`${name} shows the wrong choice (PDF.js)`);
	} else {
		const want = v as string[];
		if (!sameValue(choiceValue(terminalOf(o)), want)) problem(`${name} reads back differently (MuPDF)`);
		if (pj) {
			const got = Array.isArray(pj.fieldValue) ? pj.fieldValue : pj.fieldValue ? [pj.fieldValue] : [];
			if (!sameValue(got.map(String), want)) problem(`${name} reads back differently (PDF.js)`);
		}
	}
	// Appearances are checked where this export drew them; an unchanged answer keeps the file's own.
	if (!e.rec.visible || !e.answer.write) return;
	if (!hasNormalStream(o)) {
		// A button's off state may have no appearance at all: it then shows nothing, as meant.
		const off = (f.kind === 'checkbox' && v === false) || (f.kind === 'radio' && e.rec.option !== v);
		if (!off) problem(`${name} has no appearance`);
		return;
	}
	if (f.kind === 'text' || f.kind === 'choice') {
		const want = shownText(e.answer);
		const chars = appearanceChars(w);
		if (squash(chars.map((x) => x.c).join('')) !== squash(want)) problem(`${name} does not show its answer`);
		else if (squash(want) !== '' && !inkUnder(m, w, chars)) problem(`${name} renders blank`);
	}
}
