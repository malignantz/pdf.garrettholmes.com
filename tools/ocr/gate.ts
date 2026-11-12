/**
 * Page-level decline gate: tuned on the dev pools only (synthetic dev pages at the chosen setting and
 * real scans with an old OCR layer, dev half), then applied unchanged to the held-out synthetic pages,
 * the held-out real scans with an old layer, and the graded real scans without text.
 * A page run is "bad" when exact recall (synthetic) or agreement with the old layer (real) is under 85%.
 *
 *   npm run ocr:gate -- [--out DIR] [--th 2] [--max-bad 0.02]
 * Needs: results/synth-scored-{dev,hold}.jsonl (from `ocr:measure -- report`), results/scan-b-{dev,hold}.jsonl,
 * results/scan-c.jsonl and grade/grades.json. Writes report-gate.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readJsonl } from '../survey/lib/common';
import { addScore, emptyScore, scorePage, signals, type Score, type Signals } from './lib/score';
import { accept, pct, policyUp, type Gate, type Scored } from './report';
import type { ScanResult } from './scan-worker';

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? '/home/garrett/pdf-survey/out-ocr');
const th = args.num('th', 2);
const BAD = 0.85;

interface Row {
	s: Score;
	sig: Signals;
	group: string;
}

const synth = (set: string): Row[] =>
	readJsonl<Scored>(path.join(out, 'results', `synth-scored-${set}.jsonl`))
		.filter((r) => r.model === 'fast' && r.deskew && policyUp(r) && (r.th === th || r.deg === 'bitonal' || r.deg === 'fax'))
		.map((r) => ({ s: r.s, sig: r.sig, group: `synthetic ${r.deg}${r.deg === 'scan' || r.deg === 'bitonal' ? ` ${r.dpi}` : ''}` }));

const layer = (set: string): Row[] => {
	const rows: Row[] = [];
	for (const r of readJsonl<ScanResult>(path.join(out, 'results', `scan-b-${set}.jsonl`)))
		for (const p of r.ocr ?? [])
			for (const run of p.runs) {
				if (p.layer.length < 20 || run.model !== 'fast') continue;
				const k = p.dpi / 72;
				rows.push({ s: scorePage(p.layer, run.words, [k, 0, 0, k, 0, 0]).score, sig: signals(run.words), group: `real with old layer: ${r.source}` });
			}
	return rows;
};

const recall = (s: Score) => (s.nT ? s.ex / s.nT : 0);

const GRID = {
	minConf: [0, 60, 70, 75, 80, 82, 84, 86, 88, 90],
	maxLow60: [1, 0.3, 0.2, 0.15, 0.12, 0.1, 0.08, 0.05],
	minStop: [0, 0.05, 0.08, 0.1, 0.12, 0.15],
	minWordy: [0, 0.8, 0.9, 0.93],
	minWords: [0, 10, 25]
};

function tune(rows: Row[], maxBad: number): { g: Gate; acc: number } {
	let best: { g: Gate; acc: number } = { g: { minConf: 101, maxLow60: 0, minStop: 1, minWordy: 1, minWords: 1e9 }, acc: 0 };
	for (const minConf of GRID.minConf)
		for (const maxLow60 of GRID.maxLow60)
			for (const minStop of GRID.minStop)
				for (const minWordy of GRID.minWordy)
					for (const minWords of GRID.minWords) {
						const g = { minConf, maxLow60, minStop, minWordy, minWords };
						let acc = 0;
						let bad = 0;
						for (const r of rows)
							if (accept(g, r.sig)) {
								acc++;
								if (recall(r.s) < BAD) bad++;
							}
						if (acc > best.acc && bad <= maxBad * acc) best = { g, acc };
					}
	return best;
}

function line(label: string, rows: Row[], g: Gate): string {
	const acc = rows.filter((r) => accept(g, r.sig));
	const s = acc.reduce((a, r) => addScore(a, r.s), emptyScore());
	const bad = acc.filter((r) => recall(r.s) < BAD).length;
	const badAll = rows.filter((r) => recall(r.s) < BAD).length;
	return `| ${label} | ${rows.length} | ${pct(acc.length, rows.length)} | ${pct(s.ex, s.nT)} | ${pct(s.nO - s.ex, s.nO)} | ${pct(bad, acc.length)} (${bad}) | ${badAll - bad} of ${badAll} |`;
}

const dev = [...synth('dev'), ...layer('dev')];
const L = ['# Decline gate', '', `Tuning pool (dev only): ${synth('dev').length} synthetic page runs at the chosen setting and ${layer('dev').length} real scans with an old OCR layer (agreement with the old layer stands in for recall there). Signals from the OCR output only: mean word confidence, share of words under 60, share of the 100 commonest English words, share of word-shaped tokens, word count.`, ''];
const head = '| | page runs | accepted | recall exact (accepted; real: agreement) | junk (accepted) | bad among accepted | bad pages let through |\n|---|---:|---:|---:|---:|---:|---:|';
for (const maxBad of [args.num('max-bad', 0.02), 0.05]) {
	const { g } = tune(dev, maxBad);
	L.push(`## Tuned for at most ${maxBad * 100}% bad among accepted on dev: ${JSON.stringify(g)}`, '', head);
	L.push(line('dev pool', dev, g));
	const hs = synth('hold');
	L.push(line('held-out synthetic, all', hs, g));
	for (const grp of [...new Set(hs.map((r) => r.group))].sort()) L.push(line(`held-out ${grp}`, hs.filter((r) => r.group === grp), g));
	const hl = layer('hold');
	L.push(line('held-out real scans with an old layer (proxy)', hl, g));
	// Graded real scans without text: junk from the sampled words, recall from the strips.
	const gf = path.join(out, 'grade', 'grades.json');
	if (fs.existsSync(gf)) {
		const grades = JSON.parse(fs.readFileSync(gf, 'utf8')) as Record<string, { group: string; wrong: number[]; strips: [number, number][] }>;
		const agg = new Map<string, { n: number; acc: number; w: number; wrong: number; sT: number; sOk: number }>();
		for (const r of readJsonl<ScanResult>(path.join(out, 'results', 'scan-c.jsonl')))
			for (const p of r.ocr ?? []) {
				const key = `${r.sha256.slice(0, 16)}-p${p.i + 1}`;
				const gr = grades[key];
				if (!gr) continue;
				const sig = signals(p.runs[0].words);
				const ok = accept(g, sig);
				for (const k of [gr.group, 'all graded']) {
					const a = agg.get(k) ?? { n: 0, acc: 0, w: 0, wrong: 0, sT: 0, sOk: 0 };
					a.n++;
					if (ok) {
						a.acc++;
						a.w += Math.min(30, sig.words);
						a.wrong += gr.wrong.length;
						a.sT += gr.strips.reduce((x, s) => x + s[0], 0);
						a.sOk += gr.strips.reduce((x, s) => x + s[1], 0);
					}
					agg.set(k, a);
				}
			}
		L.push('', '| graded real scans (no text layer) | pages | accepted | sampled words wrong, accepted pages | strip words read exactly, accepted pages |', '|---|---:|---:|---:|---:|');
		for (const [k, a] of [...agg].sort()) L.push(`| ${k} | ${a.n} | ${a.acc} | ${pct(a.wrong, a.w)} | ${pct(a.sOk, a.sT)} |`);
	}
	L.push('');
}
fs.writeFileSync(path.join(out, 'report-gate.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
