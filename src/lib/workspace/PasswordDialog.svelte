<script lang="ts">
	import Button from '../ui/Button.svelte';
	import Dialog from '../ui/Dialog.svelte';
	import Field from '../ui/Field.svelte';
	import type { PasswordAsk } from './intake.svelte';

	interface Props {
		/** The file waiting for a password, or null when closed. */
		ask: PasswordAsk | null;
		onanswer: (password: string | null) => void;
	}

	let { ask, onanswer }: Props = $props();

	let open = $state(false);
	let value = $state('');
	let show = $state(false);
	let answered = false;

	$effect(() => {
		if (ask) {
			value = '';
			answered = false;
			open = true;
			if (ask.error) {
				// Wrong password: the dialog stays open; put the caret back in the field.
				queueMicrotask(() => document.querySelector<HTMLInputElement>('#pw-form input')?.focus());
			}
		} else open = false;
	});

	function submit(e: Event) {
		e.preventDefault();
		if (!value) return;
		answered = true;
		onanswer(value);
	}

	function skip() {
		answered = true;
		onanswer(null);
	}

	function onclose() {
		// Escape or the close button: same as Skip.
		if (!answered && ask) skip();
	}
</script>

<Dialog
	bind:open
	title="This file has a password"
	description={ask ? `Enter the password for ${ask.name}. It is used only on this device.` : undefined}
	dismissable={false}
	width="420px"
	{onclose}
>
	<form id="pw-form" class="form" onsubmit={submit} novalidate>
		<Field
			label="Password"
			type={show ? 'text' : 'password'}
			bind:value
			autocomplete="off"
			autofocus
			error={ask?.error}
		/>
		<label class="show"><input type="checkbox" bind:checked={show} /> Show password</label>
	</form>
	{#snippet actions()}
		<Button variant="quiet" onclick={skip}>Skip this file</Button>
		<Button variant="primary" type="submit" form="pw-form" disabled={!value}>Open</Button>
	{/snippet}
</Dialog>

<style>
	.form {
		display: grid;
		gap: var(--s-3);
	}

	.show {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		width: fit-content;
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.show input {
		width: 16px;
		height: 16px;
		accent-color: var(--ink);
	}
</style>
