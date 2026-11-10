import { describe, expect, it } from 'vitest';
import {
	addedMessage,
	baseName,
	classifyFile,
	defaultFilename,
	dropSlot,
	formatBytes,
	indicatorFor,
	isNoopMove,
	keyboardMoveSlot,
	normalizeFilename,
	passwordProblem,
	pastTense,
	pngName,
	slotAfterSelection,
	sourceBoundaries,
	type Rect
} from '../../src/lib/workspace/logic';
import type { PageRef } from '../../src/lib/core/types';

/** A grid of `n` tiles, `cols` per row, 100x140 with a 20px gap. */
function grid(n: number, cols: number): Rect[] {
	return Array.from({ length: n }, (_, i) => ({
		left: (i % cols) * 120,
		top: Math.floor(i / cols) * 160,
		width: 100,
		height: 140
	}));
}

const ids = (s: string) => [...s].map((id) => ({ id }));

describe('dropSlot', () => {
	const g = grid(10, 4); // rows: 0-3, 4-7, 8-9

	it('returns 0 for an empty grid', () => {
		expect(dropSlot([], 10, 10)).toBe(0);
	});

	it('picks the slot before the tile whose centre is right of the pointer', () => {
		expect(dropSlot(g, 10, 50)).toBe(0); // left half of tile 0
		expect(dropSlot(g, 60, 50)).toBe(1); // right half of tile 0
		expect(dropSlot(g, 110, 50)).toBe(1); // in the gap
		expect(dropSlot(g, 290, 50)).toBe(3);
	});

	it('past the last tile of a row gives the slot after it (end of row)', () => {
		expect(dropSlot(g, 470, 50)).toBe(4);
		expect(dropSlot(g, 900, 200)).toBe(8);
	});

	it('uses the second row for pointers inside it', () => {
		expect(dropSlot(g, 10, 200)).toBe(4);
		expect(dropSlot(g, 180, 200)).toBe(6);
	});

	it('partial last row: right of it means the very end', () => {
		expect(dropSlot(g, 300, 330)).toBe(10);
		expect(dropSlot(g, 10, 330)).toBe(8);
	});

	it('above the grid snaps to the first row, below to the last', () => {
		expect(dropSlot(g, 10, -500)).toBe(0);
		expect(dropSlot(g, 900, 5000)).toBe(10);
	});

	it('between rows chooses the nearer row', () => {
		expect(dropSlot(g, 10, 145)).toBe(0); // 5px below row 0, 15px above row 1
		expect(dropSlot(g, 10, 155)).toBe(4);
	});

	it('single column', () => {
		const c = grid(3, 1);
		expect(dropSlot(c, 50, 10)).toBe(0);
		expect(dropSlot(c, 80, 170)).toBe(1);
		expect(dropSlot(c, 80, 250)).toBe(2);
		expect(dropSlot(c, 80, 999)).toBe(3);
	});
});

describe('indicatorFor', () => {
	const g = grid(6, 3);
	it('sits in the gap between tiles of one row', () => {
		expect(indicatorFor(g, 1, 20)).toEqual({ x: 110, top: 0, height: 140 });
	});
	it('starts a row on its left edge', () => {
		expect(indicatorFor(g, 3, 20)).toEqual({ x: -10, top: 160, height: 140 });
	});
	it('after the last tile', () => {
		expect(indicatorFor(g, 6, 20)).toEqual({ x: 350, top: 160, height: 140 });
	});
	it('at a row break follows the pointer row', () => {
		expect(indicatorFor(g, 3, 20, 50)).toEqual({ x: 350, top: 0, height: 140 });
		expect(indicatorFor(g, 3, 20, 200)).toEqual({ x: -10, top: 160, height: 140 });
	});
	it('null for no tiles', () => {
		expect(indicatorFor([], 0, 20)).toBeNull();
	});
});

describe('isNoopMove', () => {
	const p = ids('abcdef');
	it('contiguous block dropped on itself is a no-op', () => {
		const s = new Set(['b', 'c']);
		expect(isNoopMove(p, s, 1)).toBe(true);
		expect(isNoopMove(p, s, 2)).toBe(true);
		expect(isNoopMove(p, s, 3)).toBe(true);
		expect(isNoopMove(p, s, 4)).toBe(false);
		expect(isNoopMove(p, s, 0)).toBe(false);
	});
	it('scattered selection always moves', () => {
		expect(isNoopMove(p, new Set(['a', 'c']), 1)).toBe(false);
	});
});

describe('keyboardMoveSlot', () => {
	const p = ids('abcdef');
	it('moves one left and right', () => {
		expect(keyboardMoveSlot(p, new Set(['c']), -1)).toBe(1);
		expect(keyboardMoveSlot(p, new Set(['c']), 1)).toBe(4);
	});
	it('moves a row with columns', () => {
		expect(keyboardMoveSlot(p, new Set(['a']), 3)).toBe(4);
		expect(keyboardMoveSlot(p, new Set(['e']), -3)).toBe(1);
	});
	it('is null at the edges', () => {
		expect(keyboardMoveSlot(p, new Set(['a']), -1)).toBeNull();
		expect(keyboardMoveSlot(p, new Set(['f']), 1)).toBeNull();
		expect(keyboardMoveSlot(p, new Set(), 1)).toBeNull();
	});
	it('clamps past the end', () => {
		expect(keyboardMoveSlot(p, new Set(['d']), 10)).toBe(6);
	});
	it('gathers a scattered selection', () => {
		expect(keyboardMoveSlot(p, new Set(['b', 'd']), -1)).toBe(0);
	});
});

describe('slotAfterSelection', () => {
	const p = ids('abcd');
	it('end when nothing is selected', () => expect(slotAfterSelection(p, new Set())).toBe(4));
	it('after the last selected page', () => expect(slotAfterSelection(p, new Set(['a', 'b']))).toBe(2));
});

describe('classifyFile', () => {
	const bytes = (s: string | number[]) => (typeof s === 'string' ? new TextEncoder().encode(s) : new Uint8Array(s));
	it('sniffs PDF, JPEG and PNG by content', () => {
		expect(classifyFile(bytes('%PDF-1.7\n'), 'x.bin', '')).toEqual({ kind: 'pdf' });
		expect(classifyFile(bytes('junk junk %PDF-1.4'), 'x.pdf', '')).toEqual({ kind: 'pdf' });
		expect(classifyFile(bytes([0xff, 0xd8, 0xff, 0xe0]), 'a.png', 'image/png')).toEqual({
			kind: 'image',
			mime: 'image/jpeg'
		});
		expect(classifyFile(bytes([0x89, 0x50, 0x4e, 0x47, 13, 10]), 'a', '')).toEqual({ kind: 'image', mime: 'image/png' });
	});
	it('other images are converted', () => {
		expect(classifyFile(bytes('RIFF....WEBP'), 'a.webp', 'image/webp').kind).toBe('convert');
		expect(classifyFile(bytes('GIF89a'), 'a.gif', '').kind).toBe('convert');
		expect(classifyFile(bytes('....ftypheic'), 'IMG_1.HEIC', '').kind).toBe('convert');
	});
	it('rejects fake PDFs and other files with the file name in the message', () => {
		const fake = classifyFile(bytes('hello'), 'report.pdf', 'application/pdf');
		expect(fake.kind).toBe('unsupported');
		expect(fake.kind === 'unsupported' && fake.reason).toContain('report.pdf');
		const doc = classifyFile(bytes('PK\x03\x04'), 'letter.docx', 'application/vnd.openxmlformats');
		expect(doc.kind === 'unsupported' && doc.reason).toBe(
			'letter.docx is not a PDF or an image. Only PDFs and images can be added.'
		);
	});
});

describe('file names', () => {
	it('pngName', () => {
		expect(pngName('photo.webp')).toBe('photo.png');
		expect(pngName('.gif')).toBe('image.png');
	});
	it('baseName strips extensions and illegal characters', () => {
		expect(baseName('scan.PDF')).toBe('scan');
		expect(baseName('a/b:c?.pdf')).toBe('a b c');
		expect(baseName('...pdf')).toBe('document');
	});
	it('defaultFilename', () => {
		expect(defaultFilename(['contract.pdf'], 'all')).toBe('contract-edited.pdf');
		expect(defaultFilename(['contract.pdf', 'contract.pdf'], 'all')).toBe('contract-edited.pdf');
		expect(defaultFilename(['contract.pdf', 'id.jpg'], 'all')).toBe('contract-merged.pdf');
		expect(defaultFilename(['contract.pdf', 'id.jpg'], 'extract')).toBe('contract-pages.pdf');
		expect(defaultFilename([], 'all')).toBe('document-edited.pdf');
	});
	it('normalizeFilename', () => {
		expect(normalizeFilename('out')).toBe('out.pdf');
		expect(normalizeFilename('out.PDF')).toBe('out.pdf');
		expect(normalizeFilename('  ')).toBe('document.pdf');
		expect(normalizeFilename('a<b>.pdf')).toBe('a b.pdf');
	});
});

describe('passwordProblem', () => {
	it('accepts ordinary passwords', () => {
		expect(passwordProblem('correct horse')).toBeNull();
		expect(passwordProblem('pässwörd')).toBeNull();
	});
	it('rejects empty, control characters, too long and non-NFKC', () => {
		expect(passwordProblem('')).toMatch(/at least one/);
		expect(passwordProblem('a\u0007b')).toMatch(/invisible/);
		expect(passwordProblem('x'.repeat(128))).toMatch(/too long/);
		expect(passwordProblem('ﬁ')).toMatch(/treat differently/);
	});
});

describe('copy', () => {
	it('formatBytes', () => {
		expect(formatBytes(500)).toBe('500 B');
		expect(formatBytes(2048)).toBe('2 KB');
		expect(formatBytes(3.45 * 1024 * 1024)).toBe('3.5 MB');
		expect(formatBytes(42 * 1024 * 1024)).toBe('42 MB');
	});
	it('pastTense', () => {
		expect(pastTense('Rotate 3 pages')).toBe('Rotated 3 pages');
		expect(pastTense('Delete page')).toBe('Deleted page');
		expect(pastTense('Whatever')).toBe('Whatever');
	});
	it('addedMessage', () => {
		expect(addedMessage(12, 4, 20)).toBe('Added 12 pages after page 4');
		expect(addedMessage(3, 5, 8)).toBe('Added 3 pages');
		expect(addedMessage(1, 0, 1)).toBe('Added 1 page');
		expect(addedMessage(2, 0, 5)).toBe('Added 2 pages at the start');
	});
	it('sourceBoundaries', () => {
		const p = (id: string, sourceId: string): PageRef => ({ id, sourceId, pageIndex: 0, rotation: 0, stamps: [] });
		const b = sourceBoundaries([p('1', 'a'), p('2', 'a'), p('3', 'b'), p('4', 'a')]);
		expect([...b]).toEqual(['1', '3', '4']);
	});
});

describe('plainCheck', () => {
	it('never names tools in the main line', async () => {
		const { plainCheck } = await import('../../src/lib/workspace/logic');
		const cases = [
			{ name: 'structure', ok: true, detail: 'qpdf --check found no syntax or stream errors.' },
			{ name: 'structure', ok: true, detail: 'Metadata removed: no Info dictionary and no XMP streams remain.' },
			{ name: 'reopen', ok: true, detail: 'PDF.js opened the file and all 3 pages.' },
			{ name: 'page-count', ok: true, detail: '3 pages, as planned.' },
			{ name: 'page-sizes', ok: false, detail: 'Page 2 is 600 x 800.' },
			{ name: 'encryption', ok: true, detail: 'No password, as planned.' },
			{ name: 'encryption', ok: true, detail: 'AES-256: the file opens only with the password.' }
		] as const;
		const out = cases.map((c) => plainCheck(c, 3));
		expect(out).toEqual([
			'The file is built correctly, with no errors.',
			'Hidden details such as author and dates are removed.',
			'It opens cleanly, all 3 pages.',
			'It has 3 pages, as arranged.',
			'Some pages came out a different size.',
			'It has no password, as you chose.',
			'It opens only with your password.'
		]);
		for (const line of out) expect(line).not.toMatch(/qpdf|PDF\.js|XMP|AES/);
	});
});
