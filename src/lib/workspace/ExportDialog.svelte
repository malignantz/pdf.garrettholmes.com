<script lang="ts">
	import type { EngineErrorShape, ExportResult, PageId, VerifyCheck } from '../core/types';
	import type { DocStore } from '../doc/store';
	import type { EngineClient } from '../engine/client';
	import { isEngineErrorShape } from '../engine/errors';
	import Button from '../ui/Button.svelte';
	import Dialog from '../ui/Dialog.svelte';
	import Field from '../ui/Field.svelte';
	import Icon from '../ui/Icon.svelte';
	import Progress from '../ui/Progress.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import { defaultFilename, formatBytes, normalizeFilename, passwordProblem, plainCheck, plural } from './logic';

	interface Props {
		open: boolean;
		/** 'extract': only `ids` (in document order). */
		mode: 'all' | 'extract';
		ids: readonly PageId[];
		store: DocStore;
		engine: EngineClient;
		/** The user saved or shared the file. */
		onsaved: (info: { filename: string; mode: 'all' | 'extract' }) => void;
		onclose: () => void;
	}

	let { open = $bindable(false), mode, ids, store, engine, onsaved, onclose }: Props = $props();

	type Phase =
		| { kind: 'form' }
		| { kind: 'working' }
		| { kind: 'done'; result: ExportResult; filename: string; inputBytes: number; url: string }
		| { kind: 'failed'; error: EngineErrorShape };

	let phase = $state<Phase>({ kind: 'form' });
	let filename = $state('');
	let compress = $state(true);
	let stripMetadata = $state(false);
	let usePassword = $state(false);
	let password = $state('');
	let confirm = $state('');
	let showPassword = $state(false);
	let touched = $state(false);
	let saved = $state(false);

	const plan = $derived.by(() => {
		const s = store.state;
		const set = new Set(ids);
		const pages = mode === 'extract' ? s.pages.filter((p) => set.has(p.id)) : s.pages;
		const used = new Set(pages.map((p) => p.sourceId));
		const sources = s.sources.filter((x) => used.has(x.id));
		const names = pages
			.map((p) => s.sources.find((x) => x.id === p.sourceId))
			.filter((x) => x && x.kind !== 'blank')
			.map((x) => x!.name);
		return {
			pages,
			count: pages.length,
			inputBytes: sources.reduce((n, x) => n + x.originalSize, 0),
			names,
			encryptedInput: sources.some((x) => x.wasEncrypted)
		};
	});

	// Fresh defaults every time the dialog opens.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			filename = defaultFilename(plan.names, mode);
			phase = { kind: 'form' };
			password = '';
			confirm = '';
			usePassword = false;
			showPassword = false;
			touched = false;
			saved = false;
		}
		if (!open && wasOpen) revoke();
		wasOpen = open;
	});

	const pwError = $derived(usePassword && touched ? passwordProblem(password) : null);
	const confirmError = $derived(
		usePassword && touched && !pwError && confirm !== password ? 'The two passwords do not match.' : null
	);
	const canExport = $derived(plan.count > 0 && (!usePassword || (!passwordProblem(password) && confirm === password)));

	function revoke() {
		if (phase.kind === 'done') URL.revokeObjectURL(phase.url);
	}

	async function run(e?: Event) {
		e?.preventDefault();
		touched = true;
		if (!canExport || phase.kind === 'working') return;
		const name = normalizeFilename(filename);
		filename = name;
		const options = {
			filename: name,
			compress,
			stripMetadata,
			password: usePassword ? password : undefined
		};
		const exportPlan = store.toExportPlan(options, mode === 'extract' ? ids : undefined);
		const inputBytes = plan.inputBytes;
		phase = { kind: 'working' };
		try {
			const s = store.state;
			const result = await engine.exportPlan(exportPlan, [...s.sources], [...s.assets]);
			const blob = new Blob([result.bytes as BlobPart], { type: 'application/pdf' });
			phase = { kind: 'done', result, filename: name, inputBytes, url: URL.createObjectURL(blob) };
		} catch (err) {
			phase = {
				kind: 'failed',
				error: isEngineErrorShape(err)
					? err
					: { code: 'internal', message: 'Something went wrong while building the file. Nothing was saved.' }
			};
		}
	}

	function markSaved() {
		if (phase.kind !== 'done') return;
		saved = true;
		onsaved({ filename: phase.filename, mode });
	}

	function download() {
		if (phase.kind !== 'done') return;
		const a = document.createElement('a');
		a.href = phase.url;
		a.download = phase.filename;
		a.rel = 'noopener';
		document.body.append(a);
		a.click();
		a.remove();
		markSaved();
	}

	type SavePicker = (o: {
		suggestedName: string;
		types: { description: string; accept: Record<string, string[]> }[];
	}) => Promise<{ createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }> }>;

	const picker = typeof window !== 'undefined' ? (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker : undefined;
	const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

	async function saveAs() {
		if (phase.kind !== 'done' || !picker) return;
		const p = phase;
		try {
			const handle = await picker({
				suggestedName: p.filename,
				types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }]
			});
			const w = await handle.createWritable();
			await w.write(new Blob([p.result.bytes as BlobPart], { type: 'application/pdf' }));
			await w.close();
			markSaved();
		} catch (e) {
			if ((e as Error)?.name !== 'AbortError') download();
		}
	}

	const shareFile = $derived.by(() => {
		if (phase.kind !== 'done' || !coarse || typeof navigator.canShare !== 'function') return null;
		const file = new File([phase.result.bytes as BlobPart], phase.filename, { type: 'application/pdf' });
		try {
			return navigator.canShare({ files: [file] }) ? file : null;
		} catch {
			return null;
		}
	});

	async function share() {
		if (!shareFile) return;
		try {
			await navigator.share({ files: [shareFile], title: shareFile.name });
			markSaved();
		} catch {
			// Cancelled; the download button is still there.
		}
	}

	const TITLES: Record<VerifyCheck['name'], string> = {
		structure: 'File structure',
		'page-count': 'Page count',
		'page-sizes': 'Page sizes',
		reopen: 'Opens cleanly',
		encryption: 'Password',
		redaction: 'Redaction',
		forms: 'Form answers',
		numbering: 'Page numbers',
		visual: 'Pages look the same',
		'target-size': 'File size'
	};

	function headline(r: ExportResult): string {
		const opens = r.checks.some((c) => c.name === 'reopen' && c.ok);
		return `Checked: ${plural(r.pageCount, 'page')}${opens ? ', opens cleanly' : ''}.`;
	}

	const title = $derived(
		phase.kind === 'done'
			? 'Your file is ready'
			: phase.kind === 'failed'
				? 'Export stopped'
				: mode === 'extract'
					? `Export ${plural(plan.count, 'selected page')}`
					: 'Export PDF'
	);
</script>

{#snippet checkList(checks: VerifyCheck[], pageCount: number)}
	<ul class="checks">
		{#each checks as c, i (i)}
			<li class:bad={!c.ok}>
				<Icon name={c.ok ? 'check' : 'cross'} size={18} />
				<span>{plainCheck(c, pageCount)}</span>
			</li>
		{/each}
	</ul>
	<details class="details">
		<summary>Details</summary>
		<ul>
			{#each checks as c, i (i)}
				<li><strong>{TITLES[c.name] ?? c.name}:</strong> {c.ok ? 'passed' : 'failed'}. {c.detail}</li>
			{/each}
		</ul>
	</details>
{/snippet}

<Dialog bind:open {title} width="480px" dismissable={phase.kind !== 'working'} {onclose}>
	{#if phase.kind === 'form'}
		<form id="export-form" class="form" onsubmit={run} novalidate>
			<Field label="File name" bind:value={filename} autocomplete="off" spellcheck="false" />

			<div class="toggles">
				<Toggle bind:checked={compress} label="Compress" hint="Lossless: images and text stay exactly as they are." />
				<Toggle bind:checked={stripMetadata} label="Remove metadata" hint="Author, title, dates and editing software." />
				<Toggle bind:checked={usePassword} label="Add a password" hint="Needed to open the file. AES-256." />
			</div>

			{#if usePassword}
				<div class="password">
					<Field
						label="Password"
						type={showPassword ? 'text' : 'password'}
						bind:value={password}
						autocomplete="new-password"
						error={pwError ?? undefined}
						oninput={() => (touched = touched || password.length > 0)}
						onblur={() => (touched = true)}
					/>
					<Field
						label="Confirm password"
						type={showPassword ? 'text' : 'password'}
						bind:value={confirm}
						autocomplete="new-password"
						error={confirmError ?? undefined}
						onblur={() => (touched = true)}
					/>
					<label class="show">
						<input type="checkbox" bind:checked={showPassword} />
						Show passwords
					</label>
					<p class="caption">There is no way to recover a forgotten password. Keep it somewhere safe.</p>
				</div>
			{:else if plan.encryptedInput}
				<p class="note"><Icon name="lock" size={18} />A file you opened had a password. This export will have none unless you add one.</p>
			{/if}

			<p class="summary num">
				{`${plural(plan.count, 'page')}, ${formatBytes(plan.inputBytes)} in`}
			</p>
		</form>
	{:else if phase.kind === 'working'}
		<div class="working" role="status">
			<Progress label="Building and checking your file" />
			<p>Building and checking {plural(plan.count, 'page')}…</p>
			<p class="caption">Every export is re-opened and checked before you can save it.</p>
		</div>
	{:else if phase.kind === 'done'}
		{@const r = phase.result}
		<div class="result" role="status">
			<p class="verified"><span class="seal"><Icon name="check" size={18} /></span>{headline(r)}</p>
			<p class="sizes num">
				{phase.filename}<br />
				<span class="caption io">{formatBytes(phase.inputBytes)} in → {formatBytes(r.bytes.length)} out</span>
			</p>
			{@render checkList(r.checks, r.pageCount)}
			{#if r.warnings.length}
				<ul class="warnings">
					{#each r.warnings as w, i (i)}<li><Icon name="warning" size={18} /><span>{w}</span></li>{/each}
				</ul>
			{/if}
			{#if saved}<p class="caption saved">Saved. You can keep working; nothing here has changed.</p>{/if}
		</div>
	{:else}
		{@const err = phase.error}
		<div class="failed" role="alert">
			<p class="why"><Icon name="warning" />{err.message}</p>
			{#if err.checks?.length}
				{@render checkList(err.checks, plan.count)}
			{/if}
			<p class="caption">No file was made. Your pages are unchanged; you can try again or change the options.</p>
		</div>
	{/if}

	{#snippet actions()}
		{#if phase.kind === 'form'}
			<Button variant="quiet" onclick={() => (open = false)}>Cancel</Button>
			<Button variant="primary" icon="download" type="submit" form="export-form" disabled={plan.count === 0}>Export</Button>
		{:else if phase.kind === 'working'}
			<Button variant="primary" loading>Checking…</Button>
		{:else if phase.kind === 'done'}
			<Button variant="quiet" onclick={() => (open = false)}>{saved ? 'Done' : 'Close'}</Button>
			{#if picker && !coarse}<Button variant="secondary" onclick={saveAs}>Save as…</Button>{/if}
			{#if shareFile}<Button variant="secondary" onclick={share}>Share</Button>{/if}
			<Button variant="primary" icon="download" onclick={download}>Download</Button>
		{:else}
			<Button variant="quiet" onclick={() => (open = false)}>Close</Button>
			<Button variant="primary" onclick={() => (phase = { kind: 'form' })}>Change options</Button>
		{/if}
	{/snippet}
</Dialog>

<style>
	.form,
	.result,
	.failed,
	.working {
		display: grid;
		gap: var(--s-4);
	}

	.toggles {
		display: grid;
		gap: var(--s-3);
		padding: var(--s-3) 0;
		border-block: 1px solid var(--line);
	}

	.password {
		display: grid;
		gap: var(--s-3);
	}

	.show {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--text-caption);
		color: var(--ink-soft);
		width: fit-content;
	}

	.show input {
		width: 16px;
		height: 16px;
		accent-color: var(--ink);
	}

	.note {
		display: flex;
		gap: var(--s-2);
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.note :global(.icon) {
		flex: none;
		margin-top: 1px;
	}

	.summary {
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.working {
		padding: var(--s-3) 0;
	}

	.verified {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		font-family: var(--font-serif);
		font-size: 1.25rem;
		line-height: 1.3;
		color: var(--ink);
	}

	.seal {
		display: grid;
		place-items: center;
		flex: none;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--ok);
		color: var(--surface);
	}

	.sizes {
		overflow-wrap: anywhere;
		font-weight: 550;
	}

	.checks,
	.warnings {
		list-style: none;
		padding: 0;
		display: grid;
		gap: var(--s-2);
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.checks {
		padding: var(--s-3);
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--ok) 7%, transparent);
	}

	.failed .checks {
		background: var(--hover);
	}

	.checks li,
	.warnings li {
		display: flex;
		gap: var(--s-2);
		align-items: flex-start;
	}

	.checks :global(.icon) {
		color: var(--ok);
		margin-top: 0;
	}

	.checks .bad :global(.icon) {
		color: var(--danger);
	}


	.warnings :global(.icon) {
		color: var(--ink-soft);
	}

	.why {
		display: flex;
		gap: var(--s-2);
		font-weight: 550;
	}

	.why :global(.icon) {
		color: var(--danger);
		flex: none;
	}

	.io {
		font-weight: 400;
	}

	.details {
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.details summary {
		width: fit-content;
		cursor: pointer;
		border-radius: 4px;
	}

	.details ul {
		margin-top: var(--s-2);
		padding-left: var(--s-4);
		display: grid;
		gap: var(--s-1);
	}

	.details strong {
		color: var(--ink);
		font-weight: 600;
	}

	.saved {
		color: var(--ok);
	}
</style>
