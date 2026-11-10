/**
 * Page numbers and Bates numbers (ExportOptions.numbering).
 *
 * This module owns the labels (pure) and their read-back check. Drawing them is
 * the stamps stage's job (stamps.ts receives a NumberingJob).
 */

import type { PageNumbering, PageSize, VerifyCheck } from '../core/types';
import type { EngineDeps } from './deps';
import { EngineError } from './errors';

/** What the stamps stage needs to draw the numbers. */
export interface NumberingJob {
	numbering: PageNumbering;
	/** One per output page; null = no number on that page. */
	labels: (string | null)[];
	/** Displayed size the plan expects for every output page. */
	expected: PageSize[];
}

const STYLES: readonly PageNumbering['style'][] = ['n', 'n-of-total', 'page-n', 'page-n-of-total', 'bates'];
const POSITIONS: readonly PageNumbering['position'][] = [
	'top-left',
	'top-center',
	'top-right',
	'bottom-left',
	'bottom-center',
	'bottom-right'
];
/** Largest number we print (keeps every label short and exact as a JS number). */
const MAX_NUMBER = 999_999_999;

/**
 * The label printed on each of `pageCount` output pages, in output order.
 *
 * - The first `skip` pages get null (no number) and are not counted.
 * - The k-th numbered page (k = 0, 1, …) carries n = start + k.
 * - total = (number of numbered pages) + start − 1, i.e. the number on the last
 *   numbered page. With start 1 and no skip, total is the page count; with skip 1
 *   and start 1, a 10-page file reads "1 of 9" … "9 of 9" after the cover.
 * - Styles: 'n' → "3"; 'n-of-total' → "3 of 12"; 'page-n' → "Page 3";
 *   'page-n-of-total' → "Page 3 of 12"; 'bates' → prefix + n left-padded with
 *   zeros to `bates.digits` ("ABC" + 7, 6 digits → "ABC000007").
 *
 * Throws EngineError('unsupported') for invalid settings (see validateNumbering)
 * or a Bates number that needs more digits than allowed. When every page is
 * skipped the result is all null; the caller decides whether that is an error.
 */
export function numberingLabels(numbering: PageNumbering, pageCount: number): (string | null)[] {
	validateNumbering(numbering);
	if (!Number.isInteger(pageCount) || pageCount < 0) throw new EngineError('internal', 'Invalid page count for numbering.');
	const { style, start, skip } = numbering;
	const numbered = Math.max(0, pageCount - skip);
	const total = numbered + start - 1;
	if (numbered > 0 && total > MAX_NUMBER) {
		throw new EngineError('unsupported', 'The page numbers would be too large. Choose a smaller first number.');
	}
	if (style === 'bates' && numbered > 0 && String(total).length > numbering.bates!.digits) {
		throw new EngineError(
			'unsupported',
			`Bates numbers up to ${total} need more than ${numbering.bates!.digits} digits. Choose more digits or a smaller first number.`
		);
	}
	const out: (string | null)[] = [];
	for (let i = 0; i < pageCount; i++) {
		if (i < skip) {
			out.push(null);
			continue;
		}
		const n = start + (i - skip);
		switch (style) {
			case 'n':
				out.push(String(n));
				break;
			case 'n-of-total':
				out.push(`${n} of ${total}`);
				break;
			case 'page-n':
				out.push(`Page ${n}`);
				break;
			case 'page-n-of-total':
				out.push(`Page ${n} of ${total}`);
				break;
			case 'bates':
				out.push(numbering.bates!.prefix + String(n).padStart(numbering.bates!.digits, '0'));
				break;
		}
	}
	return out;
}

/**
 * Checks the settings themselves (not the font; the caller checks the Bates
 * prefix against the stamp font). Throws EngineError('unsupported') with a
 * sentence the user can act on.
 */
export function validateNumbering(numbering: PageNumbering): void {
	const bad = (msg: string) => new EngineError('unsupported', msg);
	if (typeof numbering !== 'object' || numbering === null) throw bad('The page number settings are missing.');
	if (!STYLES.includes(numbering.style)) throw bad('Choose a page number style.');
	if (!POSITIONS.includes(numbering.position)) throw bad('Choose where the page numbers go.');
	if (!Number.isInteger(numbering.start) || numbering.start < 0 || numbering.start > MAX_NUMBER) {
		throw bad('The first page number must be a whole number of 0 or more.');
	}
	if (!Number.isInteger(numbering.skip) || numbering.skip < 0) {
		throw bad('The number of pages to leave unnumbered must be a whole number of 0 or more.');
	}
	if (typeof numbering.size !== 'number' || !Number.isFinite(numbering.size) || numbering.size < 6 || numbering.size > 24) {
		throw bad('The page number size must be between 6 and 24 points.');
	}
	if (numbering.style === 'bates') {
		const b = numbering.bates;
		if (!b || typeof b !== 'object') throw bad('Bates numbering needs a prefix and a number of digits.');
		if (typeof b.prefix !== 'string' || [...b.prefix].length > 20) throw bad('The Bates prefix can have at most 20 characters.');
		if (/[\p{C}\n]/u.test(b.prefix)) throw bad('The Bates prefix contains invisible characters. Use letters, digits and symbols.');
		if (!Number.isInteger(b.digits) || b.digits < 3 || b.digits > 10) throw bad('Bates numbers must have between 3 and 10 digits.');
	}
}

/** Cap height of the stamp font (Noto Sans), in em. The top margin is measured to the cap line. */
export const NUMBER_CAP_EM = 0.714;

export interface NumberLayout {
	/** Left edge of the text, in points from the displayed left edge. */
	x: number;
	/** Baseline, in points from the displayed top edge. */
	baseline: number;
}

/**
 * Where a label goes on a page as displayed, in points (UserUnit applied). The label
 * sits 0.5 in (36 pt) from the nearest edges; on small pages the margin shrinks to a
 * quarter of the shorter side. The text is kept inside the page horizontally.
 */
export function numberLayout(
	pageW: number,
	pageH: number,
	position: PageNumbering['position'],
	size: number,
	textW: number
): NumberLayout {
	const m = Math.min(36, pageW / 4, pageH / 4);
	let x: number;
	if (position.endsWith('left')) x = m;
	else if (position.endsWith('right')) x = pageW - m - textW;
	else x = (pageW - textW) / 2;
	x = Math.min(Math.max(x, 0), Math.max(0, pageW - textW));
	const baseline = position.startsWith('top') ? m + NUMBER_CAP_EM * size : pageH - m;
	return { x, baseline };
}

const squash = (s: string) => s.replace(/\s+/g, '');

function describeLabels(labels: (string | null)[]): string {
	const used = labels.filter((l): l is string => l !== null);
	const first = used[0];
	const last = used[used.length - 1];
	if (used.length === 1) return `Number ${first} is on its page.`;
	if (used.every((l) => /^\d+$/.test(l))) return `Numbers ${first} to ${last} are on their pages.`;
	if (used.every((l) => !/\s/.test(l))) return `Bates ${first} to ${last} are on their pages.`;
	return `Numbers "${first}" to "${last}" are on their pages.`;
}

/**
 * Reads every label back from its page of the final file ('numbering' check): the
 * label must be the text of one run in the margin where it was drawn, upright as the
 * page is displayed. Uses PDF.js, an independent parser.
 */
export async function verifyNumbering(
	deps: EngineDeps,
	finalBytes: Uint8Array,
	labels: (string | null)[],
	password?: string,
	numbering?: Pick<PageNumbering, 'position' | 'size'>
): Promise<VerifyCheck[]> {
	if (labels.every((l) => l === null)) return [];
	const fail = (detail: string): VerifyCheck[] => [{ name: 'numbering', ok: false, detail }];
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
	const missing: number[] = [];
	try {
		const doc = await task.promise;
		if (doc.numPages !== labels.length) {
			return fail(`The file has ${doc.numPages} pages but ${labels.length} were expected, so the numbers cannot be checked.`);
		}
		for (let i = 0; i < labels.length; i++) {
			const label = labels[i];
			if (label === null) continue;
			const page = await doc.getPage(i + 1);
			if (!(await labelIsThere(page, label, numbering))) missing.push(i + 1);
			page.cleanup();
		}
	} catch {
		return fail('The page numbers could not be read back from the file.');
	} finally {
		await task.destroy().catch(() => undefined);
	}
	if (missing.length) {
		const shown = missing.slice(0, 5).join(', ') + (missing.length > 5 ? ` and ${missing.length - 5} more` : '');
		return fail(`The page number was not found in the right place on page ${shown}.`);
	}
	return [{ name: 'numbering', ok: true, detail: describeLabels(labels) }];
}

interface Run {
	text: string;
	x0: number;
	x1: number;
}

async function labelIsThere(
	page: import('pdfjs-dist/legacy/build/pdf.mjs').PDFPageProxy,
	label: string,
	numbering?: Pick<PageNumbering, 'position' | 'size'>
): Promise<boolean> {
	const vp = page.getViewport({ scale: 1 });
	const tc = await page.getTextContent();
	const want = squash(label);
	// Items as upright runs in display space: start and end of the baseline, in points.
	const items: { str: string; x0: number; x1: number; y: number; ok: boolean; size: number }[] = [];
	for (const it of tc.items) {
		if (!('str' in it) || !it.str || squash(it.str) === '') continue;
		const [a, b, , d, e, f] = it.transform as number[];
		const h = Math.hypot(a, b);
		if (h === 0) continue;
		const [x0, y0] = vp.convertToViewportPoint(e, f) as [number, number];
		const [x1, y1] = vp.convertToViewportPoint(e + (it.width * a) / h, f + (it.width * b) / h) as [number, number];
		items.push({ str: it.str, x0, x1, y: y0, ok: Math.abs(y1 - y0) < 0.5 && x1 > x0, size: Math.abs(d) });
	}
	if (!numbering) return items.some((it) => it.ok && squash(it.str) === want);
	const W = vp.width;
	const H = vp.height;
	const pool = items.filter((it) => it.ok).sort((p, q) => p.x0 - q.x0);
	const tol = 2;
	// Group items that share a baseline into runs.
	const runs: (Run & { y: number })[] = [];
	for (const it of pool) {
		const run = runs.find((r) => Math.abs(r.y - it.y) <= 1 && it.x0 - r.x1 <= numbering.size);
		if (run) {
			run.text += squash(it.str);
			run.x1 = Math.max(run.x1, it.x1);
		} else runs.push({ text: squash(it.str), x0: it.x0, x1: it.x1, y: it.y });
	}
	for (const r of runs) {
		if (r.text !== want) continue;
		const lay = numberLayout(W, H, numbering.position, numbering.size, r.x1 - r.x0);
		if (Math.abs(r.x0 - lay.x) <= tol && Math.abs(r.y - lay.baseline) <= tol) return true;
	}
	return false;
}
