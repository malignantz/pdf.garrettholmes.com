/**
 * JPEG marker structure, read in JavaScript (no decoding): what the repack (jpeg-repack.ts)
 * may touch and what it must keep. Used before and after a repack:
 *
 * - before: only sequential or progressive Huffman JPEGs (SOF0, SOF1, SOF2), 8-bit, one
 *   frame, starting at SOI, ending in EOI, no DNL/DAC/DHP/EXP, are offered to the repack;
 *   colour-relevant segments after the frame header and more than one EXIF block (PDF.js
 *   then picks another decoder) are refused;
 * - after: the output must be baseline sequential (SOF0/SOF1, one frame), with the same
 *   frame (precision, size, component ids, sampling, table slots) and exactly the same
 *   kept segments, byte for byte and in the same order, and no other APPn or COM segment.
 *
 * Kept segments are the ones a PDF reader's decoder can act on: APP0 "JFIF" (poppler uses
 * its presence to choose the colour transform), APP2 "ICC_PROFILE" (browsers apply it when
 * PDF.js hands the JPEG to the platform decoder) and APP14 "Adobe" (colour transform and,
 * for CMYK, inversion, in PDF.js, MuPDF, poppler and PDFium). Everything else (EXIF, XMP,
 * thumbnails, comments, Photoshop data) is ignored by those decoders (measured:
 * /home/garrett/pdf-survey/out-jpeg-repack/notes.md, section 2) and dropped by the repack.
 */

export interface JpegComponent {
	id: number;
	h: number;
	v: number;
	tq: number;
}

export interface JpegInfo {
	/** Frame marker (0xc0 baseline, 0xc1 extended, 0xc2 progressive, ...). */
	sof: number;
	precision: number;
	width: number;
	height: number;
	components: JpegComponent[];
	/** Kept segments (marker and length included), in file order. */
	kept: Uint8Array[];
	/** A kept segment comes after the frame header. */
	keptAfterFrame: boolean;
	/** APP1 segments starting "Exif\0\0". */
	exif: number;
	/** APPn and COM segments that are not kept. */
	dropped: number;
	scans: number;
	/** Bytes after EOI. */
	trailing: number;
	/** DC/AC coefficient buffer bytes the decoder allocates (an estimate from the frame). */
	coefBytes: number;
}

export type JpegParse = { ok: true; info: JpegInfo } | { ok: false; why: string };

function startsWith(d: Uint8Array, at: number, s: string): boolean {
	if (at + s.length > d.length) return false;
	for (let i = 0; i < s.length; i++) if (d[at + i] !== s.charCodeAt(i)) return false;
	return true;
}

/** Same rule as keep_marker() in vendor/jpeg-repack/repack.c. */
function isKept(marker: number, d: Uint8Array, data: number, len: number): boolean {
	if (marker === 0xe0) return len >= 4 && startsWith(d, data, 'JFIF');
	if (marker === 0xe2) return len >= 12 && startsWith(d, data, 'ICC_PROFILE\0');
	if (marker === 0xee) return len >= 5 && startsWith(d, data, 'Adobe');
	return false;
}

/** Reads the marker structure of a whole JPEG (entropy-coded data is skipped, not decoded). */
export function parseJpeg(d: Uint8Array): JpegParse {
	const fail = (why: string): JpegParse => ({ ok: false, why });
	if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) return fail('no SOI at the start');
	let p = 2;
	let sof = -1;
	let precision = 0;
	let width = 0;
	let height = 0;
	const components: JpegComponent[] = [];
	const kept: Uint8Array[] = [];
	let keptAfterFrame = false;
	let exif = 0;
	let dropped = 0;
	let scans = 0;
	for (;;) {
		if (p >= d.length) return fail('no EOI');
		if (d[p] !== 0xff) return fail('bytes between segments');
		while (p < d.length && d[p] === 0xff) p++;
		if (p >= d.length) return fail('no EOI');
		const m = d[p++];
		if (m === 0xd9) break;
		if (m === 0xd8) return fail('second SOI');
		if ((m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0x00) return fail('stray marker');
		if (p + 2 > d.length) return fail('truncated segment');
		const len = (d[p] << 8) | d[p + 1];
		if (len < 2 || p + len > d.length) return fail('truncated segment');
		const data = p + 2;
		const end = p + len;
		if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
			if (sof !== -1) return fail('more than one frame');
			sof = m;
			if (len < 8) return fail('short frame header');
			precision = d[data];
			height = (d[data + 1] << 8) | d[data + 2];
			width = (d[data + 3] << 8) | d[data + 4];
			const n = d[data + 5];
			if (len !== 8 + 3 * n || n < 1 || n > 4) return fail('bad frame header');
			for (let i = 0; i < n; i++) {
				const o = data + 6 + 3 * i;
				components.push({ id: d[o], h: d[o + 1] >> 4, v: d[o + 1] & 15, tq: d[o + 2] });
			}
		} else if (m === 0xcc) return fail('arithmetic coding');
		else if (m === 0xdc) return fail('DNL marker');
		else if (m === 0xde || m === 0xdf) return fail('hierarchical');
		else if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
			if (isKept(m, d, data, len - 2)) {
				kept.push(d.subarray(p - 2, end));
				if (sof !== -1) keptAfterFrame = true;
			} else {
				dropped++;
				if (m === 0xe1 && startsWith(d, data, 'Exif\0\0')) exif++;
			}
		} else if (m !== 0xc4 && m !== 0xdb && m !== 0xdd && m !== 0xda) {
			return fail(`unknown marker ${m.toString(16)}`);
		}
		p = end;
		if (m === 0xda) {
			if (sof === -1) return fail('scan before frame');
			scans++;
			// Entropy-coded data runs to the next marker other than a stuffed zero or a restart.
			while (p < d.length) {
				if (d[p] !== 0xff) {
					p++;
					continue;
				}
				const n = d[p + 1];
				if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
					p += n === 0xff ? 1 : 2;
					continue;
				}
				break;
			}
		}
	}
	if (sof === -1 || scans === 0) return fail('no frame or scan');
	let hmax = 1;
	let vmax = 1;
	for (const c of components) {
		if (c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4) return fail('bad sampling');
		hmax = Math.max(hmax, c.h);
		vmax = Math.max(vmax, c.v);
	}
	let coefBytes = 0;
	for (const c of components) {
		const bw = Math.ceil(Math.ceil((width * c.h) / hmax) / 8) + c.h;
		const bh = Math.ceil(Math.ceil((height * c.v) / vmax) / 8) + c.v;
		coefBytes += bw * bh * 128;
	}
	return {
		ok: true,
		info: { sof, precision, width, height, components, kept, keptAfterFrame, exif, dropped, scans, trailing: d.length - p, coefBytes }
	};
}

/** Why the input may not be offered to the repack, or null when it may. */
export function repackRefusal(info: JpegInfo): string | null {
	if (info.sof !== 0xc0 && info.sof !== 0xc1 && info.sof !== 0xc2) return `frame type ${info.sof.toString(16)}`;
	if (info.precision !== 8) return `${info.precision}-bit`;
	if (info.width === 0 || info.height === 0) return 'no size in the frame header';
	if (info.keptAfterFrame) return 'colour segment after the frame header';
	if (info.exif > 1) return 'more than one EXIF block';
	return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Why the repack output may not replace the input, or null when it may (structure only). */
export function outputRefusal(input: JpegInfo, out: JpegInfo): string | null {
	if (out.sof !== 0xc0 && out.sof !== 0xc1) return `output frame type ${out.sof.toString(16)}`;
	if (out.precision !== input.precision || out.width !== input.width || out.height !== input.height) return 'frame changed';
	if (out.components.length !== input.components.length) return 'components changed';
	const one = input.components.length === 1;
	for (let i = 0; i < out.components.length; i++) {
		const a = input.components[i];
		const b = out.components[i];
		// A single component's sampling factors carry no meaning (T.81 A.2); libjpeg writes 1×1.
		if (a.id !== b.id || a.tq !== b.tq || (!one && (a.h !== b.h || a.v !== b.v))) return 'components changed';
	}
	if (out.kept.length !== input.kept.length || !input.kept.every((k, i) => sameBytes(k, out.kept[i]))) return 'colour segments changed';
	if (out.dropped !== 0 || out.keptAfterFrame || out.trailing !== 0) return 'unexpected segments in the output';
	return null;
}
