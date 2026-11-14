/**
 * The final structure check of an export: `qpdf --check`, without the work it throws away.
 *
 * Where the time went (tools/fast-check, plan "Faster final check"): `qpdf --check` writes
 * the whole file to a discarding pipeline with every stream it can decode decoded
 * (QPDFJob::doCheck, decode level "all"). Its writer keeps the default "compress streams"
 * setting, so each decoded image (a JPEG, say) is then deflated again at zlib's default
 * level before the bytes are discarded. On a file of scans that deflate was about two
 * thirds of the check; decoding the JPEGs (the part that verifies anything) is the rest.
 *
 * The fast check is the same command in an instance whose Flate compression level was set
 * to 0 (stored) by a prelude run: `--check` does not take `--compression-level` itself, but
 * the level is a process-wide setting (Pl_Flate::compression_level) that a write sets and
 * that stays set for the next run in the same instance. Nothing else changes: the same
 * objects are parsed, the same streams decoded with the same filters, the same content
 * streams parsed, the same warnings counted; only the encoding of bytes nobody reads.
 *
 * Belt and braces: the fast check can only *accept* a file. When it does not come back
 * clean, or the prelude did not run, the file gets the full check as before (in a fresh
 * instance), and that check's output is what the caller sees. `full: true` forces it.
 */
import { QPDF_OK, type Qpdf, type QpdfResult } from './qpdf';

/** Sets the process-wide Flate level to 0 (writes an empty PDF to /dev/null). */
export const FAST_CHECK_PRELUDE = ['--compression-level=0', '--empty', '/dev/null'];

export type CheckMode = 'fast' | 'full' | 'full-after-fast';

export interface CheckResult extends QpdfResult {
	/** Which check produced this result: the fast one, the full one, or the full one after the fast one was not clean. */
	mode: CheckMode;
	/** Time of each run, ms. */
	ms: { fast?: number; full?: number };
}

export interface CheckOptions {
	password?: string;
	/** Adds `--show-npages` (page count on the last line of stdout). */
	npages?: boolean;
	/** Bytes of the file qpdf has read so far (QpdfRunOptions.readProgress); a full check after the fast one starts again from 0. */
	progress?: (done: number, total: number) => void;
	/** The full check only (EngineOptions.fullCheck). */
	full?: boolean;
	/** Virtual file name (shows in qpdf's messages). */
	path?: string;
}

/** What core.ts counts as a clean check. */
export function checkIsClean(res: Pick<QpdfResult, 'code' | 'stdout'>): boolean {
	return res.code === QPDF_OK && /No syntax or stream encoding errors found/.test(res.stdout);
}

export async function finalCheck(qpdf: Qpdf, bytes: Uint8Array, options: CheckOptions = {}): Promise<CheckResult> {
	const path = options.path ?? '/v.pdf';
	const args = [...(options.password !== undefined ? [`--password=${options.password}`] : []), '--check', ...(options.npages ? ['--show-npages'] : []), path];
	const run = (prelude?: string[]) =>
		qpdf.run({
			args,
			inputs: { [path]: bytes },
			readProgress: options.progress && { path, report: options.progress },
			...(prelude ? { prelude } : {})
		});
	const ms: CheckResult['ms'] = {};
	if (!options.full) {
		options.progress?.(0, bytes.length);
		const t = now();
		const fast = await run(FAST_CHECK_PRELUDE);
		ms.fast = Math.round(now() - t);
		if (fast.prelude === 0 && checkIsClean(fast)) return { ...fast, mode: 'fast', ms };
	}
	options.progress?.(0, bytes.length);
	const t = now();
	const full = await run();
	ms.full = Math.round(now() - t);
	return { ...full, mode: options.full ? 'full' : 'full-after-fast', ms };
}

function now() {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
