/**
 * Re-measures "Make scanned pages searchable" on the measurement's 50 graded real scans
 * (no text layer; /home/garrett/pdf-survey/out-ocr/grade/grades.json), through the app's
 * own code path (graded-worker.ts). Survey files: read only, in a child process.
 *
 *   node --experimental-transform-types --no-warnings --import ./tools/survey/register.mjs tools/ocr/wired/graded.ts run
 *   node … tools/ocr/wired/graded.ts report      # after grading changed words by eye into <out>/graded/changed.json
 * Output: /home/garrett/pdf-survey/out-ocr-build/graded/rows.jsonl, report-graded.md, crops/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl } from '../../survey/lib/common';
import { runPool } from '../../survey/lib/pool';
import type { ScanResult } from '../scan-worker';
import { OUT, pct, quant } from './common';
import type { GJob, GRow } from './graded-worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const MEASURED = '/home/garrett/pdf-survey/out-ocr';
const dir = path.join(OUT, 'graded');
const rowsFile = path.join(dir, 'rows.jsonl');
const step = process.argv[2];

if (step === 'run') {
	fs.mkdirSync(dir, { recursive: true });
	const grades = JSON.parse(fs.readFileSync(path.join(MEASURED, 'grade', 'grades.json'), 'utf8')) as Record<string, { group: string; wrong: number[]; unsure?: number[] }>;
	const sample = JSON.parse(fs.readFileSync(path.join(MEASURED, 'scan-sample.json'), 'utf8')) as { c: { sha256: string; path: string }[] };
	const paths = new Map(sample.c.map((x) => [x.sha256, x.path]));
	const jobs: GJob[] = [];
	for (const r of readJsonl<ScanResult>(path.join(MEASURED, 'results', 'scan-c.jsonl')))
		for (const p of r.ocr ?? []) {
			const key = `${r.sha256.slice(0, 16)}-p${p.i + 1}`;
			const g = grades[key];
			const file = paths.get(r.sha256);
			if (!g || !file) continue;
			jobs.push({ key, path: file, page: p.i, group: g.group, old: p.runs[0].words, wrong: g.wrong, unsure: g.unsure ?? [] });
		}
	console.log(`${jobs.length} graded pages`);
	fs.writeFileSync(rowsFile, '');
	await runPool<GJob, GRow>(jobs, {
		script: path.join(here, 'graded-worker.ts'),
		workers: 1,
		memMB: 4000,
		timeoutMs: 900_000,
		recycleAfter: 5,
		onResult: (_j, r) => fs.appendFileSync(rowsFile, JSON.stringify(r) + '\n'),
		onDone: (j) => console.log(`  ${j.key}`),
		onFailure: (job, kind, detail) => {
			fs.appendFileSync(rowsFile, JSON.stringify({ key: job.key, group: job.group, outcome: 'error', error: `${kind}: ${detail}`, right: 0, wrong: 0, changed: [], gone: [], written: 0, ms: { orient: 0, read: 0, export: 0 } }) + '\n');
			return null;
		}
	});
	process.exit(0);
}

if (step === 'report') {
	const rows = readJsonl<GRow>(rowsFile);
	// Changed words graded by eye: { "<key>-w<n>": true when the new text is right }.
	const byEye = fs.existsSync(path.join(dir, 'changed.json')) ? (JSON.parse(fs.readFileSync(path.join(dir, 'changed.json'), 'utf8')) as Record<string, boolean>) : {};
	const groups = [...new Set(rows.map((r) => r.group))].sort();
	const L = [
		'# Make scanned pages searchable: the graded real scans through the app',
		'',
		"Pages: the measurement's 50 real scans without text, graded by eye (30 random OCR words a page). The app exports each page with the option on. For pages made searchable, each graded word is looked up in what the app wrote at the same place: the same text keeps its grade; other text was graded again by eye from a crop; a word the app did not write (confidence filter, or not read) is 'gone'. Junk = wrong among the graded words the app wrote.",
		'',
		'| group | pages | made searchable | graded words written | wrong (junk) | words changed (re-graded right / wrong) | graded right words gone | graded wrong words gone | pixels identical |',
		'|---|---:|---:|---:|---:|---:|---:|---:|---:|'
	];
	const line = (label: string, rs: GRow[]) => {
		const acc = rs.filter((r) => r.outcome === 'searchable');
		let right = 0;
		let wrong = 0;
		let chR = 0;
		let chW = 0;
		let goneR = 0;
		let goneW = 0;
		for (const r of acc) {
			right += r.right;
			wrong += r.wrong;
			for (const c of r.changed) {
				const ok = byEye[`${r.key}-w${c.n}`];
				if (ok === true) chR++;
				else if (ok === false) chW++;
			}
			for (const g of r.gone) g.oldWrong ? goneW++ : goneR++;
		}
		const n = right + wrong + chR + chW;
		const ch = acc.reduce((s, r) => s + r.changed.length, 0);
		return `| ${label} | ${rs.length} | ${acc.length} | ${n} | ${pct(wrong + chW, n)} | ${ch} (${chR} / ${chW}) | ${goneR} | ${goneW} | ${acc.filter((r) => r.pxSame).length} of ${acc.length} |`;
	};
	for (const g of groups) L.push(line(g, rows.filter((r) => r.group === g)));
	L.push(line('**all**', rows));
	L.push('', '| page | group | outcome | mean conf | common English | orientation |', '|---|---|---|---:|---:|---|');
	for (const r of rows) L.push(`| ${r.key} | ${r.group.slice(0, 30)} | ${r.outcome}${r.error ? ` (${r.error.slice(0, 60)})` : ''} | ${r.sig?.meanConf ?? '–'} | ${r.sig ? pct(r.sig.stop, 1) : '–'} | ${r.orientation ? `${r.orientation.angle}° ${r.orientation.script}` : '–'} |`);
	const ms = rows.filter((r) => r.ms.read > 0);
	L.push('', `Node, one OCR worker: reading p50 ${(quant(ms.map((r) => r.ms.read), 0.5) / 1000).toFixed(1)} s, orientation p50 ${(quant(ms.map((r) => r.ms.orient), 0.5) / 1000).toFixed(1)} s.`);
	fs.writeFileSync(path.join(OUT, 'report-graded.md'), L.join('\n') + '\n');
	console.log(L.join('\n'));
}
