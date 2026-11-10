<script lang="ts">
	import { onMount, type Component } from 'svelte';

	let Harness = $state<Component | null>(null);

	onMount(() => {
		if (import.meta.env.DEV || import.meta.env.VITE_DEV_HARNESS === '1') {
			import('#lib/editor/dev/Harness.svelte').then((m) => (Harness = m.default));
		}
	});
</script>

<svelte:head>
	<title>Editor harness</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if Harness}<Harness />{:else}<p style="padding: 16px">Not available here.</p>{/if}
