<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { dev } from '$app/env';
	import ToastRegion from '#lib/ui/ToastRegion.svelte';
	import TopBar from '#lib/ui/TopBar.svelte';
	import { registerServiceWorker } from '#lib/ui/sw-register.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	onMount(() => {
		if (!dev) registerServiceWorker();
	});
</script>

<a class="skip-link" href="#main">Skip to content</a>
<TopBar />
<main id="main" tabindex="-1">
	{@render children()}
</main>
<ToastRegion />

<style>
	main {
		outline: none;
	}
</style>
