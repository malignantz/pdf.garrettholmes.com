/**
 * A pool of Node child processes for work that may hang, blow up memory or crash.
 *
 * - Each child runs `script` with the TypeScript flags this harness needs and a V8 heap cap.
 * - The parent polls each child's resident memory (/proc/<pid>/status) and kills it above
 *   `memMB` (WebAssembly memory is outside the V8 heap, so the heap cap alone is not enough).
 * - Every message from a child (progress or result) restarts its timer; silence for
 *   `timeoutMs` kills it.
 * - A child is replaced after `recycleAfter` jobs, and always after a failure.
 *
 * Protocol (child side: see `serveJobs`): parent → child {type:'job', id, job};
 * child → parent {type:'progress', id, step} | {type:'result', id, data} | {type:'done', id}.
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { surveyDir } from './paths';

export type FailureKind = 'timeout' | 'oom' | 'exit';

export interface PoolOptions<J, R> {
	script: string;
	workers: number;
	memMB: number;
	timeoutMs: number;
	recycleAfter: number;
	onResult(job: J, data: R): void;
	/** Called when a child dies or is killed mid-job. May return a job to queue again (e.g. the remaining steps). */
	onFailure(job: J, kind: FailureKind, detail: string, lastStep: string | null): J | null;
	onDone?(job: J): void;
}

interface Slot<J> {
	child: ChildProcess;
	jobs: number;
	current: { id: number; job: J; step: string | null; timer: NodeJS.Timeout } | null;
	killedFor: FailureKind | null;
	peakKB: number;
}

const MEM_POLL_MS = 250;

export function childExecArgv(heapMB: number): string[] {
	return [
		'--experimental-transform-types',
		'--no-warnings',
		'--import',
		path.join(surveyDir, 'register.mjs'),
		`--max-old-space-size=${heapMB}`
	];
}

export async function runPool<J, R>(jobs: J[], opts: PoolOptions<J, R>): Promise<void> {
	const queue = [...jobs];
	let nextId = 1;
	let active = 0;
	return new Promise((resolveAll) => {
		const slots = new Set<Slot<J>>();
		const memTimer = setInterval(() => {
			for (const s of slots) {
				const kb = rssKB(s.child.pid);
				if (kb > s.peakKB) s.peakKB = kb;
				if (kb > opts.memMB * 1024 && s.current && !s.killedFor) {
					s.killedFor = 'oom';
					s.child.kill('SIGKILL');
				}
			}
		}, MEM_POLL_MS);

		const finishIfIdle = () => {
			if (queue.length === 0 && active === 0) {
				clearInterval(memTimer);
				for (const s of slots) s.child.kill('SIGKILL');
				resolveAll();
			}
		};

		const spawn = (): Slot<J> => {
			const child = fork(opts.script, [], {
				execArgv: childExecArgv(Math.max(256, Math.floor(opts.memMB * 0.6))),
				// A fixed cwd: children must not depend on the caller's folder still existing.
				cwd: surveyDir,
				stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
				serialization: 'advanced'
			});
			let stderrTail = '';
			child.stderr?.on('data', (d: Buffer) => {
				stderrTail = (stderrTail + d.toString()).slice(-2000);
			});
			const slot: Slot<J> = { child, jobs: 0, current: null, killedFor: null, peakKB: 0 };
			slots.add(slot);
			const arm = () => {
				if (!slot.current) return;
				clearTimeout(slot.current.timer);
				slot.current.timer = setTimeout(() => {
					slot.killedFor = 'timeout';
					child.kill('SIGKILL');
				}, opts.timeoutMs);
			};
			child.on('message', (msg: { type: string; id: number; step?: string; data?: R }) => {
				const cur = slot.current;
				if (!cur || msg.id !== cur.id) return;
				if (msg.type === 'progress') {
					cur.step = msg.step ?? null;
					arm();
				} else if (msg.type === 'result') {
					opts.onResult(cur.job, msg.data as R);
					arm();
				} else if (msg.type === 'done') {
					clearTimeout(cur.timer);
					slot.current = null;
					active--;
					opts.onDone?.(cur.job);
					slot.jobs++;
					if (slot.jobs >= opts.recycleAfter) {
						slots.delete(slot);
						child.removeAllListeners('exit');
						child.kill('SIGKILL');
						feed(spawn());
					} else feed(slot);
				}
			});
			child.on('exit', (code, signal) => {
				slots.delete(slot);
				const cur = slot.current;
				if (cur) {
					clearTimeout(cur.timer);
					slot.current = null;
					active--;
					const kind: FailureKind = slot.killedFor ?? (/out of memory|heap limit|Allocation failed/i.test(stderrTail) ? 'oom' : 'exit');
					const detail =
						kind === 'timeout'
							? `no progress for ${Math.round(opts.timeoutMs / 1000)} s`
							: kind === 'oom'
								? `memory above ${opts.memMB} MB (peak RSS ${Math.round(slot.peakKB / 1024)} MB)`
								: `child exited (code ${code}, signal ${signal}): ${lastLine(stderrTail)}`;
					const again = opts.onFailure(cur.job, kind, detail, cur.step);
					if (again) queue.unshift(again);
				}
				if (queue.length) feed(spawn());
				else finishIfIdle();
			});
			return slot;
		};

		const feed = (slot: Slot<J>) => {
			const job = queue.shift();
			if (job === undefined) {
				slots.delete(slot);
				slot.child.removeAllListeners('exit');
				slot.child.kill('SIGKILL');
				finishIfIdle();
				return;
			}
			const id = nextId++;
			active++;
			slot.peakKB = 0;
			slot.current = { id, job, step: null, timer: setTimeout(() => undefined, 0) };
			slot.child.send({ type: 'job', id, job });
			// Arm the timer for this job.
			clearTimeout(slot.current.timer);
			slot.current.timer = setTimeout(() => {
				slot.killedFor = 'timeout';
				slot.child.kill('SIGKILL');
			}, opts.timeoutMs);
		};

		if (queue.length === 0) {
			clearInterval(memTimer);
			resolveAll();
			return;
		}
		for (let i = 0; i < Math.min(opts.workers, queue.length); i++) feed(spawn());
	});
}

function lastLine(s: string): string {
	const lines = s.trim().split('\n').filter((l) => l.trim() && !/^\s+at /.test(l));
	return (lines.at(-1) ?? '').slice(0, 300);
}

function rssKB(pid: number | undefined): number {
	if (!pid) return 0;
	try {
		const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
		return m ? Number(m[1]) : 0;
	} catch {
		return 0;
	}
}

/** Child side: handles jobs one at a time; `handle` reports with `progress` and `result`. */
export function serveJobs<J, R>(
	handle: (job: J, io: { progress(step: string): void; result(data: R): void }) => Promise<void>
) {
	const send = (m: unknown) => process.send?.(m);
	let currentId = 0;
	const die = (e: unknown) => {
		process.stderr.write(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
		process.exit(70);
	};
	process.on('uncaughtException', die);
	process.on('unhandledRejection', die);
	process.on('disconnect', () => process.exit(0));
	process.on('message', async (msg: { type: string; id: number; job: J }) => {
		if (msg.type !== 'job') return;
		currentId = msg.id;
		const id = currentId;
		await handle(msg.job, {
			progress: (step) => send({ type: 'progress', id, step }),
			result: (data) => send({ type: 'result', id, data })
		});
		send({ type: 'done', id });
	});
}
