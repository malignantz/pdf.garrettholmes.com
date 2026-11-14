// Drive one candidate page in headless system Chrome with every non-local request aborted.
// Usage: node run.mjs CANDIDATE OUT_DIR DOC_LIST_FILE [--phone]
//   CANDIDATE: lo | zeta | mammoth | docxpreview   (page /web/<candidate>.html)
//   DOC_LIST_FILE: one URL path per line, e.g. /docs/gen/lt01-letter-calibri.docx
// Writes OUT_DIR/<name>.pdf, OUT_DIR/results.tsv, OUT_DIR/load.json.
// Needs: node tools/docx-trial/serve.mjs running on PORT (default 4393).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('../../node_modules/playwright');
const [cand, out, listFile, ...flags] = process.argv.slice(2);
const phone = flags.includes('--phone');
const PORT = process.env.PORT || 4393;
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT = Number(process.env.CONV_TIMEOUT || 180000);
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120000);
const loadAttempts = [];
mkdirSync(out, { recursive: true });
const docs = readFileSync(listFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

// Resident memory of Chrome's whole process tree, in MB (sum of RSS; shared pages counted more than once).
function treeRssMb(rootPid) {
	try {
		const ps = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
		const rows = ps.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
		const kids = new Map();
		for (const [pid, ppid] of rows) (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push(pid);
		const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
		let sum = 0;
		const stack = [rootPid];
		while (stack.length) {
			const p = stack.pop();
			sum += rss.get(p) || 0;
			stack.push(...(kids.get(p) || []));
		}
		return Math.round(sum / 1024);
	} catch { return null; }
}

const browser = await chromium.launch({
	executablePath: '/opt/google/chrome/chrome',
	headless: true,
	args: ['--js-flags=--max-old-space-size=4096'],
});
// Chrome is a direct child of this node process; its renderers, GPU and utility processes hang below it.
const rootPid = Number(execFileSync('ps', ['-o', 'pid=', '--ppid', String(process.pid)], { encoding: 'utf8' })
	.trim().split('\n').map(Number).find((p) => {
		try { return /chrome/.test(execFileSync('ps', ['-o', 'comm=', '-p', String(p)], { encoding: 'utf8' })); } catch { return false; }
	}));
let peak = 0;
const sampler = setInterval(() => { const m = treeRssMb(rootPid); if (m && m > peak) peak = m; }, 250);
const ctx = await browser.newContext(phone ? { ...devices['Pixel 7'] } : {});
const aborted = [];
await ctx.route('**/*', (route) => {
	const u = new URL(route.request().url());
	if (u.hostname === '127.0.0.1' || u.protocol === 'blob:' || u.protocol === 'data:') return route.continue();
	aborted.push(u.href);
	return route.abort();
});
let bytes = 0;
const consoleLog = [];
// Workers' fetches are not seen by the page's CDP session; count them from the server log instead.
const servedLog = '/home/garrett/pdf-survey/docx-trial/out/served.log';
const servedBefore = existsSync(servedLog) ? readFileSync(servedLog, 'utf8').length : 0;
let page;
let reloads = 0;
const hangs = [];

// Open the candidate page and wait until its engine says ready. Returns {readyMs, loadErr}.
async function openPage() {
	if (page) await page.close().catch(() => {});
	page = await ctx.newPage();
	const cdp = await ctx.newCDPSession(page);
	await cdp.send('Network.enable');
	cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
	page.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text()}`.slice(0, 400)));
	page.on('pageerror', (e) => consoleLog.push(`pageerror: ${e.message}`.slice(0, 400)));
	page.on('crash', () => consoleLog.push('page crashed'));
	const t0 = Date.now();
	for (let attempt = 1; attempt <= 3; attempt++) {
		const r = await openOnce(t0);
		loadAttempts.push({ ms: Date.now() - t0, ...r });
		if (!r.loadErr || !/timeout/i.test(r.loadErr)) return r;
		consoleLog.push(`load attempt ${attempt} timed out, reloading`);
	}
	return { readyMs: null, loadErr: 'not ready after 3 attempts' };
}

async function openOnce(t0) {
	try {
		await page.goto(`${BASE}/web/${cand}.html`);
		await page.waitForFunction(() => window.trial && (window.trial.ready || window.trial.error), null, { timeout: READY_TIMEOUT, polling: 250 });
		const st = await page.evaluate(() => window.trial);
		return { readyMs: st.readyMs ?? Date.now() - t0, loadErr: st.error };
	} catch (e) { return { readyMs: null, loadErr: String(e.message || e) }; }
}

const { readyMs, loadErr } = await openPage();
const memReady = treeRssMb(rootPid);
const servedText = existsSync(servedLog) ? readFileSync(servedLog, 'utf8').slice(servedBefore) : '';
const servedBytes = servedText.split('\n').filter(Boolean).reduce((a, l) => a + Number(l.split('\t')[1]), 0);
const isolated = await page.evaluate(() => self.crossOriginIsolated).catch(() => null);
const load = { cand, phone, readyMs, loadErr, servedBytesAtReady: servedBytes, pageCdpBytes: bytes, memReadyMb: memReady, crossOriginIsolated: isolated };
console.log(JSON.stringify(load));

const res = join(out, 'results.tsv');
writeFileSync(res, 'file\tstatus\tms\tbytes\terror\n');
if (!loadErr) {
	for (const d of docs) {
		const name = d.split('/').pop().replace(/\.docx$/, '');
		let r;
		try {
			r = await Promise.race([
				page.evaluate((u) => window.convertUrl(u), d),
				new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT)),
			]);
		} catch (e) { r = { error: String(e.message || e), ms: TIMEOUT }; }
		if (r.print && !r.error) {
			// HTML routes: the browser's own print engine is the PDF step (best case for that route).
			const tp = Date.now();
			const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, format: 'Letter' });
			r.ms += Date.now() - tp;
			r.pdf = Buffer.from(pdf).toString('base64');
		}
		if (r.pdf) {
			const buf = Buffer.from(r.pdf, 'base64');
			writeFileSync(join(out, `${name}.pdf`), buf);
			appendFileSync(res, `${name}\tok\t${Math.round(r.ms)}\t${buf.length}\t\n`);
		} else {
			appendFileSync(res, `${name}\tfail\t${Math.round(r.ms)}\t0\t${(r.error || '').replace(/\s+/g, ' ').slice(0, 200)}\n`);
			// A hung or crashed engine: start a fresh page (the app would replace its worker the same way).
			if (/timeout|crash|Target|closed|abort|memory/i.test(r.error || '')) {
				reloads++;
				hangs.push({ name, error: r.error, lastConsole: consoleLog.slice(-12), rssMb: treeRssMb(rootPid) });
				const again = await openPage();
				if (again.loadErr) { console.log(`engine did not come back: ${again.loadErr}`); break; }
			}
		}
		process.stdout.write(`${name} ${r.pdf ? 'ok' : 'FAIL ' + (r.error || '').slice(0, 80)} ${Math.round(r.ms)}ms\n`);
	}
}
load.reloads = reloads;
load.hangs = hangs;
load.loadAttempts = loadAttempts;
clearInterval(sampler);
load.peakMb = peak;
load.aborted = aborted;
load.console = consoleLog.slice(-60);
writeFileSync(join(out, 'load.json'), JSON.stringify(load, null, 1));
await browser.close();
console.log(`peak ${peak} MB, aborted ${aborted.length}`);
