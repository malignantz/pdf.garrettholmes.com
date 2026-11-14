/**
 * The export dialog's options, shared so the saved session can keep them (never the
 * password, which the dialog holds on its own and clears every time it opens).
 */
import { DEFAULT_FORM, type ExportForm } from './logic';

export const exportForm = $state<Omit<ExportForm, 'filename' | 'password'>>({ ...DEFAULT_FORM });

/**
 * A new job: files were added to an empty workspace. The watermark switch and "Make
 * scanned pages black and white" go back to off (both change how pages look), so a DRAFT
 * or a conversion meant for one file never lands on the next one; the text, look,
 * strength and colour stay as chosen. Reopening the dialog on the same work, undoing
 * "Start over" and restoring saved work (which brings back its own options) do not
 * count as a new job.
 */
export function startNewJob() {
	exportForm.watermark = false;
	exportForm.bilevel = false;
}
