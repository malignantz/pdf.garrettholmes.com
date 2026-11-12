/**
 * Measures tap-to-snap (src/lib/engine/forms-snap.ts) against real AcroForm widgets,
 * on the samples of the blank detector's measurement (tools/forms-detect/), so the
 * numbers are comparable. Output goes to /home/garrett/pdf-survey/out-forms-snap/
 * (or --out DIR; never inside the repo).
 *
 *   npm run forms:snap -- ink --sample S.json     # page ink + truth → <out>/ink/*.json.gz (MuPDF, pool)
 *   npm run forms:snap -- run                     # simulated taps on the cache → report.md, report.json, taps.jsonl.gz
 *   npm run forms:snap -- render --files L        # PNGs of failing taps (L: lines "sha:page" from fails.tsv)
 *
 * Options: --out DIR, --sample FILE (ink: copied to <out>/sample.json), --max-pages 6
 * (forms; non-forms 3), --workers 3 (at most 3), --mem-mb 1500, --timeout 120 (s),
 * --seed 1, --limit N, --fresh (ink: collect again).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, repoRoot, type Args } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import { loadSample } from './sample';
import type { DrawMark, InkSummary, SnapJob } from './worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';

async function pool(args: Args, jobs: SnapJob[]) {
	const workers = Math.min(3, args.num('workers', 3));
	const t0 = Date.now();
	let n = 0;
	await runPool<SnapJob, InkSummary>(jobs, {
		script: path.join(here, 'worker.ts'),
		workers,
		memMB: args.num('mem-mb', 1500),
		timeoutMs: args.num('timeout', 120) * 1000,
		recycleAfter: 20,
		onResult: () => undefined,
		onDone: () => {
			if (++n % 25 === 0) console.log(`  ${n}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail) => {
			if (job.inkDir) fs.writeFileSync(path.join(job.inkDir, `${job.sha256}.failed`), `${kind}: ${detail}\n`);
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

async function inkCommand(args: Args, out: string) {
	const src = args.get('sample');
	if (src) fs.copyFileSync(src, path.join(out, 'sample.json'));
	const files = loadSample(out);
	const inkDir = path.join(out, 'ink');
	fs.mkdirSync(inkDir, { recursive: true });
	const maxPages = args.num('max-pages', 6);
	let jobs: SnapJob[] = files
		.filter((f) => args.flag('fresh') || (!fs.existsSync(path.join(inkDir, `${f.sha256}.json.gz`)) && !fs.existsSync(path.join(inkDir, `${f.sha256}.failed`))))
		.map((f) => ({ sha256: f.sha256, path: f.path, maxPages: f.group === 'form' ? maxPages : 3, inkDir }));
	jobs = jobs.slice(0, args.num('limit', Infinity));
	console.log(`ink: ${jobs.length} files → ${inkDir}`);
	await pool(args, jobs);
}

async function renderCommand(args: Args, out: string) {
	const files = loadSample(out);
	const marksFile = args.get('marks') ?? path.join(out, 'marks.json');
	const marks = JSON.parse(fs.readFileSync(marksFile, 'utf8')) as Record<string, Record<number, DrawMark[]>>;
	const list = fs.readFileSync(args.get('files') ?? '', 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
	const pngDir = path.join(out, args.get('png') ?? 'png');
	const want = new Map<string, Record<number, DrawMark[]>>();
	for (const l of list) {
		const [sha, pg] = l.split(/[:\t]/);
		const f = files.find((x) => x.sha256.startsWith(sha));
		if (!f) continue;
		const i = Number(pg) - 1;
		const m = want.get(f.sha256) ?? {};
		m[i] = marks[f.sha256]?.[i] ?? [];
		want.set(f.sha256, m);
	}
	const jobs: SnapJob[] = [...want].map(([sha, render]) => ({ sha256: sha, path: files.find((x) => x.sha256 === sha)!.path, maxPages: 99, render, pngDir }));
	console.log(`render: ${jobs.length} files → ${pngDir}`);
	await pool(args, jobs);
}

function outDir(args: Args): string {
	const dir = path.resolve(args.get('out') ?? path.join(PILE, 'out-forms-snap'));
	const rel = path.relative(repoRoot, dir);
	if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`Output must not go inside the repo (${dir}).`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

const [step, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const out = outDir(args);
switch (step) {
	case 'ink':
		await inkCommand(args, out);
		break;
	case 'run':
		await (await import('./evaluate')).evaluate(args, out);
		break;
	case 'render':
		await renderCommand(args, out);
		break;
	default:
		console.error('usage: measure.ts <ink|run|render> [options]');
		process.exit(2);
}
