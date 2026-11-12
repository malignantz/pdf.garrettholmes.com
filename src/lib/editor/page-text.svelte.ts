/**
 * The words of source pages for the text highlighter, read from the engine (in its
 * worker, off the main thread) once per page and kept for the visit. Reading is
 * reactive: `pageTextOf` says 'loading' until the engine answers, and components that
 * read it update when it does. The first call loads MuPDF in the worker (about 10 MB,
 * cached after); nothing else waits for it.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Engine, PageText, Source } from '../core/types';

export type PageTextState =
	| { status: 'loading' }
	| { status: 'ready'; text: PageText }
	/** The engine could not read the page's text. */
	| { status: 'failed' };

const LOADING: PageTextState = Object.freeze({ status: 'loading' });
const FAILED: PageTextState = Object.freeze({ status: 'failed' });
/** Pages kept; a page is a few kilobytes to a few hundred. */
const KEEP = 60;

const known = new SvelteMap<string, PageTextState>();
const asked = new Set<string>();

/** True once any page's text has been read this visit (MuPDF is then loaded, so reading ahead is cheap). */
let warm = $state(false);
export const textWarm = () => warm;

export function pageTextOf(engine: Pick<Engine, 'pageText'>, source: Source | undefined, pageIndex: number): PageTextState {
	if (!source) return LOADING;
	if (source.kind !== 'pdf') return { status: 'ready', text: { words: [], skipped: 0 } };
	const key = `${source.id}:${pageIndex}`;
	const got = known.get(key);
	if (got) return got;
	if (!asked.has(key)) {
		asked.add(key);
		// Started outside the reading effect: the write happens later, in a callback.
		queueMicrotask(() => {
			engine.pageText(source, pageIndex).then(
				(text) => {
					warm = true;
					known.set(key, { status: 'ready', text: Object.freeze(text) as PageText });
					trim();
				},
				(e) => {
					console.warn('Could not read the page text', e);
					known.set(key, FAILED);
				}
			);
		});
	}
	return LOADING;
}

function trim() {
	while (known.size > KEEP) {
		const first = known.keys().next().value!;
		known.delete(first);
		asked.delete(first);
	}
}
