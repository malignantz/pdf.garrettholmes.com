
/**
 * Offline support. Everything the build produced (shell, engine chunks, wasm),
 * the static files and the prerendered pages are cached on install, so after
 * one visit the whole app, engines included, runs with no network.
 *
 * - `shell-<version>`: this version's precache; older ones are deleted on activate.
 * - Requests are served cache-first; anything same-origin that is not in the
 *   precache (rare) is fetched and kept in a runtime cache for next time.
 * - A new version waits until the page asks it to take over (the "Reload" toast).
 */
import { self } from '$app/service-worker';
import { immutable, assets, prerendered } from '$app/manifest';
import { version } from '$app/env';

const SHELL = `shell-${version}`;
const RUNTIME = `runtime-${version}`;

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
			// First install: nothing to replace, so take over at once.
			if (!self.registration.active) await self.skipWaiting();
		})()
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== SHELL && key !== RUNTIME) await caches.delete(key);
			}
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

	const runtime = await caches.open(RUNTIME);
	const cached = await runtime.match(req);
	if (cached) return cached;

	const res = await fetch(req);
	if (res.ok && res.type === 'basic' && url.pathname.startsWith('/_app/immutable/')) {
		await runtime.put(req, res.clone());
	}
	return res;
}
