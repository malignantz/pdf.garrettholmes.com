/**
 * Draws stamps onto an assembled PDF with pdf-lib.
 *
 * Every page that gets stamps has its content wrapped as
 *   [q × n] [original content…] [ET] [Q × m] [our stamps]
 * where n and m come from scanning the original content's q/Q nesting, so stamps are
 * drawn in the page's initial graphics state even when the original leaves a `cm`,
 * clip or an unclosed `q` behind; ET is added only when the original leaves a text
 * object open. A page whose content ends inside a string, array, dictionary or
 * inline image is refused: anything appended would be read as part of it.
 * Stamp geometry comes from geometry.ts.
 */

import type { Asset, PageSize, Stamp, VerifyCheck } from '../core/types';
import type * as PdfLib from '@cantoo/pdf-lib';
import { EngineError } from './errors';
import { graphicsNesting } from './content';
import {
	MARKS,
	STAMP_BASELINE_EM,
	STAMP_COLORS,
	STAMP_FONT,
	displayToPdf,
	displayedUserSize,
	highlightRadius,
	normalizeRotation,
	normalizeStampText,
	stampBoxMatrix,
	stampDisplayRect,
	stampPdfRect,
	uprightFrame,
	visibleBox,
	type Box,
	type Matrix
} from './geometry';
import type { Rotation } from '../core/types';
import { parsePng } from './images';
import { NUMBER_CAP_EM, numberLayout, type NumberingJob } from './numbering';
import {
	TEXT_MARGIN_PT,
	drFontNames,
	linked,
	makeWidget,
	onBlank,
	readAcroForm,
	registerFields,
	uniqueName,
	type BlankFieldsJob
} from './blank-fields';

export interface StampJob {
	/** 0-based page index in the assembled file. */
	pageIndex: number;
	stamps: Stamp[];
	/** Displayed size the plan expects for this page (PDF points, UserUnit applied). */
	expected: PageSize;
}

export interface StampDeps {
	lib: typeof PdfLib;
	fontkit: unknown;
	fontBytes: () => Promise<Uint8Array>;
}

/** Geometry pdf-lib sees for a page, mirroring PDF.js rules. */
export interface PageGeometry {
	box: Box;
	rotation: Rotation;
	userUnit: number;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export async function applyStamps(
	deps: StampDeps,
	bytes: Uint8Array,
	jobs: StampJob[],
	assets: Asset[],
	numbering?: NumberingJob,
	/** Receives plain-language warnings (e.g. a stamp lies under an annotation). */
	warnings?: string[],
	/** Keep filled blanks editable: these linked stamps become form fields (blank-fields.ts). */
	fields?: BlankFieldsJob
): Promise<Uint8Array> {
	const { lib } = deps;
	const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFRawStream, PDFContentStream, ParseSpeeds } = lib;
	const ops = lib;

	const doc = await PDFDocument.load(bytes, {
		updateMetadata: false,
		throwOnInvalidObject: true,
		parseSpeed: ParseSpeeds.Fastest
	});
	const ctx = doc.context;
	const pages = doc.getPages();

	// Pages that get stamps and/or a page number. Numbers need no StampJob.
	const work: StampJob[] = [];
	const jobByPage = new Map(jobs.map((j) => [j.pageIndex, j]));
	const pageCount = pages.length;
	for (let i = 0; i < pageCount; i++) {
		const job = jobByPage.get(i);
		const label = numbering?.labels[i] ?? null;
		if (job) work.push(job);
		else if (label !== null) work.push({ pageIndex: i, stamps: [], expected: numbering!.expected[i] });
	}
	for (const j of jobs) if (!pages[j.pageIndex]) work.push(j); // reported below

	const seen = new Set<string>();
	for (const job of work) {
		const ref = pages[job.pageIndex]?.ref;
		if (!ref) throw new EngineError('internal', 'A stamped page is missing from the assembled file.');
		if (seen.has(ref.toString())) {
			throw new EngineError('internal', 'Two output pages share one page object; stamps cannot be placed safely.');
		}
		seen.add(ref.toString());
	}

	// Shared resources, created on demand.
	const images = new Map<string, PdfLib.PDFImage>();
	const assetById = new Map(assets.map((a) => [a.id, a]));
	let font: PdfLib.PDFFont | null = null;
	const getFont = async () => {
		if (!font) {
			doc.registerFontkit(deps.fontkit as Parameters<typeof doc.registerFontkit>[0]);
			font = await doc.embedFont(await deps.fontBytes(), {
				subset: true,
				features: { liga: false, clig: false, calt: false, kern: false, rlig: false, dlig: false }
			});
		}
		return font;
	};
	// Filled blanks as form fields: declined for a form that redraws its fields itself.
	let fieldIds: ReadonlySet<string> = new Set();
	let fieldNames = new Set<string>();
	const widgetRefs: PdfLib.PDFRef[] = [];
	let drFonts = { helv: 'Helv', zadb: 'ZaDb' };
	if (fields && fields.ids.size) {
		const af = readAcroForm(lib, doc);
		if (af.redraws) for (const id of fields.ids) fields.plain.set(id, 'form-redraws');
		else {
			fieldIds = fields.ids;
			fieldNames = af.names;
			drFonts = drFontNames(lib, doc);
		}
	}
	const multiplyRef = ctx.register(ctx.obj({ Type: 'ExtGState', CA: 1, ca: 1, BM: 'Multiply' }));
	const gsRef = ctx.register(
		ctx.obj({ Type: 'ExtGState', CA: 1, ca: 1, BM: 'Normal', SMask: 'None', LW: 1, LC: 0, LJ: 0, D: [[], 0] })
	);

	for (const job of work) {
		const page = pages[job.pageIndex];
		const leaf = page.node;
		const geom = readGeometry(lib, leaf);
		const shown = displayedUserSize(geom.box, geom.rotation);
		const w = shown.width * geom.userUnit;
		const h = shown.height * geom.userUnit;
		if (Math.abs(w - job.expected.width) > 0.5 || Math.abs(h - job.expected.height) > 0.5) {
			const check: VerifyCheck = {
				name: 'page-sizes',
				ok: false,
				detail: `Page ${job.pageIndex + 1}: stamp layer sees ${r4(w)}×${r4(h)} pt, plan expects ${r4(job.expected.width)}×${r4(job.expected.height)} pt.`
			};
			throw new EngineError('verification-failed', 'The pages did not come out the expected size, so the file was not saved.', [check]);
		}

		// Original content streams and their q/Q nesting. /Contents may also be a
		// reference to an array of streams.
		let rawContents = leaf.get(PDFName.of('Contents'));
		if (rawContents instanceof PDFRef) {
			const target = ctx.lookup(rawContents);
			if (target instanceof PDFArray) rawContents = target;
		}
		const contentRefs: PdfLib.PDFObject[] = [];
		if (rawContents instanceof PDFArray) {
			for (let k = 0; k < rawContents.size(); k++) contentRefs.push(rawContents.get(k));
		} else if (rawContents) {
			contentRefs.push(rawContents);
		}
		const decoded: Uint8Array[] = [];
		// Streams kept in the new /Contents. Empty and missing ones are left out: they
		// draw nothing, and poppler stops reading a page's content at an empty stream
		// that claims /FlateDecode, which would hide the stamps there.
		const kept: PdfLib.PDFObject[] = [];
		for (let k = 0; k < contentRefs.length; k++) {
			let obj = contentRefs[k];
			if (!(obj instanceof PDFRef)) {
				// Direct stream objects are invalid in /Contents; make them indirect.
				const reg = ctx.register(obj);
				contentRefs[k] = reg;
			}
			obj = ctx.lookup(contentRefs[k]) as PdfLib.PDFObject;
			if (obj instanceof PDFRawStream) {
				// An empty stream holds no operators, whatever its /Filter says.
				if (obj.getContentsSize() === 0) continue;
				try {
					decoded.push(lib.decodePDFRawStream(obj).decode());
				} catch {
					throw new EngineError('unsupported', `Page ${job.pageIndex + 1} has damaged content, so stamps cannot be added to it safely.`);
				}
				kept.push(contentRefs[k]);
			} else if (obj instanceof PDFContentStream) {
				decoded.push(obj.getUnencodedContents());
				kept.push(contentRefs[k]);
			} else if (obj === undefined || obj === lib.PDFNull) {
				// Missing stream: treated as empty, as viewers do.
			} else {
				throw new EngineError('unsupported', `Page ${job.pageIndex + 1} has content that stamps cannot be added to safely.`);
			}
		}
		const nest = graphicsNesting(decoded);
		if (nest.unterminated) {
			throw new EngineError('unsupported', `Page ${job.pageIndex + 1} has damaged content, so stamps cannot be added to it safely.`);
		}
		const pushes = 1 - nest.minDepth;
		const pops = pushes + nest.finalDepth;

		// Page-local copies of resource dictionaries, so shared ones are not altered.
		const inherited = leaf.Resources();
		const resources = inherited ? inherited.clone(ctx) : ctx.obj({});
		const sub = (key: string) => {
			const existing = resources.lookupMaybe(PDFName.of(key), PDFDict);
			const copy = existing ? existing.clone(ctx) : ctx.obj({});
			resources.set(PDFName.of(key), copy);
			return copy;
		};
		const xobjects = sub('XObject');
		const extg = sub('ExtGState');
		let fonts: PdfLib.PDFDict | null = null;
		const name = (dict: PdfLib.PDFDict, prefix: string) => {
			let k = 0;
			while (dict.has(PDFName.of(`${prefix}${k}`))) k++;
			return `${prefix}${k}`;
		};
		const gsName = name(extg, 'PgsGS');
		extg.set(PDFName.of(gsName), gsRef);
		const mulName = name(extg, 'PgsMul');
		extg.set(PDFName.of(mulName), multiplyRef);
		leaf.set(PDFName.of('Resources'), resources);

		const body: PdfLib.PDFOperator[] = [];
		/** Where this page's stamps are, in PDF user space (for the annotation warning). */
		const drawn: Box[] = [];
		const shownSize = displayedUserSize(geom.box, geom.rotation);
		const imageNames = new Map<string, string>();
		let fontName: string | null = null;
		/** Widgets of filled blanks on this page, added to /Annots after the overlap warning. */
		const pageWidgets: PdfLib.PDFRef[] = [];
		/**
		 * A linked stamp as a form field instead of page content (blank-fields.ts), when it
		 * sits on its blank; false: draw it as usual. `ops` are the stamp's own operators.
		 */
		const asField = (stamp: Stamp, ops: PdfLib.PDFOperator[], ink: Box, start: [number, number], resources: Record<string, Record<string, PdfLib.PDFRef>>, text?: { value: string; size: number; multiline: boolean; color: readonly [number, number, number] }): boolean => {
			if (!fields || !fieldIds.has(stamp.id) || !linked(stamp)) return false;
			const b = stampDisplayRect(geom.box, geom.rotation, stamp.blank.box);
			const blank = { left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height };
			if (!onBlank(blank, start)) {
				fields.plain.set(stamp.id, 'off-blank');
				return false;
			}
			const shown = {
				left: Math.max(0, Math.min(blank.left, ink.x0)),
				top: Math.max(0, Math.min(blank.top, ink.y0)),
				right: Math.min(shownSize.width, Math.max(blank.right, ink.x1)),
				bottom: Math.min(shownSize.height, Math.max(blank.bottom, ink.y1))
			};
			const rect = displayRectToPdf(geom, shown.left, shown.top, shown.right, shown.bottom);
			const n = fields.made.filter((f) => f.page === job.pageIndex).length + 1;
			const name = uniqueName(fieldNames, job.pageIndex, n);
			const ref = makeWidget(lib, ctx, { kind: text ? 'text' : 'check', name, page: job.pageIndex, pageRef: page.ref, rect, rotation: geom.rotation, ops, resources, ...(text ? { value: text.value, multiline: text.multiline, fontSize: text.size, color: text.color } : {}) }, drFonts);
			pageWidgets.push(ref);
			fields.made.push({
				stampId: stamp.id,
				page: job.pageIndex,
				name,
				kind: text ? 'text' : 'check',
				value: text?.value ?? '',
				rect: { x0: r4(rect.x0), y0: r4(rect.y0), x1: r4(rect.x1), y1: r4(rect.y1) },
				shown: { x0: shown.left / shownSize.width, y0: shown.top / shownSize.height, x1: shown.right / shownSize.width, y1: shown.bottom / shownSize.height }
			});
			return true;
		};

		// Highlights first, so anything else on the page stays on top of them.
		for (const stamp of job.stamps) {
			if (stamp.kind !== 'highlight') continue;
			body.push(...highlightOps(ops, geom, stamp, mulName));
			if (stamp.pen) {
				const half = (stamp.pen.width * shownSize.height) / 2;
				const xs: number[] = [];
				const ys: number[] = [];
				for (const p of stamp.pen.points) {
					const [x, y] = displayToPdf(geom.box, geom.rotation, p.x * shownSize.width, p.y * shownSize.height);
					xs.push(x);
					ys.push(y);
				}
				drawn.push({ x0: Math.min(...xs) - half, y0: Math.min(...ys) - half, x1: Math.max(...xs) + half, y1: Math.max(...ys) + half });
			} else if (stamp.rects) {
				for (const r of stamp.rects) drawn.push(stampPdfRect(geom.box, geom.rotation, r));
			} else drawn.push(stampPdfRect(geom.box, geom.rotation, stamp.box));
		}
		for (const stamp of job.stamps) {
			if (stamp.kind === 'redact' || stamp.kind === 'highlight') {
				continue;
			} else if (stamp.kind === 'image') {
				const asset = assetById.get(stamp.assetId);
				if (!asset) throw new EngineError('internal', 'A stamp refers to an image that is missing.');
				let img = images.get(asset.id);
				if (!img) {
					parsePng(asset.png);
					img = await doc.embedPng(asset.png);
					images.set(asset.id, img);
				}
				let xname = imageNames.get(asset.id);
				if (!xname) {
					xname = name(xobjects, 'PgsIm');
					xobjects.set(PDFName.of(xname), img.ref);
					imageNames.set(asset.id, xname);
				}
				const m = stampBoxMatrix(geom.box, geom.rotation, stamp.box);
				body.push(ops.pushGraphicsState(), cm(ops, m), ops.drawObject(xname), ops.popGraphicsState());
				drawn.push(stampPdfRect(geom.box, geom.rotation, stamp.box));
			} else if (stamp.kind === 'mark') {
				const mo = markOps(ops, geom, stamp);
				const r = stampDisplayRect(geom.box, geom.rotation, stamp.box);
				const ink = { x0: r.left, y0: r.top, x1: r.left + r.width, y1: r.top + r.height };
				if (asField(stamp, [ops.pushGraphicsState(), ops.setGraphicsState('GS0'), ...mo, ops.popGraphicsState()], ink, [r.left + r.width / 2, r.top + r.height / 2], { ExtGState: { GS0: gsRef } })) continue;
				body.push(...mo);
				drawn.push(stampPdfRect(geom.box, geom.rotation, stamp.box));
			} else if (stamp.kind === 'text') {
				const f = await getFont();
				const size = stamp.size * shownSize.height;
				const text = normalizeStampText(stamp.text);
				const lines = text.split('\n');
				const w = Math.max(...lines.map((l) => f.widthOfTextAtSize(l, size)));
				const x = stamp.x * shownSize.width;
				const y = stamp.y * shownSize.height;
				if (fieldIds.has(stamp.id)) {
					// Every line's ascent to descent, and a margin, so the field clips nothing.
					const m = TEXT_MARGIN_PT / geom.userUnit;
					const top = y + (STAMP_BASELINE_EM - STAMP_FONT.ascent) * size;
					const bottom = y + ((lines.length - 1) * STAMP_FONT.lineHeight + STAMP_BASELINE_EM + STAMP_FONT.descent) * size;
					const ink = { x0: x - m, y0: Math.min(y, top) - m, x1: x + w + m, y1: Math.max(y + lines.length * STAMP_FONT.lineHeight * size, bottom) + m };
					const fo = textOps(ops, geom, stamp, f, 'F0');
					const color = STAMP_COLORS[stamp.color];
					const start: [number, number] = [x, y + STAMP_BASELINE_EM * size];
					const asText = { value: text, size: size * geom.userUnit, multiline: lines.length > 1, color };
					if (asField(stamp, [ops.pushGraphicsState(), ops.setGraphicsState('GS0'), ...fo, ops.popGraphicsState()], ink, start, { Font: { F0: f.ref }, ExtGState: { GS0: gsRef } }, asText)) continue;
				}
				if (!fontName) {
					fonts ??= sub('Font');
					fontName = name(fonts, 'PgsF');
					fonts.set(PDFName.of(fontName), f.ref);
				}
				body.push(...textOps(ops, geom, stamp, f, fontName));
				drawn.push(displayRectToPdf(geom, x, y, x + w, y + lines.length * STAMP_FONT.lineHeight * size));
			}
		}

		const label = numbering?.labels[job.pageIndex] ?? null;
		if (label !== null && numbering) {
			const f = await getFont();
			if (!fontName) {
				fonts ??= sub('Font');
				fontName = name(fonts, 'PgsF');
				fonts.set(PDFName.of(fontName), f.ref);
			}
			const num = numberOps(ops, geom, numbering.numbering, label, f, fontName, job.pageIndex);
			body.push(...num.ops);
			drawn.push(num.rect);
		}
		if (warnings && coveredByAnnotation(lib, leaf, drawn)) {
			warnings.push(`On page ${job.pageIndex + 1}, an annotation on the page (such as a comment, sticker or form field) lies over a stamp and may hide part of it.`);
		}
		if (pageWidgets.length) {
			// A page-local /Annots array (it may be shared with another page), with the new widgets.
			let annots: PdfLib.PDFArray | undefined;
			try {
				annots = leaf.lookupMaybe(PDFName.of('Annots'), PDFArray);
			} catch {
				annots = undefined;
			}
			const list = ctx.obj([]);
			if (annots) for (let k = 0; k < annots.size(); k++) list.push(annots.get(k));
			for (const r of pageWidgets) list.push(r);
			leaf.set(PDFName.of('Annots'), list);
			widgetRefs.push(...pageWidgets);
		}

		const pre = ctx.register(PDFContentStream.of(ctx.obj({}), Array.from({ length: pushes }, () => ops.pushGraphicsState()), false));
		const tail = ctx.register(
			PDFContentStream.of(
				ctx.obj({}),
				[
					...(nest.inText ? [ops.endText()] : []),
					...Array.from({ length: pops }, () => ops.popGraphicsState()),
					ops.pushGraphicsState(),
					ops.setGraphicsState(gsName),
					...body,
					ops.popGraphicsState()
				],
				true
			)
		);
		leaf.set(PDFName.of('Contents'), ctx.obj([pre, ...kept, tail]));
	}

	if (widgetRefs.length) registerFields(lib, doc, widgetRefs, drFonts);

	return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: Infinity });
}

export function readGeometry(lib: typeof PdfLib, leaf: PdfLib.PDFPageLeaf): PageGeometry {
	const { PDFArray, PDFNumber, PDFName } = lib;
	const nums = (arr: PdfLib.PDFArray | undefined): number[] | undefined => {
		if (!(arr instanceof PDFArray)) return undefined;
		const out: number[] = [];
		for (let k = 0; k < arr.size(); k++) {
			const v = arr.lookup(k);
			if (!(v instanceof PDFNumber)) return undefined;
			out.push(v.asNumber());
		}
		return out;
	};
	let media: number[] | undefined;
	let crop: number[] | undefined;
	try {
		media = nums(leaf.MediaBox());
	} catch {
		media = undefined;
	}
	try {
		crop = nums(leaf.CropBox());
	} catch {
		crop = undefined;
	}
	const rot = leaf.Rotate();
	const uu = leaf.lookup(PDFName.of('UserUnit'));
	const userUnit = uu instanceof PDFNumber && uu.asNumber() > 0 ? uu.asNumber() : 1;
	return {
		box: visibleBox(media, crop),
		rotation: normalizeRotation(rot instanceof PDFNumber ? rot.asNumber() : 0),
		userUnit
	};
}

/** A display-space rectangle (user units from the displayed top-left) as a PDF user-space box. */
function displayRectToPdf(geom: PageGeometry, left: number, top: number, right: number, bottom: number): Box {
	const [ax, ay] = displayToPdf(geom.box, geom.rotation, left, top);
	const [bx, by] = displayToPdf(geom.box, geom.rotation, right, bottom);
	return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/** Annotation flags: Hidden (2) and NoView (32). */
const ANNOT_UNSEEN = 2 | 32;

/**
 * Whether a visible annotation with an appearance overlaps any of `rects`.
 * Annotations are painted above page content, so such an annotation can hide a stamp.
 * Links and popups paint nothing; a form field counts only when it is likely to be
 * opaque (see opaqueWidget); otherwise its appearance is text and borders over the page.
 */
function coveredByAnnotation(lib: typeof PdfLib, leaf: PdfLib.PDFPageLeaf, rects: Box[]): boolean {
	const { PDFArray, PDFDict, PDFName, PDFNumber, PDFStream } = lib;
	if (rects.length === 0) return false;
	let annots: PdfLib.PDFArray | undefined;
	try {
		annots = leaf.lookupMaybe(PDFName.of('Annots'), PDFArray);
	} catch {
		return false;
	}
	if (!annots) return false;
	for (let k = 0; k < annots.size(); k++) {
		let a: PdfLib.PDFDict | undefined;
		try {
			a = annots.lookupMaybe(k, PDFDict);
		} catch {
			continue;
		}
		if (!a) continue;
		const subtype = a.lookup(PDFName.of('Subtype'));
		const kind = subtype instanceof PDFName ? subtype.decodeText() : '';
		if (kind === 'Link' || kind === 'Popup') continue;
		const flags = a.lookup(PDFName.of('F'));
		if (flags instanceof PDFNumber && (flags.asNumber() & ANNOT_UNSEEN) !== 0) continue;
		const ap = a.lookup(PDFName.of('AP'));
		const normal = ap instanceof PDFDict ? ap.lookup(PDFName.of('N')) : undefined;
		if (!(normal instanceof PDFStream) && !(normal instanceof PDFDict)) continue;
		if (kind === 'Widget' && !opaqueWidget(lib, a)) continue;
		const r = a.lookup(PDFName.of('Rect'));
		if (!(r instanceof PDFArray) || r.size() !== 4) continue;
		const v = [0, 1, 2, 3].map((i) => r.lookup(i));
		if (!v.every((n) => n instanceof PDFNumber)) continue;
		const [x0, y0, x1, y1] = (v as PdfLib.PDFNumber[]).map((n) => n.asNumber());
		const ax0 = Math.min(x0, x1);
		const ax1 = Math.max(x0, x1);
		const ay0 = Math.min(y0, y1);
		const ay1 = Math.max(y0, y1);
		if (rects.some((b) => Math.min(b.x1, ax1) - Math.max(b.x0, ax0) > 0.5 && Math.min(b.y1, ay1) - Math.max(b.y0, ay0) > 0.5)) return true;
	}
	return false;
}

/** Pushbutton flag in a field's /Ff. */
const FF_PUSHBUTTON = 1 << 16;

/** A form widget with a background colour or an icon, or a push button (usually drawn as a picture). */
function opaqueWidget(lib: typeof PdfLib, a: PdfLib.PDFDict): boolean {
	const { PDFArray, PDFDict, PDFName, PDFNumber } = lib;
	const mk = a.lookup(PDFName.of('MK'));
	if (mk instanceof PDFDict) {
		const bg = mk.lookup(PDFName.of('BG'));
		if (bg instanceof PDFArray && bg.size() > 0) return true;
		if (mk.has(PDFName.of('I'))) return true;
	}
	let field: PdfLib.PDFDict | undefined = a;
	for (let depth = 0; field && depth < 8; depth++) {
		const ff = field.lookup(PDFName.of('Ff'));
		if (ff instanceof PDFNumber) return (ff.asNumber() & FF_PUSHBUTTON) !== 0;
		const parent: PdfLib.PDFObject | undefined = field.lookup(PDFName.of('Parent'));
		field = parent instanceof PDFDict ? parent : undefined;
	}
	return false;
}

function cm(ops: typeof PdfLib, m: Matrix) {
	return ops.concatTransformationMatrix(r4(m[0]), r4(m[1]), r4(m[2]), r4(m[3]), r4(m[4]), r4(m[5]));
}

function markOps(ops: typeof PdfLib, geom: PageGeometry, stamp: Extract<Stamp, { kind: 'mark' }>) {
	const r = stampDisplayRect(geom.box, geom.rotation, stamp.box);
	const frame = uprightFrame(geom.box, geom.rotation, r.left, r.top + r.height);
	const w = r.width;
	const h = r.height;
	const P = (p: readonly number[]): [number, number] => [r4(p[0] * w), r4((1 - p[1]) * h)];
	const out: PdfLib.PDFOperator[] = [ops.pushGraphicsState(), cm(ops, frame)];
	const def = MARKS[stamp.mark];
	if (def.kind === 'fill') {
		const rad = def.radius * Math.min(w, h);
		const cx = w / 2;
		const cy = h / 2;
		const k = 0.5522847498 * rad;
		out.push(
			ops.setFillingRgbColor(0, 0, 0),
			ops.moveTo(r4(cx + rad), r4(cy)),
			ops.appendBezierCurve(r4(cx + rad), r4(cy + k), r4(cx + k), r4(cy + rad), r4(cx), r4(cy + rad)),
			ops.appendBezierCurve(r4(cx - k), r4(cy + rad), r4(cx - rad), r4(cy + k), r4(cx - rad), r4(cy)),
			ops.appendBezierCurve(r4(cx - rad), r4(cy - k), r4(cx - k), r4(cy - rad), r4(cx), r4(cy - rad)),
			ops.appendBezierCurve(r4(cx + k), r4(cy - rad), r4(cx + rad), r4(cy - k), r4(cx + rad), r4(cy)),
			ops.closePath(),
			ops.fill()
		);
	} else {
		out.push(
			ops.setStrokingRgbColor(0, 0, 0),
			ops.setLineWidth(r4(def.width * Math.min(w, h))),
			ops.setLineCap(ops.LineCapStyle.Round),
			ops.setLineJoin(ops.LineJoinStyle.Round)
		);
		const polylines: ReadonlyArray<ReadonlyArray<readonly number[]>> = 'points' in def ? [def.points] : def.segments;
		for (const line of polylines) {
			const [x0, y0] = P(line[0]);
			out.push(ops.moveTo(x0, y0));
			for (const p of line.slice(1)) {
				const [x, y] = P(p);
				out.push(ops.lineTo(x, y));
			}
		}
		out.push(ops.stroke());
	}
	out.push(ops.popGraphicsState());
	return out;
}

function textOps(
	ops: typeof PdfLib,
	geom: PageGeometry,
	stamp: Extract<Stamp, { kind: 'text' }>,
	font: PdfLib.PDFFont,
	fontName: string
) {
	const shown = displayedUserSize(geom.box, geom.rotation);
	const size = stamp.size * shown.height;
	const frame = uprightFrame(geom.box, geom.rotation, stamp.x * shown.width, stamp.y * shown.height);
	const [cr, cg, cb] = STAMP_COLORS[stamp.color];
	const out: PdfLib.PDFOperator[] = [
		ops.pushGraphicsState(),
		cm(ops, frame),
		ops.setFillingRgbColor(cr, cg, cb),
		ops.beginText(),
		ops.setFontAndSize(fontName, r4(size)),
		ops.setCharacterSpacing(0),
		ops.setWordSpacing(0),
		ops.setCharacterSqueeze(100),
		ops.setTextRise(0),
		ops.setTextRenderingMode(ops.TextRenderingMode.Fill)
	];
	const lines = normalizeStampText(stamp.text).split('\n');
	lines.forEach((line, i) => {
		if (line.length === 0) return;
		const baseline = (i * STAMP_FONT.lineHeight + STAMP_BASELINE_EM) * size;
		out.push(ops.setTextMatrix(1, 0, 0, 1, 0, r4(-baseline)), ops.showText(font.encodeText(line)));
	});
	out.push(ops.endText(), ops.popGraphicsState());
	return out;
}

const HIGHLIGHT_RGB = {
	yellow: [1, 0.922, 0.231],
	green: [0.647, 0.953, 0.42],
	pink: [1, 0.612, 0.796]
} as const satisfies Record<Extract<Stamp, { kind: 'highlight' }>['color'], readonly [number, number, number]>;

/**
 * Multiply blend, so dark content underneath stays as it was. A box highlight is a
 * filled rectangle with slightly rounded corners; a pen highlight is one stroked
 * path with round caps and joins, so where it crosses itself the colour does not
 * get darker.
 */
function highlightOps(ops: typeof PdfLib, geom: PageGeometry, stamp: Extract<Stamp, { kind: 'highlight' }>, mulName: string) {
	const [cr, cg, cb] = HIGHLIGHT_RGB[stamp.color];
	const shown = displayedUserSize(geom.box, geom.rotation);
	const out: PdfLib.PDFOperator[] = [ops.pushGraphicsState(), ops.setGraphicsState(mulName)];
	if (stamp.pen) {
		const P = (p: { x: number; y: number }) => displayToPdf(geom.box, geom.rotation, p.x * shown.width, p.y * shown.height).map(r4);
		const [x0, y0] = P(stamp.pen.points[0]);
		out.push(
			ops.setStrokingRgbColor(cr, cg, cb),
			ops.setLineWidth(r4(stamp.pen.width * shown.height)),
			ops.setLineCap(ops.LineCapStyle.Round),
			ops.setLineJoin(ops.LineJoinStyle.Round),
			ops.moveTo(x0, y0)
		);
		for (const p of stamp.pen.points.slice(1)) {
			const [x, y] = P(p);
			out.push(ops.lineTo(x, y));
		}
		out.push(ops.stroke());
	} else {
		// A box, or a text highlight's rectangles: each a box, all in one path filled once
		// (nonzero), so where two overlap the colour does not get darker.
		out.push(ops.setFillingRgbColor(cr, cg, cb));
		for (const b of stamp.rects ?? [stamp.box]) out.push(...roundedRect(ops, stampPdfRect(geom.box, geom.rotation, b), shown.height));
		out.push(ops.fill());
	}
	out.push(ops.popGraphicsState());
	return out;
}

/** A closed rectangle with slightly rounded corners (always the same direction, for nonzero fills). */
function roundedRect(ops: typeof PdfLib, r: Box, pageHeight: number): PdfLib.PDFOperator[] {
	const rad = highlightRadius(pageHeight, r.x1 - r.x0, r.y1 - r.y0);
	// Bezier quarter circles: k is the usual 4/3·(√2−1).
	const k = rad * (1 - 0.5522847498);
	return [
		ops.moveTo(r4(r.x0 + rad), r4(r.y0)),
		ops.lineTo(r4(r.x1 - rad), r4(r.y0)),
		ops.appendBezierCurve(r4(r.x1 - k), r4(r.y0), r4(r.x1), r4(r.y0 + k), r4(r.x1), r4(r.y0 + rad)),
		ops.lineTo(r4(r.x1), r4(r.y1 - rad)),
		ops.appendBezierCurve(r4(r.x1), r4(r.y1 - k), r4(r.x1 - k), r4(r.y1), r4(r.x1 - rad), r4(r.y1)),
		ops.lineTo(r4(r.x0 + rad), r4(r.y1)),
		ops.appendBezierCurve(r4(r.x0 + k), r4(r.y1), r4(r.x0), r4(r.y1 - k), r4(r.x0), r4(r.y1 - rad)),
		ops.lineTo(r4(r.x0), r4(r.y0 + rad)),
		ops.appendBezierCurve(r4(r.x0), r4(r.y0 + k), r4(r.x0 + k), r4(r.y0), r4(r.x0 + rad), r4(r.y0)),
		ops.closePath()
	];
}

function numberOps(
	ops: typeof PdfLib,
	geom: PageGeometry,
	numbering: NumberingJob['numbering'],
	label: string,
	font: PdfLib.PDFFont,
	fontName: string,
	pageIndex: number
): { ops: PdfLib.PDFOperator[]; rect: Box } {
	const u = geom.userUnit;
	const shown = displayedUserSize(geom.box, geom.rotation);
	const pageW = shown.width * u;
	const pageH = shown.height * u;
	const textW = font.widthOfTextAtSize(label, numbering.size);
	const lay = numberLayout(pageW, pageH, numbering.position, numbering.size, textW);
	const capTop = lay.baseline - NUMBER_CAP_EM * numbering.size;
	if (textW > pageW || capTop < 0 || lay.baseline > pageH) {
		throw new EngineError(
			'unsupported',
			`Page ${pageIndex + 1} is too small for a page number of this size. Choose a smaller size or a shorter style.`
		);
	}
	// Display point of the baseline start, in user units, from the displayed top-left.
	const frame = uprightFrame(geom.box, geom.rotation, lay.x / u, lay.baseline / u);
	const rect = displayRectToPdf(geom, lay.x / u, capTop / u, (lay.x + textW) / u, lay.baseline / u);
	const out: PdfLib.PDFOperator[] = [
		ops.pushGraphicsState(),
		cm(ops, frame),
		ops.setFillingRgbColor(0, 0, 0),
		ops.beginText(),
		ops.setFontAndSize(fontName, r4(numbering.size / u)),
		ops.setCharacterSpacing(0),
		ops.setWordSpacing(0),
		ops.setCharacterSqueeze(100),
		ops.setTextRise(0),
		ops.setTextRenderingMode(ops.TextRenderingMode.Fill),
		ops.setTextMatrix(1, 0, 0, 1, 0, 0),
		ops.showText(font.encodeText(label)),
		ops.endText(),
		ops.popGraphicsState()
	];
	return { ops: out, rect };
}
