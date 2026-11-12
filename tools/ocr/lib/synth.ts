/** Page selection, page kinds, scan degradations and truth for the synthetic-scan measurement. */
import * as mupdf from 'mupdf';
import { bitonal, blur, faxRows, IDENTITY, levelsNoise, lighting, rng, rotate, type Gray, type Mat } from './degrade';
import type { PageInfo } from './truth';
import { norm, type Box, type TruthWord } from './score';

export type Degradation = 'clean' | 'scan' | 'bitonal' | 'phone' | 'fax';

const FORM_SOURCES = new Set(['irs-forms', 'uscis-forms', 'gsa-forms', 'state-forms', 'uscourts-forms', 'intl-forms']);

const STOPWORDS = new Set('the of and to a in is it that for on are with as be at this from or by not was an have which you your all will can if any may has must other such been under each their these shall more one who no also date name'.split(' '));

/** Why a page is not good truth, or null. */
export function rejectPage(info: PageInfo): string | null {
	const ws = info.words.filter((w) => norm(w.t).length > 0);
	if (ws.length < 40) return 'few words';
	if (info.imageCover > 0.5) return 'mostly picture';
	if (ws.filter((w) => w.invisible).length > 0.02 * ws.length) return 'invisible text (OCR layer)';
	if (info.skipped > 0.02 * (ws.length * 5)) return 'characters not offered';
	const good = ws.filter((w) => w.vis && w.level);
	if (good.length < 0.8 * ws.length) return 'hidden or tilted text';
	const toks = good.map((w) => norm(w.t));
	if (toks.filter((t) => /^[a-z0-9]+$/.test(t)).length < 0.9 * toks.length) return 'not Latin';
	if (toks.filter((t) => STOPWORDS.has(t)).length < 0.1 * toks.length) return 'not English prose';
	return null;
}

export function pageKind(source: string, info: PageInfo, truth: TruthWord[]): string {
	const sizes = truth.map((t) => t.size).sort((a, b) => a - b);
	const med = sizes[Math.floor(sizes.length / 2)] ?? 10;
	if (FORM_SOURCES.has(source)) return 'form';
	if (med < 8) return 'small print';
	if (med >= 16) return 'slides / large';
	const nums = truth.filter((t) => /^[\d$€£%.,()/:-]+$/.test(t.t) && /\d/.test(t.t)).length;
	if (nums >= 0.25 * truth.length) return 'table / numbers';
	// Lines: start and width.
	const lines = new Map<number, [number, number]>();
	for (const t of truth) {
		const l = lines.get(t.line) ?? [Infinity, -Infinity];
		lines.set(t.line, [Math.min(l[0], t.h[0]), Math.max(l[1], t.h[2])]);
	}
	const ls = [...lines.values()];
	const right = ls.filter((l) => l[0] > 0.45 * info.W).length / ls.length;
	const narrow = ls.filter((l) => l[1] - l[0] < 0.5 * info.W).length / ls.length;
	if (right >= 0.25 && narrow >= 0.6) return 'multi-column';
	return 'letter / prose';
}

export function hashSeed(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

/** The degraded image of a page render and its geometry (render pixels → image pixels). */
export function degrade(src: Gray, deg: Degradation, dpi: number, seed: number): { img: Gray; m: Mat; p: Record<string, number>; kind: 'png' | 'jpeg'; q: number } {
	const r = rng(seed);
	const k = dpi / 300;
	const u = (a: number, b: number) => a + (b - a) * r();
	const sign = () => (r() < 0.5 ? -1 : 1);
	if (deg === 'clean') return { img: src, m: IDENTITY, p: {}, kind: 'png', q: 0 };
	if (deg === 'scan') {
		const angle = sign() * u(0, 2);
		const sigma = u(0.4, 1.0) * k;
		const paper = u(225, 250);
		const ink = u(10, 60);
		const sd = u(4, 12);
		const q = Math.round(u(45, 80));
		const rot = rotate(src, angle);
		const img = levelsNoise(blur(rot.img, sigma), paper, ink, sd, r);
		return { img, m: rot.m, p: { angle, sigma, paper, ink, sd, q }, kind: 'jpeg', q };
	}
	if (deg === 'bitonal') {
		const angle = sign() * u(0, 2);
		const th = u(110, 160);
		const rot = rotate(src, angle);
		const img = bitonal(levelsNoise(blur(rot.img, 0.5 * k), 255, 0, 6, r), th, 0.0002, r);
		return { img, m: rot.m, p: { angle, th }, kind: 'png', q: 0 };
	}
	if (deg === 'fax') {
		const angle = sign() * u(0, 1.5);
		const th = u(120, 150);
		const rot = rotate(src, angle);
		const img = bitonal(faxRows(levelsNoise(blur(rot.img, 0.5 * k), 255, 0, 8, r)), th, 0.0005, r);
		return { img, m: rot.m, p: { angle, th }, kind: 'png', q: 0 };
	}
	// phone: uneven light, softer focus, more noise, JPEG.
	const angle = sign() * u(0, 2);
	const sigma = u(0.8, 1.5) * k * 1.5;
	const sd = u(6, 12);
	const q = Math.round(u(55, 80));
	const rot = rotate(src, angle);
	const lit = lighting(levelsNoise(blur(rot.img, sigma), u(220, 245), u(20, 70), 0, r), r);
	const img = levelsNoise(lit, 255, 0, sd, r);
	return { img, m: rot.m, p: { angle, sigma, sd, q }, kind: 'jpeg', q };
}

/** Truth words worth scoring, and the boxes to ignore (pictures, hidden or tilted text, text without ink). */
export function truthOf(info: PageInfo, clean: Gray | null, dpi: number): { truth: TruthWord[]; ignore: Box[] } {
	const truth: TruthWord[] = [];
	const ignore: Box[] = info.images.map((im) => im.box);
	const k = dpi / 72;
	for (const w of info.words) {
		const t: TruthWord = { t: w.t, h: w.h, ink: w.ink, size: Math.round(w.size * 10) / 10, line: w.line };
		if (!w.vis || !w.level || !norm(w.t)) {
			ignore.push(w.h);
			continue;
		}
		if (clean) {
			// Some ink must show in the clean render (text painted over or white is not truth).
			let dark = 0;
			const x0 = Math.max(0, Math.floor(w.ink[0] * k));
			const x1 = Math.min(clean.w - 1, Math.ceil(w.ink[2] * k));
			const y0 = Math.max(0, Math.floor(w.ink[1] * k));
			const y1 = Math.min(clean.h - 1, Math.ceil(w.ink[3] * k));
			for (let y = y0; y <= y1 && dark < 3; y++) for (let x = x0; x <= x1; x++) if (clean.px[y * clean.w + x] < 160) dark++;
			if (dark < 3) {
				ignore.push(w.h);
				continue;
			}
		}
		truth.push(t);
	}
	return { truth, ignore };
}

export function decodeGray(bytes: Uint8Array): Gray {
	const im = new mupdf.Image(bytes);
	const pix = im.toPixmap();
	try {
		const g = pix.getNumberOfComponents() === 1 ? pix : pix.convertToColorSpace(mupdf.ColorSpace.DeviceGray);
		const w = g.getWidth();
		const h = g.getHeight();
		const stride = g.getStride();
		const src = g.getPixels();
		const px = new Uint8Array(w * h);
		for (let y = 0; y < h; y++) px.set(src.subarray(y * stride, y * stride + w), y * w);
		return { w, h, px };
	} finally {
		pix.destroy();
		im.destroy();
	}
}
