<script lang="ts">
	// Stub. The Editor stream replaces this file; the props are the contract.
	import type { PageId } from '../core/types';

	let { pageId, onclose }: { pageId: PageId; onclose: () => void } = $props();
</script>

<button type="button" onclick={onclose}>Close editor for {pageId}</button>
