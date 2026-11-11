/**
 * Low-resolution page renders (MuPDF) and pixel comparison for the "wrong" checks.
 * Thresholds are constants here so the report can state them.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

/** Render resolution for comparisons, in pixels per inch. */
export const RENDER_DPI = 40;
/** Longest rendered side, in pixels (very large pages are rendered smaller). */
export const RENDER_MAX_PX = 1200;
/** A pixel counts as different when any channel differs by more than this (0..255); absorbs antialiasing noise. */
export const PIXEL_LEVEL = 48;
/**
 * Differences are measured against the page's ink (pixels darker than INK_LUMA in either
 * render, outside excluded regions), not its whole area, so a swapped "p1"/"p2" on an
 * almost white page still counts. The denominator is at least MIN_INK_SHARE of the page.
 */
export const INK_LUMA = 230;
export const MIN_INK_SHARE = 0.002;
/** A page whose differing pixels exceed this share of its ink is wrong. */
export const WRONG_FRACTION = 0.01;
/** Above this share (but at most WRONG_FRACTION) the page is written as suspect. */
export const SUSPECT_FRACTION = 0.001;
/** Fewer differing pixels than this are ignored outright (single-pixel rounding). */
export const MIN_DIFF_PIXELS = 4;
/** Rendered sizes may differ by this many pixels (rounding of fractional page sizes). */
export const SIZE_SLACK_PX = 2;
/** Target size: mean absolute channel difference above this is suspect (the change is lossy by design). */
export const LOSSY_MEAN_SUSPECT = 12;

export interface Raster {
	w: number;
	h: number;
	/** RGB, row-major. */
	px: Uint8Array;
}

/** Fractions of the displayed page, origin top-left. */
export interface Region {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

type MupdfModule = typeof import('mupdf');

/** Scale (pixels per point) for a page of the given displayed size. */
export function renderScale(width: number, height: number): number {
	return Math.min(RENDER_DPI / 72, RENDER_MAX_PX / Math.max(width, height, 1));
}

export function openDoc(m: MupdfModule, bytes: Uint8Array, password?: string) {
	const doc = m.Document.openDocument(bytes.slice(), 'application/pdf');
	if (password !== undefined && doc.needsPassword()) {
		if (!doc.authenticatePassword(password)) {
			doc.destroy();
			throw new Error('MuPDF: password not accepted');
		}
	}
	return doc;
}

export function renderPage(m: MupdfModule, doc: InstanceType<MupdfModule['Document']>, i: number, scale: number): Raster {
	const page = doc.loadPage(i);
	try {
		const pix = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, true);
		try {
			// Components per pixel, alpha included (MuPDF's fz_pixmap_components).
			const n = pix.getNumberOfComponents();
			const w = pix.getWidth();
			const h = pix.getHeight();
			const src = pix.getPixels();
			const stride = pix.getStride();
			const px = new Uint8Array(w * h * 3);
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					const s = y * stride + x * n;
					const d = (y * w + x) * 3;
					px[d] = src[s];
					px[d + 1] = src[s + 1];
					px[d + 2] = src[s + 2];
				}
			}
			return { w, h, px };
		} finally {
			pix.destroy();
		}
	} finally {
		page.destroy();
	}
}

export interface Diff {
	sameSize: boolean;
	/** Differing pixels / ink pixels (outside the excluded regions); 0 when fewer than MIN_DIFF_PIXELS differ. */
	fraction: number;
	differing: number;
	ink: number;
	/** Mean absolute channel difference over compared pixels. */
	mean: number;
	compared: number;
	/** Differing pixels inside each `inside` region / pixels of that region. */
	insideFractions: number[];
	/** Mean luminance inside each `inside` region of the second raster. */
	insideLuma: number[];
	diff: Raster;
}

const inRegion = (r: Region, fx: number, fy: number) => fx >= r.x0 && fx <= r.x1 && fy >= r.y0 && fy <= r.y1;

/**
 * Compares two renders of the same page. Pixels in `exclude` regions are skipped;
 * `inside` regions are measured separately (e.g. "did the stamp show up").
 */
export function compare(a: Raster, b: Raster, exclude: Region[] = [], inside: Region[] = []): Diff {
	const sameSize = Math.abs(a.w - b.w) <= SIZE_SLACK_PX && Math.abs(a.h - b.h) <= SIZE_SLACK_PX;
	const w = Math.min(a.w, b.w);
	const h = Math.min(a.h, b.h);
	const diff: Raster = { w, h, px: new Uint8Array(w * h * 3) };
	let compared = 0;
	let differing = 0;
	let ink = 0;
	let sum = 0;
	const inCount = inside.map(() => 0);
	const inDiff = inside.map(() => 0);
	const inLuma = inside.map(() => 0);
	for (let y = 0; y < h; y++) {
		const fy = (y + 0.5) / h;
		for (let x = 0; x < w; x++) {
			const fx = (x + 0.5) / w;
			const ia = (y * a.w + x) * 3;
			const ib = (y * b.w + x) * 3;
			const dr = Math.abs(a.px[ia] - b.px[ib]);
			const dg = Math.abs(a.px[ia + 1] - b.px[ib + 1]);
			const db = Math.abs(a.px[ia + 2] - b.px[ib + 2]);
			const max = Math.max(dr, dg, db);
			const isDiff = max > PIXEL_LEVEL;
			const o = (y * w + x) * 3;
			// Diff image: unchanged pixels faded grey, changed pixels red.
			const grey = 200 + Math.round((b.px[ib] + b.px[ib + 1] + b.px[ib + 2]) / 3 / 255 * 55);
			diff.px[o] = isDiff ? 255 : grey;
			diff.px[o + 1] = isDiff ? 0 : grey;
			diff.px[o + 2] = isDiff ? 0 : grey;
			inside.forEach((r, k) => {
				if (!inRegion(r, fx, fy)) return;
				inCount[k]++;
				if (isDiff) inDiff[k]++;
				inLuma[k] += 0.299 * b.px[ib] + 0.587 * b.px[ib + 1] + 0.114 * b.px[ib + 2];
			});
			if (exclude.some((r) => inRegion(r, fx, fy))) {
				diff.px[o] = diff.px[o + 1] = diff.px[o + 2] = isDiff ? 160 : 230;
				continue;
			}
			compared++;
			sum += dr + dg + db;
			if (isDiff) differing++;
			const la = 0.299 * a.px[ia] + 0.587 * a.px[ia + 1] + 0.114 * a.px[ia + 2];
			const lb = 0.299 * b.px[ib] + 0.587 * b.px[ib + 1] + 0.114 * b.px[ib + 2];
			if (la < INK_LUMA || lb < INK_LUMA) ink++;
		}
	}
	return {
		sameSize,
		fraction: differing < MIN_DIFF_PIXELS ? 0 : differing / Math.max(ink, MIN_INK_SHARE * compared, 1),
		differing,
		ink,
		mean: compared ? sum / compared / 3 : 0,
		compared,
		insideFractions: inside.map((_, k) => (inCount[k] ? inDiff[k] / inCount[k] : 0)),
		insideLuma: inside.map((_, k) => (inCount[k] ? inLuma[k] / inCount[k] : 255)),
		diff
	};
}

/** Minimal RGB PNG encoder (no dependency). */
export function writePng(file: string, r: Raster) {
	const raw = Buffer.alloc((r.w * 3 + 1) * r.h);
	for (let y = 0; y < r.h; y++) {
		raw[y * (r.w * 3 + 1)] = 0;
		Buffer.from(r.px.buffer, r.px.byteOffset + y * r.w * 3, r.w * 3).copy(raw, y * (r.w * 3 + 1) + 1);
	}
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(zlib.crc32(td) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(r.w, 0);
	ihdr.writeUInt32BE(r.h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	fs.writeFileSync(
		file,
		Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
	);
}
