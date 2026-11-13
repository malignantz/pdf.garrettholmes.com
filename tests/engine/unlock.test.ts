/**
 * "Remove printing and copying limits": what openPdf reads from an encrypted original's
 * permission flags, the notes it gives, the protection it declines, and that every
 * export of such a file is free of the original's encryption (corpus: generate-unlock.mjs).
 */
import { describe, expect, it } from 'vitest';
import { corpus, defaultOptions, engine, manifest, pageTexts, ref } from './helpers';
import type { EngineErrorShape, ExportOptions, ExportResult, Source, SourceLimits } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { QPDF_ERROR, Qpdf } from '../../src/lib/engine/qpdf';
import { limitWords, openNote, parseLimits, removedLine, unionLimits } from '../../src/lib/engine/limits';
import { nodeAssets } from './helpers';

const T = 30_000;
const qpdf = new Qpdf(nodeAssets().qpdf);

async function rejects(p: Promise<unknown>): Promise<EngineErrorShape> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(EngineError);
		return e as EngineErrorShape;
	}
	throw new Error('expected a rejection');
}

function allOk(res: ExportResult) {
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
}

async function exportAll(src: Source, options: Partial<ExportOptions> = {}) {
	return engine().exportPlan({ pages: src.pages.map((_, i) => ref(src, i)), options: { ...defaultOptions, ...options } }, [src], []);
}

/** No /Encrypt anywhere: not in the trailer (qpdf), not in the bytes. */
async function expectNoEncryption(bytes: Uint8Array) {
	const enc = await qpdf.run({ args: ['--is-encrypted', '/a.pdf'], inputs: { '/a.pdf': bytes } });
	expect(enc.code).toBe(QPDF_ERROR);
	expect(enc.stderr).toBe('');
	const res = await qpdf.run({ args: ['--json-output', '--json-stream-data=none', '/a.pdf', '/a.json'], inputs: { '/a.pdf': bytes }, outputs: ['/a.json'] });
	const objects = JSON.parse(new TextDecoder().decode(res.files.get('/a.json')!)).qpdf[1] as Record<string, { value?: Record<string, unknown> }>;
	expect(objects.trailer.value).not.toHaveProperty('/Encrypt');
	expect(Buffer.from(bytes).toString('latin1')).not.toMatch(/\/Encrypt\b/);
}

type Meta = { R: number; password: string | null; ownerPassword?: string; limits: Omit<SourceLimits, 'password'> };
const LIMITED = Object.entries(manifest).filter(([name, m]) => name.startsWith('unlock-') && 'limits' in m) as [string, Meta][];

describe('unlock corpus', () => {
	it('covers every revision and each limit', () => {
		expect(new Set(LIMITED.map(([, m]) => m.R))).toEqual(new Set([2, 3, 4, 6]));
		for (const k of ['print', 'copy', 'edit', 'fill'] as const) expect(LIMITED.some(([, m]) => m.limits[k])).toBe(true);
		expect(LIMITED.some(([, m]) => !Object.values(m.limits).some(Boolean))).toBe(true);
	});
});

describe('openPdf reads the limits', () => {
	for (const [name, m] of LIMITED) {
		const passwords = m.password === null ? [undefined] : [m.password, m.ownerPassword!];
		for (const pw of passwords) {
			it(`${name}${pw ? ` (with "${pw}")` : ''}: limits, note, export without them`, async () => {
				if (pw) expect((await rejects(engine().openPdf(corpus(name), name))).code).toBe('password-required');
				const src = await engine().openPdf(corpus(name), name, pw);
				expect(src.wasEncrypted).toBe(true);
				expect(src.limits).toEqual({ password: pw !== undefined, ...m.limits });
				expect(src.notes).toContain(openNote(src.limits!, pw !== undefined));
				const label = name.replace(/\.pdf$/, '');
				const before = await pageTexts(corpus(name), pw);
				expect(before[0]).toContain(`${label} p1`);

				const res = await exportAll(src);
				allOk(res);
				await expectNoEncryption(res.bytes);
				expect(await pageTexts(res.bytes)).toEqual(before);
				// No "had a password" warning for a file that opened without one.
				expect(res.warnings.some((w) => /had a password/.test(w))).toBe(pw !== undefined);
			}, T);
		}
	}

	it('opened files carry no limits field when not encrypted', async () => {
		const src = await engine().openPdf(corpus('multi.pdf'), 'multi.pdf');
		expect(src.limits).toBeUndefined();
	}, T);

	it('an export with a new password allows everything', async () => {
		const src = await engine().openPdf(corpus('unlock-aes-256-all.pdf'), 'x');
		const res = await exportAll(src, { password: 'new pass', compress: true });
		allOk(res);
		const shown = await qpdf.run({ args: ['--password=new pass', '--show-encryption', '/a.pdf'], inputs: { '/a.pdf': res.bytes } });
		expect(parseLimits(shown.stdout, true)).toEqual({ password: true, print: false, copy: false, edit: false, fill: false });
		expect(shown.stdout).toMatch(/^R = 6$/m);
		expect(res.checks.find((c) => c.name === 'encryption')!.detail).toMatch(/allows printing, copying and editing/);
		expect(await pageTexts(res.bytes, 'new pass')).toEqual(await pageTexts(corpus('unlock-aes-256-all.pdf')));
	}, T);

	it('the compressed export of a limited file has no encryption either', async () => {
		const src = await engine().openPdf(corpus('unlock-rc4-40-print.pdf'), 'x');
		const res = await exportAll(src, { compress: true, stripMetadata: true });
		allOk(res);
		await expectNoEncryption(res.bytes);
	}, T);
});

describe('openPdf declines what it cannot open honestly', () => {
	const cases: [string, RegExp][] = [
		['unlock-filter-fopn.pdf', /rights-management system, so it cannot be opened here/],
		['unlock-filter-pubsec.pdf', /locked to a digital certificate, so it cannot be opened here/],
		['unlock-pubsec-damaged.pdf', /locked to a digital certificate, so it cannot be opened here/],
		['unlock-standard-r9.pdf', /locked in a way this app does not support/]
	];
	for (const [name, message] of cases) {
		it(name, async () => {
			const e = await rejects(engine().openPdf(corpus(name), name));
			expect(e.code).toBe('unsupported');
			expect(e.message).toMatch(message);
			expect(e.message).not.toMatch(/damaged/);
			// A password does not change that (nothing is guessed or tried).
			expect((await rejects(engine().openPdf(corpus(name), name, 'owner'))).message).toMatch(message);
		}, T);
	}

	it('encrypted and with a broken xref: refused, saying why', async () => {
		const e = await rejects(engine().openPdf(corpus('unlock-damaged-xref.pdf'), 'x'));
		expect(e.code).toBe('unreadable');
		expect(e.message).toBe('This file is damaged, and because it is also locked it cannot be repaired here.');
	}, T);
});

describe('wording', () => {
	const l = (over: Partial<SourceLimits>): SourceLimits => ({ password: false, print: false, copy: false, edit: false, fill: false, ...over });
	it('open notes list only the limits that were set', () => {
		expect(openNote(l({ print: true, copy: true }), false)).toBe('This file had limits on printing and copying. Your export will not have them.');
		expect(openNote(l({ print: true, copy: true, edit: true, fill: true }), false)).toBe(
			'This file had limits on printing, copying, editing and filling in forms. Your export will not have them.'
		);
		expect(openNote(l({}), false)).toBe('This file was locked, though it opens without a password. Your export will not be locked.');
		expect(openNote(null, false)).toBe('This file was locked, though it opens without a password. Your export will not be locked.');
		expect(openNote(l({ password: true, print: true, copy: true }), true)).toBe(
			'Opened with its password. The file also limited printing and copying; your export will not have those limits or a password unless you set one.'
		);
		expect(openNote(l({ password: true }), true)).toBe('Opened with its password. Exports have no password unless you set one.');
	});
	it('the export line joins the limits of all sources', () => {
		expect(removedLine(unionLimits([l({ copy: true }), undefined, l({ print: true })]))).toBe('Printing and copying limits removed.');
		expect(removedLine(unionLimits([l({ fill: true })]))).toBe('Form-filling limits removed.');
		expect(removedLine(unionLimits([l({}), undefined]))).toBeNull();
		expect(limitWords(['edit'])).toBe('editing');
	});
	it('reads qpdf output, and nothing from output without permissions', () => {
		expect(parseLimits('File is not encrypted\n', false)).toBeNull();
		expect(parseLimits('', false)).toBeNull();
	});
});
