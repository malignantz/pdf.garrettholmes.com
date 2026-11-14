/**
 * Measures Crop and Watermark (engine/crop.ts, engine/watermark.ts) on the survey pile (read-only).
 *
 *   npm run cropmark:measure [-- --size 300 --workers 2 --out DIR --half tune|held]
 *
 * Files: the survey's profiles (out/profiles.jsonl) that opened (status ok), at most 30 MB
 * and 300 pages, --size of them, round-robin across sources and producer families (sha256
 * order inside each). The first hex digit of the sha256 puts a file in the tuning half
 * (even) or the held-out half (odd). Each is exported twice by the real engine (the app's
 * defaults; then with a watermark and a 10%-per-edge crop on every page) and checked
 * independently (tools/crop-watermark/worker.ts). Every file is untrusted data; work runs
 * in child processes with memory and time caps (survey/lib/pool.ts); nothing is written
 * next to the inputs.
 *
 * Writes results.jsonl (resumable) and report.md to /home/garrett/pdf-survey/out-crop-watermark/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, parseArgs, readJsonl, repoRoot } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import type { CwJob, CwResult } from './worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';

interface Profile {
	sha256: string;
	path: string;
	source: string;
	size?: number;
	pages?: number;
	producerFamily?: string;
	status?: string;
}

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? path.join(PILE, 'out-crop-watermark'));
if (!path.relative(repoRoot, out).startsWith('..')) throw new Error('output must be outside the repo');
fs.mkdirSync(out, { recursive: true });
const resFile = path.join(out, 'results.jsonl');

const profiles = readJsonl<Profile>(args.get('profiles') ?? path.join(PILE, 'out/profiles.jsonl')).filter((p) => p.path.startsWith(`${PILE}/raw/`) && fs.existsSync(p.path));
const usable = profiles.filter((p) => p.status === 'ok' && (p.size ?? 0) <= 30e6 && (p.pages ?? 1) <= 300);
const size = args.num('size', 300);

function stratified(list: Profile[], n: number): Profile[] {
	const bySource = new Map<string, Map<string, Profile[]>>();
	// Ordered by the hash's tail, so the halves (decided by its first digit) come out even.
	for (const p of [...list].sort((a, b) => a.sha256.slice(8).localeCompare(b.sha256.slice(8)))) {
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

const sample = stratified(usable, size);
const half = (sha: string): CwJob['half'] => (Number.parseInt(sha[0], 16) % 2 === 0 ? 'tune' : 'held');
const only = args.get('half');
const done = new Set(readJsonl<CwResult>(resFile).map((r) => r.sha256));
const jobs: CwJob[] = sample
	.map((p) => ({ sha256: p.sha256, path: p.path, source: p.source, producer: p.producerFamily ?? 'unknown', half: half(p.sha256) }))
	.filter((j) => !done.has(j.sha256) && (!only || j.half === only));

if (!args.flag('report-only')) {
	console.log(`profiles ${profiles.length}, usable ${usable.length}; sample ${sample.length}; ${jobs.length} to do`);
	const t0 = Date.now();
	let n = 0;
	await runPool<CwJob, CwResult>(jobs, {
		script: path.join(here, 'worker.ts'),
		workers: Math.min(2, args.num('workers', 2)),
		memMB: args.num('mem-mb', 2000),
		timeoutMs: args.num('timeout', 420) * 1000,
		recycleAfter: 15,
		onResult: (_job, r) => appendJsonl(resFile, r),
		onDone: () => {
			if (++n % 20 === 0) console.log(`  ${n}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail, step) => {
			appendJsonl(resFile, { sha256: job.sha256, path: job.path, source: job.source, producer: job.producer, half: job.half, open: 'error', openMessage: `crash-${kind} at ${step}: ${detail.slice(0, 160)}`, ms: 0 } satisfies CwResult);
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}
report();

function report() {
	const wanted = new Set(sample.map((p) => p.sha256));
	const rows = readJsonl<CwResult>(resFile).filter((r) => wanted.has(r.sha256));
	const count = <T>(list: T[], key: (x: T) => string) => {
		const m = new Map<string, number>();
		for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
		return [...m].sort((a, b) => b[1] - a[1]);
	};
	const table = (head: string, list: [string, number][]) => [`| ${head} | files |`, '|---|---:|', ...list.map(([k, v]) => `| ${k.replace(/\|/g, '/').replace(/\n/g, ' ')} | ${v} |`), ''];
	const q = (xs: number[], f: number) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : 0;
	};
	const md: string[] = [
		`# Crop and watermark: survey (${new Date().toISOString().slice(0, 10)})`,
		'',
		`Tool: \`tools/crop-watermark/measure.ts\` + \`worker.ts\` (repo, branch crop-watermark). Profiles: ${profiles.length}; usable (opened in the profile, ≤ 30 MB, ≤ 300 pages): ${usable.length}. Sample: ${sample.length}, round-robin across sources and producer families; tuning half (sha256 starts with an even hex digit) and held-out half.`,
		'',
		'Each file: the default export (Optimize and the print-size cap on), all pages; then the same with a watermark ("CONFIDENTIAL", diagonal, light, grey) and every page cropped by 10% on each edge (the middle 80% × 80% shows). Independent checks with MuPDF: page sizes (first 60 pages), the watermark in the page text (first 60), renders of the first 3 pages against the middle of the plain export\'s renders (40 dpi; a pixel may be off by 60 levels or one pixel; at most 3% of pixels may differ, and less than a third as many as against the part 5% off: glyph edges fall on other pixels in a cropped render).',
		''
	];
	for (const [label, list] of [
		['Held-out half', rows.filter((r) => r.half === 'held')],
		['Tuning half', rows.filter((r) => r.half === 'tune')],
		['Both halves', rows]
	] as const) {
		const opened = list.filter((r) => r.open === 'ok');
		const baseOk = opened.filter((r) => r.base?.status === 'ok');
		const cwOk = baseOk.filter((r) => r.cw?.status === 'ok');
		const cwFail = baseOk.filter((r) => r.cw?.status === 'error');
		const added = cwOk.map((r) => r.cw!.ms! - r.base!.ms!);
		const rel = cwOk.filter((r) => r.base!.ms! > 0).map((r) => r.cw!.ms! / r.base!.ms!);
		md.push(`## ${label}: ${list.length} files`, '');
		md.push(`- Opened: ${opened.length}; default export verified: ${baseOk.length} (refused: ${opened.length - baseOk.length}, the existing rules)`);
		md.push(`- With watermark and crop: **verified ${cwOk.length} of ${baseOk.length}**; refused ${cwFail.length}`);
		md.push(`- Independent checks of the verified ones: page sizes same ${cwOk.filter((r) => r.sizes === 'same').length}, watermark text read by MuPDF ${cwOk.filter((r) => r.text === 'same').length}, renders same ${cwOk.filter((r) => r.pixels === 'same').length} (of ${cwOk.length})`);
		md.push(`- Time added (export with both minus default export): median ${q(added, 0.5)} ms, p90 ${q(added, 0.9)} ms, worst ${Math.max(0, ...added)} ms; ratio median ${q(rel, 0.5).toFixed(2)}, p90 ${q(rel, 0.9).toFixed(2)}`);
		md.push(`- Accessibility tags with both: ${count(cwOk.filter((r) => r.cw!.tags), (r) => r.cw!.tags!).map(([k, v]) => `${k} ${v}`).join(', ') || 'no tagged files'} (default export: ${count(baseOk.filter((r) => r.base!.tags), (r) => r.base!.tags!).map(([k, v]) => `${k} ${v}`).join(', ') || '–'})`);
		md.push('');
		if (cwFail.length) {
			md.push(...table('refused with watermark and crop (code: message)', count(cwFail, (r) => `${r.cw!.code}: ${r.cw!.message}`.slice(0, 300))));
			for (const r of cwFail) md.push(`- ${r.sha256.slice(0, 12)} (${r.source}): ${r.pages} pages, first page ${r.firstPage ? `${r.firstPage.width} × ${r.firstPage.height} pt` : '?'}`);
			md.push('');
		}
		const odd = cwOk.filter((r) => r.sizes !== 'same' || r.text !== 'same' || r.pixels !== 'same');
		if (odd.length) {
			md.push('Independent check differences:', '');
			for (const r of odd) md.push(`- ${r.sha256.slice(0, 12)} (${r.source}, ${r.pages} pages): sizes ${r.sizes}; text ${r.text}; pixels ${r.pixels}`.slice(0, 500));
			md.push('');
		}
		const notOpened = list.filter((r) => r.open !== 'ok');
		if (notOpened.length) md.push(...table('not opened', count(notOpened, (r) => r.openMessage ?? '?')));
	}
	fs.writeFileSync(path.join(out, 'report.md'), md.join('\n') + '\n');
	console.log(md.slice(0, 24).join('\n'));
}
