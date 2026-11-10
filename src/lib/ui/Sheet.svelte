<script lang="ts">
	import type { Snippet } from 'svelte';
	import Dialog from './Dialog.svelte';

	/** A modal bottom sheet on every screen size (choices, page options on phones). */
	interface Props {
		open: boolean;
		title: string;
		description?: string;
		onclose?: () => void;
		children: Snippet;
		actions?: Snippet;
	}

	let { open = $bindable(false), title, description, onclose, children, actions }: Props = $props();
</script>

<Dialog bind:open {title} {description} {onclose} {actions} variant="sheet">
	{@render children()}
</Dialog>
