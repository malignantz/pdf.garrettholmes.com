import type { ExportRun } from './worker';

/**
 * Same outcome: status, code, checks and warnings (the time in check details aside). Not
 * the size: the Optimize stream pass works to time budgets, so under load two runs of the
 * same export can differ in how much they compressed (reported separately).
 */
export function agree(a: ExportRun, b: ExportRun): boolean {
	const norm = (s?: string) => (s ?? '').replace(/\(\d+ ms\)/g, '(ms)');
	return a.status === b.status && a.code === b.code && norm(a.checks) === norm(b.checks) && a.warnings === b.warnings;
}
