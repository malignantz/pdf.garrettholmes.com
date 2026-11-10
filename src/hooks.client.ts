import type { HandleClientError } from '@sveltejs/kit/hooks';
import { describeError } from '#lib/ui/error-report.ts';

/**
 * SvelteKit replaces a thrown error with `{ message: 'Internal Error' }` before
 * error boundaries see it. Keep the real error alongside, so the app can show it.
 */
export const handleError: HandleClientError = ({ error }) => {
	console.error(error);
	return { detail: describeError(error) };
};
