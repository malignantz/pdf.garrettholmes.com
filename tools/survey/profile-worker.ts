/**
 * Child process for `profile`: measures one PDF. Uses the engine's own qpdf.wasm
 * (structure, encryption, object dump) and poppler (pdfinfo, pdftotext, pdfimages)
 * as a second, native reader. Every probe is guarded; a failed probe leaves its
 * traits null and adds a note.
 */
import fs from 'node:fs';
import { qpdf } from './lib/engine';
import { serveJobs } from './lib/pool';
import { shortError, tool } from './lib/common';
import {
	IMAGE_PAGE_COVER,
	TEXT_PAGE_MIN_CHARS,
	VERY_LARGE_SIDE_PT,
	producerFamily,
	scriptsIn,
	type Profile
} from './lib/traits';

export interface ProfileJob {
	path: string;
	sha256: string;
	size: number;
	source: string;
}

/** Per-page probes (text, images) look at this many leading pages. */
const PAGES_SAMPLED = 50;
const TOOL_TIMEOUT_MS = 60_000;
/** Raw byte scans are skipped above this size. */
const RAW_SCAN_MAX = 300 * 1024 * 1024;

type Obj = { value?: unknown; stream?: { dict?: Record<string, unknown> } };
type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

serveJobs<ProfileJob, Profile>(async (job, io) => {
	io.result(await profile(job, io.progress));
});

async function profile(job: ProfileJob, progress: (s: string) => void): Promise<Profile> {
	const started = Date.now();
	const notes: string[] = [];
	const p: Profile = {
		sha256: job.sha256,
		path: job.path,
		source: job.source,
		size: job.size,
		ms: 0,
		status: 'ok',
		notes,
		version: null,
		producer: null,
		creator: null,
		producerFamily: 'unknown',
		pages: null,
		encryption: 'unknown',
		linearized: null,
		objectStreams: null,
		xrefStreams: null,
		damage: 'unknown',
		form: null,
		content: null,
		fonts: null,
		geometry: null,
		annots: null,
		bookmarks: null,
		attachments: null,
		layers: null,
		javascript: null,
		tagged: null,
		pdfa: null,
		images: null,
		transparency: null
	};
	const bytes = new Uint8Array(fs.readFileSync(job.path));

	// Poppler runs in its own processes, in parallel with qpdf below.
	const info = tool('pdfinfo', ['-f', '1', '-l', String(PAGES_SAMPLED), job.path], TOOL_TIMEOUT_MS);
	const meta = tool('pdfinfo', ['-meta', job.path], TOOL_TIMEOUT_MS);
	const text = tool('pdftotext', ['-l', String(PAGES_SAMPLED), '-enc', 'UTF-8', job.path, '-'], TOOL_TIMEOUT_MS);
	const imgs = tool('pdfimages', ['-list', '-l', String(PAGES_SAMPLED), job.path], TOOL_TIMEOUT_MS);

	// Header and raw scans.
	const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
	p.version = /%PDF-(\d\.\d)/.exec(head)?.[1] ?? null;
	if (bytes.length <= RAW_SCAN_MAX) {
		const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
		p.objectStreams = /\/Type\s*\/ObjStm\b/.test(raw);
		p.xrefStreams = /\/Type\s*\/XRef\b/.test(raw);
		const aid = /pdfaid:part\s*(?:=\s*["'](\d)["']|>\s*(\d)\s*<)/.exec(raw);
		if (aid) p.pdfa = `PDF/A-${aid[1] ?? aid[2]}`;
	}

	// qpdf: encryption, structure, linearization.
	progress('qpdf-encryption');
	const q = qpdf();
	const enc = await q.run({ args: ['--requires-password', '/in.pdf'], inputs: { '/in.pdf': bytes } });
	// This qpdf build reports a needed password as exit 2 with "invalid password".
	p.encryption = enc.code === 0 || /invalid password/i.test(enc.stderr) ? 'needs-password' : enc.code === 3 ? 'owner-only' : enc.code === 2 && !enc.stderr.trim() ? 'none' : 'unknown';
	if (p.encryption !== 'needs-password') {
		progress('qpdf-check');
		const check = await q.run({ args: ['--check', '/in.pdf'], inputs: { '/in.pdf': bytes } });
		p.damage = check.code === 0 ? 'clean' : check.code === 3 ? 'warnings' : 'errors';
		if (check.code !== 0) p.damageDetail = (check.stderr || check.stdout).split('\n').filter(Boolean).slice(0, 3).join(' / ').slice(0, 300);
		if (/File is linearized/.test(check.stdout)) p.linearized = true;
		else if (/File is not linearized/.test(check.stdout)) p.linearized = false;

		progress('qpdf-json');
		try {
			fromQpdfJson(p, await qpdfJson(bytes), notes);
		} catch (e) {
			notes.push(`qpdf json: ${shortError(e)}`);
		}
	}

	// Poppler results.
	progress('poppler');
	const pageAreas: number[] = [];
	const i = await info;
	if (i.code === 0) {
		const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(i.stdout)?.[1]?.trim() ?? null;
		p.producer = field('Producer');
		p.creator = field('Creator');
		p.tagged ??= field('Tagged') === 'yes';
		p.javascript = (p.javascript ?? false) || field('JavaScript') === 'yes';
		p.pages ??= Number(field('Pages')) || null;
		if (!p.version) p.version = field('PDF version');
		for (const m of i.stdout.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/gm)) {
			pageAreas[Number(m[1]) - 1] = Number(m[2]) * Number(m[3]);
		}
	} else notes.push(`pdfinfo: ${i.timedOut ? 'timeout' : firstLine(i.stderr)}`);
	p.producerFamily = producerFamily(p.producer, p.creator);
	const m = await meta;
	if (m.code === 0 && !p.pdfa) {
		const aid = /pdfaid:part\s*(?:=\s*["'](\d)["']|>\s*(\d)\s*<)/.exec(m.stdout);
		if (aid) p.pdfa = `PDF/A-${aid[1] ?? aid[2]}`;
	}

	const t = await text;
	const im = await imgs;
	if (t.code === 0) {
		const pageTexts = t.stdout.split('\f');
		const n = Math.min(PAGES_SAMPLED, p.pages ?? pageTexts.length - 1, Math.max(0, pageTexts.length - 1));
		const cover = new Array<number>(n).fill(0);
		if (im.code === 0) {
			for (const line of im.stdout.split('\n').slice(2)) {
				const c = line.trim().split(/\s+/);
				if (c.length < 14) continue;
				const page = Number(c[0]) - 1;
				const type = c[2];
				if (page < 0 || page >= n || (type !== 'image' && type !== 'stencil')) continue;
				const w = Number(c[3]);
				const h = Number(c[4]);
				const xppi = Number(c[12]);
				const yppi = Number(c[13]);
				const area = pageAreas[page];
				if (!(xppi > 0 && yppi > 0 && area > 0)) continue;
				cover[page] += ((w / xppi) * 72 * ((h / yppi) * 72)) / area;
			}
		} else notes.push(`pdfimages: ${im.timedOut ? 'timeout' : firstLine(im.stderr)}`);
		const c = { pagesSampled: n, textPages: 0, imageOnlyPages: 0, textOverImagePages: 0, emptyPages: 0, scripts: scriptsIn(pageTexts.slice(0, n).join('\n')) };
		for (let k = 0; k < n; k++) {
			const chars = pageTexts[k].replace(/\s+/g, '').length;
			const hasText = chars >= TEXT_PAGE_MIN_CHARS;
			const imagePage = cover[k] >= IMAGE_PAGE_COVER;
			if (hasText) c.textPages++;
			if (imagePage && hasText) c.textOverImagePages++;
			else if (imagePage) c.imageOnlyPages++;
			else if (!hasText) c.emptyPages++;
		}
		p.content = c;
	} else if (p.encryption !== 'needs-password') notes.push(`pdftotext: ${t.timedOut ? 'timeout' : firstLine(t.stderr)}`);

	if (notes.length && p.encryption !== 'needs-password') p.status = 'partial';
	p.ms = Date.now() - started;
	return p;
}

function firstLine(s: string) {
	return (s.split('\n').find((l) => l.trim()) ?? 'failed').slice(0, 200);
}

async function qpdfJson(bytes: Uint8Array): Promise<{ json: Dict; objects: Record<string, Obj> }> {
	const r = await qpdf().run({
		args: ['--json', '--json-stream-data=none', '/in.pdf', '/o.json'],
		inputs: { '/in.pdf': bytes },
		outputs: ['/o.json']
	});
	const file = r.files.get('/o.json');
	if ((r.code !== 0 && r.code !== 3) || !file) throw new Error(`qpdf --json exit ${r.code}: ${firstLine(r.stderr)}`);
	const json = JSON.parse(new TextDecoder().decode(file)) as Dict;
	const objects = ((json.qpdf as unknown[])[1] ?? {}) as Record<string, Obj>;
	return { json, objects };
}

/** qpdf JSON v2: "u:text" / "b:hex" strings, "N G R" references, "/Name" names. */
function fromQpdfJson(p: Profile, { json, objects }: { json: Dict; objects: Record<string, Obj> }, notes: string[]) {
	const get = (ref: unknown): unknown => {
		if (typeof ref === 'string' && /^\d+ \d+ R$/.test(ref)) {
			const o = objects[`obj:${ref}`];
			return o ? (o.value ?? o.stream?.dict) : null;
		}
		return ref;
	};
	const dict = (v: unknown): Dict | null => {
		const d = get(v);
		return isDict(d) ? d : null;
	};
	const arr = (v: unknown): unknown[] => {
		const a = get(v);
		return Array.isArray(a) ? a : [];
	};
	const str = (v: unknown): string | null => {
		const s = get(v);
		if (typeof s !== 'string') return null;
		if (s.startsWith('u:')) return s.slice(2);
		if (s.startsWith('b:')) return Buffer.from(s.slice(2), 'hex').toString('latin1');
		return s;
	};

	const header = ((json.qpdf as unknown[])[0] ?? {}) as Dict;
	const trailer = dict(objects.trailer?.value) ?? {};
	const root = dict(trailer['/Root']) ?? {};
	const infoDict = dict(trailer['/Info']);
	if (infoDict) {
		p.producer = str(infoDict['/Producer']);
		p.creator = str(infoDict['/Creator']);
	}
	const catVersion = typeof root['/Version'] === 'string' ? (root['/Version'] as string).replace(/^\//, '') : null;
	if (catVersion && /^\d\.\d$/.test(catVersion) && (!p.version || catVersion > p.version)) p.version = catVersion;
	if (!p.version && typeof header.pdfversion === 'string') p.version = header.pdfversion;

	// Pages and geometry (inheritable MediaBox, CropBox, Rotate).
	const pages = (json.pages as { object: string }[]) ?? [];
	p.pages = pages.length;
	const inherited = (page: Dict, key: string): unknown => {
		let d: Dict | null = page;
		for (let depth = 0; d && depth < 64; depth++) {
			if (key in d) return get(d[key]);
			d = dict(d['/Parent']);
		}
		return undefined;
	};
	const box = (v: unknown): number[] | null => {
		const a = arr(v).map((x) => Number(get(x)));
		return a.length === 4 && a.every(Number.isFinite) ? [Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3])] : null;
	};
	const sizes = new Set<string>();
	const geometry = { mixedSizes: false, rotated: false, cropOffset: false, userUnit: false, veryLarge: false, maxSide: 0 };
	const annots: Record<string, number> = {};
	for (const pg of pages) {
		const page = dict(pg.object);
		if (!page) continue;
		const media = box(inherited(page, '/MediaBox')) ?? [0, 0, 612, 792];
		const crop0 = box(inherited(page, '/CropBox'));
		const crop = crop0
			? [Math.max(crop0[0], media[0]), Math.max(crop0[1], media[1]), Math.min(crop0[2], media[2]), Math.min(crop0[3], media[3])]
			: media;
		const uu = Number(get(page['/UserUnit']) ?? 1) || 1;
		const rot = ((Number(inherited(page, '/Rotate') ?? 0) % 360) + 360) % 360;
		if (rot !== 0) geometry.rotated = true;
		if (uu !== 1) geometry.userUnit = true;
		if (crop.some((v, k) => Math.abs(v - media[k]) > 1)) geometry.cropOffset = true;
		const w = (crop[2] - crop[0]) * uu;
		const h = (crop[3] - crop[1]) * uu;
		geometry.maxSide = Math.max(geometry.maxSide, w, h);
		sizes.add([Math.round(Math.min(w, h)), Math.round(Math.max(w, h))].join('x'));
		for (const a of arr(page['/Annots'])) {
			const ad = dict(a);
			const sub = typeof ad?.['/Subtype'] === 'string' ? (ad['/Subtype'] as string).slice(1) : 'unknown';
			annots[sub] = (annots[sub] ?? 0) + 1;
		}
	}
	geometry.mixedSizes = sizes.size > 1;
	geometry.veryLarge = geometry.maxSide > VERY_LARGE_SIDE_PT;
	p.geometry = geometry;
	p.annots = annots;

	// Catalog-level features.
	const outlines = dict(root['/Outlines']);
	p.bookmarks = outlines !== null && outlines['/First'] !== undefined;
	p.attachments = Object.keys((json.attachments as Dict) ?? {}).length;
	p.layers = root['/OCProperties'] !== undefined;
	const mark = dict(root['/MarkInfo']);
	p.tagged = (mark !== null && get(mark['/Marked']) === true) || root['/StructTreeRoot'] !== undefined;

	// Forms.
	const acro = dict(root['/AcroForm']);
	const af = (json.acroform ?? {}) as { hasacroform?: boolean; fields?: Dict[] };
	const fields = { text: 0, checkbox: 0, radio: 0, choice: 0, signature: 0, button: 0 };
	const seen = new Set<string>();
	let signed = false;
	for (const f of af.fields ?? []) {
		const name = String(f.fullname ?? f.object);
		if (seen.has(name)) continue;
		seen.add(name);
		if (f.fieldtype === '/Sig') {
			fields.signature++;
			if (f.value !== null && f.value !== undefined) signed = true;
		} else if (f.istext) fields.text++;
		else if (f.ischeckbox) fields.checkbox++;
		else if (f.isradiobutton) fields.radio++;
		else if (f.ischoice) fields.choice++;
		else if (f.fieldtype === '/Btn') fields.button++;
	}
	p.form = { acroform: Boolean(af.hasacroform) && seen.size > 0, xfa: acro !== null && acro['/XFA'] !== undefined, signed, fields };

	// Object-level scan: fonts, images, transparency, JavaScript.
	const fonts = { total: 0, embedded: 0, notEmbedded: 0, type3: 0, cid: 0 };
	const images = { total: 0, jpeg: 0, jpx: 0, jbig2: 0, ccitt: 0, oneBit: 0, cmyk: 0 };
	const transparency = { softMask: false, group: false };
	let js = false;
	const hasFontFile = (fd: Dict | null) => fd !== null && ['/FontFile', '/FontFile2', '/FontFile3'].some((k) => fd[k] !== undefined);
	for (const [key, o] of Object.entries(objects)) {
		if (key === 'trailer') continue;
		const d = isDict(o.value) ? o.value : isDict(o.stream?.dict) ? o.stream!.dict! : null;
		if (!d) continue;
		if (d['/JS'] !== undefined || d['/S'] === '/JavaScript') js = true;
		const group = dict(d['/Group']);
		if (group && group['/S'] === '/Transparency') transparency.group = true;
		if (d['/Type'] === '/ExtGState') {
			const sm = d['/SMask'];
			if (sm !== undefined && sm !== '/None') transparency.softMask = true;
		}
		if (d['/Type'] === '/Font' || (d['/Subtype'] && d['/BaseFont'] !== undefined && !o.stream)) {
			const sub = d['/Subtype'];
			if (sub === '/CIDFontType0' || sub === '/CIDFontType2') continue; // counted through their Type0 parent
			if (typeof sub !== 'string' || !['/Type1', '/MMType1', '/TrueType', '/Type0', '/Type3', '/OpenType'].includes(sub)) continue;
			fonts.total++;
			if (sub === '/Type3') {
				fonts.type3++;
				fonts.embedded++;
				continue;
			}
			let fd = dict(d['/FontDescriptor']);
			if (sub === '/Type0') {
				fonts.cid++;
				const desc = dict(arr(d['/DescendantFonts'])[0]);
				fd = desc ? dict(desc['/FontDescriptor']) : null;
			}
			if (hasFontFile(fd)) fonts.embedded++;
			else fonts.notEmbedded++;
		}
		if (o.stream && d['/Subtype'] === '/Image') {
			images.total++;
			const filters = (Array.isArray(get(d['/Filter'])) ? arr(d['/Filter']) : [get(d['/Filter'])]).map(String);
			if (filters.includes('/DCTDecode')) images.jpeg++;
			if (filters.includes('/JPXDecode')) images.jpx++;
			if (filters.includes('/JBIG2Decode')) images.jbig2++;
			if (filters.includes('/CCITTFaxDecode')) images.ccitt++;
			if (get(d['/ImageMask']) === true || Number(get(d['/BitsPerComponent'])) === 1) images.oneBit++;
			const cs = get(d['/ColorSpace']);
			const csArr = Array.isArray(cs) ? cs.map(get) : null;
			const iccN = csArr && csArr[0] === '/ICCBased' ? Number(dict(csArr[1])?.['/N']) : 0;
			if (cs === '/DeviceCMYK' || iccN === 4) images.cmyk++;
			if (d['/SMask'] !== undefined) transparency.softMask = true;
		}
	}
	p.fonts = fonts;
	p.images = images;
	p.transparency = transparency;
	const names = dict(root['/Names']);
	const openAction = dict(root['/OpenAction']);
	p.javascript = js || (names !== null && names['/JavaScript'] !== undefined) || openAction?.['/S'] === '/JavaScript';
	if (Object.keys(objects).length === 0) notes.push('qpdf json: no objects');
}
