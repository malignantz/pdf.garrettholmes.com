/**
 * Measures the flat-form blank detector (src/lib/engine/forms-detect.ts) against
 * real AcroForm widgets in the survey pile. Output goes to
 * /home/garrett/pdf-survey/out-forms-detect/ (or --out DIR; never inside the repo).
 *
 *   npm run forms:measure -- sample            # stratified sample → sample.json
 *   npm run forms:measure -- run               # detector on every sampled page → results.jsonl
 *   npm run forms:measure -- report            # numbers → report.md, report.json
 *   npm run forms:measure -- render --files L  # PNGs with truth and suggestions drawn (L: "sha[:page]" per line)
 *
 * Options: --out DIR, --exclude SAMPLE.json (sample: leave those files out), --profiles FILE (survey profiles.jsonl), --forms 420, --nonforms 200,
 * --max-pages 6 (forms; non-forms use 3), --workers 2 (at most 2), --mem-mb 1500,
 * --timeout 120 (s), --seed 1, --limit N, --fresh (run: start results.jsonl again).
 *
 * The truth: every widget on the page that is visible and not a push button (types
 * text, checkbox, radio, choice, signature). The flat version: the page contents
 * without annotations (see worker.ts). Scoring rules: match.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, parseArgs, readJsonl, repoRoot, type Args } from '../survey/lib/common';
import { runPool } from '../survey/lib/pool';
import type { FileRecord, MeasureJob } from './worker';
import { report } from './report';

const here = path.dirname(fileURLToPath(import.meta.url));
const PILE = '/home/garrett/pdf-survey';

export interface SampleFile {
	sha256: string;
	path: string;
	source: string;
	producer: string;
	group: 'form' | 'nonform';
	/** Real-world document (not a PDF library's test suite). */
	real: boolean;
	encryption: string;
	hybridXfa: boolean;
}

interface Profile {
	sha256: string;
	path: string;
	source: string;
	size: number;
	status: string;
	producer: string | null;
	creator: string | null;
	pages: number | null;
	encryption: string;
	damage: string;
	form: { acroform: boolean; xfa: boolean; fields: Record<string, number> } | null;
	content: { pagesSampled: number; textPages: number; imageOnlyPages: number; textOverImagePages: number } | null;
}

export const TEST_SUITES = new Set(['pdfjs-test', 'qpdf-tests', 'pdfium-tests', 'verapdf-corpus']);

/** Producer software, coarse: what made the page content. */
export function producerBucket(producer: string | null, creator: string | null): string {
	const p = `${producer ?? ''} ; ${creator ?? ''}`.toLowerCase();
	const rules: [string, RegExp][] = [
		['livecycle-designer', /designer \d|livecycle/],
		['foxit', /foxit/],
		['libreoffice', /libreoffice|openoffice/],
		['word', /microsoft.*word|word for/],
		['acrobat-pdfmaker', /pdfmaker/],
		['distiller', /distiller/],
		['adobe-pdf-library', /adobe pdf library/],
		['acrobat', /acrobat/],
		['indesign', /indesign/],
		['itext', /itext/],
		['quartz', /quartz|mac os x/],
		['antenna-house', /antenna house/],
		['ghostscript', /ghostscript/],
		['pdf-lib', /pdf-lib|pdfkit|reportlab|tcpdf|fpdf/],
		['nitro', /nitro/],
		['latex', /tex|pdftex/]
	];
	for (const [name, re] of rules) if (re.test(p)) return name;
	return p.trim() === ';' ? 'unknown' : 'other';
}

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0x100000000;
	};
}

function shuffle<T>(xs: T[], r: () => number): T[] {
	const a = [...xs];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(r() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

/**
 * Round-robin over strata: sources first (each source gets at most `perSource`, test
 * suites at most `perSuite`), inside a source over producer buckets, so neither one
 * agency nor one authoring tool dominates.
 */
function stratified(ps: Profile[], total: number, perSource: number, perSuite: number, seed: number): Profile[] {
	const r = rng(seed);
	const bySource = new Map<string, Map<string, Profile[]>>();
	for (const p of shuffle(ps, r)) {
		const b = producerBucket(p.producer, p.creator);
		let m = bySource.get(p.source);
		if (!m) bySource.set(p.source, (m = new Map()));
		let l = m.get(b);
		if (!l) m.set(b, (l = []));
		l.push(p);
	}
	const picked: Profile[] = [];
	const perSrcPicked = new Map<string, number>();
	const sources = [...bySource.keys()].sort();
	let progress = true;
	while (picked.length < total && progress) {
		progress = false;
		for (const s of sources) {
			const cap = TEST_SUITES.has(s) ? perSuite : perSource;
			if ((perSrcPicked.get(s) ?? 0) >= cap) continue;
			const buckets = [...bySource.get(s)!.entries()].filter(([, l]) => l.length).sort((a, b) => a[0].localeCompare(b[0]));
			if (!buckets.length) continue;
			// Next bucket in turn for this source.
			const turn = perSrcPicked.get(s) ?? 0;
			const [, list] = buckets[turn % buckets.length];
			picked.push(list.shift()!);
			perSrcPicked.set(s, turn + 1);
			progress = true;
			if (picked.length >= total) break;
		}
	}
	return picked;
}

function loadProfiles(args: Args): Profile[] {
	const file = args.get('profiles') ?? path.join(PILE, 'out/profiles.jsonl');
	return readJsonl<Profile>(file);
}

function sampleCommand(args: Args, out: string) {
	const profiles = loadProfiles(args);
	const seed = args.num('seed', 1);
	const fieldCount = (p: Profile) => {
		const f = p.form?.fields ?? {};
		return (f.text ?? 0) + (f.checkbox ?? 0) + (f.radio ?? 0) + (f.choice ?? 0) + (f.signature ?? 0);
	};
	const excluded: Record<string, number> = {};
	const ex = (k: string) => (excluded[k] = (excluded[k] ?? 0) + 1);
	// --exclude FILE: leave out the files of another sample (a held-out set for the final numbers).
	const exFile = args.get('exclude');
	const skip = new Set<string>(exFile ? (JSON.parse(fs.readFileSync(exFile, 'utf8')) as { files: SampleFile[] }).files.map((f) => f.sha256) : []);
	const forms: Profile[] = [];
	const nonforms: Profile[] = [];
	for (const p of profiles) {
		if (p.status !== 'ok' || !p.form || skip.has(p.sha256)) continue;
		if (p.form.acroform || p.form.xfa) {
			if (p.form.xfa && fieldCount(p) === 0) {
				ex('xfa-only');
				continue;
			}
			if (fieldCount(p) === 0) {
				ex('acroform without fillable fields');
				continue;
			}
			if (p.encryption === 'needs-password' || p.encryption === 'unknown') {
				ex(`encrypted (${p.encryption})`);
				continue;
			}
			if (p.damage !== 'clean' && p.damage !== 'warnings') {
				ex(`damaged (${p.damage})`);
				continue;
			}
			forms.push(p);
			continue;
		}
		// Non-forms: text documents (not scans), no annotations-based forms, not test suites.
		if (TEST_SUITES.has(p.source)) continue;
		if (p.encryption !== 'none' || p.damage !== 'clean') continue;
		const c = p.content;
		if (!c || c.textPages < Math.max(1, c.pagesSampled * 0.8) || c.textOverImagePages > 0) continue;
		if (/forms$/.test(p.source)) continue; // flat government forms are forms, not "non-forms"
		nonforms.push(p);
	}
	const f = stratified(forms, args.num('forms', 420), args.num('per-source', 45), args.num('per-suite', 15), seed);
	const n = stratified(nonforms, args.num('nonforms', 200), args.num('per-source-nonforms', 40), 0, seed + 1);
	const toFile = (p: Profile, group: 'form' | 'nonform'): SampleFile => ({
		sha256: p.sha256,
		path: p.path,
		source: p.source,
		producer: producerBucket(p.producer, p.creator),
		group,
		real: !TEST_SUITES.has(p.source),
		encryption: p.encryption,
		hybridXfa: !!p.form?.xfa
	});
	const files = [...f.map((p) => toFile(p, 'form')), ...n.map((p) => toFile(p, 'nonform'))];
	const pool = { forms: forms.length, nonforms: nonforms.length };
	fs.writeFileSync(path.join(out, 'sample.json'), JSON.stringify({ seed, pool, excluded, files }, null, 1));
	const count = (xs: SampleFile[], k: keyof SampleFile) => {
		const c: Record<string, number> = {};
		for (const x of xs) c[String(x[k])] = (c[String(x[k])] ?? 0) + 1;
		return Object.entries(c).sort((a, b) => b[1] - a[1]);
	};
	const sf = files.filter((x) => x.group === 'form');
	console.log(`sample: ${sf.length} forms of ${forms.length}, ${files.length - sf.length} non-forms of ${nonforms.length}`);
	console.log('excluded', excluded);
	console.log('forms by source', count(sf, 'source'));
	console.log('forms by producer', count(sf, 'producer'));
	console.log('non-forms by source', count(files.filter((x) => x.group === 'nonform'), 'source'));
}

async function runCommand(args: Args, out: string, render: boolean) {
	const sample = JSON.parse(fs.readFileSync(path.join(out, 'sample.json'), 'utf8')) as { files: SampleFile[] };
	const resultsFile = path.join(out, render ? 'render.jsonl' : 'results.jsonl');
	if (args.flag('fresh') && fs.existsSync(resultsFile)) fs.unlinkSync(resultsFile);
	const done = new Set(readJsonl<FileRecord>(resultsFile).map((r) => r.sha256));
	const maxPages = args.num('max-pages', 6);
	let jobs: MeasureJob[] = [];
	if (render) {
		const list = fs.readFileSync(args.get('files') ?? '', 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
		const pngDir = path.join(out, 'png');
		const want = new Map<string, number[]>();
		for (const l of list) {
			const [sha, pg] = l.split(':');
			const f = sample.files.find((x) => x.sha256.startsWith(sha));
			if (!f) continue;
			want.set(f.sha256, [...(want.get(f.sha256) ?? []), pg ? Number(pg) - 1 : 0]);
		}
		for (const [sha, pages] of want) jobs.push({ sha256: sha, path: sample.files.find((x) => x.sha256 === sha)!.path, maxPages: 99, render: pages, pngDir });
	} else {
		for (const f of sample.files) {
			if (done.has(f.sha256)) continue;
			jobs.push({ sha256: f.sha256, path: f.path, maxPages: f.group === 'form' ? maxPages : 3 });
		}
	}
	const limit = args.num('limit', Infinity);
	if (jobs.length > limit) jobs = jobs.slice(0, limit);
	const workers = Math.min(2, args.num('workers', 2));
	console.log(`${render ? 'render' : 'run'}: ${jobs.length} files → ${resultsFile}`);
	const t0 = Date.now();
	let n = 0;
	await runPool<MeasureJob, FileRecord>(jobs, {
		script: path.join(here, 'worker.ts'),
		workers,
		memMB: args.num('mem-mb', 1500),
		timeoutMs: args.num('timeout', 120) * 1000,
		recycleAfter: 20,
		onResult: (_job, r) => appendJsonl(resultsFile, r),
		onDone: () => {
			if (++n % 25 === 0) console.log(`  ${n}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
		},
		onFailure: (job, kind, detail) => {
			appendJsonl(resultsFile, { sha256: job.sha256, path: job.path, pages: [], pageCount: 0, error: `${kind}: ${detail}` } satisfies FileRecord);
			return null;
		}
	});
	console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

function outDir(args: Args): string {
	const dir = path.resolve(args.get('out') ?? path.join(PILE, 'out-forms-detect'));
	const rel = path.relative(repoRoot, dir);
	if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`Output must not go inside the repo (${dir}).`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

const [step, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const out = outDir(args);
switch (step) {
	case 'sample':
		sampleCommand(args, out);
		break;
	case 'run':
		await runCommand(args, out, false);
		break;
	case 'render':
		await runCommand(args, out, true);
		break;
	case 'report':
		report(args, out);
		break;
	default:
		console.error('usage: measure.ts <sample|run|report|render> [options]');
		process.exit(2);
}
