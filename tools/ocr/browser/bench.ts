/**
 * tesseract.js in real Chrome (system Chrome through Playwright), everything served from one
 * local origin; every request to any other origin is blocked and counted. Measures engine
 * load, time to first result, seconds per page, a worker pool, peak memory of Chrome's
 * processes, and 4× CPU throttling (Chrome's DevTools throttle) as a phone proxy. Also checks
 * that Chrome and Node give the same words for the same image.
 *
 *   npm run ocr:browser -- [--images DIR] [--out DIR] [--quick]
 *
 * Images: the benchmark set written by `ocr:measure -- synth --set hold --bench-images`
 * (<out>/png/bench/, inside the survey folder). Results: <out>/results/browser.json, report-browser.md.
 *
 * Chrome's DevTools CPU throttle (Emulation.setCPUThrottlingRate on the page) does not reach dedicated
 * workers (measured: no slowdown), so the phone proxy is a CPU quota on the whole run instead:
 *   systemd-run --user --scope -p CPUQuota=25% npm run ocr:browser -- --only '^fast, 1 worker, 300' --tag quota25
 * (25% of one core = a single thread 4× slower; 50% for two workers).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { parseArgs } from '../../survey/lib/common';
import { tessWorker } from '../lib/tess';

const here = path.dirname(fileURLToPath(import.meta.url));
const OCR = path.resolve(here, '..');
const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? '/home/garrett/pdf-survey/out-ocr');
const imgDir = path.resolve(args.get('images') ?? path.join(out, 'png', 'bench'));
const quick = args.flag('quick');
// --only REGEX: run the scenarios whose name matches; --tag T: results go to browser-T.json / report-browser-T.md.
const only = args.get('only') ? new RegExp(args.get('only')!) : null;
const tag = args.get('tag') ? `-${args.get('tag')}` : '';

// ---------------------------------------------------------------- static server
const routes: [string, string][] = [
	['/t/', path.join(OCR, 'node_modules/tesseract.js/dist/')],
	['/core/', path.join(OCR, 'node_modules/tesseract.js-core/')],
	['/lang/', path.join(OCR, 'models/')],
	['/img/', imgDir + '/']
];
const served: { path: string; bytes: number }[] = [];
const types: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
	const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
	let file: string | null = null;
	if (url === '/bench.html' || url === '/bench.js') file = path.join(here, url.slice(1));
	for (const [pre, dir] of routes) if (url.startsWith(pre)) file = path.join(dir, url.slice(pre.length));
	if (!file || file.includes('..') || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
		res.writeHead(404).end();
		return;
	}
	const body = fs.readFileSync(file);
	served.push({ path: url, bytes: body.length });
	res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// ---------------------------------------------------------------- memory of Chrome's processes
function children(pid: number): number[] {
	const out: number[] = [];
	for (const d of fs.readdirSync('/proc')) {
		if (!/^\d+$/.test(d)) continue;
		try {
			const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
			const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
			if (ppid === pid) out.push(Number(d), ...children(Number(d)));
		} catch {
			// gone
		}
	}
	return out;
}
function rssMB(pids: number[]): number {
	let kb = 0;
	for (const p of pids) {
		try {
			const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p}/status`, 'utf8'));
			kb += m ? Number(m[1]) : 0;
		} catch {
			// gone
		}
	}
	return Math.round(kb / 1024);
}

// ---------------------------------------------------------------- images
const all = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).sort() : [];
const set = (suffix: RegExp, dpi: number, n: number) => all.filter((f) => suffix.test(f)).slice(0, n).map((f) => ({ url: `/img/${f}`, dpi, file: f }));
const N = quick ? 4 : 20;
const sets = {
	'300': set(/-scan-300\.jpg$/, 300, N),
	'200→300': set(/-scan-200up\.png$/, 300, quick ? 3 : 10),
	'150→300': set(/-scan-150up\.png$/, 300, quick ? 3 : 10),
	'200': set(/-scan-200\.jpg$/, 200, quick ? 3 : 10),
	'150': set(/-scan-150\.jpg$/, 150, quick ? 3 : 10)
};

interface Scenario {
	name: string;
	model: string;
	images: { url: string; dpi: number; file: string }[];
	workers: number;
	throttle: number;
	core?: string;
	imageSet: string;
}
const sc: Scenario[] = [
	{ name: 'fast, 1 worker, 300 dpi', model: 'fast', images: sets['300'], workers: 1, throttle: 1, imageSet: '300' },
	{ name: 'fast, 1 worker, 200→300', model: 'fast', images: sets['200→300'], workers: 1, throttle: 1, imageSet: '200→300' },
	{ name: 'fast, 1 worker, 150→300', model: 'fast', images: sets['150→300'], workers: 1, throttle: 1, imageSet: '150→300' },
	{ name: 'fast, 1 worker, 200 as is', model: 'fast', images: sets['200'], workers: 1, throttle: 1, imageSet: '200' },
	{ name: 'fast, 1 worker, 150 as is', model: 'fast', images: sets['150'], workers: 1, throttle: 1, imageSet: '150' },
	{ name: 'best_int, 1 worker, 300 dpi', model: 'best_int', images: sets['300'].slice(0, quick ? 3 : 10), workers: 1, throttle: 1, imageSet: '300' },
	{ name: 'best (float, SIMD core), 1 worker, 300 dpi', model: 'best', images: sets['300'].slice(0, quick ? 2 : 5), workers: 1, throttle: 1, core: '/core/tesseract-core-simd-lstm.wasm.js', imageSet: '300' },
	{ name: 'fast, 2 workers, 300 dpi', model: 'fast', images: sets['300'], workers: 2, throttle: 1, imageSet: '300' },
	{ name: 'fast, 4 workers, 300 dpi', model: 'fast', images: sets['300'], workers: 4, throttle: 1, imageSet: '300' },
	{ name: 'fast, 1 worker, 300 dpi, CPU 4× slower', model: 'fast', images: sets['300'].slice(0, quick ? 2 : 6), workers: 1, throttle: 4, imageSet: '300' },
	{ name: 'fast, 2 workers, 300 dpi, CPU 4× slower', model: 'fast', images: sets['300'].slice(0, quick ? 2 : 6), workers: 2, throttle: 4, imageSet: '300' }
];

const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true });
const blocked: string[] = [];
const results: Record<string, unknown>[] = [];
const quantile = (v: number[], q: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(q * v.length))] ?? 0;

async function throttleAll(page: Page, rate: number) {
	// The page's own session, and every dedicated worker's (CPU throttling is per target).
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate });
	return cdp;
}

for (const s of sc) {
	if (!s.images.length || (only && !only.test(s.name))) continue;
	const ctx = await browser.newContext();
	await ctx.route('**/*', (route) => {
		const u = route.request().url();
		if (u.startsWith(origin + '/')) return route.continue();
		blocked.push(u);
		return route.abort();
	});
	const page = await ctx.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});
	const servedBefore = served.length;
	await page.goto(`${origin}/bench.html`);
	await page.waitForFunction(() => document.getElementById('status')?.textContent === 'loaded');
	if (s.throttle > 1) await throttleAll(page, s.throttle);
	const pids = children(process.pid);
	const base = rssMB(pids);
	let peak = base;
	const timer = setInterval(() => {
		peak = Math.max(peak, rssMB(children(process.pid)));
	}, 100);
	const t0 = Date.now();
	let r: { load: number; first: number; total: number; results: { ms: number; words: unknown[] }[] } | null = null;
	try {
		r = await page.evaluate((o) => (window as unknown as { bench: (o: unknown) => Promise<never> }).bench(o), { model: s.model, images: s.images.map(({ url, dpi }) => ({ url, dpi })), workers: s.workers, core: s.core ?? '/core/' });
	} catch (e) {
		errors.push(String(e));
	}
	clearInterval(timer);
	const wall = Date.now() - t0;
	const bytes = served.slice(servedBefore).filter((x) => !x.path.startsWith('/img/'));
	const ms = r?.results.map((x) => x.ms) ?? [];
	const row = {
		name: s.name,
		model: s.model,
		workers: s.workers,
		throttle: s.throttle,
		imageSet: s.imageSet,
		pages: s.images.length,
		loadS: r ? r.load / 1000 : null,
		firstS: r ? r.first / 1000 : null,
		p50: quantile(ms, 0.5) / 1000,
		p90: quantile(ms, 0.9) / 1000,
		max: Math.max(0, ...ms) / 1000,
		throughput: r ? s.images.length / (r.total / 1000 - r.load / 1000) : null,
		wallS: wall / 1000,
		baseMB: base,
		peakMB: peak,
		engineBytes: bytes.reduce((a, b) => a + b.bytes, 0),
		engineFiles: bytes.map((b) => b.path),
		errors,
		words: r?.results.map((x) => x.words) ?? []
	};
	results.push(row);
	console.log(`${s.name}: load ${row.loadS?.toFixed(2)} s, first ${row.firstS?.toFixed(1)} s, per page p50 ${row.p50.toFixed(1)} / p90 ${row.p90.toFixed(1)} / max ${row.max.toFixed(1)} s, ${row.throughput?.toFixed(2)} pages/s, Chrome RSS ${base} → ${peak} MB${errors.length ? `, errors: ${errors.slice(0, 2).join(' | ')}` : ''}`);
	await ctx.close();
}
await browser.close();
server.close();

// Chrome vs Node: the same words for the same images?
const first = results.find((r) => r.name === 'fast, 1 worker, 300 dpi') as { words: [string, ...number[]][][] } | undefined;
let same = 0;
let compared = 0;
const diffs: string[] = [];
if (first) {
	const w = await tessWorker('fast');
	for (let i = 0; i < sets['300'].length; i++) {
		const o = await w.recognize(fs.readFileSync(path.join(imgDir, sets['300'][i].file)), 300, {}, { deskew: true });
		const a = JSON.stringify(o.words.map((x) => x[0]));
		const b = JSON.stringify((first.words[i] ?? []).map((x) => x[0]));
		compared++;
		if (a === b) same++;
		else diffs.push(`${sets['300'][i].file}: node ${o.words.length} words, chrome ${(first.words[i] ?? []).length}`);
	}
	await w.terminate();
}
const summary = { origin, blocked, chromeVsNode: { compared, identical: same, diffs }, results: results.map(({ words, ...r }) => (void words, r)) };
fs.mkdirSync(path.join(out, 'results'), { recursive: true });
fs.writeFileSync(path.join(out, 'results', `browser${tag}.json`), JSON.stringify(summary, null, 1));
const L = ['# tesseract.js in Chrome (system Chrome, headless, Playwright)', '', `Requests to other origins: ${blocked.length} (${blocked.slice(0, 5).join(', ')}). Chrome vs Node, same images (fast, 300 dpi): ${same} of ${compared} pages give the identical word sequence (boxes not compared: Chrome's are in the deskewed frame).`, '', '| scenario | pages | engine load s | first result s (cold) | s/page p50 | p90 | max | pages/s | Chrome RSS before → peak MB | engine bytes fetched |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
for (const r of summary.results as Record<string, number & string>[])
	L.push(`| ${r.name} | ${r.pages} | ${Number(r.loadS).toFixed(2)} | ${Number(r.firstS).toFixed(1)} | ${Number(r.p50).toFixed(1)} | ${Number(r.p90).toFixed(1)} | ${Number(r.max).toFixed(1)} | ${Number(r.throughput).toFixed(2)} | ${r.baseMB} → ${r.peakMB} | ${(Number(r.engineBytes) / 1e6).toFixed(1)} MB |`);
fs.writeFileSync(path.join(out, `report-browser${tag}.md`), L.join('\n') + '\n');
console.log(L.join('\n'));
