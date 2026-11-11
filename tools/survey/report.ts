/** `report`: profiles + results → out/report.md and out/report.json. */
import fs from 'node:fs';
import path from 'node:path';
import { outDir, readJsonl, type Args } from './lib/common';
import * as R from './lib/raster';
import { traitsOf } from './lib/traits';
import type { Outcome, RunResult } from './run-worker';
import { latestProfiles } from './sample';

const OUTCOMES: Outcome[] = ['verified', 'refused', 'crashed', 'wrong', 'suspect', 'needs-password', 'skipped'];
/** Outcomes that count as an attempt (the denominator of the percentages). */
const ATTEMPTED: Outcome[] = ['verified', 'refused', 'crashed', 'wrong', 'suspect'];
const BAD: Outcome[] = ['refused', 'crashed', 'wrong'];
/** A trait value needs this many files in the results to get a row in "outcome by trait". */
const MIN_TRAIT_FILES = 3;

/** Digits, paths and long tokens out, so similar failures group together. */
export function normalise(s: string): string {
	return s
		.replace(/\/[\w./-]+/g, '<path>')
		.replace(/"[^"]{20,}"/g, '"…"')
		.replace(/\d+(\.\d+)?/g, '#')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 180);
}

/** Latest row per (file, scenario). */
function latestResults(out: string): RunResult[] {
	const m = new Map<string, RunResult>();
	for (const r of readJsonl<RunResult>(path.join(out, 'results.jsonl'))) m.set(`${r.sha256}\0${r.scenario}`, r);
	return [...m.values()];
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '–');
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export async function reportCommand(args: Args) {
	const out = outDir(args);
	const label = args.get('label') ?? '';
	const profiles = latestProfiles(out, args.get('profiles'));
	const results = latestResults(out);
	const scenarios = [...new Set(results.map((r) => r.scenario))];

	// Headline.
	const headline = scenarios.map((s) => {
		const rows = results.filter((r) => r.scenario === s);
		const counts = Object.fromEntries(OUTCOMES.map((o) => [o, rows.filter((r) => r.outcome === o).length])) as Record<Outcome, number>;
		const attempted = ATTEMPTED.reduce((n, o) => n + counts[o], 0);
		return { scenario: s, files: rows.length, attempted, counts };
	});

	// Groups.
	type Group = { key: string; outcome: Outcome; code: string; text: string; count: number; scenarios: Record<string, number>; examples: string[] };
	const groupBy = (rows: RunResult[], text: (r: RunResult) => string) => {
		const g = new Map<string, Group>();
		for (const r of rows) {
			const t = normalise(text(r));
			const key = `${r.outcome}\0${r.code ?? ''}\0${t}`;
			let e = g.get(key);
			if (!e) g.set(key, (e = { key, outcome: r.outcome, code: r.code ?? '', text: t, count: 0, scenarios: {}, examples: [] }));
			e.count++;
			e.scenarios[r.scenario] = (e.scenarios[r.scenario] ?? 0) + 1;
			if (e.examples.length < 3 && !e.examples.includes(r.path)) e.examples.push(r.path);
		}
		return [...g.values()].sort((a, b) => b.count - a.count);
	};
	const checkNames = (r: RunResult) => (r.detail ?? '').split(' | ').map((d) => d.split(':')[0]).filter(Boolean).join(', ');
	const refusals = groupBy(
		results.filter((r) => r.outcome === 'refused'),
		(r) => `${r.message ?? ''}${r.code === 'verification-failed' && r.detail ? ` [failed: ${checkNames(r)}]` : ''}`
	);
	const crashes = groupBy(
		results.filter((r) => r.outcome === 'crashed'),
		(r) => (r.code === 'internal' ? (r.detail ?? r.message ?? '') : (r.message ?? ''))
	);
	const failures = groupBy(
		results.filter((r) => BAD.includes(r.outcome) || r.outcome === 'suspect'),
		(r) => (r.outcome === 'refused' ? (r.message ?? '') : r.outcome === 'crashed' && r.code === 'internal' ? (r.detail ?? r.message ?? '') : (r.detail ?? r.message ?? ''))
	);

	// Outcome by trait.
	const bySha = new Map<string, RunResult[]>();
	for (const r of results) bySha.set(r.sha256, [...(bySha.get(r.sha256) ?? []), r]);
	type TraitRow = { feature: string; files: number; attempts: number; refused: number; crashed: number; wrong: number; suspect: number; badRate: number };
	const traitRows = new Map<string, TraitRow>();
	for (const [sha, rows] of bySha) {
		const p = profiles.get(sha);
		if (!p) continue;
		for (const [k, v] of Object.entries(traitsOf(p))) {
			const f = `${k}=${v}`;
			let t = traitRows.get(f);
			if (!t) traitRows.set(f, (t = { feature: f, files: 0, attempts: 0, refused: 0, crashed: 0, wrong: 0, suspect: 0, badRate: 0 }));
			t.files++;
			for (const r of rows) {
				if (!ATTEMPTED.includes(r.outcome)) continue;
				t.attempts++;
				if (r.outcome === 'refused') t.refused++;
				if (r.outcome === 'crashed') t.crashed++;
				if (r.outcome === 'wrong') t.wrong++;
				if (r.outcome === 'suspect') t.suspect++;
			}
		}
	}
	const traits = [...traitRows.values()]
		// "=unknown" values only repeat profile=partial/failed, so they are left out.
		.filter((t) => t.files >= MIN_TRAIT_FILES && t.attempts > 0 && !t.feature.endsWith('=unknown'))
		.map((t) => ({ ...t, badRate: (t.refused + t.crashed + t.wrong) / t.attempts }))
		.sort((a, b) => b.badRate - a.badRate || b.files - a.files);
	const overallBad = results.filter((r) => BAD.includes(r.outcome)).length / Math.max(1, results.filter((r) => ATTEMPTED.includes(r.outcome)).length);

	// Slowest.
	const slowest = [...results]
		.filter((r) => r.ms > 0)
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 15)
		.map((r) => ({ path: r.path, scenario: r.scenario, ms: r.ms, outcome: r.outcome, size: profiles.get(r.sha256)?.size ?? 0, pages: profiles.get(r.sha256)?.pages ?? null }));
	const peak = [...results].sort((a, b) => b.peakMB - a.peakMB).slice(0, 5).map((r) => ({ path: r.path, scenario: r.scenario, peakMB: r.peakMB }));

	const thresholds = {
		RENDER_DPI: R.RENDER_DPI,
		RENDER_MAX_PX: R.RENDER_MAX_PX,
		PIXEL_LEVEL: R.PIXEL_LEVEL,
		INK_LUMA: R.INK_LUMA,
		MIN_INK_SHARE: R.MIN_INK_SHARE,
		MIN_DIFF_PIXELS: R.MIN_DIFF_PIXELS,
		WRONG_FRACTION: R.WRONG_FRACTION,
		SUSPECT_FRACTION: R.SUSPECT_FRACTION,
		SIZE_SLACK_PX: R.SIZE_SLACK_PX,
		LOSSY_MEAN_SUSPECT: R.LOSSY_MEAN_SUSPECT
	};
	const sampleInfo = fs.existsSync(path.join(out, 'sample.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'sample.json'), 'utf8')) : null;
	const data = {
		created: new Date().toISOString(),
		label,
		profiles: profiles.size,
		sampledFiles: sampleInfo?.files?.length ?? null,
		filesWithResults: bySha.size,
		thresholds,
		headline,
		refusals,
		crashes,
		traits,
		overallBadRate: overallBad,
		slowest,
		peak,
		failures: failures.slice(0, 40)
	};
	fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(data, null, 1));

	const md: string[] = [];
	md.push(`# PDF survey report${label ? ` — ${label}` : ''}`, '');
	md.push(`Generated ${data.created}. ${profiles.size} files profiled, ${data.sampledFiles ?? '?'} sampled, ${bySha.size} with results.`, '');
	md.push('Outcomes: **verified** (export returned, all engine checks ok, independent checks agree); **refused** (EngineError with a user-facing message); **crashed** (internal engine error, unexpected exception, timeout or memory cap); **wrong** (engine verified it but an independent check disagrees); **suspect** (an independent check is borderline; look at the files in out/suspects/); **needs-password** (clean, not attempted); **skipped** (scenario does not apply). Percentages are of attempts (verified + refused + crashed + wrong + suspect).', '');
	md.push('## Headline', '');
	md.push('| scenario | files | verified | refused | crashed | wrong | suspect | needs password | skipped |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
	for (const h of headline) {
		const c = h.counts;
		const cell = (o: Outcome) => `${c[o]} (${pct(c[o], h.attempted)})`;
		md.push(`| ${h.scenario} | ${h.files} | ${cell('verified')} | ${cell('refused')} | ${cell('crashed')} | ${cell('wrong')} | ${cell('suspect')} | ${c['needs-password']} | ${c.skipped} |`);
	}
	md.push('', '## Refusal reasons', '');
	if (!refusals.length) md.push('None.');
	else {
		md.push('| count | code | message | scenarios |', '|---:|---|---|---|');
		for (const g of refusals.slice(0, 30)) md.push(`| ${g.count} | ${g.code} | ${esc(g.text)} | ${fmtScen(g.scenarios)} |`);
	}
	md.push('', '## Crash groups', '');
	if (!crashes.length) md.push('None.');
	else {
		md.push('| count | kind | detail | scenarios | example |', '|---:|---|---|---|---|');
		for (const g of crashes.slice(0, 30)) md.push(`| ${g.count} | ${g.code} | ${esc(g.text)} | ${fmtScen(g.scenarios)} | ${esc(g.examples[0] ?? '')} |`);
	}
	md.push('', `## Outcome by trait`, '', `Trait values with at least ${MIN_TRAIT_FILES} files, worst first. "bad" = refused + crashed + wrong, as a share of attempts. Overall bad rate: ${(overallBad * 100).toFixed(1)}%.`, '');
	md.push('| trait=value | files | attempts | bad | refused | crashed | wrong | suspect |', '|---|---:|---:|---:|---:|---:|---:|---:|');
	for (const t of traits.slice(0, 60)) {
		md.push(`| ${t.feature} | ${t.files} | ${t.attempts} | ${(t.badRate * 100).toFixed(1)}% | ${t.refused} | ${t.crashed} | ${t.wrong} | ${t.suspect} |`);
	}
	md.push('', '## Slowest', '', '| ms | scenario | outcome | size | pages | file |', '|---:|---|---|---:|---:|---|');
	for (const s of slowest) md.push(`| ${s.ms} | ${s.scenario} | ${s.outcome} | ${(s.size / 1024 / 1024).toFixed(1)} MB | ${s.pages ?? '?'} | ${esc(s.path)} |`);
	md.push('', `Highest child peak memory: ${peak.map((p) => `${p.peakMB} MB (${p.scenario}, ${path.basename(p.path)})`).join('; ') || 'n/a'}.`);
	md.push('', '## Top failure groups', '');
	for (const g of failures.slice(0, 25)) {
		md.push(`### ${g.count} × ${g.outcome}${g.code ? ` (${g.code})` : ''} — ${fmtScen(g.scenarios)}`, '', `${esc(g.text) || '(no message)'}`, '');
		for (const e of g.examples) md.push(`- ${e}`);
		md.push('');
	}
	md.push('## Thresholds', '', '```', JSON.stringify(thresholds, null, 1), '```', '');
	fs.writeFileSync(path.join(out, 'report.md'), md.join('\n'));
	console.log(`report: ${results.length} results → ${path.join(out, 'report.md')}`);
	for (const h of headline) {
		const c = h.counts;
		console.log(`  ${h.scenario.padEnd(10)} verified ${c.verified}, refused ${c.refused}, crashed ${c.crashed}, wrong ${c.wrong}, suspect ${c.suspect}, needs-password ${c['needs-password']}, skipped ${c.skipped}`);
	}
}

function fmtScen(s: Record<string, number>) {
	return Object.entries(s)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k} ${v}`)
		.join(', ');
}

