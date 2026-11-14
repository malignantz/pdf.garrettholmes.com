/**
 * The final check in real Chrome (system Chrome through Playwright): the engine in a
 * dedicated worker, as in the app, served by a plain Vite dev server on 127.0.0.1:4394.
 * Generated files only (tools/fast-check/gen.ts); they are handed to the page by a local
 * route, never copied into the repo.
 *
 *   npm run fastcheck:browser [-- --files scan-260,photo-260 --reps 2 --out DIR]
 *
 * Per file: 'raw' (fresh qpdf instance, copy into the wasm FS, full and fast check of the
 * file as given) and 'export' (open, then the plain export with the fast check and with
 * fullCheck, the order alternating per repetition). Writes browser.json and browser.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { parseArgs, repoRoot } from '../survey/lib/common';
import { generate, GENERATED } from './gen';

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? '/home/garrett/pdf-survey/out-fast-check');
if (!path.relative(repoRoot, out).startsWith('..')) throw new Error('output must be outside the repo');
const names = (args.get('files') ?? 'scan-30,scan-260,photo-260,text-1000,streams').split(',') as (keyof typeof GENERATED)[];
if (!names.includes('text-1000')) names.push('text-1000');
const reps = args.num('reps', 2);
const port = args.num('port', 4394);
const files = await generate(path.join(out, 'gen'), names);

const server = await createServer({
	configFile: false,
	root: repoRoot,
	logLevel: 'warn',
	worker: { format: 'es' },
	server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [repoRoot] } },
	cacheDir: path.join(out, 'vite-cache'),
	optimizeDeps: { include: ['@neslinesli93/qpdf-wasm'] },
	plugins: [
		{
			name: 'fast-check-files',
			configureServer(s) {
				s.middlewares.use('/__fc/file/', (req, res) => {
					const n = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0]);
					const f = files[n as keyof typeof files];
					if (!f) {
						res.statusCode = 404;
						res.end();
						return;
					}
					res.setHeader('content-type', 'application/pdf');
					fs.createReadStream(f).pipe(res);
				});
			}
		}
	]
});
await server.listen();
const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined });
const results: Record<string, unknown>[] = [];
try {
	const page = await browser.newPage();
	page.on('pageerror', (e) => console.log('pageerror', e.message));
	const open = async () => {
		await page.goto(`http://127.0.0.1:${port}/tools/fast-check/browser/bench.html`);
		await page.waitForFunction(() => (window as unknown as { benchReady?: boolean }).benchReady === true);
	};
	// Warm-up: the dev server optimizes dependencies on first use and then reloads the page.
	for (let i = 0; i < 4; i++) {
		await open();
		try {
			await page.evaluate(() => (window as unknown as { bench: (n: string, j: unknown) => Promise<unknown> }).bench('text-1000', { kind: 'export', order: ['fast'] }));
			break;
		} catch (e) {
			console.log(`warm-up ${i + 1}: ${(e as Error).message.split('\n')[0]}`);
		}
	}
	const ua = await page.evaluate(() => navigator.userAgent);
	for (const n of names) {
		for (let r = 0; r < reps; r++) {
			const raw = await page.evaluate(([f]) => (window as unknown as { bench: (n: string, j: unknown) => Promise<unknown> }).bench(f, { kind: 'raw' }), [n]);
			const order = r % 2 === 0 ? ['fast', 'full'] : ['full', 'fast'];
			const exp = await page.evaluate(([f, o]) => (window as unknown as { bench: (n: string, j: unknown) => Promise<unknown> }).bench(f as string, { kind: 'export', order: o }), [n, order] as const);
			const row = { file: n, rep: r, size: fs.statSync(files[n]).size, raw, export: exp, load: fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0] };
			console.log(JSON.stringify(row));
			results.push(row);
		}
	}
	fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ ua, results }, null, 1));
	const md = [`# Final check in Chrome (${new Date().toISOString().slice(0, 10)})`, '', `${ua}; engine in a dedicated worker; plain export (Optimize off). Each row is one repetition; load average at the end of the row in the last column.`, '', '| file | MB | fresh instance | copy in | check of the file: full → fast (same output) | plain export, whole: full → fast | its final check: full → fast | load |', '|---|---:|---:|---:|---:|---:|---:|---:|'];
	type Raw = { instanceMs: number; copyInMs: number; fullMs: number; fastMs: number; same: boolean; error?: string };
	type Exp = { fast: { ms: number; check: string }; full: { ms: number; check: string }; error?: string };
	const checkMs = (s: string) => [...s.matchAll(/(\d+) ms/g)].reduce((t, m) => t + Number(m[1]), 0);
	for (const row of results) {
		const raw = ((row.raw as { result?: Raw }).result ?? row.raw) as Raw;
		const e = ((row.export as { result?: Exp }).result ?? row.export) as Exp;
		if (raw.error || e.error) {
			md.push(`| ${row.file} | | error: ${raw.error ?? e.error} | | | | | |`);
			continue;
		}
		md.push(`| ${row.file} | ${((row.size as number) / 1e6).toFixed(1)} | ${raw.instanceMs} ms | ${raw.copyInMs} ms | ${(raw.fullMs / 1000).toFixed(1)} → ${(raw.fastMs / 1000).toFixed(1)} s (${raw.same}) | ${(e.full.ms / 1000).toFixed(1)} → ${(e.fast.ms / 1000).toFixed(1)} s | ${(checkMs(e.full.check) / 1000).toFixed(1)} → ${(checkMs(e.fast.check) / 1000).toFixed(1)} s | ${row.load} |`);
	}
	fs.writeFileSync(path.join(out, 'browser.md'), md.join('\n') + '\n');
	console.log(md.join('\n'));
} finally {
	await browser.close();
	await server.close();
}
