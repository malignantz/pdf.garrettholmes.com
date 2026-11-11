/** `sample`: stratified sample of the profiled pile → out/sample.json and out/coverage.tsv. */
import fs from 'node:fs';
import path from 'node:path';
import { outDir, readJsonl, type Args } from './lib/common';
import { sample } from './lib/sampler';
import { featuresOf, type Profile } from './lib/traits';

/** Latest profile per sha256 from out/profiles.jsonl, or from `--profiles FILE` (to sample a smoke test from a shared profile run). */
export function latestProfiles(out: string, file?: string): Map<string, Profile> {
	const bySha = new Map<string, Profile>();
	for (const p of readJsonl<Profile>(file ?? path.join(out, 'profiles.jsonl'))) bySha.set(p.sha256, p);
	return bySha;
}

export async function sampleCommand(args: Args) {
	const out = outDir(args);
	const profiles = [...latestProfiles(out, args.get('profiles')).values()].filter((p) => fs.existsSync(p.path));
	const opts = {
		target: args.num('size', 600),
		k: args.num('k', 2),
		maxBytes: args.num('max-mb', 100) * 1024 * 1024,
		seed: args.num('seed', 1),
		pairs: !args.flag('no-pairs')
	};
	const items = profiles.map((p) => ({ id: p.sha256, size: p.size, features: featuresOf(p) }));
	const t0 = Date.now();
	const res = sample(items, opts);
	const bySha = new Map(profiles.map((p) => [p.sha256, p]));
	const files = res.ids.map((id) => {
		const p = bySha.get(id)!;
		return { sha256: id, path: p.path, size: p.size, source: p.source };
	});
	const rows = Object.entries(res.coverage).sort(([a], [b]) => a.localeCompare(b));
	const missing = rows.filter(([, [pile, s]]) => s < Math.min(opts.k, pile));
	fs.writeFileSync(
		path.join(out, 'sample.json'),
		JSON.stringify(
			{
				created: new Date().toISOString(),
				options: opts,
				pile: profiles.length,
				excludedTooLarge: res.excludedTooLarge,
				pairs: { total: res.pairsTotal, short: res.pairsShort },
				featuresShort: missing.map(([f]) => f),
				files,
				coverage: Object.fromEntries(rows.map(([f, [pile, s]]) => [f, { pile, sample: s }]))
			},
			null,
			1
		)
	);
	fs.writeFileSync(path.join(out, 'coverage.tsv'), 'trait\tvalue\tpile\tsample\n' + rows.map(([f, [pile, s]]) => `${f.replace('=', '\t')}\t${pile}\t${s}`).join('\n') + '\n');
	const bytes = files.reduce((n, f) => n + f.size, 0);
	console.log(
		`sample: ${files.length} of ${profiles.length} files (${(bytes / 1024 / 1024).toFixed(1)} MB) in ${Date.now() - t0} ms; ` +
			`${rows.length} features, ${missing.length} below k; pairs ${res.pairsTotal - res.pairsShort}/${res.pairsTotal} met; ` +
			`${res.excludedTooLarge} over the size cap → ${path.join(out, 'sample.json')}`
	);
}
