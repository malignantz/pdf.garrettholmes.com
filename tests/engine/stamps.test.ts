import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import type { Asset, EngineErrorShape, PageRef, Rotation, Source, Stamp, StampBox } from '../../src/lib/core/types';
import {
	STAMP_BASELINE_EM,
	applyMatrix,
	displayToPdf,
	stampBoxMatrix,
	stampPdfRect,
	uprightFrame,
	visibleBox,
	type Box,
	type Matrix
} from '../../src/lib/engine/geometry';
import { graphicsNesting } from '../../src/lib/engine/content';
import { EngineError } from '../../src/lib/engine/errors';
import { corpus, defaultOptions, engine, loadPdfjs, openCorpus, pageTexts, ref } from './helpers';

const T = 60_000;

// ---------------------------------------------------------------------------
// Pure geometry against hand-calculated rectangles.

describe('stamp geometry (hand-calculated)', () => {
	const letter: Box = { x0: 0, y0: 0, x1: 612, y1: 792 };
	const offset: Box = { x0: 150, y0: 250, x1: 500, y1: 700 };
	const s1: StampBox = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
	const s2: StampBox = { x: 0.5, y: 0.5, w: 0.2, h: 0.1 };
	const cases: [string, Box, Rotation, StampBox, [number, number, number, number]][] = [
		['letter 0', letter, 0, s1, [61.2, 554.4, 244.8, 633.6]],
		['letter 90', letter, 90, s1, [122.4, 79.2, 183.6, 316.8]],
		['letter 180', letter, 180, s1, [367.2, 158.4, 550.8, 237.6]],
		['letter 270', letter, 270, s1, [428.4, 475.2, 489.6, 712.8]],
		['offset crop 0', offset, 0, s2, [325, 430, 395, 475]],
		['offset crop 90', offset, 90, s2, [325, 475, 360, 565]],
		['offset crop 180', offset, 180, s2, [255, 475, 325, 520]],
		['offset crop 270', offset, 270, s2, [290, 385, 325, 475]]
	];
	for (const [name, box, rot, s, [x0, y0, x1, y1]] of cases) {
		it(name, () => {
			const r = stampPdfRect(box, rot, s);
			expect(r.x0).toBeCloseTo(x0, 6);
			expect(r.y0).toBeCloseTo(y0, 6);
			expect(r.x1).toBeCloseTo(x1, 6);
			expect(r.y1).toBeCloseTo(y1, 6);
		});
	}

	it('box = CropBox ∩ MediaBox, normalized, like PDF.js', () => {
		expect(visibleBox([0, 0, 400, 400], [-50, -50, 700, 900])).toEqual({ x0: 0, y0: 0, x1: 400, y1: 400 });
		expect(visibleBox([0, 0, 612, 792], [456, 672, 36, 72])).toEqual({ x0: 36, y0: 72, x1: 456, y1: 672 });
		expect(visibleBox([0, 0, 612, 792], [700, 800, 900, 900])).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
		expect(visibleBox(undefined, undefined)).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
	});

	for (const rot of [0, 90, 180, 270] as Rotation[]) {
		it(`image matrix is upright at rotation ${rot}`, () => {
			const box = offset;
			const s = s2;
			const m = stampBoxMatrix(box, rot, s);
			const W = rot % 180 ? 450 : 350;
			const H = rot % 180 ? 350 : 450;
			const left = s.x * W;
			const top = s.y * H;
			const right = left + s.w * W;
			const bottom = top + s.h * H;
			const near = (a: [number, number], b: [number, number]) => {
				expect(a[0]).toBeCloseTo(b[0], 6);
				expect(a[1]).toBeCloseTo(b[1], 6);
			};
			// Image top-left (0,1) at the box's top-left on screen, and so on.
			near(applyMatrix(m, 0, 1), displayToPdf(box, rot, left, top));
			near(applyMatrix(m, 1, 1), displayToPdf(box, rot, right, top));
			near(applyMatrix(m, 0, 0), displayToPdf(box, rot, left, bottom));
			near(applyMatrix(m, 1, 0), displayToPdf(box, rot, right, bottom));
			// The frame's axes are unit-length and orthogonal (no skew or scaling).
			const f = uprightFrame(box, rot, 0, 0);
			expect(Math.hypot(f[0], f[1])).toBeCloseTo(1, 9);
			expect(f[0] * f[2] + f[1] * f[3]).toBeCloseTo(0, 9);
			expect(f[0] * f[3] - f[1] * f[2]).toBeCloseTo(1, 9);
		});
	}
});

describe('content q/Q scanner', () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	it('counts nesting, ignoring strings, comments, names and inline images', () => {
		expect(graphicsNesting([enc('q 1 0 0 1 0 0 cm Q')])).toEqual({ minDepth: 0, finalDepth: 0 });
		expect(graphicsNesting([enc('q q'), enc('Q')])).toEqual({ minDepth: 0, finalDepth: 1 });
		expect(graphicsNesting([enc('Q Q q')])).toEqual({ minDepth: -2, finalDepth: -1 });
		expect(graphicsNesting([enc('(q \\) Q (Q)) Tj % q q q\n /Q /q <71> q')])).toEqual({ minDepth: 0, finalDepth: 1 });
		expect(graphicsNesting([enc('BI /W 1 /H 1 ID \x00Q q Q\x01 EI Q')])).toEqual({ minDepth: -1, finalDepth: -1 });
		expect(graphicsNesting([enc('qQ')])).toEqual({ minDepth: 0, finalDepth: 0 }); // "qQ" is one unknown token
		expect(graphicsNesting([enc('<< /A (q) >> q')])).toEqual({ minDepth: 0, finalDepth: 1 });
	});
	it('treats stream boundaries as whitespace', () => {
		expect(graphicsNesting([enc('q'), enc('q')])).toEqual({ minDepth: 0, finalDepth: 2 });
	});
});

// ---------------------------------------------------------------------------
// Stamps in real exports, checked through PDF.js (an independent parser): the
// matrix PDF.js sees when it paints, mapped through PDF.js's own viewport.

function solidPng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
	const crcTable = new Uint32Array(256).map((_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (b: Buffer) => {
		let c = 0xffffffff;
		for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
	const raw = Buffer.concat(Array.from({ length: h }, () => row));
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk('IHDR', ihdr),
			chunk('IDAT', zlib.deflateSync(raw)),
			chunk('IEND', Buffer.alloc(0))
		])
	);
}

const red: Asset = { id: 'red', kind: 'image', png: solidPng(8, 8, [255, 0, 0]), width: 8, height: 8 };
const sig: Asset = { id: 'sig', kind: 'signature', png: corpus('signature.png'), width: 240, height: 80 };

interface Painted {
	images: Matrix[];
	paths: Matrix[];
}

function mul(m: Matrix, n: Matrix): Matrix {
	return [
		m[0] * n[0] + m[1] * n[2],
		m[0] * n[1] + m[1] * n[3],
		m[2] * n[0] + m[3] * n[2],
		m[2] * n[1] + m[3] * n[3],
		m[4] * n[0] + m[5] * n[2] + n[4],
		m[4] * n[1] + m[5] * n[3] + n[5]
	];
}

async function inspect(bytes: Uint8Array) {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), verbosity: 0, useWasm: false, isOffscreenCanvasSupported: false });
	const doc = await task.promise;
	const pages: {
		viewport: { width: number; height: number; toDisplay: (x: number, y: number) => [number, number] };
		painted: Painted;
		text: { str: string; transform: number[] }[];
	}[] = [];
	for (let i = 1; i <= doc.numPages; i++) {
		const page = await doc.getPage(i);
		const vp = page.getViewport({ scale: 1 });
		const ol = await page.getOperatorList();
		const painted: Painted = { images: [], paths: [] };
		let ctm: Matrix = [1, 0, 0, 1, 0, 0];
		const stack: Matrix[] = [];
		ol.fnArray.forEach((fn, k) => {
			const args = ol.argsArray[k] as unknown[];
			if (fn === lib.OPS.save) stack.push(ctm);
			else if (fn === lib.OPS.restore) ctm = stack.pop() ?? ctm;
			else if (fn === lib.OPS.transform) ctm = mul(args as Matrix, ctm);
			else if (fn === lib.OPS.paintImageXObject) painted.images.push(ctm);
			else if (fn === lib.OPS.constructPath) painted.paths.push(ctm);
		});
		const tc = await page.getTextContent();
		pages.push({
			viewport: {
				width: vp.width,
				height: vp.height,
				toDisplay: (x, y) => vp.convertToViewportPoint(x, y) as [number, number]
			},
			painted,
			text: tc.items.filter((it) => 'str' in it && it.str) as { str: string; transform: number[] }[]
		});
	}
	await task.destroy();
	return pages;
}

function expectNear(a: [number, number], b: [number, number], tol = 0.05) {
	expect(Math.abs(a[0] - b[0]), `x ${a[0]} vs ${b[0]}`).toBeLessThan(tol);
	expect(Math.abs(a[1] - b[1]), `y ${a[1]} vs ${b[1]}`).toBeLessThan(tol);
}

/** The image's corners as PDF.js would put them on screen. */
function imageOnScreen(page: Awaited<ReturnType<typeof inspect>>[number], m: Matrix) {
	const d = (x: number, y: number) => page.viewport.toDisplay(...applyMatrix(m, x, y));
	return { tl: d(0, 1), tr: d(1, 1), bl: d(0, 0), br: d(1, 0) };
}

function stampsFor(k: number): Stamp[] {
	const box: StampBox = { x: 0.1 + 0.05 * (k % 4), y: 0.15 + 0.04 * (k % 5), w: 0.3, h: 0.12 };
	return [
		{ id: `i${k}`, kind: 'image', assetId: k % 2 ? 'sig' : 'red', box },
		{ id: `t${k}`, kind: 'text', text: `Signed ${k} Grüße`, x: 0.12, y: 0.6, size: 0.03, color: (['black', 'blue', 'red'] as const)[k % 3] },
		{ id: `m${k}`, kind: 'mark', mark: (['check', 'cross', 'dot'] as const)[k % 3], box: { x: 0.7, y: 0.7, w: 0.08, h: 0.06 } }
	];
}

describe('stamps in exported files', () => {
	async function stampedExport(pages: PageRef[], sources: Source[], extra = {}) {
		return engine().exportPlan({ pages, options: { ...defaultOptions, ...extra } }, sources, [red, sig]);
	}

	it('land where the user put them on every rotation, crop offset, inherited box, UserUnit and messy content', async () => {
		const sources = await Promise.all(
			['rotated.pdf', 'cropbox.pdf', 'inherited.pdf', 'unbalanced.pdf', 'userunit.pdf'].map((n) => openCorpus(n))
		);
		const pages: PageRef[] = [];
		let k = 0;
		for (const src of sources) {
			for (let i = 0; i < src.pages.length; i++) {
				for (const r of [0, 90, 180, 270] as Rotation[]) {
					if ((i + r / 90) % 2 && src.pages.length > 2) continue; // keep the file small but cover all combos per source
					pages.push(ref(src, i, r, stampsFor(k++)));
				}
			}
		}
		const res = await stampedExport(pages, sources);
		for (const c of res.checks) expect(c.ok, c.detail).toBe(true);
		const seen = await inspect(res.bytes);
		expect(seen).toHaveLength(pages.length);

		pages.forEach((p, n) => {
			const page = seen[n];
			const W = page.viewport.width;
			const H = page.viewport.height;
			const [img, text, mark] = p.stamps as [
				Extract<Stamp, { kind: 'image' }>,
				Extract<Stamp, { kind: 'text' }>,
				Extract<Stamp, { kind: 'mark' }>
			];

			// Image: exactly one painted, upright, filling its box.
			expect(page.painted.images, `page ${n + 1}`).toHaveLength(1);
			const c = imageOnScreen(page, page.painted.images[0]);
			const L = img.box.x * W;
			const Tp = img.box.y * H;
			const R = L + img.box.w * W;
			const B = Tp + img.box.h * H;
			expectNear(c.tl, [L, Tp]);
			expectNear(c.tr, [R, Tp]);
			expectNear(c.bl, [L, B]);
			expectNear(c.br, [R, B]);

			// Text: right string, baseline where the layout rule says, upright, right size.
			const item = page.text.find((t) => t.str.startsWith('Signed'));
			expect(item?.str, `page ${n + 1}`).toBe(text.text);
			const [a, b, , , e, f] = item!.transform;
			const origin = page.viewport.toDisplay(e, f);
			const size = text.size * H;
			expectNear(origin, [text.x * W, text.y * H + STAMP_BASELINE_EM * size], 0.05);
			const along = page.viewport.toDisplay(e + a, f + b);
			expect(along[0] - origin[0]).toBeCloseTo(size, 2);
			expect(along[1] - origin[1]).toBeCloseTo(0, 2);

			// Mark: drawn last, in a frame whose origin is the box's bottom-left on screen
			// and whose axes run right and up on screen.
			const frame = page.painted.paths[page.painted.paths.length - 1];
			const o = page.viewport.toDisplay(...applyMatrix(frame, 0, 0));
			const x1 = page.viewport.toDisplay(...applyMatrix(frame, 1, 0));
			const y1 = page.viewport.toDisplay(...applyMatrix(frame, 0, 1));
			expectNear(o, [mark.box.x * W, (mark.box.y + mark.box.h) * H]);
			const unit = Math.hypot(x1[0] - o[0], x1[1] - o[1]);
			expect((x1[0] - o[0]) / unit).toBeCloseTo(1, 6);
			expect((y1[1] - o[1]) / unit).toBeCloseTo(-1, 6);
		});
	}, T);

	it('only the stamped copy of a repeated page changes', async () => {
		const multi = await openCorpus('multi.pdf');
		const pages = [ref(multi, 0), ref(multi, 0, 0, stampsFor(0)), ref(multi, 0, 90)];
		const res = await stampedExport(pages, [multi]);
		const texts = await pageTexts(res.bytes);
		expect(texts[0]).toBe('multi p1');
		expect(texts[1]).toContain('Signed 0 Grüße');
		expect(texts[2]).toBe('multi p1');
	}, T);

	it('works together with compress, password and metadata removal', async () => {
		const meta = await openCorpus('metadata.pdf');
		const res = await stampedExport([ref(meta, 0, 90, stampsFor(1))], [meta], {
			compress: true,
			password: 'pw',
			stripMetadata: true
		});
		for (const c of res.checks) expect(c.ok, c.detail).toBe(true);
		expect((await pageTexts(res.bytes, 'pw'))[0]).toContain('Signed 1 Grüße');
	}, T);

	it('embeds only a subset of the font', async () => {
		const multi = await openCorpus('multi.pdf');
		const res = await stampedExport([ref(multi, 0, 0, stampsFor(0))], [multi], { compress: true });
		expect(res.bytes.length).toBeLessThan(60_000);
	}, T);

	it('refuses stamps it cannot place reliably', async () => {
		const multi = await openCorpus('multi.pdf');
		const attempt = async (stamp: Stamp) => {
			try {
				await stampedExport([ref(multi, 0, 0, [stamp])], [multi]);
			} catch (e) {
				expect(e).toBeInstanceOf(EngineError);
				return (e as EngineErrorShape).code;
			}
			return 'ok';
		};
		expect(await attempt({ id: 'a', kind: 'mark', mark: 'dot', box: { x: 0.9, y: 0.1, w: 0.2, h: 0.1 } })).toBe('unsupported');
		expect(await attempt({ id: 'a', kind: 'mark', mark: 'dot', box: { x: 0.1, y: 0.1, w: 0, h: 0.1 } })).toBe('unsupported');
		expect(await attempt({ id: 'a', kind: 'text', text: 'ok ✓', x: 0.1, y: 0.1, size: 0.02, color: 'black' })).toBe('unsupported');
		expect(await attempt({ id: 'a', kind: 'text', text: 'x', x: 0.1, y: 0.1, size: 0, color: 'black' })).toBe('unsupported');
		expect(await attempt({ id: 'a', kind: 'image', assetId: 'nope', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } })).toBe('internal');
		expect(await attempt({ id: 'a', kind: 'text', text: '', x: 0.1, y: 0.1, size: 0.02, color: 'black' })).toBe('ok');
	}, T);
});

// ---------------------------------------------------------------------------
// Pixel check with an independent renderer (poppler), when it is installed.

const pdftoppm = (() => {
	try {
		execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

function render(bytes: Uint8Array, page: number) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
	try {
		fs.writeFileSync(path.join(dir, 'in.pdf'), bytes);
		execFileSync('pdftoppm', ['-cropbox', '-r', '72', '-f', String(page), '-l', String(page), '-singlefile', path.join(dir, 'in.pdf'), path.join(dir, 'out')]);
		const ppm = fs.readFileSync(path.join(dir, 'out.ppm'));
		// P6\n<w> <h>\n255\n<data>
		const header = ppm.subarray(0, 32).toString('latin1');
		const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(header)!;
		const w = Number(m[1]);
		const h = Number(m[2]);
		const data = ppm.subarray(m[0].length);
		return { w, h, at: (x: number, y: number) => [...data.subarray((Math.floor(y) * w + Math.floor(x)) * 3, (Math.floor(y) * w + Math.floor(x)) * 3 + 3)] };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe.skipIf(!pdftoppm)('stamps rendered by poppler', () => {
	it('a red image stamp covers exactly its box on rotated and cropped pages', async () => {
		const rot = await openCorpus('rotated.pdf');
		const crop = await openCorpus('cropbox.pdf');
		const box: StampBox = { x: 0.2, y: 0.3, w: 0.4, h: 0.25 };
		const pages: PageRef[] = [];
		for (const [src, i] of [
			[rot, 1],
			[rot, 2],
			[crop, 1],
			[crop, 2],
			[crop, 4]
		] as [Source, number][]) {
			for (const r of [0, 90, 180, 270] as Rotation[]) {
				pages.push(ref(src, i, r, [{ id: 'r', kind: 'image', assetId: 'red', box }, { id: 'd', kind: 'mark', mark: 'dot', box: { x: 0.75, y: 0.75, w: 0.1, h: 0.1 } }]));
			}
		}
		const res = await engine().exportPlan({ pages, options: defaultOptions }, [rot, crop], [red]);
		pages.forEach((_, n) => {
			const img = render(res.bytes, n + 1);
			const isRed = (x: number, y: number) => {
				const [r, g, b] = img.at(x, y);
				return r > 200 && g < 60 && b < 60;
			};
			const isBlack = (x: number, y: number) => img.at(x, y).every((v) => v < 60);
			const L = box.x * img.w;
			const Tp = box.y * img.h;
			const R = L + box.w * img.w;
			const B = Tp + box.h * img.h;
			const inset = 2;
			for (const [x, y] of [
				[L + inset, Tp + inset],
				[R - inset, Tp + inset],
				[L + inset, B - inset],
				[R - inset, B - inset],
				[(L + R) / 2, (Tp + B) / 2]
			]) {
				expect(isRed(x, y), `page ${n + 1} inside (${x},${y})`).toBe(true);
			}
			for (const [x, y] of [
				[L - inset - 1, Tp + inset],
				[R + inset + 1, B - inset],
				[L + inset, Tp - inset - 1],
				[R - inset, B + inset + 1]
			]) {
				expect(isRed(x, y), `page ${n + 1} outside (${x},${y})`).toBe(false);
			}
			expect(isBlack(0.8 * img.w, 0.8 * img.h), `page ${n + 1} dot`).toBe(true);
		});
	}, T);
});
