/**
 * OCR text-layer prototype, step 3: pooled numbers and the per-page table from
 * /home/garrett/pdf-survey/out-ocr/layer/results.jsonl (check.ts) → table.md there.
 *
 *   node --experimental-transform-types --no-warnings --import ./tools/survey/register.mjs tools/ocr/layer/report.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/home/garrett/pdf-survey/out-ocr/layer';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const R: any[] = fs
	.readFileSync(path.join(OUT, 'results.jsonl'), 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((l) => JSON.parse(l));
const q = (xs: number[], p: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '–');
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
const EX = ['mupdf', 'pdfjs', 'pdftotext', 'pdftotextLayout'];

const lines: string[] = [];
// Pages that count for pooled numbers: everything but the deliberately sideways page.
const normal = R.filter((r) => !r.error && !String(r.kind).includes('sideways'));
for (const sp of ['gap-tz-0.2', 'gap-tz-0', 'none-tz-0.2', 'gap-tc-0.2', 'gap-tcmax-0.2', 'gap-mix-0.2']) {
	const words = normal.reduce((a, r) => a + r.ocrWords, 0);
	const offered = normal.reduce((a, r) => a + r[sp].hl.offered, 0);
	const miss = normal.reduce((a, r) => a + r[sp].hl.miss1pt, 0);
	const flood = normal.reduce((a, r) => a + r[sp].hl.flood, 0);
	const split = normal.reduce((a, r) => a + r[sp].hl.split, 0);
	const merged = normal.reduce((a, r) => a + r[sp].hl.merged, 0);
	const iou = normal.flatMap((r) => r[sp].hl.all.iou);
	const edge = normal.flatMap((r) => r[sp].hl.all.edge);
	const vEdge = normal.flatMap((r) => r[sp].hl.all.vEdge);
	const px = ['mupdf', 'pdfjs', 'poppler'].map((k) => `${k} ${normal.filter((r) => r[sp].px[k] === 0).length}/${normal.length}`);
	const tried = normal.reduce((a, r) => a + r[sp].search.tried, 0);
	const right = normal.reduce((a, r) => a + r[sp].search.rightPlace, 0);
	lines.push(`### variant ${sp} (${normal.length} pages, ${words} OCR words)`, '');
	lines.push(`- pixel-identical pages: ${px.join(', ')}`);
	for (const e of EX) {
		const ratios = normal.filter((r) => r.ocrWords).map((r) => r[sp].text[e].ratio);
		const glued = normal.reduce((a, r) => a + r[sp].text[e].glued, 0);
		const br = normal.filter((r) => r.ocrLines > 1).map((r) => r[sp].text[e].lineBreaks);
		const spc = normal.filter((r) => r.ocrWords).map((r) => r[sp].text[e].spacesKept);
		lines.push(`- text ${e}: word-sequence ratio median ${f2(q(ratios, 0.5))}, min ${f2(Math.min(...ratios))}; glued word pairs ${glued}; line breaks kept (median page) ${f2(q(br, 0.5))}, min ${f2(Math.min(...br))}; spaces kept min ${f2(Math.min(...spc))}`);
	}
	lines.push(
		`- highlighter: ${pct(offered, words)} of OCR words offered with the same text (${offered}/${words}); ink outside the box by >1 pt ${miss}; box floods another line's word ${pct(flood, offered)}; OCR word split ${split}, highlighter word over 2+ OCR words ${merged}`,
		`- highlighter box vs OCR ink box: IoU p10/p50/p90 ${f2(q(iou, 0.1))}/${f2(q(iou, 0.5))}/${f2(q(iou, 0.9))}; left/right edge error p50/p90/p99 ${f2(q(edge, 0.5))}/${f2(q(edge, 0.9))}/${f2(q(edge, 0.99))} pt; top/bottom p50/p90/p99 ${f2(q(vEdge, 0.5))}/${f2(q(vEdge, 0.9))}/${f2(q(vEdge, 0.99))} pt`,
		`- MuPDF search (unique words, 4+ letters, up to 40 a page): ${right}/${tried} hit at the OCR word`,
		''
	);
}
const g = normal.filter((r) => r.ocrWords > 0);
const grow = g.map((r) => r['gap-tz-0.2'].afterBytes - r.beforeBytes);
const growP = g.map((r) => r['gap-tz-0.2'].afterPacked - r.beforePacked);
const empty = normal.find((r) => r.ocrWords === 0);
const perWord = g.map((r) => (r['gap-tz-0.2'].afterPacked - r.beforePacked - (empty ? empty['gap-tz-0.2'].afterPacked - empty.beforePacked : 0)) / r.ocrWords);
lines.push(
	`### size (gap-tz-0.2)`,
	'',
	`- growth per page as pdf-lib writes it: median ${q(grow, 0.5)} B, max ${Math.max(...grow)} B; after qpdf object streams + compression: median ${q(growP, 0.5)} B, max ${Math.max(...growP)} B`,
	`- fixed part (font + q/Q streams, page with no OCR words): ${empty ? `${empty['gap-tz-0.2'].afterBytes - empty.beforeBytes} B raw, ${empty['gap-tz-0.2'].afterPacked - empty.beforePacked} B packed` : '–'}; per word after that (packed): median ${f2(q(perWord, 0.5))} B`,
	`- none-tz-0.2 instead of gap-tz-0.2 saves (packed) median ${q(
		g.map((r) => r['gap-tz-0.2'].afterPacked - r['none-tz-0.2'].afterPacked),
		0.5
	)} B a page`,
	''
);

const hdr = ['id', 'kind', 'source', 'file', 'page', 'words', 'lines', '>3°', 'non-ASCII', 'existing words (dup by OCR)', 'px diff mu/pj/pp', 'seq ratio mu/pj/pt/pt-layout', 'offered', 'flood', 'IoU p50', 'edge p50/p90 pt', 'search', 'growth raw/packed B'];
lines.push('### per page (gap-tz-0.2)', '', `| ${hdr.join(' | ')} |`, `|${hdr.map(() => '---').join('|')}|`);
for (const r of R) {
	if (r.error) {
		lines.push(`| ${r.id} | error: ${r.error.slice(0, 80)} |`);
		continue;
	}
	const x = r['gap-tz-0.2'];
	lines.push(
		`| ${[
			r.id,
			r.kind,
			r.source,
			r.file.slice(0, 22),
			r.page + 1,
			r.ocrWords,
			r.ocrLines,
			r.linesOver3deg,
			`${r.nonAscii} ${r.nonAsciiChars ?? ''}`.trim(),
			`${r.existingWords} (${r.dupOfExisting})`,
			[x.px.mupdf, x.px.pdfjs, x.px.poppler].join('/'),
			EX.map((e) => f2(x.text[e].ratio)).join('/'),
			`${x.hl.offered}/${r.ocrWords}`,
			x.hl.flood,
			f2(x.hl.iouP50),
			`${f2(x.hl.edgeP50)}/${f2(x.hl.edgeP90)}`,
			`${x.search.rightPlace}/${x.search.tried}`,
			`${x.afterBytes - r.beforeBytes}/${x.afterPacked - r.beforePacked}`
		].join(' | ')} |`
	);
}
fs.writeFileSync(path.join(OUT, 'table.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
