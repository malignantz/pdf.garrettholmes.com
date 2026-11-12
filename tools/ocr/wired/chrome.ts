/**
 * Desktop Chrome speed and memory of "Make scanned pages searchable", through the real
 * app (the production build, served with its own headers by scripts/serve-build.mjs):
 * open a 20-page scanned file, export with the option on, twice (first use, then with
 * the OCR files cached). Per-page times come from the engine's debug notes, the wall
 * time from the dialog; memory is the RSS of all of Chrome's processes, sampled.
 * Requests to other origins are aborted and counted.
 *
 *   node … tools/ocr/wired/chrome.ts make     # <out>/bench/bench20.pdf from 20 held-out synthetic scans (survey-derived; stays there)
 *   node … tools/ocr/wired/chrome.ts run [--port 4393]   # needs `npm run build`
 * Output: <out>/report-chrome.md, <out>/chrome.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import * as mupdf from 'mupdf';
import * as PL from '@cantoo/pdf-lib';
import { chromium } from '@playwright/test';
import { parseArgs, readJsonl, repoRoot } from '../../survey/lib/common';
import { degrade, hashSeed } from '../lib/synth';
import { encode, renderGray } from '../lib/truth';
import type { SynthResult } from '../synth-worker';
import { OUT, quant } from './common';

const [step, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const bench = path.join(OUT, 'bench', 'bench20.pdf');

if (step === 'make') {
	const sample = JSON.parse(fs.readFileSync('/home/garrett/pdf-survey/out-ocr/synth-sample.json', 'utf8')) as Record<string, { sha256: string; path: string }[]>;
	const paths = new Map<string, string>();
	for (const list of Object.values(sample)) if (Array.isArray(list)) for (const f of list) paths.set(f.sha256, f.path);
	const out = await PL.PDFDocument.create();
	let n = 0;
	const seen = new Set<string>();
	for (const r of readJsonl<SynthResult>('/home/garrett/pdf-survey/out-ocr/results/synth-hold.jsonl'))
		for (const p of r.pages) {
			if (n >= 20 || seen.has(p.sha256) || !paths.get(p.sha256)) continue;
			// Letter-size pages of ordinary prose and forms, one per file.
			if (Math.abs(p.W - 612) > 2 || Math.abs(p.H - 792) > 2 || !/letter|form/.test(p.kind)) continue;
			seen.add(p.sha256);
			const doc = mupdf.Document.openDocument(fs.readFileSync(paths.get(p.sha256)!), 'application/pdf');
			const d = degrade(renderGray(mupdf, doc, p.page, 300), 'scan', 300, hashSeed(`${p.sha256}:${p.page}:scan:300`));
			doc.destroy();
			const jpg = await out.embedJpg(encode(mupdf, d.img, 'jpeg', d.q));
			out.addPage([p.W, p.H]).drawImage(jpg, { x: 0, y: 0, width: p.W, height: p.H });
			n++;
		}
	fs.mkdirSync(path.dirname(bench), { recursive: true });
	fs.writeFileSync(bench, await out.save());
	console.log(`${n} pages → ${bench} (${(fs.statSync(bench).size / 1e6).toFixed(1)} MB)`);
	process.exit(0);
}

if (step === 'run') {
	const port = args.num('port', 4393);
	const server = spawn('node', [path.join(repoRoot, 'scripts/serve-build.mjs'), String(port)], { stdio: 'ignore' });
	await new Promise((r) => setTimeout(r, 1500));
	const base = `http://127.0.0.1:${port}`;
	const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true });
	const pid = (browser as unknown as { process?: () => { pid: number } }).process?.()?.pid;
	const tree = (root: number): number[] => {
		const out = [root];
		for (const line of execFileSync('ps', ['-eo', 'pid=,ppid=']).toString().trim().split('\n')) {
			const [p, pp] = line.trim().split(/\s+/).map(Number);
			if (out.includes(pp) && !out.includes(p)) out.push(p);
		}
		// Second pass for grandchildren.
		for (const line of execFileSync('ps', ['-eo', 'pid=,ppid=']).toString().trim().split('\n')) {
			const [p, pp] = line.trim().split(/\s+/).map(Number);
			if (out.includes(pp) && !out.includes(p)) out.push(p);
		}
		return out;
	};
	const rss = (): number => {
		if (!pid) return 0;
		let kb = 0;
		for (const p of tree(pid)) {
			try {
				const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p}/status`, 'utf8'));
				if (m) kb += Number(m[1]);
			} catch {
				// gone
			}
		}
		return kb / 1024;
	};
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const external: string[] = [];
	await context.route('**/*', (route) => {
		const u = route.request().url();
		if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith(base)) return route.continue();
		external.push(u);
		return route.abort('blockedbyclient');
	});
	const page = await context.newPage();
	const notes: { t: number; text: string }[] = [];
	page.on('console', (m) => {
		if (m.text().includes('ocr: page')) notes.push({ t: Date.now(), text: m.text() });
	});
	await page.goto(base);
	await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
	const runs: Record<string, unknown>[] = [];
	for (const label of ['first use', 'cached']) {
		notes.length = 0;
		await page.goto(base);
		await page.locator('input[type=file]').first().setInputFiles([bench]);
		await page.getByRole('option').nth(19).waitFor({ timeout: 60_000 });
		await page.getByRole('button', { name: 'Export', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Export PDF' });
		const option = dialog.getByRole('switch', { name: 'Make scanned pages searchable' });
		await option.waitFor({ timeout: 60_000 });
		if (!(await option.isChecked())) await option.click();
		const before = rss();
		let peak = before;
		const sampler = setInterval(() => (peak = Math.max(peak, rss())), 500);
		const t0 = Date.now();
		await dialog.getByRole('button', { name: 'Export', exact: true }).click();
		let firstReading = 0;
		await page.getByText(/^Reading page/).waitFor({ timeout: 120_000 }).then(() => (firstReading = Date.now() - t0));
		const done = page.getByRole('dialog', { name: 'Your file is ready' });
		await done.getByText(/made searchable/).waitFor({ timeout: 900_000 });
		const total = Date.now() - t0;
		clearInterval(sampler);
		const result = await done.getByText(/made searchable/).first().textContent();
		const reads = notes.map((n) => Number(/reading (\d+) ms/.exec(n.text)?.[1] ?? NaN)).filter(Number.isFinite);
		const orients = notes.map((n) => Number(/orientation (\d+) ms/.exec(n.text)?.[1] ?? NaN)).filter(Number.isFinite);
		const ocrSpan = notes.length ? notes[notes.length - 1].t - t0 : 0;
		runs.push({ label, pages: notes.length, totalMs: total, firstReadingMs: firstReading, ocrSpanMs: ocrSpan, readP50: quant(reads, 0.5), readP90: quant(reads, 0.9), readMax: Math.max(...reads), orientP50: quant(orients, 0.5), rssBefore: Math.round(before), rssPeak: Math.round(peak), result, notes: notes.map((n) => n.text) });
		console.log(label, JSON.stringify(runs[runs.length - 1]).slice(0, 400));
		await done.getByRole('button', { name: 'Close' }).click();
	}
	await browser.close();
	server.kill();
	fs.writeFileSync(path.join(OUT, 'chrome.json'), JSON.stringify({ external, runs, cores: (await import('node:os')).cpus().length }, null, 1));
	const L = ['# Make scanned pages searchable in desktop Chrome', '', `System Chrome headless, the production build served locally with its own headers; ${bench.split('/').pop()}: 20 held-out synthetic scans (scan, 300 dpi, Letter), two OCR workers (this box: ${(await import('node:os')).cpus().length} cores). Requests to other origins: ${external.length}.`, '', '| run | pages read | whole export | first "Reading page" | reading per page p50 / p90 / max | orientation per page p50 | Chrome RSS before → peak |', '|---|---:|---:|---:|---:|---:|---:|'];
	for (const r of runs as { label: string; pages: number; totalMs: number; firstReadingMs: number; readP50: number; readP90: number; readMax: number; orientP50: number; rssBefore: number; rssPeak: number }[])
		L.push(`| ${r.label} | ${r.pages} | ${(r.totalMs / 1000).toFixed(1)} s | ${(r.firstReadingMs / 1000).toFixed(1)} s | ${(r.readP50 / 1000).toFixed(1)} / ${(r.readP90 / 1000).toFixed(1)} / ${(r.readMax / 1000).toFixed(1)} s | ${(r.orientP50 / 1000).toFixed(1)} s | ${r.rssBefore} → ${r.rssPeak} MB |`);
	fs.writeFileSync(path.join(OUT, 'report-chrome.md'), L.join('\n') + '\n');
	console.log(L.join('\n'));
	process.exit(0);
}
