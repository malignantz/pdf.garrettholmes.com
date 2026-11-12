/**
 * A page's own words (the highlighter's word extraction, src/lib/engine/page-text.ts)
 * with what OCR scoring needs: highlight box and ink box in points, font size, whether
 * the glyphs are drawn visibly, and the page's pictures (where they are, how many pixels).
 */
import type * as MU from 'mupdf';
import { layoutWordsDetailed, readRawLines } from '../../../src/lib/engine/page-text';
import type { Box, TruthWord } from './score';

export interface PageImage {
	box: Box;
	/** Image pixels. */
	pw: number;
	ph: number;
	/** Pixels per inch along each side of its box. */
	ppi: number;
	/** 1-bit image or stencil mask. */
	bits: number;
	/** Drawing order. */
	seq: number;
}

export interface PageWord extends TruthWord {
	/** Glyphs drawn visibly (not render mode 3, not covered by a later picture). */
	vis: boolean;
	/** Glyphs in invisible text (render mode 3). */
	invisible: boolean;
	/** Line runs left to right, level within ~3°. */
	level: boolean;
}

export interface PageInfo {
	W: number;
	H: number;
	rotate: number;
	words: PageWord[];
	images: PageImage[];
	/** Share of the page covered by the largest picture. */
	imageCover: number;
	/** Vector paths drawn (fills + strokes). */
	paths: number;
	skipped: number;
}

const destroy = (o: unknown) => {
	try {
		(o as { destroy?: () => void })?.destroy?.();
	} catch {
		// gone
	}
};

type Mat = [number, number, number, number, number, number];
const ap = (m: Mat, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

export function pageInfo(m: typeof MU, doc: MU.Document, index: number): PageInfo {
	const page = doc.loadPage(index) as MU.PDFPage;
	try {
		const [bx0, by0, bx1, by1] = page.getBounds();
		const W = bx1 - bx0;
		const H = by1 - by0;
		let rotate = 0;
		try {
			rotate = Number(page.getObject().getInheritable('Rotate')?.asNumber?.() ?? 0) || 0;
		} catch {
			rotate = 0;
		}
		const raw = readRawLines(page);
		const { words, chars, skipped } = layoutWordsDetailed(raw, W, H);
		// Glyph visibility and pictures, in drawing order.
		const glyphs = new Map<string, { inv: boolean; seq: number }>();
		const key = (x: number, y: number) => `${Math.round(x * 20)},${Math.round(y * 20)}`;
		const images: PageImage[] = [];
		let seq = 0;
		let paths = 0;
		const dl = page.toDisplayList(false);
		const onText = (text: MU.Text, ctm: Mat, inv: boolean) => {
			const s = seq++;
			text.walk({
				showGlyph(_f, trm) {
					const [x, y] = ap(ctm, trm[4], trm[5]);
					glyphs.set(key(x - bx0, y - by0), { inv, seq: s });
				}
			});
		};
		const onImage = (img: MU.Image, ctm: Mat, mask: boolean) => {
			const pts = [ap(ctm, 0, 0), ap(ctm, 1, 0), ap(ctm, 0, 1), ap(ctm, 1, 1)];
			const xs = pts.map((p) => p[0] - bx0);
			const ys = pts.map((p) => p[1] - by0);
			const box: Box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
			const pw = img.getWidth();
			const ph = img.getHeight();
			const sideA = Math.hypot(ctm[0], ctm[1]) / 72;
			const sideB = Math.hypot(ctm[2], ctm[3]) / 72;
			// Pixels per inch: the image's width runs along the unit square's x side.
			const ppi = Math.min(pw / Math.max(1e-6, sideA), ph / Math.max(1e-6, sideB));
			let bits = 8;
			try {
				bits = mask ? 1 : img.getBitsPerComponent?.() ?? 8;
			} catch {
				bits = 8;
			}
			images.push({ box, pw, ph, ppi: Math.round(ppi), bits, seq: seq++ });
		};
		const dev = new m.Device({
			fillText: (t, ctm) => onText(t, ctm as Mat, false),
			strokeText: (t, _s, ctm) => onText(t, ctm as Mat, false),
			ignoreText: (t, ctm) => onText(t, ctm as Mat, true),
			fillImage: (img, ctm) => onImage(img, ctm as Mat, false),
			fillImageMask: (img, ctm) => onImage(img, ctm as Mat, true),
			fillPath: () => void paths++,
			strokePath: () => void paths++,
			fillShade(shade) {
				const ctor = (shade as unknown as { constructor?: { _finalizer?: FinalizationRegistry<unknown> } }).constructor;
				ctor?._finalizer?.unregister(shade as unknown as object);
			}
		});
		try {
			dl.run(dev, m.Matrix.identity);
		} finally {
			dev.close();
			destroy(dev);
			destroy(dl);
		}
		const covered = (x: number, y: number, s: number) => images.some((im) => im.seq > s && x >= im.box[0] && x <= im.box[2] && y >= im.box[1] && y <= im.box[3]);
		const out: PageWord[] = words.map((w, wi) => {
			const cs = chars[wi] ?? [];
			let ix0 = Infinity;
			let iy0 = Infinity;
			let ix1 = -Infinity;
			let iy1 = -Infinity;
			const sizes: number[] = [];
			let inv = 0;
			let hidden = 0;
			let li = 0;
			for (const [l, c] of cs) {
				li = l;
				const ch = raw[l].chars[c];
				const q = ch.ink ?? ch.quad;
				for (let k = 0; k < 8; k += 2) {
					ix0 = Math.min(ix0, q[k]);
					ix1 = Math.max(ix1, q[k]);
					iy0 = Math.min(iy0, q[k + 1]);
					iy1 = Math.max(iy1, q[k + 1]);
				}
				sizes.push(ch.size);
				const g = glyphs.get(key(ch.origin[0], ch.origin[1]));
				if (g?.inv) inv++;
				else if (g && covered(ch.origin[0], ch.origin[1], g.seq)) hidden++;
			}
			sizes.sort((a, b) => a - b);
			const dir = raw[li]?.dir ?? [1, 0];
			const n = Math.max(1, cs.length);
			return {
				t: w.text,
				h: [w.box.x * W, w.box.y * H, (w.box.x + w.box.w) * W, (w.box.y + w.box.h) * H],
				ink: Number.isFinite(ix0) ? [ix0, iy0, ix1, iy1] : [w.box.x * W, w.box.y * H, (w.box.x + w.box.w) * W, (w.box.y + w.box.h) * H],
				size: sizes[Math.floor(sizes.length / 2)] ?? 0,
				line: li,
				invisible: inv / n > 0.5,
				vis: (inv + hidden) / n < 0.5,
				level: dir[0] > 0.998
			};
		});
		const cover = images.reduce((mx, im) => Math.max(mx, (Math.max(0, Math.min(W, im.box[2]) - Math.max(0, im.box[0])) * Math.max(0, Math.min(H, im.box[3]) - Math.max(0, im.box[1]))) / (W * H)), 0);
		return { W, H, rotate, words: out, images, imageCover: cover, paths, skipped };
	} finally {
		destroy(page);
	}
}

/** Render the page as displayed, grey, at `dpi`. */
export function renderGray(m: typeof MU, doc: MU.Document, index: number, dpi: number): { w: number; h: number; px: Uint8Array } {
	const page = doc.loadPage(index);
	try {
		const pix = page.toPixmap(m.Matrix.scale(dpi / 72, dpi / 72), m.ColorSpace.DeviceGray, false, true);
		try {
			const w = pix.getWidth();
			const h = pix.getHeight();
			const stride = pix.getStride();
			const src = pix.getPixels();
			const px = new Uint8Array(w * h);
			for (let y = 0; y < h; y++) px.set(src.subarray(y * stride, y * stride + w), y * w);
			return { w, h, px };
		} finally {
			destroy(pix);
		}
	} finally {
		destroy(page);
	}
}

/** Encode an 8-bit grey image as PNG or JPEG with MuPDF. */
export function encode(m: typeof MU, img: { w: number; h: number; px: Uint8Array }, kind: 'png' | 'jpeg', quality = 75): Uint8Array {
	const pix = new m.Pixmap(m.ColorSpace.DeviceGray, [0, 0, img.w, img.h], false);
	try {
		const dst = pix.getPixels();
		const stride = pix.getStride();
		for (let y = 0; y < img.h; y++) dst.set(img.px.subarray(y * img.w, (y + 1) * img.w), y * stride);
		return (kind === 'png' ? pix.asPNG() : pix.asJPEG(quality)).slice();
	} finally {
		destroy(pix);
	}
}
