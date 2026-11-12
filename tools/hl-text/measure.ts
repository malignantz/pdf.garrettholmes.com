/**
 * Measures the text highlighter's rectangles against rendered ink on real PDFs from
 * the survey pile (see worker.ts for the method). Output goes to
 * /home/garrett/pdf-survey/out-hl-text/ (or --out DIR; never inside the repo).
 * Files in the pile are untrusted: they are only read, in child processes with a
 * memory cap and a timeout, and never copied.
 *
 *   npm run hltext:measure -- sample            # stratified sample of text PDFs → <out>/sample.json
 *   npm run hltext:measure -- run               # measure → <out>/results.jsonl (resumable)
 *   npm run hltext:measure -- report            # → <out>/report.md, <out>/fails.tsv
 *   npm run hltext:measure -- render --files L  # PNGs of ranges (L: lines "sha<TAB>page<TAB>a<TAB>b", e.g. from fails.tsv)
 *
 * Options: --out DIR, --size 150, --seed 1, --exclude S.json (sample), --pages 3, --ranges 12, --workers 3 (at
 * most 3), --mem-mb 1500, --timeout 180 (s), --limit N, --profiles FILE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJsonl, repoRoot, type Args } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import type { HlJob, HlResult, RangeResult } from './worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';

interface Profile {
	sha256: string;
	path: string;
	source: string;
	size: number;
	status: string;
	producer: string | null;
	producerFamily: string;
	pages: number;
	encryption: string;
	damage: string;
	content?: { textPages: number; imageOnlyPages: number; textOverImagePages: number; pagesSampled: number };
	fonts?: { type3: number };
}

interface SampleFile {
	sha256: string;
	path: string;
	source: string;
	producer: string;
	family: string;
	ocr: boolean;
	type3: boolean;
}

/** PDF library test suites: few files each, so they do not dominate. */
const TEST_SUITES = new Set(['pdfjs-test', 'pdfium-tests', 'qpdf-tests', 'verapdf-corpus', 'pdfjs-links']);

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

function sampleCommand(args: Args, out: string) {
	const profiles = readJsonl<Profile>(args.get('profiles') ?? path.join(PILE, 'out-baseline-2026-11-10/profiles.jsonl'));
	const size = args.num('size', 150);
	const rnd = rng(args.num('seed', 1));
	// --exclude S.json: leave out the files of another sample (a held-out sample).
	const ex = args.get('exclude');
	const excluded = new Set(ex ? (JSON.parse(fs.readFileSync(ex, 'utf8')) as { files: SampleFile[] }).files.map((f) => f.sha256) : []);
	const ok = profiles.filter(
		(p) =>
			p.status === 'ok' &&
			(p.encryption === 'none' || !p.encryption) &&
			p.damage === 'clean' &&
			(p.content?.textPages ?? 0) > 0 &&
			p.size <= 60 * 1024 * 1024 &&
			!excluded.has(p.sha256) &&
			fs.existsSync(p.path)
	);
	// Source → family → files, shuffled.
	const bySource = new Map<string, Map<string, Profile[]>>();
	for (const p of ok.sort(() => rnd() - 0.5)) {
		const fam = bySource.get(p.source) ?? new Map<string, Profile[]>();
		const list = fam.get(p.producerFamily) ?? [];
		list.push(p);
		fam.set(p.producerFamily, list);
		bySource.set(p.source, fam);
	}
	const taken = new Map<string, number>();
	const picked: Profile[] = [];
	const cap = (s: string) => (TEST_SUITES.has(s) ? 6 : 15);
	let progress = true;
	while (picked.length < size && progress) {
		progress = false;
		for (const [src, fams] of [...bySource].sort(() => rnd() - 0.5)) {
			if (picked.length >= size) break;
			if ((taken.get(src) ?? 0) >= cap(src)) continue;
			// Round-robin over producer families inside the source.
			const famList = [...fams.values()].filter((l) => l.length);
			if (!famList.length) continue;
			famList.sort((a, b) => b.length - a.length);
			const k = (taken.get(src) ?? 0) % famList.length;
			const p = famList[k].shift()!;
			picked.push(p);
			taken.set(src, (taken.get(src) ?? 0) + 1);
			progress = true;
		}
	}
	const files: SampleFile[] = picked.map((p) => ({
		sha256: p.sha256,
		path: p.path,
		source: p.source,
		producer: p.producer ?? '',
		family: p.producerFamily,
		ocr: (p.content?.textOverImagePages ?? 0) > 0,
		type3: (p.fonts?.type3 ?? 0) > 0
	}));
	fs.writeFileSync(path.join(out, 'sample.json'), JSON.stringify({ seed: args.num('seed', 1), files }, null, 1));
	const count = (f: (x: SampleFile) => string) => {
		const m = new Map<string, number>();
		for (const x of files) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
		return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
	};
	console.log(`sample: ${files.length} files of ${ok.length} candidates`);
	console.log(`sources: ${count((x) => x.source)}`);
	console.log(`families: ${count((x) => x.family)}`);
}

function loadSample(out: string): SampleFile[] {
	return (JSON.parse(fs.readFileSync(path.join(out, 'sample.json'), 'utf8')) as { files: SampleFile[] }).files;
}

async function pool(args: Args, jobs: HlJob[], onResult: (job: HlJob, r: HlResult) => void, onFail: (job: HlJob, why: string) => void) {
	const t0 = Date.now();
	let n = 0;
	await runPool<HlJob, HlResult>(jobs, {
		script: path.join(here, 'worker.ts'),
		workers: Math.min(3, args.num('workers', 3)),
		memMB: args.num('mem-mb', 1500),
		timeoutMs: args.num('timeout', 180) * 1000,
		recycleAfter: 10,
		onResult,
		onDone: () => {
			if (++n % 10 === 0) console.log(`  ${n}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail) => {
			onFail(job, `${kind}: ${detail}`);
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

async function runCommand(args: Args, out: string) {
	const files = loadSample(out);
	const resFile = path.join(out, 'results.jsonl');
	const done = new Set(readJsonl<{ sha256: string }>(resFile).map((r) => r.sha256));
	let jobs: HlJob[] = files
		.filter((f) => !done.has(f.sha256))
		.map((f) => ({ sha256: f.sha256, path: f.path, maxPages: args.num('pages', 3), seed: args.num('seed', 1), rangesPerPage: args.num('ranges', 12) }));
	jobs = jobs.slice(0, args.num('limit', Infinity));
	console.log(`run: ${jobs.length} files → ${resFile}`);
	const append = (r: object) => fs.appendFileSync(resFile, JSON.stringify(r) + '\n');
	await pool(args, jobs, (_j, r) => append(r), (j, why) => append({ sha256: j.sha256, pageCount: 0, pages: [], error: why }));
}

async function renderCommand(args: Args, out: string) {
	const files = loadSample(out);
	const list = fs.readFileSync(args.get('files') ?? '', 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
	const want = new Map<string, Record<number, [number, number][]>>();
	for (const l of list) {
		const [sha, pg, a, b] = l.split(/\t/);
		const f = files.find((x) => x.sha256.startsWith(sha));
		if (!f) continue;
		const m = want.get(f.sha256) ?? {};
		(m[Number(pg) - 1] ??= []).push([Number(a), Number(b)]);
		want.set(f.sha256, m);
	}
	const pngDir = path.join(out, 'png');
	const jobs: HlJob[] = [...want].map(([sha, render]) => ({
		sha256: sha,
		path: files.find((x) => x.sha256 === sha)!.path,
		maxPages: Math.max(...Object.keys(render).map(Number)) + 1,
		seed: 0,
		rangesPerPage: 0,
		render,
		pngDir
	}));
	console.log(`render: ${jobs.length} files → ${pngDir}`);
	await pool(args, jobs, () => undefined, (j, why) => console.log(`failed ${j.sha256.slice(0, 12)}: ${why}`));
}

// ---------------------------------------------------------------- report

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
const quant = (v: number[], q: number) => {
	if (!v.length) return 0;
	const s = [...v].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
/** Flood bar: other ink reaching more than this share of the line height into a rectangle. */
const FLOOD = 0.15;

function reportCommand(_args: Args, out: string) {
	const files = loadSample(out);
	const meta = new Map(files.map((f) => [f.sha256, f]));
	const results = readJsonl<HlResult>(path.join(out, 'results.jsonl'));
	const lines: string[] = [];
	const fails: string[] = [];
	let filesOk = 0;
	let filesErr = 0;
	let pages = 0;
	let textPages = 0;
	let pageErr = 0;
	const ms: number[] = [];
	const rss: number[] = [];
	const wordsPerPage: number[] = [];
	let skippedChars = 0;
	let allChars = 0;
	let pagesWithSkipped = 0;
	let invisibleWords = 0;
	let wordsTotal = 0;
	const all: (RangeResult & { sha: string; page: number })[] = [];
	for (const r of results) {
		if (r.error || r.encrypted) {
			filesErr++;
			continue;
		}
		filesOk++;
		for (const p of r.pages) {
			pages++;
			if (p.error) {
				pageErr++;
				continue;
			}
			ms.push(p.ms);
			rss.push(p.rssKB);
			skippedChars += p.skipped;
			allChars += p.chars;
			if (p.skipped > 0) pagesWithSkipped++;
			if (p.words > 0) {
				textPages++;
				wordsPerPage.push(p.words);
				invisibleWords += p.invisibleWords;
				wordsTotal += p.words;
			}
			for (const rr of p.ranges) all.push({ ...rr, sha: r.sha256, page: p.i + 1 });
		}
	}
	const inked = all.filter((r) => r.ink > 0);
	const miss = inked.filter((r) => r.missPx > 0);
	const flood = inked.filter((r) => r.flood > FLOOD);
	const floodAcross = flood.filter((r) => r.floodDir === 'across');
	const floodAlong = flood.filter((r) => r.floodDir === 'along');
	const either = inked.filter((r) => r.missPx > 0 || r.flood > FLOOD);
	for (const r of either) fails.push([r.sha.slice(0, 16), r.page, r.a, r.b, r.missPx > 0 ? 'miss' : 'flood', r.missPt, r.flood, r.floodDir ?? '', meta.get(r.sha)?.source ?? '', meta.get(r.sha)?.family ?? ''].join('\t'));

	const singles = inked.filter((r) => r.a === r.b);
	const pj = singles.filter((r) => r.pdfjs);
	const pjMiss = pj.filter((r) => r.pdfjs!.missPx > 0);
	const pjFlood = pj.filter((r) => r.pdfjs!.flood > FLOOD);
	const ourMissOnPj = pj.filter((r) => r.missPx > 0);
	const ourFloodOnPj = pj.filter((r) => r.flood > FLOOD);
	const edgeErr = (d: { dx0: number; dx1: number }) => Math.max(Math.abs(d.dx0), Math.abs(d.dx1));
	const ourEdge = singles.filter((r) => r.edge).map((r) => edgeErr(r.edge!));
	const ourEdgeRel = singles.filter((r) => r.edge && r.em > 0).map((r) => edgeErr(r.edge!) / r.em);
	const pjEdge = pj.map((r) => edgeErr(r.pdfjs!));
	const pjEdgeRel = pj.filter((r) => r.em > 0).map((r) => edgeErr(r.pdfjs!) / r.em);
	const within = (v: number[], rel: number[]) => {
		let n = 0;
		v.forEach((x, i) => {
			if (x <= 1 || rel[i] <= 0.02) n++;
		});
		return pct(n, v.length);
	};

	lines.push(`# Text highlighter: rectangles vs rendered ink`, '');
	lines.push(`Files measured: ${filesOk} (${filesErr} could not be measured). Pages: ${pages} (${pageErr} errors), ${textPages} with words.`, '');
	lines.push(`| | ranges | miss > 1 pt | flood > ${FLOOD * 100}% of line height (across lines / along a line) | either |`);
	lines.push(`|---|---:|---:|---:|---:|`);
	const row = (label: string, rs: typeof inked) => {
		const m = rs.filter((r) => r.missPx > 0).length;
		const f = rs.filter((r) => r.flood > FLOOD);
		const e = rs.filter((r) => r.missPx > 0 || r.flood > FLOOD).length;
		lines.push(`| ${label} | ${rs.length} | ${pct(m, rs.length)} | ${pct(f.length, rs.length)} (${pct(f.filter((r) => r.floodDir === 'across').length, rs.length)} / ${pct(f.filter((r) => r.floodDir === 'along').length, rs.length)}) | ${pct(e, rs.length)} |`);
	};
	row('all ranges with ink', inked);
	row('1 word', inked.filter((r) => r.words === 1));
	row('2–6 words', inked.filter((r) => r.words >= 2 && r.words <= 6));
	row('7–40 words', inked.filter((r) => r.words >= 7));
	row('2+ lines', inked.filter((r) => r.rects >= 2));
	lines.push('', `Ranges without ink (invisible OCR text, or glyphs that draw nothing): ${all.length - inked.length}. Invisible words on measured pages: ${invisibleWords} of ${wordsTotal}.`);
	lines.push('', `Miss distance at p99: ${quant(miss.map((r) => r.missPt), 0.99)} pt (of missing ranges). Flood at p50/p90 of flooding ranges: ${quant(flood.map((r) => r.flood), 0.5)} / ${quant(flood.map((r) => r.flood), 0.9)}.`);
	lines.push('', `## By source`, '', `| source | ranges | miss | flood | either |`, `|---|---:|---:|---:|---:|`);
	const bySrc = new Map<string, typeof inked>();
	for (const r of inked) {
		const s = meta.get(r.sha)?.source ?? '?';
		bySrc.set(s, [...(bySrc.get(s) ?? []), r]);
	}
	for (const [s, rs] of [...bySrc].sort((a, b) => b[1].length - a[1].length))
		lines.push(`| ${s} | ${rs.length} | ${pct(rs.filter((r) => r.missPx > 0).length, rs.length)} | ${pct(rs.filter((r) => r.flood > FLOOD).length, rs.length)} | ${pct(rs.filter((r) => r.missPx > 0 || r.flood > FLOOD).length, rs.length)} |`);
	lines.push('', `## By producer family`, '', `| family | ranges | miss | flood | either |`, `|---|---:|---:|---:|---:|`);
	const byFam = new Map<string, typeof inked>();
	for (const r of inked) {
		const s = meta.get(r.sha)?.family ?? '?';
		byFam.set(s, [...(byFam.get(s) ?? []), r]);
	}
	for (const [s, rs] of [...byFam].sort((a, b) => b[1].length - a[1].length))
		lines.push(`| ${s} | ${rs.length} | ${pct(rs.filter((r) => r.missPx > 0).length, rs.length)} | ${pct(rs.filter((r) => r.flood > FLOOD).length, rs.length)} | ${pct(rs.filter((r) => r.missPx > 0 || r.flood > FLOOD).length, rs.length)} |`);
	lines.push('', `## Text source: MuPDF structured text vs PDF.js text content (single words)`, '');
	lines.push(`Single-word ranges with ink: ${singles.length}; with a PDF.js word of the same text nearby: ${pj.length}.`, '');
	lines.push(`| | MuPDF (ours) | PDF.js items split by character count |`, `|---|---:|---:|`);
	lines.push(`| miss > 1 pt (same ${pj.length} words) | ${pct(ourMissOnPj.length, pj.length)} | ${pct(pjMiss.length, pj.length)} |`);
	lines.push(`| flood > ${FLOOD * 100}% (same words) | ${pct(ourFloodOnPj.length, pj.length)} | ${pct(pjFlood.length, pj.length)} |`);
	lines.push(`| word ends within 1 pt or 2% of the font size of the ink | ${within(ourEdge, ourEdgeRel)} | ${within(pjEdge, pjEdgeRel)} |`);
	lines.push(`| word end error p50 / p90 / p99 (pt) | ${quant(ourEdge, 0.5)} / ${quant(ourEdge, 0.9)} / ${quant(ourEdge, 0.99)} | ${quant(pjEdge, 0.5)} / ${quant(pjEdge, 0.9)} / ${quant(pjEdge, 0.99)} |`);
	lines.push('', `## Collecting a page's words (Node, MuPDF already loaded)`, '');
	lines.push(`Time per page: p50 ${quant(ms, 0.5).toFixed(1)} ms, p90 ${quant(ms, 0.9).toFixed(1)} ms, p99 ${quant(ms, 0.99).toFixed(1)} ms, max ${Math.max(0, ...ms).toFixed(1)} ms.`);
	lines.push(`Resident memory growth while collecting: p50 ${quant(rss, 0.5)} kB, p90 ${quant(rss, 0.9)} kB, max ${Math.max(0, ...rss)} kB.`);
	lines.push(`Words per text page: p50 ${quant(wordsPerPage, 0.5)}, p90 ${quant(wordsPerPage, 0.9)}, max ${Math.max(0, ...wordsPerPage)}.`);
	lines.push(`Characters not offered (tilted runs, glyphs without metrics): ${skippedChars} of ${allChars} (${pct(skippedChars, allChars)}), on ${pagesWithSkipped} pages.`);
	fs.writeFileSync(path.join(out, 'report.md'), lines.join('\n') + '\n');
	fs.writeFileSync(path.join(out, 'fails.tsv'), fails.join('\n') + '\n');
	console.log(lines.join('\n'));
	console.log(`\n${either.length} failing ranges → ${path.join(out, 'fails.tsv')}`);
	void miss;
	void floodAcross;
	void floodAlong;
}

function outDir(args: Args): string {
	const dir = path.resolve(args.get('out') ?? path.join(PILE, 'out-hl-text'));
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
	case 'run':
		await runCommand(args, out);
		break;
	case 'report':
		reportCommand(args, out);
		break;
	case 'render':
		await renderCommand(args, out);
		break;
	default:
		console.error('usage: measure.ts <sample|run|report|render> [options]');
		process.exit(2);
}
