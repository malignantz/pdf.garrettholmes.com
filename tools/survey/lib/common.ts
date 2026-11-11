/**
 * Shared plumbing: options, paths, JSONL files, input discovery, sandboxed
 * external tools.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './paths';

export { repoRoot };

export const DEFAULT_PILE = '/home/garrett/pdf-survey';

/** Parsed `--name value` / `--flag` arguments (repeatable names collect into arrays). */
export interface Args {
	_: string[];
	get(name: string): string | undefined;
	all(name: string): string[];
	num(name: string, fallback: number): number;
	flag(name: string): boolean;
}

export function parseArgs(argv: string[]): Args {
	const values = new Map<string, string[]>();
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) {
			rest.push(a);
			continue;
		}
		const eq = a.indexOf('=');
		let name: string;
		let value: string;
		if (eq > 0) {
			name = a.slice(2, eq);
			value = a.slice(eq + 1);
		} else {
			name = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith('--')) {
				value = next;
				i++;
			} else value = 'true';
		}
		values.set(name, [...(values.get(name) ?? []), value]);
	}
	return {
		_: rest,
		get: (n) => values.get(n)?.at(-1),
		all: (n) => values.get(n) ?? [],
		num: (n, d) => {
			const v = values.get(n)?.at(-1);
			if (v === undefined) return d;
			const x = Number(v);
			if (!Number.isFinite(x)) throw new Error(`--${n} must be a number`);
			return x;
		},
		flag: (n) => {
			const v = values.get(n)?.at(-1);
			return v !== undefined && v !== 'false' && v !== '0';
		}
	};
}

/** Output folder: --out, else $SURVEY_OUT, else /home/garrett/pdf-survey/out. Refuses a folder inside the repo. */
export function outDir(args: Args): string {
	const dir = path.resolve(args.get('out') ?? process.env.SURVEY_OUT ?? path.join(DEFAULT_PILE, 'out'));
	const rel = path.relative(repoRoot, dir);
	if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
		throw new Error(`Survey output must not go inside the repo (${dir}). Use --out or SURVEY_OUT.`);
	}
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function readJsonl<T>(file: string): T[] {
	if (!fs.existsSync(file)) return [];
	const out: T[] = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// A line cut short by a killed run; ignore it (the item is redone).
		}
	}
	return out;
}

export function appendJsonl(file: string, row: unknown) {
	fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

export interface InputFile {
	path: string;
	size: number;
	source: string;
	sha256?: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
/** Files modified more recently than this are assumed to be still downloading. */
export const SETTLE_MS = 120_000;

/**
 * Candidate PDFs. Each input is a TSV (sha256, path, size, source) or a folder walked
 * recursively for files named *.pdf or starting with "%PDF" within 1 KB.
 */
export function discover(inputs: string[]): InputFile[] {
	const found = new Map<string, InputFile>();
	for (const given of inputs) {
		const input = path.resolve(given);
		if (!fs.existsSync(input)) continue;
		const stat = fs.statSync(input);
		if (stat.isFile() && /\.tsv$/i.test(input)) {
			for (const line of fs.readFileSync(input, 'utf8').split('\n')) {
				const cols = line.split('\t');
				if (cols.length < 2 || !HEX64.test(cols[0])) continue;
				const p = path.resolve(path.dirname(input), cols[1]);
				if (!fs.existsSync(p)) continue;
				found.set(p, { path: p, sha256: cols[0].toLowerCase(), size: Number(cols[2]) || fs.statSync(p).size, source: cols[3]?.trim() || 'tsv' });
			}
		} else if (stat.isDirectory()) {
			const label = path.basename(input);
			walk(input, (p, st) => {
				if (found.has(p)) return;
				if (Date.now() - st.mtimeMs < SETTLE_MS) return;
				if (!/\.pdf$/i.test(p) && !startsLikePdf(p)) return;
				const rel = path.relative(input, p).split(path.sep);
				found.set(p, { path: p, size: st.size, source: rel.length > 1 ? rel[0] : label });
			});
		} else if (stat.isFile()) {
			found.set(input, { path: input, size: stat.size, source: 'arg' });
		}
	}
	return [...found.values()].filter((f) => f.size > 0);
}

function walk(dir: string, visit: (p: string, st: fs.Stats) => void) {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, visit);
		else if (e.isFile()) {
			try {
				visit(p, fs.statSync(p));
			} catch {
				// Vanished.
			}
		}
	}
}

function startsLikePdf(p: string): boolean {
	let fd: number | null = null;
	try {
		fd = fs.openSync(p, 'r');
		const buf = Buffer.alloc(1024);
		const n = fs.readSync(fd, buf, 0, 1024, 0);
		return buf.subarray(0, n).includes('%PDF-');
	} catch {
		return false;
	} finally {
		if (fd !== null) fs.closeSync(fd);
	}
}

/** sha256 of each file, cached in out/hashes.jsonl by (path, size, mtime). */
export function hashAll(files: InputFile[], out: string): InputFile[] {
	const cacheFile = path.join(out, 'hashes.jsonl');
	const cache = new Map<string, string>();
	for (const r of readJsonl<{ key: string; sha256: string }>(cacheFile)) cache.set(r.key, r.sha256);
	for (const f of files) {
		if (f.sha256) continue;
		const st = fs.statSync(f.path);
		const key = `${f.path}\0${st.size}\0${st.mtimeMs}`;
		let sha = cache.get(key);
		if (!sha) {
			sha = createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');
			appendJsonl(cacheFile, { key, sha256: sha });
		}
		f.sha256 = sha;
	}
	return files;
}

/** Default inputs: the pile (files.tsv if present, else raw/) plus the repo's corpus. */
export function defaultInputs(args: Args): string[] {
	const given = args.all('input');
	if (given.length) return given;
	const pile = process.env.SURVEY_PILE ?? DEFAULT_PILE;
	const tsv = path.join(pile, 'files.tsv');
	const inputs = [fs.existsSync(tsv) ? tsv : path.join(pile, 'raw')];
	if (!args.flag('no-corpus')) inputs.push(path.join(repoRoot, 'tests/corpus/files'));
	return inputs;
}

export interface ToolResult {
	code: number | null;
	stdout: string;
	stderr: string;
	/** Killed by its timeout. */
	timedOut: boolean;
}

/** Memory limit (address space) for external tools such as poppler. */
const TOOL_AS_BYTES = 2 * 1024 ** 3;
const hasPrlimit = fs.existsSync('/usr/bin/prlimit');

/** Runs an external tool with a timeout and an address-space cap; never throws. */
export function tool(cmd: string, args: string[], timeoutMs = 30_000, maxBuffer = 64 * 1024 * 1024): Promise<ToolResult> {
	const [file, argv] = hasPrlimit ? ['/usr/bin/prlimit', [`--as=${TOOL_AS_BYTES}`, '--', cmd, ...args]] : [cmd, args];
	return new Promise((resolve) => {
		execFile(file, argv, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
			const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
			resolve({
				code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
				stdout: stdout ?? '',
				stderr: stderr ?? '',
				timedOut: e?.killed === true
			});
		});
	});
}

export function shortError(e: unknown, max = 300): string {
	const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
	return s.replace(/\s+/g, ' ').slice(0, max);
}
