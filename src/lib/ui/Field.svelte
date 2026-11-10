<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLInputAttributes, 'value'> {
		label: string;
		value?: string;
		/** Short help under the input. */
		hint?: string;
		/** Error sentence: what happened and what to do. Sets aria-invalid. */
		error?: string;
	}

	let { label, value = $bindable(''), hint, error, id, type = 'text', class: className = '', ...rest }: Props =
		$props();

	const uid = Math.random().toString(36).slice(2, 9);
	const inputId = $derived(id ?? `field-${uid}`);
	const describedBy = $derived(
		[error ? `${inputId}-err` : null, hint ? `${inputId}-hint` : null].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="field {className}" class:invalid={!!error}>
	<label for={inputId}>{label}</label>
	<input
		{...rest}
		id={inputId}
		{type}
		bind:value
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={describedBy}
	/>
	{#if hint}<p class="hint" id="{inputId}-hint">{hint}</p>{/if}
	{#if error}<p class="error" id="{inputId}-err">{error}</p>{/if}
</div>

<style>
	.field {
		display: grid;
		gap: 6px;
	}

	label {
		font-size: var(--text-control);
		font-weight: 550;
	}

	input {
		width: 100%;
		min-height: max(40px, var(--control-h));
		padding: 0 var(--s-3);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-control);
		background: var(--surface);
		color: var(--ink);
		font-size: var(--text-base);
		transition: border-color var(--dur-fast) var(--ease);
	}

	input::placeholder {
		color: color-mix(in srgb, var(--ink-soft) 80%, transparent);
	}

	input:hover {
		border-color: var(--ink-soft);
	}

	input:focus-visible {
		outline-offset: 0;
		border-color: var(--accent);
	}

	.invalid input {
		border-color: var(--danger);
	}

	.hint,
	.error {
		font-size: var(--text-caption);
		line-height: 1.4;
	}

	.hint {
		color: var(--ink-soft);
	}

	.error {
		color: var(--danger);
		font-weight: 550;
	}
</style>
