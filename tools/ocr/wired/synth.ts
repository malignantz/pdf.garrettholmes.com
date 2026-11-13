/**
 * Re-measures "Make scanned pages searchable" on the measurement's held-out synthetic
 * scans (/home/garrett/pdf-survey/out-ocr/results/synth-hold.jsonl: 354 pages from 201
 * files, true words known) through the app's own code path (synth-worker.ts).
 *
 *   node --experimental-transform-types --no-warnings --import ./tools/survey/register.mjs tools/ocr/wired/synth.ts run [--workers 2] [--limit N]
 *   node … tools/ocr/wired/synth.ts report
 * Output: /home/garrett/pdf-survey/out-ocr-build/results/synth.jsonl (resumable), report-synth.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJsonl } from '../../survey/lib/common';
import { runPool } from '../../survey/lib/pool';
import { addScore, emptyScore, type Score } from '../lib/score';
import type { SynthResult } from '../synth-worker';
import { OUT, pct, quant } from './common';
import type { WCond, WJob, WRow } from './synth-worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const MEASURED = '/home/garrett/pdf-survey/out-ocr';
const res = path.join(OUT, 'results', 'synth.jsonl');
const CONDS: WCond[] = [
	{ dpi: 300, deg: 'clean' },
	{ dpi: 300, deg: 'scan' },
	{ dpi: 200, deg: 'scan' },
	{ dpi: 150, deg: 'scan' },
	{ dpi: 300, deg: 'bitonal' },
	{ dpi: 200, deg: 'bitonal' },
	{ dpi: 200, deg: 'phone' }
];
const key = (sha: string, page: number, c: WCond) => `${sha}:${page}:${c.deg}:${c.dpi}`;
/** Box time: clean and phone on every third page; the typed conditions the bars are about on all. */
const condsFor = (n: number) => CONDS.filter((c) => (c.deg !== 'clean' && c.deg !== 'phone') || n % 3 === 0);

const [step, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (step === 'run') {
	fs.mkdirSync(path.dirname(res), { recursive: true });
	const sample = JSON.parse(fs.readFileSync(path.join(MEASURED, 'synth-sample.json'), 'utf8')) as Record<string, { sha256: string; path: string; source: string }[]>;
	const paths = new Map<string, string>();
	for (const list of Object.values(sample)) if (Array.isArray(list)) for (const f of list) paths.set(f.sha256, f.path);
	const done = new Set(readJsonl<WRow>(res).filter((r) => !r.error).map((r) => key(r.sha256, r.page, r)));
	const byFile = new Map<string, WJob>();
	const seen = new Set<string>();
	for (const r of readJsonl<SynthResult>(path.join(MEASURED, 'results', 'synth-hold.jsonl')))
		for (const p of r.pages) {
			if (seen.has(`${p.sha256}:${p.page}`)) continue;
			seen.add(`${p.sha256}:${p.page}`);
			const conds = condsFor(seen.size - 1).filter((c) => !done.has(key(p.sha256, p.page, c)));
			if (!conds.length) continue;
			const file = paths.get(p.sha256);
			if (!file) continue;
			const job = byFile.get(p.sha256) ?? { sha256: p.sha256, path: file, source: p.source, pages: [], conds: [] };
			job.pages.push({ page: p.page, kind: p.kind, W: p.W, H: p.H, truth: p.truth, ignore: p.ignore, conds });
			byFile.set(p.sha256, job);
		}
	const jobs = [...byFile.values()].slice(0, args.num('limit', Infinity));
	console.log(`${seen.size} held-out pages; ${jobs.length} files to run (${CONDS.length} conditions) → ${res}`);
	const t0 = Date.now();
	let n = 0;
	await runPool<WJob, WRow>(jobs, {
		script: path.join(here, 'synth-worker.ts'),
		workers: Math.min(2, args.num('workers', 2)),
		memMB: args.num('mem-mb', 3500),
		timeoutMs: args.num('timeout', 900) * 1000,
		recycleAfter: 4,
		onResult: (_j, r) => fs.appendFileSync(res, JSON.stringify(r) + '\n'),
		onDone: () => console.log(`  ${++n}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`),
		onFailure: (job, kind, detail) => {
			fs.appendFileSync(res, JSON.stringify({ sha256: job.sha256, page: -1, error: `${kind}: ${detail}` }) + '\n');
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
	process.exit(0);
}

if (step === 'report') {
	const rows = readJsonl<WRow>(res).filter((r) => r.page >= 0);
	const last = new Map<string, WRow>();
	for (const r of rows) last.set(key(r.sha256, r.page, r), r);
	const all = [...last.values()];
	const BAD = 0.85;
	const rec = (s?: Score) => (s && s.nT ? s.ex / s.nT : 0);
	const L = [
		'# Make scanned pages searchable: held-out synthetic scans through the app',
		'',
		`Pages: the measurement's held-out synthetic set (${new Set(all.map((r) => `${r.sha256}:${r.page}`)).size} pages), each condition's degraded scan made again with the same seed and exported by the app's engine (createCoreEngine, ExportOptions.ocr, Node OCR workers). Recall, junk and bad pages are scored on the words written (after the gate and dropping words under confidence 50); "all words" columns score every word OCR returned, as the measurement did. A page is bad when exact recall is under 85%.`,
		'',
		'| condition | pages | tried (eligible) | made searchable | recall exact (written) | junk (written) | bad among searchable | bad let through | all words: recall / junk | pixels identical | errors |',
		'|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
	];
	const line = (label: string, rs: WRow[]) => {
		const acc = rs.filter((r) => r.outcome === 'searchable');
		const s = acc.reduce((a, r) => addScore(a, r.s ?? emptyScore()), emptyScore());
		const sa = acc.reduce((a, r) => addScore(a, r.sAll ?? emptyScore()), emptyScore());
		const bad = acc.filter((r) => rec(r.s) < BAD).length;
		const tried = rs.filter((r) => r.eligible);
		const badAll = tried.filter((r) => r.sAll && rec(r.sAll) < BAD).length;
		const badThrough = acc.filter((r) => rec(r.sAll) < BAD).length;
		return `| ${label} | ${rs.length} | ${tried.length} | ${acc.length} (${pct(acc.length, rs.length)}) | ${pct(s.ex, s.nT)} | ${pct(s.nO - s.ex, s.nO)} | ${pct(bad, acc.length)} (${bad}) | ${badThrough} of ${badAll} | ${pct(sa.ex, sa.nT)} / ${pct(sa.nO - sa.ex, sa.nO)} | ${acc.filter((r) => r.pxSame).length} of ${acc.length} | ${rs.filter((r) => r.error).length} |`;
	};
	for (const c of CONDS) L.push(line(`${c.deg} ${c.dpi}`, all.filter((r) => r.deg === c.deg && r.dpi === c.dpi)));
	const typed = all.filter((r) => ['clean', 'scan', 'bitonal'].includes(r.deg) && r.dpi >= 200);
	L.push(line('**typed (clean, scan, bitonal), 200 and 300**', typed));
	L.push('', '## Outcomes', '', '| condition | searchable | not tried | orientation | script | gate | no words | failed | error |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
	for (const c of CONDS) {
		const rs = all.filter((r) => r.deg === c.deg && r.dpi === c.dpi);
		const n = (o: string) => rs.filter((r) => (o === 'error' ? !!r.error : r.outcome === o && !r.error)).length;
		L.push(`| ${c.deg} ${c.dpi} | ${n('searchable')} | ${n('not tried')} | ${n('orientation')} | ${n('script')} | ${n('gate')} | ${n('no words')} | ${n('failed')} | ${n('error')} |`);
	}
	L.push('', '## Highlighter on the written layer, against the true ink', '', 'Among true words OCR wrote exactly: offered = the highlighter has the word over its ink; right = ink within 1 pt of the box and no other line\'s ink painted (more than 1 pt along and 15% of its height across, measured in the original page\'s frame).', '', '| condition | true words written exactly | offered | right (of offered) | paints a neighbour | misses ink > 1 pt |', '|---|---:|---:|---:|---:|---:|');
	const hl = (label: string, rs: WRow[]) => {
		const t = rs.reduce((a, r) => (r.hl ? { n: a.n + r.hl.n, offered: a.offered + r.hl.offered, right: a.right + r.hl.right, miss: a.miss + r.hl.miss, flood: a.flood + r.hl.flood } : a), { n: 0, offered: 0, right: 0, miss: 0, flood: 0 });
		return `| ${label} | ${t.n} | ${pct(t.offered, t.n)} | ${pct(t.right, t.offered)} | ${pct(t.flood, t.offered)} | ${pct(t.miss, t.offered)} |`;
	};
	for (const c of CONDS) L.push(hl(`${c.deg} ${c.dpi}`, all.filter((r) => r.deg === c.deg && r.dpi === c.dpi)));
	L.push(hl('**typed, 200 and 300**', typed));
	L.push('', '## By document kind (typed, 200 and 300)', '', '| kind | pages | searchable | recall (written) | junk | bad among searchable |', '|---|---:|---:|---:|---:|---:|');
	for (const k of [...new Set(typed.map((r) => r.kind))].sort()) {
		const rs = typed.filter((r) => r.kind === k);
		const acc = rs.filter((r) => r.outcome === 'searchable');
		const s = acc.reduce((a, r) => addScore(a, r.s ?? emptyScore()), emptyScore());
		L.push(`| ${k} | ${rs.length} | ${pct(acc.length, rs.length)} | ${pct(s.ex, s.nT)} | ${pct(s.nO - s.ex, s.nO)} | ${pct(acc.filter((r) => rec(r.s) < BAD).length, acc.length)} |`);
	}
	const ms = typed.filter((r) => r.outcome === 'searchable');
	L.push('', `Node time per searchable page (one OCR worker; box shared with other work): render p50 ${quant(ms.map((r) => r.ms.render), 0.5)} ms, orientation p50 ${quant(ms.map((r) => r.ms.orient), 0.5)} ms, reading p50 / p90 ${(quant(ms.map((r) => r.ms.read), 0.5) / 1000).toFixed(1)} / ${(quant(ms.map((r) => r.ms.read), 0.9) / 1000).toFixed(1)} s, whole export p50 ${(quant(ms.map((r) => r.ms.export), 0.5) / 1000).toFixed(1)} s. Export checks all passed on ${all.filter((r) => r.checksOk).length} of ${all.filter((r) => r.checksOk !== undefined).length} exports.`);
	fs.writeFileSync(path.join(OUT, 'report-synth.md'), L.join('\n') + '\n');
	console.log(L.join('\n'));
}
