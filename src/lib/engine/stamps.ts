/**
 * Draws stamps onto an assembled PDF with pdf-lib.
 *
 * Every page that gets stamps has its content wrapped as
 *   [q × n] [original content…] [Q × m] [our stamps]
 * where n and m come from scanning the original content's q/Q nesting, so stamps are
 * drawn in the page's initial graphics state even when the original leaves a `cm`,
 * clip or an unclosed `q` behind. Stamp geometry comes from geometry.ts.
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
	displayedUserSize,
	normalizeRotation,
	normalizeStampText,
	stampBoxMatrix,
	stampDisplayRect,
	uprightFrame,
	visibleBox,
	type Box,
	type Matrix
} from './geometry';
import type { Rotation } from '../core/types';
import { parsePng } from './images';

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
	assets: Asset[]
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

	const seen = new Set<string>();
	for (const job of jobs) {
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
	const gsRef = ctx.register(
		ctx.obj({ Type: 'ExtGState', CA: 1, ca: 1, BM: 'Normal', SMask: 'None', LW: 1, LC: 0, LJ: 0, D: [[], 0] })
	);

	for (const job of jobs) {
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

		// Original content streams and their q/Q nesting.
		const rawContents = leaf.get(PDFName.of('Contents'));
		const contentRefs: PdfLib.PDFObject[] = [];
		if (rawContents instanceof PDFArray) {
			for (let k = 0; k < rawContents.size(); k++) contentRefs.push(rawContents.get(k));
		} else if (rawContents) {
			contentRefs.push(rawContents);
		}
		const decoded: Uint8Array[] = [];
		for (let k = 0; k < contentRefs.length; k++) {
			let obj = contentRefs[k];
			if (!(obj instanceof PDFRef)) {
				// Direct stream objects are invalid in /Contents; make them indirect.
				const reg = ctx.register(obj);
				contentRefs[k] = reg;
			}
			obj = ctx.lookup(contentRefs[k]) as PdfLib.PDFObject;
			if (obj instanceof PDFRawStream) {
				try {
					decoded.push(lib.decodePDFRawStream(obj).decode());
				} catch {
					throw new EngineError('unsupported', `Page ${job.pageIndex + 1} uses a content encoding that stamps cannot be added to safely.`);
				}
			} else if (obj instanceof PDFContentStream) {
				decoded.push(obj.getUnencodedContents());
			} else if (obj === undefined || obj === lib.PDFNull) {
				// Missing stream: treated as empty, as viewers do.
			} else {
				throw new EngineError('unsupported', `Page ${job.pageIndex + 1} has content that stamps cannot be added to safely.`);
			}
		}
		const nest = graphicsNesting(decoded);
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
		leaf.set(PDFName.of('Resources'), resources);

		const body: PdfLib.PDFOperator[] = [];
		const imageNames = new Map<string, string>();
		let fontName: string | null = null;

		for (const stamp of job.stamps) {
			if (stamp.kind === 'image') {
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
			} else if (stamp.kind === 'mark') {
				body.push(...markOps(ops, geom, stamp));
			} else {
				const f = await getFont();
				if (!fontName) {
					fonts ??= sub('Font');
					fontName = name(fonts, 'PgsF');
					fonts.set(PDFName.of(fontName), f.ref);
				}
				body.push(...textOps(ops, geom, stamp, f, fontName));
			}
		}

		const pre = ctx.register(PDFContentStream.of(ctx.obj({}), Array.from({ length: pushes }, () => ops.pushGraphicsState()), false));
		const tail = ctx.register(
			PDFContentStream.of(
				ctx.obj({}),
				[
					...Array.from({ length: pops }, () => ops.popGraphicsState()),
					ops.pushGraphicsState(),
					ops.setGraphicsState(gsName),
					...body,
					ops.popGraphicsState()
				],
				true
			)
		);
		leaf.set(PDFName.of('Contents'), ctx.obj([pre, ...contentRefs, tail]));
	}

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
