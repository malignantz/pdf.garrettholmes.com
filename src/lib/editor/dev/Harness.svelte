<script lang="ts">
	// Development and test harness for the page editor, mounted by /dev-editor only in
	// dev and in builds made with VITE_DEV_HARNESS=1 (the e2e build). Loads a corpus
	// fixture and opens the editor on one page:
	//   /dev-editor?file=rotated.pdf&page=2&rotate=90
	// Only works on localhost / 127.0.0.1.
	import { onMount } from 'svelte';
	import { getApp } from '../../app';
	import { useDocStore } from '../../doc/store.svelte';
	import PageCanvas from '../../render/PageCanvas.svelte';
	import PageEditor from '../PageEditor.svelte';
	import StampLayer from '../StampLayer.svelte';
	import type { PageId, Rotation, Source } from '../../core/types';

	// Corpus files, bundled only into this harness chunk.
	const fixtures = import.meta.glob('../../../../tests/corpus/files/*.pdf', { query: '?no-inline', import: 'default', eager: true }) as Record<string, string>;
	const fixtureUrl = (name: string) => Object.entries(fixtures).find(([k]) => k.endsWith(`/${name}`))?.[1];

	const app = getApp();
	const doc = useDocStore(app.store);

	let allowed = $state(false);
	let status = $state('Loading…');
	let editing = $state<PageId | null>(null);

	async function exportPage(index: number, width: number) {
		const store = app.store;
		const plan = store.toExportPlan({ filename: 'harness.pdf', compress: false, stripMetadata: false });
		const res = await app.engine.exportPlan(plan, [...store.state.sources], [...store.state.assets]);
		const sizes = plan.pages.map((p) => store.displayedSize(p)!);
		const src: Source = {
			id: `export-${Date.now()}-${Math.random()}`,
			name: 'export.pdf',
			kind: 'pdf',
			bytes: res.bytes,
			pages: sizes,
			originalSize: res.bytes.length,
			wasEncrypted: false,
			notes: []
		};
		const bmp = await app.renderer.render({ source: src, pageIndex: index, width, rotation: 0 });
		const c = document.createElement('canvas');
		c.width = bmp.width;
		c.height = bmp.height;
		c.getContext('2d')!.drawImage(bmp, 0, 0);
		bmp.close();
		app.renderer.release(src.id);
		return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height, checks: res.checks };
	}

	onMount(() => {
		allowed = ['localhost', '127.0.0.1'].includes(location.hostname);
		if (!allowed) return;
		const q = new URLSearchParams(location.search);
		const file = q.get('file') ?? 'multi.pdf';
		const pageNo = Math.max(1, Number(q.get('page') ?? '1') || 1);
		const rotate = Number(q.get('rotate') ?? '0');
		(window as unknown as { __editor: unknown }).__editor = { store: app.store, engine: app.engine, exportPage };
		(async () => {
			try {
				app.store.reset();
				const url = fixtureUrl(file);
				if (!url) throw new Error(`no fixture ${file}`);
				const res = await fetch(url);
				if (!res.ok) throw new Error(`fixture ${file}: ${res.status}`);
				const src = await app.engine.openPdf(new Uint8Array(await res.arrayBuffer()), file);
				const ids = app.store.addSource(src);
				if (rotate) app.store.rotatePages(ids, rotate as Rotation);
				status = 'Ready';
				if (q.get('open') !== '0') editing = ids[Math.min(pageNo, ids.length) - 1];
			} catch (e) {
				status = `Failed: ${(e as Error).message}`;
			}
		})();
	});
</script>

{#if !allowed}
	<p class="pad">Not available here.</p>
{:else}
	<div class="pad">
		<p data-testid="harness-status">{status}</p>
		<div class="grid">
			{#each doc.state.pages as p, i (p.id)}
				{@const src = doc.state.sources.find((s) => s.id === p.sourceId)}
				{#if src}
					<button type="button" class="thumb" aria-label={`Edit page ${i + 1}`} data-testid="thumb" onclick={() => (editing = p.id)}>
						<div class="sheet-box">
							<PageCanvas source={src} pageIndex={p.pageIndex} rotation={p.rotation} renderer={app.renderer} />
							<StampLayer page={p} assets={doc.state.assets} />
						</div>
						<span>{i + 1}</span>
					</button>
				{/if}
			{/each}
		</div>
	</div>
{/if}

{#if editing}
	<PageEditor pageId={editing} onclose={() => (editing = null)} />
{/if}

<style>
	.pad {
		padding: var(--s-4);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: var(--s-4);
		margin-top: var(--s-4);
	}

	.thumb {
		display: grid;
		gap: var(--s-1);
		justify-items: center;
		font-size: var(--text-caption);
	}

	.sheet-box {
		position: relative;
		width: 100%;
		box-shadow: var(--shadow-page);
	}
</style>
