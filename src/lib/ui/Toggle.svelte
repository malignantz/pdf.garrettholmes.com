<script lang="ts">
	interface Props {
		checked?: boolean;
		label: string;
		/** One line under the label. */
		hint?: string;
		disabled?: boolean;
		onchange?: (checked: boolean) => void;
	}

	let { checked = $bindable(false), label, hint, disabled = false, onchange }: Props = $props();
	const uid = Math.random().toString(36).slice(2, 9);

	function toggle() {
		checked = !checked;
		onchange?.(checked);
	}
</script>

<div class="toggle-row">
	<button
		type="button"
		role="switch"
		class="switch"
		aria-checked={checked}
		aria-labelledby="tg-{uid}"
		aria-describedby={hint ? `tg-hint-${uid}` : undefined}
		{disabled}
		onclick={toggle}
	>
		<span class="thumb"></span>
	</button>
	<span class="text">
		<!-- Clicking the label toggles too; the switch itself is the keyboard target. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<span class="label" id="tg-{uid}" onclick={() => !disabled && toggle()}>{label}</span>
		{#if hint}<span class="hint" id="tg-hint-{uid}">{hint}</span>{/if}
	</span>
</div>

<style>
	.toggle-row {
		display: flex;
		align-items: flex-start;
		gap: var(--s-3);
	}

	.switch {
		position: relative;
		flex: none;
		width: 40px;
		height: 24px;
		margin-top: 0;
		border-radius: 12px;
		background: var(--line-strong);
		transition: background-color var(--dur) var(--ease);
	}

	/* 48px hit area on touch without changing the drawing */
	@media (pointer: coarse) {
		.switch::after {
			content: '';
			position: absolute;
			inset: -12px -4px;
		}
	}

	.thumb {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--sheet);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
		transition: transform var(--dur) var(--ease);
	}

	.switch[aria-checked='true'] {
		background: var(--ink);
	}

	.switch[aria-checked='true'] .thumb {
		transform: translateX(16px);
		background: var(--surface);
	}

	.switch:disabled {
		opacity: 0.45;
	}

	.text {
		display: grid;
		gap: 2px;
		padding-top: 1px;
	}

	.label {
		font-size: var(--text-control);
		cursor: default;
		user-select: none;
	}

	.hint {
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}
</style>
