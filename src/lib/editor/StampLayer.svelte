<script lang="ts">
	// Stub. The Editor stream replaces this file; the props are the contract.
	// Non-interactive overlay that draws a page's stamps on top of its thumbnail.
	// The parent is a positioned box with the displayed page's aspect ratio.
	import type { Asset, PageRef } from '../core/types';

	let { page, assets }: { page: PageRef; assets: readonly Asset[] } = $props();
</script>
