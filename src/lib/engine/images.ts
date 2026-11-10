/**
 * Image intake helpers: JPEG/PNG header parsing, EXIF orientation, metadata stripping,
 * and the page-size rule for images.
 *
 * Page-size rule: the page takes the image's displayed aspect ratio (after EXIF
 * orientation) and fits inside US Letter turned to match (612×792 pt for portrait or
 * square images, 792×612 pt for landscape ones). Images are never enlarged beyond
 * 1 pt per pixel, so the effective resolution is at least 72 dpi; a small image gets a
 * small page instead of a blurry full sheet. Example: a 4032×3024 phone photo becomes a
 * 792×594 pt page; a 300×200 icon becomes a 300×200 pt page.
 */

import type { PageSize } from '../core/types';
import type { Matrix } from './geometry';
import { EngineError } from './errors';

export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface JpegInfo {
	width: number;
	height: number;
	components: number;
	orientation: Orientation;
}

export interface PngInfo {
	width: number;
	height: number;
}

const MAX_PIXELS = 100_000_000;
const MAX_SIDE = 65_535;

export function parseJpeg(bytes: Uint8Array): JpegInfo {
	const bad = () => new EngineError('unreadable', 'This JPEG image is damaged or not a JPEG.');
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw bad();
	let i = 2;
	let orientation: Orientation = 1;
	while (i < bytes.length) {
		if (bytes[i] !== 0xff) throw bad();
		while (bytes[i] === 0xff) i++; // fill bytes
		const marker = bytes[i++];
		if (marker === undefined) break;
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (marker === 0xd9) break;
		if (i + 2 > bytes.length) throw bad();
		const len = (bytes[i] << 8) | bytes[i + 1];
		if (len < 2 || i + len > bytes.length) throw bad();
		const seg = bytes.subarray(i + 2, i + len);
		if (marker === 0xe1 && isExif(seg)) {
			orientation = readExifOrientation(seg.subarray(6)) ?? orientation;
		}
		if (isSof(marker)) {
			if (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) {
				throw new EngineError(
					'unsupported',
					'This JPEG uses a compression mode that PDF files cannot hold. Convert it to PNG first.'
				);
			}
			if (seg.length < 6) throw bad();
			const precision = seg[0];
			const height = (seg[1] << 8) | seg[2];
			const width = (seg[3] << 8) | seg[4];
			const components = seg[5];
			if (precision !== 8) {
				throw new EngineError('unsupported', 'This JPEG uses 12-bit color, which PDF viewers cannot show reliably. Convert it to PNG first.');
			}
			if (components !== 1 && components !== 3 && components !== 4) {
				throw new EngineError('unsupported', 'This JPEG has an unusual color layout. Convert it to PNG first.');
			}
			if (width === 0 || height === 0) {
				throw new EngineError('unsupported', 'This JPEG does not state its size. Convert it to PNG first.');
			}
			checkPixels(width, height);
			return { width, height, components, orientation };
		}
		if (marker === 0xda) break;
		i += len;
	}
	throw bad();
}

function isSof(m: number) {
	return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function isExif(seg: Uint8Array) {
	return seg.length > 14 && seg[0] === 0x45 && seg[1] === 0x78 && seg[2] === 0x69 && seg[3] === 0x66 && seg[4] === 0 && seg[5] === 0;
}

/** Reads tag 0x0112 from IFD0 of a TIFF block. Returns undefined if absent or malformed. */
export function readExifOrientation(tiff: Uint8Array): Orientation | undefined {
	if (tiff.length < 8) return undefined;
	const le = tiff[0] === 0x49 && tiff[1] === 0x49;
	const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
	if (!le && !be) return undefined;
	const u16 = (o: number) => (le ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]);
	const u32 = (o: number) =>
		le
			? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0
			: ((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0;
	if (u16(2) !== 42) return undefined;
	const ifd = u32(4);
	if (ifd + 2 > tiff.length) return undefined;
	const count = u16(ifd);
	for (let k = 0; k < count; k++) {
		const e = ifd + 2 + k * 12;
		if (e + 12 > tiff.length) return undefined;
		if (u16(e) === 0x0112) {
			const type = u16(e + 2);
			const value = type === 3 ? u16(e + 8) : type === 4 ? u32(e + 8) : 0;
			return value >= 1 && value <= 8 ? (value as Orientation) : undefined;
		}
	}
	return undefined;
}

/**
 * Removes metadata segments (EXIF, XMP, IPTC, comments and other APPn) before SOS.
 * Keeps APP0 (JFIF), APP2 (ICC profile) and APP14 (Adobe color transform), which
 * affect how the pixels decode. The entropy-coded data is copied untouched.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
	const keep: Array<[number, number]> = [[0, 2]];
	let i = 2;
	while (i < bytes.length) {
		if (bytes[i] !== 0xff) return bytes;
		const segStart = i;
		while (bytes[i] === 0xff) i++;
		const marker = bytes[i++];
		if (marker === 0xda || marker === 0xd9) {
			keep.push([segStart, bytes.length]);
			break;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			keep.push([segStart, i]);
			continue;
		}
		const len = (bytes[i] << 8) | bytes[i + 1];
		const end = i + len;
		if (len < 2 || end > bytes.length) return bytes;
		const drop = (marker >= 0xe0 && marker <= 0xef && marker !== 0xe0 && marker !== 0xe2 && marker !== 0xee) || marker === 0xfe;
		if (!drop) keep.push([segStart, end]);
		i = end;
	}
	const size = keep.reduce((n, [a, b]) => n + (b - a), 0);
	if (size === bytes.length) return bytes;
	const out = new Uint8Array(size);
	let o = 0;
	for (const [a, b] of keep) {
		out.set(bytes.subarray(a, b), o);
		o += b - a;
	}
	return out;
}

export function parsePng(bytes: Uint8Array): PngInfo {
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.length < 33 || sig.some((b, k) => bytes[k] !== b)) {
		throw new EngineError('unreadable', 'This PNG image is damaged or not a PNG.');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(12) !== 0x49484452) throw new EngineError('unreadable', 'This PNG image is damaged.');
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (width === 0 || height === 0) throw new EngineError('unreadable', 'This PNG image is damaged.');
	checkPixels(width, height);
	return { width, height };
}

function checkPixels(width: number, height: number) {
	if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
		throw new EngineError('too-large', 'This image has too many pixels to place on a page. Resize it and try again.');
	}
}

/** Pixel size as displayed, after EXIF orientation. */
export function orientedPixels(width: number, height: number, orientation: Orientation) {
	return orientation >= 5 ? { width: height, height: width } : { width, height };
}

export function imagePageSize(displayWidth: number, displayHeight: number): PageSize {
	const landscape = displayWidth > displayHeight;
	const boxW = landscape ? 792 : 612;
	const boxH = landscape ? 612 : 792;
	const scale = Math.min(1, boxW / displayWidth, boxH / displayHeight);
	const round = (v: number) => Math.max(1, Math.round(v * 1000) / 1000);
	return { width: round(displayWidth * scale), height: round(displayHeight * scale) };
}

/**
 * `cm` matrix that draws an image XObject (unit square) onto a W×H page so that it
 * appears as EXIF orientation `o` says it should.
 */
export function orientationMatrix(o: Orientation, W: number, H: number): Matrix {
	switch (o) {
		case 1:
			return [W, 0, 0, H, 0, 0];
		case 2:
			return [-W, 0, 0, H, W, 0];
		case 3:
			return [-W, 0, 0, -H, W, H];
		case 4:
			return [W, 0, 0, -H, 0, H];
		case 5:
			return [0, -H, -W, 0, W, H];
		case 6:
			return [0, -H, W, 0, 0, H];
		case 7:
			return [0, H, W, 0, 0, 0];
		case 8:
			return [0, H, -W, 0, W, 0];
	}
}
