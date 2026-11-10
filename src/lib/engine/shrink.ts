/**
 * Compress to a target size (ExportOptions.targetBytes): lower the resolution
 * and quality of plain 8-bit grey/RGB images step by step until the finalized
 * file fits. See the plan's "Phase 2 design".
 *
 * Stub: finalizes once without touching any image.
 */

import type { ExportResult, VerifyCheck } from '../core/types';
import type { EngineDeps } from './deps';

export type ShrinkReport = NonNullable<ExportResult['shrink']>;

/**
 * `bytes` is the file after stamps, before finalize. `finalize` runs the qpdf
 * finalize step (compress, metadata, password) and returns the final bytes; call
 * it for every candidate so the size measured is the size delivered.
 * Returns the finalized bytes to deliver (the smallest verified one when the
 * target cannot be reached), the report, and this stage's checks ('visual',
 * 'target-size'). Every returned check must be ok.
 */
export async function shrinkToTarget(
	_deps: EngineDeps,
	bytes: Uint8Array,
	targetBytes: number,
	finalize: (b: Uint8Array) => Promise<Uint8Array>
): Promise<{ bytes: Uint8Array; shrink: ShrinkReport; checks: VerifyCheck[] }> {
	const out = await finalize(bytes);
	const reached = out.length <= targetBytes;
	return {
		bytes: out,
		shrink: { targetBytes, reached, imagesChanged: 0, dpi: 0 },
		checks: [
			{
				name: 'target-size',
				ok: true,
				detail: reached
					? `${out.length} bytes, within the target of ${targetBytes}.`
					: `${out.length} bytes; the target of ${targetBytes} could not be reached (no image was changed).`
			}
		]
	};
}
