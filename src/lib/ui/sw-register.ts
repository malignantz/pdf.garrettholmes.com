import { toasts } from './toasts.svelte';

/**
 * Register the service worker (production builds only) and offer a reload when
 * a new version has installed. The worker waits until the user says so, so a
 * half-finished document is never reloaded out from under them. When `idle`
 * says there is no document open, the new version is taken at once.
 */
export async function registerServiceWorker(idle: () => boolean = () => false) {
	if (!('serviceWorker' in navigator)) return;

	const sw = navigator.serviceWorker;
	let hadController = !!sw.controller;
	let reloading = false;
	let prompted = false;

	sw.addEventListener('controllerchange', () => {
		// The first install claims the page; that is not an update.
		if (!hadController) {
			hadController = true;
			return;
		}
		if (reloading) return;
		reloading = true;
		location.reload();
	});

	const prompt = (worker: ServiceWorker) => {
		if (prompted) return;
		prompted = true;
		if (idle()) {
			worker.postMessage({ type: 'SKIP_WAITING' });
			return;
		}
		toasts.show({
			message: 'A new version is available.',
			timeout: 0,
			action: { label: 'Reload', run: () => worker.postMessage({ type: 'SKIP_WAITING' }) }
		});
	};

	let reg: ServiceWorkerRegistration;
	try {
		reg = await sw.register('/service-worker.js', { type: 'module', scope: '/' });
	} catch (err) {
		console.warn('Service worker registration failed; offline use is unavailable.', err);
		return;
	}

	if (reg.waiting && sw.controller) prompt(reg.waiting);

	reg.addEventListener('updatefound', () => {
		const worker = reg.installing;
		worker?.addEventListener('statechange', () => {
			if (worker.state === 'installed' && sw.controller) prompt(worker);
		});
	});

	// Look for a new version when the user comes back to the tab.
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') reg.update().catch(() => {});
	});
}
