/**
 * Form answers for the PDF.js preview. Pure functions; no PDF.js import.
 *
 * PDF.js draws a widget from its `annotationStorage` entry (keyed by annotation
 * id) when a page is rendered with `AnnotationMode.ENABLE_STORAGE`. This module
 * turns `RenderRequest.formValues` (field name -> FormValue, the names of
 * `Engine.formFields`, which follow PDF.js `fieldName` and `buttonValue`) into
 * those entries for the widgets of one page:
 *
 * - text (Tx):        { value: string }
 * - checkbox (Btn):   { value: boolean } on every widget of the field
 * - radio (Btn):      { value: boolean } per widget, true for the widget whose
 *                     `buttonValue` is the chosen option
 * - combo box (Ch):   { value: string } (export value; PDF.js draws its label)
 *
 * A value of the wrong type for the widget is ignored. Widgets that the engine
 * never fills are ignored too, so they show what the file stores: read-only,
 * password, comb without MaxLen, list boxes, push buttons, signatures, hidden.
 * A widget whose answer equals what the file stores gets no entry, so it keeps
 * the file's own appearance (as the export does: it only writes changed values),
 * and a page with no entry renders exactly as without form values.
 *
 * What PDF.js does not expose, and so cannot be checked here: calculate actions
 * (/AA /C) and /AcroForm /CO. The engine lists those fields read-only and the
 * export refuses to change them, so callers pass answers only for fields that
 * `Engine.formFields` lists with `readOnly: false`.
 */

import type { FormValue } from '../core/types';

/** The fields of a PDF.js widget annotation (`page.getAnnotations()`) used here. */
export interface WidgetAnnotation {
	id: string;
	subtype?: string;
	fieldName?: string;
	fieldType?: string;
	fieldValue?: unknown;
	readOnly?: boolean;
	hidden?: boolean;
	password?: boolean;
	comb?: boolean;
	maxLen?: number;
	checkBox?: boolean;
	radioButton?: boolean;
	pushButton?: boolean;
	exportValue?: string;
	buttonValue?: string;
	combo?: boolean;
}

export type WidgetKind = 'text' | 'checkbox' | 'radio' | 'combo';

/** A widget of one page the preview may draw an answer into. */
export interface FillableWidget {
	id: string;
	field: string;
	kind: WidgetKind;
	/** What the file shows now, in the shape of the storage value. */
	stored: string | boolean;
	/** radio only. */
	option?: string;
}

/** `[annotation id, storage value]`, sorted by id. */
export type StorageEntry = [string, { value: string | boolean }];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const firstChoice = (v: unknown): string => (Array.isArray(v) ? str(v[0]) : str(v));

/** The widgets of a page the preview may fill. Everything else is drawn as stored. */
export function fillableWidgets(annotations: readonly WidgetAnnotation[]): FillableWidget[] {
	const out: FillableWidget[] = [];
	for (const a of annotations) {
		if (a.subtype !== 'Widget' || !a.fieldName || typeof a.id !== 'string') continue;
		if (a.readOnly || a.hidden) continue;
		const base = { id: a.id, field: a.fieldName };
		switch (a.fieldType) {
			case 'Tx':
				if (a.password || (a.comb && !a.maxLen)) break;
				out.push({ ...base, kind: 'text', stored: str(a.fieldValue) });
				break;
			case 'Btn':
				if (a.checkBox) {
					out.push({ ...base, kind: 'checkbox', stored: a.fieldValue === a.exportValue });
				} else if (a.radioButton && typeof a.buttonValue === 'string') {
					out.push({ ...base, kind: 'radio', option: a.buttonValue, stored: a.fieldValue === a.buttonValue });
				}
				break;
			case 'Ch':
				if (a.combo) out.push({ ...base, kind: 'combo', stored: firstChoice(a.fieldValue) });
				break;
		}
	}
	return out;
}

/** Storage value for one widget, or undefined when the answer does not fit its type. */
function valueFor(w: FillableWidget, v: FormValue): string | boolean | undefined {
	switch (w.kind) {
		case 'text':
			return typeof v === 'string' ? v : undefined;
		case 'checkbox':
			return typeof v === 'boolean' ? v : undefined;
		case 'radio':
			return typeof v === 'string' ? v === w.option : undefined;
		case 'combo':
			// [] would trip an assertion in PDF.js; no choice draws an empty box.
			return Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length <= 1 ? (v[0] ?? '') : undefined;
	}
}

/** Annotation storage entries for the answers that change what this page shows. */
export function storageEntries(
	widgets: readonly FillableWidget[],
	values: Readonly<Record<string, FormValue>> | undefined
): StorageEntry[] {
	if (!values) return [];
	const out: StorageEntry[] = [];
	for (const w of widgets) {
		if (!Object.hasOwn(values, w.field)) continue;
		const value = valueFor(w, values[w.field]);
		if (value === undefined || value === w.stored) continue;
		out.push([w.id, { value }]);
	}
	return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Cache-key part for a page's entries; '' when there are none. */
export function entriesKey(entries: readonly StorageEntry[]): string {
	return entries.length ? JSON.stringify(entries) : '';
}
