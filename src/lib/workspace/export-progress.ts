/**
 * What the export dialog shows while working: the bar's fraction, the step's words and
 * the sample the remaining-time estimate (time-left.ts) reads, from ExportProgress.
 */

import type { ExportProgress } from '../core/types';
import { ocrProgressText } from './ocr-option';
import { printCapProgressText } from './print-cap-option';
import type { StepSample } from './time-left';

/** 0..1 while a stage with a count is running; undefined (indeterminate) otherwise. */
export function progressFraction(p: ExportProgress | null): number | undefined {
	if (!p || !('done' in p) || !(p.total > 0) || p.done >= p.total) return undefined;
	return Math.max(0, p.done / p.total);
}

/** The step's words, or null for the dialog's general line. */
export function progressText(p: ExportProgress | null): string | null {
	const special = ocrProgressText(p) ?? printCapProgressText(p);
	if (special || !p || !('done' in p) || p.done >= p.total) return special;
	switch (p.stage) {
		case 'pack':
			return 'Compressing…';
		case 'reduce':
			return `Reducing picture ${p.done + 1} of ${p.total}`;
		case 'compare':
			return `Comparing page ${p.done + 1} of ${p.total}`;
		case 'check':
			return 'Checking the finished file…';
		default:
			return null;
	}
}

/**
 * For the estimate. Only the final check says its end is the export's end; the other
 * counted steps get an estimate of their own. Not the stream pass: it stops on a time
 * budget, so its rate says little about its end.
 */
export function progressSample(p: ExportProgress | null): StepSample | null {
	const fraction = progressFraction(p);
	if (!p || fraction === undefined || p.stage === 'pack') return null;
	return { step: p.stage, fraction, final: p.stage === 'check' && p.last };
}
