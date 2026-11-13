/**
 * "About 30 seconds left": a remaining-time estimate for a long job, extrapolated from
 * the measured fraction of its current step. Pure (every call is given the time), so it
 * is tested without a clock.
 *
 * Honest by construction: nothing is said before the job has run `showAfterMs` or while
 * the step gives no fraction, and a step that is not the job's last slow one (its end is
 * not the job's end) is said to be one: "About 30 seconds left for this step". The rate is measured over the latter half of the step so
 * far: a step's start is often quicker than the rest (qpdf's check reads the small
 * objects first), and measured from the start it predicted a 70 s check of 260 photo
 * pages at 46 s after 7 s; over the latter half, 63 s (real: 62 s). The end time is
 * smoothed, and the words are coarse and only move up again when the estimate really
 * grew, so the line does not jump about.
 */

export interface StepSample {
	/** Identifies the step; a new id (or a fraction going back) starts a new measurement. */
	step: string;
	/** 0..1 of the step done. */
	fraction: number;
	/** True when the step's end is about the job's end (nothing slow follows). */
	final: boolean;
}

export interface TimeLeftOptions {
	/** Say nothing before the job has run this long. Default 10 s. */
	showAfterMs?: number;
	/** Measure the step's rate over at least this long. Default 2 s. */
	minStepMs?: number;
	/** ...and over at least this much of it. Default 2%. */
	minFraction?: number;
	/** Weight of each new end-time estimate (exponential smoothing). Default 0.25. */
	smoothing?: number;
}

export const SHOW_AFTER_MS = 10_000;

/** Upper bounds (seconds) of the coarse buckets, in order. */
const BOUNDS = [10, 20, 30, 40, 50, 90, ...Array.from({ length: 58 }, (_, i) => (i + 2) * 60 + 30), Infinity];

/** The words for a number of seconds left (coarse, rounded up within a minute). */
export function describeSeconds(s: number): string {
	return bucketText(bucketOf(s));
}

function bucketOf(s: number): number {
	const i = BOUNDS.findIndex((b) => s <= b);
	return i < 0 ? BOUNDS.length - 1 : i;
}

function bucketText(i: number): string {
	const b = BOUNDS[i];
	if (b <= 10) return 'Less than 10 seconds left';
	if (b <= 50) return `About ${b} seconds left`;
	if (b <= 90) return 'About a minute left';
	if (b === Infinity) return 'More than an hour left';
	return `About ${(b - 30) / 60} minutes left`;
}

export class TimeLeft {
	readonly #start: number;
	readonly #showAfter: number;
	readonly #minStep: number;
	readonly #minFraction: number;
	readonly #alpha: number;
	#step: string | null = null;
	#stepStart = 0;
	/** The step's reports so far, [time, fraction]. */
	#samples: [number, number][] = [];
	#f = 0;
	#final = false;
	#end: number | null = null;
	#shown: number | null = null;

	constructor(start: number, opts: TimeLeftOptions = {}) {
		this.#start = start;
		this.#showAfter = opts.showAfterMs ?? SHOW_AFTER_MS;
		this.#minStep = opts.minStepMs ?? 2_000;
		this.#minFraction = opts.minFraction ?? 0.02;
		this.#alpha = opts.smoothing ?? 0.25;
	}

	/** A progress report (or null: the job is in a step without a fraction). */
	update(now: number, sample: StepSample | null): void {
		if (!sample || !Number.isFinite(sample.fraction)) {
			this.#reset(null, now, 0, false);
			return;
		}
		const f = Math.min(1, Math.max(0, sample.fraction));
		if (sample.step !== this.#step || f < this.#f) {
			this.#reset(sample.step, now, f, sample.final);
			return;
		}
		this.#f = f;
		this.#final = sample.final;
		this.#samples.push([now, f]);
		if (this.#samples.length > 4000) this.#samples = this.#samples.filter((_, i) => i % 2 === 0);
		const elapsed = now - this.#stepStart;
		if (elapsed < this.#minStep) return;
		const [t0, f0] = this.#samples.find(([t]) => t >= this.#stepStart + elapsed / 2) ?? this.#samples[0];
		const gained = f - f0;
		if (gained < this.#minFraction || now <= t0) return;
		const end = now + ((1 - f) * (now - t0)) / gained;
		this.#end = this.#end === null ? end : this.#end + this.#alpha * (end - this.#end);
	}

	/** The line to show now, or null when there is no honest basis for one. */
	text(now: number): string | null {
		if (now - this.#start < this.#showAfter || this.#end === null) return null;
		const left = (this.#end - now) / 1000;
		// Well past the estimate: it no longer means anything.
		if (left < -10) return null;
		let b = bucketOf(Math.max(0, left));
		// Down freely (time passes); up only when the estimate grew clearly past the words shown.
		if (this.#shown !== null && b > this.#shown && left <= BOUNDS[this.#shown] * 1.2) b = this.#shown;
		this.#shown = b;
		return this.#final ? bucketText(b) : `${bucketText(b)} for this step`;
	}

	#reset(step: string | null, now: number, f: number, final: boolean) {
		this.#step = step;
		this.#stepStart = now;
		this.#samples = step === null ? [] : [[now, f]];
		this.#f = f;
		this.#final = final;
		this.#end = null;
		this.#shown = null;
	}
}
