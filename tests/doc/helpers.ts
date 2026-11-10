import type { Asset, ExportOptions, Source } from '../../src/lib/core/types';
import { createDocStore, type DocState, type DocStore, type DocStoreOptions } from '../../src/lib/doc/store';

export function makeSource(id: string, pageCount: number, name = `${id}.pdf`): Source {
	return {
		id,
		name,
		kind: 'pdf',
		bytes: new Uint8Array(8),
		pages: Array.from({ length: pageCount }, (_, i) => ({ width: 600 + i, height: 800 })),
		originalSize: 1000,
		wasEncrypted: false,
		notes: []
	};
}

export function makeAsset(id: string, kind: Asset['kind'] = 'signature'): Asset {
	return { id, kind, png: new Uint8Array(4), width: 100, height: 40 };
}

export const exportOptions: ExportOptions = {
	filename: 'out.pdf',
	compress: false,
	stripMetadata: false
};

/** Store with deterministic ids p1, p2, ... */
export function makeStore(opts: DocStoreOptions = {}): { store: DocStore; released: string[] } {
	let n = 0;
	const released: string[] = [];
	const store = createDocStore({
		generateId: () => `id${++n}`,
		onSourceReleased: (id) => released.push(id),
		...opts
	});
	return { store, released };
}

export const ids = (s: DocState | DocStore) =>
	('state' in s ? s.state : s).pages.map((p) => p.id);

/** Short page names "a0 a1 b0" (sourceId + pageIndex) in document order. */
export const names = (s: DocStore) => s.state.pages.map((p) => `${p.sourceId}${p.pageIndex}`);

export function docOf(s: DocStore) {
	const st = s.state;
	return { sources: st.sources, pages: st.pages, assets: st.assets };
}

export function checkInvariants(s: DocStore): void {
	const st = s.state;
	const pageIds = new Set(st.pages.map((p) => p.id));
	if (pageIds.size !== st.pages.length) throw new Error('duplicate page ids');
	const srcIds = new Set(st.sources.map((x) => x.id));
	if (srcIds.size !== st.sources.length) throw new Error('duplicate source ids');
	const stampIds = new Set<string>();
	for (const p of st.pages) {
		const src = st.sources.find((x) => x.id === p.sourceId);
		if (!src) throw new Error(`page ${p.id} has no source`);
		if (p.pageIndex < 0 || p.pageIndex >= src.pages.length) throw new Error('pageIndex out of range');
		for (const stamp of p.stamps) {
			if (stampIds.has(stamp.id)) throw new Error('duplicate stamp id');
			stampIds.add(stamp.id);
			if (stamp.kind === 'image' && !st.assets.some((a) => a.id === stamp.assetId))
				throw new Error('stamp references missing asset');
		}
	}
	for (const x of st.sources)
		if (!st.pages.some((p) => p.sourceId === x.id)) throw new Error(`source ${x.id} has no pages`);
	for (const id of st.selection) if (!pageIds.has(id)) throw new Error('selection not subset of pages');
	if (st.anchor !== null && !pageIds.has(st.anchor)) throw new Error('anchor not in pages');
}
