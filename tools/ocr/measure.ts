/**
 * Measures in-browser OCR (tesseract.js) for a "Make this scan searchable" feature.
 * Not part of the app: tesseract.js lives in tools/ocr/node_modules (its own package),
 * language data in tools/ocr/models/ (setup: `npm run ocr:setup`).
 * Output goes to /home/garrett/pdf-survey/out-ocr/ (or --out DIR; never inside the repo).
 * Survey files are untrusted: read only, in child processes with a memory cap and a timeout.
 *
 *   npm run ocr:measure -- sample                 # dev + held-out samples of born-digital pages → <out>/synth-sample.json
 *   npm run ocr:measure -- synth --set dev|hold   # render, degrade, OCR → <out>/results/synth-<set>.jsonl (resumable)
 *   npm run ocr:measure -- report                 # → <out>/report-synth.md (+ gates, tables)
 *
 * Other steps (real scans, browser, layer) live in their own scripts in this folder.
 * Options: --out DIR, --workers 4 (at most 4), --mem-mb 2500, --timeout 600 (s), --limit N, --models fast,best_int.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJsonl, repoRoot, type Args } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import type { Cond, SynthJob, SynthResult } from './synth-worker';
import { report } from './report';

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
	damage: string;
	content?: { textPages: number; imageOnlyPages: number; textOverImagePages: number };
}

/** Not English, scans, maps, and PDF-library test suites (odd by design). */
const EXCLUDED = new Set(['un-multilingual', 'archive-org-scans', 'usgs-topo', 'pdfjs-test', 'pdfium-tests', 'qpdf-tests', 'verapdf-corpus', 'pdfjs-links']);
/** [dev, held-out] files per source; form sources get fewer so letters, reports and tables are not crowded out. */
const CAP: Record<string, [number, number]> = { govdocs1: [14, 70], 'irs-forms': [5, 12], 'uscis-forms': [4, 12], 'gsa-forms': [4, 12], 'state-forms': [4, 12], 'uscourts-forms': [4, 12], 'intl-forms': [4, 12] };

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

interface SampleFile {
	sha256: string;
	path: string;
	source: string;
	pages: number[];
}

function sampleCommand(args: Args, out: string) {
	const profiles = readJsonl<Profile>(path.join(PILE, 'out-baseline-2026-11-10/profiles.jsonl'));
	const rnd = rng(args.num('seed', 20261112));
	const ok = profiles.filter(
		(p) =>
			p.status === 'ok' &&
			(p.encryption === 'none' || !p.encryption) &&
			p.damage === 'clean' &&
			(p.content?.textPages ?? 0) > 0 &&
			(p.content?.imageOnlyPages ?? 0) === 0 &&
			!EXCLUDED.has(p.source) &&
			p.size <= 30e6 &&
			fs.existsSync(p.path)
	);
	const bySource = new Map<string, Profile[]>();
	for (const p of ok.sort(() => rnd() - 0.5)) bySource.set(p.source, [...(bySource.get(p.source) ?? []), p]);
	const take = (which: 0 | 1, extra: number) => {
		const picked: SampleFile[] = [];
		for (const [src, list] of bySource) {
			const cap = CAP[src]?.[which] ?? (which === 0 ? 5 : extra);
			for (const p of list.splice(0, cap)) {
				const n = Math.min(p.pages, 8);
				const pages = [...Array(n).keys()].sort(() => rnd() - 0.5);
				picked.push({ sha256: p.sha256, path: p.path, source: p.source, pages });
			}
		}
		return picked;
	};
	const dev = take(0, 5);
	const hold = take(1, 18);
	fs.writeFileSync(path.join(out, 'synth-sample.json'), JSON.stringify({ seed: args.num('seed', 20261112), dev, hold }, null, 1));
	const count = (fs: SampleFile[]) => {
		const m = new Map<string, number>();
		for (const f of fs) m.set(f.source, (m.get(f.source) ?? 0) + 1);
		return [...m].map(([k, v]) => `${k} ${v}`).join(', ');
	};
	console.log(`candidates ${ok.length}; dev ${dev.length} files (${count(dev)}); held-out ${hold.length} files (${count(hold)})`);
}

/**
 * Dev: a wide grid to choose the model, the binarisation and whether to enlarge 150/200 dpi
 * images to 300 before OCR. Held-out: the chosen setting (`fast`, `th`, enlarge) on every
 * condition, with best_int and best on the scan condition for comparison.
 */
export function conditions(set: 'dev' | 'hold', th: number): Cond[] {
	const c: Cond[] = [];
	if (set === 'dev') {
		// Round 1 (results/synth-v1-noskew-dev.jsonl, no deskew) showed skew of 1.5–2° losing whole lines;
		// round 2 deskews everywhere and compares binarisation (0 Otsu, 2 Sauvola), enlarging, and models.
		c.push({ dpi: 300, deg: 'clean', models: ['fast'] });
		for (const th of [0, 2]) for (const up of [false, true]) c.push({ dpi: 150, deg: 'scan', th, up, models: ['fast'] });
		c.push({ dpi: 200, deg: 'scan', models: ['fast'] }, { dpi: 200, deg: 'scan', up: true, models: ['fast', 'best_int'] }, { dpi: 200, deg: 'scan', up: true, th: 2, models: ['fast'] });
		c.push({ dpi: 300, deg: 'scan', models: ['fast', 'best_int', 'best'] }, { dpi: 300, deg: 'scan', th: 2, models: ['fast'] });
		c.push({ dpi: 300, deg: 'scan', deskew: false, models: ['fast'] });
		for (const up of [false, true]) c.push({ dpi: 150, deg: 'bitonal', up, models: ['fast'] });
		c.push({ dpi: 200, deg: 'bitonal', models: ['fast'] }, { dpi: 300, deg: 'bitonal', models: ['fast'] });
		for (const th of [0, 2]) c.push({ dpi: 200, deg: 'phone', up: true, th, models: ['fast'] });
		c.push({ dpi: 200, deg: 'fax', models: ['fast'] });
		return c;
	}
	for (const dpi of [150, 200, 300])
		for (const deg of ['clean', 'scan', 'bitonal'] as const) c.push({ dpi, deg, th, up: dpi < 300, models: deg === 'scan' ? ['fast', 'best_int'] : ['fast'] });
	c.push({ dpi: 300, deg: 'scan', th, models: ['best'] });
	c.push({ dpi: 200, deg: 'phone', th, up: true, models: ['fast'] }, { dpi: 200, deg: 'fax', th, up: true, models: ['fast'] });
	// Native (not enlarged) 150/200 for the resolution question.
	for (const dpi of [150, 200]) c.push({ dpi, deg: 'scan', th, models: ['fast'] });
	return c;
}

async function synthCommand(args: Args, out: string) {
	const set = (args.get('set') ?? 'dev') as 'dev' | 'hold';
	const sample = JSON.parse(fs.readFileSync(path.join(out, 'synth-sample.json'), 'utf8')) as { dev: SampleFile[]; hold: SampleFile[] };
	const bench = args.flag('bench-images');
	// --bench-images: only write images for the browser benchmark (no OCR).
	const conds: Cond[] = bench
		? [150, 200, 300].flatMap((dpi) => [{ dpi, deg: 'scan' as const, models: [] }, ...(dpi < 300 ? [{ dpi, deg: 'scan' as const, up: true, models: [] }] : [])])
		: conditions(set, args.num('th', 0));
	const resDir = path.join(out, 'results');
	fs.mkdirSync(resDir, { recursive: true });
	const resFile = path.join(resDir, bench ? `bench-images-${set}.jsonl` : `synth-${set}.jsonl`);
	const done = new Set(readJsonl<{ sha256: string }>(resFile).map((r) => r.sha256));
	let jobs: SynthJob[] = sample[set]
		.filter((f) => !done.has(f.sha256))
		.map((f) => ({ sha256: f.sha256, path: f.path, source: f.source, set, pages: f.pages, want: args.num('want', 2), conds, pngDir: bench ? path.join(out, 'png', 'bench') : undefined }));
	jobs = jobs.slice(0, args.num('limit', Infinity));
	console.log(`synth ${set}: ${jobs.length} files, ${conds.length} conditions → ${resFile}`);
	const t0 = Date.now();
	let n = 0;
	await runPool<SynthJob, SynthResult>(jobs, {
		script: path.join(here, 'synth-worker.ts'),
		workers: Math.min(4, args.num('workers', 4)),
		memMB: args.num('mem-mb', 2500),
		timeoutMs: args.num('timeout', 600) * 1000,
		recycleAfter: 3,
		onResult: (_j, r) => fs.appendFileSync(resFile, JSON.stringify(r) + '\n'),
		onDone: () => {
			n++;
			console.log(`  ${n}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail, lastStep) => {
			fs.appendFileSync(resFile, JSON.stringify({ sha256: job.sha256, pages: [], tried: 0, rejected: {}, error: `${kind}: ${detail}`, lastStep }) + '\n');
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

function outDir(args: Args): string {
	const dir = path.resolve(args.get('out') ?? path.join(PILE, 'out-ocr'));
	const rel = path.relative(repoRoot, dir);
	if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`Output must not go inside the repo (${dir}).`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

const [step, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const out = outDir(args);
switch (step) {
	case 'sample':
		sampleCommand(args, out);
		break;
	case 'synth':
		await synthCommand(args, out);
		break;
	case 'report':
		report(args, out);
		break;
	default:
		console.error('usage: measure.ts <sample|synth|report> [options]');
		process.exit(2);
}
