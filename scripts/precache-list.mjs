// Post-build: list every file under build/_app/immutable in build/_app/precache.json.
//
// SvelteKit's service-worker manifest lists the app's own chunks, but not the
// chunks and assets that Vite emits for Web Workers (the PDF engine's code, the
// qpdf wasm, the PDF.js worker, the stamp font). Without them the app loads
// offline but cannot open a file. The service worker reads this list on install
// and caches everything in it.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
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

const files = walk(root)
	.map((p) => `/${relative(build, p).split('\\').join('/')}`)
	.sort();
writeFileSync(join(build, '_app/precache.json'), JSON.stringify(files));
console.log(`precache-list: ${files.length} immutable files`);
