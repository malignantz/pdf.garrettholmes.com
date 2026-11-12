/**
 * OCR text-layer prototype, step 1: pick scanned pages from the survey pile.
 * Survey files are untrusted: read only; output (paths, page numbers) goes to
 * /home/garrett/pdf-survey/out-ocr/layer/pages.json, never into the repo.
 *
 *   node --experimental-transform-types --no-warnings --import ./tools/survey/register.mjs tools/ocr/layer/select.ts
 *
 * Kinds: "scan" (no text, one picture over most of the page), "inset" (no text, the
 * picture covers well under the page or is offset), "partial" (a few words of real text
 * plus a page-sized picture). Up to 2 pages per file, mid-document for books.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as mupdf from 'mupdf';
import { pageInfo, renderGray } from '../lib/truth';

const PILE = '/home/garrett/pdf-survey';
const OUT = path.join(PILE, 'out-ocr/layer');
const local = new Set(fs.readFileSync(path.join(PILE, 'local-files.txt'), 'utf8').split('\n').map((s) => s.trim()));

interface Profile {
	path: string;
	source: string;
	status: string;
	pages: number;
	encryption: string;
	size: number;
	content?: { imageOnlyPages: number; textOverImagePages: number };
}
const profiles = fs
	.readFileSync(path.join(PILE, 'out-baseline-2026-11-10/profiles.jsonl'), 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((l) => JSON.parse(l) as Profile)
	.filter((p) => p.status === 'ok' && !local.has(p.path) && ['archive-org-scans', 'govdocs1'].includes(p.source) && p.encryption === 'none' && p.size < 60e6);

export interface Pick {
	path: string;
	source: string;
	page: number;
	kind: 'scan' | 'inset' | 'partial';
	W: number;
	H: number;
	rotate: number;
	cover: number;
	imgBox: number[];
	words: number;
}

const picks: Pick[] = [];
const want = { scan: 15, inset: 3, partial: 3 };
const have = { scan: 0, inset: 0, partial: 0 };
// Interleave the two sources so both are represented.
const bySrc = ['archive-org-scans', 'govdocs1'].map((s) => profiles.filter((p) => p.source === s && ((p.content?.imageOnlyPages ?? 0) > 0 || (p.content?.textOverImagePages ?? 0) > 0)));
const order: Profile[] = [];
for (let i = 0; i < Math.max(...bySrc.map((b) => b.length)); i++) for (const b of bySrc) if (b[i]) order.push(b[i]);

for (const p of order) {
	if (Object.entries(want).every(([k, v]) => have[k as keyof typeof have] >= v)) break;
	let doc: mupdf.Document;
	try {
		doc = mupdf.Document.openDocument(new Uint8Array(fs.readFileSync(p.path)), 'application/pdf');
	} catch {
		continue;
	}
	const n = doc.countPages();
	const cands = p.source === 'archive-org-scans' ? [Math.floor(n * 0.4), Math.floor(n * 0.6), Math.floor(n * 0.25)] : [0, 1, 2, 3];
	let took = 0;
	for (const i of [...new Set(cands)].filter((i) => i < n)) {
		if (took >= (p.source === 'govdocs1' ? 2 : 1)) break;
		let info;
		try {
			info = pageInfo(mupdf, doc, i);
		} catch {
			continue;
		}
		const big = [...info.images].sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))[0];
		if (!big || big.ppi < 150) continue;
		const vis = info.words.filter((w) => w.vis).length;
		const offset = big.box[0] > 5 || big.box[1] > 5;
		let kind: Pick['kind'] | null = null;
		if (info.words.length === 0 && info.imageCover > 0.85 && !offset && info.images.length <= 3) kind = 'scan';
		else if (info.words.length === 0 && info.imageCover > 0.2 && (info.imageCover < 0.85 || offset)) kind = 'inset';
		else if (vis > 0 && vis <= 60 && info.imageCover > 0.7 && info.words.every((w) => !w.invisible)) kind = 'partial';
		if (!kind || have[kind] >= want[kind]) continue;
		// Blank or nearly blank pages (book end-papers) have nothing to OCR.
		const g = renderGray(mupdf, doc, i, 40);
		let dark = 0;
		for (const v of g.px) if (v < 110) dark++;
		if (dark / g.px.length < 0.01) continue;
		have[kind]++;
		took++;
		picks.push({ path: p.path, source: p.source, page: i, kind, W: info.W, H: info.H, rotate: info.rotate, cover: Math.round(info.imageCover * 100) / 100, imgBox: big.box.map((v) => Math.round(v)), words: vis });
		console.log(kind, p.source, path.basename(p.path).slice(0, 40), i, info.imageCover.toFixed(2), vis);
	}
	doc.destroy();
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'pages.json'), JSON.stringify(picks, null, 1));
console.log(have);
