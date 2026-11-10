<script lang="ts">
	// Hidden review page for the UI kit: every component, light and dark side by side. Not linked.
	import {
		ActionBar,
		Button,
		Dialog,
		Field,
		Icon,
		IconButton,
		Mark,
		Menu,
		Progress,
		Sheet,
		Slider,
		Spinner,
		Toggle,
		Tooltip,
		icons,
		toasts,
		type IconName
	} from '#lib/ui/index.ts';

	const names = Object.keys(icons) as IconName[];

	let dialogOpen = $state<string | null>(null);
	let sheetOpen = $state<string | null>(null);
	let loading = $state(false);
	let password = $state('');
	let compress = $state(true);
	let strip = $state(false);
	let size = $state(3);
	let progress = $state(0.62);

	function fakeLoad() {
		loading = true;
		setTimeout(() => (loading = false), 1600);
	}

	function undoToast() {
		toasts.show({ message: '2 pages deleted.', action: { label: 'Undo', run: () => toasts.show('Restored 2 pages.') } });
	}
</script>

<svelte:head>
	<title>UI kit · pdf.garrettholmes.com</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#snippet showcase(theme: 'light' | 'dark')}
	<section class="panel" data-theme={theme} aria-label="{theme} theme">
		<h2 class="theme-name">{theme}</h2>

		<div class="group">
			<h3>Buttons</h3>
			<div class="row">
				<Button variant="primary" icon="download">Export</Button>
				<Button>Cancel</Button>
				<Button variant="quiet" icon="add">Add pages</Button>
				<Button variant="danger" icon="trash">Delete 3 pages</Button>
			</div>
			<div class="row">
				<Button variant="primary" {loading} onclick={fakeLoad}>{loading ? 'Checking…' : 'Place'}</Button>
				<Button variant="primary" size="lg" icon="add">Choose files</Button>
				<Button disabled>Disabled</Button>
			</div>
		</div>

		<div class="group">
			<h3>Icon buttons, tooltip, menu</h3>
			<div class="row">
				<IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" />
				<IconButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" />
				<IconButton icon="rotate-left" label="Rotate left" />
				<IconButton icon="rotate-right" label="Rotate right" shortcut="R" />
				<IconButton icon="grid-size" label="Grid size" variant="secondary" />
				<IconButton icon="select" label="Select pages" pressed={true} />
				<Menu
					label="More actions"
					items={[
						{ label: 'Duplicate', icon: 'duplicate', hint: 'Ctrl+D', onselect: () => toasts.show('Duplicated.') },
						{ label: 'Extract pages', icon: 'extract', onselect: () => toasts.show('Extract.') },
						{ label: 'Insert blank page', icon: 'blank-page', onselect: () => toasts.show('Blank page.') },
						{ label: 'Add a password', icon: 'lock', onselect: () => toasts.show('Password.') },
						'separator',
						{ label: 'Delete', icon: 'trash', hint: 'Del', danger: true, onselect: undoToast }
					]}
				/>
				<Menu
					label="Add"
					icon="add"
					showLabel
					align="start"
					items={[
						{ label: 'PDF or image', icon: 'file', onselect: () => {} },
						{ label: 'Signature', icon: 'sign', onselect: () => {} },
						{ label: 'Text', icon: 'text', onselect: () => {} },
						{ label: 'Date (disabled)', icon: 'text', disabled: true, onselect: () => {} }
					]}
				/>
			</div>
			<div class="row">
				<Tooltip text="Pages are checked with qpdf before you can download.">
					{#snippet children(attrs)}
						<button class="text-link" type="button" {...attrs}>What does “checked” mean?</button>
					{/snippet}
				</Tooltip>
			</div>
		</div>

		<div class="group">
			<h3>Icons</h3>
			<ul class="icons">
				{#each names as n (n)}
					<li><Icon name={n} /><span>{n}</span></li>
				{/each}
			</ul>
		</div>

		<div class="group">
			<h3>Fields</h3>
			<div class="stack">
				<Field label="File name" value="contract-signed.pdf" hint="The .pdf ending is added for you." />
				<Field
					label="Password"
					type="password"
					bind:value={password}
					error={password.length > 0 && password.length < 4 ? 'Use at least 4 characters.' : undefined}
					placeholder="Type at least 4 characters"
				/>
				<Field label="Page range" value="1-3, 9" error="Page 9 does not exist. This file has 8 pages." />
			</div>
		</div>

		<div class="group">
			<h3>Toggles and slider</h3>
			<div class="stack">
				<Toggle bind:checked={compress} label="Compress" hint="Lossless: images and text are untouched." />
				<Toggle bind:checked={strip} label="Remove metadata" />
				<Toggle checked={false} disabled label="Disabled option" />
				<Slider bind:value={size} min={1} max={6} label="Thumbnail size" valueText={(v) => `Size ${v} of 6`}>
					{#snippet before()}<Icon name="grid-size" size={16} />{/snippet}
					{#snippet after()}<Icon name="grid-size" />{/snippet}
				</Slider>
			</div>
		</div>

		<div class="group">
			<h3>Progress and status</h3>
			<div class="stack">
				<div class="row"><Spinner /> <span class="caption">Opening scan.pdf…</span></div>
				<Progress value={progress} label="Exporting" showLabel />
				<Progress label="Loading the PDF engine" showLabel />
				<p class="verified"><Icon name="check" /> Checked: 12 pages, opens cleanly.</p>
				<p class="warn"><Icon name="warning" /> This file is damaged. Try saving it again from the app that made it.</p>
				<div class="row"><span class="page-chip chip">p. 12</span><span class="caption num">2.4 MB · 12 pages</span></div>
			</div>
		</div>

		<div class="group">
			<h3>Dialog, sheet, toast</h3>
			<div class="row">
				<Button onclick={() => (dialogOpen = theme)}>Open dialog</Button>
				<Button onclick={() => (sheetOpen = theme)}>Open sheet</Button>
				<Button variant="quiet" onclick={undoToast}>Toast with Undo</Button>
				<Button
					variant="quiet"
					onclick={() => toasts.show({ message: 'Checked: 12 pages, opens cleanly.', tone: 'ok' })}>Success toast</Button
				>
				<Button
					variant="quiet"
					onclick={() =>
						toasts.show({ message: 'This file needs a password. Type it to open the file.', tone: 'error' })}
					>Error toast</Button
				>
			</div>
		</div>

		<div class="group">
			<h3>Action bar</h3>
			<ActionBar label="Page actions" mode="static">
				{#snippet status()}3 selected{/snippet}
				<IconButton icon="rotate-left" label="Rotate left" />
				<IconButton icon="rotate-right" label="Rotate right" />
				<IconButton icon="duplicate" label="Duplicate" />
				<IconButton icon="extract" label="Extract" />
				<IconButton icon="trash" label="Delete" />
			</ActionBar>
		</div>

		<div class="group">
			<h3>Mark and page</h3>
			<div class="row">
				<Mark size={48} />
				<Mark size={24} />
				<div class="page-demo" aria-hidden="true"></div>
			</div>
		</div>

		<Dialog
			open={dialogOpen === theme}
			onclose={() => (dialogOpen = null)}
			title="Export"
			description="Your file is built, checked, then offered for download."
		>
			<div class="stack">
				<Field label="File name" value="combined.pdf" />
				<Toggle bind:checked={compress} label="Compress" />
				<Toggle bind:checked={strip} label="Remove metadata" />
			</div>
			{#snippet actions()}
				<Button onclick={() => (dialogOpen = null)}>Cancel</Button>
				<Button variant="primary" icon="download" onclick={() => (dialogOpen = null)}>Export</Button>
			{/snippet}
		</Dialog>

		<Sheet open={sheetOpen === theme} onclose={() => (sheetOpen = null)} title="Page 4">
			<div class="sheet-actions">
				<Button variant="quiet" icon="rotate-right">Rotate</Button>
				<Button variant="quiet" icon="duplicate">Duplicate</Button>
				<Button variant="quiet" icon="extract">Extract</Button>
				<Button variant="quiet" icon="trash">Delete</Button>
			</div>
		</Sheet>
	</section>
{/snippet}

<div class="kit">
	<header class="intro">
		<h1>UI kit</h1>
		<p class="caption">Every shared component, light and dark. This page is for review and is not linked.</p>
	</header>
	<div class="panels">
		{@render showcase('light')}
		{@render showcase('dark')}
	</div>
</div>

<style>
	.kit {
		padding: var(--s-5) var(--s-4) var(--s-7);
	}

	.intro {
		max-width: 1400px;
		margin: 0 auto var(--s-5);
	}

	h1 {
		font-family: var(--font-serif);
		font-weight: 500;
		font-size: 2rem;
	}

	.panels {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 560px), 1fr));
		gap: var(--s-4);
		max-width: 1400px;
		margin: 0 auto;
	}

	.panel {
		border: 1px solid var(--line);
		border-radius: var(--radius-sheet);
		padding: var(--s-5);
		display: grid;
		gap: var(--s-6);
		align-content: start;
	}

	.theme-name {
		font-size: var(--text-caption);
		color: var(--ink-soft);
		font-weight: 600;
	}

	.group {
		display: grid;
		gap: var(--s-3);
	}

	h3 {
		font-size: var(--text-control);
		font-weight: 600;
		padding-bottom: var(--s-2);
		border-bottom: 1px solid var(--line);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}

	.stack {
		display: grid;
		gap: var(--s-4);
		max-width: 380px;
	}

	.icons {
		list-style: none;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
		gap: var(--s-2);
	}

	.icons li {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: var(--s-3) var(--s-1);
		border-radius: var(--radius-control);
		background: var(--surface);
	}

	.icons span {
		font-size: 11px;
		color: var(--ink-soft);
	}

	.text-link {
		font-size: var(--text-control);
		text-decoration: underline;
		text-decoration-color: var(--line-strong);
		text-underline-offset: 0.2em;
		min-height: var(--control-h);
	}

	.verified,
	.warn {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--text-control);
	}

	.verified {
		color: var(--ok);
		font-weight: 550;
	}

	.warn :global(.icon) {
		color: var(--accent);
	}

	.page-chip {
		display: inline-block;
		padding: 2px 6px;
		border-radius: 4px;
		background: var(--ink);
		color: var(--surface);
	}

	.page-demo {
		width: 64px;
		aspect-ratio: 1 / 1.414;
		background: var(--sheet);
		border-radius: var(--radius-page);
		box-shadow: var(--shadow-page);
		margin-left: var(--s-4);
	}

	.sheet-actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-2);
	}

	.sheet-actions :global(.btn) {
		justify-content: flex-start;
	}
</style>
