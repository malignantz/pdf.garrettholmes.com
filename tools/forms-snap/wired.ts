/**
 * `forms:snap wired`: the snap on tap the editor ships, measured through the code
 * the editor calls (engine/snap-tap.ts `tapData`, editor/snap.ts `textAt` and
 * `tickAt`), on the cached ink and the same seeded taps as `run` (evaluate.ts), and
 * scored with the fill-in standard (fill.ts). For comparison the ungated rule of the
 * fill-in re-score (all rules at 0.42, baseline always at the bottom, no cue check)
 * is scored on the same taps.
 *
 * Text tool: taps on text-like widgets; FILL-GOOD when start and baseline are
 * acceptable (fill.ts `textOk`), else FILL-BAD when the snapped blank covers the
 * widget, WRONG when not; a tap that does not snap gets plain placement and counts
 * as NO-SNAP (its plain outcome is reported apart). "Worse than plain": a snap that
 * is FILL-BAD or WRONG where plain placement would have been FILL-GOOD.
 * Check tool: taps on check-like widgets (all, and those where the page draws a
 * small box, ring or box glyph); `tickOk` as in fill.ts.
 * Not blanks: the harm taps of evaluate.ts; the share that snaps at all.
 *
 *   npm run forms:snap -- wired --from DIR --out OUT   (reads DIR/sample.json and DIR/ink, e.g. out-forms-snap or
 *   out-forms-snap/holdout; writes OUT/wired.md and OUT/wired.json, outside the repo)
 */
import fs from 'node:fs';
import path from 'node:path';
import { snapAt } from '../../src/lib/engine/forms-snap';
import { tapData } from '../../src/lib/engine/snap-tap';
import { textAt, tickAt, TEXT_MIN_CONFIDENCE } from '../../src/lib/editor/snap';
import { textLike, type Rect } from '../forms-detect/match';
import type { Args } from '../survey/lib/common';
import { loadSample } from './sample';
import { harmTaps, readInk, rng, seedOf, shapeCue, tapsFor } from './evaluate';
import { fillPlain, printedBox, snapText, textOk, tickOk } from './fill';

type Out = 'good' | 'nosnap' | 'bad' | 'wrong';
interface Row {
	n: number;
	good: number;
	nosnap: number;
	bad: number;
	wrong: number;
	worse: number;
	plainGood: number;
}
const row = (): Row => ({ n: 0, good: 0, nosnap: 0, bad: 0, wrong: 0, worse: 0, plainGood: 0 });

const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
function covers(a: Rect, b: Rect): boolean {
	const ox = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
	const oy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
	return ox * oy > 0 && ox * oy >= 0.5 * Math.min(area(a), area(b));
}
const insideR = (x: number, y: number, r: Rect) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

function add(r: Row, out: Out, plain: string) {
	r.n++;
	r[out]++;
	if (plain === 'good') r.plainGood++;
	if ((out === 'bad' || out === 'wrong') && plain === 'good') r.worse++;
}

export async function wired(args: Args, out: string) {
	const from = path.resolve(args.get('from') ?? out);
	const files = loadSample(from);
	const rows: Record<string, Row> = {};
	const get = (k: string) => (rows[k] ??= row());
	const harm: Record<string, { n: number; text: number; check: number }> = {};
	for (const f of files) {
		const rec = readInk(path.join(from, 'ink', `${f.sha256}.json.gz`));
		if (!rec || rec.error || !f.real) continue;
		for (const pg of rec.pages) {
			if (pg.declined) continue;
			const data = tapData(pg.ink);
			if (!data) continue;
			const page = data.snap;
			const form = f.group === 'form';
			if (form && !pg.truths.length) continue;
			if (form) {
				const r = rng(seedOf(f.sha256, pg.i, 1));
				for (const t of pg.truths) {
					const shape = shapeCue(pg.ink, t.rect);
					for (const tp of tapsFor(page, t, r)) {
						if (tp.model !== 'centre' && !insideR(tp.p[0], tp.p[1], t.rect) && pg.truths.some((o) => o !== t && insideR(tp.p[0], tp.p[1], o.rect))) continue;
						const box = printedBox(pg, page, t.rect);
						const plain = fillPlain(t, tp.p, pg, box, pg.truths);
						const cue = t.cue ? 'cue' : 'no cue';
						if (textLike(t.type)) {
							const at = textAt(data, tp.p);
							const o: Out = !at ? 'nosnap' : textOk(t.rect, { x: at.x, base: at.baseline }) ? 'good' : covers(at.snap.rect, t.rect) ? 'bad' : 'wrong';
							add(get(`text|${tp.model}|${cue}|wired`), o, plain);
							// The ungated rule of the fill-in re-score, same taps.
							const s = snapAt(page, tp.p);
							const u = s && s.kind === 'text' && s.confidence >= TEXT_MIN_CONFIDENCE ? s : null;
							const ou: Out = !u ? 'nosnap' : textOk(t.rect, snapText(u, tp.p, 'tap')) ? 'good' : covers(u.rect, t.rect) ? 'bad' : 'wrong';
							add(get(`text|${tp.model}|${cue}|ungated`), ou, plain);
						} else {
							const at = tickAt(data, tp.p);
							const tick = at ? { cx: (at.box[0] + at.box[2]) / 2, cy: (at.box[1] + at.box[3]) / 2, side: at.box[2] - at.box[0] } : null;
							const o: Out = !at ? 'nosnap' : tickOk(t.rect, box, tick!) ? 'good' : covers(at.snap.rect, t.rect) ? 'bad' : 'wrong';
							add(get(`check|${tp.model}|${cue}|wired`), o, plain);
							if (shape) add(get(`check|${tp.model}|drawn box|wired`), o, plain);
						}
					}
				}
			}
			for (const h of harmTaps(page, pg, form, rng(seedOf(f.sha256, pg.i, 2)))) {
				const e = (harm[h.place] ??= { n: 0, text: 0, check: 0 });
				e.n++;
				if (textAt(data, h.p)) e.text++;
				if (tickAt(data, h.p)) e.check++;
			}
		}
	}
	const pct = (a: number, n: number) => (n ? ((100 * a) / n).toFixed(1) : '–');
	const lines: string[] = [`# Snap on tap through the wired code (${from})`, ''];
	lines.push('| tool, taps, widgets | rule | taps | FILL-GOOD | NO-SNAP | FILL-BAD | WRONG | worse than plain | plain FILL-GOOD |');
	lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
	for (const k of Object.keys(rows).sort()) {
		const [tool, model, cue, rule] = k.split('|');
		const r = rows[k];
		lines.push(`| ${tool}, ${model}, ${cue} | ${rule} | ${r.n} | ${pct(r.good, r.n)} | ${pct(r.nosnap, r.n)} | ${pct(r.bad, r.n)} | ${pct(r.wrong, r.n)} | ${pct(r.worse, r.n)} | ${pct(r.plainGood, r.n)} |`);
	}
	lines.push('', '| not a blank | taps | Text snaps | Check snaps |', '|---|---:|---:|---:|');
	for (const [k, e] of Object.entries(harm)) lines.push(`| ${k} | ${e.n} | ${pct(e.text, e.n)} | ${pct(e.check, e.n)} |`);
	fs.writeFileSync(path.join(out, 'wired.md'), lines.join('\n') + '\n');
	fs.writeFileSync(path.join(out, 'wired.json'), JSON.stringify({ rows, harm }, null, '\t'));
	console.log(lines.join('\n'));
}
