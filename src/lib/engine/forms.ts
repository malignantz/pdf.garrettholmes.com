/**
 * AcroForm fields: detect at intake, list for the UI, write answers (and
 * optionally flatten) at export, read them back from the final file.
 *
 * Stub until the forms stream lands: no source reports a form, nothing is
 * listed, and a plan with answers is refused.
 */

import type { FormField, FormValues, Rotation, Source, VerifyCheck } from '../core/types';
import type { EngineDeps } from './deps';
import { EngineError } from './errors';

/** One output page of the plan, in order: page i of the assembled file. */
export interface FormsPage {
	source: Source;
	/** 0-based index into source.pages. */
	pageIndex: number;
	/** PageRef.rotation the assemble step applied. */
	rotation: Rotation;
}

export interface FormsContext {
	pages: FormsPage[];
	/** plan.formValues limited to the sources this plan uses ({} when none). */
	formValues: FormValues;
	/** Turn fields into page content: options.flattenForms, or forced because the plan has a redaction. */
	flatten: boolean;
}

/** True when the forms stage has anything to do for this plan. */
export function formsNeeded(ctx: FormsContext): boolean {
	return ctx.flatten || Object.values(ctx.formValues).some((v) => Object.keys(v).length > 0);
}

/**
 * Called by openPdf on the normalized bytes. Must be cheap (it runs on every
 * file opened); it must not load MuPDF unless the file plausibly has a form.
 */
export async function detectForm(_deps: EngineDeps, _bytes: Uint8Array): Promise<boolean> {
	return false;
}

/** Fillable fields of a source (Engine.formFields). */
export async function listFormFields(_deps: EngineDeps, _source: Source): Promise<FormField[]> {
	return [];
}

/**
 * The forms stage: writes ctx.formValues into the assembled file (`bytes`),
 * regenerates appearances, and flattens when ctx.flatten.
 */
export async function applyForms(_deps: EngineDeps, bytes: Uint8Array, ctx: FormsContext): Promise<Uint8Array> {
	if (Object.values(ctx.formValues).some((v) => Object.keys(v).length > 0)) {
		throw new EngineError('unsupported', 'Filling in forms is not available yet.');
	}
	// No source reports a form yet (detectForm), so there is nothing to flatten.
	return bytes;
}

/** 'forms' check on the final file. Runs only when the forms stage ran. */
export async function verifyForms(
	_deps: EngineDeps,
	_finalBytes: Uint8Array,
	_ctx: FormsContext,
	_password?: string
): Promise<VerifyCheck[]> {
	return [];
}
