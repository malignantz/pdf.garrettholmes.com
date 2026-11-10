// Post-build: put the Content-Security-Policy into build/_headers.
//
// SvelteKit (kit.csp, hash mode) writes the policy into every prerendered page
// as <meta http-equiv="content-security-policy">, with a sha256 hash for its
// inline bootstrap script. This script:
//   1. reads that policy from every built HTML file,
//   2. recomputes the hash of every inline <script> and checks the policy allows it,
//   3. merges the per-page script hashes into one policy, adds the header-only
//      directives (frame-ancestors), and writes it in place of __CSP__ in build/_headers.
// It exits non-zero if anything disagrees, so a build can never ship a header
// that blocks its own pages.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../build/', import.meta.url));
const headerOnly = { 'frame-ancestors': ["'none'"] };

function htmlFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === '_app' ? [] : htmlFiles(p);
		return e.name.endsWith('.html') ? [p] : [];
	});
}

function parsePolicy(text) {
	const map = new Map();
	for (const part of text.split(';')) {
		const [name, ...values] = part.trim().split(/\s+/);
		if (name) map.set(name, values);
	}
	return map;
}

const fail = (msg) => {
	console.error(`csp-headers: ${msg}`);
	process.exit(1);
};

const files = htmlFiles(build);
if (files.length === 0) fail('no HTML files in build/');

let merged;
for (const file of files) {
	const html = readFileSync(file, 'utf8');
	const meta = html.match(/<meta http-equiv="content-security-policy" content="([^"]+)">/i);
	if (!meta) fail(`${file} has no CSP <meta>; is kit.csp configured?`);
	const policy = parsePolicy(meta[1].replaceAll('&#39;', "'"));

	// Independently hash each inline script and make sure the page's policy allows it.
	const allowed = new Set(policy.get('script-src') ?? []);
	for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
		if (/\ssrc=/.test(attrs)) continue;
		const hash = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
		if (!allowed.has(hash)) fail(`${file}: inline script hash ${hash} is not in its CSP`);
	}

	if (!merged) {
		merged = policy;
		continue;
	}
	// Directives must match across pages, apart from script hashes.
	for (const [name, values] of policy) {
		const have = merged.get(name);
		if (!have) fail(`${file}: directive ${name} missing on other pages`);
		const union = [...new Set([...have, ...values])];
		const nonHash = (v) => v.filter((x) => !x.startsWith("'sha256-"));
		if (nonHash(union).length !== nonHash(have).length) fail(`${file}: ${name} differs between pages`);
		merged.set(name, union);
	}
}

for (const [name, values] of Object.entries(headerOnly)) merged.set(name, values);
const csp = [...merged].map(([name, values]) => [name, ...values].join(' ')).join('; ');

const headersPath = join(build, '_headers');
const headers = readFileSync(headersPath, 'utf8');
const slot = 'Content-Security-Policy: __CSP__';
if (!headers.includes(slot)) fail('build/_headers has no "Content-Security-Policy: __CSP__" line');
if (csp.length > 2000) fail(`policy is ${csp.length} characters; Cloudflare allows 2000 per header`);
writeFileSync(headersPath, headers.replace(slot, `Content-Security-Policy: ${csp}`));

console.log(`csp-headers: ${files.length} pages, policy written to build/_headers`);
console.log(`  ${csp}`);
