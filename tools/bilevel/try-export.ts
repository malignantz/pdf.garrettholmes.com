/** Ad-hoc: export a PDF with "Make scanned pages black and white" on (real engine). node … try-export.ts IN.pdf [password] */
import fs from 'node:fs';
import { engine } from '../survey/lib/engine';

const [inp, password] = process.argv.slice(2);
const e = engine();
const src = await e.openPdf(new Uint8Array(fs.readFileSync(inp)), 'in.pdf');
const pages = src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0 as const, stamps: [] }));
console.log('bilevelPages', await e.bilevelPages(src));
const prev = await e.bilevelPreview(src, 0);
console.log('preview', prev && { w: prev.width, h: prev.height, before: prev.before.length, after: prev.after.length });
const t = performance.now();
const r = await e.exportPlan({ pages, options: { filename: 'x.pdf', compress: true, stripMetadata: false, printCap: true, bilevel: true, password } }, [src], []);
console.log(Math.round(performance.now() - t), 'ms', src.bytes.length, '→', r.bytes.length, r.bilevel);
for (const c of r.checks) console.log(c.ok ? 'ok ' : 'BAD', c.name, c.detail.slice(0, 220));
