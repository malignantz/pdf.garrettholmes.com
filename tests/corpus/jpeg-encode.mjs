// @ts-nocheck -- plain Node module for the corpus generators (like generate.mjs)
/**
 * A small JPEG encoder for generated test files (tests/corpus/generate-jpeg.mjs): any
 * number of components (1 to 4), any sampling factors, baseline or progressive
 * (spectral selection: one DC scan, then one AC scan per component), the standard
 * Annex K Huffman tables or optimal ones, restart intervals, and any extra segments
 * (JFIF, Adobe, ICC, EXIF, ...) right after SOI. Components are coded as given: colour
 * conversion is the caller's business, which is what CMYK and YCCK files need.
 * Written for this repository so the corpus does not depend on libjpeg or a browser.
 */

const ZIGZAG = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57,
	50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
];

export const QUANT_LUMA = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22,
	37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
];
export const QUANT_CHROMA = [
	17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
	...new Array(32).fill(99)
];

/** Annex K tables: [bits (16 counts), values]. */
const STD = {
	dc0: [[0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
	dc1: [[0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
	ac0: [
		[0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
		[
			0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1,
			0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26,
			0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
			0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85,
			0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
			0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
			0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
			0xfa
		]
	],
	ac1: [
		[0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
		[
			0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42,
			0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19,
			0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
			0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83,
			0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
			0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
			0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
			0xfa
		]
	]
};

function codesOf([bits, vals]) {
	const map = new Map();
	let code = 0;
	let k = 0;
	for (let len = 1; len <= 16; len++) {
		for (let i = 0; i < bits[len - 1]; i++) map.set(vals[k++], { code: code++, len });
		code <<= 1;
	}
	return map;
}

/** Optimal length-limited table from symbol counts (T.81 Annex K.2, as libjpeg does it). */
function optimalTable(freqIn) {
	const freq = new Array(257).fill(0);
	for (const [s, n] of freqIn) freq[s] = n;
	freq[256] = 1; // reserve one code point so no code is all ones
	const codesize = new Array(257).fill(0);
	const others = new Array(257).fill(-1);
	for (;;) {
		let c1 = -1;
		let v = 1e18;
		for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) (v = freq[i]), (c1 = i);
		let c2 = -1;
		v = 1e18;
		for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) (v = freq[i]), (c2 = i);
		if (c2 < 0) break;
		freq[c1] += freq[c2];
		freq[c2] = 0;
		codesize[c1]++;
		while (others[c1] >= 0) (c1 = others[c1]), codesize[c1]++;
		others[c1] = c2;
		codesize[c2]++;
		while (others[c2] >= 0) (c2 = others[c2]), codesize[c2]++;
	}
	const bits = new Array(33).fill(0);
	for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
	for (let i = 32; i > 16; i--) {
		while (bits[i] > 0) {
			let j = i - 2;
			while (bits[j] === 0) j--;
			bits[i] -= 2;
			bits[i - 1]++;
			bits[j + 1] += 2;
			bits[j]--;
		}
	}
	let i = 16;
	while (bits[i] === 0) i--;
	bits[i]--; // drop the reserved code point
	const vals = [];
	for (let len = 1; len <= 32; len++) for (let s = 0; s <= 255; s++) if (codesize[s] === len) vals.push(s);
	return [bits.slice(1, 17), vals];
}

class Bits {
	constructor() {
		this.out = [];
		this.acc = 0;
		this.n = 0;
	}
	put(code, len) {
		for (let i = len - 1; i >= 0; i--) {
			this.acc = (this.acc << 1) | ((code >> i) & 1);
			if (++this.n === 8) this.byte();
		}
	}
	byte() {
		this.out.push(this.acc);
		if (this.acc === 0xff) this.out.push(0);
		this.acc = 0;
		this.n = 0;
	}
	flush() {
		while (this.n) this.put(1, 1);
	}
}

function category(v) {
	let a = Math.abs(v);
	let n = 0;
	while (a) (a >>= 1), n++;
	return n;
}
function extra(v, n) {
	return v >= 0 ? v : v + (1 << n) - 1;
}

const COS = [];
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);

function fdct(block) {
	const out = new Float64Array(64);
	for (let v = 0; v < 8; v++)
		for (let u = 0; u < 8; u++) {
			let s = 0;
			for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[x * 8 + u] * COS[y * 8 + v];
			out[v * 8 + u] = 0.25 * (u ? 1 : Math.SQRT1_2) * (v ? 1 : Math.SQRT1_2) * s;
		}
	return out;
}

function seg(marker, body) {
	const len = body.length + 2;
	return [0xff, marker, len >> 8, len & 255, ...body];
}

/**
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.height
 * @param {{id:number,h:number,v:number,tq:number,plane:Uint8Array}[]} o.components full-size planes (width × height)
 * @param {number[][]} o.quant quantisation tables, natural order, by slot
 * @param {boolean} [o.progressive]
 * @param {boolean} [o.optimize] optimal Huffman tables instead of the standard ones
 * @param {number} [o.restart] restart interval in MCUs (baseline only)
 * @param {number[][]} [o.segments] whole segments (marker included) written right after SOI
 * @param {number} [o.sofMarker] frame marker override (default 0xc0 / 0xc2)
 * @returns {Uint8Array}
 */
export function encodeJpeg(o) {
	const { width: W, height: H, components: comps, quant } = o;
	const hmax = Math.max(...comps.map((c) => c.h));
	const vmax = Math.max(...comps.map((c) => c.v));
	const mcuX = Math.ceil(W / (8 * hmax));
	const mcuY = Math.ceil(H / (8 * vmax));
	// Quantised coefficients per component, natural order, padded to whole MCUs.
	const data = comps.map((c) => {
		const cw = Math.ceil((W * c.h) / hmax);
		const ch = Math.ceil((H * c.v) / vmax);
		const bw = mcuX * c.h;
		const bh = mcuY * c.v;
		const sx = hmax / c.h;
		const sy = vmax / c.v;
		const px = (x, y) => {
			// box-filtered downsample, edges replicated
			let s = 0;
			for (let j = 0; j < sy; j++)
				for (let i = 0; i < sx; i++) {
					const X = Math.min(W - 1, Math.min(cw - 1, x) * sx + i);
					const Y = Math.min(H - 1, Math.min(ch - 1, y) * sy + j);
					s += c.plane[Y * W + X];
				}
			return s / (sx * sy);
		};
		const q = quant[c.tq];
		const blocks = [];
		for (let by = 0; by < bh; by++)
			for (let bx = 0; bx < bw; bx++) {
				const b = new Float64Array(64);
				for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b[y * 8 + x] = px(bx * 8 + x, by * 8 + y) - 128;
				const f = fdct(b);
				blocks.push(Int16Array.from(f, (v, k) => Math.round(v / q[k])));
			}
		return { c, cw, ch, bw, bh, blocks, nbx: Math.ceil(cw / 8), nby: Math.ceil(ch / 8) };
	});
	const dcSel = (i) => (i === 0 ? 0 : 1);

	// Scans: [component indexes, Ss, Se]
	const scans = o.progressive ? [[comps.map((_, i) => i), 0, 0], ...comps.map((_, i) => [[i], 1, 63])] : [[comps.map((_, i) => i), 0, 63]];

	/** Visits the blocks of a scan in coding order: f(componentIndex, block), restart(n) between intervals. */
	function walk(sc, f, restart) {
		const [ci] = sc;
		let mcu = 0;
		const rst = () => {
			if (o.restart && !o.progressive && mcu > 0 && mcu % o.restart === 0) restart(mcu / o.restart - 1);
			mcu++;
		};
		if (ci.length === 1) {
			const d = data[ci[0]];
			for (let y = 0; y < d.nby; y++)
				for (let x = 0; x < d.nbx; x++) {
					rst();
					f(ci[0], d.blocks[y * d.bw + x]);
				}
			return;
		}
		for (let my = 0; my < mcuY; my++)
			for (let mx = 0; mx < mcuX; mx++) {
				rst();
				for (const i of ci) {
					const d = data[i];
					for (let v = 0; v < d.c.v; v++) for (let h = 0; h < d.c.h; h++) f(i, d.blocks[(my * d.c.v + v) * d.bw + mx * d.c.h + h]);
				}
			}
	}

	/** Codes one scan; with `count`, only counts symbols (for optimal tables). */
	function codeScan(sc, tables, bits, count) {
		const [, ss, se] = sc;
		const pred = new Array(comps.length).fill(0);
		const sym = (table, s) => {
			if (count) table.set(s, (table.get(s) ?? 0) + 1);
			else {
				const e = table.get(s);
				bits.put(e.code, e.len);
			}
		};
		walk(
			sc,
			(i, blk) => {
				if (ss === 0) {
					const diff = blk[0] - pred[i];
					pred[i] = blk[0];
					const n = category(diff);
					sym(tables.dc[dcSel(i)], n);
					if (!count && n) bits.put(extra(diff, n), n);
				}
				if (se > 0) {
					let run = 0;
					for (let k = Math.max(1, ss); k <= se; k++) {
						const v = blk[ZIGZAG[k]];
						if (v === 0) {
							run++;
							continue;
						}
						while (run > 15) {
							sym(tables.ac[dcSel(i)], 0xf0);
							run -= 16;
						}
						const n = category(v);
						sym(tables.ac[dcSel(i)], (run << 4) | n);
						if (!count) bits.put(extra(v, n), n);
						run = 0;
					}
					if (run > 0) sym(tables.ac[dcSel(i)], 0x00);
				}
			},
			(k) => {
				if (count) return;
				bits.flush();
				bits.out.push(0xff, 0xd0 + (k % 8));
				pred.fill(0);
			}
		);
	}

	let specs;
	if (o.optimize) {
		const counts = { dc: [new Map(), new Map()], ac: [new Map(), new Map()] };
		for (const sc of scans) codeScan(sc, counts, null, true);
		specs = {
			dc: counts.dc.map((m) => (m.size ? optimalTable(m) : null)),
			ac: counts.ac.map((m) => (m.size ? optimalTable(m) : null))
		};
	} else specs = { dc: [STD.dc0, STD.dc1], ac: [STD.ac0, STD.ac1] };
	const used = new Set(comps.map((_, i) => dcSel(i)));

	const out = [0xff, 0xd8];
	for (const s of o.segments ?? []) out.push(...s);
	// DQT (8-bit), zigzag order
	for (const slot of new Set(comps.map((c) => c.tq))) out.push(...seg(0xdb, [slot, ...ZIGZAG.map((k) => quant[slot][k])]));
	const sof = o.sofMarker ?? (o.progressive ? 0xc2 : 0xc0);
	out.push(...seg(sof, [8, H >> 8, H & 255, W >> 8, W & 255, comps.length, ...comps.flatMap((c) => [c.id, (c.h << 4) | c.v, c.tq])]));
	const dht = [];
	for (const t of used) {
		if (specs.dc[t]) dht.push(t, ...specs.dc[t][0], ...specs.dc[t][1]);
		if (specs.ac[t]) dht.push(0x10 | t, ...specs.ac[t][0], ...specs.ac[t][1]);
	}
	out.push(...seg(0xc4, dht));
	if (o.restart && !o.progressive) out.push(...seg(0xdd, [o.restart >> 8, o.restart & 255]));
	const tables = { dc: specs.dc.map((t) => t && codesOf(t)), ac: specs.ac.map((t) => t && codesOf(t)) };
	for (const sc of scans) {
		const [ci, ss, se] = sc;
		out.push(...seg(0xda, [ci.length, ...ci.flatMap((i) => [comps[i].id, (dcSel(i) << 4) | dcSel(i)]), ss, se, 0]));
		const bits = new Bits();
		codeScan(sc, tables, bits, false);
		bits.flush();
		for (const b of bits.out) out.push(b);
	}
	out.push(0xff, 0xd9);
	return Uint8Array.from(out);
}

/** An APPn or COM segment: marker byte (0xe0-0xef, 0xfe) and payload (string or bytes). */
export function segment(marker, payload) {
	const body = typeof payload === 'string' ? [...payload].map((ch) => ch.charCodeAt(0) & 255) : [...payload];
	return seg(marker, body);
}

export const JFIF = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 72, 0, 72, 0, 0]);
/** Adobe APP14: version 100, flags 0, 0, transform (0 none/CMYK/RGB, 1 YCbCr, 2 YCCK). */
export const adobe = (transform) => segment(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, transform]);
