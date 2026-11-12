// Runs in the page: tesseract.js loaded from our own origin, workers from our origin, core
// and language data from our origin. `window.bench(opts)` OCRs a list of image URLs with a
// pool of `workers` and reports load time, per-image time and the words.
import Tesseract from '/t/tesseract.esm.min.js';

window.bench = async ({ model, images, workers = 1, th = '0', core = '/core/', deskew = true }) => {
	const t0 = performance.now();
	let first = null;
	const ws = await Promise.all(
		Array.from({ length: workers }, () =>
			Tesseract.createWorker('eng', 1, {
				workerPath: '/t/worker.min.js',
				corePath: core,
				langPath: `/lang/${model}`,
				gzip: false,
				cacheMethod: 'none',
				workerBlobURL: false
			})
		)
	);
	for (const w of ws) await w.setParameters({ tessedit_pageseg_mode: '3' });
	const load = performance.now() - t0;
	const results = new Array(images.length);
	let next = 0;
	await Promise.all(
		ws.map(async (w) => {
			while (next < images.length) {
				const i = next++;
				const ts = performance.now();
				const r = await w.recognize(images[i].url, { user_defined_dpi: String(images[i].dpi), thresholding_method: th, rotateAuto: deskew }, { blocks: true, text: false });
				const words = [];
				for (const b of r.data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const x of l.words) words.push([x.text, x.bbox.x0, x.bbox.y0, x.bbox.x1, x.bbox.y1, Math.round(x.confidence * 10) / 10]);
				const end = performance.now();
				if (first === null) first = end - t0;
				results[i] = { ms: end - ts, words };
			}
		})
	);
	const total = performance.now() - t0;
	await Promise.all(ws.map((w) => w.terminate()));
	return { load, first, total, results };
};
document.getElementById('status').textContent = 'loaded';
