
/**
 * Offline support. Everything the build produced (shell, engine chunks, wasm),
 * the static files and the prerendered pages are cached on install, so after
 * one visit the whole app, engines included, runs with no network.
 *
 * - `shell-<version>`: this version's precache; older ones are deleted on activate.
 * - Requests are served cache-first. A build file that is not precached is fetched
 *   on first use and kept in `lazy` for next time. That is how MuPDF (~10 MB wasm,
 *   listed in /_app/lazy.json) is handled: not downloaded at install, offline once
 *   used. Build files have content-hashed names, so `lazy` survives updates; on
 *   activate it is pruned to the files the new build still lists as lazy.
 * - A new version waits until the page asks it to take over (the "Reload" toast).
 */
import { self } from '$app/service-worker';
import { immutable, assets, prerendered } from '$app/manifest';
import { version } from '$app/env';

const SHELL = `shell-${version}`;
const LAZY = 'lazy';
const LAZY_LIST = '/_app/lazy.json';

// Manifest paths are relative to the base path ('' is the home page).
const skip = new Set(['_headers', 'robots.txt']);
const precache = [
	...immutable.map((f) => f.path),
	...assets.map((f) => f.path).filter((p) => !skip.has(p.replace(/^\//, ''))),
	...prerendered.map((f) => f.path)
].map((p) => (p.startsWith('/') ? p : `/${p}`));

const precacheSet = new Set(precache);

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(SHELL);
			await cache.addAll(precache);
			// Worker chunks and assets (engine, wasm, fonts) are not in SvelteKit's
			// manifest; the build lists them in /_app/precache.json.
			try {
				const res = await fetch('/_app/precache.json', { cache: 'no-store' });
				const extra = ((await res.json()) as string[]).filter((p) => !precacheSet.has(p));
				await cache.addAll(extra);
				for (const p of extra) precacheSet.add(p);
			} catch {
				// Older build without the list: those files are cached on first use instead.
			}
			// Kept for activate, which prunes the lazy cache against it.
			try {
				await cache.add(new Request(LAZY_LIST, { cache: 'no-store' }));
			} catch {
				// No list: activate keeps the lazy cache as it is.
			}
			// First install: nothing to replace, so take over at once.
			if (!self.registration.active) await self.skipWaiting();
		})()
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== SHELL && key !== LAZY) await caches.delete(key);
			}
			await pruneLazy();
			await self.clients.claim();
		})()
	);
});

self.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
	// Sent by a tab with no document open. Another tab may hold one, and taking
	// over would reload it, so only do it when that tab is the only one.
	if (event.data?.type === 'SKIP_WAITING_IF_ALONE') {
		event.waitUntil(
			self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
				if (all.length <= 1) return self.skipWaiting();
			})
		);
	}
});

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;

	event.respondWith(respond(req, url));
});

async function respond(req: Request, url: URL): Promise<Response> {
	const shell = await caches.open(SHELL);

	if (precacheSet.has(url.pathname) || url.pathname.startsWith('/_app/immutable/')) {
		const hit = await shell.match(url.pathname);
		if (hit) return hit;
	}

	// Navigations to a route that was not prerendered: serve the cached app
	// shell and let the client router take it from there.
	if (req.mode === 'navigate') {
		try {
			return await fetch(req);
		} catch {
			return (
				(await shell.match(url.pathname)) ??
				(await shell.match('/')) ??
				new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })
			);
		}
	}

	const lazy = await caches.open(LAZY);
	const cached = await lazy.match(url.pathname);
	if (cached) return cached;

	const res = await fetch(req);
	if (res.ok && res.status === 200 && res.type === 'basic' && url.pathname.startsWith('/_app/immutable/')) {
		await lazy.put(url.pathname, res.clone());
	}
	return res;
}

/** Drop lazily cached build files the current build no longer uses. */
async function pruneLazy(): Promise<void> {
	try {
		const listed = await (await caches.open(SHELL)).match(LAZY_LIST);
		if (!listed) return;
		const keep = new Set((await listed.json()) as string[]);
		const lazy = await caches.open(LAZY);
		for (const req of await lazy.keys()) {
			if (!keep.has(new URL(req.url).pathname)) await lazy.delete(req);
		}
	} catch {
		// Pruning is housekeeping; never block activation on it.
	}
}
