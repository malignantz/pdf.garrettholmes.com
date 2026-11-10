<script lang="ts">
	import Spinner from '../ui/Spinner.svelte';
	import Icon from '../ui/Icon.svelte';
	import type { Intake } from './intake.svelte';

	let { intake, raised = false }: { intake: Intake; raised?: boolean } = $props();

	const MAX = 4;
	const shown = $derived(intake.jobs.slice(0, MAX));
	const more = $derived(intake.jobs.length - shown.length);
</script>

<div class="intake" class:raised role="status" aria-live="polite">
	{#if intake.jobs.length}
		<ul>
			{#each shown as job (job.id)}
				<li class:waiting={job.status === 'waiting'}>
					{#if job.status === 'password'}
						<Icon name="lock" size={18} />
						<span class="text">Waiting for the password for <b>{job.name}</b></span>
					{:else if job.status === 'opening'}
						<Spinner size={16} />
						<span class="text">
							Opening <b>{job.name}</b>…
							{#if intake.engineCold}<span class="sub">Loading the PDF engine (first time only)</span>{/if}
						</span>
					{:else}
						<span class="dot" aria-hidden="true"></span>
						<span class="text">Waiting: {job.name}</span>
					{/if}
				</li>
			{/each}
			{#if more > 0}<li class="waiting"><span class="dot" aria-hidden="true"></span><span class="text">and {more} more</span></li>{/if}
		</ul>
	{/if}
</div>

<style>
	.intake {
		position: fixed;
		z-index: 40;
		left: calc(var(--s-5) + var(--safe-left));
		bottom: calc(var(--s-5) + var(--safe-bottom));
		max-width: min(360px, calc(100vw - 2 * var(--s-4)));
		pointer-events: none;
	}

	ul {
		list-style: none;
		padding: var(--s-2) var(--s-3);
		display: grid;
		gap: var(--s-1);
		border: 1px solid var(--line);
		border-radius: var(--radius-sheet);
		background: var(--surface);
		box-shadow: var(--shadow-float);
		pointer-events: auto;
	}

	li {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
		min-height: 24px;
		font-size: var(--text-caption);
		line-height: 1.4;
		padding-top: 2px;
	}

	li > :global(.spinner),
	li > :global(.icon) {
		flex: none;
		margin-top: 1px;
	}

	.text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	b {
		font-weight: 600;
	}

	.sub {
		display: block;
		color: var(--ink-soft);
	}

	.waiting {
		color: var(--ink-soft);
	}

	.dot {
		flex: none;
		width: 16px;
		height: 16px;
		display: grid;
		place-items: center;
	}

	.dot::before {
		content: '';
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--line-strong);
	}

	@media (max-width: 599px) {
		.intake {
			left: var(--s-3);
			right: var(--s-3);
			max-width: none;
			bottom: calc(var(--s-3) + var(--safe-bottom));
		}

		.raised {
			bottom: calc(72px + var(--safe-bottom));
		}
	}
</style>
