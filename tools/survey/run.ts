/** `run`: scenarios through the real engine for every sampled file → out/results.jsonl (resumable). */
import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, outDir, readJsonl, repoRoot, type Args } from './lib/common';
import { runPool } from './lib/pool';
import { surveyDir } from './lib/paths';
import type { RunJob, RunResult, Scenario } from './run-worker';
import { latestProfiles } from './sample';

const ALL: Scenario[] = ['open', 'plain', 'arrange', 'stamps', 'protect', 'redact', 'forms', 'forms-flat', 'target'];

export async function runCommand(args: Args) {
	const out = outDir(args);
	const resultsFile = path.join(out, 'results.jsonl');
	const sampleFile = args.get('sample') ?? path.join(out, 'sample.json');
	if (!fs.existsSync(sampleFile)) throw new Error(`No sample at ${sampleFile}; run survey:sample first.`);
	const sample = JSON.parse(fs.readFileSync(sampleFile, 'utf8')) as { files: { sha256: string; path: string; size: number }[] };
	const profiles = latestProfiles(out, args.get('profiles'));
	const scenarios = (args.get('scenarios')?.split(',') ?? ALL) as Scenario[];
	for (const s of scenarios) if (!ALL.includes(s)) throw new Error(`Unknown scenario ${s}. Known: ${ALL.join(', ')}`);

	const done = new Set(readJsonl<RunResult>(resultsFile).map((r) => `${r.sha256}\0${r.scenario}`));
	const only = args.get('only');
	let files = sample.files.filter((f) => !only || f.sha256.startsWith(only));
	const limit = args.num('limit', Infinity);
	if (files.length > limit) files = files.slice(0, limit);
	const knownGood = path.join(repoRoot, 'tests/corpus/files/multi.pdf');
	const jobs: RunJob[] = [];
	for (const f of files) {
		const todo = scenarios.filter((s) => !done.has(`${f.sha256}\0${s}`));
		if (!todo.length || !fs.existsSync(f.path)) continue;
		const p = profiles.get(f.sha256);
		// Unknown image status (profile incomplete): try the target scenario anyway.
		const hasImages = p?.images ? p.images.total > 0 : true;
		jobs.push({ sha256: f.sha256, path: f.path, size: f.size, scenarios: todo, hasImages, out, knownGood, reopen: done.has(`${f.sha256}\0open`) });
	}
	console.log(`run: ${files.length} sampled files, ${jobs.length} with scenarios to do → ${resultsFile}`);

	const got = new Map<RunJob, Set<Scenario>>();
	let filesDone = 0;
	const t0 = Date.now();
	const write = (r: RunResult) => {
		appendJsonl(resultsFile, r);
		if (r.outcome === 'wrong' || r.outcome === 'crashed' || r.outcome === 'suspect') {
			console.log(`  ${r.outcome.padEnd(8)} ${r.scenario.padEnd(10)} ${path.basename(r.path).slice(0, 50)}: ${(r.code ?? '') + ' ' + (r.detail ?? r.message ?? '')}`.slice(0, 220));
		}
	};
	await runPool<RunJob, RunResult>(jobs, {
		script: path.join(surveyDir, 'run-worker.ts'),
		workers: args.num('workers', 3),
		memMB: args.num('mem-mb', 1800),
		timeoutMs: args.num('timeout', 180) * 1000,
		recycleAfter: 1,
		onResult: (job, r) => {
			let s = got.get(job);
			if (!s) got.set(job, (s = new Set()));
			s.add(r.scenario);
			write(r);
		},
		onDone: () => {
			filesDone++;
			if (filesDone % 10 === 0) console.log(`  ${filesDone}/${jobs.length} files (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail, step) => {
			const seen = got.get(job) ?? new Set<Scenario>();
			const failed = (step ?? 'open') as Scenario;
			const base = { sha256: job.sha256, path: job.path, ms: 0, peakMB: 0 };
			if (!seen.has(failed)) write({ ...base, scenario: failed, outcome: 'crashed', code: kind, message: detail });
			seen.add(failed);
			const rest = job.scenarios.filter((s) => !seen.has(s));
			if (failed === 'open') {
				for (const s of rest) write({ ...base, scenario: s, outcome: 'skipped', message: 'The file did not open (crashed).' });
				return null;
			}
			if (!rest.length) return null;
			const again: RunJob = { ...job, scenarios: rest, reopen: true };
			return again;
		}
	});
	console.log(`run: done in ${Math.round((Date.now() - t0) / 1000)} s`);
}
