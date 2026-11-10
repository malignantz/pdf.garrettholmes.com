import { describe, expect, it } from 'vitest';
import type { Asset, PageRef, Rotation, Source, Stamp } from '../../src/lib/core/types';
import { rotateSize } from '../../src/lib/engine/geometry';
import { corpus, engine, manifest, openCorpus, pageSizes, pageTexts, prng, ref } from './helpers';

const PDFS: [string, string?][] = [
	['multi.pdf'],
	['sizes.pdf'],
	['rotated.pdf'],
	['inherited.pdf'],
	['cropbox.pdf'],
	['unbalanced.pdf'],
	['userunit.pdf'],
	['form.pdf'],
	['metadata.pdf'],
	['linearized.pdf'],
	['objstm.pdf'],
	['damaged-xref.pdf'],
	['damaged-streams.pdf'],
	['enc-aes-256.pdf', 'user'],
	['enc-rc4-128.pdf', 'user'],
	['enc-aes-256-owner-only.pdf']
];

const sig: Asset = { id: 'sig', kind: 'signature', png: corpus('signature.png'), width: 240, height: 80 };

/** Label each page of a corpus PDF carries, e.g. "sizes p3"; null for image/blank sources. */
function labelOf(src: Source, pageIndex: number): string | null {
	const meta = manifest[src.name];
	if (!meta || typeof meta.label !== 'string') return null;
	return `${meta.label} p${pageIndex + 1}`;
}

describe('random plans across the corpus', () => {
	it('always verify, keep order, and match planned sizes', async () => {
		const e = engine();
		const sources: Source[] = await Promise.all(PDFS.map(([n, pw]) => openCorpus(n, pw)));
		sources.push(await e.openImage(corpus('photo-exif6.jpg'), 'image/jpeg', 'photo-exif6.jpg'));
		sources.push(await e.openImage(corpus('alpha.png'), 'image/png', 'alpha.png'));
		sources.push(await e.blankPage({ width: 612, height: 792 }));

		const rand = prng(20261109);
		const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
		const ROT: Rotation[] = [0, 90, 180, 270];
		const runs = 30;
		let pagesTotal = 0;
		for (let run = 0; run < runs; run++) {
			const count = 1 + Math.floor(rand() * 14);
			const pages: PageRef[] = [];
			for (let k = 0; k < count; k++) {
				// Sometimes repeat an earlier page (duplicates), otherwise pick a new one.
				if (pages.length && rand() < 0.2) {
					const prev = pick(pages);
					pages.push(ref(sources.find((s) => s.id === prev.sourceId)!, prev.pageIndex, pick(ROT)));
					continue;
				}
				const src = pick(sources);
				const stamps: Stamp[] = [];
				if (rand() < 0.25) {
					const w = 0.1 + rand() * 0.3;
					const h = 0.05 + rand() * 0.2;
					stamps.push({ id: 's', kind: 'image', assetId: 'sig', box: { x: rand() * (1 - w), y: rand() * (1 - h), w, h } });
				}
				if (rand() < 0.2) {
					stamps.push({ id: 't', kind: 'text', text: `Run ${run}`, x: rand() * 0.5, y: rand() * 0.8, size: 0.01 + rand() * 0.04, color: 'blue' });
				}
				if (rand() < 0.2) stamps.push({ id: 'm', kind: 'mark', mark: pick(['check', 'cross', 'dot'] as const), box: { x: 0.4, y: 0.4, w: 0.05, h: 0.05 } });
				pages.push(ref(src, Math.floor(rand() * src.pages.length), pick(ROT), stamps));
			}
			const options = {
				filename: 'x.pdf',
				compress: rand() < 0.5,
				stripMetadata: rand() < 0.3,
				password: rand() < 0.2 ? `pw${run}` : undefined
			};
			const res = await e.exportPlan({ pages, options }, sources, [sig]);
			for (const c of res.checks) expect(c.ok, `run ${run}: ${c.name}: ${c.detail}`).toBe(true);
			expect(res.pageCount).toBe(pages.length);

			const sizes = await pageSizes(res.bytes, options.password);
			const texts = await pageTexts(res.bytes, options.password);
			pages.forEach((p, i) => {
				const src = sources.find((s) => s.id === p.sourceId)!;
				const want = rotateSize(src.pages[p.pageIndex], p.rotation);
				expect(Math.abs(sizes[i].width - want.width), `run ${run} page ${i + 1}`).toBeLessThan(0.5);
				expect(Math.abs(sizes[i].height - want.height), `run ${run} page ${i + 1}`).toBeLessThan(0.5);
				const label = labelOf(src, p.pageIndex);
				if (label) expect(texts[i], `run ${run} page ${i + 1}`).toContain(label);
				const text = p.stamps.find((s) => s.kind === 'text');
				if (text && text.kind === 'text') expect(texts[i]).toContain(text.text);
			});
			pagesTotal += pages.length;
		}
		expect(pagesTotal).toBeGreaterThan(runs);
	}, 180_000);
});
