/**
 * Child process for `tools/unlock/measure.ts`: one survey file per job.
 *
 * Reads what protection the file has (qpdf --show-encryption, and the /Filter name next
 * to the offset qpdf reports when it declines), opens it with the real engine without a
 * password, and (mode 'export') runs the app's default export (Optimize and the
 * print-size cap on) and checks the result independently: qpdf says it is not
 * encrypted, the bytes hold no /Encrypt, and MuPDF reads the same text from the
 * original and the export (first 30 pages, whitespace removed). Nothing is written
 * into the input file.
 */
import fs from 'node:fs';
import type { Source } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { mupdf } from '../../src/lib/engine/mupdf';
import { limitsSet } from '../../src/lib/engine/limits';
import { engine, qpdf } from '../survey/lib/engine';
import { serveJobs } from '../survey/lib/pool';

export interface UnlockJob {
	sha256: string;
	path: string;
	source: string;
	/** 'export': open and export (owner-only files); 'probe': open only (other encrypted-looking files). */
	mode: 'export' | 'probe';
}

export interface UnlockResult {
	sha256: string;
	path: string;
	source: string;
	mode: UnlockJob['mode'];
	/** No /Encrypt in the bytes at all (probe mode only; nothing else was done). */
	plain?: boolean;
	R?: number;
	P?: number;
	method?: string;
	/** /Filter of the encryption dictionary when qpdf declined it. */
	filter?: string;
	qpdfError?: string;
	open: 'ok' | 'error';
	openCode?: string;
	openMessage?: string;
	limits?: string[];
	notes?: string[];
	export?: 'ok' | 'error' | 'skipped';
	exportCode?: string;
	exportMessage?: string;
	exportEncrypted?: boolean;
	rawEncrypt?: boolean;
	text?: 'same' | 'differs' | 'no-text' | 'unchecked';
	textDetail?: string;
	ms: number;
}

const MAX_TEXT_PAGES = 30;
const STREAM_FILTERS = new Set(['FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'RunLengthDecode', 'RL', 'CCITTFaxDecode', 'CCF', 'DCTDecode', 'DCT', 'JPXDecode', 'JBIG2Decode', 'Crypt']);

serveJobs<UnlockJob, UnlockResult>(async (job, io) => {
	const t0 = Date.now();
	const bytes = new Uint8Array(fs.readFileSync(job.path));
	const r: UnlockResult = { sha256: job.sha256, path: job.path, source: job.source, mode: job.mode, open: 'error', ms: 0 };
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
	if (job.mode === 'probe' && buf.indexOf('/Encrypt') < 0) {
		r.plain = true;
		r.ms = Date.now() - t0;
		io.result(r);
		return;
	}
	io.progress('show-encryption');
	const shown = await qpdf().run({ args: ['--show-encryption', '/in.pdf'], inputs: { '/in.pdf': bytes } });
	const R = /^R = (\d+)$/m.exec(shown.stdout);
	const P = /^P = (-?\d+)$/m.exec(shown.stdout);
	if (R) r.R = Number(R[1]);
	if (P) r.P = Number(P[1]);
	r.method = /^file encryption method: (\S+)/m.exec(shown.stdout)?.[1] ?? (R && Number(R[1]) <= 3 ? 'RC4' : undefined);
	if (shown.code !== 0) {
		r.qpdfError = shown.stderr.split('\n').filter(Boolean)[0]?.replace(/^.*?\/in\.pdf/, '').slice(0, 200);
	}
	// The security handler: a /Filter name that is not a stream filter, anywhere in the file.
	if (shown.code !== 0 || job.mode === 'probe') {
		const names = new Set<string>();
		for (const m of buf.toString('latin1').matchAll(/\/Filter\s*\/([A-Za-z0-9_.#-]+)/g)) if (!STREAM_FILTERS.has(m[1])) names.add(m[1]);
		if (names.size) r.filter = [...names].join(' ');
	}

	io.progress('open');
	let src: Source;
	try {
		src = await engine().openPdf(bytes, 'survey.pdf');
		r.open = 'ok';
		r.limits = limitsSet(src.limits);
		r.notes = src.notes;
	} catch (e) {
		r.openCode = e instanceof EngineError ? e.code : 'exception';
		r.openMessage = e instanceof Error ? e.message : String(e);
		r.ms = Date.now() - t0;
		io.result(r);
		return;
	}
	if (job.mode !== 'export') {
		r.ms = Date.now() - t0;
		io.result(r);
		return;
	}

	io.progress('export');
	let out: Uint8Array;
	try {
		const pages = src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0 as const, stamps: [] }));
		const res = await engine().exportPlan({ pages, options: { filename: 'out.pdf', compress: true, stripMetadata: false, printCap: true } }, [src], []);
		out = res.bytes;
		r.export = 'ok';
	} catch (e) {
		r.export = 'error';
		r.exportCode = e instanceof EngineError ? e.code : 'exception';
		r.exportMessage = e instanceof Error ? e.message : String(e);
		r.ms = Date.now() - t0;
		io.result(r);
		return;
	}
	const enc = await qpdf().run({ args: ['--is-encrypted', '/o.pdf'], inputs: { '/o.pdf': out } });
	r.exportEncrypted = !(enc.code === 2 && !/invalid password/i.test(enc.stderr));
	r.rawEncrypt = Buffer.from(out.buffer, out.byteOffset, out.length).indexOf('/Encrypt') >= 0;

	io.progress('text');
	try {
		const m = await mupdf();
		const textOf = (b: Uint8Array) => {
			const doc = m.Document.openDocument(b.slice(), 'application/pdf');
			try {
				if (doc.needsPassword()) return null;
				const n = Math.min(MAX_TEXT_PAGES, doc.countPages());
				const pages: string[] = [];
				for (let i = 0; i < n; i++) {
					const page = doc.loadPage(i);
					const st = page.toStructuredText();
					pages.push(st.asText().replace(/\s+/g, ''));
					st.destroy();
					page.destroy();
				}
				return pages;
			} finally {
				doc.destroy();
			}
		};
		const a = textOf(bytes);
		const b = textOf(out);
		if (!a || !b) r.text = 'unchecked';
		else if (a.every((t) => t === '')) r.text = a.join('') === b.join('') ? 'no-text' : 'differs';
		else {
			const diff = a.findIndex((t, i) => t !== b[i]);
			r.text = diff < 0 && a.length === b.length ? 'same' : 'differs';
			if (diff >= 0) r.textDetail = `page ${diff + 1}: ${a[diff].length} vs ${b[diff]?.length ?? 0} characters`;
		}
	} catch (e) {
		r.text = 'unchecked';
		r.textDetail = e instanceof Error ? e.message.slice(0, 200) : String(e);
	}
	r.ms = Date.now() - t0;
	io.result(r);
});
