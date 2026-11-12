<script lang="ts">
	import Button from '../ui/Button.svelte';
	import Dialog from '../ui/Dialog.svelte';
	import Toggle from '../ui/Toggle.svelte';

	/** "Your work on this device": the switch, Forget my work, and what is saved. */
	interface Props {
		open: boolean;
		keep: boolean;
		line: string;
		/** Something is open or saved that Forget would remove. */
		canForget: boolean;
		onkeep: (on: boolean) => void;
		onforget: () => void;
	}

	let { open = $bindable(false), keep, line, canForget, onkeep, onforget }: Props = $props();

	let checked = $state(true);
	$effect(() => {
		checked = keep;
	});
</script>

<Dialog
	bind:open
	title="Your work on this device"
	description="Open files and changes are kept in this browser, so you can pick up where you left off. They are never sent anywhere."
	width="460px"
>
	<div class="body">
		<p class="status">{line}</p>
		<Toggle
			bind:checked
			label="Keep my work on this device"
			hint="Saved work is deleted 7 days after the last change. Turning this off deletes it now."
			onchange={(on) => onkeep(on)}
		/>
		<div class="forget">
			<Button variant="secondary" icon="trash" disabled={!canForget} onclick={onforget}>Forget my work</Button>
			<p class="caption">Deletes the saved files and changes from this device now. What is open here stays until you close the tab.</p>
		</div>
		<p class="caption">Saved signatures are kept apart from this. Delete them in the signature tool.</p>
	</div>
	{#snippet actions()}
		<Button variant="quiet" onclick={() => (open = false)}>Close</Button>
	{/snippet}
</Dialog>

<style>
	.body {
		display: grid;
		gap: var(--s-4);
	}

	.status {
		font-size: var(--text-control);
		font-weight: 550;
	}

	.forget {
		display: grid;
		gap: var(--s-2);
		justify-items: start;
	}

	.caption {
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}
</style>
