/** `forms:measure report`: numbers from results.jsonl → report.md, report.json, pages.tsv. */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, type Args } from '../survey/lib/common';
import { scorePage, type Sugg, type SuggVerdict, type TruthType } from './match';
import type { SampleFile } from './measure';
import type { FileRecord, PageRecord } from './worker';

const CUTS = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98];
const TYPES: TruthType[] = ['text', 'checkbox', 'radio', 'choice', 'signature'];

interface Tally {
	truth: Record<string, { n: number; cue: number; good: number; any: number; goodCued: number }>;
	sugg: Record<string, Record<SuggVerdict | 'all', number>>;
	files: { perfect: number; mostly: number; mess: number; perfectCued: number; mostlyCued: number; messCued: number; n: number; empty: number; noWrong: number };
}

function newTally(): Tally {
	return { truth: {}, sugg: {}, files: { perfect: 0, mostly: 0, mess: 0, perfectCued: 0, mostlyCued: 0, messCued: 0, n: 0, empty: 0, noWrong: 0 } };
}

interface PageEval {
	file: FileRecord;
	page: PageRecord;
	errors: number;
	errorsCued: number;
	verdicts: SuggVerdict[];
	missed: number;
	missedCued: number;
}

function evalPage(p: PageRecord, cut: number, kinds?: Set<string>, sources?: Set<string>): { score: ReturnType<typeof scorePage>; suggs: PageRecord['suggs'] } {
	const suggs = p.suggs.filter((s) => s.confidence >= cut && (!kinds || kinds.has(s.kind)) && (!sources || sources.has(s.source)));
	return { score: scorePage(p.truths, suggs as Sugg[], p.neutral), suggs };
}

function tallyFile(t: Tally, f: FileRecord, cut: number, pages: PageEval[] | null, kinds?: Set<string>) {
	let errors = 0;
	let errorsCued = 0;
	let truths = 0;
	let cued = 0;
	let anySugg = 0;
	let wrong = 0;
	for (const p of f.pages) {
		const { score, suggs } = evalPage(p, cut, kinds);
		let missed = 0;
		let missedCued = 0;
		p.truths.forEach((tr, i) => {
			const k = tr.type;
			const r = (t.truth[k] ??= { n: 0, cue: 0, good: 0, any: 0, goodCued: 0 });
			r.n++;
			if (tr.cue) r.cue++;
			const m = score.truth[i];
			if (m.s >= 0) r.any++;
			if (m.good) {
				r.good++;
				if (tr.cue) r.goodCued++;
			} else {
				missed++;
				if (tr.cue) missedCued++;
			}
			truths++;
			if (tr.cue) cued++;
		});
		const verdicts: SuggVerdict[] = [];
		suggs.forEach((s, i) => {
			const v = score.sugg[i].verdict;
			verdicts.push(v);
			const r = (t.sugg[s.kind] ??= { all: 0, correct: 0, 'bad-rect': 0, 'wrong-type': 0, duplicate: 0, 'false-positive': 0, neutral: 0 });
			if (v === 'neutral') {
				r.neutral++;
				return;
			}
			r.all++;
			r[v]++;
			anySugg++;
		});
		// A found-but-bad match counts once (as the miss); a pure false positive or duplicate adds one.
		const fp = verdicts.filter((v) => v === 'false-positive' || v === 'duplicate').length;
		wrong += verdicts.filter((v) => v !== 'correct' && v !== 'neutral').length;
		const e = missed + fp;
		const ec = missedCued + fp;
		errors += e;
		errorsCued += ec;
		pages?.push({ file: f, page: p, errors: e, errorsCued: ec, verdicts, missed, missedCued });
	}
	if (truths === 0) return;
	t.files.n++;
	if (anySugg === 0) t.files.empty++;
	else if (wrong === 0) t.files.noWrong++;
	const ok = (e: number, n: number) => (e === 0 ? 'perfect' : e <= Math.max(2, Math.ceil(0.05 * n)) ? 'mostly' : 'mess');
	const o = ok(errors, truths);
	t.files[o]++;
	const oc = ok(errorsCued, cued);
	if (oc === 'perfect') t.files.perfectCued++;
	else if (oc === 'mostly') t.files.mostlyCued++;
	else t.files.messCued++;
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');

function precision(t: Tally, kind?: string) {
	const rows = kind ? [t.sugg[kind]].filter(Boolean) : Object.values(t.sugg);
	const all = rows.reduce((s, r) => s + r.all, 0);
	const ok = rows.reduce((s, r) => s + r.correct, 0);
	return { all, ok };
}

function recall(t: Tally, types: TruthType[], cuedOnly = false) {
	let n = 0;
	let g = 0;
	for (const k of types) {
		const r = t.truth[k];
		if (!r) continue;
		n += cuedOnly ? r.cue : r.n;
		g += cuedOnly ? r.goodCued : r.good;
	}
	return { n, g };
}

export function report(args: Args, out: string) {
	const sample = JSON.parse(fs.readFileSync(path.join(out, 'sample.json'), 'utf8')) as { files: SampleFile[]; excluded: Record<string, number>; pool: Record<string, number>; seed: number };
	const meta = new Map(sample.files.map((f) => [f.sha256, f]));
	const recs = readJsonl<FileRecord>(path.join(args.get('results') ?? path.join(out, 'results.jsonl')));
	const latest = new Map<string, FileRecord>();
	for (const r of recs) latest.set(r.sha256, r);
	const files = [...latest.values()].filter((r) => meta.has(r.sha256));
	const forms = files.filter((r) => meta.get(r.sha256)!.group === 'form');
	const nonforms = files.filter((r) => meta.get(r.sha256)!.group === 'nonform');
	const usable = (r: FileRecord) => !r.error && !r.encrypted && r.pages.some((p) => p.truths.length > 0);
	const formOk = forms.filter(usable);
	const real = formOk.filter((r) => meta.get(r.sha256)!.real);
	const suites = formOk.filter((r) => !meta.get(r.sha256)!.real);
	const lines: string[] = [];
	const say = (s = '') => lines.push(s);
	const json: Record<string, unknown> = {};

	say(`# Flat-form blank detector: measurement`);
	say();
	say(`Sample (seed ${sample.seed}): ${forms.length} form files of ${sample.pool.forms} eligible, ${nonforms.length} non-form files. Excluded before sampling: ${JSON.stringify(sample.excluded)}.`);
	const failed = forms.filter((r) => r.error || r.encrypted);
	say(`Form files that failed to open or need a password: ${failed.length}${failed.length ? ` (${failed.map((r) => (r.error ?? 'password').slice(0, 60)).join('; ')})` : ''}. Form files with no widget on the measured pages: ${forms.length - failed.length - formOk.length}.`);
	say(`Measured: ${formOk.length} form files (${real.length} real-world, ${suites.length} from PDF library test suites), ${formOk.reduce((s, r) => s + r.pages.length, 0)} pages.`);
	say();

	const section = (name: string, set: FileRecord[]) => {
		const t = newTally();
		const pages: PageEval[] = [];
		for (const f of set) tallyFile(t, f, 0, pages);
		say(`## ${name} (${set.length} files, ${pages.length} pages)`);
		say();
		say(`| truth type | widgets | with a visible cue | found, good rectangle | found (any) | good, of cued |`);
		say(`|---|---:|---:|---:|---:|---:|`);
		for (const k of TYPES) {
			const r = t.truth[k];
			if (!r) continue;
			say(`| ${k} | ${r.n} | ${pct(r.cue, r.n)} | ${pct(r.good, r.n)} | ${pct(r.any, r.n)} | ${pct(r.goodCued, r.cue)} |`);
		}
		const tl = recall(t, ['text', 'choice', 'signature']);
		const cl = recall(t, ['checkbox', 'radio']);
		say(`| text-like (text+choice+signature) | ${tl.n} | | ${pct(tl.g, tl.n)} | | ${pct(recall(t, ['text', 'choice', 'signature'], true).g, recall(t, ['text', 'choice', 'signature'], true).n)} |`);
		say(`| check-like (checkbox+radio) | ${cl.n} | | ${pct(cl.g, cl.n)} | | ${pct(recall(t, ['checkbox', 'radio'], true).g, recall(t, ['checkbox', 'radio'], true).n)} |`);
		say();
		say(`| suggestion kind | suggestions | correct (precision) | bad rectangle | wrong type | duplicate | false positive | neutral (on a button/hidden widget) |`);
		say(`|---|---:|---:|---:|---:|---:|---:|---:|`);
		for (const [k, r] of Object.entries(t.sugg)) {
			say(`| ${k} | ${r.all} | ${pct(r.correct, r.all)} | ${pct(r['bad-rect'], r.all)} | ${pct(r['wrong-type'], r.all)} | ${pct(r.duplicate, r.all)} | ${pct(r['false-positive'], r.all)} | ${r.neutral} |`);
		}
		say();
		const fo = t.files;
		say(`Per file (errors = missed widgets + bad rectangles + false positives; "mostly right" = at most max(2, 5% of the widgets)):`);
		say();
		say(`| | all right | mostly right | a mess | no suggestion at all |`);
		say(`|---|---:|---:|---:|---:|`);
		say(`| misses counted over all widgets | ${pct(fo.perfect, fo.n)} | ${pct(fo.mostly, fo.n)} | ${pct(fo.mess, fo.n)} | ${pct(fo.empty, fo.n)} |`);
		say(`| misses counted only where the page shows a cue | ${pct(fo.perfectCued, fo.n)} | ${pct(fo.mostlyCued, fo.n)} | ${pct(fo.messCued, fo.n)} | |`);
		say();
		say(`Confidence cutoff (suggestions below it dropped, then scored again):`);
		say();
		say(`| cutoff | suggestions | precision | text precision | checkbox precision | text-like recall | check-like recall | files with suggestions, none wrong | files all right | files mostly right |`);
		say(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
		const cutRows: unknown[] = [];
		for (const c of CUTS) {
			const tc = newTally();
			for (const f of set) tallyFile(tc, f, c, null);
			const p = precision(tc);
			const pt = precision(tc, 'text');
			const pc = precision(tc, 'checkbox');
			const rt = recall(tc, ['text', 'choice', 'signature']);
			const rc = recall(tc, ['checkbox', 'radio']);
			say(`| ${c} | ${p.all} | ${pct(p.ok, p.all)} | ${pct(pt.ok, pt.all)} | ${pct(pc.ok, pc.all)} | ${pct(rt.g, rt.n)} | ${pct(rc.g, rc.n)} | ${tc.files.noWrong} of ${tc.files.n - tc.files.empty} | ${pct(tc.files.perfect, tc.files.n)} | ${pct(tc.files.mostly, tc.files.n)} |`);
			cutRows.push({ cut: c, n: p.all, precision: p.ok / (p.all || 1), textPrecision: pt.ok / (pt.all || 1), checkPrecision: pc.ok / (pc.all || 1), textRecall: rt.g / (rt.n || 1), checkRecall: rc.g / (rc.n || 1) });
		}
		say();
		// By detector rule.
		const bySource: Record<string, Record<string, number>> = {};
		for (const pe of pages) {
			const { suggs } = evalPage(pe.page, 0);
			suggs.forEach((s, i) => {
				const v = pe.verdicts[i];
				const r = (bySource[s.source] ??= { all: 0, correct: 0 });
				if (v === 'neutral') return;
				r.all++;
				r[v] = (r[v] ?? 0) + 1;
			});
		}
		say(`By detector rule: ${Object.entries(bySource).map(([k, r]) => `${k} ${r.all} (${pct(r.correct, r.all)} correct)`).join(', ')}.`);
		say();
		json[name] = { truth: t.truth, sugg: t.sugg, files: t.files, cuts: cutRows, rules: bySource };
		return pages;
	};

	const realPages = section('Real-world forms', real);
	section('Test-suite forms', suites);
	section('All forms', formOk);

	// Strata.
	const strata = (key: 'source' | 'producer') => {
		const groups = new Map<string, FileRecord[]>();
		for (const f of formOk) {
			const k = meta.get(f.sha256)![key];
			groups.set(k, [...(groups.get(k) ?? []), f]);
		}
		say(`### By ${key}`);
		say();
		say(`| ${key} | files | widgets | cued | text-like recall | check-like recall | precision | files all right | mostly | mess |`);
		say(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
		for (const [k, set] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
			const t = newTally();
			for (const f of set) tallyFile(t, f, 0, null);
			const n = Object.values(t.truth).reduce((s, r) => s + r.n, 0);
			const cue = Object.values(t.truth).reduce((s, r) => s + r.cue, 0);
			const rt = recall(t, ['text', 'choice', 'signature']);
			const rc = recall(t, ['checkbox', 'radio']);
			const p = precision(t);
			say(`| ${k} | ${set.length} | ${n} | ${pct(cue, n)} | ${pct(rt.g, rt.n)} | ${pct(rc.g, rc.n)} | ${pct(p.ok, p.all)} | ${pct(t.files.perfect, t.files.n)} | ${pct(t.files.mostly, t.files.n)} | ${pct(t.files.mess, t.files.n)} |`);
		}
		say();
	};
	strata('source');
	strata('producer');

	// Non-forms.
	const nf = nonforms.filter((r) => !r.error && !r.encrypted);
	const nfPages = nf.flatMap((r) => r.pages.filter((p) => !p.declined));
	say(`## Non-form documents (${nf.length} files, ${nfPages.length} pages with text; scans declined: ${nf.flatMap((r) => r.pages).filter((p) => p.declined).length} pages)`);
	say();
	say(`| cutoff | suggestions per page | pages with any suggestion | text | checkbox |`);
	say(`|---|---:|---:|---:|---:|`);
	const nfRows: unknown[] = [];
	for (const c of CUTS) {
		const ss = nfPages.map((p) => p.suggs.filter((s) => s.confidence >= c));
		const total = ss.reduce((s, x) => s + x.length, 0);
		const withAny = ss.filter((x) => x.length).length;
		const tx = ss.flat().filter((s) => s.kind === 'text').length;
		say(`| ${c} | ${(total / (nfPages.length || 1)).toFixed(2)} | ${pct(withAny, nfPages.length)} | ${tx} | ${total - tx} |`);
		nfRows.push({ cut: c, perPage: total / (nfPages.length || 1), pagesWithAny: withAny / (nfPages.length || 1) });
	}
	say();
	json.nonforms = nfRows;

	// Speed.
	const ms = files.flatMap((r) => r.pages.map((p) => p.ms)).sort((a, b) => a - b);
	const q = (x: number) => ms[Math.min(ms.length - 1, Math.floor(x * ms.length))] ?? 0;
	say(`Speed (collect + detect, Node, one core): median ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${ms.at(-1)} ms per page over ${ms.length} pages.`);
	json.speed = { median: q(0.5), p95: q(0.95), max: ms.at(-1) };

	fs.writeFileSync(path.join(out, 'report.md'), lines.join('\n') + '\n');
	fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(json, null, 1));
	// Worst real-world pages for looking at by eye.
	const tsv = ['sha256\tpage\terrors\terrorsCued\ttruths\tsuggs\tmissed\tfp\tbad\tsource\tproducer\tpath'];
	for (const pe of realPages.sort((a, b) => b.errors - a.errors)) {
		const m = meta.get(pe.file.sha256)!;
		const fp = pe.verdicts.filter((v) => v === 'false-positive' || v === 'duplicate').length;
		const bad = pe.verdicts.filter((v) => v === 'bad-rect' || v === 'wrong-type').length;
		tsv.push([pe.file.sha256, pe.page.i + 1, pe.errors, pe.errorsCued, pe.page.truths.length, pe.page.suggs.length, pe.missed, fp, bad, m.source, m.producer, pe.file.path].join('\t'));
	}
	fs.writeFileSync(path.join(out, 'pages.tsv'), tsv.join('\n') + '\n');
	console.log(lines.join('\n'));
}
