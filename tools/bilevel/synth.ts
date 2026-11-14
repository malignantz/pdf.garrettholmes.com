/**
 * Synthetic scans for tools/bilevel/: a born-digital page (survey data, read-only) made into
 * what a scanner would give, with the clean render kept as the truth (the oracle).
 */
import type { Mupdf } from '../../src/lib/engine/mupdf';

export interface SynthTraits {
	ppi: number;
	grey: boolean;
	paper: [number, number, number];
	ink: number;
	blur: number;
	noise: number;
	quality: number;
	/** Light falls to this at the far corner (phone-like when under 1). */
	light: number;
}

function prng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

/** Separable Gaussian blur of interleaved samples (n channels), in place. */
function blur(px: Float32Array, w: number, h: number, n: number, sigma: number) {
	if (sigma <= 0.05) return;
	const r = Math.ceil(sigma * 2.5);
	const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
	const sum = k.reduce((a, b) => a + b, 0);
	for (let i = 0; i < k.length; i++) k[i] /= sum;
	const line = new Float32Array(Math.max(w, h) * n);
	for (let y = 0; y < h; y++) {
		const o = y * w * n;
		line.set(px.subarray(o, o + w * n));
		for (let x = 0; x < w; x++)
			for (let c = 0; c < n; c++) {
				let v = 0;
				for (let i = -r; i <= r; i++) v += k[i + r] * line[Math.min(w - 1, Math.max(0, x + i)) * n + c];
				px[o + x * n + c] = v;
			}
	}
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) for (let c = 0; c < n; c++) line[y * n + c] = px[(y * w + x) * n + c];
		for (let y = 0; y < h; y++)
			for (let c = 0; c < n; c++) {
				let v = 0;
				for (let i = -r; i <= r; i++) v += k[i + r] * line[Math.min(h - 1, Math.max(0, y + i)) * n + c];
				px[(y * w + x) * n + c] = v;
			}
	}
}

/**
 * A born-digital page made into what a scanner would give: rendered by MuPDF (RGB) at the
 * traits' resolution, paper and ink levels, blur, noise, optional uneven light, stored as a
 * JPEG covering a page of the same size. Returns the one-page PDF and the clean render's
 * grey (the truth for the oracle), or null when the page is too large or unreadable.
 */
export async function synthScan(m: Mupdf, bytes: Uint8Array, index: number, seed: number): Promise<{ pdf: Uint8Array; clean: Uint8Array; traits: SynthTraits } | null> {
	const rnd = prng(seed);
	const phone = rnd() < 0.12;
	const beige = rnd() < 0.2;
	const p0 = Math.round(236 + rnd() * 16);
	const t: SynthTraits = {
		ppi: rnd() < 0.25 ? 200 : 300,
		grey: rnd() < 0.3,
		paper: beige ? [Math.round(232 + rnd() * 10), Math.round(220 + rnd() * 10), Math.round(190 + rnd() * 15)] : [p0, p0 - 1, p0 - 3],
		ink: Math.round(8 + rnd() * 40),
		blur: phone ? 1.3 + rnd() * 0.8 : 0.4 + rnd() * 0.8,
		noise: 1.5 + rnd() * 5,
		quality: Math.round(60 + rnd() * 30),
		light: phone ? 0.55 + rnd() * 0.3 : 1
	};
	t.ppi = Math.round(t.ppi * (phone ? 0.85 + rnd() * 0.15 : 1));
	const doc = m.Document.openDocument(bytes, 'application/pdf');
	try {
		if (doc.needsPassword() || index >= doc.countPages()) return null;
		const page = doc.loadPage(index);
		try {
			const [x0, y0, x1, y1] = page.getBounds();
			const W = x1 - x0;
			const H = y1 - y0;
			if (!(W > 100 && H > 100) || ((W * t.ppi) / 72) * ((H * t.ppi) / 72) > 16e6) return null;
			const pix = page.toPixmap(m.Matrix.scale(t.ppi / 72, t.ppi / 72), m.ColorSpace.DeviceRGB, false, true);
			const w = pix.getWidth();
			const h = pix.getHeight();
			const stride = pix.getStride();
			const src = pix.getPixels();
			const f = new Float32Array(w * h * 3);
			const clean = new Uint8Array(w * h);
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					const o = y * stride + x * 3;
					clean[y * w + x] = (77 * src[o] + 150 * src[o + 1] + 29 * src[o + 2] + 128) >> 8;
					for (let c = 0; c < 3; c++) f[(y * w + x) * 3 + c] = t.ink + (src[o + c] / 255) * (t.paper[c] - t.ink);
				}
			pix.destroy();
			// Blur is given at 300 ppi; scale it to the scan's resolution.
			blur(f, w, h, 3, (t.blur * t.ppi) / 300);
			const n = t.grey ? 1 : 3;
			const out = new Uint8Array(w * h * n);
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					const light = 1 - (1 - t.light) * Math.min(1, Math.hypot(x / w, y / h) / Math.SQRT2) ** 1.5;
					const noise = (rnd() + rnd() + rnd() - 1.5) * 2 * t.noise;
					const i = y * w + x;
					if (n === 1) out[i] = Math.max(0, Math.min(255, Math.round((0.299 * f[i * 3] + 0.587 * f[i * 3 + 1] + 0.114 * f[i * 3 + 2]) * light + noise)));
					else for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(f[i * 3 + c] * light + noise)));
				}
			const jp = new m.Pixmap(n === 1 ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB, [0, 0, w, h], false);
			jp.getPixels().set(out);
			const jpeg = jp.asJPEG(t.quality).slice();
			jp.destroy();
			const nd = new m.PDFDocument();
			try {
				const dict = nd.newDictionary();
				dict.put('Type', nd.newName('XObject'));
				dict.put('Subtype', nd.newName('Image'));
				dict.put('ColorSpace', nd.newName(n === 1 ? 'DeviceGray' : 'DeviceRGB'));
				dict.put('Filter', nd.newName('DCTDecode'));
				dict.put('Width', w);
				dict.put('Height', h);
				dict.put('BitsPerComponent', 8);
				const img = nd.addRawStream(jpeg, dict);
				const res = nd.newDictionary();
				const xo = nd.newDictionary();
				xo.put('Scan', img);
				res.put('XObject', xo);
				const pg = nd.addPage([0, 0, W, H], 0, res, `q ${W} 0 0 ${H} 0 0 cm /Scan Do Q`);
				nd.insertPage(-1, pg);
				const pdf = nd.saveToBuffer('').asUint8Array().slice();
				return { pdf, clean, traits: t };
			} finally {
				nd.destroy();
			}
		} finally {
			page.destroy();
		}
	} finally {
		doc.destroy();
		m.emptyStore();
	}
}
