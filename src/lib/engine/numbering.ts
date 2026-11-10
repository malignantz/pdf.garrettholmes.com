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

/**
 * Reads every label back from its page of the final file ('numbering' check).
 * Stub until the numbering stream lands: no check yet.
 */
export async function verifyNumbering(
	_deps: EngineDeps,
	_finalBytes: Uint8Array,
	_labels: (string | null)[],
	_password?: string
): Promise<VerifyCheck[]> {
	return [];
}
