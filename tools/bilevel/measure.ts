/**
 * Measures "Make scanned pages black and white" (engine/bilevel.ts). Measurement only:
 * nothing here is wired into the app.
 *
 *   npm run bilevel:measure -- [--set notice,hard,survey] [--half tune|held] [--max-pages 6]
 *                              [--workers 2] [--out DIR] [--review DIR] [--rules k=v,…] [--report-only]
 *
 * Inputs (all read-only; none is ever copied into the repo):
 *  - notice: the owner's example (--notice PATH), a one-page RGB JPEG scan.
 *  - hard: synthetic hard cases (tools/bilevel/hard.ts writes them to OUT/hard/ first).
 *  - survey: files of /home/garrett/pdf-survey whose pages include scans (the OCR
 *    measurement's inventory, out-ocr/results/scan-inventory.jsonl: files with image-only
 *    or text-over-image pages). The first hex digit of the sha256 puts a file in the tuning
 *    half (even) or the held-out half (odd). Up to --max-pages scanned pages a file, spread
 *    over its first 80 pages.
 * Work runs in child processes (survey/lib/pool.ts: memory and time caps, at most 2).
 *
 * Writes OUT/results.jsonl (one row per file; resumable) and OUT/report.md; review images
 * (original beside black/white, at 100%) go to the review folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BILEVEL_RULES, type BilevelRules } from '../../src/lib/engine/bilevel';
import { appendJsonl, parseArgs, readJsonl, repoRoot } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import type { BlJob, BlResult, CheckRow, PageRow } from './worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';
const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? path.join(PILE, 'out-bilevel'));
if (!path.relative(repoRoot, out).startsWith('..')) throw new Error('output must be outside the repo');
const reviewDir = path.resolve(args.get('review') ?? '/tmp/claude-1000/-home-garrett-code/e509adfd-95d4-5840-9e96-afefdb3adbb8/scratchpad/bilevel/review');
if (!path.relative(repoRoot, reviewDir).startsWith('..')) throw new Error('review folder must be outside the repo');
fs.mkdirSync(out, { recursive: true });
const resFile = path.join(out, args.get('results') ?? 'results.jsonl');
const sets = new Set((args.get('set') ?? 'notice,hard,survey,synth').split(','));
const maxPages = args.num('max-pages', 12);
const rules: Partial<BilevelRules> = Object.fromEntries(
	(args.get('rules') ?? '')
		.split(',')
		.filter(Boolean)
		.map((kv) => {
			const [k, v] = kv.split('=');
			return [k, Number(v)];
		})
);

const notice = args.get('notice') ?? '/home/garrett/.claude/uploads/e509adfd-95d4-5840-9e96-afefdb3adbb8/8861ee54-notice.pdf';
const jobs: BlJob[] = [];
if (sets.has('notice') && fs.existsSync(notice))
	jobs.push({ id: 'notice', path: notice, kind: 'notice', source: 'owner', half: 'notice', maxPages: 1, reviewDir, rules, reviewAll: true });
if (sets.has('hard')) {
	const dir = path.join(out, 'hard');
	const cases = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8')) as { name: string; expect: string }[];
	for (const c of cases) jobs.push({ id: `hard-${c.name}`, path: path.join(dir, `${c.name}.pdf`), kind: 'hard', source: 'hard', half: 'hard', expect: c.expect, maxPages: 1, reviewDir, rules, reviewAll: true });
}
if (sets.has('survey')) {
	const inv = readJsonl<{ sha256: string; source: string; inv?: unknown[] }>(path.join(PILE, 'out-ocr/results/scan-inventory.jsonl')).filter((r) => r.inv);
	const profiles = new Map(readJsonl<{ sha256: string; path: string; size?: number }>(path.join(PILE, 'out/profiles.jsonl')).map((p) => [p.sha256, p]));
	const only = args.get('half');
	for (const r of inv.sort((a, b) => a.sha256.localeCompare(b.sha256))) {
		const p = profiles.get(r.sha256);
		if (!p || !p.path.startsWith(`${PILE}/raw/`) || !fs.existsSync(p.path) || (p.size ?? 0) > 120e6) continue;
		const half = Number.parseInt(r.sha256[0], 16) % 2 === 0 ? 'tune' : 'held';
		if (only && half !== only) continue;
		jobs.push({ id: r.sha256.slice(0, 12), path: p.path, kind: 'survey', source: r.source, half, maxPages, reviewDir, rules });
	}
}

if (sets.has('synth')) {
	// Born-digital pages made into scans (worker.ts synthScan), round-robin across sources.
	const SOURCES = ['govdocs1', 'irs-forms', 'uscis-forms', 'gsa-forms', 'state-forms', 'uscourts-forms', 'intl-forms', 'invoices-statements', 'office-exports', 'signed-pdfs', 'attachments-portfolios', 'arxiv', 'un-multilingual'];
	type Prof = { sha256: string; path: string; source: string; status?: string; pages?: number; size?: number; encryption?: string; content?: { textPages?: number } };
	const hash = (s: string) => Number.parseInt(s.slice(8, 16), 16);
	const per = args.num('synth', 160);
	const only = args.get('half');
	for (const half of ['tune', 'held'] as const) {
		if (only && half !== only) continue;
		const bySource = SOURCES.map((src) =>
			readJsonl<Prof>(path.join(PILE, 'out/profiles.jsonl'))
				.filter((p) => p.source === src && p.status === 'ok' && (p.encryption ?? 'none') === 'none' && (p.pages ?? 0) > 0 && (p.size ?? 0) < 30e6 && (p.content?.textPages ?? 0) > 0)
				.filter((p) => (Number.parseInt(p.sha256[0], 16) % 2 === 0 ? 'tune' : 'held') === half && fs.existsSync(p.path))
				.sort((a, b) => a.sha256.slice(8).localeCompare(b.sha256.slice(8)))
		);
		let added = 0;
		for (let i = 0; added < per && bySource.some((l) => l.length > i); i++)
			for (const list of bySource) {
				const p = list[i];
				if (!p || added >= per) continue;
				const page = hash(p.sha256) % Math.min(p.pages!, 8);
				jobs.push({ id: `syn-${p.sha256.slice(0, 10)}-p${page + 1}`, path: p.path, kind: 'synth', source: p.source, half, page, seed: hash(p.sha256) ^ 0x5bd1e995, maxPages: 1, reviewDir, rules });
				added++;
			}
	}
}

const done = new Set(readJsonl<BlResult>(resFile).map((r) => r.id));
const todo = jobs.filter((j) => !done.has(j.id));

if (!args.flag('report-only')) {
	console.log(`${jobs.length} files, ${todo.length} to do → ${resFile}`);
	const t0 = Date.now();
	let n = 0;
	await runPool<BlJob, BlResult>(todo, {
		script: path.join(here, 'worker.ts'),
		workers: Math.min(2, args.num('workers', 2)),
		memMB: args.num('mem-mb', 2500),
		timeoutMs: args.num('timeout', 300) * 1000,
		recycleAfter: 10,
		onResult: (_job, r) => appendJsonl(resFile, r),
		onDone: () => {
			if (++n % 10 === 0) console.log(`  ${n}/${todo.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail, step) => {
			appendJsonl(resFile, { id: job.id, path: job.path, kind: job.kind, source: job.source, half: job.half, size: 0, open: 'error', message: `crash-${kind} at ${step}: ${detail.slice(0, 160)}`, rows: [], ms: 0 } satisfies BlResult);
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}
report();

// --- report ----------------------------------------------------------------------------------

function report() {
	const wanted = new Set(jobs.map((j) => j.id));
	const rows = readJsonl<BlResult>(resFile).filter((r) => wanted.has(r.id));
	const q = (xs: number[], f: number) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN;
	};
	const kb = (n: number) => (Number.isFinite(n) ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : '–');
	const x = (n: number) => (Number.isFinite(n) ? `${n.toFixed(1)}×` : '–');
	const count = (list: string[]) => {
		const m = new Map<string, number>();
		for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
		return [...m].sort((a, b) => b[1] - a[1]);
	};
	const r = { ...BILEVEL_RULES, ...rules };
	const md: string[] = [
		'# Black and white scans: measurement',
		'',
		`Generated ${new Date().toISOString().slice(0, 16)} by \`npm run bilevel:measure\` (tools/bilevel/). Rules: ${Object.entries(r)
			.map(([k, v]) => `${k} ${v}`)
			.join(', ')}.`,
		''
	];
	const pageRows = (list: BlResult[]) => list.flatMap((f) => f.rows.map((p) => ({ f, p })));
	const section = (title: string, list: BlResult[]) => {
		const pr = pageRows(list);
		const conv = pr.filter((x) => x.p.status === 'converted');
		md.push(`## ${title}`, '');
		md.push(
			`Files ${list.length} (opened ${list.filter((f) => f.open === 'ok').length}); scanned pages found ${list.reduce((s, f) => s + (f.scanPages ?? 0), 0)}; tried ${pr.length}; **converted ${conv.length}**, refused ${pr.length - conv.length}.`,
			''
		);
		md.push('| refused because | pages | files |', '|---|---:|---:|');
		const reasons = count(pr.filter((x) => x.p.status === 'refused').map((x) => x.p.reason ?? '?'));
		for (const [k, v] of reasons) md.push(`| ${k} | ${v} | ${new Set(pr.filter((x) => x.p.reason === k).map((x) => x.f.id)).size} |`);
		md.push('');
		const inv = pr.filter((x) => x.p.invisibleText);
		md.push(`Pages with an invisible OCR text layer: ${inv.length} tried, ${inv.filter((x) => x.p.status === 'converted').length} converted.`, '');
		if (conv.length) {
			const ratio = (k: 'g4' | 'flate' | 'flateNone') => conv.map((x) => x.p.before! / x.p[k]!);
			const size = (k: 'before' | 'g4' | 'flate' | 'flateNone') => conv.map((x) => x.p[k]!);
			md.push('| converted pictures | median | p10 | p90 | min | max |', '|---|---:|---:|---:|---:|---:|');
			for (const k of ['before', 'g4', 'flate', 'flateNone'] as const) {
				const s = size(k);
				md.push(`| ${{ before: 'stored before', g4: 'CCITT G4', flate: 'Flate, 1 bit, PNG predictors', flateNone: 'Flate, 1 bit, no predictor' }[k]} | ${kb(q(s, 0.5))} | ${kb(q(s, 0.1))} | ${kb(q(s, 0.9))} | ${kb(Math.min(...s))} | ${kb(Math.max(...s))} |`);
			}
			for (const k of ['g4', 'flate', 'flateNone'] as const) {
				const s = ratio(k);
				md.push(`| reduction, ${k} | ${x(q(s, 0.5))} | ${x(q(s, 0.1))} | ${x(q(s, 0.9))} | ${x(Math.min(...s))} | ${x(Math.max(...s))} |`);
			}
			const g4Wins = conv.filter((c) => c.p.g4! <= c.p.flate!).length;
			md.push('', `G4 smaller than Flate on ${g4Wins} of ${conv.length} pictures; G4 / Flate size median ${q(conv.map((c) => c.p.g4! / c.p.flate!), 0.5).toFixed(2)}.`);
			const files = list.filter((f) => f.outSize && f.srcSize);
			if (files.length) {
				const fr = files.map((f) => f.srcSize! / f.outSize!);
				md.push(`Whole files with a converted page (engine-normalised bytes, before → after, only the converted pictures changed): ${files.length}; reduction median ${x(q(fr, 0.5))}, range ${x(Math.min(...fr))}–${x(Math.max(...fr))}; total ${kb(files.reduce((s, f) => s + f.srcSize!, 0))} → ${kb(files.reduce((s, f) => s + f.outSize!, 0))}.`);
			}
			const ver = conv.filter((c) => c.p.verify);
			md.push(
				`Read back from the written file: MuPDF bit-exact ${ver.filter((c) => c.p.verify!.mupdf).length}/${ver.length}, PDF.js (wasm) ${ver.filter((c) => c.p.verify!.pdfjs).length}/${ver.length}, PDF.js (JS fallback) ${ver.filter((c) => c.p.verify!.pdfjsFallback).length}/${ver.length}.`,
				''
			);
			const ms = (k: keyof NonNullable<PageRow['ms']>) => conv.map((c) => c.p.ms![k]);
			const tot = conv.map((c) => c.p.ms!.analyse + c.p.ms!.binarize + c.p.ms!.check + c.p.ms!.g4);
			const mp = conv.map((c) => (c.p.w * c.p.h) / 1e6);
			md.push(
				'| time per page, Node (ms) | median | p90 | max |',
				'|---|---:|---:|---:|',
				...(['decode', 'analyse', 'binarize', 'check', 'g4', 'flate'] as const).map((k) => `| ${k} | ${q(ms(k), 0.5)} | ${q(ms(k), 0.9)} | ${Math.max(...ms(k))} |`),
				`| analyse + binarize + check + G4 | ${q(tot, 0.5)} | ${q(tot, 0.9)} | ${Math.max(...tot)} |`,
				'',
				`Picture size of converted pages: median ${q(mp, 0.5).toFixed(1)} MP (range ${Math.min(...mp).toFixed(1)}–${Math.max(...mp).toFixed(1)}); resolution median ${q(conv.map((c) => c.p.ppi), 0.5)} ppi.`,
				''
			);
			const ck = (k: keyof CheckRow) => conv.map((c) => Number(c.p.check![k]));
			const limit: Partial<Record<keyof CheckRow, number>> = { lostExtent: r.minExtent, gainedExtent: r.minExtent, lossCoarse: r.lossCoarse, gainCoarse: r.gainCoarse };
			md.push('| "nothing vanished" on converted pages | limit | median | p90 | max |', '|---|---:|---:|---:|---:|');
			for (const k of ['lostExtent', 'lostMean', 'gainedExtent', 'gainedMean', 'lossFine', 'gainFine', 'lossCoarse', 'gainCoarse'] as const) md.push(`| ${k} | ${limit[k] ?? ''} | ${q(ck(k), 0.5)} | ${q(ck(k), 0.9)} | ${Math.max(...ck(k))} |`);
			const rk = (k: 'lossFine' | 'gainFine' | 'lossCoarse' | 'gainCoarse') => conv.filter((c) => c.p.rendered).map((c) => c.p.rendered![k]);
			md.push('', `Cross-check, MuPDF renders of the page before and after at 75 dpi (no edge excuse): largest loss per pixel ${Math.max(...rk('lossFine'))}, gain ${Math.max(...rk('gainFine'))}; over 3 × 3 pixels ${Math.max(...rk('lossCoarse'))} / ${Math.max(...rk('gainCoarse'))}.`, '');
		}
		const orc = conv.filter((c) => c.p.oracle);
		if (orc.length) {
			const bad = orc.filter((c) => (c.p.oracle!.lostExtent ?? 0) >= r.minExtent);
			const badG = orc.filter((c) => (c.p.oracle!.gainedExtent ?? 0) >= r.minExtent);
			md.push(
				`Oracle (the result against the clean render, before scanner traits): converted pages with a lost region of ${r.minExtent} in or more: ${bad.length} of ${orc.length}${bad.length ? ` (${bad.map((c) => `${c.f.id} ${c.p.oracle!.lostExtent} in`).join(', ')})` : ''}; with a gained region: ${badG.length}${badG.length ? ` (${badG.map((c) => `${c.f.id} ${c.p.oracle!.gainedExtent} in`).join(', ')})` : ''}.`,
				''
			);
			const tr = (f: BlResult) => f.traits;
			const phone = pr.filter((x) => tr(x.f) && tr(x.f)!.light < 1);
			md.push(`Phone-like synthetic scans (uneven light): ${phone.length} tried, ${phone.filter((x) => x.p.status === 'converted').length} converted. By resolution: 200 ppi ${pr.filter((x) => x.p.ppi < 250).length} tried / ${conv.filter((x) => x.p.ppi < 250).length} converted; 300 ppi ${pr.filter((x) => x.p.ppi >= 250).length} / ${conv.filter((x) => x.p.ppi >= 250).length}. Grey JPEGs ${pr.filter((x) => tr(x.f)?.grey).length} / ${conv.filter((x) => tr(x.f)?.grey).length}; beige paper ${pr.filter((x) => tr(x.f) && tr(x.f)!.paper[2] < 220).length} / ${conv.filter((x) => tr(x.f) && tr(x.f)!.paper[2] < 220).length}.`, '');
		}
		const vanishedRows = pr.filter((x) => x.p.reason === 'vanished');
		md.push(`"Nothing vanished" turned down ${vanishedRows.length} page${vanishedRows.length === 1 ? '' : 's'} that passed the qualify test.`);
		const checked = pr.filter((x) => x.p.check && x.p.status === 'refused' && x.p.reason !== 'vanished');
		const wouldFail = checked.filter((x) => {
			const c = x.p.check!;
			return !c.ok;
		});
		md.push(`Of ${checked.length} pages the qualify test refused (and that could be binarized), the check alone would also have turned down ${wouldFail.length}.`, '');
		return pr;
	};

	const groups: [string, BlResult[]][] = [
		['The owner\'s notice', rows.filter((f) => f.kind === 'notice')],
		['Hard cases (synthetic)', rows.filter((f) => f.kind === 'hard')],
		['Real scans in the survey, tuning half', rows.filter((f) => f.kind === 'survey' && f.half === 'tune')],
		['Real scans in the survey, held-out half', rows.filter((f) => f.kind === 'survey' && f.half === 'held')],
		['Synthetic scans of survey pages, tuning half', rows.filter((f) => f.kind === 'synth' && f.half === 'tune')],
		['Synthetic scans of survey pages, held-out half', rows.filter((f) => f.kind === 'synth' && f.half === 'held')]
	];
	for (const [t, list] of groups) if (list.length) section(t, list);

	const notice = rows.find((f) => f.kind === 'notice');
	if (notice) {
		md.push('### Notice detail', '');
		for (const p of notice.rows) md.push('```', JSON.stringify(p, null, 1), '```');
		md.push(`File ${kb(notice.size)} as given, ${kb(notice.srcSize ?? NaN)} after the engine opened it, ${kb(notice.outSize ?? NaN)} with the picture converted.`, '');
	}
	const hard = rows.filter((f) => f.kind === 'hard');
	if (hard.length) {
		md.push('### Hard cases', '', '| case | expected | result | reason | colour blocks | grey blocks | orphan share | lost region (in) / coarse | gained region (in) / coarse | G4 |', '|---|---|---|---|---:|---:|---:|---:|---:|---:|');
		for (const f of hard) {
			const p = f.rows[0];
			const res = p?.status === 'converted' ? 'converted' : 'refused';
			const bad = (f.expect === 'accept' && res !== 'converted') || (f.expect === 'refuse' && res !== 'refused');
			md.push(
				`| ${f.id.replace(/^hard-/, '')} | ${f.expect} | ${bad ? '**' + res + '**' : res} | ${p?.reason ?? ''} | ${p?.stats?.colourBlocks ?? ''} | ${p?.stats?.greyBlocks ?? ''} | ${p?.stats?.orphanShare ?? ''} | ${p?.check ? `${p.check.lostExtent} / ${p.check.lossCoarse}` : ''} | ${p?.check ? `${p.check.gainedExtent} / ${p.check.gainCoarse}` : ''} | ${p?.g4 ? kb(p.g4) : ''} |`
			);
		}
		md.push('');
	}
	const survey = rows.filter((f) => f.kind === 'survey');
	if (survey.length) {
		md.push('### Survey pages: per source', '', '| source | half | tried | converted | top refusals |', '|---|---|---:|---:|---|');
		const keys = [...new Set(survey.map((f) => `${f.kind}\t${f.source}\t${f.half}`))].sort();
		for (const k of keys) {
			const [kind, s, h] = k.split('\t');
			const pr = pageRows(survey.filter((f) => f.kind === kind && f.source === s && f.half === h));
			if (!pr.length) continue;
			const top = count(pr.filter((x) => x.p.status === 'refused').map((x) => x.p.reason ?? '?'))
				.slice(0, 4)
				.map(([a, b]) => `${a} ${b}`)
				.join(', ');
			md.push(`| ${kind === 'synth' ? 'synthetic: ' : ''}${s} | ${h} | ${pr.length} | ${pr.filter((x) => x.p.status === 'converted').length} | ${top} |`);
		}
		md.push('');
		const crashed = survey.filter((f) => f.open !== 'ok' || f.message);
		if (crashed.length) md.push(`Files not opened or with an error: ${crashed.length} (${count(crashed.map((f) => (f.message ?? 'open').slice(0, 60))).slice(0, 5).map(([a, b]) => `${a} ×${b}`).join('; ')}).`, '');
	}
	if (fs.existsSync(path.join(out, 'review-notes.md'))) md.push(fs.readFileSync(path.join(out, 'review-notes.md'), 'utf8'));
	fs.writeFileSync(path.join(out, args.get('report') ?? 'report.md'), md.join('\n') + '\n');
	console.log(`report → ${path.join(out, args.get('report') ?? 'report.md')}`);
}
