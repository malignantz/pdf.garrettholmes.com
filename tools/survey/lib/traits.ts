/**
 * Profiles (what `profile` measures about one PDF) and their reduction to
 * categorical traits (what `sample` stratifies on and `report` groups by).
 * Pure functions only; unit-tested in tests/survey/.
 */

export type Encryption = 'none' | 'owner-only' | 'needs-password' | 'unknown';
export type Damage = 'clean' | 'warnings' | 'errors' | 'unknown';

export interface Profile {
	sha256: string;
	path: string;
	source: string;
	size: number;
	ms: number;
	/** ok: every probe ran. partial: some probes failed (see notes). failed: the profiler itself crashed or timed out. */
	status: 'ok' | 'partial' | 'failed';
	error?: string;
	notes: string[];
	version: string | null;
	producer: string | null;
	creator: string | null;
	producerFamily: string;
	pages: number | null;
	encryption: Encryption;
	linearized: boolean | null;
	objectStreams: boolean | null;
	xrefStreams: boolean | null;
	damage: Damage;
	damageDetail?: string;
	form: {
		acroform: boolean;
		xfa: boolean;
		signed: boolean;
		fields: Record<'text' | 'checkbox' | 'radio' | 'choice' | 'signature' | 'button', number>;
	} | null;
	/** Per-page content measured on the first `pagesSampled` pages. */
	content: {
		pagesSampled: number;
		textPages: number;
		/** Pages with little or no text and an image covering most of the page. */
		imageOnlyPages: number;
		/** Pages with text and an image covering most of the page (typically OCR'd scans). */
		textOverImagePages: number;
		emptyPages: number;
		scripts: string[];
	} | null;
	fonts: { total: number; embedded: number; notEmbedded: number; type3: number; cid: number } | null;
	geometry: {
		mixedSizes: boolean;
		rotated: boolean;
		cropOffset: boolean;
		userUnit: boolean;
		veryLarge: boolean;
		/** Longest page side in points (UserUnit applied). */
		maxSide: number;
	} | null;
	annots: Record<string, number> | null;
	bookmarks: boolean | null;
	attachments: number | null;
	layers: boolean | null;
	javascript: boolean | null;
	tagged: boolean | null;
	pdfa: string | null;
	images: { total: number; jpeg: number; jpx: number; jbig2: number; ccitt: number; oneBit: number; cmyk: number } | null;
	transparency: { softMask: boolean; group: boolean } | null;
}

/** Longest side above which a page counts as "very large" (50 in). */
export const VERY_LARGE_SIDE_PT = 3600;
/** Share of page area an image must cover for the page to count as an image page. */
export const IMAGE_PAGE_COVER = 0.6;
/** A page with fewer visible characters than this counts as having no text. */
export const TEXT_PAGE_MIN_CHARS = 20;

const FAMILY_RULES: [string, RegExp][] = [
	// Scanners and copiers first: their PDFs often also name a library.
	[
		'scanner',
		/\b(canon|xerox|ricoh|konica|minolta|kyocera|sharp|brother|epson|lexmark|toshiba|e-studio|fujitsu|scansnap|paperstream|fuji ?xerox|fujifilm|kodak|panasonic|oc[eé]\b|nashuatec|savin|lanier|develop ineo|imagerunner|bizhub|taskalfa|workcentre|versalink|altalink|hp (digital sending|scan|smart)|hp scanjet|naps2|vflat|camscanner|scanner|scan to pdf|genius scan|adobe scan|office lens|abbyy)\b/i
	],
	['latex', /\b(pdftex|luatex|xetex|dvipdfm|dvipdfmx|latex|tex live|miktex|tex output|context|tectonic)\b/i],
	['indesign', /\bindesign\b/i],
	['word', /\b(microsoft(®)? (office )?word|word for (office|mac|microsoft)|winword|pdfmaker[^,;]* for (microsoft )?word|ms word)\b/i],
	[
		'microsoft-other',
		/\b(microsoft(®)? (office )?(excel|powerpoint|publisher|visio|onenote)|microsoft: print to pdf|microsoft reporting|pdfmaker[^,;]* for (excel|powerpoint)|microsoft)\b/i
	],
	['libreoffice', /\b(libreoffice|openoffice|staroffice|neooffice)\b/i],
	['chrome-skia', /\b(skia\/pdf|skia|chromium|google chrome|headlesschrome|google docs renderer)\b/i],
	['quartz-macos', /\b(quartz|quartz pdfcontext|mac ?os( x)?|macintosh|apple|preview)\b/i],
	['itext', /\b(itext|itextsharp|itext®|openpdf|lowagie)\b/i],
	['ghostscript', /\b(ghostscript|artifex|gpl ghostscript|afpl)\b/i],
	['acrobat', /\b(acrobat|distiller|adobe pdf library|adobe pdf|adobe livecycle|adobe experience manager|pdfmaker)\b/i],
	['adobe-other', /\b(adobe|illustrator|photoshop|framemaker)\b/i]
];

/** Producer/creator strings → one family. Creator names the authoring app, so it is tried with the producer as one string. */
export function producerFamily(producer: string | null | undefined, creator: string | null | undefined): string {
	const p = (producer ?? '').trim();
	const c = (creator ?? '').trim();
	if (!p && !c) return 'unknown';
	const both = `${c} ; ${p}`;
	for (const [family, re] of FAMILY_RULES) if (re.test(both)) return family;
	return 'other';
}

export function sizeBucket(bytes: number): string {
	const kb = bytes / 1024;
	if (kb < 100) return '<100KB';
	if (kb < 1024) return '100KB-1MB';
	if (kb < 10 * 1024) return '1-10MB';
	if (kb < 100 * 1024) return '10-100MB';
	return '>100MB';
}

export function pagesBucket(n: number | null): string {
	if (n === null) return 'unknown';
	if (n <= 1) return '1';
	if (n <= 5) return '2-5';
	if (n <= 20) return '6-20';
	if (n <= 100) return '21-100';
	if (n <= 500) return '101-500';
	return '501+';
}

export function versionBucket(v: string | null): string {
	if (!v) return 'unknown';
	const m = /^(\d)\.(\d)/.exec(v);
	if (!m) return 'unknown';
	const n = Number(m[1]) * 10 + Number(m[2]);
	if (n <= 13) return '<=1.3';
	if (n >= 20) return '2.0';
	return `${m[1]}.${m[2]}`;
}

/** Writing systems found in text (Latin is not reported). */
const SCRIPTS: [string, RegExp][] = [
	['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
	['cyrillic', /\p{Script=Cyrillic}/u],
	['greek', /\p{Script=Greek}/u],
	['arabic', /\p{Script=Arabic}/u],
	['hebrew', /\p{Script=Hebrew}/u],
	['indic', /[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Malayalam}]/u],
	['thai', /\p{Script=Thai}/u]
];
/** Fewer characters of a script than this are ignored (stray symbols, math). */
const SCRIPT_MIN_CHARS = 5;

export function scriptsIn(text: string): string[] {
	const found: string[] = [];
	for (const [name, re] of SCRIPTS) {
		const g = new RegExp(re.source, 'gu');
		let n = 0;
		while (g.exec(text) && ++n < SCRIPT_MIN_CHARS);
		if (n >= SCRIPT_MIN_CHARS) found.push(name);
	}
	return found;
}

function yn(v: boolean | null | undefined): string {
	return v === null || v === undefined ? 'unknown' : v ? 'yes' : 'no';
}

/** Annotation subtypes kept as their own trait; others are counted as "other". */
export const ANNOT_KINDS = ['Link', 'Widget', 'Text', 'FreeText', 'Highlight', 'Ink', 'Stamp', 'Square', 'Line', 'Popup', 'FileAttachment', 'Underline', 'StrikeOut', 'Polygon', 'Circle', 'Redact'];

/**
 * Categorical traits of one profile, trait name → value. Every profile gets every
 * trait (unknown when not measured), so pairs are comparable across the pile.
 */
export function traitsOf(p: Profile): Record<string, string> {
	const t: Record<string, string> = {};
	t.profile = p.status;
	t.size = sizeBucket(p.size);
	t.version = versionBucket(p.version);
	t.producer = p.producerFamily;
	t.pages = pagesBucket(p.pages);
	t.encryption = p.encryption;
	t.linearized = yn(p.linearized);
	t.objstm = yn(p.objectStreams);
	t.xrefstm = yn(p.xrefStreams);
	t.damage = p.damage;
	if (p.form) {
		t.form = p.form.xfa ? 'xfa' : p.form.acroform ? 'acroform' : 'none';
		t.signed = yn(p.form.signed);
		for (const k of ['text', 'checkbox', 'radio', 'choice'] as const) t[`field.${k}`] = yn(p.form.fields[k] > 0);
	} else {
		t.form = 'unknown';
		t.signed = 'unknown';
		for (const k of ['text', 'checkbox', 'radio', 'choice']) t[`field.${k}`] = 'unknown';
	}
	if (p.content && p.content.pagesSampled > 0) {
		const c = p.content;
		const n = c.pagesSampled;
		t.content =
			c.emptyPages === n
				? 'empty'
				: c.imageOnlyPages >= n * 0.8
					? 'scanned'
					: c.textOverImagePages >= n * 0.5
						? 'ocr'
						: c.imageOnlyPages > 0 || c.textOverImagePages > 0
							? 'mixed'
							: 'text';
		t.nonlatin = c.scripts.length ? 'yes' : 'no';
		for (const [name] of SCRIPTS) t[`script.${name}`] = yn(c.scripts.includes(name));
	} else {
		t.content = 'unknown';
		t.nonlatin = 'unknown';
		for (const [name] of SCRIPTS) t[`script.${name}`] = 'unknown';
	}
	if (p.fonts) {
		const f = p.fonts;
		t.fonts = f.total === 0 ? 'none' : f.notEmbedded === 0 ? 'all-embedded' : f.embedded === 0 ? 'none-embedded' : 'some-embedded';
		t.type3 = yn(f.type3 > 0);
		t.cid = yn(f.cid > 0);
	} else {
		t.fonts = 'unknown';
		t.type3 = 'unknown';
		t.cid = 'unknown';
	}
	const g = p.geometry;
	t['geom.mixed'] = yn(g?.mixedSizes);
	t['geom.rotate'] = yn(g?.rotated);
	t['geom.cropoffset'] = yn(g?.cropOffset);
	t['geom.userunit'] = yn(g?.userUnit);
	t['geom.verylarge'] = yn(g?.veryLarge);
	for (const k of ANNOT_KINDS) t[`annot.${k}`] = p.annots ? yn((p.annots[k] ?? 0) > 0) : 'unknown';
	t['annot.other'] = p.annots ? yn(Object.keys(p.annots).some((k) => !ANNOT_KINDS.includes(k))) : 'unknown';
	t.bookmarks = yn(p.bookmarks);
	t.attachments = p.attachments === null ? 'unknown' : yn(p.attachments > 0);
	t.layers = yn(p.layers);
	t.javascript = yn(p.javascript);
	t.tagged = yn(p.tagged);
	t.pdfa = p.pdfa ?? 'none';
	const im = p.images;
	t.images = im === null ? 'unknown' : im.total === 0 ? 'none' : 'yes';
	for (const k of ['jpeg', 'jpx', 'jbig2', 'ccitt', 'oneBit', 'cmyk'] as const) t[`img.${k}`] = im === null ? 'unknown' : yn(im[k] > 0);
	t.softmask = yn(p.transparency?.softMask);
	t.transpgroup = yn(p.transparency?.group);
	return t;
}

/** "name=value" features of a profile, the unit the sampler covers. */
export function featuresOf(p: Profile): string[] {
	return Object.entries(traitsOf(p)).map(([k, v]) => `${k}=${v}`);
}
