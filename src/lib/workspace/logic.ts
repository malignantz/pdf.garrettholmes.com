/**
 * Pure helpers for the workspace: drop-slot maths, keyboard moves, file
 * classification, filename defaults, password rules and copy. No DOM, no Svelte,
 * so everything here is unit-tested in tests/workspace/.
 */

import type { PageId, PageRef, Source } from '../core/types';

// ---------------------------------------------------------------- drop slots

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Insertion slot (0..rects.length, store index semantics) for a pointer at
 * (x, y). `rects` are the tiles in document order, in the same coordinate space
 * as the pointer. Rows are tiles sharing a top edge (within half a tile).
 *
 * Inside a row the slot is before the first tile whose horizontal centre is
 * right of the pointer. Between rows the pointer belongs to the nearer row.
 */
export function dropSlot(rects: readonly Rect[], x: number, y: number): number {
	const n = rects.length;
	if (n === 0) return 0;
	const rows = groupRows(rects);
	// One column: the vertical half of the tile decides.
	if (rows.every((r) => r.end - r.start === 1) && rows.length > 1) {
		for (let i = 0; i < n; i++) if (y < rects[i].top + rects[i].height / 2) return i;
		return n;
	}
	// Pick the row whose vertical band contains y, or the nearest one.
	let row = rows[0];
	let best = Infinity;
	for (const r of rows) {
		const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
		if (d < best) {
			best = d;
			row = r;
		}
		if (d === 0) break;
	}
	for (let i = row.start; i < row.end; i++) {
		const c = rects[i];
		if (x < c.left + c.width / 2) return i;
	}
	return row.end;
}

interface Row {
	start: number;
	end: number;
	top: number;
	bottom: number;
}

function groupRows(rects: readonly Rect[]): Row[] {
	const rows: Row[] = [];
	let cur: Row | null = null;
	for (let i = 0; i < rects.length; i++) {
		const r = rects[i];
		if (cur && Math.abs(r.top - cur.top) <= Math.max(4, r.height / 2) && r.left > rects[i - 1].left) {
			cur.end = i + 1;
			cur.bottom = Math.max(cur.bottom, r.top + r.height);
		} else {
			cur = { start: i, end: i + 1, top: r.top, bottom: r.top + r.height };
			rows.push(cur);
		}
	}
	return rows;
}

/**
 * Where the insertion indicator goes for a slot: the edge of the tile after the
 * slot (its left side), or the right side of the last tile in the row before it.
 * Returns a vertical bar position: x and the row's top and height.
 */
export function indicatorFor(
	rects: readonly Rect[],
	slot: number,
	gap: number,
	/** Pointer y: at a row break, show the bar in the row the pointer is in. */
	y?: number
): { x: number; top: number; height: number } | null {
	if (rects.length === 0) return null;
	const before = slot > 0 ? rects[slot - 1] : undefined;
	const after = slot < rects.length ? rects[slot] : undefined;
	// Same row: centre the bar in the gap between them.
	if (before && after && Math.abs(before.top - after.top) <= before.height / 2) {
		return { x: (before.left + before.width + after.left) / 2, top: after.top, height: after.height };
	}
	if (before && after && y !== undefined && y < before.top + before.height + gap / 2) {
		return { x: before.left + before.width + gap / 2, top: before.top, height: before.height };
	}
	if (after) return { x: after.left - gap / 2, top: after.top, height: after.height };
	const b = before!;
	return { x: b.left + b.width + gap / 2, top: b.top, height: b.height };
}

/** True when dropping the moved pages at `slot` would change nothing. */
export function isNoopMove(pages: readonly { id: PageId }[], moving: ReadonlySet<PageId>, slot: number): boolean {
	const idx: number[] = [];
	pages.forEach((p, i) => {
		if (moving.has(p.id)) idx.push(i);
	});
	if (idx.length === 0) return true;
	const contiguous = idx[idx.length - 1] - idx[0] === idx.length - 1;
	return contiguous && slot >= idx[0] && slot <= idx[idx.length - 1] + 1;
}

/**
 * Slot for an Alt+Arrow keyboard move of the selected pages by `delta`
 * positions (±1 for left/right, ±columns for up/down). The block is gathered
 * like movePages does. Returns null when the move does nothing.
 */
export function keyboardMoveSlot(
	pages: readonly { id: PageId }[],
	selected: ReadonlySet<PageId>,
	delta: number
): number | null {
	const idx: number[] = [];
	pages.forEach((p, i) => {
		if (selected.has(p.id)) idx.push(i);
	});
	if (idx.length === 0 || delta === 0) return null;
	const first = idx[0];
	const last = idx[idx.length - 1];
	let slot: number;
	if (delta < 0) slot = Math.max(0, first + delta);
	else slot = Math.min(pages.length, last + 1 + delta);
	return isNoopMove(pages, selected, slot) ? null : slot;
}

/** Slot right after the last selected page, or the end when nothing is selected. */
export function slotAfterSelection(pages: readonly { id: PageId }[], selected: ReadonlySet<PageId>): number {
	if (selected.size === 0) return pages.length;
	let last = -1;
	pages.forEach((p, i) => {
		if (selected.has(p.id)) last = i;
	});
	return last < 0 ? pages.length : last + 1;
}

// ---------------------------------------------------------------- intake

export type FileKind =
	| { kind: 'pdf' }
	| { kind: 'image'; mime: 'image/jpeg' | 'image/png' }
	/** Another image type: decode with the browser and convert to PNG. */
	| { kind: 'convert' }
	| { kind: 'unsupported'; reason: string };

const IMAGE_EXT = /\.(webp|gif|bmp|avif|heic|heif|tiff?|ico|svg)$/i;

/** Decide how to open a file from its first bytes, then its type and name. */
export function classifyFile(head: Uint8Array, name: string, mime: string): FileKind {
	if (findPdfHeader(head)) return { kind: 'pdf' };
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
	if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
		return { kind: 'image', mime: 'image/png' };
	}
	const lower = name.toLowerCase();
	if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
		return { kind: 'unsupported', reason: `${name} does not look like a PDF. It may be damaged or only named .pdf.` };
	}
	if (mime.startsWith('image/') || IMAGE_EXT.test(lower)) return { kind: 'convert' };
	return { kind: 'unsupported', reason: `${name} is not a PDF or an image. Only PDFs and images can be added.` };
}

/** PDF readers accept a %PDF- header anywhere in the first 1024 bytes. */
function findPdfHeader(head: Uint8Array): boolean {
	const max = Math.min(head.length - 5, 1024);
	for (let i = 0; i <= max; i++) {
		if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) {
			return true;
		}
	}
	return false;
}

/** Name for a converted image: photo.webp -> photo.png. */
export function pngName(name: string): string {
	const base = name.replace(/\.[^./\\]+$/, '');
	return `${base || 'image'}.png`;
}

// ---------------------------------------------------------------- export

/** Strip the extension and characters that are not allowed in file names. */
export function baseName(name: string): string {
	const noExt = name.replace(/\.(pdf|png|jpe?g|webp|gif|bmp|heic|heif|avif|tiff?)$/i, '');
	return sanitize(noExt) || 'document';
}

function sanitize(name: string): string {
	return name
		.replace(/[\\/:*?"<>|\p{C}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.slice(0, 120)
		.trim();
}

/**
 * Smart default file name: one source -> name-edited.pdf, several -> first
 * source + -merged, extract -> -pages. `sourceNames` are the sources of the
 * exported pages in page order.
 */
export function defaultFilename(sourceNames: readonly string[], mode: 'all' | 'extract'): string {
	const unique = [...new Set(sourceNames)];
	const first = baseName(unique[0] ?? 'document');
	if (mode === 'extract') return `${first}-pages.pdf`;
	if (unique.length > 1) return `${first}-merged.pdf`;
	return `${first}-edited.pdf`;
}

/** Make whatever the user typed a safe file name ending in .pdf. */
export function normalizeFilename(input: string, fallback = 'document.pdf'): string {
	const s = sanitize(input.replace(/\.pdf$/i, ''));
	return s ? `${s}.pdf` : fallback;
}

/** Mirror of the engine's password rules, for inline validation. Null when fine. */
export function passwordProblem(pw: string): string | null {
	if (pw.length === 0) return 'Choose a password with at least one character.';
	if (/[\p{C}]/u.test(pw)) return 'The password contains invisible characters. Use letters, digits and symbols.';
	if (new TextEncoder().encode(pw).length > 127) {
		return 'The password is too long. Use at most 127 bytes (about 100 characters).';
	}
	if (pw !== pw.normalize('NFKC')) {
		return 'The password contains characters that some PDF readers treat differently. Use other characters.';
	}
	return null;
}

// ---------------------------------------------------------------- copy

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
	const mb = n / (1024 * 1024);
	return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

const PAST: Record<string, string> = {
	Rotate: 'Rotated',
	Delete: 'Deleted',
	Move: 'Moved',
	Duplicate: 'Duplicated',
	Add: 'Added',
	Insert: 'Inserted',
	Reverse: 'Reversed',
	Remove: 'Removed',
	Sort: 'Sorted',
	Group: 'Grouped',
	Clear: 'Cleared',
	Open: 'Opened'
};

/** "Rotate 3 pages" -> "Rotated 3 pages", for the live region. */
export function pastTense(label: string): string {
	const [first, ...rest] = label.split(' ');
	const p = PAST[first];
	return p ? [p, ...rest].join(' ') : label;
}

/** "Added 12 pages after page 4" / "Added 3 pages". */
export function addedMessage(count: number, at: number, total: number): string {
	const what = `Added ${plural(count, 'page')}`;
	if (at <= 0 && total > count) return `${what} at the start`;
	if (at >= total - count) return what;
	return `${what} after page ${at}`;
}

/** Which tiles start a run of pages from a source different from the previous tile. */
export function sourceBoundaries(pages: readonly PageRef[]): Set<PageId> {
	const out = new Set<PageId>();
	let prev: string | null = null;
	for (const p of pages) {
		if (p.sourceId !== prev) out.add(p.id);
		prev = p.sourceId;
	}
	return out;
}

/** Display name for a source in the grid: blank pages have no file. */
export function sourceLabel(s: Source | undefined): string {
	if (!s) return '';
	if (s.kind === 'blank') return 'Blank page';
	return s.name;
}

// ---------------------------------------------------------------- verification copy

/**
 * One plain sentence per verification check, for people who have never heard of
 * qpdf or PDF.js. The engine's own wording goes in a "Details" disclosure.
 */
export function plainCheck(
	c: { name: 'structure' | 'page-count' | 'page-sizes' | 'reopen' | 'encryption'; ok: boolean; detail: string },
	pageCount: number
): string {
	const pages = plural(pageCount, 'page');
	switch (c.name) {
		case 'structure':
			if (/metadata/i.test(c.detail)) {
				return c.ok
					? 'Hidden details such as author and dates are removed.'
					: 'Some hidden details such as author or dates could not be removed.';
			}
			return c.ok ? 'The file is built correctly, with no errors.' : 'The file has errors in how it is built.';
		case 'reopen':
			return c.ok ? `It opens cleanly, all ${pages}.` : 'It did not open cleanly when we tried it.';
		case 'page-count':
			return c.ok ? `It has ${pages}, as arranged.` : 'It does not have the number of pages you arranged.';
		case 'page-sizes':
			return c.ok ? 'Every page keeps its size and orientation.' : 'Some pages came out a different size.';
		case 'encryption':
			if (/no password/i.test(c.detail) && c.ok) return 'It has no password, as you chose.';
			return c.ok ? 'It opens only with your password.' : 'The password protection is not right.';
	}
}
