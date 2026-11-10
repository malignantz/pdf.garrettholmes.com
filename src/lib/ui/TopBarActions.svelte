<script lang="ts">
	import type { Snippet } from 'svelte';
	import { topbar } from './topbar.svelte';

	/** Put the current page's actions (undo/redo, Export) in the layout's top bar. */
	let { children }: { children: Snippet } = $props();

	$effect(() => {
		const mine = children;
		topbar.actions = mine;
		return () => {
			if (topbar.actions === mine) topbar.actions = null;
		};
	});
</script>
