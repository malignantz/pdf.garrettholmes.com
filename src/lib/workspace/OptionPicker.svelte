<script lang="ts" generics="T extends string">
	/** A small radio group drawn as buttons (arrow keys move the choice). */
	interface Props {
		label: string;
		value: T;
		options: readonly { value: T; label: string; aria?: string }[];
		/** 'row': chips in a line. 'corners': a 3 x 2 grid that mimics a page. */
		layout?: 'row' | 'corners';
		disabled?: boolean;
	}

	let { label, value = $bindable(), options, layout = 'row', disabled = false }: Props = $props();
	const uid = Math.random().toString(36).slice(2, 9);
	let group: HTMLElement | undefined = $state();

	function key(e: KeyboardEvent) {
		const i = options.findIndex((o) => o.value === value);
		let n = i;
		if (e.key === 'ArrowRight') n = i + 1;
		else if (e.key === 'ArrowLeft') n = i - 1;
		else if (e.key === 'ArrowDown') n = layout === 'corners' ? i + 3 : i + 1;
		else if (e.key === 'ArrowUp') n = layout === 'corners' ? i - 3 : i - 1;
		else return;
		e.preventDefault();
		if (n < 0 || n >= options.length) return;
		value = options[n].value;
		group?.querySelectorAll<HTMLElement>('[role=radio]')[n]?.focus();
	}
</script>

<div class="wrap">
	<span class="label" id="op-{uid}">{label}</span>
	<!-- svelte-ignore a11y_interactive_supports_focus -->
	<div class="group {layout}" role="radiogroup" aria-labelledby="op-{uid}" bind:this={group} onkeydown={key}>
		{#each options as o (o.value)}
			<button
				type="button"
				role="radio"
				class="opt"
				class:on={o.value === value}
				aria-checked={o.value === value}
				aria-label={o.aria ?? (layout === 'corners' ? o.label : undefined)}
				title={layout === 'corners' ? o.label : undefined}
				tabindex={o.value === value ? 0 : -1}
				{disabled}
				onclick={() => (value = o.value)}
			>
				{#if layout === 'corners'}<span class="dot dot-{o.value}"></span>{:else}{o.label}{/if}
			</button>
		{/each}
	</div>
</div>

<style>
	.wrap {
		display: grid;
		gap: 6px;
	}

	.label {
		font-size: var(--text-control);
		font-weight: 550;
	}

	.group.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}

	.group.corners {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--s-1);
		width: 132px;
		padding: var(--s-1);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-page);
		background: var(--sheet);
	}

	.opt {
		position: relative;
		min-height: 36px;
		padding: 0 var(--s-3);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-control);
		background: var(--surface);
		color: var(--ink);
		font-size: var(--text-control);
	}

	@media (pointer: coarse) {
		.opt {
			min-height: 44px;
		}
	}

	.opt:hover {
		border-color: var(--ink-soft);
	}

	.opt.on {
		background: var(--ink);
		color: var(--surface);
		border-color: var(--ink);
	}

	.corners .opt {
		padding: 0;
		min-height: 44px;
		border-color: transparent;
		background: transparent;
	}

	.corners .opt:hover {
		background: var(--hover);
	}

	.corners .opt.on {
		background: transparent;
	}

	.dot {
		position: absolute;
		width: 14px;
		height: 6px;
		border-radius: 1px;
		background: var(--line-strong);
	}

	.opt.on .dot {
		background: var(--accent);
	}

	.dot-top-left,
	.dot-bottom-left {
		left: 4px;
	}

	.dot-top-right,
	.dot-bottom-right {
		right: 4px;
	}

	.dot-top-center,
	.dot-bottom-center {
		left: calc(50% - 7px);
	}

	.dot-top-left,
	.dot-top-center,
	.dot-top-right {
		top: 4px;
	}

	.dot-bottom-left,
	.dot-bottom-center,
	.dot-bottom-right {
		bottom: 4px;
	}
</style>
