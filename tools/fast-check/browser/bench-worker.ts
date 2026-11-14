/// <reference lib="webworker" />
/**
 * The engine as the app's worker builds it (src/lib/engine/worker.ts), twice: with the fast
 * final check and with `fullCheck`. Messages: { file: ArrayBuffer, job } → { result }.
 * Jobs: 'export' (open + plain export with each engine, order given), 'raw' (qpdf check of
 * the bytes as given, full and fast, plus a fresh instance and the copy into the wasm FS).
 */
import qpdfWasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';
import pdfjsWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import fontUrl from '../../../src/lib/engine/fonts/NotoSans-Regular.ttf?url';
import { createCoreEngine, type EngineAssets } from '../../../src/lib/engine/core';
import { FAST_CHECK_PRELUDE, checkIsClean } from '../../../src/lib/engine/final-check';
import { Qpdf } from '../../../src/lib/engine/qpdf';
import type { Engine, ExportOptions } from '../../../src/lib/core/types';

async function fetchBytes(url: string): Promise<Uint8Array> {
	return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

const assets: EngineAssets = {
	qpdf: { location: qpdfWasmUrl, compile: () => WebAssembly.compileStreaming(fetch(qpdfWasmUrl)) },
	font: () => fetchBytes(fontUrl),
	pdfjs: async () => {
		const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
		lib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
		return lib;
	}
};
const notes: string[] = [];
const engines: Record<'fast' | 'full', Engine> = {
	fast: createCoreEngine(assets, { debug: (n) => notes.push(n) }),
	full: createCoreEngine(assets, { debug: (n) => notes.push(n), fullCheck: true })
};
const qpdf = new Qpdf(assets.qpdf);

interface Job {
	kind: 'export' | 'raw';
	order?: ('fast' | 'full')[];
	options?: Partial<ExportOptions>;
}

const ms = (t: number) => Math.round(performance.now() - t);

self.onmessage = async (ev: MessageEvent<{ file: ArrayBuffer; job: Job }>) => {
	const bytes = new Uint8Array(ev.data.file);
	const job = ev.data.job;
	try {
		if (job.kind === 'raw') {
			const r: Record<string, unknown> = {};
			let t = performance.now();
			await qpdf.run({ args: ['--version'] });
			r.instanceMs = ms(t);
			t = performance.now();
			await qpdf.run({ args: ['--version'], inputs: { '/v.pdf': bytes } });
			r.copyInMs = Math.max(0, ms(t) - (r.instanceMs as number));
			const args = ['--check', '--show-npages', '/v.pdf'];
			t = performance.now();
			const a = await qpdf.run({ args, inputs: { '/v.pdf': bytes } });
			r.fullMs = ms(t);
			t = performance.now();
			const b = await qpdf.run({ args, inputs: { '/v.pdf': bytes }, prelude: FAST_CHECK_PRELUDE });
			r.fastMs = ms(t);
			r.same = b.prelude === 0 && a.code === b.code && a.stdout === b.stdout && a.stderr === b.stderr;
			r.clean = checkIsClean(a);
			self.postMessage({ result: r });
			return;
		}
		const src = await engines.fast.openPdf(bytes, 'in.pdf');
		const out: Record<string, unknown> = {};
		for (const which of job.order ?? ['fast', 'full']) {
			notes.length = 0;
			const t = performance.now();
			const res = await engines[which].exportPlan(
				{ pages: src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0, stamps: [] })), options: { filename: 'out.pdf', compress: false, stripMetadata: false, ...job.options } },
				[src],
				[]
			);
			out[which] = { ms: ms(t), check: notes.filter((n) => n.startsWith('final-check')).join('; '), ok: res.checks.every((c) => c.ok), bytes: res.bytes.length };
		}
		self.postMessage({ result: out });
	} catch (e) {
		self.postMessage({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
	}
};
