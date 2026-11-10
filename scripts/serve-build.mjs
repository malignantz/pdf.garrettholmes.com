// Serve build/ the way Cloudflare Pages does, including build/_headers, so the
// e2e tests run the real site under its real Content-Security-Policy.
//   node scripts/serve-build.mjs [port]     (default 4173, or $PORT)
// - /privacy serves privacy.html, / serves index.html
// - unknown paths get 404.html with status 404
// - every _headers rule whose pattern matches is applied (later rules add to earlier ones)
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../build/', import.meta.url));
const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);

const types = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.webmanifest': 'application/manifest+json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.wasm': 'application/wasm',
	'.txt': 'text/plain; charset=utf-8',
	'.woff2': 'font/woff2',
	'.map': 'application/json'
};

/** Parse Cloudflare's _headers format into [{ pattern: RegExp, headers: [name, value][] }]. */
function loadRules() {
	const file = join(root, '_headers');
	if (!existsSync(file)) return [];
	const rules = [];
	for (const raw of readFileSync(file, 'utf8').split('\n')) {
		if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
		if (!/^\s/.test(raw)) {
			const glob = raw.trim();
			const re = glob
				.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
				.replace(/\*/g, '.*')
				.replace(/:[A-Za-z]\w*/g, '[^/]+');
			rules.push({ pattern: new RegExp(`^${re}$`), headers: [] });
		} else {
			const i = raw.indexOf(':');
			rules.at(-1)?.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
		}
	}
	return rules;
}

const rules = loadRules();
if (rules.some((r) => r.headers.some(([, v]) => v.includes('__CSP__')))) {
	console.error('serve-build: build/_headers still has __CSP__; run scripts/csp-headers.mjs after vite build');
	process.exit(1);
}

function resolve(pathname) {
	const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
	const candidates = [clean, `${clean}.html`, join(clean, 'index.html')];
	for (const c of candidates) {
		const p = join(root, c);
		if (p.startsWith(root) && existsSync(p) && statSync(p).isFile()) return p;
	}
	return null;
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost');
	if (url.pathname === '/_headers') {
		res.writeHead(404).end();
		return;
	}
	let file = resolve(url.pathname);
	let status = 200;
	if (!file) {
		file = join(root, '404.html');
		status = 404;
	}

	const headers = { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' };
	for (const rule of rules) {
		if (!rule.pattern.test(url.pathname)) continue;
		for (const [k, v] of rule.headers) headers[k] = v;
	}
	if (!headers['Cache-Control']) headers['Cache-Control'] = 'no-cache';

	res.writeHead(status, headers);
	if (req.method === 'HEAD') res.end();
	else res.end(readFileSync(file));
});

server.listen(port, '127.0.0.1', () => {
	console.log(`serve-build: http://127.0.0.1:${port} (${rules.length} header rules)`);
});
