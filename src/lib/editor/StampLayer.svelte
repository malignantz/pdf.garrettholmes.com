<script lang="ts">
	// Non-interactive overlay that draws a page's stamps on top of its thumbnail.
	// The parent is a positioned box with the displayed page's aspect ratio.
	// Cheap: no observers, no measuring. Sizes come from CSS (percentages and
	// container query units), images share one object URL per asset.
	import type { Asset, PageRef } from '../core/types';
	import { getApp } from '../app';
	import StampShape from './StampShape.svelte';
	import { ensureStampFont } from './stamp-view';

	let { page, assets }: { page: PageRef; assets: readonly Asset[] } = $props();

	const byId = $derived(new Map(assets.map((a) => [a.id, a])));
	const aspect = $derived.by(() => {
		if (page.stamps.every((s) => s.kind !== 'mark')) return 1;
		const size = getApp().store.displayedSize(page);
		return size && size.height > 0 ? size.width / size.height : 1;
	});

	$effect(() => {
		if (page.stamps.some((s) => s.kind === 'text')) void ensureStampFont();
	});
</script>

{#if page.stamps.length > 0}
	<div class="stamp-layer" aria-hidden="true">
		{#each page.stamps as stamp (stamp.id)}
			<StampShape {stamp} asset={stamp.kind === 'image' ? byId.get(stamp.assetId) : undefined} {aspect} />
		{/each}
	</div>
{/if}

<style>
	.stamp-layer {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		container-type: size;
	}
</style>
