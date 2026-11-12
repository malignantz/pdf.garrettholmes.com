/**
 * Report for the synthetic-scan measurement: scores every OCR run of results/synth-<set>.jsonl
 * (lib/score.ts), then tables by condition, document kind and font size, a page-level
 * decline gate tuned on the dev set and applied once to the held-out set, and a word-level
 * confidence filter. Writes <out>/report-synth.md and <out>/results/synth-scored-<set>.jsonl.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, type Args } from '../survey/lib/common';
import { addScore, emptyScore, scorePage, signals, SIZE_BUCKETS, type Score, type Signals } from './lib/score';
import type { Run, SynthPage, SynthResult } from './synth-worker';

export interface Scored {
	set: string;
	sha: string;
	page: number;
	kind: string;
	source: string;
	dpi: number;
	deg: string;
	up: boolean;
	th: number;
	deskew: boolean;
	model: string;
	angle: number;
	s: Score;
	sig: Signals;
	ms: number;
	/** Score with words below confidence k dropped, k in CONF_CUTS. */
	byConf: Score[];
}

export const CONF_CUTS = [0, 30, 50, 60, 70, 80];
const BAD = 0.85;

export const pct = (a: number, b: number, d = 1) => (b ? `${((100 * a) / b).toFixed(d)}%` : '–');
export const quant = (v: number[], q: number) => {
	if (!v.length) return 0;
	const s = [...v].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
export const recall = (s: Score) => (s.nT ? s.ex / s.nT : 0);

export function scoreAll(out: string, set: string): Scored[] {
	const cache = path.join(out, 'results', `synth-scored-${set}.jsonl`);
	const src = path.join(out, 'results', `synth-${set}.jsonl`);
	if (fs.existsSync(cache) && fs.statSync(cache).mtimeMs > fs.statSync(src).mtimeMs) return readJsonl<Scored>(cache);
	const rows: Scored[] = [];
	for (const r of readJsonl<SynthResult>(src))
		for (const p of r.pages as SynthPage[])
			for (const run of p.runs as Run[]) {
				const { score } = scorePage(p.truth, run.words, run.m, p.ignore);
				const byConf = CONF_CUTS.map((k) => (k === 0 ? score : scorePage(p.truth, run.words, run.m, p.ignore, k, false).score));
				rows.push({ set, sha: p.sha256, page: p.page, kind: p.kind, source: p.source, dpi: run.dpi, deg: run.deg, up: run.up, th: run.th ?? 0, deskew: run.deskew ?? false, model: run.model, angle: run.p.angle ?? 0, s: score, sig: signals(run.words), ms: run.ms, byConf });
			}
	fs.writeFileSync(cache, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
	return rows;
}

export function sum(rows: Scored[], f: (r: Scored) => Score = (r) => r.s): Score {
	return rows.reduce((a, r) => addScore(a, f(r)), emptyScore());
}

export function row(label: string, rows: Scored[]): string {
	const s = sum(rows);
	const bad = rows.filter((r) => recall(r.s) < BAD).length;
	const ms = rows.map((r) => r.ms);
	return `| ${label} | ${rows.length} | ${pct(s.ex, s.nT)} | ${pct(s.e1, s.nT)} | ${pct(s.nO - s.ex, s.nO)} | ${pct(s.ce, s.ch)} | ${pct(s.right, s.bm)} | ${pct(s.flood, s.bm)} | ${pct(s.miss, s.bm)} | ${pct(bad, rows.length)} | ${(quant(ms, 0.5) / 1000).toFixed(1)} / ${(quant(ms, 0.9) / 1000).toFixed(1)} |`;
}
export const HEAD = `| | pages | recall exact | recall ≤1 edit | junk (1 − precision) | CER | boxes right | paint a neighbour | miss ink > 1 pt | bad pages (recall < 85%) | Node s/page p50 / p90 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`;

/** The OCR input the feature would use: images under 300 dpi enlarged to 300 ("up"), 300 as is. */
export const policyUp = (r: Scored) => (r.dpi < 300 ? r.up : !r.up);

export interface Gate {
	minConf: number;
	maxLow60: number;
	minStop: number;
	minWordy: number;
	minWords: number;
}
export const NO_GATE: Gate = { minConf: 0, maxLow60: 1, minStop: 0, minWordy: 0, minWords: 0 };
export const accept = (g: Gate, s: Signals) => s.words >= g.minWords && s.meanConf >= g.minConf && s.low60 <= g.maxLow60 && s.stop >= g.minStop && s.wordy >= g.minWordy;

/** Best gate on `rows`: most pages accepted with at most `maxBad` of accepted pages bad. */
export function tuneGate(rows: { s: Score; sig: Signals }[], maxBad: number): Gate {
	let best: { g: Gate; acc: number } | null = null;
	for (const minConf of [0, 50, 60, 65, 70, 75, 78, 80, 82, 84, 86, 88, 90])
		for (const maxLow60 of [1, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.07, 0.05])
			for (const minStop of [0, 0.03, 0.06, 0.1])
				for (const minWordy of [0, 0.6, 0.7, 0.8, 0.85, 0.9])
					for (const minWords of [0, 10, 25]) {
						const g = { minConf, maxLow60, minStop, minWordy, minWords };
						const acc = rows.filter((r) => accept(g, r.sig));
						const bad = acc.filter((r) => recall(r.s) < BAD).length;
						if (acc.length && bad <= maxBad * acc.length && (!best || acc.length > best.acc)) best = { g, acc: acc.length };
					}
	return best?.g ?? { minConf: 101, maxLow60: 0, minStop: 1, minWordy: 1, minWords: 1e9 };
}

export function gateLine(label: string, rows: Scored[], g: Gate): string {
	const acc = rows.filter((r) => accept(g, r.sig));
	const s = sum(acc);
	const bad = acc.filter((r) => recall(r.s) < BAD).length;
	const badAll = rows.filter((r) => recall(r.s) < BAD).length;
	return `| ${label} | ${rows.length} | ${pct(acc.length, rows.length)} | ${pct(s.ex, s.nT)} | ${pct(s.nO - s.ex, s.nO)} | ${pct(s.right, s.bm)} | ${pct(bad, acc.length)} (${bad}) | ${pct(badAll - bad, badAll)} of ${badAll} |`;
}
export const GATE_HEAD = `| | page runs | accepted | recall exact (accepted) | junk (accepted) | boxes right | bad among accepted | bad pages declined |\n|---|---:|---:|---:|---:|---:|---:|---:|`;

const TYPED = ['clean', 'scan', 'bitonal'];

export function report(args: Args, out: string) {
	const sets = (args.get('sets') ?? 'dev,hold').split(',').filter((s) => fs.existsSync(path.join(out, 'results', `synth-${s}.jsonl`)));
	const L: string[] = ['# OCR on synthetic scans (born-digital pages, rendered and degraded)', ''];
	const all = new Map<string, Scored[]>();
	for (const set of sets) all.set(set, scoreAll(out, set));
	const model = args.get('model') ?? 'fast';
	// Binarisation used outside the condition table (bitonal and fax images are black and white already).
	const th = args.num('th', 0);
	const pickTh = (r: Scored) => (r.th === th || r.deg === 'bitonal' || r.deg === 'fax') && r.deskew;
	for (const set of sets) {
		const rows = all.get(set)!;
		const pageKeys = new Map<string, string>();
		for (const r of rows) pageKeys.set(`${r.sha}:${r.page}`, r.kind);
		const files = new Set(rows.map((r) => r.sha));
		const kinds = new Map<string, number>();
		for (const k of pageKeys.values()) kinds.set(k, (kinds.get(k) ?? 0) + 1);
		const tw = rows.filter((r) => r.model === 'fast' && r.dpi === 300 && r.deg === 'clean').reduce((a, r) => a + r.s.nT, 0);
		L.push(`## ${set === 'dev' ? 'Dev set (tuning)' : 'Held-out set'}`, '', `${pageKeys.size} pages from ${files.size} files, ${tw} true words. Kinds: ${[...kinds].map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
		L.push('### By condition', '', HEAD);
		const order = ['clean', 'scan', 'bitonal', 'fax', 'phone'];
		const configs = [...new Set(rows.map((r) => `${order.indexOf(r.deg)}|${r.deg}|${String(r.dpi).padStart(3, '0')}|${r.up ? 1 : 0}|${r.th}|${r.deskew ? 1 : 0}|${r.model}`))].sort();
		for (const c of configs) {
			const [, deg, dpi, up, th, ds, m] = c.split('|');
			const rs = rows.filter((r) => r.deg === deg && r.dpi === Number(dpi) && r.up === (up === '1') && r.th === Number(th) && r.deskew === (ds === '1') && r.model === m);
			L.push(row(`${deg} ${Number(dpi)} dpi${up === '1' ? ' → 300' : ''}, th ${th}${ds === '1' ? '' : ', no deskew'}, ${m}`, rs));
		}
		const rowsT = rows.filter(pickTh);
		L.push('', `Below: binarisation ${th} (tesseract thresholding_method) for grey images.`);
		const typed = (r: Scored) => TYPED.includes(r.deg) && policyUp(r);
		for (const m of ['fast', 'best_int']) {
			L.push('', `### Typed scans (clean, scan, bitonal), ${m}, 150/200 enlarged to 300`, '', HEAD);
			L.push(row('all dpi', rowsT.filter((r) => r.model === m && typed(r))));
			L.push(row('200 and 300 dpi', rowsT.filter((r) => r.model === m && typed(r) && r.dpi >= 200)));
			L.push(row('300 dpi', rowsT.filter((r) => r.model === m && typed(r) && r.dpi === 300)));
		}
		L.push('', `### By document kind (${model}; clean, scan and bitonal; 200 and 300 dpi, 200 enlarged)`, '', HEAD);
		for (const k of [...kinds.keys()].sort()) L.push(row(k, rowsT.filter((r) => r.model === model && typed(r) && r.dpi >= 200 && r.kind === k)));
		L.push('', `### By font size (${model}; clean, scan, bitonal): recall exact (true words)`, '', `| scan dpi (OCR input) | ${SIZE_BUCKETS.map((b) => b[0]).join(' | ')} |`, `|---|${SIZE_BUCKETS.map(() => '---:').join('|')}|`);
		for (const [label, f] of [
			['150 (as is)', (r: Scored) => r.dpi === 150 && !r.up],
			['150 → 300', (r: Scored) => r.dpi === 150 && r.up],
			['200 (as is)', (r: Scored) => r.dpi === 200 && !r.up],
			['200 → 300', (r: Scored) => r.dpi === 200 && r.up],
			['300', (r: Scored) => r.dpi === 300]
		] as [string, (r: Scored) => boolean][]) {
			const s = sum(rowsT.filter((r) => r.model === model && TYPED.includes(r.deg) && f(r)));
			L.push(`| ${label} | ${s.sz.map((b) => `${pct(b[1], b[0])} (${b[0]})`).join(' | ')} |`);
		}
		L.push('', `### Skew (${model}, scan + bitonal, enlarged policy)`, '', HEAD);
		const sk = rowsT.filter((r) => r.model === model && ['scan', 'bitonal'].includes(r.deg) && policyUp(r));
		L.push(row('|angle| < 0.5°', sk.filter((r) => Math.abs(r.angle) < 0.5)));
		L.push(row('0.5–1.25°', sk.filter((r) => Math.abs(r.angle) >= 0.5 && Math.abs(r.angle) < 1.25)));
		L.push(row('1.25–2°', sk.filter((r) => Math.abs(r.angle) >= 1.25)));
		L.push('', `### Word-level confidence filter (${model}; typed, 200 and 300 dpi, enlarged policy)`, '', `| drop words below | recall exact | recall ≤1 | junk | words kept |`, `|---|---:|---:|---:|---:|`);
		const base = rowsT.filter((r) => r.model === model && typed(r) && r.dpi >= 200);
		const s0 = sum(base);
		CONF_CUTS.forEach((k, i) => {
			const s = sum(base, (r) => r.byConf[i]);
			L.push(`| ${k} | ${pct(s.ex, s.nT)} | ${pct(s.e1, s.nT)} | ${pct(s.nO - s.ex, s.nO)} | ${pct(s.nO, s0.nO)} |`);
		});
		L.push('');
	}
	if (all.has('dev')) {
		L.push('## Page-level decline gate', '', 'Tuned on dev (most page runs accepted with at most 2% of accepted ones bad, recall < 85%), applied unchanged to held-out. Tuning pool: every condition (clean, scan, bitonal, fax, phone) at the enlarged policy.', '');
		for (const m of ['fast', 'best_int']) {
			const pool = (set: string) => (all.get(set) ?? []).filter((r) => r.model === m && policyUp(r) && pickTh(r));
			const g = tuneGate(pool('dev'), 0.02);
			L.push(`### ${m}: gate ${JSON.stringify(g)}`, '', GATE_HEAD);
			for (const set of sets) {
				const rs = pool(set);
				L.push(gateLine(`${set}: all conditions`, rs, g));
				L.push(gateLine(`${set}: typed, all dpi`, rs.filter((r) => TYPED.includes(r.deg)), g));
				L.push(gateLine(`${set}: typed, 200 and 300 dpi`, rs.filter((r) => TYPED.includes(r.deg) && r.dpi >= 200), g));
				L.push(gateLine(`${set}: typed, 150 dpi`, rs.filter((r) => TYPED.includes(r.deg) && r.dpi === 150), g));
				L.push(gateLine(`${set}: fax`, rs.filter((r) => r.deg === 'fax'), g));
				L.push(gateLine(`${set}: phone`, rs.filter((r) => r.deg === 'phone'), g));
				L.push(gateLine(`${set}: no gate, all conditions`, rs, NO_GATE));
			}
			L.push('');
		}
	}
	fs.writeFileSync(path.join(out, 'report-synth.md'), L.join('\n') + '\n');
	console.log(L.join('\n'));
}
