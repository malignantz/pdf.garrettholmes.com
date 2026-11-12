/**
 * Real scans from the survey pile (output under /home/garrett/pdf-survey/out-ocr/, never the repo).
 *
 *   npm run ocr:scans -- inventory      # what each page of files with pictures is made of → results/scan-inventory.jsonl
 *   npm run ocr:scans -- pick           # pages for (b) scans with an OCR layer (dev/held-out) and (c) scans without text → scan-sample.json
 *   npm run ocr:scans -- ocr --part b|c [--set dev|hold]   # OCR them → results/scan-<part>-<set>.jsonl
 *   npm run ocr:scans -- report         # → report-scans.md (agreement with existing layers, gate, page classes)
 *
 * Options: --out DIR, --workers 2, --th 0, --models fast.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJsonl, repoRoot, type Args } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import type { PageInv, ScanJob, ScanResult } from './scan-worker';
import { addScore, emptyScore, scorePage, signals, type Score } from './lib/score';
import { accept, GATE_HEAD, pct, quant, type Gate } from './report';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';

interface Profile {
	sha256: string;
	path: string;
	source: string;
	size: number;
	status: string;
	pages: number;
	encryption: string;
	content?: { imageOnlyPages: number; textOverImagePages: number; pagesSampled: number; textPages: number };
	form?: { signed: boolean };
}

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

async function pool(args: Args, jobs: ScanJob[], file: string) {
	const t0 = Date.now();
	let n = 0;
	await runPool<ScanJob, ScanResult>(jobs, {
		script: path.join(here, 'scan-worker.ts'),
		workers: Math.min(4, args.num('workers', 2)),
		memMB: 2500,
		timeoutMs: 600_000,
		recycleAfter: 10,
		onResult: (_j, r) => fs.appendFileSync(file, JSON.stringify(r) + '\n'),
		onDone: () => {
			if (++n % 20 === 0) console.log(`  ${n}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail) => {
			fs.appendFileSync(file, JSON.stringify({ sha256: job.sha256, source: job.source, pageCount: 0, error: `${kind}: ${detail}` }) + '\n');
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

async function inventoryCommand(args: Args, out: string) {
	const profiles = readJsonl<Profile>(path.join(PILE, 'out-baseline-2026-11-10/profiles.jsonl'));
	const file = path.join(out, 'results', 'scan-inventory.jsonl');
	const done = new Set(readJsonl<{ sha256: string }>(file).map((r) => r.sha256));
	const jobs: ScanJob[] = profiles
		.filter((p) => p.status === 'ok' && (p.encryption === 'none' || !p.encryption) && ((p.content?.imageOnlyPages ?? 0) > 0 || (p.content?.textOverImagePages ?? 0) > 0) && !done.has(p.sha256) && fs.existsSync(p.path))
		.map((p) => ({ sha256: p.sha256, path: p.path, source: p.source, mode: 'inventory', maxPages: 12 }));
	console.log(`inventory: ${jobs.length} files → ${file}`);
	await pool(args, jobs, file);
}

export type PageClass = 'ocr-layer' | 'image-only' | 'mixed' | 'picture-page' | 'other';

/** What a page is, for the feature: a scan with a text layer, a bare scan, a scan with some real text, ... */
export function classify(p: PageInv): PageClass {
	if (p.cover < 0) return 'other';
	if (p.cover >= 0.85) {
		if (p.visible >= 5) return 'mixed';
		if (p.invisible + p.hidden >= 20) return 'ocr-layer';
		if (p.visible + p.invisible + p.hidden < 5) return 'image-only';
		return 'mixed';
	}
	if (p.cover >= 0.4) return p.visible >= 5 ? 'mixed' : 'picture-page';
	return 'other';
}

interface PickedPage {
	sha256: string;
	path: string;
	source: string;
	page: number;
}

function pickCommand(args: Args, out: string) {
	const rnd = rng(args.num('seed', 20261112));
	const inv = readJsonl<ScanResult>(path.join(out, 'results', 'scan-inventory.jsonl')).filter((r) => r.inv);
	const profiles = new Map(readJsonl<Profile>(path.join(PILE, 'out-baseline-2026-11-10/profiles.jsonl')).map((p) => [p.sha256, p]));
	const byClass = (c: PageClass) =>
		inv
			.map((r) => ({ r, pages: r.inv!.filter((p) => classify(p) === c && p.ppi >= 100) }))
			.filter((x) => x.pages.length)
			.sort(() => rnd() - 0.5);
	// (b) up to three pages per file, files split between dev and held-out; at most 25 files per source.
	const b = byClass('ocr-layer');
	const perSrc = new Map<string, number>();
	const dev: PickedPage[] = [];
	const hold: PickedPage[] = [];
	let k = 0;
	for (const { r, pages } of b) {
		if ((perSrc.get(r.source) ?? 0) >= 25) continue;
		perSrc.set(r.source, (perSrc.get(r.source) ?? 0) + 1);
		const ps = pages.sort(() => rnd() - 0.5).slice(0, 3);
		const target = k++ % 3 === 0 ? dev : hold;
		for (const p of ps) target.push({ sha256: r.sha256, path: profiles.get(r.sha256)!.path, source: r.source, page: p.i });
	}
	// (c) image-only pages: up to 3 per file, at most 10 files per source; graded by eye later (only those with text).
	const c: PickedPage[] = [];
	const perSrcC = new Map<string, number>();
	for (const { r, pages } of byClass('image-only')) {
		if ((perSrcC.get(r.source) ?? 0) >= 10) continue;
		perSrcC.set(r.source, (perSrcC.get(r.source) ?? 0) + 1);
		for (const p of pages.sort(() => rnd() - 0.5).slice(0, 2)) c.push({ sha256: r.sha256, path: profiles.get(r.sha256)!.path, source: r.source, page: p.i });
	}
	fs.writeFileSync(path.join(out, 'scan-sample.json'), JSON.stringify({ b: { dev, hold }, c }, null, 1));
	console.log(`(b) dev ${dev.length} pages, held-out ${hold.length} pages; (c) ${c.length} candidate pages`);
}

async function ocrCommand(args: Args, out: string) {
	const part = args.get('part') ?? 'b';
	const set = args.get('set') ?? 'dev';
	const sample = JSON.parse(fs.readFileSync(path.join(out, 'scan-sample.json'), 'utf8'));
	const pages: PickedPage[] = part === 'b' ? sample.b[set] : sample.c;
	const file = path.join(out, 'results', part === 'b' ? `scan-b-${set}.jsonl` : 'scan-c.jsonl');
	const done = new Set(readJsonl<{ sha256: string }>(file).map((r) => r.sha256));
	const byFile = new Map<string, PickedPage[]>();
	for (const p of pages) if (!done.has(p.sha256)) byFile.set(p.sha256, [...(byFile.get(p.sha256) ?? []), p]);
	const jobs: ScanJob[] = [...byFile.values()].map((ps) => ({
		sha256: ps[0].sha256,
		path: ps[0].path,
		source: ps[0].source,
		mode: 'ocr',
		pages: ps.map((p) => p.page),
		models: (args.get('models') ?? 'fast').split(',') as ScanJob['models'],
		th: args.num('th', 0),
		deskew: !args.flag('no-deskew'),
		pngDir: part === 'c' ? path.join(out, 'png', 'c') : undefined
	}));
	console.log(`ocr (${part}, ${set}): ${jobs.length} files → ${file}`);
	await pool(args, jobs, file);
}

function reportCommand(args: Args, out: string) {
	const L: string[] = ['# Real scans', ''];
	// Page classes over the inventory.
	const inv = readJsonl<ScanResult>(path.join(out, 'results', 'scan-inventory.jsonl'));
	const pages = inv.flatMap((r) => (r.inv ?? []).map((p) => ({ ...p, source: r.source, signed: !!r.signed, sha: r.sha256 })));
	const cls = new Map<string, typeof pages>();
	for (const p of pages) cls.set(classify(p), [...(cls.get(classify(p)) ?? []), p]);
	L.push(`## Page classes (first 12 pages of ${inv.length} files with pictures; ${pages.length} pages)`, '', `| class | pages | files | rotated (/Rotate ≠ 0) | picture < 150 ppi | 150–250 ppi | 250–350 | > 350 | 1-bit | > 25 MP |`, `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
	for (const [c, ps] of [...cls].sort((a, b) => b[1].length - a[1].length)) {
		L.push(`| ${c} | ${ps.length} | ${new Set(ps.map((p) => p.sha)).size} | ${ps.filter((p) => p.rotate % 360 !== 0).length} | ${ps.filter((p) => p.ppi < 150).length} | ${ps.filter((p) => p.ppi >= 150 && p.ppi < 250).length} | ${ps.filter((p) => p.ppi >= 250 && p.ppi < 350).length} | ${ps.filter((p) => p.ppi >= 350).length} | ${ps.filter((p) => p.bits === 1).length} | ${ps.filter((p) => p.mpx > 25).length} |`);
	}
	L.push('', `Signed files among them: ${new Set(pages.filter((p) => p.signed).map((p) => p.sha)).size}. Landscape pages (displayed width > height) among scan pages: ${pages.filter((p) => ['ocr-layer', 'image-only', 'mixed'].includes(classify(p)) && ((p.rotate % 180 === 0 ? p.W > p.H : p.H > p.W))).length}.`, '');
	// (b) agreement with existing layers.
	const gate: Gate | null = args.get('gate') ? JSON.parse(args.get('gate')!) : null;
	for (const set of ['dev', 'hold']) {
		const f = path.join(out, 'results', `scan-b-${set}.jsonl`);
		if (!fs.existsSync(f)) continue;
		const rows: { s: Score; sig: ReturnType<typeof signals>; src: string; ppi: number; bits: number; ms: number; model: string }[] = [];
		for (const r of readJsonl<ScanResult>(f))
			for (const p of r.ocr ?? [])
				for (const run of p.runs) {
					if (p.layer.length < 20) continue;
					const k = p.dpi / 72;
					const { score } = scorePage(p.layer, run.words, [k, 0, 0, k, 0, 0]);
					rows.push({ s: score, sig: signals(run.words), src: r.source, ppi: p.inv.ppi, bits: p.inv.bits, ms: run.ms, model: run.model });
				}
		const line = (label: string, rs: typeof rows) => {
			const s = rs.reduce((a, r) => addScore(a, r.s), emptyScore());
			const low = rs.filter((r) => r.s.ex / Math.max(1, r.s.nT) < 0.85).length;
			return `| ${label} | ${rs.length} | ${pct(s.ex, s.nT)} | ${pct(s.e1, s.nT)} | ${pct(s.nO - s.ex, s.nO)} | ${pct(s.ce, s.ch)} | ${pct(low, rs.length)} | ${(quant(rs.map((r) => r.ms), 0.5) / 1000).toFixed(1)} |`;
		};
		L.push(`## (b) Agreement with the existing OCR layer, ${set} (a proxy: the old layer is not truth)`, '', `| | pages | layer words found exactly | within 1 edit | our words not in the layer | CER vs layer | pages < 85% agreement | s/page |`, `|---|---:|---:|---:|---:|---:|---:|---:|`);
		for (const m of new Set(rows.map((r) => r.model))) {
			const rm = rows.filter((r) => r.model === m);
			L.push(line(`${m}, all`, rm));
			for (const src of new Set(rm.map((r) => r.src))) L.push(line(`${m}, ${src}`, rm.filter((r) => r.src === src)));
			L.push(line(`${m}, picture < 200 ppi`, rm.filter((r) => r.ppi < 200)));
			L.push(line(`${m}, picture ≥ 200 ppi`, rm.filter((r) => r.ppi >= 200)));
			L.push(line(`${m}, 1-bit`, rm.filter((r) => r.bits === 1)));
			if (gate) {
				const acc = rm.filter((r) => accept(gate, r.sig));
				L.push(line(`${m}, accepted by the gate (${pct(acc.length, rm.length)})`, acc));
				L.push(line(`${m}, declined by the gate`, rm.filter((r) => !accept(gate, r.sig))));
			}
		}
		L.push('');
	}
	void GATE_HEAD;
	fs.writeFileSync(path.join(out, 'report-scans.md'), L.join('\n') + '\n');
	console.log(L.join('\n'));
}

function outDir(args: Args): string {
	const dir = path.resolve(args.get('out') ?? path.join(PILE, 'out-ocr'));
	const rel = path.relative(repoRoot, dir);
	if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`Output must not go inside the repo (${dir}).`);
	fs.mkdirSync(path.join(dir, 'results'), { recursive: true });
	return dir;
}

const [step, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const out = outDir(args);
switch (step) {
	case 'inventory':
		await inventoryCommand(args, out);
		break;
	case 'pick':
		pickCommand(args, out);
		break;
	case 'ocr':
		await ocrCommand(args, out);
		break;
	case 'report':
		reportCommand(args, out);
		break;
	default:
		console.error('usage: scans.ts <inventory|pick|ocr|report> [options]');
		process.exit(2);
}
