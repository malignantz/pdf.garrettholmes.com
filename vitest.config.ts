import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Unit tests for the engine, renderer and doc store run in Node. The folders may
// still be empty while those streams are in progress, so an empty run passes.
export default defineConfig({
	plugins: [sveltekit()],
	test: {
		environment: 'node',
		include: ['tests/{engine,render,doc,editor,workspace}/**/*.test.ts'],
		passWithNoTests: true,
		testTimeout: 30_000
	}
});
