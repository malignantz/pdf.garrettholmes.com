import type { EngineErrorCode, EngineErrorShape, VerifyCheck } from '../core/types';

const CODES: readonly EngineErrorCode[] = [
	'password-required',
	'password-wrong',
	'unreadable',
	'unsupported',
	'verification-failed',
	'too-large',
	'cancelled',
	'internal'
];

/** Thrown by the engine. Also satisfies EngineErrorShape, so callers can treat it as one. */
export class EngineError extends Error implements EngineErrorShape {
	readonly code: EngineErrorCode;
	readonly checks?: VerifyCheck[];

	constructor(code: EngineErrorCode, message: string, checks?: VerifyCheck[]) {
		super(message);
		this.name = 'EngineError';
		this.code = code;
		if (checks) this.checks = checks;
	}

	toShape(): EngineErrorShape {
		const shape: EngineErrorShape = { code: this.code, message: this.message };
		if (this.checks) shape.checks = this.checks.map((c) => ({ ...c }));
		return shape;
	}
}

export function isEngineErrorShape(value: unknown): value is EngineErrorShape {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.code === 'string' && CODES.includes(v.code as EngineErrorCode) && typeof v.message === 'string';
}

/** Anything thrown inside the engine becomes a plain EngineErrorShape. */
export function toErrorShape(error: unknown): EngineErrorShape {
	if (error instanceof EngineError) return error.toShape();
	if (isEngineErrorShape(error)) {
		const shape: EngineErrorShape = { code: error.code, message: error.message };
		if (error.checks) shape.checks = error.checks;
		return shape;
	}
	if (isOutOfMemory(error)) {
		return { code: 'too-large', message: 'This file is too large to process on this device.' };
	}
	return { code: 'internal', message: 'Something went wrong inside the PDF engine. Nothing was changed.' };
}

export function fromErrorShape(shape: EngineErrorShape): EngineError {
	return new EngineError(shape.code, shape.message, shape.checks);
}

export function isOutOfMemory(error: unknown): boolean {
	if (error instanceof RangeError) return /memory|allocation|array buffer/i.test(error.message);
	const msg = error instanceof Error ? error.message : String(error);
	return /\bOOM\b|out of memory|Cannot enlarge memory|could not allocate/i.test(msg);
}
