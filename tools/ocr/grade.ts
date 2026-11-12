/**
 * Sheets for grading OCR on real scans by eye (part c), drawn by Chrome from the page renders
 * (which stay in the survey folder, as do the sheets).
 *
 *   npm run ocr:grade -- contact          # thumbnails of every (c) page, 12 per sheet → <out>/grade/contact-N.png
 *   npm run ocr:grade -- sheets --pages L # per page: 30 random OCR words (crop + what OCR read) and 3 random
 *                                         # text-line strips with OCR's words under them → <out>/grade/<page>.png
 *   npm run ocr:grade -- report           # scores from <out>/grade/grades.json (written by hand)
 *
 * grades.json: { "<sha16>-p<N>": { "kind": "...", "wrong": [word indices OCR got wrong], "unsure": [...],
 *   "strips": [[true words in strip, of them read exactly], ...], "note": "..." } }
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { parseArgs, readJsonl } from '../survey/lib/common';
import { rng } from './lib/degrade';
import { norm, signals } from './lib/score';
import type { ScanResult } from './scan-worker';
import { accept, type Gate } from './report';

const args = parseArgs(process.argv.slice(3));
const step = process.argv[2];
const out = path.resolve(args.get('out') ?? '/home/garrett/pdf-survey/out-ocr');
const pngDir = path.join(out, 'png', 'c');
const gdir = path.join(out, 'grade');
fs.mkdirSync(gdir, { recursive: true });
const results = readJsonl<ScanResult>(path.join(out, 'results', 'scan-c.jsonl'));
const pages = results.flatMap((r) => (r.ocr ?? []).map((p) => ({ r, p, key: `${r.sha256.slice(0, 16)}-p${p.i + 1}` })));

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const dataUrl = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;

async function shoot(html: string, file: string, width = 1400) {
	const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true });
	const page = await browser.newPage({ viewport: { width, height: 800 } });
	await page.route('**/*', (r) => (r.request().url().startsWith('data:') ? r.continue() : r.abort()));
	await page.setContent(html);
	await page.screenshot({ path: file, fullPage: true });
	await browser.close();
}

if (step === 'contact') {
	for (let s = 0; s * 12 < pages.length; s++) {
		const cells = pages
			.slice(s * 12, s * 12 + 12)
			.map(({ p, key, r }, j) => `<div style="display:inline-block;width:330px;margin:4px;vertical-align:top;font:12px sans-serif"><b>${s * 12 + j}</b> ${key} ${r.source} ${p.inv.ppi}ppi ${p.inv.bits}bit rot${p.inv.rotate} ocrw=${p.runs[0]?.words.length} conf=${Math.round(p.runs[0]?.conf ?? 0)}<br><img src="${dataUrl(path.join(pngDir, p.png!))}" style="max-width:330px;max-height:430px;border:1px solid #888"></div>`)
			.join('');
		await shoot(`<body style="margin:0">${cells}</body>`, path.join(gdir, `contact-${s}.png`));
		console.log(`contact-${s}.png`);
	}
} else if (step === 'sheets') {
	const want = (args.get('pages') ?? '').split(',').filter(Boolean);
	for (const { p, key } of pages.filter((x) => want.includes(x.key))) {
		const run = p.runs[0];
		const r = rng(parseInt(key.slice(0, 8), 16));
		const words = run.words.map((w, i) => ({ w, i })).filter(({ w }) => norm(w[0]).length > 0);
		const pick = [...words].sort(() => r() - 0.5).slice(0, 30);
		const img = dataUrl(path.join(pngDir, p.png!));
		const crop = (x0: number, y0: number, x1: number, y1: number, maxW: number) => {
			const w = x1 - x0;
			const h = y1 - y0;
			const k = Math.min(2, maxW / w, 70 / h);
			return `<div class="pg" style="width:${w * k}px;height:${h * k}px;background-position:${-x0 * k}px ${-y0 * k}px;background-size:${run.iw * k}px ${run.ih * k}px;border:1px solid #bbb"></div>`;
		};
		const cells = pick
			.map(({ w }, n) => {
				const pad = (w[4] - w[2]) * 0.5;
				return `<div style="display:inline-block;margin:6px;vertical-align:top;font:16px monospace"><span style="color:#888">${n}</span> <span style="color:#c00;background:#fee">${esc(w[0])}</span> <span style="color:#888;font-size:11px">${Math.round(w[5])}</span>${crop(Math.max(0, w[1] - pad), Math.max(0, w[2] - pad), Math.min(run.iw, w[3] + pad), Math.min(run.ih, w[4] + pad), 420)}</div>`;
			})
			.join('');
		// Strips: three random text lines (by OCR word positions, so a line OCR missed entirely can't be chosen;
		// a fourth strip is a random band of the page whatever OCR saw).
		const lines = new Map<number, typeof words>();
		for (const x of words) {
			const yc = Math.round((x.w[2] + x.w[4]) / 2 / 20);
			lines.set(yc, [...(lines.get(yc) ?? []), x]);
		}
		const keys = [...lines.keys()].sort(() => r() - 0.5).slice(0, 3);
		const bands: [number, number][] = keys.map((k) => {
			const ws = lines.get(k)!;
			return [Math.min(...ws.map((x) => x.w[2])) - 8, Math.max(...ws.map((x) => x.w[4])) + 8];
		});
		const ry = r() * (run.ih - 120);
		bands.push([ry, ry + 90]);
		const strips = bands
			.map(([y0, y1], n) => {
				const inside = run.words.filter((w) => (w[2] + w[4]) / 2 >= y0 && (w[2] + w[4]) / 2 <= y1).sort((a, b) => a[1] - b[1]);
				return `<div style="margin:10px 0;font:15px monospace"><b>strip ${n}${n === 3 ? ' (random band)' : ''}</b>${crop(0, Math.max(0, y0), run.iw, Math.min(run.ih, y1), 1360)}<div style="color:#c00">${inside.map((w) => esc(w[0])).join(' ')}</div></div>`;
			})
			.join('');
		await shoot(`<style>.pg{background-image:url(${img});background-repeat:no-repeat}</style><body style="margin:8px"><h3 style="font:16px sans-serif">${key}: ${run.words.length} OCR words, mean conf ${Math.round(run.conf)}</h3>${cells}<hr>${strips}</body>`, path.join(gdir, `${key}.png`));
		console.log(`${key}.png`);
	}
} else if (step === 'report') {
	const grades = JSON.parse(fs.readFileSync(path.join(gdir, 'grades.json'), 'utf8')) as Record<string, { kind: string; group: string; wrong: number[]; unsure?: number[]; strips: [number, number][]; note?: string }>;
	const gate: Gate | null = args.get('gate') ? JSON.parse(args.get('gate')!) : null;
	const L = ['# Real scans without text: graded by eye', '', '| page | group | kind | OCR words | mean conf | gate | sampled words wrong | strip words read exactly | note |', '|---|---|---|---:|---:|---|---:|---:|---|'];
	const agg = new Map<string, { w: number; wrong: number; sT: number; sOk: number; bT: number; bOk: number; pages: number }>();
	const add = (k: string, w: number, wrong: number, sT: number, sOk: number, bT: number, bOk: number) => {
		const a = agg.get(k) ?? { w: 0, wrong: 0, sT: 0, sOk: 0, bT: 0, bOk: 0, pages: 0 };
		agg.set(k, { w: a.w + w, wrong: a.wrong + wrong, sT: a.sT + sT, sOk: a.sOk + sOk, bT: a.bT + bT, bOk: a.bOk + bOk, pages: a.pages + 1 });
	};
	for (const [key, g] of Object.entries(grades)) {
		const pg = pages.find((x) => x.key === key);
		if (!pg) continue;
		const run = pg.p.runs[0];
		const sig = signals(run.words);
		const acc = gate ? accept(gate, sig) : true;
		const n = Math.min(30, run.words.filter((w) => norm(w[0])).length);
		const sT = g.strips.reduce((a, s) => a + s[0], 0);
		const sOk = g.strips.reduce((a, s) => a + s[1], 0);
		L.push(`| ${key} | ${g.group} | ${g.kind} | ${run.words.length} | ${Math.round(sig.meanConf)} | ${acc ? 'accept' : 'decline'} | ${g.wrong.length} / ${n} | ${sOk} / ${sT} | ${g.note ?? ''} |`);
		const band = g.strips[3] ?? [0, 0];
		for (const k of ['all', g.group, ...(gate ? [acc ? 'accepted by the gate' : 'declined by the gate', `${acc ? 'accepted' : 'declined'}: ${g.group}`] : [])]) add(k, n, g.wrong.length, sT, sOk, band[0], band[1]);
	}
	L.push('', 'Strips: three lines chosen where OCR found words (so a line OCR missed entirely cannot be chosen: an upper bound) and one random band of the page (unbiased, fewer words).', '', '| group | pages | sampled OCR words wrong (junk) | words in all strips read exactly | words in the random band read exactly |', '|---|---:|---:|---:|---:|');
	const p = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}% of ${b}`;
	for (const [k, a] of [...agg].sort()) L.push(`| ${k} | ${a.pages} | ${p(a.wrong, a.w)} | ${p(a.sOk, a.sT)} | ${p(a.bOk, a.bT)} |`);
	fs.writeFileSync(path.join(out, 'report-graded.md'), L.join('\n') + '\n');
	console.log(L.join('\n'));
}
