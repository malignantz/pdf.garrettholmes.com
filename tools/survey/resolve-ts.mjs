// ESM resolve hook: a relative specifier with no extension that fails to resolve is
// retried with ".ts" (then "/index.ts"), as Vite resolves the repo's sources.

/**
 * @param {string} specifier
 * @param {object} context
 * @param {(specifier: string, context: object) => Promise<{ url: string }>} next
 */
export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (e) {
		const relative = specifier.startsWith('./') || specifier.startsWith('../');
		if (!relative || /\.[cm]?[jt]s$/.test(specifier)) throw e;
		for (const suffix of ['.ts', '/index.ts']) {
			try {
				return await next(specifier + suffix, context);
			} catch {
				// Try the next one.
			}
		}
		throw e;
	}
}
