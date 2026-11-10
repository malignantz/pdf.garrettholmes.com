import { createSubscriber } from 'svelte/reactivity';
import type { DocState, DocStore } from './store';

/**
 * Reactive view of a DocStore for Svelte 5 components. Reads inside `$derived`,
 * `$effect` or the template track the store; the subscription is created and
 * released automatically with the reading effect.
 *
 *   const doc = useDocStore(store);
 *   {#each doc.state.pages as page (page.id)} ...
 */
export function useDocStore(store: DocStore) {
	const subscribe = createSubscriber((update) => store.subscribe(() => update()));
	return {
		/** The underlying store, for commands. */
		store,
		get state(): DocState {
			subscribe();
			return store.state;
		}
	};
}
