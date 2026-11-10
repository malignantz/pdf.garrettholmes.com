// The editor harness exists only in dev and in builds made with VITE_DEV_HARNESS=1
// (the end-to-end test build). Production builds neither prerender this page nor
// bundle the harness.
export const prerender = import.meta.env.DEV || import.meta.env.VITE_DEV_HARNESS === '1';
