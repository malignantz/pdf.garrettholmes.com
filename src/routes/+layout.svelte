<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { dev } from '$app/env';
	import { getApp } from '#lib/app.ts';
	import ToastRegion from '#lib/ui/ToastRegion.svelte';
	import TopBar from '#lib/ui/TopBar.svelte';
	import { isBusy, watchFilePickers } from '#lib/ui/busy.ts';
	import { registerServiceWorker } from '#lib/ui/sw-register.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	onMount(() => {
		watchFilePickers();
		// Idle means nothing to lose: no pages, no file picker open, no file still opening.
		if (!dev) registerServiceWorker(() => getApp().store.state.pages.length === 0 && !isBusy());
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
