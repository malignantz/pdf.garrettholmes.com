/**
 * Measures the title, details and bookmarks kept in exports (engine/outline.ts) on the survey
 * pile (read-only).
 *
 *   npm run outline:measure [-- --size 300 --titles 600 --workers 2 --out DIR --report-only]
 *
 * Files: the survey's profiles (out/profiles.jsonl) with bookmarks (an /Outlines with a /First),
 * --size of them, round-robin across sources and, inside a source, across producer families
 * (sha256 order inside each); and --titles files of the whole pile, picked the same way, for the
 * share with a title (qpdf only). Each file goes to the tuning half or the held-out half by the
 * first hex digit of its sha256 (even: tuning). Every file is untrusted data; work runs in child
 * processes with memory and time caps (survey/lib/pool.ts); nothing is written next to the inputs.
 *
 * Writes results.jsonl (resumable) and report.md to /home/garrett/pdf-survey/out-outline/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, parseArgs, readJsonl, repoRoot } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import type { OutlineJob, OutlineResult, StepResult } from './worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';

interface Profile {
	sha256: string;
	path: string;
	source: string;
	producerFamily?: string;
	bookmarks?: boolean;
	status?: string;
}

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? path.join(PILE, 'out-outline'));
if (!path.relative(repoRoot, out).startsWith('..')) throw new Error('output must be outside the repo');
fs.mkdirSync(out, { recursive: true });
const resFile = path.join(out, 'results.jsonl');

const profiles = readJsonl<Profile>(args.get('profiles') ?? path.join(PILE, 'out/profiles.jsonl')).filter((p) => p.path.startsWith(`${PILE}/raw/`) && fs.existsSync(p.path));
const withMarks = profiles.filter((p) => p.bookmarks === true);
const size = args.num('size', 300);
const titles = args.num('titles', 600);

function stratified(list: Profile[], n: number): Profile[] {
	const bySource = new Map<string, Map<string, Profile[]>>();
	for (const p of [...list].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
		const fam = p.producerFamily ?? 'unknown';
		const m = bySource.get(p.source) ?? new Map<string, Profile[]>();
		m.set(fam, [...(m.get(fam) ?? []), p]);
		bySource.set(p.source, m);
	}
	const queues = [...bySource.values()].map((m) => [...m.values()]);
	const next = (fams: Profile[][]): Profile | undefined => {
		for (let k = 0; k < fams.length; k++) {
			const q = fams.shift()!;
			fams.push(q);
			if (q.length) return q.shift();
		}
		return undefined;
	};
	const picked: Profile[] = [];
	while (picked.length < n && queues.some((fams) => fams.some((q) => q.length))) {
		for (const fams of queues) {
			if (picked.length >= n) break;
			const p = next(fams);
			if (p) picked.push(p);
		}
	}
	return picked;
}

const sample = stratified(withMarks, size);
const titleSample = stratified(profiles, titles);
const half = (sha: string): OutlineJob['half'] => (Number.parseInt(sha[0], 16) % 2 === 0 ? 'tune' : 'held');
const key = (r: { kind: string; sha256: string }) => `${r.kind}:${r.sha256}`;
const done = new Set(readJsonl<OutlineResult>(resFile).map(key));
const jobs: OutlineJob[] = [
	...titleSample.map((p) => ({ kind: 'title' as const, sha256: p.sha256, path: p.path, source: p.source, producer: p.producerFamily ?? 'unknown', half: half(p.sha256) })),
	...sample.map((p, i) => ({ kind: 'full' as const, sha256: p.sha256, path: p.path, source: p.source, producer: p.producerFamily ?? 'unknown', half: half(p.sha256), partner: sample[(i + 1) % sample.length].path }))
].filter((j) => !done.has(key(j)));

if (!args.flag('report-only')) {
	console.log(`profiles ${profiles.length}, with bookmarks ${withMarks.length}; sample ${sample.length} + ${titleSample.length} for titles; ${jobs.length} to do`);
	const t0 = Date.now();
	let n = 0;
	await runPool<OutlineJob, OutlineResult>(jobs, {
		script: path.join(here, 'worker.ts'),
		// Other work shares the box: at most 2 workers.
		workers: Math.min(2, args.num('workers', 2)),
		memMB: args.num('mem-mb', 2000),
		timeoutMs: args.num('timeout', 420) * 1000,
		recycleAfter: 15,
		onResult: (_job, r) => appendJsonl(resFile, r),
		onDone: () => {
			if (++n % 25 === 0) console.log(`  ${n}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail, step) => {
			appendJsonl(resFile, { kind: job.kind, sha256: job.sha256, path: job.path, source: job.source, producer: job.producer, half: job.half, open: 'error', openMessage: `crash-${kind} at ${step}: ${detail.slice(0, 160)}`, ms: 0 } satisfies OutlineResult);
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}
report();

function report() {
	const wanted = new Set(sample.map((p) => `full:${p.sha256}`));
	const wantedT = new Set(titleSample.map((p) => `title:${p.sha256}`));
	const all = readJsonl<OutlineResult>(resFile);
	const rows = all.filter((r) => wanted.has(key(r)));
	const trows = all.filter((r) => wantedT.has(key(r)));
	const count = <T>(list: T[], k: (x: T) => string) => {
		const m = new Map<string, number>();
		for (const x of list) m.set(k(x), (m.get(k(x)) ?? 0) + 1);
		return [...m].sort((a, b) => b[1] - a[1]);
	};
	const table = (head: string, list: [string, number][]) => (list.length ? [`| ${head} | files |`, '|---|---:|', ...list.map(([k, v]) => `| ${k.replace(/\|/g, '/').slice(0, 160)} | ${v} |`), ''] : []);
	const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
	const q = (xs: number[], f: number) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : 0;
	};
	const step = (list: OutlineResult[], name: 'base' | 't1' | 'del1' | 'halfKept' | 'rev' | 'merge' | 'redact') => list.map((r) => r[name]).filter((x): x is StepResult => x !== undefined);
	const topen = trows.filter((r) => r.open === 'ok');
	const md: string[] = [
		`# Title and bookmarks kept in exports: survey (${new Date().toISOString().slice(0, 10)})`,
		'',
		`Tool: \`tools/outline/measure.ts\` + \`worker.ts\` (repo, branch outline). Profiles: ${profiles.length} files; ${withMarks.length} with bookmarks (${pct(withMarks.length, profiles.length)}; ${withMarks.filter((p) => p.source === 'verapdf-corpus').length} of them in the veraPDF test corpus). Sample with bookmarks: ${sample.length}, round-robin across sources and producer families; tuning half (sha256 starts with an even hex digit) and held-out half.`,
		'',
		`Title share (${trows.length} files of the whole pile picked the same way, qpdf on the file as given): read ${topen.length}; with an Info /Title ${topen.filter((r) => r.title).length} (${pct(topen.filter((r) => r.title).length, topen.length)}); with a catalog XMP packet ${topen.filter((r) => r.xmp).length} (${pct(topen.filter((r) => r.xmp).length, topen.length)}).`,
		''
	];
	for (const [label, list] of [
		['Held-out half', rows.filter((r) => r.half === 'held')],
		['Tuning half', rows.filter((r) => r.half === 'tune')],
		['Both halves', rows]
	] as const) {
		const opened = list.filter((r) => r.open === 'ok');
		const marked = opened.filter((r) => r.outline && r.outline !== 'none');
		const t1 = step(marked, 't1');
		const kept = t1.filter((s) => s.status === 'kept');
		const fully = marked.filter((r) => r.t1?.status === 'kept' && r.t1.marks === 'same' && !r.unresolved && !Object.keys(r.actions ?? {}).length);
		md.push(`## ${label}: ${list.length} files`, '');
		md.push(`- Opened: ${opened.length}; with an outline that has items after opening: ${marked.length}; with a title: ${opened.filter((r) => r.title).length}; with named destinations: ${opened.filter((r) => (r.namesCount ?? 0) > 0).length}`);
		md.push(`- Default export, all pages (Optimize and print-size cap on): bookmarks kept and verified ${kept.length} (${pct(kept.length, t1.length)}), of which kept fully (every bookmark, nothing dropped) ${fully.length}; not kept ${t1.filter((s) => s.status === 'dropped').length}; export failed ${t1.filter((s) => s.status === 'error').length} (the same export without this code failed ${step(marked, 'base').filter((s) => s.status === 'error').length})`);
		md.push(`- Kept with some bookmarks dropped by rule: ${marked.filter((r) => r.t1?.status === 'kept' && (r.unresolved || Object.keys(r.actions ?? {}).length)).length} (a destination that resolves to no page ${marked.filter((r) => r.t1?.status === 'kept' && r.unresolved).length}; another action ${marked.filter((r) => r.t1?.status === 'kept' && Object.keys(r.actions ?? {}).length).length})`);
		md.push(`- Independent check of kept bookmarks (PDF.js: preorder list of title, page, view kind of bookmarks to a page or web address): same ${kept.filter((s) => s.marks === 'same').length} of ${kept.length}; named destinations same ${kept.filter((s) => s.names === 'same').length}; title same ${kept.filter((s) => s.title === 'same').length}`);
		md.push(`- Title (details) on the default export: kept ${t1.filter((s) => s.info === 'kept').length}, not kept ${t1.filter((s) => s.info && s.info !== 'kept').length} (${count(t1.filter((s) => s.info && s.info !== 'kept'), (s) => s.info!).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
		const own = kept.map((s) => (s.outlineMs ? s.outlineMs.graft + s.outlineMs.verify : 0));
		md.push(`- Time of outline.ts's own steps (graft + final check; source read below), kept files: median ${q(own, 0.5)} ms, p90 ${q(own, 0.9)} ms, worst ${Math.max(0, ...own)} ms; source read: median ${q(marked.map((r) => r.inspectMs ?? 0), 0.5)} ms, worst ${Math.max(0, ...marked.map((r) => r.inspectMs ?? 0))} ms`);
		const total = marked.filter((r) => r.t1?.status === 'kept' && r.base?.ms !== undefined).map((r) => r.t1!.ms! - r.base!.ms!);
		const slow = marked.filter((r) => r.t1?.status === 'kept' && r.base?.ms !== undefined).sort((a, b) => b.t1!.ms! - b.base!.ms! - (a.t1!.ms! - a.base!.ms!))[0];
		md.push(`- Whole export time, with minus without: median ${q(total, 0.5)} ms, p90 ${q(total, 0.9)} ms, worst ${Math.max(0, ...total)} ms${slow ? ` (${slow.items} bookmarks, ${slow.namesCount} names, ${slow.pages} pages: ${slow.base!.ms} → ${slow.t1!.ms} ms)` : ''}`);
		const added = marked.filter((r) => r.t1?.status === 'kept' && r.base?.bytes && r.t1.bytes).map((r) => r.t1!.bytes! - r.base!.bytes!);
		const rel = marked.filter((r) => r.t1?.status === 'kept' && r.base?.bytes && r.t1.bytes).map((r) => (r.t1!.bytes! - r.base!.bytes!) / r.base!.bytes!);
		md.push(`- Size added against the same export without: median ${q(added, 0.5)} bytes (${(100 * q(rel, 0.5)).toFixed(2)}%), p90 ${q(added, 0.9)} bytes (${(100 * q(rel, 0.9)).toFixed(2)}%), worst ${Math.max(0, ...added)} bytes (${(100 * Math.max(0, ...rel)).toFixed(2)}%)`);
		md.push(`- Rebuilt after a failed check: ${marked.filter((r) => ['t1', 'del1', 'halfKept', 'rev', 'merge'].some((n) => /title and bookmarks failed/.test((r[n as 't1'] as StepResult | undefined)?.fellBack ?? ''))).length}; MuPDF cleanup turned down (any reason): ${marked.filter((r) => /rejected/.test(r.t1?.cleanup ?? '')).length} (without this code: ${marked.filter((r) => /rejected/.test(r.base?.cleanup ?? '')).length})`);
		for (const name of ['del1', 'halfKept', 'rev'] as const) {
			const s = step(marked, name);
			const k = s.filter((x) => x.status === 'kept');
			md.push(`- ${name === 'del1' ? 'One page removed' : name === 'halfKept' ? 'Random half kept' : 'Pages reversed'}: kept ${k.length} of ${s.length} (independent check same ${k.filter((x) => x.marks === 'same').length}, names same ${k.filter((x) => x.names === 'same').length}), not kept ${s.filter((x) => x.status === 'dropped').length}, failed ${s.filter((x) => x.status === 'error').length}`);
		}
		const mg = step(marked, 'merge');
		md.push(`- Merged with another file with bookmarks: kept ${mg.filter((x) => x.status === 'kept').length} of ${mg.length} (independent check same ${mg.filter((x) => x.status === 'kept' && x.marks === 'same').length}); not kept ${mg.filter((x) => x.status === 'dropped').length} (${count(mg.filter((x) => x.status === 'dropped'), (x) => x.reason ?? '?').map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); failed ${mg.filter((x) => x.status === 'error').length}; title kept ${mg.filter((x) => x.info === 'kept').length}`);
		const rd = step(marked, 'redact').filter((x) => x.status !== 'skipped');
		md.push(`- One word blacked out (one also in a bookmark title: ${rd.filter((x) => /bookmark title/.test(x.message ?? '')).length}): exported ${rd.filter((x) => x.status !== 'error').length} of ${rd.length} (refused by the redaction stage ${rd.filter((x) => x.status === 'error').length}); bookmarks not kept ${rd.filter((x) => x.status === 'dropped' && x.reason === 'redacted').length}; title kept ${rd.filter((x) => x.info === 'kept').length}; the word found in the decompressed bytes: ${rd.filter((x) => x.leak && x.leak !== 'none' && x.leak !== 'unchecked').length}`);
		md.push('');
		md.push(...table('why bookmarks were not kept (all pages)', count(t1.filter((s) => s.status === 'dropped'), (s) => s.reason ?? '?')));
		md.push(...table('damaged or large source outlines: what', count(marked.filter((r) => r.outline === 'damaged' || r.outline === 'large'), (r) => `${r.outline}: ${(r.outlineDetail ?? '').replace(/\d+ \d+ R/g, 'N 0 R').replace(/\d+/g, 'N')}`)));
		md.push(...table('actions dropped with their bookmark (files)', count(marked.flatMap((r) => Object.keys(r.actions ?? {})), (x) => x)));
		md.push(...table('named destinations not carried (files)', count(marked.filter((r) => r.namesProblem), (r) => (r.namesProblem ?? '').replace(/\d+/g, 'N'))));
		md.push(...table('bookmarks kept, by source', count(marked.filter((r) => r.t1?.status === 'kept'), (r) => r.source)));
		md.push(...table('bookmarks not kept, by source', count(marked.filter((r) => r.t1?.status === 'dropped'), (r) => r.source)));
		const odd = marked.filter((r) => ['t1', 'del1', 'halfKept', 'rev', 'merge'].some((n) => {
			const s = r[n as 't1'] as StepResult | undefined;
			return s?.status === 'kept' && ((s.marks && s.marks !== 'same') || (s.names && s.names !== 'same') || (s.title && s.title !== 'same'));
		}));
		if (odd.length) {
			md.push('Independent check differences:', '');
			for (const r of odd) {
				const parts = (['t1', 'del1', 'halfKept', 'rev', 'merge'] as const).flatMap((n) => {
					const s = r[n];
					return s?.status === 'kept' && ((s.marks && s.marks !== 'same') || (s.names && s.names !== 'same') || (s.title && s.title !== 'same')) ? [`${n}: marks ${s.marks}; names ${s.names ?? '-'}; title ${s.title ?? '-'}`] : [];
				});
				md.push(`- ${r.sha256.slice(0, 12)} (${r.source}): ${parts.join(' | ')}`.slice(0, 700));
			}
			md.push('');
		}
		const errs = marked.flatMap((r) => (['t1', 'del1', 'halfKept', 'rev', 'merge'] as const).filter((n) => r[n]?.status === 'error' && r.base?.status !== 'error').map((n) => `${n}: ${r[n]!.code}: ${r[n]!.message}`));
		if (errs.length) md.push(...table('export failures where the export without this code worked (step: code: message)', count(errs, (x) => x)));
		const leaks = marked.filter((r) => r.redact?.leak && r.redact.leak !== 'none' && r.redact.leak !== 'unchecked');
		if (leaks.length) {
			md.push('Blacked-out word found in the export:', '');
			for (const r of leaks) md.push(`- ${r.sha256.slice(0, 12)} (${r.source}): ${r.redact!.message}: ${r.redact!.leak}`.slice(0, 400));
			md.push('');
		}
		const fails = list.filter((r) => r.open !== 'ok');
		if (fails.length) md.push(...table('not opened', count(fails, (r) => r.openMessage ?? '?')));
	}
	fs.writeFileSync(path.join(out, 'report.md'), md.join('\n') + '\n');
	console.log(md.slice(0, 40).join('\n'));
}
