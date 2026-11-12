/**
 * Highlighter over OCR text layers, before and after the band rule for ink-less lines
 * (src/lib/engine/page-text.ts), on the measurement's layer pages
 * (/home/garrett/pdf-survey/out-ocr/layer/pages/pNN, survey-derived, read only):
 *  (a) the prototype's layer (after-gap-tz-0.2.pdf, gold = its ocr.json), as measured (4.5% flood);
 *  (b) the app's own export with "Make scanned pages searchable" on before.pdf
 *      (gold = the words the pipeline wrote, from its trace).
 *
 *   node --experimental-transform-types --no-warnings --import ./tools/survey/register.mjs tools/ocr/wired/hl.ts
 * Writes <out>/hl.md and <out>/hl.jsonl.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as mupdf from 'mupdf';
import type { OcrTrace } from '../../../src/lib/engine/ocr/stage';
import { OUT, hlScore, hlScoreTurned, pct, unturned, wiredEngine, type B } from './common';

const PAGES = '/home/garrett/pdf-survey/out-ocr/layer/pages';
interface Ocr {
	dpi: number;
	lines: { words: [string, number, number, number, number, number][] }[];
}
type S = ReturnType<typeof hlScore>;
const add = (a: S, b: S): S => ({ gold: a.gold + b.gold, offered: a.offered + b.offered, miss: a.miss + b.miss, flood: a.flood + b.flood, right: a.right + b.right });
const zero = (): S => ({ gold: 0, offered: 0, miss: 0, flood: 0, right: 0 });

const rows: Record<string, unknown>[] = [];
const tot = { protoOld: zero(), protoNew: zero(), wiredOld: zero(), wiredNew: zero(), turnedOld: zero(), turnedNew: zero() };
let wiredPages = 0;
let traces: OcrTrace[] = [];
const eng = wiredEngine((t) => traces.push(t));
const ids = fs.readdirSync(PAGES).filter((d) => /^p\d\d$/.test(d)).sort();
for (const id of ids) {
	if (id === 'p21') continue; // sideways page, reported apart in the measurement
	const dir = path.join(PAGES, id);
	const ocr = JSON.parse(fs.readFileSync(path.join(dir, 'ocr.json'), 'utf8')) as Ocr;
	const k = 72 / ocr.dpi;
	const gold = ocr.lines.flatMap((l, li) => l.words.map((x) => ({ t: x[0], b: [x[1] * k, x[2] * k, x[3] * k, x[4] * k] as B, line: li })));
	const proto = mupdf.Document.openDocument(fs.readFileSync(path.join(dir, 'after-gap-tz-0.2.pdf')), 'application/pdf');
	const po = hlScore(proto, 0, gold, { inklessCut: false });
	const pn = hlScore(proto, 0, gold);
	proto.destroy();
	tot.protoOld = add(tot.protoOld, po);
	tot.protoNew = add(tot.protoNew, pn);
	const row: Record<string, unknown> = { id, protoOld: po, protoNew: pn };
	// The app's export of the same page.
	traces = [];
	const before = new Uint8Array(fs.readFileSync(path.join(dir, 'before.pdf')));
	try {
		const src = await eng.openPdf(before, `${id}.pdf`);
		const res = await eng.exportPlan({ pages: [{ id: 'a', sourceId: src.id, pageIndex: 0, rotation: 0, stamps: [] }], options: { filename: 'o.pdf', compress: false, stripMetadata: false, ocr: true } }, [src], [], {});
		row.report = res.ocr;
		const t = traces[0];
		row.outcome = t ? (t.outcome.ok ? 'ok' : t.outcome.why) : 'not tried';
		if (res.ocr?.searchable.length && t?.outcome.ok) {
			const { words, line } = unturned(t.outcome.read);
			const g = words.map((w, i) => ({ t: w[0], b: [w[1] * (72 / 300), w[2] * (72 / 300), w[3] * (72 / 300), w[4] * (72 / 300)] as B, line: line[i] }));
			const out = mupdf.Document.openDocument(res.bytes, 'application/pdf');
			const wo = hlScore(out, 0, g, { inklessCut: false });
			const wn = hlScore(out, 0, g);
			const to = hlScoreTurned(out, 0, t.outcome.read, 300, { inklessCut: false });
			const tn = hlScoreTurned(out, 0, t.outcome.read);
			out.destroy();
			tot.turnedOld = add(tot.turnedOld, to);
			tot.turnedNew = add(tot.turnedNew, tn);
			Object.assign(row, { turnedOld: to, turnedNew: tn });
			tot.wiredOld = add(tot.wiredOld, wo);
			tot.wiredNew = add(tot.wiredNew, wn);
			wiredPages++;
			Object.assign(row, { wiredOld: wo, wiredNew: wn });
		}
	} catch (e) {
		row.error = String(e);
	}
	rows.push(row);
	console.log(id, JSON.stringify(row).slice(0, 300));
}
const line = (label: string, s: S) => `| ${label} | ${s.gold} | ${pct(s.offered, s.gold)} | ${pct(s.right, s.offered)} | ${pct(s.flood, s.offered)} | ${pct(s.miss, s.offered)} |`;
const L = [
	'# Highlighter on OCR text layers: band rule for ink-less lines',
	'',
	`Pages: the measurement's layer pages (${ids.length - 1}: 21 + the upright rotated one; the sideways page left out). Right = offered, gold ink within 1 pt of the box, no neighbour painted (flood: more than 15% of a word height into a word of another line).`,
	'',
	'| layer, highlighter rule | gold words | offered | right (of offered) | paints a neighbour | misses ink > 1 pt |',
	'|---|---:|---:|---:|---:|---:|',
	line('prototype layer, old rule (the measurement)', tot.protoOld),
	line('prototype layer, new rule', tot.protoNew),
	line(`app export (${wiredPages} pages made searchable), old rule`, tot.wiredOld),
	line(`app export (${wiredPages} pages made searchable), new rule`, tot.wiredNew),
	line(`app export, each word in its own frame (as the measurement's box score), old rule`, tot.turnedOld),
	line(`app export, each word in its own frame, new rule`, tot.turnedNew),
	'',
	'| page | outcome in the app | prototype old → new flood | app old → new flood | app, own frame: old → new flood (miss) |',
	'|---|---|---:|---:|---:|',
	...rows.map((r) => {
		const f = (s?: S) => (s ? `${s.flood}/${s.offered}` : '–');
		const t = r.turnedNew as S | undefined;
		return `| ${r.id} | ${r.outcome ?? r.error} | ${f(r.protoOld as S)} → ${f(r.protoNew as S)} | ${f(r.wiredOld as S)} → ${f(r.wiredNew as S)} | ${f(r.turnedOld as S)} → ${f(t)}${t ? ` (${t.miss})` : ''} |`;
	})
];
fs.writeFileSync(path.join(OUT, 'hl.md'), L.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'hl.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(L.join('\n'));
process.exit(0);
