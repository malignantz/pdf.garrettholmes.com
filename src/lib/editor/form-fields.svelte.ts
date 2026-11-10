/**
 * The fillable fields of each open source, read once from the engine and shared by
 * the page grid (the "Form" chip) and the page editor (the controls). Reading is
 * reactive: `formFieldsOf(source)` returns undefined until the engine answers, and
 * components that read it update when it does. Sources are immutable, so the
 * answer is kept for as long as the app runs; it is small (names and boxes).
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Engine, FormField, Source, SourceId } from '../core/types';

const NONE: readonly FormField[] = Object.freeze([]);
const known = new SvelteMap<SourceId, readonly FormField[]>();
const asked = new Set<SourceId>();

/** Fields of a source; [] when it has no form, undefined while they are being read. */
export function formFieldsOf(engine: Pick<Engine, 'formFields'>, source: Source | undefined): readonly FormField[] | undefined {
	if (!source) return undefined;
	if (!source.hasForm) return NONE;
	const got = known.get(source.id);
	if (got) return got;
	if (!asked.has(source.id)) {
		asked.add(source.id);
		const id = source.id;
		// Started outside the reading effect: the write happens later, in a callback.
		queueMicrotask(() => {
			engine.formFields(source).then(
				(fields) => known.set(id, Object.freeze(fields)),
				(e) => {
					console.warn('Could not read the form fields', e);
					known.set(id, NONE);
				}
			);
		});
	}
	return undefined;
}

/** 0-based source page indices that have at least one field widget. */
export function pagesWithFields(fields: readonly FormField[] | undefined): ReadonlySet<number> {
	const out = new Set<number>();
	for (const f of fields ?? []) for (const w of f.widgets) out.add(w.pageIndex);
	return out;
}
