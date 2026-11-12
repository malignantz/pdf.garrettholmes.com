/**
 * Orientation detection (Tesseract OSD, legacy engine) as a decline signal: is a page
 * sideways or upside down? Runs tesseract.js `detect` on the benchmark scans turned by
 * 0/90/180/270 degrees and on the graded real scans, and reports how often the angle is
 * right, its confidence, and the time per page.
 *
 *   npm run ocr:osd -- [--out DIR] [--limit 25]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as mupdf from 'mupdf';
import { parseArgs } from '../survey/lib/common';
import { OCR_DIR } from './lib/tess';
import { decodeGray } from './lib/synth';
import { encode } from './lib/truth';
import type { Gray } from './lib/degrade';

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? '/home/garrett/pdf-survey/out-ocr');
const require = createRequire(path.join(OCR_DIR, 'package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T: any = require('tesseract.js');

function turn(g: Gray, deg: number): Gray {
	if (deg === 0) return g;
	const { w, h, px } = g;
	const W = deg === 180 ? w : h;
	const H = deg === 180 ? h : w;
	const o = new Uint8Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			// Clockwise turns.
			const [nx, ny] = deg === 90 ? [h - 1 - y, x] : deg === 180 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
			o[ny * W + nx] = px[y * w + x];
		}
	return { w: W, h: H, px: o };
}

process.env.OCR_CORE = 'relaxedsimd';
const t0 = performance.now();
const w = await T.createWorker('osd', 0, {
	workerPath: path.join(OCR_DIR, 'node-worker.cjs'),
	langPath: path.join(OCR_DIR, 'models', 'osd'),
	gzip: false,
	cacheMethod: 'none',
	legacyCore: true,
	legacyLang: true
});
const loadMs = performance.now() - t0;
const rows: { src: string; turned: number; angle: number | null; conf: number; script: string | null; ms: number }[] = [];
const detect = async (src: string, img: Uint8Array, turned: number) => {
	const ts = performance.now();
	try {
		const r = await w.detect(Buffer.from(img));
		rows.push({ src, turned, angle: r.data.orientation_degrees ?? null, conf: r.data.orientation_confidence ?? 0, script: r.data.script ?? null, ms: performance.now() - ts });
	} catch (e) {
		rows.push({ src, turned, angle: null, conf: 0, script: String(e).slice(0, 60), ms: performance.now() - ts });
	}
};
const bench = path.join(out, 'png', 'bench');
const files = fs.readdirSync(bench).filter((f) => /-scan-300\.jpg$/.test(f)).slice(0, args.num('limit', 25));
for (const f of files) {
	const g = decodeGray(fs.readFileSync(path.join(bench, f)));
	for (const deg of [0, 90, 180, 270]) await detect(`synthetic ${f.slice(0, 8)}`, encode(mupdf, turn(g, deg), 'png'), deg);
}
const grades = fs.existsSync(path.join(out, 'grade', 'grades.json')) ? (JSON.parse(fs.readFileSync(path.join(out, 'grade', 'grades.json'), 'utf8')) as Record<string, { group: string }>) : {};
for (const [key, g] of Object.entries(grades)) {
	const f = path.join(out, 'png', 'c', `${key}.png`);
	if (fs.existsSync(f)) await detect(`real ${g.group}`, fs.readFileSync(f), g.group === 'sideways text' ? -1 : 0);
}
await w.terminate();
// Tesseract reports the angle the page must be turned (counter-clockwise) to be upright.
const right = (r: (typeof rows)[number]) => r.turned >= 0 && r.angle !== null && (r.angle + r.turned) % 360 === 0;
const L = ['# Orientation detection (Tesseract OSD, legacy core)', '', `Engine load ${(loadMs / 1000).toFixed(1)} s (legacy core + osd.traineddata).`, '', '| pages | turned | detected right | conf ≥ 2 and right | conf ≥ 2 and wrong | s/page p50 |', '|---|---:|---:|---:|---:|---:|'];
const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
for (const deg of [0, 90, 180, 270]) {
	const rs = rows.filter((r) => r.src.startsWith('synthetic') && r.turned === deg);
	L.push(`| synthetic scans | ${deg}° | ${rs.filter(right).length} / ${rs.length} | ${rs.filter((r) => r.conf >= 2 && right(r)).length} | ${rs.filter((r) => r.conf >= 2 && !right(r)).length} | ${(med(rs.map((r) => r.ms)) / 1000).toFixed(2)} |`);
}
L.push('', '| real scan (graded set) | angle to turn | confidence | script |', '|---|---:|---:|---|');
for (const r of rows.filter((r) => r.src.startsWith('real'))) L.push(`| ${r.src.slice(5)} | ${r.angle} | ${r.conf.toFixed(1)} | ${r.script} |`);
fs.writeFileSync(path.join(out, 'report-osd.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
