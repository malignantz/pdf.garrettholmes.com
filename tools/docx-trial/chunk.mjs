// Compress a big engine file once (gzip -9) and split the compressed bytes into pieces that fit
// Cloudflare's 25 MiB per-asset limit. The browser fetches the pieces in order, joins them into
// one stream and inflates it with DecompressionStream('gzip') (see web/chunked-fetch.js).
// Also reports the brotli size (quality BROTLI_Q, default 9; 16 MiB window) for comparison;
// quality 11 takes over 15 minutes on the 147 MB wasm. NO_BROTLI=1 skips it.
//
// Usage: node chunk.mjs SRC_FILE OUT_DIR [PIECE_MIB=24]
import { createReadStream, createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';

const [src, out, pieceMib = '24'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const name = basename(src);
const gzPath = join(out, `${name}.gz`);
await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(gzPath));
const gz = readFileSync(gzPath);
const piece = Number(pieceMib) * 1024 * 1024;
const parts = [];
for (let off = 0, i = 0; off < gz.length; off += piece, i++) {
	const p = `${name}.gz.${String(i).padStart(2, '0')}`;
	writeFileSync(join(out, p), gz.subarray(off, off + piece));
	parts.push(p);
}
let br = 0;
if (!process.env.NO_BROTLI) {
	const counter = new (await import('node:stream')).Writable({
		write(c, _e, cb) { br += c.length; cb(); },
	});
	await pipeline(createReadStream(src), createBrotliCompress({
		params: { [constants.BROTLI_PARAM_QUALITY]: Number(process.env.BROTLI_Q || 9), [constants.BROTLI_PARAM_LGWIN]: 24 },
	}), counter);
}
const manifest = { name, raw: statSync(src).size, gzip: gz.length, brotli: br || null, parts };
writeFileSync(join(out, `${name}.json`), JSON.stringify(manifest, null, 1));
console.log(JSON.stringify(manifest));
