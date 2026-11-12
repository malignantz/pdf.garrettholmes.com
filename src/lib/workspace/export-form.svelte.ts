/**
 * The export dialog's options, shared so the saved session can keep them (never the
 * password, which the dialog holds on its own and clears every time it opens).
 */
import { DEFAULT_FORM, type ExportForm } from './logic';

export const exportForm = $state<Omit<ExportForm, 'filename' | 'password'>>({ ...DEFAULT_FORM });
