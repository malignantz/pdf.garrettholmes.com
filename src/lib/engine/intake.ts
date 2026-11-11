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

const NON_STREAM = /page object (\d+) (\d+): item index \d+ \(from \d+\): ignoring non-stream in an array of streams/;
/** Most pages repaired in one file before giving up. */
const MAX_CONTENT_FIXES = 20;

/**
 * The page count from `qpdf --show-pages`, which also resolves every page's content list.
 * A content list holding something other than a stream (a null left by a missing object)
 * is drawn as if the item were not there by PDF.js and MuPDF, but stops qpdf from copying
 * the page: such items are removed here, page by page. Returns null when qpdf cannot
 * list the pages for any other reason.
 */
export async function listPages(qpdf: Qpdf, bytes: Uint8Array): Promise<{ bytes: Uint8Array; pages: number; fixedPages: number } | null> {
	let fixedPages = 0;
	for (;;) {
		const res = await qpdf.run({ args: ['--show-pages', '/p.pdf'], inputs: { '/p.pdf': bytes } });
		if (res.code === QPDF_OK) {
			return { bytes, pages: (res.stdout.match(/^page \d+: /gm) ?? []).length, fixedPages };
		}
		const bad = NON_STREAM.exec(res.stderr);
		if (!bad || fixedPages >= MAX_CONTENT_FIXES) return null;
		const fixed = await dropNonStreams(qpdf, bytes, `${bad[1]} ${bad[2]} R`);
		if (!fixed) return null;
		bytes = fixed;
		fixedPages++;
	}
}

type JsonObj = { value?: unknown; stream?: unknown };

async function jsonObjects(qpdf: Qpdf, bytes: Uint8Array, refs: string[]) {
	const res = await qpdf.run({
		args: ['--json=2', '--json-key=qpdf', ...refs.map((r) => `--json-object=${r.replace(/^(\d+) (\d+) R$/, '$1,$2')}`), '--json-stream-data=none', '/j.pdf', '/j.json'],
		inputs: { '/j.pdf': bytes },
		outputs: ['/j.json']
	});
	const file = res.files.get('/j.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return null;
	const parsed = JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Record<string, unknown>, Record<string, JsonObj>] };
	return { header: parsed.qpdf[0], objects: parsed.qpdf[1] };
}

/** `bytes` with the page's /Contents array reduced to its streams, or null. */
async function dropNonStreams(qpdf: Qpdf, bytes: Uint8Array, page: string): Promise<Uint8Array | null> {
	const first = await jsonObjects(qpdf, bytes, [page]);
	const dict = first?.objects[`obj:${page}`]?.value as Record<string, unknown> | undefined;
	const contents = dict?.['/Contents'];
	if (!first || !dict || !Array.isArray(contents)) return null;
	const refs = contents.filter((c): c is string => typeof c === 'string' && /^\d+ \d+ R$/.test(c));
	const resolved = refs.length ? await jsonObjects(qpdf, bytes, refs) : { objects: {} as Record<string, JsonObj> };
	if (!resolved) return null;
	const kept = refs.filter((r) => resolved.objects[`obj:${r}`]?.stream !== undefined);
	if (kept.length === contents.length) return null;
	const update = { qpdf: [first.header, { [`obj:${page}`]: { value: { ...dict, '/Contents': kept } } }] };
	const res = await qpdf.run({
		args: ['/p.pdf', '--update-from-json=/p.json', '/p-out.pdf'],
		inputs: { '/p.pdf': bytes, '/p.json': new TextEncoder().encode(JSON.stringify(update)) },
		outputs: ['/p-out.pdf']
	});
	const out = res.files.get('/p-out.pdf');
	return (res.code === QPDF_OK || res.code === QPDF_WARNINGS) && out ? out : null;
}
