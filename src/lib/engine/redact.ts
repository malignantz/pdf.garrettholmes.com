/**
 * True redaction with MuPDF: remove text, image pixels, line art, links and
 * annotations under each box, paint the box black, and prove it.
 *
 * Stub until the redaction stream lands: a plan with any redaction is refused.
 */

import type { PageSize, StampBox, VerifyCheck } from '../core/types';
import type { EngineDeps } from './deps';
import { EngineError } from './errors';

export interface RedactJob {
	/** 0-based page index in the assembled file (= output page index). */
	pageIndex: number;
	/** Stamp boxes: fractions of the page as displayed (after all rotation), origin top-left. */
	boxes: StampBox[];
	/** Displayed size the plan expects for this page (PDF points, UserUnit applied). */
	expected: PageSize;
}

/**
 * The redact stage. Must check its own result (nothing readable under any box,
 * boxes black) before returning, and throw EngineError('verification-failed')
 * with a 'redaction' check otherwise.
 */
export async function applyRedactions(_deps: EngineDeps, bytes: Uint8Array, jobs: RedactJob[]): Promise<Uint8Array> {
	if (jobs.length > 0) throw new EngineError('unsupported', 'Redaction is not available yet.');
	return bytes;
}

/**
 * 'redaction' check on the final file. `allowedText[i]` lists the strings our own
 * stamps and page numbers may have drawn on job i's page (they may overlap a box).
 */
export async function verifyRedactions(
	_deps: EngineDeps,
	_finalBytes: Uint8Array,
	_jobs: RedactJob[],
	_allowedText: string[][],
	_password?: string
): Promise<VerifyCheck[]> {
	return [];
}
