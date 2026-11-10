<script lang="ts">
	import Dialog from '../ui/Dialog.svelte';

	let { open = $bindable(false) }: { open: boolean } = $props();

	const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
	const mod = mac ? '⌘' : 'Ctrl';

	const groups: { title: string; rows: [string[], string][] }[] = [
		{
			title: 'Pages',
			rows: [
				[['←', '→', '↑', '↓'], 'Move between pages'],
				[['Space'], 'Select or unselect the page'],
				[['Shift', 'Arrow'], 'Extend the selection'],
				[[mod, 'A'], 'Select all'],
				[['Esc'], 'Clear the selection, cancel a drag'],
				[['Enter'], 'Open the page to sign or add text']
			]
		},
		{
			title: 'Arrange',
			rows: [
				[['Alt', 'Arrow'], 'Move selected pages'],
				[['R'], 'Rotate right'],
				[['Shift', 'R'], 'Rotate left'],
				[[mod, 'D'], 'Duplicate'],
				[['Delete'], 'Delete'],
				[[mod, 'Z'], 'Undo'],
				[[mod, 'Shift', 'Z'], 'Redo']
			]
		},
		{
			title: 'Files',
			rows: [
				[[mod, 'O'], 'Add files'],
				[[mod, 'V'], 'Paste files or images'],
				[[mod, 'S'], 'Export'],
				[['?'], 'This list']
			]
		}
	];
</script>

<Dialog bind:open title="Keyboard shortcuts" width="560px">
	<div class="groups">
		{#each groups as g (g.title)}
			<section>
				<h3>{g.title}</h3>
				<dl>
					{#each g.rows as [keys, what] (what)}
						<div class="row">
							<dt>
								{#each keys as k, i (i)}{#if i > 0}<span class="plus">+</span>{/if}<kbd>{k}</kbd>{/each}
							</dt>
							<dd>{what}</dd>
						</div>
					{/each}
				</dl>
			</section>
		{/each}
	</div>
</Dialog>

<style>
	.groups {
		display: grid;
		gap: var(--s-5);
	}

	h3 {
		margin-bottom: var(--s-2);
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--ink-soft);
	}

	dl {
		display: grid;
		gap: 2px;
	}

	.row {
		display: grid;
		grid-template-columns: 9.5rem 1fr;
		gap: var(--s-3);
		align-items: center;
		min-height: 30px;
	}

	dt {
		display: flex;
		align-items: center;
		gap: 3px;
		flex-wrap: wrap;
	}

	dd {
		font-size: var(--text-control);
	}

	kbd {
		display: inline-grid;
		place-items: center;
		min-width: 24px;
		height: 24px;
		padding: 0 6px;
		border: 1px solid var(--line-strong);
		border-bottom-width: 2px;
		border-radius: 5px;
		background: var(--surface);
		font-family: var(--font-sans);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
	}

	.plus {
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}
</style>
