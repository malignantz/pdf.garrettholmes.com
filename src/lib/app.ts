/**
 * App-wide singletons. The workspace and the page editor both use these, so
 * there is exactly one document store, one engine worker and one renderer.
 */
import { createDocStore, type DocStore } from './doc/store';
import { createEngine, type EngineClient } from './engine/client';
import { createRenderer } from './render/renderer';
import type { Renderer, SourceId } from './core/types';

export interface App {
	store: DocStore;
	engine: EngineClient;
	renderer: Renderer;
	/** Also tell `fn` when a source is released (nothing references it any more). */
	onSourceReleased(fn: (id: SourceId) => void): void;
}

let app: App | undefined;

export function getApp(): App {
	if (!app) {
		const renderer = createRenderer();
		const released = new Set<(id: SourceId) => void>();
		app = {
			renderer,
			engine: createEngine(),
			store: createDocStore({
				onSourceReleased: (id) => {
					renderer.release(id);
					for (const fn of released) fn(id);
				}
			}),
			onSourceReleased: (fn) => void released.add(fn)
		};
	}
	return app;
}
