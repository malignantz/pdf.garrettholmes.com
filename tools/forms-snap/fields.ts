/**
 * `forms:snap fields`: "Keep filled blanks editable" measured on real forms through the
 * wired code (fields-worker.ts does one form per job). Reads the snap measurement's
 * sample and ink cache (--from, e.g. out-forms-snap/holdout: held-out sample B), writes
 * results.jsonl and report.md to --out (never inside the repo).
 *
 *   npm run forms:snap -- fields --from DIR --out OUT [--workers 2] [--limit N] [--keep 20] [--only sha,sha]
 *
 * --keep N keeps both exports of the first N forms in OUT/keep/ for the
 * independent poppler/qpdf check; delete them when done.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Args } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import { loadSample } from './sample';
import type { FieldsJob, FieldsResult } from './fields-worker';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function fields(args: Args, out: string) {
	const from = path.resolve(args.get('from') ?? out);
	const files = loadSample(from).filter((f) => f.group === 'form' && f.real);
	const keep = args.num('keep', 20);
	let jobs: FieldsJob[] = files
		.map((f) => ({ sha256: f.sha256, path: f.path, inkFile: path.join(from, 'ink', `${f.sha256}.json.gz`), maxPages: args.num('max-pages', 6), plainFinalize: args.flag('no-compress') }))
		.filter((j) => fs.existsSync(j.inkFile))
		.filter((j) => !args.get('only') || args.get('only')!.split(',').some((p) => j.sha256.startsWith(p)));
	jobs = jobs.slice(0, args.num('limit', Infinity));
	jobs.forEach((j, i) => {
		if (i < keep) (j as FieldsJob).keepDir = path.join(out, 'keep');
	});
	const resultsFile = path.join(out, 'results.jsonl');
	fs.writeFileSync(resultsFile, '');
	const results: FieldsResult[] = [];
	const t0 = Date.now();
	let done = 0;
	console.log(`fields: ${jobs.length} forms from ${from} → ${out}`);
	await runPool<FieldsJob, FieldsResult>(jobs, {
		script: path.join(here, 'fields-worker.ts'),
		workers: Math.min(2, args.num('workers', 2)),
		memMB: args.num('mem-mb', 2500),
		timeoutMs: args.num('timeout', 300) * 1000,
		recycleAfter: 10,
		onResult: (_job, r) => {
			results.push(r);
			fs.appendFileSync(resultsFile, JSON.stringify(r) + '\n');
		},
		onDone: () => {
			if (++done % 10 === 0) console.log(`  ${done}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail) => {
			const r: FieldsResult = { sha256: job.sha256, error: `${kind}: ${detail.slice(0, 200)}`, pages: 0, taps: 0, text: 0, ticks: 0, nonWinAnsi: 0 };
			results.push(r);
			fs.appendFileSync(resultsFile, JSON.stringify(r) + '\n');
			return null;
		}
	});
	const report = fieldsReport(results, from);
	fs.writeFileSync(path.join(out, 'report.md'), report);
	console.log(report);
}

const pct = (a: number, n: number) => (n ? `${((100 * a) / n).toFixed(1)}%` : '–');
function quantile(xs: number[], q: number): number {
	if (!xs.length) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

export function fieldsReport(results: FieldsResult[], from: string): string {
	const ok = results.filter((r) => !r.error);
	const both = ok.filter((r) => r.ordinaryMs !== undefined && r.fieldsMs !== undefined);
	const sum = (f: (r: FieldsResult) => number) => ok.reduce((n, r) => n + f(r), 0);
	const stamps = sum((r) => r.text + r.ticks);
	const fieldsMade = sum((r) => r.fields ?? 0);
	const plain = sum((r) => r.plain ?? 0);
	const reasons: Record<string, number> = {};
	for (const r of ok) for (const [k, v] of Object.entries(r.reasons ?? {})) reasons[k] = (reasons[k] ?? 0) + v;
	const withStamps = ok.filter((r) => r.text + r.ticks > 0);
	const fieldsErr = ok.filter((r) => r.fieldsError && !r.ordinaryError);
	const bothErr = ok.filter((r) => r.fieldsError && r.ordinaryError);
	const readProblems = ok.flatMap((r) => (r.readBack?.problems ?? []).map((p) => `${r.sha256.slice(0, 12)}: ${p}`));
	const renders = ok.flatMap((r) => (r.renders ?? []).map((d) => ({ sha: r.sha256, ...d })));
	const bad = (n: number | null) => n !== null && n >= 4;
	const renderFail = renders.filter((d) => bad(d.mupdf) || bad(d.pdfjs) || bad(d.poppler));
	const added = both.filter((r) => r.text + r.ticks > 0).map((r) => (r.fieldsMs! - r.ordinaryMs!) / 1000);
	const notVerified = ok.flatMap((r) => r.notVerified ?? []);
	const lines = [
		`# Keep filled blanks editable, measured on real forms (${from})`,
		'',
		`Forms: ${results.length} (${results.length - ok.length} not run: ${[...new Set(results.filter((r) => r.error).map((r) => r.error!.split(':')[0]))].join(', ') || 'none'}); with snapped stamps: ${withStamps.length}; pages: ${sum((r) => r.pages)}.`,
		'',
		'| | count |',
		'|---|---:|',
		`| sloppy taps (one per true widget) | ${sum((r) => r.taps)} |`,
		`| linked stamps placed (text / ticks) | ${stamps} (${sum((r) => r.text)} / ${sum((r) => r.ticks)}) |`,
		`| of the text, typed with letters outside WinAnsi on purpose | ${sum((r) => r.nonWinAnsi)} |`,
		`| exports with the option that failed (the ordinary export of the same plan worked) | ${fieldsErr.length} |`,
		`| exports where both failed | ${bothErr.length} |`,
		`| fields created / linked stamps in exports that worked | ${fieldsMade} / ${fieldsMade + plain} (${pct(fieldsMade, fieldsMade + plain)}) |`,
		`| plain stamps instead, by reason | ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} |`,
		`| exports with every check passed | ${ok.filter((r) => r.checksOk).length} / ${ok.filter((r) => r.checksOk !== undefined).length} |`,
		`| PDF.js read-back of the new fields: right / problems | ${sum((r) => r.readBack?.found ?? 0)} / ${readProblems.length} |`,
		`| pages with fields rendered (MuPDF, PDF.js, poppler at 100 dpi) | ${renders.length} |`,
		`| … that differ from the ordinary export (≥ 4 pixels off by > 48) | ${renderFail.length} |`,
		`| largest difference (pixels): MuPDF / PDF.js / poppler | ${Math.max(0, ...renders.map((d) => d.mupdf))} / ${Math.max(0, ...renders.map((d) => d.pdfjs))} / ${Math.max(0, ...renders.map((d) => d.poppler ?? 0))} |`,
		`| export time added, s: median / p90 / p99 / max | ${[0.5, 0.9, 0.99, 1].map((q) => quantile(added, q).toFixed(2)).join(' / ')} |`,
		`| ordinary export time, s: median / p90 / max | ${[0.5, 0.9, 1].map((q) => quantile(both.map((r) => r.ordinaryMs! / 1000), q).toFixed(2)).join(' / ')} |`
	];
	if (notVerified.length) lines.push('', 'Not verified (drawn as plain stamps):', ...[...new Set(notVerified)].slice(0, 30).map((s) => `- ${s}`));
	if (fieldsErr.length) lines.push('', 'Exports that failed only with the option:', ...fieldsErr.map((r) => `- ${r.sha256.slice(0, 12)}: ${r.fieldsError}`));
	if (bothErr.length) lines.push('', 'Both failed:', ...bothErr.map((r) => `- ${r.sha256.slice(0, 12)}: ${r.fieldsError}`));
	if (readProblems.length) lines.push('', 'Read-back problems:', ...readProblems.slice(0, 30).map((s) => `- ${s}`));
	if (renderFail.length) lines.push('', 'Render differences:', ...renderFail.map((d) => `- ${d.sha.slice(0, 12)} page ${d.page + 1}: MuPDF ${d.mupdf}, PDF.js ${d.pdfjs}, poppler ${d.poppler}`));
	return lines.join('\n') + '\n';
}
