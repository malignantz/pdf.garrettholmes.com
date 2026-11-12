/**
 * Synthetic scan degradations on 8-bit grey images, deterministic for a seed.
 * Every function returns a new image; geometry changes report the affine map
 * from input pixels to output pixels so truth boxes can follow.
 */

export interface Gray {
	w: number;
	h: number;
	px: Uint8Array;
}

/** Affine map [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function apply(m: Mat, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** m2 after m1. */
export function concat(m1: Mat, m2: Mat): Mat {
	return [
		m1[0] * m2[0] + m1[1] * m2[2],
		m1[0] * m2[1] + m1[1] * m2[3],
		m1[2] * m2[0] + m1[3] * m2[2],
		m1[2] * m2[1] + m1[3] * m2[3],
		m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
		m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
	];
}

/** Axis-aligned box of a box mapped through m. */
export function mapBox(m: Mat, b: [number, number, number, number]): [number, number, number, number] {
	const pts = [apply(m, b[0], b[1]), apply(m, b[2], b[1]), apply(m, b[0], b[3]), apply(m, b[2], b[3])];
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

export function gauss(r: () => number): number {
	const u = Math.max(1e-12, r());
	const v = r();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Rotate by `deg` about the centre, same canvas size, white fill (bilinear). */
export function rotate(img: Gray, deg: number): { img: Gray; m: Mat } {
	const t = (deg * Math.PI) / 180;
	const c = Math.cos(t);
	const s = Math.sin(t);
	const cx = img.w / 2;
	const cy = img.h / 2;
	// Forward map: p' = R (p - c) + c.
	const m: Mat = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
	const out = new Uint8Array(img.w * img.h).fill(255);
	const { w, h, px } = img;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			// Inverse: p = R^T (p' - c) + c.
			const dx = x + 0.5 - cx;
			const dy = y + 0.5 - cy;
			const sx = c * dx + s * dy + cx - 0.5;
			const sy = -s * dx + c * dy + cy - 0.5;
			const x0 = Math.floor(sx);
			const y0 = Math.floor(sy);
			if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
			const fx = sx - x0;
			const fy = sy - y0;
			const i = y0 * w + x0;
			const v = px[i] * (1 - fx) * (1 - fy) + px[i + 1] * fx * (1 - fy) + px[i + w] * (1 - fx) * fy + px[i + w + 1] * fx * fy;
			out[y * w + x] = v;
		}
	}
	return { img: { w, h, px: out }, m };
}

/** Separable Gaussian blur. */
export function blur(img: Gray, sigma: number): Gray {
	if (sigma < 0.2) return { ...img, px: img.px.slice() };
	const r = Math.ceil(sigma * 3);
	const k: number[] = [];
	let sum = 0;
	for (let i = -r; i <= r; i++) {
		const v = Math.exp(-(i * i) / (2 * sigma * sigma));
		k.push(v);
		sum += v;
	}
	for (let i = 0; i < k.length; i++) k[i] /= sum;
	const { w, h } = img;
	const tmp = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		const row = y * w;
		for (let x = 0; x < w; x++) {
			let a = 0;
			for (let j = -r; j <= r; j++) {
				const xx = x + j < 0 ? 0 : x + j >= w ? w - 1 : x + j;
				a += img.px[row + xx] * k[j + r];
			}
			tmp[row + x] = a;
		}
	}
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let a = 0;
			for (let j = -r; j <= r; j++) {
				const yy = y + j < 0 ? 0 : y + j >= h ? h - 1 : y + j;
				a += tmp[yy * w + x] * k[j + r];
			}
			out[y * w + x] = clamp(Math.round(a));
		}
	}
	return { w, h, px: out };
}

/** Map white to `paper` and black to `ink`, then add Gaussian noise of `sd` levels. */
export function levelsNoise(img: Gray, paper: number, ink: number, sd: number, r: () => number): Gray {
	const out = new Uint8Array(img.px.length);
	const k = (paper - ink) / 255;
	for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round(ink + img.px[i] * k + (sd ? gauss(r) * sd : 0)));
	return { w: img.w, h: img.h, px: out };
}

/** Threshold to black and white, with salt-and-pepper speckle at `speckle` per pixel. */
export function bitonal(img: Gray, threshold: number, speckle: number, r: () => number): Gray {
	const out = new Uint8Array(img.px.length);
	for (let i = 0; i < out.length; i++) out[i] = img.px[i] < threshold ? 0 : 255;
	const n = Math.round(out.length * speckle);
	for (let j = 0; j < n; j++) {
		const i = Math.floor(r() * out.length);
		out[i] = r() < 0.7 ? 0 : 255;
	}
	return { w: img.w, h: img.h, px: out };
}

/** Uneven lighting: a darkening vignette off centre plus a linear falloff (phone photo). */
export function lighting(img: Gray, r: () => number): Gray {
	const { w, h } = img;
	const cx = w * (0.3 + 0.4 * r());
	const cy = h * (0.3 + 0.4 * r());
	const a = 0.15 + 0.2 * r();
	const b = 0.1 + 0.15 * r();
	const ang = r() * 2 * Math.PI;
	const ux = Math.cos(ang);
	const uy = Math.sin(ang);
	const R2 = (w * w + h * h) / 4;
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / R2;
			const lin = ((x / w - 0.5) * ux + (y / h - 0.5) * uy + 0.7) / 1.4;
			const f = Math.max(0.35, 1 - a * d2 - b * lin);
			out[y * w + x] = clamp(Math.round(img.px[y * w + x] * f));
		}
	return { w, h, px: out };
}

/** Fax standard mode: half the vertical resolution (rows averaged in pairs), then rows doubled back. */
export function faxRows(img: Gray): Gray {
	const { w, h } = img;
	const out = new Uint8Array(w * h);
	for (let y = 0; y + 1 < h; y += 2)
		for (let x = 0; x < w; x++) {
			const v = (img.px[y * w + x] + img.px[(y + 1) * w + x]) >> 1;
			out[y * w + x] = v;
			out[(y + 1) * w + x] = v;
		}
	if (h % 2) out.set(img.px.subarray((h - 1) * w), (h - 1) * w);
	return { w, h, px: out };
}

/** Bilinear resize by `f` (both axes). */
export function resize(img: Gray, f: number): { img: Gray; m: Mat } {
	const w = Math.max(1, Math.round(img.w * f));
	const h = Math.max(1, Math.round(img.h * f));
	const fx = img.w / w;
	const fy = img.h / h;
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		const sy = Math.min(img.h - 1.001, Math.max(0, (y + 0.5) * fy - 0.5));
		const y0 = Math.floor(sy);
		const ty = sy - y0;
		for (let x = 0; x < w; x++) {
			const sx = Math.min(img.w - 1.001, Math.max(0, (x + 0.5) * fx - 0.5));
			const x0 = Math.floor(sx);
			const tx = sx - x0;
			const i = y0 * img.w + x0;
			const v = img.px[i] * (1 - tx) * (1 - ty) + img.px[i + 1] * tx * (1 - ty) + img.px[i + img.w] * (1 - tx) * ty + img.px[i + img.w + 1] * tx * ty;
			out[y * w + x] = Math.round(v);
		}
	}
	return { img: { w, h, px: out }, m: [w / img.w, 0, 0, h / img.h, 0, 0] };
}
