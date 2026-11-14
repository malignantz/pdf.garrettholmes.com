// Classic script, usable in a page or a worker (importScripts). Replaces fetch() for the two big
// LibreOffice files: instead of soffice.wasm / soffice.data it fetches the gzip pieces listed in
// CHUNK_BASE/<name>.json (each under 25 MiB, Cloudflare's per-asset limit), joins them and inflates
// them with DecompressionStream. Everything else goes to the real fetch. Records bytes fetched.
(function () {
	const g = self;
	const realFetch = g.fetch.bind(g);
	g.__trial = g.__trial || { fetched: 0, pieces: [] };
	g.installChunkedFetch = function (chunkBase) {
		g.fetch = async function (input, init) {
			const url = typeof input === 'string' ? input : input.url;
			const m = /(soffice\.(?:wasm|data))(?:\?.*)?$/.exec(url);
			if (!m) return realFetch(input, init);
			const name = m[1];
			const man = await (await realFetch(`${chunkBase}/${name}.json`)).json();
			let i = 0;
			let reader = null;
			const joined = new ReadableStream({
				async pull(ctl) {
					for (;;) {
						if (!reader) {
							if (i >= man.parts.length) { ctl.close(); return; }
							const r = await realFetch(`${chunkBase}/${man.parts[i++]}`);
							if (!r.ok) { ctl.error(new Error(`piece ${i} ${r.status}`)); return; }
							reader = r.body.getReader();
						}
						const { done, value } = await reader.read();
						if (done) { reader = null; continue; }
						g.__trial.fetched += value.length;
						ctl.enqueue(value);
						return;
					}
				},
			});
			const body = joined.pipeThrough(new DecompressionStream('gzip'));
			const type = name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
			return new Response(body, { headers: { 'Content-Type': type, 'Content-Length': String(man.raw) } });
		};
	};
})();
