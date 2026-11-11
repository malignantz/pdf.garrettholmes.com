/** `profile`: traits of every input PDF → out/profiles.jsonl (resumable, keyed by sha256). */
import path from 'node:path';
import { appendJsonl, defaultInputs, discover, hashAll, outDir, readJsonl, type Args } from './lib/common';
import { runPool } from './lib/pool';
import { surveyDir } from './lib/paths';
import { producerFamily, type Profile } from './lib/traits';
import type { ProfileJob } from './profile-worker';

export async function profileCommand(args: Args) {
	const out = outDir(args);
	const file = path.join(out, 'profiles.jsonl');
	const inputs = defaultInputs(args);
	console.log(`profile: inputs ${inputs.join(', ')}`);
	const files = hashAll(discover(inputs), out);
	const done = new Set(readJsonl<Profile>(file).map((p) => p.sha256));
	const jobs: ProfileJob[] = [];
	const queued = new Set<string>();
	for (const f of files) {
		if (done.has(f.sha256!) || queued.has(f.sha256!)) continue;
		queued.add(f.sha256!);
		jobs.push({ path: f.path, sha256: f.sha256!, size: f.size, source: f.source });
	}
	const limit = args.num('limit', Infinity);
	if (jobs.length > limit) jobs.length = limit;
	console.log(`profile: ${files.length} files, ${done.size} already profiled, ${jobs.length} to do → ${file}`);
	let n = 0;
	const t0 = Date.now();
	const tick = () => {
		n++;
		if (n % 50 === 0 || n === jobs.length) {
			const rate = n / ((Date.now() - t0) / 1000);
			console.log(`  ${n}/${jobs.length} (${rate.toFixed(1)}/s)`);
		}
	};
	await runPool<ProfileJob, Profile>(jobs, {
		script: path.join(surveyDir, 'profile-worker.ts'),
		workers: args.num('workers', 3),
		memMB: args.num('mem-mb', 1500),
		timeoutMs: args.num('timeout', 90) * 1000,
		recycleAfter: 40,
		onResult: (_job, prof) => {
			appendJsonl(file, prof);
			tick();
		},
		onFailure: (job, kind, detail) => {
			appendJsonl(file, failedProfile(job, `${kind}: ${detail}`));
			tick();
			return null;
		}
	});
	console.log(`profile: done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

/** The profile of a file the profiler could not finish; it still takes part in sampling. */
function failedProfile(job: ProfileJob, error: string): Profile {
	return {
		sha256: job.sha256,
		path: job.path,
		source: job.source,
		size: job.size,
		ms: 0,
		status: 'failed',
		error,
		notes: [],
		version: null,
		producer: null,
		creator: null,
		producerFamily: producerFamily(null, null),
		pages: null,
		encryption: 'unknown',
		linearized: null,
		objectStreams: null,
		xrefStreams: null,
		damage: 'unknown',
		form: null,
		content: null,
		fonts: null,
		geometry: null,
		annots: null,
		bookmarks: null,
		attachments: null,
		layers: null,
		javascript: null,
		tagged: null,
		pdfa: null,
		images: null,
		transparency: null
	};
}
