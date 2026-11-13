/**
 * "Split into several files" in the export dialog: which pages go in which file, how
 * page numbers carry on across the files, and what the files are called. Pure; the
 * export itself is multi-export.ts (every part is one ordinary verified export).
 *
 * Rules (plan: "Pictures and split export"):
 * - 'each': one file per page. 'every': N pages per file, the last may be shorter.
 *   'at': a new file starts at each listed page ("5, 12" on 20 pages: 1–4, 5–11, 12–20).
 * - 'files': one file per opened file, in the order each first appears in the export,
 *   holding that file's pages in their current order (a page that was moved away from
 *   its file still goes with it). Blank pages the user inserted belong to the opened
 *   file of the nearest page before them (the first page after them when nothing comes
 *   before). Offered only when the export holds pages of more than one opened file.
 * - Page numbers continue across the files, as Bates numbering expects: file 2 starts
 *   where file 1 stopped, "of total" styles print the whole export's total, and the
 *   pages skipped as covers are the first pages of the whole export. A file whose pages
 *   are all covers gets no numbers.
 */

import type { PageNumbering, PageRef, Source, SourceId } from '../core/types';
import { plural } from './logic';

export type SplitRule = 'each' | 'every' | 'files' | 'at';

export const SPLIT_RULES: readonly { value: SplitRule; label: string }[] = [
	{ value: 'each', label: 'Every page on its own' },
	{ value: 'every', label: 'Every N pages' },
	{ value: 'at', label: 'At these pages' },
	{ value: 'files', label: 'One file per original file' }
];

/** Most files one split makes (each is a full export; the zip format allows more). */
export const MAX_PARTS = 1000;

/** One part: 0-based indexes into the export's pages, in the order they go in the file. */
export type Part = number[];

export type SplitResult = { ok: true; parts: Part[] } | { ok: false; problem: string };

/** Opened files (not inserted blanks) that pages of the export come from. */
export function openedFileCount(pages: readonly Pick<PageRef, 'sourceId'>[], sources: readonly Pick<Source, 'id' | 'kind'>[]): number {
	const kind = new Map(sources.map((s) => [s.id, s.kind]));
	return new Set(pages.filter((p) => kind.get(p.sourceId) !== 'blank').map((p) => p.sourceId)).size;
}

function whole(text: string): number | null {
	return /^\s*\d{1,7}\s*$/.test(text) ? Number(text.trim()) : null;
}

/** "Every N pages": the number, or what to fix. */
export function parseEvery(text: string, count: number): { n: number } | { problem: string } {
	const n = whole(text);
	if (n === null || n < 1) return { problem: 'Enter a whole number of pages, 1 or more.' };
	if (n >= count) return { problem: `That makes one file. Choose fewer than ${plural(count, 'page')}.` };
	return { n };
}

/** "At these pages": the pages that start a new file, sorted, or what to fix. */
export function parseStarts(text: string, count: number): { starts: number[] } | { problem: string } {
	const bits = text.split(/[\s,;]+/).filter(Boolean);
	if (bits.length === 0) return { problem: 'Enter the pages where a new file starts, such as 5, 12.' };
	const out = new Set<number>();
	for (const b of bits) {
		const n = whole(b);
		if (n === null) return { problem: `"${b}" is not a page number. Use whole numbers separated by commas.` };
		if (n === 1) continue; // The first file always starts at page 1.
		if (n < 1 || n > count) return { problem: `There is no page ${n}. Use pages 2 to ${count}.` };
		out.add(n);
	}
	if (out.size === 0) return { problem: `Page 1 always starts the first file. Enter pages from 2 to ${count}.` };
	return { starts: [...out].sort((a, b) => a - b) };
}

/**
 * The parts for a rule. `every` and `at` are the dialog's text fields. Fails with a
 * sentence when the settings make no sense or make a single file.
 */
export function planSplit(
	pages: readonly Pick<PageRef, 'sourceId'>[],
	sources: readonly Pick<Source, 'id' | 'kind'>[],
	rule: SplitRule,
	every: string,
	at: string
): SplitResult {
	const count = pages.length;
	if (count < 2) return { ok: false, problem: 'Splitting needs at least 2 pages.' };
	let parts: Part[];
	if (rule === 'each') {
		parts = pages.map((_, i) => [i]);
	} else if (rule === 'every') {
		const r = parseEvery(every, count);
		if ('problem' in r) return { ok: false, problem: r.problem };
		parts = [];
		for (let i = 0; i < count; i += r.n) parts.push(range(i, Math.min(count, i + r.n)));
	} else if (rule === 'at') {
		const r = parseStarts(at, count);
		if ('problem' in r) return { ok: false, problem: r.problem };
		const cuts = [1, ...r.starts, count + 1];
		parts = [];
		for (let k = 0; k + 1 < cuts.length; k++) parts.push(range(cuts[k] - 1, cuts[k + 1] - 1));
	} else {
		parts = byOpenedFile(pages, sources);
		if (parts.length < 2) return { ok: false, problem: 'All pages come from one file, so this makes one file.' };
	}
	if (parts.length > MAX_PARTS) {
		return { ok: false, problem: `That makes ${parts.length} files; one export makes at most ${MAX_PARTS}. Choose more pages per file.` };
	}
	return { ok: true, parts };
}

function range(a: number, b: number): number[] {
	return Array.from({ length: b - a }, (_, i) => a + i);
}

function byOpenedFile(pages: readonly Pick<PageRef, 'sourceId'>[], sources: readonly Pick<Source, 'id' | 'kind'>[]): Part[] {
	const blank = new Set(sources.filter((s) => s.kind === 'blank').map((s) => s.id));
	// The opened file each page belongs to: its own, or for a blank page the nearest before it (else after).
	const owner: (SourceId | null)[] = pages.map((p) => (blank.has(p.sourceId) ? null : p.sourceId));
	let last: SourceId | null = null;
	for (let i = 0; i < owner.length; i++) {
		if (owner[i] === null) owner[i] = last;
		else last = owner[i];
	}
	const firstReal = owner.find((o) => o !== null) ?? null;
	const groups = new Map<SourceId | null, number[]>();
	owner.forEach((o, i) => {
		const key = o ?? firstReal;
		let g = groups.get(key);
		if (!g) groups.set(key, (g = []));
		g.push(i);
	});
	return [...groups.values()];
}

/**
 * Page numbers for each part so that they continue across the files (see the top of
 * this file); undefined for a part whose pages are all left unnumbered.
 */
export function partNumbering(numbering: PageNumbering, parts: readonly Part[]): (PageNumbering | undefined)[] {
	const count = parts.reduce((n, p) => n + p.length, 0);
	const total = numbering.start + Math.max(0, count - numbering.skip) - 1;
	let before = 0;
	return parts.map((p) => {
		const skip = Math.max(0, numbering.skip - before);
		const numberedBefore = Math.max(0, before - numbering.skip);
		before += p.length;
		if (skip >= p.length) return undefined;
		return { ...numbering, skip, start: numbering.start + numberedBefore, total };
	});
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** "report-part-01.pdf" … (at least two digits, more when there are 100 parts or more). */
export function partName(base: string, index: number, count: number): string {
	return `${base}-part-${pad(index + 1, Math.max(2, String(count).length))}.pdf`;
}

/** Page numbers in a part as the user counts them: "pages 3–4", "page 5", "4 pages". */
export function partPages(part: Part): string {
	if (part.length === 1) return `page ${part[0] + 1}`;
	const contiguous = part.every((p, i) => i === 0 || p === part[i - 1] + 1);
	return contiguous ? `pages ${part[0] + 1}–${part[part.length - 1] + 1}` : plural(part.length, 'page');
}

/** The line under the split choices: what the export will make. */
export function splitSummary(parts: readonly Part[], names?: readonly string[]): string {
	const n = parts.length;
	if (parts.every((p) => p.length === 1)) return `Makes ${n} files, one page each, in one zip.`;
	const items = parts.map((p, i) => (names ? `${names[i]} (${plural(p.length, 'page')})` : partPages(p)));
	const shown = items.length > 6 ? [...items.slice(0, 3), '…', ...items.slice(-2)] : items;
	return `Makes ${n} files in one zip: ${shown.join(', ')}.`;
}
