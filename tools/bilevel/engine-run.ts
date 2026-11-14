/**
 * "Make scanned pages black and white" through the real engine on the held-out data:
 * the owner's notice, the held-out survey files whose scanned pages reached the picture
 * test in the phase 1 measurement (out-bilevel/final.jsonl), and the held-out synthetic
 * scans of survey pages. Each file is exported (engine-worker.ts) as the app would: the
 * switch off with Optimize (base), the switch alone, the switch with Optimize, and the
 * switch with Optimize and OCR (the notice, the survey files, every fourth synthetic scan).
 *
 *   npm run bilevel:engine -- [--max-pages 40] [--workers 2] [--out DIR] [--report-only]
 *
 * Writes OUT/engine.jsonl (resumable) and OUT/report-engine.md (OUT: /home/garrett/pdf-survey/out-bilevel).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, parseArgs, readJsonl, repoRoot } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import type { EngineJob, EngineResult, Variant, VariantRun } from './engine-worker';
import type { BlResult } from './worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';
const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? path.join(PILE, 'out-bilevel'));
if (!path.relative(repoRoot, out).startsWith('..')) throw new Error('output must be outside the repo');
const resFile = path.join(out, 'engine.jsonl');
const maxPages = args.num('max-pages', 40);
const notice = args.get('notice') ?? '/home/garrett/.claude/uploads/e509adfd-95d4-5840-9e96-afefdb3adbb8/8861ee54-notice.pdf';
const ALL: Variant[] = ['base', 'alone', 'optimize', 'ocr'];

const measured = readJsonl<BlResult>(path.join(out, 'final.jsonl'));
const profiles = new Map(readJsonl<{ sha256: string; path: string }>(path.join(PILE, 'out/profiles.jsonl')).map((p) => [p.path, p.sha256]));
const jobs: EngineJob[] = [];
if (fs.existsSync(notice)) jobs.push({ id: 'notice', path: notice, kind: 'notice', source: 'owner', maxPages, variants: ALL });
for (const r of measured) {
	if (r.kind === 'survey' && r.half === 'held' && r.rows.some((p) => p.stats)) jobs.push({ id: r.id, path: r.path, kind: 'survey', source: r.source, maxPages, variants: ALL });
}
let k = 0;
for (const r of measured) {
	if (r.kind !== 'synth' || r.half !== 'held' || r.message) continue;
	const sha = profiles.get(r.path);
	const m = /-p(\d+)$/.exec(r.id);
	if (!sha || !m) continue;
	const seed = Number.parseInt(sha.slice(8, 16), 16) ^ 0x5bd1e995;
	jobs.push({ id: r.id, path: r.path, kind: 'synth', source: r.source, page: Number(m[1]) - 1, seed, maxPages: 1, variants: k++ % 4 === 0 ? ALL : ['base', 'alone', 'optimize'] });
}

const done = new Set(readJsonl<EngineResult>(resFile).map((r) => r.id));
const todo = jobs.filter((j) => !done.has(j.id));
if (!args.flag('report-only')) {
	console.log(`${jobs.length} files, ${todo.length} to do → ${resFile}`);
	const t0 = Date.now();
	let n = 0;
	await runPool<EngineJob, EngineResult>(todo, {
		script: path.join(here, 'engine-worker.ts'),
		workers: Math.min(2, args.num('workers', 2)),
		memMB: args.num('mem-mb', 3000),
		timeoutMs: args.num('timeout', 600) * 1000,
		recycleAfter: args.num('recycle', 5),
		onResult: (_job, r) => appendJsonl(resFile, r),
		onDone: () => {
			if (++n % 10 === 0) console.log(`  ${n}/${todo.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail, step) => {
			appendJsonl(resFile, { id: job.id, path: job.path, kind: job.kind, source: job.source, size: 0, pages: 0, runs: [], message: `crash-${kind} at ${step}: ${detail.slice(0, 160)}` } satisfies EngineResult);
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}
report();

function report() {
	const rows = readJsonl<EngineResult>(resFile).filter((r) => jobs.some((j) => j.id === r.id));
	const q = (xs: number[], f: number) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN;
	};
	const kb = (n: number) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
	const md = ['# Black and white scans: the real engine on held-out data', '', `Generated ${new Date().toISOString().slice(0, 16)} by \`npm run bilevel:engine\`. Every number is from Engine.exportPlan with the app's own options; an export either passes every check (the new 'bilevel' check included) or is refused, so nothing unverified can be counted as shipped.`, ''];
	for (const [title, kind] of [
		['The owner\'s notice', 'notice'],
		['Held-out survey files (scanned pages that reached the picture test in phase 1)', 'survey'],
		['Held-out synthetic scans of survey pages', 'synth']
	] as const) {
		const list = rows.filter((r) => r.kind === kind);
		if (!list.length) continue;
		md.push(`## ${title}`, '');
		const crashed = list.filter((r) => r.message);
		md.push(`Files ${list.length}${crashed.length ? ` (${crashed.length} not run: ${[...new Set(crashed.map((r) => r.message!.slice(0, 60)))].join('; ')})` : ''}; pages exported ${list.reduce((s, r) => s + r.pages, 0)}; pages the dialog would offer it for ${list.reduce((s, r) => s + (r.bilevelPages ?? 0), 0)}.`, '');
		md.push('| variant | exports | refused (any reason) | of which verification failed | converted pages | left pages | pages rebuilt after a failed bilevel check | median time | total size |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
		const runsOf = (v: Variant) => list.flatMap((r) => r.runs.filter((x) => x.variant === v).map((x) => ({ r, x })));
		for (const v of ['base', 'alone', 'optimize', 'ocr'] as Variant[]) {
			const runs = runsOf(v);
			if (!runs.length) continue;
			const ok = runs.filter((e) => e.x.status === 'ok');
			const conv = ok.reduce((s, e) => s + (e.x.bilevel?.converted.length ?? 0), 0);
			const left = ok.reduce((s, e) => s + (e.x.bilevel?.left.length ?? 0), 0);
			const rebuilt = runs.reduce((s, e) => s + (e.x.notes ?? []).filter((n) => /bilevel: failed its check/.test(n)).length, 0);
			const vf = runs.filter((e) => e.x.code === 'verification-failed').length;
			md.push(`| ${v} | ${runs.length} | ${runs.length - ok.length} | ${vf} | ${v === 'base' ? '–' : conv} | ${v === 'base' ? '–' : left} | ${v === 'base' ? '–' : rebuilt} | ${(q(ok.map((e) => e.x.ms), 0.5) / 1000).toFixed(1)} s | ${kb(ok.reduce((s, e) => s + (e.x.bytes ?? 0), 0))} |`);
		}
		const errs = list.flatMap((r) => r.runs.filter((x) => x.status === 'error').map((x) => `${r.id} ${x.variant}: ${x.code} ${x.message?.slice(0, 80)}`));
		if (errs.length) md.push('', 'Refused exports: ' + errs.slice(0, 8).join('; '));
		// Size: files with a converted page, base vs the switch with Optimize.
		const pair = list
			.map((r) => ({ r, base: r.runs.find((x) => x.variant === 'base' && x.status === 'ok'), on: r.runs.find((x) => x.variant === 'optimize' && x.status === 'ok') }))
			.filter((p) => p.base && p.on && (p.on.bilevel?.converted.length ?? 0) > 0);
		if (pair.length) {
			const ratio = pair.map((p) => p.base!.bytes! / p.on!.bytes!);
			const extra = pair.map((p) => (p.on!.ms - p.base!.ms) / p.on!.bilevel!.converted.length);
			md.push(
				'',
				`Files with a converted page: ${pair.length}. Size with Optimize, switch off → on: ${kb(pair.reduce((s, p) => s + p.base!.bytes!, 0))} → ${kb(pair.reduce((s, p) => s + p.on!.bytes!, 0))}; per file ${q(ratio, 0.5).toFixed(1)}× smaller (median; range ${Math.min(...ratio).toFixed(1)}–${Math.max(...ratio).toFixed(1)}×). Time added per converted page (switch on minus off, Node on a busy box): median ${(q(extra, 0.5) / 1000).toFixed(2)} s, p90 ${(q(extra, 0.9) / 1000).toFixed(2)} s.`
			);
			if (kind === 'notice') md.push('', `Notice: ${kb(list[0].size)} as given → ${kb(pair[0].on!.bytes!)} with the switch and Optimize (base ${kb(pair[0].base!.bytes!)}); switch alone ${kb(list[0].runs.find((x) => x.variant === 'alone')?.bytes ?? 0)}.`);
		}
		const ocr = list.flatMap((r) => r.runs.filter((x) => x.variant === 'ocr' && x.status === 'ok'));
		if (ocr.length) {
			md.push('', `With OCR: ${ocr.length} exports, pages made searchable ${ocr.reduce((s, x) => s + (x.ocr?.searchable ?? 0), 0)}, black and white ${ocr.reduce((s, x) => s + (x.bilevel?.converted.length ?? 0), 0)}; every one passed both the 'text-layer' and 'bilevel' checks where they applied (${ocr.filter((x) => x.checks?.includes('FAIL')).length} with a failed check).`);
		}
		md.push('');
	}
	fs.writeFileSync(path.join(out, 'report-engine.md'), md.join('\n') + '\n');
	console.log(`report → ${path.join(out, 'report-engine.md')}`);
}
