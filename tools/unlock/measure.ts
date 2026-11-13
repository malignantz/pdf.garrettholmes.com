/**
 * Measures "Remove printing and copying limits" on the survey pile (read-only).
 *
 *   npm run unlock:measure [-- --size 300 --workers 2 --out DIR]
 *
 * Files come from the survey's profiles (out/profiles.jsonl, written by
 * `npm run survey:profile`):
 * - export: files qpdf opens without a password although they are encrypted
 *   ("owner-only"), at most --size of them, taken round-robin across sources (sorted by
 *   sha256 inside each) when there are more. Each is opened and exported with the app's
 *   defaults and checked (tools/unlock/worker.ts).
 * - probe: files the profile marked "needs-password" or "unknown" (qpdf could not read
 *   them): those whose bytes mention /Encrypt are opened without a password only, to
 *   count other security handlers and the message each gets.
 *
 * Writes results.jsonl (resumable: rows already there are kept) and report.md to
 * /home/garrett/pdf-survey/out-unlock/ (or --out). Every file is untrusted data; work
 * runs in child processes with memory and time caps (survey/lib/pool.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, parseArgs, readJsonl, repoRoot } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import type { UnlockJob, UnlockResult } from './worker';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';

interface Profile {
	sha256: string;
	path: string;
	source: string;
	encryption: string;
}

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? path.join(PILE, 'out-unlock'));
if (!path.relative(repoRoot, out).startsWith('..')) throw new Error('output must be outside the repo');
fs.mkdirSync(out, { recursive: true });
const resFile = path.join(out, 'results.jsonl');

const profiles = readJsonl<Profile>(args.get('profiles') ?? path.join(PILE, 'out/profiles.jsonl')).filter((p) => p.path.startsWith(`${PILE}/raw/`) && fs.existsSync(p.path));
const ownerOnly = profiles.filter((p) => p.encryption === 'owner-only');
const size = args.num('size', 300);

/** Round-robin across sources, sha256 order inside each. */
function stratified(list: Profile[], n: number): Profile[] {
	const by = new Map<string, Profile[]>();
	for (const p of [...list].sort((a, b) => a.sha256.localeCompare(b.sha256))) by.set(p.source, [...(by.get(p.source) ?? []), p]);
	const queues = [...by.values()];
	const picked: Profile[] = [];
	while (picked.length < n && queues.some((q) => q.length)) for (const q of queues) if (q.length && picked.length < n) picked.push(q.shift()!);
	return picked;
}

const exportSet = stratified(ownerOnly, size);
const probeSet = profiles.filter((p) => p.encryption === 'needs-password' || p.encryption === 'unknown');
const done = new Set(readJsonl<UnlockResult>(resFile).map((r) => `${r.mode}:${r.sha256}`));
const jobs: UnlockJob[] = [
	...exportSet.map((p) => ({ sha256: p.sha256, path: p.path, source: p.source, mode: 'export' as const })),
	...probeSet.map((p) => ({ sha256: p.sha256, path: p.path, source: p.source, mode: 'probe' as const }))
].filter((j) => !done.has(`${j.mode}:${j.sha256}`));

console.log(`owner-only ${ownerOnly.length}, exporting ${exportSet.length}; probing ${probeSet.length}; ${jobs.length} to do`);
const t0 = Date.now();
let n = 0;
await runPool<UnlockJob, UnlockResult>(jobs, {
	script: path.join(here, 'worker.ts'),
	workers: Math.min(3, args.num('workers', 2)),
	memMB: args.num('mem-mb', 1800),
	timeoutMs: args.num('timeout', 240) * 1000,
	recycleAfter: 20,
	onResult: (_job, r) => appendJsonl(resFile, r),
	onDone: () => {
		if (++n % 25 === 0) console.log(`  ${n}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
	},
	onFailure: (job, kind, detail) => {
		appendJsonl(resFile, { sha256: job.sha256, path: job.path, source: job.source, mode: job.mode, open: 'error', openCode: `crash-${kind}`, openMessage: detail.slice(0, 200), ms: 0 } satisfies UnlockResult);
		return null;
	}
});
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
report();

function report() {
	const wanted = new Set([...exportSet.map((p) => `export:${p.sha256}`), ...probeSet.map((p) => `probe:${p.sha256}`)]);
	const rows = readJsonl<UnlockResult>(resFile).filter((r) => wanted.has(`${r.mode}:${r.sha256}`));
	const ex = rows.filter((r) => r.mode === 'export');
	const pr = rows.filter((r) => r.mode === 'probe' && !r.plain);
	const count = <T>(list: T[], key: (x: T) => string) => {
		const m = new Map<string, number>();
		for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
		return [...m].sort((a, b) => b[1] - a[1]);
	};
	const table = (head: string, list: [string, number][]) => [`| ${head} | files |`, '|---|---:|', ...list.map(([k, v]) => `| ${k.replace(/\|/g, '/')} | ${v} |`), ''];
	const opened = ex.filter((r) => r.open === 'ok');
	const exported = opened.filter((r) => r.export === 'ok');
	const clean = exported.filter((r) => !r.exportEncrypted && !r.rawEncrypt);
	const md: string[] = [
		`# Remove printing and copying limits: survey (${new Date().toISOString().slice(0, 10)})`,
		'',
		`Tool: \`tools/unlock/measure.ts\` (repo), engine as in the branch. Profiles: ${profiles.length} files; ${ownerOnly.length} open without a password but are encrypted (owner-only); ${exportSet.length} of them measured (round-robin across sources).`,
		'',
		'## Owner-only files: open and default export (Optimize and the print-size cap on)',
		'',
		`- Measured: ${ex.length}`,
		`- Opened: ${opened.length}`,
		`- Exported (verified by the engine): ${exported.length}`,
		`- Exports with no encryption (qpdf --is-encrypted says not encrypted, and no /Encrypt in the bytes): ${clean.length} of ${exported.length}`,
		`- Text (MuPDF, first 30 pages, whitespace removed): same ${exported.filter((r) => r.text === 'same').length}, no text in either ${exported.filter((r) => r.text === 'no-text').length}, differs ${exported.filter((r) => r.text === 'differs').length}, not checked ${exported.filter((r) => r.text === 'unchecked').length}`,
		'',
		'Refused or failed, by message:',
		'',
		...table('stage: code: message', [
			...count(ex.filter((r) => r.open !== 'ok'), (r) => `open: ${r.openCode}: ${r.openMessage}`),
			...count(opened.filter((r) => r.export !== 'ok'), (r) => `export: ${r.exportCode}: ${r.exportMessage}`)
		]),
		'Limits found (of files opened):',
		'',
		...table('limit', count(opened.flatMap((r) => (r.limits?.length ? r.limits : ['(none: encrypted, nothing limited)'])), (x) => x)),
		'Security handler revision and method (qpdf --show-encryption):',
		'',
		...table('R / method', count(ex, (r) => (r.R ? `R${r.R} ${r.method ?? ''}`.trim() : `not read: ${r.qpdfError ?? '?'}`))),
		'Open notes shown:',
		'',
		...table('note', count(opened.flatMap((r) => (r.notes ?? []).filter((n) => /limit|locked|password/.test(n))), (x) => x)),
		...(exported.some((r) => r.text === 'differs') ? ['Text differences:', '', ...exported.filter((r) => r.text === 'differs').map((r) => `- ${r.sha256.slice(0, 12)} (${r.source}): ${r.textDetail ?? ''}`), ''] : []),
		...(exported.some((r) => r.exportEncrypted || r.rawEncrypt) ? ['Exports still encrypted:', '', ...exported.filter((r) => r.exportEncrypted || r.rawEncrypt).map((r) => `- ${r.sha256.slice(0, 12)} (${r.source}) qpdf ${r.exportEncrypted}, raw /Encrypt ${r.rawEncrypt}`), ''] : []),
		'## Other encrypted-looking files (profile: needs a password, or qpdf could not read them)',
		'',
		`${probeSet.length} probed; ${pr.length} mention /Encrypt and were opened without a password.`,
		'',
		...table('outcome: code: message', count(pr, (r) => (r.open === 'ok' ? `opened: ${(r.limits ?? []).join(', ') || 'no limits'}` : `${r.openCode}: ${r.openMessage}`))),
		'Security handlers named in these files (a /Filter that is not a stream filter) and what the app said:',
		'',
		...table('handler (/Filter) → message', count(pr, (r) => `${r.filter ?? 'Standard (no other /Filter name found)'} → ${r.open === 'ok' ? 'opened' : r.openMessage}`)),
		'(Files that need a password are not opened: the app never guesses one, so their revisions are not read here.)'
	];
	fs.writeFileSync(path.join(out, 'report.md'), md.join('\n') + '\n');
	fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ export: ex.length, opened: opened.length, exported: exported.length, clean: clean.length }, null, 1));
	console.log(md.slice(0, 14).join('\n'));
}
