/**
 * "Remove printing and copying limits" (2026-11-13): what an encrypted original
 * limited (its permission flags, as qpdf reads them), the plain words for it, and the
 * protection the app declines.
 *
 * The rules: a file that needs a password to open still needs it (the app only ever
 * tries no password, then the one the user types; it never guesses); a file locked
 * only with limits opens, and its export has none of them, because Source.bytes is
 * always decrypted. Security handlers other than the standard password one
 * (certificates, rights-management systems) are declined before anything is decrypted.
 */

import type { SourceLimits } from '../core/types';

type Limit = 'print' | 'copy' | 'edit' | 'fill';
const ORDER: readonly Limit[] = ['print', 'copy', 'edit', 'fill'];
/** As in "This file had limits on printing and copying". */
const NOUN: Record<Limit, string> = { print: 'printing', copy: 'copying', edit: 'editing', fill: 'filling in forms' };
/** As in "Printing and copying limits removed." */
const ADJ: Record<Limit, string> = { print: 'printing', copy: 'copying', edit: 'editing', fill: 'form-filling' };

/**
 * The permissions in `qpdf --show-encryption` (or `--check`) output, or null when the
 * output has none (not encrypted, or qpdf could not read them). A limit is set when
 * qpdf says "not allowed" for any of its flags:
 *   print: print low or high resolution
 *   copy:  extract for any purpose
 *   edit:  modify other, modify document assembly, modify annotations (comments)
 *   fill:  modify forms
 */
export function parseLimits(stdout: string, password: boolean): SourceLimits | null {
	const flags = new Map<string, boolean>();
	for (const m of stdout.matchAll(/^([a-z ]+): (allowed|not allowed)\s*$/gm)) flags.set(m[1].trim(), m[2] === 'allowed');
	const known = ['print low resolution', 'print high resolution', 'extract for any purpose', 'modify other', 'modify document assembly', 'modify annotations', 'modify forms'];
	if (!known.every((k) => flags.has(k))) return null;
	const denied = (...keys: string[]) => keys.some((k) => flags.get(k) === false);
	return {
		password,
		print: denied('print low resolution', 'print high resolution'),
		copy: denied('extract for any purpose'),
		edit: denied('modify other', 'modify document assembly', 'modify annotations'),
		fill: denied('modify forms')
	};
}

/** The limits that are set, in a fixed order. */
export function limitsSet(l: Pick<SourceLimits, Limit> | undefined): Limit[] {
	return l ? ORDER.filter((k) => l[k]) : [];
}

/** Several sources' limits together. */
export function unionLimits(list: readonly (Pick<SourceLimits, Limit> | undefined)[]): Limit[] {
	return ORDER.filter((k) => list.some((l) => l?.[k]));
}

function join(words: string[]): string {
	return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "printing and copying" */
export function limitWords(limits: readonly Limit[]): string {
	return join(limits.map((k) => NOUN[k]));
}

/** The note shown when an encrypted file opens. `limits` null: encrypted, flags unreadable. */
export function openNote(limits: SourceLimits | null, withPassword: boolean): string {
	const set = limitsSet(limits ?? undefined);
	if (withPassword) {
		return set.length
			? `Opened with its password. The file also limited ${limitWords(set)}; your export will not have those limits or a password unless you set one.`
			: 'Opened with its password. Exports have no password unless you set one.';
	}
	return set.length
		? `This file had limits on ${limitWords(set)}. Your export will not have them.`
		: 'This file was locked, though it opens without a password. Your export will not be locked.';
}

/** The export result's line: "Printing and copying limits removed.", or null when no source had limits. */
export function removedLine(limits: readonly Limit[]): string | null {
	if (!limits.length) return null;
	const words = join(limits.map((k) => ADJ[k]));
	return `${words[0].toUpperCase()}${words.slice(1)} limits removed.`;
}

export const CERTIFICATE_MESSAGE = 'This file is locked to a digital certificate, so it cannot be opened here.';
export const RIGHTS_MESSAGE = 'This file is protected by a rights-management system, so it cannot be opened here.';
export const UNKNOWN_LOCK_MESSAGE = 'This file is locked in a way this app does not support, so it cannot be opened here.';
export const DAMAGED_LOCK_MESSAGE = 'This file’s lock is damaged, so it cannot be opened here.';
export const DAMAGED_LOCKED_MESSAGE = 'This file is damaged, and because it is also locked it cannot be repaired here.';

/**
 * Protection qpdf will not open (its error after `--decrypt`), as the message to show, or
 * null when the error is something else. Only the standard password handler is read:
 * certificate security (/Adobe.PubSec) and other handlers (FileOpen, LiveCycle Rights
 * Management, ...) give qpdf's "unsupported encryption filter"; the name is looked up
 * next to the offset qpdf reports, to tell certificates from the rest.
 */
export function declinedMessage(stderr: string, bytes: Uint8Array): string | null {
	if (/unsupported encryption filter/i.test(stderr)) {
		const at = Number(/encryption dictionary, offset (\d+)/.exec(stderr)?.[1] ?? NaN);
		const near = Number.isFinite(at) ? latin1(bytes, at - 4096, at + 4096) : '';
		return /\/Adobe\.PubSec\b/.test(near) ? CERTIFICATE_MESSAGE : RIGHTS_MESSAGE;
	}
	if (/Unsupported \/R or \/V in encryption dictionary/i.test(stderr)) return UNKNOWN_LOCK_MESSAGE;
	if (/encryption dictionary|\/Encrypt|encryption key|\/Perms field/i.test(stderr)) return DAMAGED_LOCK_MESSAGE;
	return null;
}

/** Whether a file qpdf could not read names an /Encrypt dictionary (its trailer sits near either end). */
export function mentionsEncrypt(bytes: Uint8Array): boolean {
	const span = 1 << 20;
	return /\/Encrypt\b/.test(latin1(bytes, bytes.length - span, bytes.length)) || /\/Encrypt\b/.test(latin1(bytes, 0, span));
}

function latin1(bytes: Uint8Array, from: number, to: number): string {
	const a = Math.max(0, from);
	const b = Math.min(bytes.length, to);
	let s = '';
	for (let i = a; i < b; i += 8192) s += String.fromCharCode(...bytes.subarray(i, Math.min(b, i + 8192)));
	return s;
}
