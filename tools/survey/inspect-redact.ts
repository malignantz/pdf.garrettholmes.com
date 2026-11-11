/**
 * Looks closely at one redact-scenario result: re-runs the scenario's export (same line,
 * same box), then compares input and output page 1 in detail for a human:
 *  - text outside the box (MuPDF characters, poppler words): lost, added, moved;
 *  - text still under the box (MuPDF, poppler, PDF.js);
 *  - pixel differences outside the box, grouped into areas, each with the text there;
 *  - annotations before and after.
 * Writes before/after/diff PNGs at 72 dpi and a JSON summary into --out/<sha16>/.
 *
 *   node --experimental-transform-types --no-warnings --import ./tools/survey/register.mjs \
 *     tools/survey/inspect-redact.ts --out DIR FILE.pdf [FILE.pdf ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as mupdf from 'mupdf';
import type { PageRef, StampBox } from '../../src/lib/core/types';
import { parseArgs, outDir, tool } from './lib/common';
import { engine, loadPdfjs } from './lib/engine';
import { compare, openDoc, renderPage, writePng, type Raster, type Region } from './lib/raster';

type Rect = [number, number, number, number];
interface Ch {
	c: string;
	r: Rect;
}

const args = parseArgs(process.argv.slice(2));
const out = outDir(args);
const DPI = args.num('dpi', 72);

function firstTextLine(bytes: Uint8Array): { text: string; box: StampBox } | null {
	const doc = openDoc(mupdf, bytes);
	try {
		const page = doc.loadPage(0);
		const b = page.getBounds();
		const W = b[2] - b[0];
		const H = b[3] - b[1];
		const st = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
			blocks: { type: string; lines?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] }[];
		};
		for (const block of st.blocks ?? []) {
			for (const line of block.lines ?? []) {
				const alnum = line.text.replace(/[^\p{L}\p{N}]/gu, '');
				const bb = line.bbox;
				if (alnum.length < 3 || bb.w < 2 || bb.h < 2) continue;
				const x0 = Math.max(0, (bb.x - b[0] - 1) / W);
				const y0 = Math.max(0, (bb.y - b[1] - 1) / H);
				const x1 = Math.min(1, (bb.x - b[0] + bb.w + 1) / W);
				const y1 = Math.min(1, (bb.y - b[1] + bb.h + 1) / H);
				if (x1 - x0 <= 0.001 || y1 - y0 <= 0.001) continue;
				return { text: line.text, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
			}
		}
		return null;
	} finally {
		doc.destroy();
	}
}

/** MuPDF characters of page 1 with their quads' bounding boxes, page space (top-left origin). */
function mupdfChars(bytes: Uint8Array): { chars: Ch[]; W: number; H: number; annots: string[] } {
	const doc = openDoc(mupdf, bytes);
	try {
		const page = doc.loadPage(0) as mupdf.PDFPage;
		const b = page.getBounds();
		const chars: Ch[] = [];
		const st = page.toStructuredText('preserve-whitespace,accurate-bboxes');
		st.walk({
			onChar(c, _o, _f, _s, q) {
				const xs = [q[0], q[2], q[4], q[6]];
				const ys = [q[1], q[3], q[5], q[7]];
				chars.push({ c, r: [Math.min(...xs) - b[0], Math.min(...ys) - b[1], Math.max(...xs) - b[0], Math.max(...ys) - b[1]] });
			}
		});
		const annots: string[] = [];
		const a = page.getObject().get('Annots');
		if (a.isArray()) for (let i = 0; i < a.length; i++) annots.push(String(a.get(i).resolve().get('Subtype')));
		return { chars, W: b[2] - b[0], H: b[3] - b[1], annots };
	} finally {
		doc.destroy();
	}
}

async function popplerWords(file: string): Promise<{ words: Ch[]; W: number; H: number } | null> {
	const [txt, info] = await Promise.all([
		tool('pdftotext', ['-cropbox', '-bbox', '-f', '1', '-l', '1', file, '-'], 60_000),
		tool('pdfinfo', ['-f', '1', '-l', '1', file], 60_000)
	]);
	if (txt.code !== 0 || info.code !== 0) return null;
	const rot = Number(/^Page\s+1 rot:\s+(\d+)/m.exec(info.stdout)?.[1] ?? 0) % 180 !== 0;
	const pm = /<page width="([\d.]+)" height="([\d.]+)"/.exec(txt.stdout);
	if (!pm) return null;
	const [pw0, ph0] = [Number(pm[1]), Number(pm[2])];
	const [W, H] = rot ? [ph0, pw0] : [pw0, ph0];
	const words: Ch[] = [];
	for (const m of txt.stdout.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g)) {
		words.push({ c: m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'), r: [+m[1], +m[2], +m[3], +m[4]] });
	}
	return { words, W, H };
}

async function pdfjsItemsIn(bytes: Uint8Array, box: Rect): Promise<string[]> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), useWasm: false, useWorkerFetch: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
	const doc = await task.promise;
	try {
		const page = await doc.getPage(1);
		const vp = page.getViewport({ scale: 1 });
		const tc = await page.getTextContent();
		const hits: string[] = [];
		for (const it of tc.items as { str: string; transform: number[]; width: number; height: number }[]) {
			if (!it.str?.trim()) continue;
			const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
			const [x2, y2] = vp.convertToViewportPoint(it.transform[4] + it.width, it.transform[5] + it.height * 0.6);
			const r: Rect = [Math.min(x, x2), Math.min(y, y2), Math.max(x, x2), Math.max(y, y2)];
			if (touch(r, box)) hits.push(it.str);
		}
		return hits;
	} finally {
		await task.destroy();
	}
}

const touch = (a: Rect, b: Rect, eps = 0) => a[0] < b[2] - eps && a[2] > b[0] + eps && a[1] < b[3] - eps && a[3] > b[1] + eps;

/** Characters (or words) outside `box` that have no same-text partner within `tol` pt in `after`. */
function unmatched(before: Ch[], after: Ch[], box: Rect, tol: number): Ch[] {
	const pool = after.filter((c) => c.c.trim());
	const out: Ch[] = [];
	for (const ch of before) {
		if (!ch.c.trim() || touch(ch.r, box, -0.5)) continue;
		const i = pool.findIndex((o) => o.c === ch.c && Math.abs(o.r[0] - ch.r[0]) <= tol && Math.abs(o.r[1] - ch.r[1]) <= tol);
		if (i < 0) out.push(ch);
		else pool.splice(i, 1);
	}
	return out;
}

/** Joins nearby characters into readable runs for the summary. */
function runs(chs: Ch[]): string[] {
	const res: { s: string; r: Rect }[] = [];
	for (const c of chs) {
		const last = res.at(-1);
		if (last && Math.abs(c.r[1] - last.r[1]) < 3 && c.r[0] - last.r[2] < 15) {
			last.s += c.c;
			last.r = [Math.min(last.r[0], c.r[0]), Math.min(last.r[1], c.r[1]), Math.max(last.r[2], c.r[2]), Math.max(last.r[3], c.r[3])];
		} else res.push({ s: c.c, r: [...c.r] as Rect });
	}
	return res.map((x) => `"${x.s}" @${x.r.map((v) => v.toFixed(0)).join(',')}`);
}

/** Groups differing pixels (outside the excluded region) into areas on a coarse grid. */
function diffAreas(a: Raster, b: Raster, exclude: Region, scale: number): { px: number; rect: Rect }[] {
	const w = Math.min(a.w, b.w);
	const h = Math.min(a.h, b.h);
	const cell = 6;
	const gw = Math.ceil(w / cell);
	const gh = Math.ceil(h / cell);
	const grid = new Int32Array(gw * gh);
	for (let y = 0; y < h; y++) {
		const fy = (y + 0.5) / h;
		for (let x = 0; x < w; x++) {
			const fx = (x + 0.5) / w;
			if (fx >= exclude.x0 && fx <= exclude.x1 && fy >= exclude.y0 && fy <= exclude.y1) continue;
			const ia = (y * a.w + x) * 3;
			const ib = (y * b.w + x) * 3;
			const d = Math.max(Math.abs(a.px[ia] - b.px[ib]), Math.abs(a.px[ia + 1] - b.px[ib + 1]), Math.abs(a.px[ia + 2] - b.px[ib + 2]));
			if (d > 48) grid[Math.floor(y / cell) * gw + Math.floor(x / cell)]++;
		}
	}
	const seen = new Uint8Array(gw * gh);
	const areas: { px: number; rect: Rect }[] = [];
	for (let i = 0; i < grid.length; i++) {
		if (!grid[i] || seen[i]) continue;
		let px = 0;
		let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
		const stack = [i];
		seen[i] = 1;
		while (stack.length) {
			const k = stack.pop()!;
			px += grid[k];
			const gx = k % gw;
			const gy = Math.floor(k / gw);
			x0 = Math.min(x0, gx);
			y0 = Math.min(y0, gy);
			x1 = Math.max(x1, gx + 1);
			y1 = Math.max(y1, gy + 1);
			for (let dy = -2; dy <= 2; dy++)
				for (let dx = -2; dx <= 2; dx++) {
					const nx = gx + dx;
					const ny = gy + dy;
					if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
					const n = ny * gw + nx;
					if (grid[n] && !seen[n]) {
						seen[n] = 1;
						stack.push(n);
					}
				}
		}
		areas.push({ px, rect: [(x0 * cell) / scale, (y0 * cell) / scale, (x1 * cell) / scale, (y1 * cell) / scale] });
	}
	return areas.sort((p, q) => q.px - p.px);
}

const r0 = (r: Rect) => r.map((v) => v.toFixed(0)).join(',');

async function inspect(file: string) {
	const bytes = new Uint8Array(fs.readFileSync(file));
	const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
	const dir = path.join(out, sha);
	fs.mkdirSync(dir, { recursive: true });
	const eng = engine();
	const src = await eng.openPdf(bytes, path.basename(file));
	let line = null;
	for (const b of [src.bytes, bytes]) {
		try {
			line = firstTextLine(b);
			break;
		} catch {
			// next
		}
	}
	if (!line) return { file, error: 'no line' };
	const pages: PageRef[] = src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0, stamps: [] }));
	pages[0].stamps = [{ id: 'r', kind: 'redact', box: line.box }];
	const res = await eng.exportPlan({ pages, options: { filename: 'o.pdf', compress: false, stripMetadata: false } }, [src], []);
	fs.writeFileSync(path.join(dir, 'output.pdf'), res.bytes);
	fs.writeFileSync(path.join(dir, 'opened.pdf'), src.bytes);

	const bm = mupdfChars(src.bytes);
	const am = mupdfChars(res.bytes);
	const box: Rect = [line.box.x * bm.W, line.box.y * bm.H, (line.box.x + line.box.w) * bm.W, (line.box.y + line.box.h) * bm.H];
	const lostM = unmatched(bm.chars, am.chars, box, 0.6);
	const addedM = unmatched(am.chars, bm.chars, box, 0.6);
	const underM = am.chars.filter((c) => c.c.trim() && touch(c.r, box, 0.01));

	const pb = await popplerWords(path.join(dir, 'opened.pdf'));
	const pa = await popplerWords(path.join(dir, 'output.pdf'));
	let lostP: Ch[] = [];
	let underP: string[] = [];
	if (pb && pa) {
		const pbox: Rect = [line.box.x * pb.W, line.box.y * pb.H, (line.box.x + line.box.w) * pb.W, (line.box.y + line.box.h) * pb.H];
		lostP = unmatched(pb.words, pa.words, pbox, 1);
		underP = pa.words
			.filter((w) => {
				const cx = (w.r[0] + w.r[2]) / 2;
				const cy = (w.r[1] + w.r[3]) / 2;
				return cx > pbox[0] && cx < pbox[2] && cy > pbox[1] && cy < pbox[3];
			})
			.map((w) => w.c);
	}
	const underJ = await pdfjsItemsIn(res.bytes, box);

	const scale = Math.min(DPI / 72, args.num("max-px", 1600) / Math.max(bm.W, bm.H));
	const rend = (b: Uint8Array) => {
		const d = openDoc(mupdf, b);
		try {
			return renderPage(mupdf, d, 0, scale);
		} finally {
			d.destroy();
		}
	};
	let before: Raster;
	try {
		before = rend(bytes);
	} catch {
		before = rend(src.bytes);
	}
	const norm = rend(src.bytes);
	const after = rend(res.bytes);
	const ex: Region = { x0: line.box.x - 0.01, y0: line.box.y - 0.01, x1: line.box.x + line.box.w + 0.01, y1: line.box.y + line.box.h + 0.01 };
	const d = compare(before, after, [ex]);
	const dn = compare(norm, after, [ex]);
	const dbn = compare(before, norm, []);
	writePng(path.join(dir, 'before.png'), before);
	writePng(path.join(dir, 'after.png'), after);
	writePng(path.join(dir, 'diff.png'), d.diff);
	const areas = diffAreas(norm, after, ex, scale).slice(0, 8).map((a) => {
		const inA = (c: Ch) => touch(c.r, a.rect);
		return {
			px: a.px,
			rect: r0(a.rect),
			textBefore: runs(bm.chars.filter(inA)).slice(0, 3),
			textAfter: runs(am.chars.filter(inA)).slice(0, 3)
		};
	});
	// Side by side (before | after), cropped to the box and the largest areas of difference.
	{
		let u: Rect = [...box] as Rect;
		for (const a of diffAreas(norm, after, ex, scale).slice(0, 3)) {
			const [x0, y0, x1, y1] = a.rect;
			u = [Math.min(u[0], x0), Math.min(u[1], y0), Math.max(u[2], x1), Math.max(u[3], y1)];
		}
		const padPt = 20;
		const cx0 = Math.max(0, Math.floor((u[0] - padPt) * scale));
		const cy0 = Math.max(0, Math.floor((u[1] - padPt) * scale));
		const cx1 = Math.min(after.w, Math.ceil((u[2] + padPt) * scale));
		const cy1 = Math.min(after.h, Math.ceil((u[3] + padPt) * scale));
		const cw = Math.max(1, cx1 - cx0);
		const ch = Math.max(1, cy1 - cy0);
		const pair: Raster = { w: cw * 2 + 4, h: ch, px: new Uint8Array((cw * 2 + 4) * ch * 3).fill(128) };
		for (let y = 0; y < ch; y++)
			for (let x = 0; x < cw; x++)
				for (const [k, r] of [norm, after].entries()) {
					const sx = cx0 + x;
					const sy = cy0 + y;
					if (sx >= r.w || sy >= r.h) continue;
					const s0 = (sy * r.w + sx) * 3;
					const d0 = (y * pair.w + x + k * (cw + 4)) * 3;
					pair.px[d0] = r.px[s0];
					pair.px[d0 + 1] = r.px[s0 + 1];
					pair.px[d0 + 2] = r.px[s0 + 2];
				}
		writePng(path.join(dir, 'pair.png'), pair);
	}
	const summary = {
		file,
		line: line.text.slice(0, 60),
		box: r0(box),
		page: `${bm.W.toFixed(0)}x${bm.H.toFixed(0)}`,
		warnings: res.warnings,
		hasForm: src.hasForm,
		fracOrig: +(d.fraction * 100).toFixed(2),
		fracOpened: +(dn.fraction * 100).toFixed(2),
		origVsOpened: +(dbn.fraction * 100).toFixed(2),
		mupdfUnder: underM.map((c) => c.c).join(''),
		popplerUnder: underP,
		pdfjsUnder: underJ,
		mupdfLost: runs(lostM).slice(0, 10),
		mupdfLostCount: lostM.length,
		mupdfAdded: runs(addedM).slice(0, 6),
		popplerLost: lostP.slice(0, 10).map((w) => `"${w.c}" @${r0(w.r)}`),
		popplerLostCount: lostP.length,
		annotsBefore: bm.annots.join(' '),
		annotsAfter: am.annots.join(' '),
		areas
	};
	fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
	return summary;
}

for (const f of args._) {
	try {
		console.log(JSON.stringify(await inspect(f), null, 1));
	} catch (e) {
		console.log(JSON.stringify({ file: f, error: String((e as Error).stack ?? e).slice(0, 600) }));
	}
}
process.exit(0);
