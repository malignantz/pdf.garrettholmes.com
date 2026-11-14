/**
 * Time of the black/white core (engine/bilevel.ts: analyse, binarize, vanished, encodeG4)
 * in system Chrome through Playwright, on one picture of a hard case (hard.ts output, a
 * synthetic scan: nothing from the survey or the owner). The module is loaded as plain
 * JavaScript (types stripped by Node) into a blank page; the samples come from a local
 * route. Runs at full speed, then with DevTools CPU throttling ×4 (it slows the page's main
 * thread, where this runs) as a rough phone estimate.
 *
 *   node … tools/bilevel/browser.ts [--case clean] [--reps 3] [--out DIR]
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { chromium } from '@playwright/test';
import { mupdf } from '../../src/lib/engine/mupdf';
import { findCandidates } from '../../src/lib/engine/shrink';
import { parseArgs, repoRoot } from '../survey/lib/common';

const args = parseArgs(process.argv.slice(2));
const out = path.resolve(args.get('out') ?? '/home/garrett/pdf-survey/out-bilevel');
const name = args.get('case') ?? 'clean';
const reps = args.num('reps', 3);

const m = await mupdf();
const doc = new m.PDFDocument(new Uint8Array(fs.readFileSync(path.join(out, 'hard', `${name}.pdf`))));
const c = findCandidates(doc)[0];
const samples = doc.newIndirect(c.num).readStream().asUint8Array().slice();
const ppi = Math.min(c.width / c.inW, c.height / c.inH);
doc.destroy();

const src = stripTypeScriptTypes(fs.readFileSync(path.join(repoRoot, 'src/lib/engine/bilevel.ts'), 'utf8')).replace(/^export /gm, '');
const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true });
const page = await browser.newPage();
await page.route('http://bench.local/**', (route) =>
	route.request().url().endsWith('/samples.bin')
		? route.fulfill({ status: 200, body: Buffer.from(samples), contentType: 'application/octet-stream' })
		: route.fulfill({ status: 200, body: '<!doctype html><title>bench</title>', contentType: 'text/html' })
);
await page.goto('http://bench.local/');
await page.addScriptTag({ content: `${src}\nwindow.BL = { analyse, binarize, vanished, encodeG4 };` });
const cdp = await page.context().newCDPSession(page);
const results: Record<string, unknown> = { case: name, width: c.width, height: c.height, n: c.n, ppi: Math.round(ppi), chrome: browser.version() };
for (const rate of [1, 4]) {
	await cdp.send('Emulation.setCPUThrottlingRate', { rate });
	const r = await page.evaluate(
		async ({ w, h, n, ppi, reps }) => {
			const samples = new Uint8Array(await (await fetch('/samples.bin')).arrayBuffer());
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const BL = (window as any).BL;
			const t: Record<string, number[]> = { analyse: [], binarize: [], vanished: [], encodeG4: [], total: [] };
			let size = 0;
			for (let i = 0; i < reps; i++) {
				let s = performance.now();
				const t0 = s;
				const a = BL.analyse(samples, w, h, n, ppi);
				t.analyse.push(performance.now() - s);
				s = performance.now();
				const bits = BL.binarize(a.grey, w, h, a.threshold);
				t.binarize.push(performance.now() - s);
				s = performance.now();
				BL.vanished(a.grey, bits, w, h, ppi, a.paper, a.ink);
				t.vanished.push(performance.now() - s);
				s = performance.now();
				size = BL.encodeG4(bits, w, h).length;
				t.encodeG4.push(performance.now() - s);
				t.total.push(performance.now() - t0);
			}
			const med = (xs: number[]) => Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);
			return { ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, med(v)])), g4: size };
		},
		{ w: c.width, h: c.height, n: c.n, ppi, reps }
	);
	results[`throttle${rate}`] = r;
}
await browser.close();
fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
