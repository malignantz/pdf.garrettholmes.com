import type { Snippet } from 'svelte';

/**
 * The page-actions region of the top bar. A page renders <TopBarActions> with
 * its buttons (undo/redo, Export); the layout renders whatever is registered.
 */
export const topbar = $state<{ actions: Snippet | null }>({ actions: null });
