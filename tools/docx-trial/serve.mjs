// Static server for the trial pages, with the headers a cross-origin-isolated page needs
// (COOP same-origin, COEP require-corp) and the app's CSP shape. Every response's size is logged
// to OUT/served.log so the harness can total what a cold load transferred.
//
// Routes:  /web/*   -> tools/docx-trial/web (the trial pages, from the repo)
//          /v/*     -> $TRIAL/vendor (engines, chunks, npm packages)
//          /docs/*  -> $TRIAL/gen and $TRIAL/raw (test documents; /docs/gen/..., /docs/raw/...)
// Usage: node serve.mjs [PORT=4393]
import { createReadStream, existsSync, statSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 4393);
const TRIAL = process.env.TRIAL || '/home/garrett/pdf-survey/docx-trial';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const LOG = join(TRIAL, 'out', 'served.log');
const roots = {
	web: join(HERE, 'web'),
	v: join(TRIAL, 'vendor'),
	docs: TRIAL,
};
const types = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
	'.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css',
	'.docx': 'application/octet-stream', '.pdf': 'application/pdf', '.ttf': 'font/ttf',
};
// The app's policy has no 'unsafe-eval'; EVAL=1 adds it, to find out whether an engine needs it.
const CSP = `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${process.env.EVAL ? " 'unsafe-eval'" : ''}; worker-src 'self' blob:; ` +
	"style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob: data:; frame-src 'self' blob:";

createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	const [, top, ...rest] = url.pathname.split('/');
	const root = roots[top];
	let file = root && normalize(join(root, decodeURIComponent(rest.join('/'))));
	if (top === 'docs') {
		const sub = rest[0];
		file = (sub === 'gen' || sub === 'raw') ? normalize(join(TRIAL, decodeURIComponent(rest.join('/')))) : null;
	}
	if (!file || !file.startsWith(top === 'docs' ? TRIAL : root) || !existsSync(file) || statSync(file).isDirectory()) {
		res.writeHead(404);
		res.end();
		return;
	}
	const size = statSync(file).size;
	res.writeHead(200, {
		'Content-Type': types[extname(file)] || 'application/octet-stream',
		'Content-Length': size,
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Cross-Origin-Embedder-Policy': process.env.NO_COEP ? 'unsafe-none' : 'require-corp',
		'Cross-Origin-Resource-Policy': 'same-origin',
		'Content-Security-Policy': CSP,
		'Cache-Control': 'no-store',
	});
	appendFileSync(LOG, `${Date.now()}\t${size}\t${url.pathname}\n`);
	createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`serving on http://127.0.0.1:${PORT}`));
