/**
 * Report for the "fill-in" standard (fill.ts): FILL-GOOD / NO-SNAP / FILL-BAD /
 * WRONG-TARGET per tap model and widget class, against today's plain placement.
 * Written to fill-report.md / fill-report.json beside report.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SnapResult } from '../../src/lib/engine/forms-snap';
import { textLike, type Rect, type Truth } from '../forms-detect/match';
import type { Fill } from './fill';
import type { DrawMark } from './worker';

export interface FillTap {
	scope: string;
	model: 'centre' | 'sloppy' | 'near';
	cls: 'text' | 'check';
	cue: boolean;
	real: boolean;
	shape: boolean;
	conf: number;
	/** Text starts at the tap's x (clamped into the snapped rectangle). */
	tap: Fill;
	/** Text always starts at the snapped rectangle's left edge. */
	left: Fill;
	/** Today's plain placement at the tap. */
	plain: Fill;
	/** Plain tick: position only (centre in the box), size ignored. Text: same as plain good. */
	plainPos: boolean;
	/** Old outcome; for BAD-RECT the old failure group. */
	old: string;
}

export interface FillFail {
	sha: string;
	page: number;
	fill: Fill;
	cls: string;
	rule: string;
	truth: Rect;
	tap: [number, number];
	snap: Rect;
	at: { x: number; base: number } | null;
	source: string;
}

export interface FillJson {
	cuts: Record<string, number | null>;
}

type OldCuts = Record<string, { cut: number }> | null;
/** The old (rectangle standard) cutoffs fixed on sample A, by scope name. */
export const d0 = (fixed: OldCuts | Record<string, unknown> | null): OldCuts => fixed as OldCuts;

/** The failure group of an old BAD-RECT. */
export function oldGroup(t: Truth, s: SnapResult, detail: string): string {
	if (detail === 'type') return 'type: wrong class';
	const iou1 = (a0: number, a1: number, b0: number, b1: number) => {
		const o = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
		const u = Math.max(a1, b1) - Math.min(a0, b0);
		return u > 0 ? o / u : 0;
	};
	const r = t.rect;
	const q = s.rect;
	const th = r[3] - r[1];
	const xi = iou1(r[0], r[2], q[0], q[2]);
	if (xi < 0.75 && q[2] - q[0] > r[2] - r[0]) return 'snap wider (widget is part of the drawn space)';
	if (xi < 0.75) return 'snap narrower than the widget';
	if (iou1(r[1], r[3], q[1], q[3]) < 0.4 || Math.abs(r[3] - q[3]) > Math.max(4, 0.4 * th)) return 'height or bottom differs';
	return textLike(t.type) ? 'other' : 'check box size or offset';
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');

interface Shares {
	n: number;
	good: number;
	other: number;
	nosnap: number;
	bad: number;
	wrong: number;
	worse: number;
	better: number;
	/** What the user ends up with: the snap, or plain placement when there is none. */
	endGood: number;
}

function shares(ts: FillTap[], cut: number, mode: 'tap' | 'left' = 'tap'): Shares {
	const s: Shares = { n: ts.length, good: 0, other: 0, nosnap: 0, bad: 0, wrong: 0, worse: 0, better: 0, endGood: 0 };
	for (const t of ts) {
		const raw = t[mode];
		const o: Fill = raw !== 'nosnap' && t.conf < cut ? 'nosnap' : raw;
		s[o]++;
		const plainGood = t.plain === 'good';
		const snapGood = o === 'good' || o === 'other';
		if (o !== 'nosnap' && !snapGood && plainGood) s.worse++;
		if (o !== 'nosnap' && snapGood && !plainGood) s.better++;
		if (o === 'nosnap' ? plainGood : snapGood) s.endGood++;
	}
	return s;
}

const row = (name: string, s: Shares, cut: string) =>
	`| ${name} | ${cut} | ${s.n} | ${pct(s.good, s.n)} | ${pct(s.good + s.other, s.n)} | ${pct(s.nosnap, s.n)} | ${pct(s.bad, s.n)} | ${pct(s.wrong, s.n)} | ${pct(s.worse, s.n)} | ${pct(s.better, s.n)} | ${pct(s.endGood, s.n)} |`;
const HEAD = [
	'| widgets / taps | cutoff | taps | FILL-GOOD | + OTHER-TYPE | NO-SNAP | FILL-BAD | WRONG-TARGET | worse than plain | better than plain | user ends up good (snap, else plain) |',
	'|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
];

/** On the tuning sample: the cutoff with the most FILL-GOOD (incl. other type) where FILL-BAD + WRONG ≤ 3% and worse-than-plain ≤ 1%. */
function chooseCut(ts: FillTap[]): number | null {
	let best: { cut: number; g: number } | null = null;
	for (let k = 0; k <= 100; k++) {
		const s = shares(ts, k / 100);
		if ((s.bad + s.wrong) / (s.n || 1) > 0.03 || s.worse / (s.n || 1) > 0.01) continue;
		if (!best || s.good + s.other > best.g) best = { cut: k / 100, g: s.good + s.other };
	}
	return best?.cut ?? null;
}

export function fillReport(fills: FillTap[], oldCuts: OldCuts, fixed: FillJson | null): { md: string; json: FillJson & Record<string, unknown> } {
	const L: string[] = [];
	const say = (x = '') => L.push(x);
	const real = fills.filter((f) => f.real);
	const json: FillJson & Record<string, unknown> = { cuts: {} };
	const SC = { all: 'all', checks: 'checks (squares, rings, box glyphs, small cells)', drawn: 'drawn checks (squares, rings, box glyphs)' };
	// Populations: [label, scope, filter].
	const pops: [string, string, (f: FillTap) => boolean][] = [
		['text-like, all rules', SC.all, (f) => f.cls === 'text'],
		['check-like, all rules', SC.all, (f) => f.cls === 'check'],
		['all widgets, all rules', SC.all, () => true],
		['check-like, checkbox rules', SC.checks, (f) => f.cls === 'check'],
		['check-like with a drawn box, drawn-checkbox rules', SC.drawn, (f) => f.cls === 'check' && f.shape]
	];
	say('# Tap to snap: fill-in standard');
	say();
	say('Would a person filling in the form be happy with where the typing or tick lands? Rules in tools/forms-snap/fill.ts; every tolerance is a guess. Real-world forms. "Worse than plain": the snap is FILL-BAD or WRONG where today\'s plain placement at the tap would have been FILL-GOOD. "User ends up good": the snap when there is one, else the plain placement.');
	say();
	if (fixed) say('Held-out sample: cutoffs are the ones fixed on the tuning sample (old: chosen under the rectangle standard; new: chosen on the tuning sample under this standard).');
	say();
	for (const [label, scope, keep] of pops) {
		const cutsHere: [string, number | null][] = [['all conf.', 0]];
		const oldName = scope === SC.drawn ? null : scope;
		if (oldName && oldCuts?.[oldName]) cutsHere.push(['old cutoff', oldCuts[oldName].cut]);
		if (scope === SC.drawn) cutsHere.push(['ambiguous dropped', 0.6]);
		const key = `${label}`;
		const chosen = fixed ? (fixed.cuts[key] ?? null) : chooseCut(real.filter((f) => f.scope === scope && keep(f) && f.cue && f.model === 'sloppy'));
		json.cuts[key] = chosen;
		cutsHere.push(['new cutoff', chosen]);
		say(`## ${label}`);
		say();
		say(...HEAD);
		for (const m of ['centre', 'sloppy', 'near'] as const) {
			const ts = real.filter((f) => f.scope === scope && keep(f) && f.cue && f.model === m);
			for (const [cname, c] of cutsHere) {
				if (c === null) {
					say(`| ${m}, cue | ${cname}: none | | | | | | | | | |`);
					continue;
				}
				say(row(`${m}, cue`, shares(ts, c), `${cname}: ${c}`));
			}
			const p = ts.reduce((a, f) => ({ good: a.good + (f.plain === 'good' ? 1 : 0), bad: a.bad + (f.plain === 'bad' ? 1 : 0), wrong: a.wrong + (f.plain === 'wrong' ? 1 : 0), pos: a.pos + (f.plainPos ? 1 : 0) }), { good: 0, bad: 0, wrong: 0, pos: 0 });
			say(`| ${m}, cue: **plain placement** | – | ${ts.length} | ${pct(p.good, ts.length)} | | – | ${pct(p.bad, ts.length)} | ${pct(p.wrong, ts.length)} | | | ${pct(p.good, ts.length)}${label.startsWith('check') ? ` (tick position only: ${pct(p.pos, ts.length)})` : ''} |`);
			if (m === 'sloppy') {
				const nc = real.filter((f) => f.scope === scope && keep(f) && !f.cue && f.model === m);
				say(row(`${m}, no cue`, shares(nc, 0), 'all conf.'));
				const every = real.filter((f) => f.scope === scope && keep(f) && f.model === m);
				for (const [cname, c] of cutsHere) if (c !== null) say(row(`${m}, cue or not`, shares(every, c), `${cname}: ${c}`));
			}
		}
		say();
		// Bar.
		const sl = real.filter((f) => f.scope === scope && keep(f) && f.cue && f.model === 'sloppy');
		for (const [cname, c] of cutsHere) {
			if (c === null) continue;
			const s = shares(sl, c);
			const g = (s.good + s.other) / (s.n || 1);
			const ok = g >= 0.85 && (s.good + s.other + s.nosnap) / (s.n || 1) >= 0.95 && (s.bad + s.wrong) / (s.n || 1) <= 0.03 && s.worse / (s.n || 1) <= 0.01;
			const okStrict = s.good / (s.n || 1) >= 0.85 && (s.good + s.other + s.nosnap) / (s.n || 1) >= 0.95 && (s.bad + s.wrong) / (s.n || 1) <= 0.03 && s.worse / (s.n || 1) <= 0.01;
			say(`Bar (sloppy, cue, ${cname} ${c}): ${ok ? 'meets' : 'short'} counting other-type as good; ${okStrict ? 'meets' : 'short'} without it.`);
			json[`bar ${label} ${cname}`] = { cut: c, ...s, ok, okStrict };
		}
		say();
	}

	// Start x: tap or left edge.
	say('## Text start: at the tap (clamped into the snap) or always at the left edge');
	say();
	say('| text-like, all rules, cue | taps | tap x: FILL-GOOD / FILL-BAD + WRONG | left edge: FILL-GOOD / FILL-BAD + WRONG |');
	say('|---|---:|---|---|');
	for (const m of ['centre', 'sloppy', 'near'] as const) {
		const ts = real.filter((f) => f.scope === SC.all && f.cls === 'text' && f.cue && f.model === m);
		const a = shares(ts, 0, 'tap');
		const b = shares(ts, 0, 'left');
		say(`| ${m} | ${a.n} | ${pct(a.good + a.other, a.n)} / ${pct(a.bad + a.wrong, a.n)} | ${pct(b.good + b.other, b.n)} / ${pct(b.bad + b.wrong, b.n)} |`);
	}
	say();

	// Old BAD-RECT that are fine for filling in.
	say('## Old BAD-RECT taps under the fill-in standard (all rules, cue, sloppy)');
	say();
	say('| old failure group | taps | FILL-GOOD | + OTHER-TYPE | FILL-BAD | WRONG-TARGET |');
	say('|---|---:|---:|---:|---:|---:|');
	const ob = real.filter((f) => f.scope === SC.all && f.cue && f.model === 'sloppy' && !['good', 'nosnap', 'wrong'].includes(f.old));
	const groups = [...new Set(ob.map((f) => f.old))].sort();
	const oj: Record<string, unknown> = {};
	for (const g of [...groups, 'all']) {
		const ts = g === 'all' ? ob : ob.filter((f) => f.old === g);
		const s = shares(ts, 0);
		say(`| ${g} | ${s.n} | ${pct(s.good, s.n)} | ${pct(s.good + s.other, s.n)} | ${pct(s.bad, s.n)} | ${pct(s.wrong, s.n)} |`);
		oj[g] = s;
	}
	json.oldBad = oj;
	const og = real.filter((f) => f.scope === SC.all && f.cue && f.model === 'sloppy' && f.old === 'good');
	const ogs = shares(og, 0);
	say();
	say(`Old GOOD taps that fail the fill-in standard: ${pct(ogs.bad + ogs.wrong, ogs.n)} of ${ogs.n}.`);
	say();
	return { md: L.join('\n') + '\n', json };
}

export function writeFillFails(out: string, xs: FillFail[]) {
	fs.writeFileSync(
		path.join(out, 'fill-fails.tsv'),
		['sha256\tpage\tfill\tclass\trule\tsource\ttruth\ttap\tsnap\tstart_x\tbaseline', ...xs.map((x) => [x.sha, x.page, x.fill, x.cls, x.rule, x.source, x.truth.map((n) => n.toFixed(1)).join(','), x.tap.map((n) => n.toFixed(1)).join(','), x.snap.map((n) => n.toFixed(1)).join(','), x.at?.x.toFixed(1) ?? '', x.at?.base.toFixed(1) ?? ''].join('\t'))].join('\n') + '\n'
	);
	const marks: Record<string, Record<number, DrawMark[]>> = {};
	for (const x of xs) {
		const m = ((marks[x.sha] ??= {})[x.page - 1] ??= []);
		if (m.length > 160) continue;
		m.push({ r: x.truth, color: [0, 0.6, 0], width: 0.6 });
		m.push({ r: x.tap, color: x.fill === 'wrong' ? [1, 0, 0] : [1, 0.55, 0], width: 0.3 });
		m.push({ r: x.snap, color: [0.3, 0.3, 1], width: 0.5 });
		// The text's start and baseline: a short thick line from the start x.
		if (x.at) m.push({ r: [x.at.x, x.at.base - 0.6, x.at.x + 30, x.at.base + 0.6], color: x.fill === 'wrong' ? [1, 0, 0] : [1, 0.55, 0], width: 1.2 });
	}
	fs.writeFileSync(path.join(out, 'fill-marks.json'), JSON.stringify(marks));
}
