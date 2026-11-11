/** Survey harness: producer families, buckets and trait flattening (tools/survey/lib/traits.ts). */
import { describe, expect, it } from 'vitest';
import { featuresOf, pagesBucket, producerFamily, scriptsIn, sizeBucket, traitsOf, versionBucket, type Profile } from '../../tools/survey/lib/traits';

describe('producerFamily', () => {
	const cases: [string | null, string | null, string][] = [
		['Microsoft® Word for Microsoft 365', 'Microsoft® Word for Microsoft 365', 'word'],
		['Acrobat Distiller 10.1.8 (Windows)', 'Acrobat PDFMaker 10.1 for Word', 'word'],
		['Adobe PDF Library 15.0', 'Adobe InDesign 16.0 (Windows)', 'indesign'],
		['Acrobat Distiller 9.0.0 (Windows)', 'PScript5.dll Version 5.2.2', 'acrobat'],
		['LibreOffice 7.4', 'Writer', 'libreoffice'],
		['Skia/PDF m120', 'Mozilla/5.0 HeadlessChrome/120.0', 'chrome-skia'],
		['pdfTeX-1.40.25', 'LaTeX with hyperref', 'latex'],
		['iTextSharp™ 5.5.13 ©2000-2020 iText Group NV', null, 'itext'],
		['macOS Version 13.4 (Build 22F66) Quartz PDFContext', 'Pages', 'quartz-macos'],
		['GPL Ghostscript 9.54.0', 'dvips(k) 5.998', 'ghostscript'],
		['Canon iR-ADV C5535  PDF', null, 'scanner'],
		['RICOH MP C3004', 'RICOH MP C3004', 'scanner'],
		['Microsoft: Print To PDF', null, 'microsoft-other'],
		['Some Custom Tool 1.0', null, 'other'],
		[null, null, 'unknown'],
		['  ', '', 'unknown']
	];
	for (const [producer, creator, family] of cases) {
		it(`${producer} / ${creator} → ${family}`, () => expect(producerFamily(producer, creator)).toBe(family));
	}
});

describe('buckets', () => {
	it('size', () => {
		expect(sizeBucket(10)).toBe('<100KB');
		expect(sizeBucket(500 * 1024)).toBe('100KB-1MB');
		expect(sizeBucket(5 * 1024 * 1024)).toBe('1-10MB');
		expect(sizeBucket(50 * 1024 * 1024)).toBe('10-100MB');
		expect(sizeBucket(500 * 1024 * 1024)).toBe('>100MB');
	});
	it('pages', () => {
		expect([null, 1, 2, 5, 6, 20, 21, 100, 101, 500, 501].map(pagesBucket)).toEqual(['unknown', '1', '2-5', '2-5', '6-20', '6-20', '21-100', '21-100', '101-500', '101-500', '501+']);
	});
	it('version', () => {
		expect([null, '1.2', '1.3', '1.4', '1.7', '2.0', 'x'].map(versionBucket)).toEqual(['unknown', '<=1.3', '<=1.3', '1.4', '1.7', '2.0', 'unknown']);
	});
	it('scripts ignore a few stray characters', () => {
		expect(scriptsIn('Hello world')).toEqual([]);
		expect(scriptsIn('Area of a circle: π r²; α β')).toEqual([]);
		expect(scriptsIn('Привет, как дела? 東京都の天気は晴れです')).toEqual(['cjk', 'cyrillic']);
	});
});

function profile(over: Partial<Profile> = {}): Profile {
	return {
		sha256: 'a'.repeat(64),
		path: '/x.pdf',
		source: 't',
		size: 2000,
		ms: 1,
		status: 'ok',
		notes: [],
		version: '1.7',
		producer: null,
		creator: null,
		producerFamily: 'unknown',
		pages: 3,
		encryption: 'none',
		linearized: false,
		objectStreams: true,
		xrefStreams: true,
		damage: 'clean',
		form: { acroform: true, xfa: false, signed: false, fields: { text: 2, checkbox: 0, radio: 1, choice: 0, signature: 0, button: 0 } },
		content: { pagesSampled: 3, textPages: 1, imageOnlyPages: 3, textOverImagePages: 0, emptyPages: 0, scripts: ['arabic'] },
		fonts: { total: 2, embedded: 1, notEmbedded: 1, type3: 0, cid: 1 },
		geometry: { mixedSizes: false, rotated: true, cropOffset: false, userUnit: false, veryLarge: false, maxSide: 792 },
		annots: { Link: 3, Squiggly: 1 },
		bookmarks: true,
		attachments: 0,
		layers: false,
		javascript: false,
		tagged: true,
		pdfa: 'PDF/A-2',
		images: { total: 3, jpeg: 0, jpx: 0, jbig2: 1, ccitt: 0, oneBit: 1, cmyk: 0 },
		transparency: { softMask: false, group: true },
		...over
	};
}

describe('traitsOf', () => {
	it('flattens a full profile', () => {
		const t = traitsOf(profile());
		expect(t).toMatchObject({
			size: '<100KB',
			pages: '2-5',
			form: 'acroform',
			'field.text': 'yes',
			'field.radio': 'yes',
			'field.checkbox': 'no',
			content: 'scanned',
			'script.arabic': 'yes',
			nonlatin: 'yes',
			fonts: 'some-embedded',
			cid: 'yes',
			'geom.rotate': 'yes',
			'annot.Link': 'yes',
			'annot.other': 'yes',
			pdfa: 'PDF/A-2',
			'img.jbig2': 'yes',
			transpgroup: 'yes'
		});
	});
	it('marks unmeasured traits unknown and keeps every trait name', () => {
		const full = Object.keys(traitsOf(profile()));
		const bare = traitsOf(profile({ status: 'failed', form: null, content: null, fonts: null, geometry: null, annots: null, images: null, transparency: null, pages: null }));
		expect(Object.keys(bare)).toEqual(full);
		expect(bare.form).toBe('unknown');
		expect(bare.content).toBe('unknown');
		expect(bare['img.jpeg']).toBe('unknown');
		expect(bare.profile).toBe('failed');
	});
	it('features are trait=value strings', () => {
		expect(featuresOf(profile())).toContain('form=acroform');
	});
});
