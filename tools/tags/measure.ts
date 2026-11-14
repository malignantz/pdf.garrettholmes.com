/**
 * Measures accessibility tags kept in exports (engine/tags.ts) on the survey pile (read-only).
 *
 *   npm run tags:measure [-- --size 300 --workers 2 --out DIR]
 *
 * Files: the survey's profiles (out/profiles.jsonl) marked tagged (a /StructTreeRoot or
 * /MarkInfo /Marked true), --size of them, round-robin across sources and, inside a source,
 * across producer families (sha256 order inside each). Each file goes to the tuning half
 * or the held-out half by the first hex digit of its sha256 (even: tuning). Every file is
 * untrusted data; work runs in child processes with memory and time caps
 * (survey/lib/pool.ts); nothing is written next to the inputs.
 *
 * Writes results.jsonl (resumable) and report.md to /home/garrett/pdf-survey/out-tags/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, parseArgs, readJsonl, repoRoot } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import type { StepResult, TagsJob, TagsResult } from './worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';

interface Profile {
	sha256: string;
	path: string;
	source: string;
	producerFamily?: string;
	tagged?: boolean;
	status?: string;
}

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? path.join(PILE, 'out-tags'));
if (!path.relative(repoRoot, out).startsWith('..')) throw new Error('output must be outside the repo');
fs.mkdirSync(out, { recursive: true });
const resFile = path.join(out, 'results.jsonl');

const profiles = readJsonl<Profile>(args.get('profiles') ?? path.join(PILE, 'out/profiles.jsonl')).filter((p) => p.path.startsWith(`${PILE}/raw/`) && fs.existsSync(p.path));
const tagged = profiles.filter((p) => p.tagged === true);
const size = args.num('size', 300);

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

const sample = stratified(tagged, size);
const half = (sha: string): TagsJob['half'] => (Number.parseInt(sha[0], 16) % 2 === 0 ? 'tune' : 'held');
const done = new Set(readJsonl<TagsResult>(resFile).map((r) => r.sha256));
const jobs: TagsJob[] = sample
	.map((p, i) => ({ sha256: p.sha256, path: p.path, source: p.source, producer: p.producerFamily ?? 'unknown', half: half(p.sha256), partner: sample[(i + 1) % sample.length].path }))
	.filter((j) => !done.has(j.sha256));

if (!args.flag('report-only')) {
	console.log(`profiles ${profiles.length}, tagged ${tagged.length}; sample ${sample.length}; ${jobs.length} to do`);
	const t0 = Date.now();
	let n = 0;
	await runPool<TagsJob, TagsResult>(jobs, {
		script: path.join(here, 'worker.ts'),
		workers: Math.min(3, args.num('workers', 2)),
		memMB: args.num('mem-mb', 2000),
		timeoutMs: args.num('timeout', 420) * 1000,
		recycleAfter: 15,
		onResult: (_job, r) => appendJsonl(resFile, r),
		onDone: () => {
			if (++n % 20 === 0) console.log(`  ${n}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail, step) => {
			appendJsonl(resFile, { sha256: job.sha256, path: job.path, source: job.source, producer: job.producer, half: job.half, open: 'error', openMessage: `crash-${kind} at ${step}: ${detail.slice(0, 160)}`, ms: 0 } satisfies TagsResult);
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}
report();

function report() {
	const wanted = new Set(sample.map((p) => p.sha256));
	const rows = readJsonl<TagsResult>(resFile).filter((r) => wanted.has(r.sha256));
	const count = <T>(list: T[], key: (x: T) => string) => {
		const m = new Map<string, number>();
		for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
		return [...m].sort((a, b) => b[1] - a[1]);
	};
	const table = (head: string, list: [string, number][]) => [`| ${head} | files |`, '|---|---:|', ...list.map(([k, v]) => `| ${k.replace(/\|/g, '/')} | ${v} |`), ''];
	const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
	const q = (xs: number[], f: number) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : 0;
	};
	const step = (list: TagsResult[], name: 'base' | 't1' | 'del1' | 'halfKept' | 'rev' | 'merge' | 'redact') => list.map((r) => r[name]).filter((x): x is StepResult => x !== undefined);
	const md: string[] = [
		`# Accessibility tags kept in exports: survey (${new Date().toISOString().slice(0, 10)})`,
		'',
		`Tool: \`tools/tags/measure.ts\` + \`worker.ts\` (repo, branch tags). Profiles: ${profiles.length} files; ${tagged.length} tagged (${pct(tagged.length, profiles.length)}: a /StructTreeRoot or /MarkInfo /Marked true). Sample: ${sample.length}, round-robin across sources and producer families; tuning half (sha256 starts with an even hex digit) and held-out half.`,
		''
	];
	for (const [label, list] of [
		['Held-out half', rows.filter((r) => r.half === 'held')],
		['Tuning half', rows.filter((r) => r.half === 'tune')],
		['Both halves', rows]
	] as const) {
		const opened = list.filter((r) => r.open === 'ok');
		const withTree = opened.filter((r) => r.tagged);
		const t1 = step(withTree, 't1');
		const kept = t1.filter((s) => s.status === 'kept');
		const added = kept.map((s) => (s.tagsMs ? s.tagsMs.read + s.tagsMs.graft + s.tagsMs.verify : 0));
		const sizeChange = withTree.filter((r) => r.t1?.status === 'kept' && r.base?.bytes && r.t1.bytes).map((r) => (r.t1!.bytes! - r.base!.bytes!) / r.base!.bytes!);
		md.push(`## ${label}: ${list.length} files`, '');
		md.push(`- Opened: ${opened.length}; with a structure tree: ${withTree.length} (the rest only say /Marked true)`);
		md.push(`- Default export, all pages (Optimize and print-size cap on): tags kept and verified ${kept.length} (${pct(kept.length, t1.length)}), not kept ${t1.filter((s) => s.status === 'dropped').length}, export failed ${t1.filter((s) => s.status === 'error').length} (the same export without tags failed ${step(withTree, 'base').filter((s) => s.status === 'error').length})`);
		md.push(`- Independent check of kept tags (PDF.js getStructTree of every page up to 60, source vs export): same ${kept.filter((s) => s.tree === 'same').length} of ${kept.length}; MuPDF text (30 pages): same ${kept.filter((s) => s.text === 'same').length}; renders (3 pages, 40 dpi): same ${kept.filter((s) => s.pixels === 'same').length}`);
		md.push(`- Time the tags add (source read + graft + final check), kept files: median ${q(added, 0.5)} ms, p90 ${q(added, 0.9)} ms, worst ${Math.max(0, ...added)} ms`);
		md.push(`- Size change against the same export without tags: median ${(100 * q(sizeChange, 0.5)).toFixed(2)}%, p90 ${(100 * q(sizeChange, 0.9)).toFixed(2)}%, worst ${(100 * Math.max(0, ...sizeChange)).toFixed(2)}%`);
		const vsOriginal = withTree.filter((r) => r.t1?.status === 'kept' && r.size && r.t1.bytes).map((r) => (r.t1!.bytes! - r.size!) / r.size!);
		md.push(`- Size against the file as given (which has its tags): median ${(100 * q(vsOriginal, 0.5)).toFixed(2)}%, p90 ${(100 * q(vsOriginal, 0.9)).toFixed(2)}%, worst ${(100 * Math.max(...vsOriginal, 0)).toFixed(2)}%; exports bigger than the file as given: ${vsOriginal.filter((x) => x > 0).length}`);
		md.push(`- MuPDF cleanup turned down because of the tags (struct elements it would merge): ${withTree.filter((r) => r.t1?.status === 'kept' && /structure objects/.test(r.t1.cleanup ?? '')).length}; compressed result failed a check and the uncompressed one was used: ${withTree.filter((r) => r.t1?.fellBack).length} (same plan without tags: ${withTree.filter((r) => r.base?.fellBack).length})`);
		for (const name of ['del1', 'halfKept', 'rev'] as const) {
			const s = step(withTree, name);
			const k = s.filter((x) => x.status === 'kept');
			md.push(`- ${name === 'del1' ? 'One page removed' : name === 'halfKept' ? 'Random half kept' : 'Pages reversed'}: kept ${k.length} of ${s.length} (independent check same ${k.filter((x) => x.tree === 'same').length}), not kept ${s.filter((x) => x.status === 'dropped').length}, failed ${s.filter((x) => x.status === 'error').length}`);
		}
		const mg = step(withTree, 'merge');
		md.push(`- Merged with another tagged file: kept ${mg.filter((x) => x.status === 'kept').length} of ${mg.length} (independent check same ${mg.filter((x) => x.status === 'kept' && x.tree === 'same').length}); not kept ${mg.filter((x) => x.status === 'dropped').length} (${count(mg.filter((x) => x.status === 'dropped'), (x) => x.reason ?? '?').map(([k, v]) => `${k} ${v}`).join(', ')}); failed ${mg.filter((x) => x.status === 'error').length}`);
		const rd = step(withTree, 'redact').filter((x) => x.status !== 'skipped');
		md.push(`- One word blacked out: exported ${rd.filter((x) => x.status !== 'error').length} of ${rd.length} (refused ${rd.filter((x) => x.status === 'error').length}); tags not kept ${rd.filter((x) => x.status === 'dropped' && x.reason === 'redacted').length}; the word found in the decompressed bytes: ${rd.filter((x) => x.leak && x.leak !== 'none' && x.leak !== 'unchecked').length}`);
		md.push('');
		md.push(...table('why tags were not kept (all pages)', count(t1.filter((s) => s.status === 'dropped'), (s) => s.reason ?? '?')));
		md.push(...table('problem kinds in source trees (files)', count(withTree.flatMap((r) => Object.keys(r.problems ?? {})), (x) => x)));
		md.push(...table('tags kept, by source', count(withTree.filter((r) => r.t1?.status === 'kept'), (r) => r.source)));
		md.push(...table('tags not kept, by source', count(withTree.filter((r) => r.t1?.status === 'dropped'), (r) => r.source)));
		md.push(...table('tags not kept, by producer family', count(withTree.filter((r) => r.t1?.status === 'dropped'), (r) => r.producer)));
		const odd = withTree.filter((r) => (r.t1?.status === 'kept' && (r.t1.tree !== 'same' || r.t1.text !== 'same' || r.t1.pixels !== 'same')) || ['del1', 'halfKept', 'rev', 'merge'].some((n) => (r[n as 'del1'] as StepResult | undefined)?.status === 'kept' && (r[n as 'del1'] as StepResult).tree !== 'same'));
		if (odd.length) {
			md.push('Independent check differences:', '');
			for (const r of odd) md.push(`- ${r.sha256.slice(0, 12)} (${r.source}): t1 tree ${r.t1?.tree}; text ${r.t1?.text}; pixels ${r.t1?.pixels}; del1 ${r.del1?.tree ?? '-'}; half ${r.halfKept?.tree ?? '-'}; rev ${r.rev?.tree ?? '-'}; merge ${r.merge?.tree ?? '-'}`.slice(0, 600));
			md.push('');
		}
		const errs = withTree.flatMap((r) => (['t1', 'del1', 'halfKept', 'rev', 'merge'] as const).filter((n) => r[n]?.status === 'error').map((n) => `${n}: ${r[n]!.code}: ${r[n]!.message}`));
		if (errs.length) md.push(...table('export failures (step: code: message)', count(errs, (x) => x)));
		const leaks = withTree.filter((r) => r.redact?.leak && r.redact.leak !== 'none' && r.redact.leak !== 'unchecked');
		if (leaks.length) {
			md.push('Redacted word found in the export:', '');
			for (const r of leaks) md.push(`- ${r.sha256.slice(0, 12)} (${r.source}): ${r.redact!.message}: ${r.redact!.leak}`.slice(0, 400));
			md.push('');
		}
		const fails = opened.filter((r) => r.open !== 'ok');
		if (fails.length) md.push(...table('not opened', count(fails, (r) => r.openMessage ?? '?')));
	}
	fs.writeFileSync(path.join(out, 'report.md'), md.join('\n') + '\n');
	console.log(md.slice(0, 30).join('\n'));
}
