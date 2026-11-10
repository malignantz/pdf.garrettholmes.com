<script lang="ts">
	// Placeholder: the Workspace stream replaces this page with the page grid.
	import EmptyDesk from '#lib/ui/EmptyDesk.svelte';
	import { toasts } from '#lib/ui/toasts.svelte.ts';

	function onfiles(files: File[]) {
		const n = files.length;
		toasts.show(`${n} ${n === 1 ? 'file' : 'files'} chosen. The workspace is not built yet.`);
	}
</script>

<svelte:head>
	<title>PDF Workspace · pdf.garrettholmes.com</title>
</svelte:head>

<EmptyDesk {onfiles} />
