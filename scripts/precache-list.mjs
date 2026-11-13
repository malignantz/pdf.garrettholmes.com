// Post-build: list the files under build/_app/immutable the service worker must
// cache on install (build/_app/precache.json) and the ones it must NOT, because
// they are large and only some exports need them (build/_app/lazy.json).
//
// SvelteKit's service-worker manifest lists the app's own chunks, but not the
// chunks and assets that Vite emits for Web Workers (the PDF engine's code, the
// qpdf wasm, the PDF.js worker, the stamp font). Without them the app loads
// offline but cannot open a file. The service worker reads precache.json on
// install and caches everything in it.
//
// Lazy files (MuPDF: ~10 MB of wasm plus its JS chunk; OCR for "Make scanned pages
// searchable": tesseract.js's worker script, its cores and the language data, about
// 9 MB as served) are fetched on first use and then kept in the service worker's lazy
// cache, so they work offline after that; lazy.json lets the service worker prune old
// versions of them.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../build/', import.meta.url));
const root = join(build, '_app/immutable');

function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

/** OCR files, by the names Vite gives them (src/lib/engine/ocr/browser.ts). */
const OCR_ASSET = /^(worker\.min|tesseract-core(-[a-z]+)*\.wasm)-[\w-]+\.js$|^(eng|osd)\.traineddata-[\w-]+\.gz$/;

/** MuPDF's wasm (named after the package file) and the JS chunk that loads it; the OCR files and their loader. */
function isLazy(path) {
	const name = path.split(/[/\\]/).pop();
	if (/^mupdf-wasm[-.].*\.wasm$/.test(name)) return true;
	if (OCR_ASSET.test(name)) return true;
	if (name.endsWith('.js')) {
		const text = readFileSync(path, 'utf8');
		return text.includes('mupdf-wasm') || text.includes('.traineddata-');
	}
	return false;
}

const all = walk(root);
const url = (p) => `/${relative(build, p).split('\\').join('/')}`;
const precache = all.filter((p) => !isLazy(p)).map(url).sort();
const lazy = all.filter(isLazy).map(url).sort();
if (!lazy.some((p) => p.endsWith('.wasm'))) {
	console.error('precache-list: the MuPDF wasm was not found in the build; check isLazy()');
	process.exit(1);
}
if (!lazy.some((p) => /eng\.traineddata-/.test(p)) || !lazy.some((p) => /tesseract-core-relaxedsimd-lstm\.wasm-/.test(p))) {
	console.error('precache-list: the OCR files were not found in the build; check OCR_ASSET');
	process.exit(1);
}
writeFileSync(join(build, '_app/precache.json'), JSON.stringify(precache));
writeFileSync(join(build, '_app/lazy.json'), JSON.stringify(lazy));
console.log(`precache-list: ${precache.length} immutable files precached, ${lazy.length} lazy:`);
for (const p of lazy) console.log(`  ${p} (${Math.round(statSync(join(build, p)).size / 1024)} KB)`);
