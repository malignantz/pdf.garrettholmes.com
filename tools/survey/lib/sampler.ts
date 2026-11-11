/**
 * Stratified sample by greedy coverage. Pure; unit-tested in tests/survey/.
 *
 * Units to cover: every feature ("trait=value") and every pair of features of
 * different traits that occur in the pile. Each unit wants min(k, count in pile)
 * files. Lazy greedy: repeatedly take the file with the best
 *   (uncovered demand it meets) / cost(size)
 * where cost grows with the log of the size, so small files win ties and near-ties.
 * Gains only shrink as files are taken, so stale heap entries are re-scored on pop.
 * Slots left after coverage is met (or cannot improve) are filled by a seeded
 * shuffle of the remaining eligible files, smaller first within equal draws.
 */

export interface SampleItem {
	id: string;
	size: number;
	features: string[];
}

export interface SampleOptions {
	target: number;
	k: number;
	maxBytes: number;
	seed: number;
	/** Cover pairs as well as single features (default true). */
	pairs?: boolean;
}

export interface SampleResult {
	ids: string[];
	/** feature → [count in pile, count in sample] */
	coverage: Record<string, [number, number]>;
	/** Pairs that wanted more files than the sample holds (only when the target ran out). */
	pairsShort: number;
	pairsTotal: number;
	excludedTooLarge: number;
}

/** Deterministic PRNG (mulberry32), same as tests/engine/helpers.ts. */
export function prng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Larger files cost more: 1 for anything up to 256 KB, +1 per factor of 4 above. */
export function sizeCost(bytes: number): number {
	return 1 + Math.max(0, Math.log(Math.max(bytes, 1) / 262_144) / Math.log(4));
}

export function sample(items: SampleItem[], opts: SampleOptions): SampleResult {
	const usePairs = opts.pairs ?? true;
	const eligible = items.filter((it) => it.size <= opts.maxBytes);
	// Stable order independent of input order: by id.
	eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	// Feature ids; trait name of each feature (pairs need different traits).
	const featId = new Map<string, number>();
	const traitOf: number[] = [];
	const traitId = new Map<string, number>();
	const fileFeats: Int32Array[] = eligible.map((it) => {
		const ids = new Set<number>();
		for (const f of it.features) {
			let id = featId.get(f);
			if (id === undefined) {
				id = featId.size;
				featId.set(f, id);
				const trait = f.slice(0, Math.max(0, f.indexOf('=')));
				let t = traitId.get(trait);
				if (t === undefined) traitId.set(trait, (t = traitId.size));
				traitOf.push(t);
			}
			ids.add(id);
		}
		return Int32Array.from([...ids].sort((a, b) => a - b));
	});
	const F = featId.size;

	// Units: feature u (0..F-1) and pair F + a*F + b (a < b, different traits).
	const unitsOf = (k: number): Int32Array => {
		const f = fileFeats[k];
		const out: number[] = Array.from(f);
		if (usePairs) {
			for (let i = 0; i < f.length; i++)
				for (let j = i + 1; j < f.length; j++) if (traitOf[f[i]] !== traitOf[f[j]]) out.push(F + f[i] * F + f[j]);
		}
		return Int32Array.from(out);
	};
	const pileCount = new Int32Array(F + F * F);
	const fileUnits: Int32Array[] = [];
	for (let k = 0; k < eligible.length; k++) {
		const u = unitsOf(k);
		fileUnits.push(u);
		for (const x of u) pileCount[x]++;
	}
	const demand = pileCount.map((c) => Math.min(opts.k, c));

	const gain = (k: number) => {
		let g = 0;
		for (const u of fileUnits[k]) if (demand[u] > 0) g++;
		return g / sizeCost(eligible[k].size);
	};

	// Max-heap of [score, -size, index] (ties: smaller file, then lower index).
	const rand = prng(opts.seed);
	const tieBreak = eligible.map(() => rand());
	type Entry = { score: number; k: number };
	const better = (a: Entry, b: Entry) =>
		a.score !== b.score
			? a.score > b.score
			: eligible[a.k].size !== eligible[b.k].size
				? eligible[a.k].size < eligible[b.k].size
				: tieBreak[a.k] < tieBreak[b.k];
	const heap: Entry[] = [];
	const push = (e: Entry) => {
		heap.push(e);
		let i = heap.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!better(heap[i], heap[p])) break;
			[heap[i], heap[p]] = [heap[p], heap[i]];
			i = p;
		}
	};
	const pop = (): Entry | undefined => {
		const top = heap[0];
		const last = heap.pop();
		if (heap.length && last) {
			heap[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < heap.length && better(heap[l], heap[m])) m = l;
				if (r < heap.length && better(heap[r], heap[m])) m = r;
				if (m === i) break;
				[heap[i], heap[m]] = [heap[m], heap[i]];
				i = m;
			}
		}
		return top;
	};
	for (let k = 0; k < eligible.length; k++) push({ score: gain(k), k });

	const chosen: number[] = [];
	const taken = new Set<number>();
	while (chosen.length < opts.target && heap.length) {
		const e = pop()!;
		const fresh = gain(e.k);
		if (fresh <= 0) continue; // nothing left for this file to cover; drop it
		if (heap.length && fresh < e.score && better(heap[0], { score: fresh, k: e.k })) {
			push({ score: fresh, k: e.k });
			continue;
		}
		chosen.push(e.k);
		taken.add(e.k);
		for (const u of fileUnits[e.k]) if (demand[u] > 0) demand[u]--;
	}
	// Fill: seeded shuffle of the rest.
	if (chosen.length < opts.target) {
		const rest = eligible.map((_, k) => k).filter((k) => !taken.has(k));
		rest.sort((a, b) => tieBreak[a] - tieBreak[b]);
		for (const k of rest) {
			if (chosen.length >= opts.target) break;
			chosen.push(k);
			for (const u of fileUnits[k]) if (demand[u] > 0) demand[u]--;
		}
	}

	const coverage: Record<string, [number, number]> = {};
	for (const [f, id] of featId) coverage[f] = [pileCount[id], 0];
	for (const it of items) if (it.size > opts.maxBytes) for (const f of it.features) (coverage[f] ??= [0, 0])[0]++;
	const names = [...featId.keys()];
	for (const k of chosen) for (const id of fileFeats[k]) coverage[names[id]][1]++;
	let pairsShort = 0;
	let pairsTotal = 0;
	for (let u = F; u < pileCount.length; u++) {
		if (pileCount[u] === 0) continue;
		pairsTotal++;
		if (demand[u] > 0) pairsShort++;
	}
	return {
		ids: chosen.map((k) => eligible[k].id),
		coverage,
		pairsShort,
		pairsTotal,
		excludedTooLarge: items.length - eligible.length
	};
}
