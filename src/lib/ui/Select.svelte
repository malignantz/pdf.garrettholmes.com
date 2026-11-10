<script lang="ts" generics="T extends string">
	interface Props {
		label: string;
		value: T;
		options: readonly { value: T; label: string }[];
		id?: string;
		disabled?: boolean;
	}

	let { label, value = $bindable(), options, id, disabled = false }: Props = $props();
	const uid = Math.random().toString(36).slice(2, 9);
	const selectId = $derived(id ?? `select-${uid}`);
</script>

<div class="field">
	<label for={selectId}>{label}</label>
	<select id={selectId} bind:value {disabled}>
		{#each options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
	</select>
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

	select {
		width: 100%;
		min-height: max(40px, var(--control-h));
		padding: 0 var(--s-3);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-control);
		background: var(--surface);
		color: var(--ink);
		font-size: var(--text-base);
	}

	select:hover {
		border-color: var(--ink-soft);
	}

	select:focus-visible {
		outline-offset: 0;
		border-color: var(--accent);
	}
</style>
