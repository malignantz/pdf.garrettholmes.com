/**
 * Crop (PageRef.crop, 2026-11-14): the export shows only part of a page.
 *
 * Right after assembling (and after the OCR layer, which is placed in user space), each
 * cropped page gets a /CropBox: the planned part of the page as displayed, mapped into
 * PDF user space through the page's own visible box (CropBox ∩ MediaBox, inherited
 * values followed, as PDF.js computes it) and its rotation (/Rotate plus the app's
 * rotation, which assembling has already added). /MediaBox stays as it is; /TrimBox,
 * /BleedBox and /ArtBox are cut back to the new box (or set to it when they miss it).
 * Content is hidden, never removed: the dialog and the editor say so.
 *
 * Every later stage (forms, redaction, stamps, page numbers, watermark) reads the page
 * box from the file, so it works in the cropped page. The plan's expected page sizes
 * are the cropped ones, so the usual size check covers them too. The 'crop' check reads
 * each cropped page's visible box back with PDF.js (an independent reader) and compares
 * it with the planned rectangle.
 *
 * Not touched: accessibility tags, form fields and links (a field or link outside the
 * box is hidden with it; nothing points into the cut-off area that did not before).
 */

import type { PageRef, PageSize, StampBox, VerifyCheck } from '../core/types';
import type { EngineDeps } from './deps';
import { EngineError } from './errors';
import { normalizeRotation, stampPdfRect, visibleBox, type Box } from './geometry';
import { QPDF_OK, QPDF_WARNINGS, type Qpdf } from './qpdf';

/** Smallest side of a crop, as a fraction of the page side (the editor asks for more). */
export const CROP_MIN = 0.05;
/** Tolerance of the check, in user units. */
const CHECK_TOLERANCE = 0.01;

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Throws EngineError('internal') unless `crop` is a box inside the page, at least CROP_MIN each way. */
export function validateCrop(pageNo: number, crop: unknown): void {
	if (crop === undefined) return;
	const c = crop as Partial<StampBox> | null;
	const eps = 1e-6;
	const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
	if (!c || typeof c !== 'object' || !fin(c.x) || !fin(c.y) || !fin(c.w) || !fin(c.h)) {
		throw new EngineError('internal', `Page ${pageNo + 1} has a bad crop.`);
	}
	if (c.x < -eps || c.y < -eps || c.x + c.w > 1 + eps || c.y + c.h > 1 + eps || c.w < CROP_MIN - eps || c.h < CROP_MIN - eps) {
		throw new EngineError('internal', `Page ${pageNo + 1} has a bad crop.`);
	}
}

/** The size of a page shown `size` once cropped to `crop` (fractions of it). */
export function croppedSize(size: PageSize, crop: StampBox | undefined): PageSize {
	return crop ? { width: size.width * crop.w, height: size.height * crop.h } : { width: size.width, height: size.height };
}

type Json = unknown;
type Dict = Record<string, Json>;
const isDict = (v: Json): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRef = (v: Json): v is string => typeof v === 'string' && /^\d+ \d+ R$/.test(v);
const objKey = (ref: string) => `obj:${ref}`;
const objArg = (ref: string) => ref.replace(/^(\d+) (\d+) R$/, '$1,$2');

interface Dump {
	header: Dict;
	objects: Record<string, { value?: Json; stream?: unknown }>;
	pages: string[];
}

async function dump(qpdf: Qpdf, bytes: Uint8Array, objects: string[], withPages: boolean): Promise<Dump> {
	const res = await qpdf.run({
		args: ['--json=2', '--json-key=qpdf', ...(withPages ? ['--json-key=pages'] : []), ...objects.map((o) => `--json-object=${o}`), '--json-stream-data=none', '/cr.pdf', '/cr.json'],
		inputs: { '/cr.pdf': bytes },
		outputs: ['/cr.json']
	});
	const file = res.files.get('/cr.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) throw new EngineError('internal', 'The pages could not be read to crop them.');
	const parsed = JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Dict, Dump['objects']]; pages?: { object: string }[] };
	return { header: parsed.qpdf[0], objects: parsed.qpdf[1], pages: (parsed.pages ?? []).map((p) => p.object) };
}

/** The planned crop rectangle of every output page in PDF user space (null: not cropped), and the cropped file. */
export interface CropResult {
	bytes: Uint8Array;
	rects: (Box | null)[];
}

const INHERITED = ['/MediaBox', '/CropBox', '/Rotate'] as const;
const CUT_BACK = ['/TrimBox', '/BleedBox', '/ArtBox'] as const;

/** Sets /CropBox on every cropped page of the assembled file (see the module comment). */
export async function applyCrops(qpdf: Qpdf, bytes: Uint8Array, pages: readonly PageRef[]): Promise<CropResult> {
	const rects: (Box | null)[] = pages.map(() => null);
	if (!pages.some((p) => p.crop)) return { bytes, rects };
	const first = await dump(qpdf, bytes, ['trailer'], true);
	if (first.pages.length !== pages.length) throw new EngineError('internal', 'The assembled file does not have the planned pages, so they cannot be cropped.');
	// Objects read so far, and a reader that fetches what is missing a few at a time.
	const objects = new Map<string, Json>();
	const fetch = async (refs: string[]) => {
		const want = [...new Set(refs)].filter((r) => !objects.has(r));
		for (let k = 0; k < want.length; k += 200) {
			const d = await dump(qpdf, bytes, want.slice(k, k + 200).map(objArg), false);
			for (const r of want.slice(k, k + 200)) objects.set(r, d.objects[objKey(r)]?.value ?? null);
		}
	};
	const header = first.header;
	const cropped = pages.flatMap((p, i) => (p.crop ? [i] : []));
	const seen = new Map<string, number>();
	for (const [i, ref] of first.pages.entries()) {
		const other = seen.get(ref);
		if (other !== undefined && (pages[i].crop || pages[other].crop)) {
			throw new EngineError('unsupported', `Pages ${other + 1} and ${i + 1} share one page in the file, so they cannot be cropped.`);
		}
		seen.set(ref, i);
	}
	await fetch(cropped.map((i) => first.pages[i]));
	// Follow /Parent for inherited boxes and rotation (a few rounds: the tree is shallow).
	for (let round = 0; round < 32; round++) {
		const need: string[] = [];
		for (const i of cropped) {
			let node = objects.get(first.pages[i]);
			for (let depth = 0; isDict(node) && depth < 64; depth++) {
				for (const k of [...INHERITED, ...CUT_BACK]) {
					const v = node[k];
					if (isRef(v) && !objects.has(v)) need.push(v);
					if (Array.isArray(v)) for (const x of v) if (isRef(x) && !objects.has(x)) need.push(x);
				}
				const parent = node['/Parent'];
				if (!isRef(parent)) break;
				if (!objects.has(parent)) {
					need.push(parent);
					break;
				}
				node = objects.get(parent);
			}
		}
		if (need.length === 0) break;
		await fetch(need);
	}
	const val = (v: Json): Json => (isRef(v) ? (objects.get(v) ?? null) : v);
	const nums = (v: Json): number[] | undefined => {
		const a = val(v);
		if (!Array.isArray(a) || a.length !== 4) return undefined;
		const out = a.map((x) => val(x));
		return out.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (out as number[]) : undefined;
	};
	const inherited = (ref: string, key: string): Json => {
		let node = objects.get(ref);
		for (let depth = 0; isDict(node) && depth < 64; depth++) {
			if (key in node) return node[key];
			const parent = node['/Parent'];
			if (!isRef(parent)) return undefined;
			node = objects.get(parent);
		}
		return undefined;
	};

	const updates: Record<string, { value: Json }> = {};
	for (const i of cropped) {
		const ref = first.pages[i];
		const dict = objects.get(ref);
		if (!isDict(dict)) throw new EngineError('internal', `Page ${i + 1} could not be read to crop it.`);
		const box = visibleBox(nums(inherited(ref, '/MediaBox')), nums(inherited(ref, '/CropBox')));
		const rotate = val(inherited(ref, '/Rotate'));
		const rect = stampPdfRect(box, normalizeRotation(typeof rotate === 'number' ? rotate : 0), pages[i].crop!);
		const r = { x0: r4(rect.x0), y0: r4(rect.y0), x1: r4(rect.x1), y1: r4(rect.y1) };
		rects[i] = r;
		const next: Dict = { ...dict, '/CropBox': [r.x0, r.y0, r.x1, r.y1] };
		for (const k of CUT_BACK) {
			if (!(k in dict)) continue;
			const b = nums(dict[k]);
			if (!b) {
				// Unreadable: the page box it describes is replaced by the crop.
				next[k] = [r.x0, r.y0, r.x1, r.y1];
				continue;
			}
			const x0 = Math.max(Math.min(b[0], b[2]), r.x0);
			const y0 = Math.max(Math.min(b[1], b[3]), r.y0);
			const x1 = Math.min(Math.max(b[0], b[2]), r.x1);
			const y1 = Math.min(Math.max(b[1], b[3]), r.y1);
			next[k] = x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : [r.x0, r.y0, r.x1, r.y1];
		}
		updates[objKey(ref)] = { value: next };
	}
	const json = new TextEncoder().encode(JSON.stringify({ qpdf: [header, updates] }));
	const res = await qpdf.run({
		args: ['/cr.pdf', '--update-from-json=/cr-update.json', '/cr-out.pdf'],
		inputs: { '/cr.pdf': bytes, '/cr-update.json': json },
		outputs: ['/cr-out.pdf']
	});
	const out = res.files.get('/cr-out.pdf');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !out) throw new EngineError('internal', 'The pages could not be cropped.');
	return { bytes: out, rects };
}

/**
 * 'crop' check on the final file: PDF.js's view of every cropped page (CropBox ∩
 * MediaBox) equals the planned rectangle within 0.01 unit. A CropBox reaching outside
 * the MediaBox, or a missing one, shows as a different view.
 */
export async function verifyCrops(deps: EngineDeps, finalBytes: Uint8Array, rects: (Box | null)[], password?: string): Promise<VerifyCheck> {
	const want = rects.flatMap((r, i) => (r ? [[i, r] as const] : []));
	const fail = (detail: string): VerifyCheck => ({ name: 'crop', ok: false, detail });
	const lib = await deps.pdfjs();
	const task = lib.getDocument({
		data: finalBytes.slice(),
		password,
		useWasm: false,
		useWorkerFetch: false,
		useSystemFonts: false,
		disableFontFace: true,
		enableXfa: false,
		verbosity: 0
	});
	const wrong: number[] = [];
	try {
		const doc = await task.promise;
		if (doc.numPages !== rects.length) return fail(`The file has ${doc.numPages} pages but ${rects.length} were expected, so the crops cannot be checked.`);
		for (const [i, r] of want) {
			const page = await doc.getPage(i + 1);
			const [x0, y0, x1, y1] = page.view;
			const t = CHECK_TOLERANCE;
			if (Math.abs(x0 - r.x0) > t || Math.abs(y0 - r.y0) > t || Math.abs(x1 - r.x1) > t || Math.abs(y1 - r.y1) > t) wrong.push(i + 1);
			page.cleanup();
		}
	} catch {
		return fail('The cropped pages could not be read back from the file.');
	} finally {
		await task.destroy().catch(() => undefined);
	}
	if (wrong.length) {
		const shown = wrong.slice(0, 5).join(', ') + (wrong.length > 5 ? ` and ${wrong.length - 5} more` : '');
		return fail(`Page ${shown} does not show the planned part of the page.`);
	}
	return { name: 'crop', ok: true, detail: `${want.length} cropped ${want.length === 1 ? 'page shows' : 'pages show'} exactly the planned part (the rest is hidden, not removed).` };
}
