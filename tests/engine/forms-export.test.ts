/**
 * Forms at export: answers written with real appearances, flattening, how qpdf's
 * page assembly is mapped back to source fields, refusals, and the 'forms' check.
 */
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { Asset, EngineErrorShape, ExportOptions, ExportResult, FormValues, PageRef, Source, Stamp } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { CALC_WARNING, FORMAT_WARNING } from '../../src/lib/engine/forms';
import { corpus, defaultOptions, engine, loadPdfjs, openCorpus, pageTexts, ref } from './helpers';

const T = 60_000;

function run(pages: PageRef[], sources: Source[], formValues: FormValues, options: Partial<ExportOptions> = {}, assets: Asset[] = []) {
	return engine().exportPlan({ pages, options: { ...defaultOptions, ...options }, formValues }, sources, assets);
}

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
	const bad = res.checks.filter((c) => !c.ok);
	expect(bad).toEqual([]);
	const forms = res.checks.filter((c) => c.name === 'forms');
	expect(forms).toHaveLength(1);
	return forms[0].detail;
}

interface Read {
	page: number;
	name: string;
	type: string;
	value: string;
	as: string | null;
	/** Text the widget's appearance draws, whitespace removed. */
	shown: string;
	rect: number[];
}

/** Every widget of the file as MuPDF reads it. */
function readBack(bytes: Uint8Array, password?: string): Read[] {
	const doc = new mupdf.PDFDocument(bytes);
	if (password !== undefined) doc.authenticatePassword(password);
	const out: Read[] = [];
	for (let i = 0; i < doc.countPages(); i++) {
		for (const w of doc.loadPage(i).getWidgets()) {
			const o = w.getObject();
			const as = o.get('AS');
			const st = w.toDisplayList().toStructuredText('preserve-whitespace');
			const r = o.get('Rect');
			out.push({
				page: i,
				name: w.getName(),
				type: w.getFieldType(),
				value: w.getValue(),
				as: as.isName() ? as.asName() : null,
				shown: st.asText().replace(/\s+/g, ''),
				rect: [0, 1, 2, 3].map((k) => r.get(k).asNumber())
			});
		}
	}
	return out;
}

/** PDF.js view of each page's widgets. */
async function pdfjsWidgets(bytes: Uint8Array, password?: string) {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), password, verbosity: 0 });
	const doc = await task.promise;
	const out: { page: number; fieldName: string; fieldValue: unknown; buttonValue?: unknown; exportValue?: unknown }[] = [];
	try {
		for (let i = 1; i <= doc.numPages; i++) {
			for (const a of (await (await doc.getPage(i)).getAnnotations()) as { subtype: string; fieldName: string; fieldValue: unknown }[]) {
				if (a.subtype === 'Widget') out.push({ page: i - 1, ...a });
			}
		}
	} finally {
		await task.destroy();
	}
	return out;
}

const KINDS_ANSWERS = {
	name: 'Grace Hopper',
	notes: 'First line\nSecond line, a little longer',
	zip: '80202',
	code: 'AB12',
	agree: false,
	opt_in: true,
	color: 'blue',
	size: 'M',
	shared: 'On both pages',
	'person.first': 'Grace',
	'person.last': 'Hopper',
	country: ['us']
};

describe('filling every kind (not flattened)', () => {
	it('writes values and appearances that MuPDF and PDF.js read back', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const res = await run([ref(src, 0), ref(src, 1)], [src], { [src.id]: KINDS_ANSWERS });
		expect(allOk(res)).toBe('12 form answers saved and read back.');
		expect(res.warnings).toEqual([]);

		const w = readBack(res.bytes);
		const one = (name: string, page = 0) => w.find((x) => x.name === name && x.page === page)!;
		expect(one('name')).toMatchObject({ value: 'Grace Hopper', shown: 'GraceHopper' });
		expect(one('notes')).toMatchObject({ value: KINDS_ANSWERS.notes, shown: KINDS_ANSWERS.notes.replace(/\s+/g, '') });
		expect(one('code').shown).toBe('AB12');
		expect(one('ro')).toMatchObject({ value: 'Fixed' });
		expect(one('agree').as).toBe('Off');
		expect(one('opt_in').as).toBe('On');
		expect(w.filter((x) => x.name === 'color').map((x) => x.as)).toEqual(['Off', 'Off', '2']);
		// The 'size' group is split by qpdf into one field per page; each copy shows the answer.
		expect(w.filter((x) => x.name.startsWith('size')).map((x) => [x.page, x.as])).toEqual([
			[0, 'Off'],
			[0, 'M'],
			[1, 'Off']
		]);
		expect(w.filter((x) => x.name.startsWith('shared')).map((x) => [x.page, x.value, x.shown])).toEqual([
			[0, 'On both pages', 'Onbothpages'],
			[1, 'On both pages', 'Onbothpages']
		]);
		// Combo: export value stored, label drawn.
		expect(one('country', 1)).toMatchObject({ value: 'us', shown: 'UnitedStates' });

		const pj = await pdfjsWidgets(res.bytes);
		const p = (name: string) => pj.find((x) => x.fieldName === name)!;
		expect(p('name').fieldValue).toBe('Grace Hopper');
		expect(p('opt_in').fieldValue).toBe('On');
		expect(pj.filter((x) => x.fieldName === 'color').map((x) => x.fieldValue)).toEqual(['blue', 'blue', 'blue']);
		expect(p('country').fieldValue).toEqual(['us']);
		expect(p('person.last').fieldValue).toBe('Hopper');
	}, T);

	it('leaves no /NeedAppearances behind and draws what it asked viewers to draw', async () => {
		const src = await openCorpus('forms-needapp.pdf');
		const res = await run([ref(src, 0)], [src], { [src.id]: { empty: 'Now filled' } });
		allOk(res);
		const doc = new mupdf.PDFDocument(res.bytes);
		expect(doc.getTrailer().get('Root').get('AcroForm').get('NeedAppearances').isNull()).toBe(true);
		const w = readBack(res.bytes);
		expect(w.map((x) => [x.name, x.shown])).toEqual([
			['filled', 'Setbyascript'],
			['empty', 'Nowfilled']
		]);
	}, T);

	it('answers equal to the file’s own values change nothing and still read back', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const res = await run([ref(src, 0), ref(src, 1)], [src], { [src.id]: { name: 'Ada Lovelace', ro: 'Fixed', langs: ['English', 'German'] } });
		expect(allOk(res)).toBe('3 form answers saved and read back.');
		// Nothing was written, so the assembled file passed through the stage untouched.
		expect(readBack(res.bytes).find((x) => x.name === 'name')!.shown).toBe('AdaLovelace');
	}, T);
});

describe('flattening', () => {
	it('bakes every widget into the page and removes the form', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const res = await run([ref(src, 0), ref(src, 1)], [src], { [src.id]: KINDS_ANSWERS }, { flattenForms: true });
		expect(allOk(res)).toMatch(/^Form fields turned into page content; \d+ typed answers found on the page\.$/);
		expect(readBack(res.bytes)).toEqual([]);
		const doc = new mupdf.PDFDocument(res.bytes);
		expect(doc.getTrailer().get('Root').get('AcroForm').isNull()).toBe(true);
		expect(await pdfjsWidgets(res.bytes)).toEqual([]);
		const [p1, p2] = (await pageTexts(res.bytes)).map((t) => t.replace(/\s+/g, ''));
		for (const s of ['GraceHopper', 'Firstline', '80202', 'Fixed', 'Onbothpages']) expect(p1).toContain(s);
		for (const s of ['Grace', 'Hopper', 'UnitedStates', 'Onbothpages', 'English']) expect(p2).toContain(s);
		// Unsigned signature field, hidden and NoView widgets draw nothing.
		expect(p2).not.toMatch(/SIGN/i);
	}, T);

	it('drops widgets whose appearance has an empty /BBox instead of baking them (MuPDF would scale them to infinity)', async () => {
		const src = await openCorpus('forms-calc.pdf');
		const res = await run([ref(src, 0)], [src], { [src.id]: { qty: '4' } }, { flattenForms: true });
		allOk(res);
		const doc = new mupdf.PDFDocument(res.bytes);
		const raw = new TextDecoder('latin1').decode(doc.saveToBuffer('decompress').asUint8Array());
		expect(raw).not.toMatch(/\d{30}/);
	}, T);

	it('flattens untouched forms too (no answers)', async () => {
		const src = await openCorpus('form.pdf');
		const res = await run([ref(src, 0), ref(src, 1)], [src], {}, { flattenForms: true });
		expect(allOk(res)).toBe('Form fields turned into page content; 0 typed answers found on the page.');
		expect(readBack(res.bytes)).toEqual([]);
		expect((await pageTexts(res.bytes))[0]).toContain('Ada Lovelace');
	}, T);
});

describe('mapping assembled pages back to source fields', () => {
	it('a page used twice shows the answer on both copies', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const res = await run([ref(src, 0), ref(src, 0, 90)], [src], { [src.id]: { name: 'Twice', color: 'red' } });
		expect(allOk(res)).toBe('2 form answers saved and read back.');
		const w = readBack(res.bytes);
		expect(w.filter((x) => x.name.startsWith('name')).map((x) => [x.page, x.value, x.shown])).toEqual([
			[0, 'Twice', 'Twice'],
			[1, 'Twice', 'Twice']
		]);
		expect(w.filter((x) => x.name.startsWith('color')).map((x) => x.as)).toEqual(['0', 'Off', 'Off', '0', 'Off', 'Off']);
	}, T);

	it('two byte-identical sources keep their own answers', async () => {
		const a = await engine().openPdf(corpus('forms-kinds.pdf'), 'a.pdf');
		const b = await engine().openPdf(corpus('forms-kinds.pdf'), 'b.pdf');
		const res = await run([ref(a, 0), ref(b, 0), ref(a, 1), ref(b, 1)], [a, b], {
			[a.id]: { name: 'From A', size: 'L', agree: false },
			[b.id]: { name: 'From B', size: 'S' }
		});
		expect(allOk(res)).toBe('5 form answers saved and read back.');
		const w = readBack(res.bytes);
		expect(w.filter((x) => x.name.startsWith('name')).map((x) => [x.page, x.value])).toEqual([
			[0, 'From A'],
			[1, 'From B']
		]);
		expect(w.filter((x) => x.name.startsWith('agree')).map((x) => [x.page, x.as])).toEqual([
			[0, 'Off'],
			[1, 'Yes']
		]);
		expect(w.filter((x) => x.name.startsWith('size')).map((x) => [x.page, x.as])).toEqual([
			[0, 'Off'],
			[0, 'Off'],
			[1, 'S'],
			[1, 'Off'],
			[2, 'L'],
			[3, 'Off']
		]);
	}, T);

	it('a plan with only page 2 of a 2-page form; answers for page-1 fields are left out', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const res = await run([ref(src, 1)], [src], { [src.id]: { size: 'L', shared: 'Page two', name: 'Not exported' } });
		expect(allOk(res)).toBe('2 form answers saved and read back.');
		const w = readBack(res.bytes);
		expect(w.find((x) => x.name === 'size')!.as).toBe('L');
		expect(w.find((x) => x.name === 'shared')!.shown).toBe('Pagetwo');
		expect(w.some((x) => x.name === 'name')).toBe(false);
	}, T);

	it('a plan whose pages carry no answered field still verifies', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const res = await run([ref(src, 1)], [src], { [src.id]: { name: 'Only on page 1' } });
		expect(allOk(res)).toBe('No form answers fall on the exported pages.');
	}, T);

	it('rotated pages and offset CropBoxes, with and without extra rotation', async () => {
		const src = await openCorpus('forms-geometry.pdf');
		const answers = { t1: 'Ninety', t2: 'One eighty', t3: 'Offset', t4: 'Two seventy', c1: true, c2: true, c3: true, c4: true };
		for (const flattenForms of [false, true]) {
			const res = await run([ref(src, 0), ref(src, 1, 90), ref(src, 2, 180), ref(src, 3, 270)], [src], { [src.id]: answers }, { flattenForms });
			allOk(res);
			if (!flattenForms) {
				const w = readBack(res.bytes);
				expect(w.filter((x) => x.type === 'text').map((x) => x.shown)).toEqual(['Ninety', 'Oneeighty', 'Offset', 'Twoseventy']);
				expect(w.filter((x) => x.type === 'checkbox').map((x) => x.as)).toEqual(['Yes', 'Yes', 'Yes', 'Yes']);
			} else {
				const texts = (await pageTexts(res.bytes)).map((t) => t.replace(/\s+/g, ''));
				expect(texts).toEqual([
					expect.stringContaining('Ninety'),
					expect.stringContaining('Oneeighty'),
					expect.stringContaining('Offset'),
					expect.stringContaining('Twoseventy')
				]);
			}
		}
	}, T);
});

describe('with other export features', () => {
	it('form and stamps on the same page', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const sig: Asset = { id: 'sig', kind: 'signature', png: corpus('signature.png'), width: 240, height: 80 };
		const stamps: Stamp[] = [
			{ id: 't', kind: 'text', text: 'Stamped', x: 0.5, y: 0.05, size: 0.02, color: 'blue' },
			{ id: 'm', kind: 'mark', mark: 'check', box: { x: 0.6, y: 0.1, w: 0.05, h: 0.04 } },
			{ id: 'i', kind: 'image', assetId: 'sig', box: { x: 0.5, y: 0.8, w: 0.3, h: 0.1 } }
		];
		for (const flattenForms of [false, true]) {
			const res = await run([ref(src, 0, 0, stamps)], [src], { [src.id]: { name: 'With stamps', agree: false } }, { flattenForms }, [sig]);
			allOk(res);
			const text = (await pageTexts(res.bytes))[0];
			expect(text).toContain('Stamped');
			if (flattenForms) expect(text).toContain('With stamps');
			else expect(readBack(res.bytes).find((x) => x.name === 'name')!.shown).toBe('Withstamps');
		}
	}, T);

	it('a password-protected export', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const res = await run([ref(src, 0), ref(src, 1)], [src], { [src.id]: { name: 'Secret', country: ['ca'], opt_in: true } }, { password: 'pw1', compress: true });
		expect(allOk(res)).toBe('3 form answers saved and read back.');
		expect(res.checks.find((c) => c.name === 'encryption')!.ok).toBe(true);
		const w = readBack(res.bytes, 'pw1');
		expect(w.find((x) => x.name === 'name')!.value).toBe('Secret');
		expect((await pdfjsWidgets(res.bytes, 'pw1')).find((x) => x.fieldName === 'opt_in')!.fieldValue).toBe('On');
	}, T);

	it('an encrypted source, flattened and not', async () => {
		const src = await openCorpus('forms-enc.pdf', 'form');
		for (const flattenForms of [false, true]) {
			const res = await run([ref(src, 0)], [src], { [src.id]: { name: 'From an encrypted file' } }, { flattenForms });
			allOk(res);
			expect((await pageTexts(res.bytes))[0].includes('From an encrypted file')).toBe(flattenForms);
		}
	}, T);
});

describe('calculated and formatted fields', () => {
	it('warns that totals were not recalculated and formats not applied', async () => {
		const src = await openCorpus('forms-calc.pdf');
		const qty = await run([ref(src, 0)], [src], { [src.id]: { qty: '3' } });
		allOk(qty);
		expect(qty.warnings).toEqual([CALC_WARNING]);
		const price = await run([ref(src, 0)], [src], { [src.id]: { price: '12.5', date: '2026-11-10' } });
		allOk(price);
		expect(price.warnings).toEqual([CALC_WARNING, FORMAT_WARNING]);
		expect(readBack(price.bytes).find((x) => x.name === 'price')!.shown).toBe('12.5');
	}, T);

	it('refuses a changed computed total, accepts it unchanged', async () => {
		const src = await openCorpus('forms-calc.pdf');
		const e = await rejects(run([ref(src, 0)], [src], { [src.id]: { total: '99.00' } }));
		expect(e.code).toBe('unsupported');
		expect(e.message).toMatch(/total/);
		allOk(await run([ref(src, 0)], [src], { [src.id]: { total: '20.00' } }));
	}, T);
});

describe('refusals with a plain message', () => {
	const cases: [string, Record<string, unknown>, RegExp][] = [
		['unknown field', { nosuch: 'x' }, /no form field named “nosuch”/],
		['wrong type for text', { name: true }, /not the right kind of value/],
		['wrong type for checkbox', { agree: 'yes' }, /not the right kind of value/],
		['maxLength', { zip: '123456' }, /at most 5 characters/],
		['comb maxLength', { code: '1234567' }, /at most 6 characters/],
		['newline in a single-line field', { name: 'a\nb' }, /single line/],
		['characters the font cannot show', { name: 'Ωμέγα' }, /cannot show these characters: Ω μ έ γ α/],
		['control characters', { name: 'a\u0007b' }, /invisible characters/],
		['radio option that does not exist', { color: 'purple' }, /“purple” is not one of the choices/],
		['choice value that does not exist', { country: ['United States'] }, /“United States” is not one of the choices/],
		['two choices in a combo box', { country: ['us', 'ca'] }, /only one choice/],
		['read-only field changed', { ro: 'Changed' }, /cannot be changed/],
		['list box changed', { langs: ['French'] }, /cannot be changed/],
		['signature field', { sig: 'x' }, /no form field named “sig”/],
		['text that does not fit', { name: 'This answer is much too long to fit in a box only two hundred points wide' }, /does not fit in its box/],
		['too many lines', { notes: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine' }, /does not fit in its box/]
	];
	for (const [what, values, message] of cases) {
		it(what, async () => {
			const src = await openCorpus('forms-kinds.pdf');
			const e = await rejects(run([ref(src, 0), ref(src, 1)], [src], { [src.id]: values as never }));
			expect(e.code).toBe('unsupported');
			expect(e.message).toMatch(message);
		}, T);
	}

	it('answers for an XFA form', async () => {
		const src = await openCorpus('forms-xfa.pdf');
		const e = await rejects(run([ref(src, 0)], [src], { [src.id]: { name: 'x' } }));
		expect(e.code).toBe('unsupported');
		expect(e.message).toMatch(/XFA/);
	}, T);
});

describe('MuPDF drawing, checked by rendering', () => {
	it('comb fields put one character in each cell', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const res = await run([ref(src, 0)], [src], { [src.id]: { code: 'XY7' } });
		allOk(res);
		const doc = new mupdf.PDFDocument(res.bytes);
		const w = doc.loadPage(0).getWidgets().find((x) => x.getName() === 'code')!;
		const [x0, , x1] = w.getRect();
		const cell = (x1 - x0) / 6;
		const centers: number[] = [];
		w.toDisplayList()
			.toStructuredText('preserve-whitespace')
			.walk({ onChar: (c: string, _o: unknown, _f: unknown, _s: unknown, q: number[]) => c.trim() && centers.push((q[0] + q[2]) / 2) });
		expect(centers.map((c) => Math.floor((c - x0) / cell))).toEqual([0, 1, 2]);
		// Each glyph is drawn: the cell has dark pixels.
		const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
		const px = pix.getPixels();
		const [, y0, , y1] = w.getRect();
		for (let k = 0; k < 3; k++) {
			let dark = 0;
			for (let y = Math.ceil(y0 + 3); y < y1 - 3; y++) {
				for (let x = Math.ceil(x0 + k * cell + 3); x < x0 + (k + 1) * cell - 3; x++) {
					if (px[(y * pix.getWidth() + x) * 3] < 128) dark++;
				}
			}
			expect(dark).toBeGreaterThan(5);
		}
	}, T);

	it('every WinAnsi character is drawn with one standard font and extracts back', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		let all = '';
		for (let c = 0x21; c < 0x7f; c++) all += String.fromCharCode(c);
		for (let c = 0xa1; c <= 0xff; c++) if (c !== 0xad) all += String.fromCharCode(c);
		all += '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
		// Three characters per line keeps it inside the multiline box at its fixed size.
		const lines: string[] = [];
		const chars = [...all];
		for (let i = 0; i < chars.length; i += 24) lines.push(chars.slice(i, i + 24).join(' '));
		const page = (k: number) => lines.slice(k * 4, k * 4 + 4).join('\n');
		for (let k = 0; k * 4 < lines.length; k++) {
			const res = await run([ref(src, 0)], [src], { [src.id]: { notes: page(k) } });
			allOk(res);
			expect(readBack(res.bytes).find((x) => x.name === 'notes')!.shown).toBe(page(k).replace(/\s+/g, ''));
		}
	}, T);
});

describe('every fillable text field of every corpus form', () => {
	const FILES: [string, string?][] = [['form.pdf'], ['forms-kinds.pdf'], ['forms-calc.pdf'], ['forms-geometry.pdf'], ['forms-needapp.pdf'], ['forms-enc.pdf', 'form']];
	for (const [name, password] of FILES) {
		it(name, async () => {
			const src = await openCorpus(name, password);
			const fields = (await engine().formFields(src)).filter((f) => f.kind === 'text' && !f.readOnly);
			expect(fields.length).toBeGreaterThan(0);
			const values = Object.fromEntries(fields.map((f, i) => [f.name, `T${i}`.slice(0, f.maxLength ?? 99)]));
			const pages = src.pages.map((_, i) => ref(src, i));
			for (const flattenForms of [false, true]) allOk(await run(pages, [src], { [src.id]: values }, { flattenForms }));
		}, T);
	}
});
