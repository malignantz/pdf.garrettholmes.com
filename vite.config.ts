import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * Content-Security-Policy. SvelteKit adds a sha256 hash of its inline bootstrap
 * script to `script-src` and writes the policy into each prerendered page as a
 * <meta> tag. `scripts/csp-headers.mjs` (run after `vite build`) reads the same
 * hashes out of the built HTML and writes the identical policy, plus the
 * header-only directives (`frame-ancestors`), into `build/_headers`.
 */
export const cspDirectives = {
	'default-src': ['self'],
	'script-src': ['self', 'wasm-unsafe-eval'],
	'style-src': ['self', 'unsafe-inline'],
	'img-src': ['self', 'blob:', 'data:'],
	'font-src': ['self'],
	'connect-src': ['self'],
	'worker-src': ['self', 'blob:'],
	'manifest-src': ['self'],
	'object-src': ['none'],
	'base-uri': ['self'],
	'form-action': ['none']
} as const;

export default defineConfig({
	// The engine worker code-splits (qpdf, pdf-lib, PDF.js load on demand), which needs ES workers.
	worker: { format: 'es' },
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: '404.html' }),
			csp: {
				mode: 'hash',
				directives: structuredClone(cspDirectives) as never
			},
			// Registered by hand in +layout.svelte so dev never gets a worker and
			// the "new version" toast can drive the update.
			serviceWorker: { register: false }
		})
	]
});
