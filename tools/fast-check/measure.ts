/**
 * Measures the export's final check (src/lib/engine/final-check.ts): where its time goes,
 * the fast check against the full `qpdf --check`, and whether they ever disagree.
 *
 *   npm run fastcheck:measure [-- --size 100 --raw 300 --workers 2 --out DIR --only corpus,generated,survey,raw --report-only]
 *   npm run fastcheck:measure -- --only timing   (the survey sample's own check again, one worker, for times)
 *
 * Files:
 *  - corpus: tests/corpus/files/*.pdf (password files with the manifest's password);
 *  - generated: tools/fast-check/gen.ts (260-page scan, 260 photo pages, 1000 text pages,
 *    big DCT/Flate/JPX/CCITT/JBIG2 streams), written outside the repo;
 *  - survey: --size of the largest survey files (2 to 45 MB, opened or partly opened by the
 *    survey profile), round-robin across sources; exported both ways;
 *  - raw: --raw more survey files of any size and state (damaged ones included), round-robin
 *    across sources and damage classes: raw check comparison only.
 * Each survey file goes to the tuning or the held-out half by the first hex digit of its
 * sha256 (even: tuning). Survey files are untrusted data: read only, in child processes
 * with memory and time caps (survey/lib/pool.ts), nothing written next to them or into the repo.
 *
 * Writes results.jsonl (resumable) and measurements.md to /home/garrett/pdf-survey/out-fast-check/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, parseArgs, readJsonl, repoRoot } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import { generate } from './gen';
import { agree } from './agree';
import type { ExportRun, FastJob, FastResult, RawCompare } from './worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';

interface Profile {
	sha256: string;
	path: string;
	source: string;
	size: number;
	status?: string;
	damage?: string;
}

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? path.join(PILE, 'out-fast-check'));
if (!path.relative(repoRoot, out).startsWith('..')) throw new Error('output must be outside the repo');
fs.mkdirSync(out, { recursive: true });
const resFile = path.join(out, 'results.jsonl');
const only = new Set((args.get('only') ?? 'corpus,generated,survey,raw').split(','));
/** Every category's jobs are listed (the report covers them all); `only` picks the ones run. */
const all = new Set(['corpus', 'generated', 'survey', 'raw', 'timing']);

const half = (sha: string): FastJob['half'] => (Number.parseInt(sha[0], 16) % 2 === 0 ? 'tune' : 'held');

function roundRobin<T>(groups: Map<string, T[]>, n: number): T[] {
	const queues = [...groups.values()].map((q) => [...q]);
	const picked: T[] = [];
	while (picked.length < n && queues.some((q) => q.length)) {
		for (const q of queues) {
			if (picked.length >= n) break;
			const x = q.shift();
			if (x) picked.push(x);
		}
	}
	return picked;
}

const jobs: FastJob[] = [];
if (all.has('corpus')) {

	const dir = path.join(repoRoot, 'tests/corpus/files');
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, { password?: string }>;
	for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.pdf')).sort()) {
		jobs.push({ id: `corpus:${f}`, path: path.join(dir, f), kind: 'corpus', source: 'corpus', half: 'tune', fullFirst: jobs.length % 2 === 1, password: manifest[f]?.password });
	}
}
if (all.has('generated')) {

	const files = await generate(path.join(out, 'gen'));
	for (const [n, p] of Object.entries(files)) jobs.push({ id: `generated:${n}`, path: p, kind: 'generated', source: 'generated', half: 'tune', fullFirst: jobs.length % 2 === 1 });
}
const profiles = readJsonl<Profile>(args.get('profiles') ?? path.join(PILE, 'out/profiles.jsonl')).filter((p) => p.path.startsWith(`${PILE}/raw/`) && fs.existsSync(p.path));
const surveyPicked: Profile[] = [];
if (all.has('survey')) {

	const big = profiles.filter((p) => p.size >= 2e6 && p.size <= 45e6 && (p.status === 'ok' || p.status === 'partial')).sort((a, b) => b.size - a.size);
	const bySource = new Map<string, Profile[]>();
	for (const p of big) bySource.set(p.source, [...(bySource.get(p.source) ?? []), p]);
	surveyPicked.push(...roundRobin(bySource, args.num('size', 100)));
	for (const p of surveyPicked) jobs.push({ id: p.sha256, path: p.path, kind: 'survey', source: p.source, half: half(p.sha256), fullFirst: Number.parseInt(p.sha256[1], 16) % 2 === 1 });
}
if (all.has('timing')) {

	// The survey sample again, check of the file as given only, one worker: for times on a quieter box.
	const big = profiles.filter((p) => p.size >= 2e6 && p.size <= 45e6 && (p.status === 'ok' || p.status === 'partial')).sort((a, b) => b.size - a.size);
	const bySource = new Map<string, Profile[]>();
	for (const p of big) bySource.set(p.source, [...(bySource.get(p.source) ?? []), p]);
	for (const p of roundRobin(bySource, args.num('size', 100))) jobs.push({ id: `timing:${p.sha256}`, path: p.path, kind: 'survey', source: p.source, half: half(p.sha256), fullFirst: false, rawOnly: true });
}
if (all.has('raw')) {

	const taken = new Set(surveyPicked.map((p) => p.sha256));
	const rest = profiles.filter((p) => !taken.has(p.sha256) && p.size <= 60e6).sort((a, b) => a.sha256.localeCompare(b.sha256));
	const groups = new Map<string, Profile[]>();
	for (const p of rest) {
		const k = `${p.source}/${p.damage ?? p.status}`;
		groups.set(k, [...(groups.get(k) ?? []), p]);
	}
	for (const p of roundRobin(groups, args.num('raw', 300))) jobs.push({ id: p.sha256, path: p.path, kind: 'survey', source: p.source, half: half(p.sha256), fullFirst: false, rawOnly: true });
}

const catOf = (j: FastJob) => (j.id.startsWith('timing:') ? 'timing' : j.kind === 'survey' ? (j.rawOnly ? 'raw' : 'survey') : j.kind);
const done = new Set(readJsonl<FastResult>(resFile).map((r) => r.id));
const todo = jobs.filter((j) => !done.has(j.id) && only.has(catOf(j)));

if (!args.flag('report-only')) {
	console.log(`${todo.length} of ${jobs.length} jobs to run (${jobs.filter((j) => j.kind === 'corpus').length} corpus, ${jobs.filter((j) => j.kind === 'generated').length} generated, ${jobs.filter((j) => j.kind === 'survey' && !j.rawOnly).length} survey, ${jobs.filter((j) => j.rawOnly).length} raw)`);
	const t0 = Date.now();
	let n = 0;
	// Big files first, so the pool's two workers are not left with one long file at the end.
	todo.sort((a, b) => Number(a.rawOnly ?? false) - Number(b.rawOnly ?? false) || fs.statSync(b.path).size - fs.statSync(a.path).size);
	await runPool<FastJob, FastResult>(todo, {
		script: path.join(here, 'worker.ts'),
		workers: only.has('timing') ? 1 : Math.min(2, args.num('workers', 2)),
		memMB: args.num('mem-mb', 3500),
		timeoutMs: args.num('timeout', 900) * 1000,
		recycleAfter: 10,
		onResult: (_job, r) => appendJsonl(resFile, r),
		onDone: () => {
			if (++n % 10 === 0) console.log(`  ${n}/${todo.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail, step) => {
			appendJsonl(resFile, { id: job.id, path: job.path, kind: job.kind, source: job.source, half: job.half, size: fs.statSync(job.path).size, open: 'error', openMessage: `crash-${kind} at ${step}: ${detail.slice(0, 160)}`, ms: 0 } satisfies FastResult);
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}
report();

function report() {
	const wanted = new Set(jobs.map((j) => j.id));
	const rows = readJsonl<FastResult>(resFile).filter((r) => wanted.has(r.id));
	for (const r of rows) for (const p of [r.plain, r.optimized]) if (p) p.agree = agree(p.fast, p.full);
	const q = (xs: number[], f: number) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : 0;
	};
	const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
	const stats = (xs: number[]) => (xs.length ? `median ${sec(q(xs, 0.5))}, p90 ${sec(q(xs, 0.9))}, worst ${sec(Math.max(...xs))}` : '–');
	const raws = (list: FastResult[]): RawCompare[] => list.flatMap((r) => [r.raw, r.exportRaw?.plain, r.exportRaw?.optimized].filter((x): x is RawCompare => x !== undefined));
	const md: string[] = [
		`# Faster final check: measurement (${new Date().toISOString().slice(0, 10)}, branch fast-check)`,
		'',
		'Tool: `tools/fast-check/measure.ts` + `worker.ts` (Node, the real engine; `npm run fastcheck:measure`). "Full" is the old final check (`qpdf --check --show-npages`, a fresh instance); "fast" is final-check.ts (the same command after a prelude that sets the Flate level to 0 in the same instance). Times are wall-clock on the Debian box, shared with other sessions (load average often 8-14 on 4 cores during the run), so compare full and fast on the same row rather than absolute numbers; each export pair alternates which runs first.',
		''
	];

	// Disagreements first.
	const all = raws(rows);
	const differ = rows.filter((r) => [r.raw, r.exportRaw?.plain, r.exportRaw?.optimized].some((x) => x && !x.same) || (r.plain && !r.plain.agree) || (r.optimized && !r.optimized.agree));
	md.push('## Agreement', '');
	md.push(`- Raw check comparisons (file as given, and each export): ${all.length}; identical exit code, stdout and stderr: ${all.filter((x) => x.same).length}; verdict differs: ${all.filter((x) => x.full.clean !== x.fast.clean).length}; rejected by the full check: ${all.filter((x) => !x.full.clean).length}, by the fast check: ${all.filter((x) => !x.fast.clean).length}.`);
	const pairs = rows.flatMap((r) => [r.plain, r.optimized].filter((x) => x !== undefined));
	md.push(`- Export pairs (same file and options, fast engine vs fullCheck engine): ${pairs.length}; same outcome, checks and warnings: ${pairs.filter((p) => p!.agree).length}; both refused: ${pairs.filter((p) => p!.fast.status === 'error' && p!.full.status === 'error').length}. Same size: plain exports ${rows.filter((r) => r.plain && r.plain.fast.bytes === r.plain.full.bytes).length} of ${rows.filter((r) => r.plain).length}, default exports ${rows.filter((r) => r.optimized && r.optimized.fast.bytes === r.optimized.full.bytes).length} of ${rows.filter((r) => r.optimized).length} (the Optimize stream pass stops on time budgets, so under load two runs can compress differently; the check runs after it and does not change the file).`);
	if (differ.length) {
		md.push('', 'Rows that differ:', '');
		for (const r of differ) md.push(`- ${r.id.slice(0, 40)} (${r.source}): raw ${r.raw?.same}; plain ${r.plain?.agree} (${r.plain?.fast.status}/${r.plain?.full.status} ${r.plain?.fast.code ?? ''}/${r.plain?.full.code ?? ''}); optimized ${r.optimized?.agree} (${r.optimized?.fast.status}/${r.optimized?.full.status})`);
	}
	md.push('');

	for (const [label, list] of [
		['Generated files', rows.filter((r) => r.kind === 'generated')],
		['Corpus', rows.filter((r) => r.kind === 'corpus')],
		['Survey, tuning half (exported)', rows.filter((r) => r.kind === 'survey' && r.half === 'tune' && r.open !== undefined)],
		['Survey, held-out half (exported)', rows.filter((r) => r.kind === 'survey' && r.half === 'held' && r.open !== undefined)],
		['Survey, raw check only', rows.filter((r) => r.kind === 'survey' && r.open === undefined && !r.id.startsWith('timing:'))],
		['Survey sample, check of the file as given, one worker on a quieter box', rows.filter((r) => r.id.startsWith('timing:'))]
	] as const) {
		if (!list.length) continue;
		md.push(`## ${label}: ${list.length} files`, '');
		const opened = list.filter((r) => r.open === 'ok');
		if (list.some((r) => r.open !== undefined)) md.push(`- Opened: ${opened.length}; not opened: ${list.filter((r) => r.open === 'error').length}`);
		const r0 = raws(list);
		md.push(`- Raw comparisons: ${r0.length}, identical ${r0.filter((x) => x.same).length}; rejected full ${r0.filter((x) => !x.full.clean).length} / fast ${r0.filter((x) => !x.fast.clean).length}`);
		const fileRaw = list.map((r) => r.raw).filter((x): x is RawCompare => x !== undefined);
		md.push(`- Check of the file as given: full ${stats(fileRaw.map((x) => x.full.ms))}; fast ${stats(fileRaw.map((x) => x.fast.ms))}`);
		for (const kind of ['plain', 'optimized'] as const) {
			const ok = opened.map((r) => r[kind]).filter((p): p is { fast: ExportRun; full: ExportRun; agree: boolean } => p !== undefined && p.fast.status === 'ok' && p.full.status === 'ok');
			if (!ok.length) continue;
			const fc = ok.map((p) => p.full.checkMs ?? 0);
			const fa = ok.map((p) => p.fast.checkMs ?? 0);
			const saved = ok.map((p) => (p.full.checkMs ?? 0) - (p.fast.checkMs ?? 0));
			md.push(`- ${kind === 'plain' ? 'Plain export (Optimize off)' : 'Default export (Optimize and print-size cap on)'}, ${ok.length} exported: whole export full ${stats(ok.map((p) => p.full.ms))}; fast ${stats(ok.map((p) => p.fast.ms))}. Final check full ${stats(fc)}; fast ${stats(fa)}; saved ${stats(saved)}. Share of the export that is the final check: full ${(100 * q(ok.map((p) => (p.full.checkMs ?? 0) / p.full.ms), 0.5)).toFixed(0)}% median, fast ${(100 * q(ok.map((p) => (p.fast.checkMs ?? 0) / p.fast.ms), 0.5)).toFixed(0)}%.`);
			const modes = new Map<string, number>();
			for (const p of ok) modes.set((p.fast.check ?? '?').replace(/\d+ ms/g, '').replace(/\s+/g, ' ').trim(), (modes.get((p.fast.check ?? '?').replace(/\d+ ms/g, '').replace(/\s+/g, ' ').trim()) ?? 0) + 1);
			md.push(`  - fast engine's check modes: ${[...modes].map(([k, v]) => `${k} ×${v}`).join('; ')}`);
		}
		md.push('');
		if (label === 'Generated files' || label === 'Corpus') {
			md.push('| file | MB | pages | plain export full → fast | final check full → fast | instance | copy in | parse | write, no decoding | decode all, no compression | fast check | is-encrypted | PDF.js re-open |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
			for (const r of list.filter((x) => x.breakdown && (label === 'Generated files' || x.size > 300_000))) {
				const b = r.breakdown!;
				md.push(`| ${path.basename(r.path)} | ${(r.size / 1e6).toFixed(1)} | ${r.pages} | ${sec(r.plain!.full.ms)} → ${sec(r.plain!.fast.ms)} | ${sec(r.plain!.full.checkMs ?? 0)} → ${sec(r.plain!.fast.checkMs ?? 0)} | ${b.instanceMs} ms | ${b.copyInMs} ms | ${b.parseMs} ms | ${sec(b.writeNoDecodeMs)} | ${sec(b.writeDecodeNoCompressMs)} | ${sec(b.fastCheckMs)} (full ${sec(b.fullCheckMs)}) | ${b.isEncryptedMs} ms | ${sec(b.pdfjsReopenMs)} |`);
			}
			md.push('');
			const opt = list.filter((x) => x.optimized?.fast.status === 'ok' && (label === 'Generated files' || x.size > 300_000));
			if (opt.length) {
				md.push('| file | default export full → fast | its final check full → fast |', '|---|---:|---:|');
				for (const r of opt) md.push(`| ${path.basename(r.path)} | ${sec(r.optimized!.full.ms)} → ${sec(r.optimized!.fast.ms)} | ${sec(r.optimized!.full.checkMs ?? 0)} → ${sec(r.optimized!.fast.checkMs ?? 0)} |`);
				md.push('');
			}
		}
		const errs = new Map<string, number>();
		for (const r of list) for (const p of [r.plain, r.optimized]) if (p?.fast.status === 'error') errs.set(`${p.fast.code}: ${p.fast.message?.slice(0, 120)}`, (errs.get(`${p.fast.code}: ${p.fast.message?.slice(0, 120)}`) ?? 0) + 1);
		if (errs.size) {
			md.push('| export refused (fast engine; the full one refused the same) | exports |', '|---|---:|');
			for (const [k, v] of [...errs].sort((a, b) => b[1] - a[1])) md.push(`| ${k.replace(/\|/g, '/')} | ${v} |`);
			md.push('');
		}
		const rej = new Map<string, number>();
		for (const x of r0.filter((y) => !y.full.clean)) {
			const k = (x.full.first ?? `exit ${x.full.code}`).replace(/\/v\.pdf/g, '').replace(/\d+/g, '#').slice(0, 110);
			rej.set(k, (rej.get(k) ?? 0) + 1);
		}
		if (rej.size) {
			md.push('| what the full check reported (first line, numbers as #) | files |', '|---|---:|');
			for (const [k, v] of [...rej].sort((a, b) => b[1] - a[1]).slice(0, 15)) md.push(`| ${k.replace(/\|/g, '/')} | ${v} |`);
			md.push('');
		}
	}
	fs.writeFileSync(path.join(out, 'measurements.md'), md.join('\n') + '\n');
	console.log(md.slice(0, 40).join('\n'));
}
