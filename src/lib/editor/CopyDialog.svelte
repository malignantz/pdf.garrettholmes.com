<script lang="ts">
	// "Copy to pages…": put a copy of the selected stamp on other pages, at the
	// same place. The editor applies it as one undo step.
	import Dialog from '../ui/Dialog.svelte';
	import Button from '../ui/Button.svelte';
	import { copyTargets } from './copy';

	interface Props {
		open: boolean;
		pageCount: number;
		/** 0-based index of the page the stamp is on. */
		current: number;
		what: string;
		oncopy: (indices: number[]) => void;
	}

	let { open = $bindable(false), pageCount, current, what, oncopy }: Props = $props();

	let mode = $state<'all' | 'range'>('all');
	let from = $state('1');
	let to = $state('1');

	$effect(() => {
		if (open) {
			mode = 'all';
			from = '1';
			to = String(pageCount);
		}
	});

	const targets = $derived(copyTargets(pageCount, current, mode, Number(from), Number(to)));
	const uid = Math.random().toString(36).slice(2, 8);

	function go() {
		if (targets.length === 0) return;
		oncopy(targets);
		open = false;
	}
</script>

<Dialog bind:open title="Copy to pages" description={`Put a copy of this ${what} at the same place on other pages.`}>
	<fieldset>
		<legend class="sr">Which pages</legend>
		<label class="opt">
			<input type="radio" name="copy-{uid}" value="all" bind:group={mode} />
			<span>All other pages ({pageCount - 1})</span>
		</label>
		<label class="opt">
			<input type="radio" name="copy-{uid}" value="range" bind:group={mode} />
			<span>Pages</span>
			<input
				class="num"
				type="number"
				inputmode="numeric"
				min="1"
				max={pageCount}
				aria-label="From page"
				bind:value={from}
				onfocus={() => (mode = 'range')}
			/>
			<span>to</span>
			<input
				class="num"
				type="number"
				inputmode="numeric"
				min="1"
				max={pageCount}
				aria-label="To page"
				bind:value={to}
				onfocus={() => (mode = 'range')}
			/>
		</label>
	</fieldset>
	<p class="count" aria-live="polite">
		{targets.length === 0
			? 'No other pages in that range.'
			: `${targets.length} ${targets.length === 1 ? 'page' : 'pages'}, skipping this one.`}
	</p>

	{#snippet actions()}
		<Button variant="quiet" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" disabled={targets.length === 0} onclick={go}>Copy</Button>
	{/snippet}
</Dialog>

<style>
	fieldset {
		border: 0;
		padding: 0;
		margin: 0;
		display: grid;
		gap: var(--s-3);
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.opt {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-height: var(--control-h);
		flex-wrap: wrap;
	}

	input[type='radio'] {
		width: 20px;
		height: 20px;
		accent-color: var(--accent);
	}

	.num {
		width: 5.5em;
		min-height: var(--control-h);
		padding: 0 var(--s-2);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-control);
		background: var(--surface);
		color: var(--ink);
		font: inherit;
		font-variant-numeric: tabular-nums;
	}

	.count {
		margin-top: var(--s-3);
		color: var(--ink-soft);
		font-size: var(--text-caption);
	}
</style>
