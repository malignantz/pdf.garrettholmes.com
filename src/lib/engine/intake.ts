/**
 * Intake checks that look at the original bytes, beside qpdf's own reading.
 */

import { QPDF_OK, QPDF_WARNINGS, type Qpdf } from './qpdf';

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

/**
 * Calls `visit(num, gen, offset)` for every "N G obj" header in the raw bytes (objects
 * inside object streams are not seen, and need not be: they always have generation 0).
 */
function scanHeaders(bytes: Uint8Array, visit: (num: number, gen: number, offset: number) => void) {
	let i = 0;
	for (;;) {
		i = bytes.indexOf(0x6f, i + 1); // 'o'
		if (i < 0) return;
		if (bytes[i + 1] !== 0x62 || bytes[i + 2] !== 0x6a) continue; // 'bj'
		const after = bytes[i + 3];
		if (after !== undefined && ((after >= 0x41 && after <= 0x5a) || (after >= 0x61 && after <= 0x7a))) continue;
		let j = i - 1;
		if (!WS.has(bytes[j])) continue;
		while (j >= 0 && WS.has(bytes[j])) j--;
		let gen = 0;
		let mul = 1;
		let digits = 0;
		while (j >= 0 && isDigit(bytes[j]) && digits < 6) {
			gen += (bytes[j] - 0x30) * mul;
			mul *= 10;
			digits++;
			j--;
		}
		if (digits === 0 || !WS.has(bytes[j])) continue;
		while (j >= 0 && WS.has(bytes[j])) j--;
		let num = 0;
		mul = 1;
		digits = 0;
		while (j >= 0 && isDigit(bytes[j]) && digits < 11) {
			num += (bytes[j] - 0x30) * mul;
			mul *= 10;
			digits++;
			j--;
		}
		if (digits === 0 || (j >= 0 && isDigit(bytes[j]))) continue;
		visit(num, gen, j + 1);
	}
}

/**
 * True when the file defines an object number with two different generation numbers and
 * qpdf resolves it to an older definition than the newest one in the file. Readers disagree
 * on such files: qpdf (and so every export) follows the generation in the reference, while
 * PDF.js, MuPDF and most viewers take the newest definition whatever its generation. Seen
 * in files saved by apps that append an update with a reset generation number; the
 * update's changes (often annotations) would silently vanish from exports.
 *
 * Cheap for ordinary files: one pass over the bytes; qpdf runs only when some object
 * number appears with two generations.
 */
export async function hasGenerationConflict(qpdf: Qpdf, bytes: Uint8Array, passwordArgs: string[]): Promise<boolean> {
	// Pass 1: object numbers seen with a generation other than 0 (rare).
	const odd = new Set<number>();
	scanHeaders(bytes, (num, gen) => {
		if (gen !== 0) odd.add(num);
	});
	if (odd.size === 0) return false;
	// Pass 2: every definition of those numbers.
	const defs = new Map<number, Map<number, number>>();
	scanHeaders(bytes, (num, gen, offset) => {
		if (!odd.has(num)) return;
		const m = defs.get(num) ?? new Map<number, number>();
		m.set(gen, Math.max(offset, m.get(gen) ?? -1));
		defs.set(num, m);
	});
	const multi = [...defs].filter(([, m]) => m.size > 1);
	if (multi.length === 0) return false;
	const res = await qpdf.run({ args: [...passwordArgs, '--show-xref', '/x.pdf'], inputs: { '/x.pdf': bytes } });
	if (res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) return false;
	const chosen = new Map<number, { gen: number; offset: number }>();
	for (const m of res.stdout.matchAll(/^(\d+)\/(\d+): uncompressed; offset = (\d+)/gm)) {
		chosen.set(Number(m[1]), { gen: Number(m[2]), offset: Number(m[3]) });
	}
	return multi.some(([num, gens]) => {
		const c = chosen.get(num);
		if (!c) return false;
		return [...gens].some(([gen, offset]) => gen !== c.gen && offset > c.offset);
	});
}
