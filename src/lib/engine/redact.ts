/**
 * True redaction with MuPDF: remove text, image pixels, drawings, links and
 * annotations under each box, paint the box black, and prove it.
 *
 * What the stage does, per redacted page (the assembled file is unencrypted):
 *
 *  1. Box mapping. A StampBox is a fraction of the page as displayed (after /Rotate,
 *     CropBox-relative, top-left origin). MuPDF "page space" is exactly that frame
 *     in points with UserUnit applied (`page.getBounds()` is [0 0 W H] of the
 *     displayed page; `page.getTransform()` maps PDF user space into it), so a box
 *     is `bounds.x0 + f.x·W` etc. The page's displayed size must match the plan's
 *     expected size or the stage refuses (a box on the wrong frame would miss).
 *
 *  2. Which glyphs go. Every glyph whose ink touches a box, by any amount: its
 *     structured-text outline box ("accurate-bboxes"; the font's ascent/descent quad
 *     for a visible character without an outline), or the core of its em box in a
 *     device pass (which also sees clipped and invisible text). A glyph whose nominal
 *     box merely reaches into a box (the next line, the descent of a big title above)
 *     while its ink stays outside is not under the box and stays. MuPDF removes a
 *     glyph when its nominal box (ascent to descent, shrunk by a tenth) meets a
 *     redaction area, so the text pass redacts a small area in the middle of each
 *     chosen glyph (a second pass takes the whole nominal and em box of any chosen
 *     glyph still there). Redacting text with the box itself, or with the box grown
 *     over touched glyphs, removed whole neighbouring lines. Only the boxes the user
 *     drew are painted black (a partly covered glyph disappears and leaves a gap; the
 *     export then carries a warning to check the text around the boxes).
 *     Before that, on a page with stroked text, stroke-state operators are turned into
 *     equivalent ExtGStates (keepStrokeState: MuPDF's rewrite drops them before text).
 *     After the text passes, every visible character outside the boxes must still be
 *     there, in place (MuPDF's rewrite can take or move one), or the stage refuses.
 *
 *  3. MuPDF `applyRedactions(black=false, IMAGE_PIXELS, LINE_ART_NONE, TEXT_NONE)`
 *     over the boxes (after the text passes of 2). MuPDF rewrites the page content into
 *     a new stream, copies every
 *     Form XObject the page uses (so pages sharing streams, forms or images with this
 *     page are not changed), removes the chosen text (including invisible
 *     OCR text, Type 3 text, text in hidden layers and in forms), blanks image pixels
 *     in a new copy of the image (blanked pixels become opaque white in the stored
 *     data, soft-mask values opaque, image-mask bits unpainted; the black is the
 *     painted box), and removes links.
 *
 *  4. Our own pass over MuPDF's output (page stream and its new forms). It needs a
 *     tokenizer; MuPDF's output is regular (inline images always ASCIIHex) and
 *     anything else is refused:
 *     - Drawings (MuPDF's line-art removal is off; this pass does it all). MuPDF's
 *       REMOVE_IF_TOUCHED misses paths with several subpaths (seen with a glyph
 *       outline drawn as one path) and REMOVE_IF_COVERED keeps a path only partly
 *       under the box, whose data under the black paint would still be in the file
 *       (text converted to outlines is exactly that). Rule: a painted path whose
 *       geometry touches a box is removed whole, unless it is "kept":
 *
 *       KEPT DRAWINGS. A path may stay (whole, painted over by the black box) only
 *       if what lies under every box is the straight continuation of what is
 *       visible outside it, so it adds nothing a reader cannot already see:
 *         (a) no curves at all, and painted with a plain colour (not a pattern);
 *         (b) every segment that enters a box's interior is horizontal or vertical
 *             in page space (after the CTM and the page's rotation) and runs right
 *             through the box: both of its ends lie outside the box, beyond the
 *             box's full width (horizontal) or full height (vertical);
 *         (c) fills are judged with their subpaths closed (a filled rectangle by its
 *             four edges); a lone point or zero-length segment touching a box counts
 *             as not running through it.
 *       What this keeps: table grid lines and borders that cross a box, underlines
 *       and rules longer than the box on both sides, cell and page backgrounds that
 *       contain the box, bands (rules drawn as filled rectangles, wide fills) that
 *       cross it completely. What it removes: anything with a corner, an end or an
 *       edge inside a box (a bar-chart bar ending under it, an underline no longer
 *       than the redacted word, which would give away its exact width; a table line
 *       ending inside the box), every curve and diagonal (glyph outlines, signatures,
 *       ticks), and every small mark (barcode bars, QR modules, pixel-font strokes)
 *       that does not cross the whole box. A dense cluster of small rectangles
 *       inside a box therefore always goes: none of them can cross it. Bars of a
 *       barcode that cross the box from edge to edge stay, but each is then fully
 *       visible above and below the box, so nothing is hidden. A kept background
 *       or rule cannot reveal text: its hidden part is a solid area or a straight
 *       band whose edges are all visible outside the box.
 *       Every `sh` shading whose clip touches a box is removed whole, and so is
 *       every pattern-filled path that touches one. Paths used only as clips are
 *       kept (they paint nothing).
 *     - Marked content: MuPDF keeps `/Span <</ActualText (…)>> BDC` even when it
 *       removed the glyphs, so the hidden text would still be in the file. Every
 *       string-valued property (ActualText, Alt, E, …; not Lang) of every marked-
 *       content sequence on a redacted page is dropped, inline and named.
 *     - Resources: MuPDF leaves resources that nothing draws any more (a pattern
 *       whose cell holds text, an ExtGState whose soft mask draws text, an image
 *       whose `Do` was removed). Each resource dictionary of the page and its forms
 *       is cut down to the names its content uses. A pattern that is selected as a
 *       colour but no longer painted with (MuPDF removed the path) does not count:
 *       its `scn` becomes `0 g` and the pattern goes.
 *     - Soft masks: the content of a soft-mask group is not page content, so it is
 *       neither redacted nor fully checked. A redacted page whose content uses a soft
 *       mask containing text or images is refused.
 *
 *  5. Annotations: MuPDF removes links only. Every entry of /Annots whose /Rect
 *     touches a box (or has no usable /Rect) is removed, whatever its subtype,
 *     widgets included; then popups and replies (/Parent, /IRT) of removed ones, judged
 *     by identity and by place (qpdf's page copy can leave a reply pointing at a second
 *     copy of the annotation, which would otherwise keep its text alive); then
 *     removed widgets are taken out of /AcroForm /Fields and /CO (with parents left
 *     without kids).
 *
 *  6. Document level: /StructTreeRoot is dropped (its /Alt and /ActualText may spell
 *     out the removed text; the tags would be stale anyway); /Thumb is dropped from
 *     redacted pages. Metadata removal is the finalize stage's job (core forces it).
 *
 *  7. Black: the content is wrapped in q … Q and `q 0 g <boxes> re f Q` appended.
 *     Saved with `garbage=compact` so removed objects are not left behind as orphans.
 *
 *  8. The saved bytes are checked (strict); core runs the same check on the final
 *     file (`verifyRedactions`) with our later stamps allowed.
 *
 * The check (any failure refuses the export):
 *  - Optional content: hidden layers are made visible for the check (the file is
 *    re-opened without /OCProperties), so hidden text and drawings are seen.
 *  - Text, MuPDF: no structured-text character other than whitespace has ink (its
 *    outline box; its ascent/descent quad when it has no outline) touching a box,
 *    except characters of `allowedText`.
 *  - Text, PDF.js: no text item touches a box, in PDF.js's own displayed-page
 *    geometry. An item is taken from its baseline to 60% of its height along its
 *    advance (the band of the device pass's glyph core; the ink above it is the
 *    outline check's), except allowed strings.
 *  - Device pass (MuPDF interpreter, contents and annotations): no glyph core, no
 *    painted path (other than a kept drawing, same rule as above), no shading
 *    inside its clip, no tiling pattern touches a box, except the axis-aligned black
 *    rectangles we painted (and, on the final file,
 *    our later image/mark/highlight stamps and allowed text). Every image drawn over
 *    a box has stored pixels (and soft-mask values) under the box that are uniform:
 *    the stored data carries no picture there.
 *  - Annotations: no /Annots entry touches a box.
 *  - Pixels: a MuPDF render of each box, inset by 1 px, is black (channels ≤ 40).
 *    In the stage every pixel must be black: nothing of ours is drawn yet. On the
 *    final file our own later stamps may sit on a box, so pixels inside overlay
 *    boxes and inside the (padded) quads of allowed text are skipped, and 99.5% of
 *    the rest must be black: allowed glyphs can ink slightly outside their quads.
 *    Everything that could leave readable data is already covered by the content
 *    checks above, so this small tolerance cannot hide a leak.
 *
 * Refused (a clear message, no file) rather than risked:
 *  - soft masks with text or images on a redacted page (see 4);
 *  - content MuPDF did not rewrite but which still needs an edit (should not happen:
 *    MuPDF copies every form of a redacted page);
 *  - inline images not written as ASCIIHex/ASCII85 in MuPDF's output, or content the
 *    tokenizer cannot read;
 *  - text outside the boxes that MuPDF's text removal took or moved (see 2);
 *  - a gradient or pattern fill touching a box that also covers more than a quarter
 *    of the page outside the boxes (a background; it can only go whole);
 *  - anything the check finds (a glyph MuPDF kept, an image it did not blank, …).
 * Handled by removal, not refused: Type 3 fonts (as text), tiling patterns (the
 * painted path goes), smaller shadings (removed whole), clipped content, outlined text and
 * other drawings that are not kept (removed whole; the export warns when one reached
 * past the box), image masks and soft-masked images (blanked by MuPDF, checked).
 * Not covered: bookmarks, named destinations, document JavaScript or other pages
 * that quote the same text (search-and-redact is in the backlog).
 */

import type * as MU from 'mupdf';
import type { PageSize, StampBox, VerifyCheck } from '../core/types';
import type { EngineDeps } from './deps';
import { EngineError } from './errors';
import { applyMatrix, multiply, type Matrix } from './geometry';
import { disown, isRetired, rethrowFault, type Mupdf } from './mupdf';
import type { PdfjsLib } from './pdfjs';

export interface RedactJob {
	/** 0-based page index in the assembled file (= output page index). */
	pageIndex: number;
	/** Stamp boxes: fractions of the page as displayed (after all rotation), origin top-left. */
	boxes: StampBox[];
	/** Displayed size the plan expects for this page (PDF points, UserUnit applied). */
	expected: PageSize;
	/**
	 * Boxes of our own later image, mark and highlight stamps on this page (same frame).
	 * Only the check on the final file uses them: what is drawn inside them is ours.
	 */
	overlays?: StampBox[];
}

type Rect = [number, number, number, number];
type Doc = MU.PDFDocument;
type Obj = MU.PDFObject;

const SIZE_TOLERANCE = 0.5;
/** Strings in marked-content properties that may stay (language tags carry no text). */
const KEEP_STRING_KEYS = new Set(['Lang']);
const RESOURCE_KINDS = ['XObject', 'Font', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties'] as const;
type ResourceKind = (typeof RESOURCE_KINDS)[number];
const DEVICE_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK', 'I', 'Indexed']);

/**
 * The redact stage. Checks its own result (nothing readable under any box, boxes
 * black) before returning, and throws EngineError('verification-failed') with
 * 'redaction' checks otherwise.
 */
export async function applyRedactions(deps: EngineDeps, bytes: Uint8Array, jobs: RedactJob[], warnings: string[] = []): Promise<Uint8Array> {
	if (jobs.length === 0) return bytes;
	const m = await deps.mupdf();
	let out: Uint8Array;
	const notes = { partly: 0, drawings: 0 };
	const doc = openDoc(m, bytes);
	try {
		out = redactDocument(m, doc, jobs, notes);
	} catch (e) {
		if (e instanceof ContentError) {
			const err = new EngineError(
				'unsupported',
				`Page ${e.pageNo} has content that cannot be redacted reliably, so nothing was exported.`
			);
			(err as { cause?: unknown }).cause = e.message;
			throw err;
		}
		throw e;
	} finally {
		destroy(doc);
	}
	const checks = await checkRedactions(deps, out, jobs, { allowed: jobs.map(() => []), strict: true });
	if (isRetired(m)) throw new EngineError('internal', 'The PDF engine had to restart. Try again.');
	if (!checks.every((c) => c.ok)) {
		throw new EngineError('verification-failed', 'A redaction could not be verified, so the file was not saved.', checks);
	}
	if (notes.partly) {
		warnings.push(
			`${notes.partly === 1 ? 'A letter' : `${notes.partly} letters`} only partly under a redaction box ${notes.partly === 1 ? 'was' : 'were'} removed whole, so nothing of ${notes.partly === 1 ? 'it' : 'them'} is left in the file. Check the text around the boxes.`
		);
	}
	if (notes.drawings) {
		warnings.push(
			`${notes.drawings === 1 ? 'A drawing' : `${notes.drawings} drawings`} (lines, shapes or outlined text) touching a redaction box ${notes.drawings === 1 ? 'was' : 'were'} removed whole, also where ${notes.drawings === 1 ? 'it extended' : 'they extended'} past the box. Check the page around the boxes.`
		);
	}
	return out;
}

/**
 * 'redaction' check on the final file. `allowedText[i]` lists the strings our own
 * stamps and page numbers may have drawn on job i's page (they may overlap a box).
 */
export async function verifyRedactions(
	deps: EngineDeps,
	finalBytes: Uint8Array,
	jobs: RedactJob[],
	allowedText: string[][],
	password?: string,
	/** True when compress-to-target re-encoded images after the stage (see imageBlankUnder). */
	imagesReencoded = false
): Promise<VerifyCheck[]> {
	if (jobs.length === 0) return [];
	return checkRedactions(deps, finalBytes, jobs, { allowed: allowedText, password, strict: false, imagesReencoded });
}

// ---------------------------------------------------------------------------
// The stage

function redactDocument(m: Mupdf, doc: Doc, jobs: RedactJob[], notes: { partly: number; drawings: number }): Uint8Array {
	const preCount = doc.countObjects();
	// Glyph boxes are measured with hidden layers visible, so hidden text is grown over too.
	const probe = hasOptionalContent(doc) ? withoutOptionalContent(m, doc) : null;
	try {
		for (const job of jobs) {
			const pageNo = job.pageIndex + 1;
			// Pages, annotations and probes are freed here rather than by the garbage collector:
			// each page holds its document, and the engine worker is long-lived.
			const page = doc.loadPage(job.pageIndex);
			const probePage = probe ? probe.loadPage(job.pageIndex) : null;
			try {
				const boxes = pageBoxes(page, job);
				keepStrokeState(doc, page.getObject());
				// Text first: exactly the glyphs whose ink touches a box (see glyphMarks). Then
				// pictures under the boxes themselves, text left alone (MuPDF's own test would
				// also take every glyph whose nominal box merely overlaps a box).
				const removeText = (marks: Rect[]) => {
					if (!marks.length) return;
					const a = page.createAnnotation('Redact');
					a.setQuadPoints(marks.map(([x0, y0, x1, y1]) => [x0, y0, x1, y0, x0, y1, x1, y1]));
					destroy(a);
					page.applyRedactions(false, m.PDFPage.REDACT_IMAGE_NONE, m.PDFPage.REDACT_LINE_ART_NONE, m.PDFPage.REDACT_TEXT_REMOVE);
				};
				const before = readChars(page, true);
				const choice = glyphMarks(m, probePage ?? page, boxes, false);
				removeText(choice.marks);
				// A glyph whose metrics disagree between text extraction and MuPDF's redaction
				// (a Type 3 glyph with no width in one and some in the other) can survive its
				// point: once more over its whole nominal and em box; and if a chosen glyph is
				// still there (combining marks MuPDF extracts at another place than it draws
				// them), over the boxes themselves, as MuPDF judges text.
				const again = glyphMarks(m, page, boxes, true).marks;
				if (again.length) {
					removeText(again);
					if (glyphMarks(m, page, boxes, true).marks.length) removeText(boxes);
				}
				// Text that should have stayed must still be there, in its place (MuPDF's test is
				// by nominal box, so where those overlap a lot removing one glyph takes its
				// neighbour; and its rewrite of a text object can shift the glyphs after a
				// removed one, seen with character spacing).
				if (lostText(before, readChars(page, true), boxes, choice.cores)) {
					throw new EngineError(
						'unsupported',
						`Page ${pageNo}: removing the text under a redaction box would also remove or move text outside it, so nothing was exported.`
					);
				}
				notes.partly += choice.chosen.filter((ch) => ch.ink && shareInside(ch.ink, boxes) < 0.5).length;
				for (const r of boxes) {
					const a = page.createAnnotation('Redact');
					a.setRect(r);
					destroy(a);
				}
				page.applyRedactions(false, m.PDFPage.REDACT_IMAGE_PIXELS, m.PDFPage.REDACT_LINE_ART_NONE, m.PDFPage.REDACT_TEXT_NONE);
				const pageObj = page.getObject();
				const pageTf = page.getTransform() as Matrix;
				cleanContent(m, doc, pageObj, pageTf, boxes, preCount, pageNo, page.getBounds() as Rect, notes);
				removeAnnotations(doc, pageObj, pageTf, boxes);
				paintBlack(doc, pageObj, pageTf, boxes);
				pageObj.delete('Thumb');
			} finally {
				if (probePage) destroy(probePage);
				destroy(page);
			}
		}
	} finally {
		if (probe) destroy(probe);
	}
	doc.getTrailer().get('Root').delete('StructTreeRoot');
	// Not garbage=compact: renumbering copies every object mupdf.js holds a reference to
	// (all it has read) and the copy of a stream loses its data, so images and forms
	// read by the pass above came out as empty dictionaries ("XObject should be a
	// stream"). garbage=yes still drops every object nothing refers to any more.
	return saveBuffer(doc, 'garbage=yes,compress');
}

/** Boxes of a job in MuPDF page space; refuses if the page is not the planned size. */
function pageBoxes(page: MU.PDFPage, job: RedactJob): Rect[] {
	const b = page.getBounds() as Rect;
	const w = b[2] - b[0];
	const h = b[3] - b[1];
	if (Math.abs(w - job.expected.width) > SIZE_TOLERANCE || Math.abs(h - job.expected.height) > SIZE_TOLERANCE) {
		const check: VerifyCheck = {
			name: 'page-sizes',
			ok: false,
			detail: `Page ${job.pageIndex + 1}: the redaction step sees ${r2(w)}×${r2(h)} pt, the plan expects ${r2(job.expected.width)}×${r2(job.expected.height)} pt.`
		};
		throw new EngineError('verification-failed', 'The pages did not come out the expected size, so the file was not saved.', [check]);
	}
	return job.boxes.map((s) => fractionRect(b, s));
}

function fractionRect(b: Rect, s: StampBox): Rect {
	const w = b[2] - b[0];
	const h = b[3] - b[1];
	return [b[0] + s.x * w, b[1] + s.y * h, b[0] + (s.x + s.w) * w, b[1] + (s.y + s.h) * h];
}

/**
 * Glyphs to remove: every glyph whose ink touches a box (any amount), by its
 * structured-text outline box, or by the core of its em box in a device pass (which
 * also sees clipped and invisible text). MuPDF removes a glyph when its nominal box
 * (font descent to ascent along its advance, shrunk by a tenth) meets a redaction
 * area. Redacting text with the box itself also removed glyphs of the next line, or
 * of a big title above, whose nominal boxes reach into the box while their ink is
 * outside it: text visibly outside the box disappeared. So each chosen glyph gets a
 * point area of its own: inside its nominal box and, where the nominal boxes of
 * tightly set lines overlap, outside the nominal box of every glyph that stays.
 * (A glyph with no advance has a zero-width nominal box; its point is on it.)
 *
 * With `whole` (the second pass, for chosen glyphs still there), the areas are the
 * glyphs' whole nominal and em boxes.
 */
function glyphMarks(m: Mupdf, page: MU.PDFPage, boxes: Rect[], whole: boolean): GlyphChoice {
	const hit = (r: Rect) => boxes.some((b) => touches(r, b, 0));
	const chars = readChars(page);
	const chosen = chars.filter((ch) => ch.ink && hit(ch.ink));
	const kept = chars.filter((ch) => !(ch.ink && hit(ch.ink)) && ch.c.trim() !== '');
	// Where MuPDF's test would take a glyph that stays (its shrunk nominal box), plus a margin.
	const keptAreas = kept.map((ch) => pad(shrinkBy(ch.nominal, 0.1), 0.25));
	const free = (r: Rect): Rect => {
		const near = keptAreas.filter((a) => a[0] <= r[2] && a[2] >= r[0] && a[1] <= r[3] && a[3] >= r[1]);
		const steps = [0.5, 0.3, 0.7, 0.1, 0.9];
		for (const fy of steps) {
			for (const fx of steps) {
				const x = r[0] + (r[2] - r[0]) * fx;
				const y = r[1] + (r[3] - r[1]) * fy;
				if (!near.some((a) => x >= a[0] && x <= a[2] && y >= a[1] && y <= a[3])) return [x, y, x, y];
			}
		}
		const x = (r[0] + r[2]) / 2;
		const y = (r[1] + r[3]) / 2;
		return [x, y, x, y];
	};
	const marks = chosen.map((ch) => (whole ? ch.nominal : free(shrinkBy(ch.nominal, 0.15))));
	const cores: Pt[] = [];
	runDevice(m, page, {
		glyph: (g) => {
			if (!hit(g.core)) return;
			if (whole) {
				marks.push(g.em);
				return;
			}
			// Text extraction already chose this glyph: its point is set.
			const cx = (g.core[0] + g.core[2]) / 2;
			const cy = (g.core[1] + g.core[3]) / 2;
			cores.push([cx, cy]);
			if (chosen.some((ch) => cx >= ch.nominal[0] && cx <= ch.nominal[2] && cy >= ch.nominal[1] && cy <= ch.nominal[3])) return;
			marks.push(free(g.mark));
		}
	});
	return { marks, chosen: chosen.filter((ch) => ch.c.trim() !== ''), cores };
}

interface GlyphChoice {
	/** Redaction areas, page space. */
	marks: Rect[];
	/** Visible characters chosen (their ink touches a box). */
	chosen: CharBox[];
	/** Centres of the em cores of glyphs the device pass chose. */
	cores: Pt[];
}

/**
 * True when a visible character whose ink is outside every box (so it should have
 * stayed) is gone: no character with the same text within half a point of it is left.
 */
function lostText(before: CharBox[], after: CharBox[], boxes: Rect[], cores: Pt[]): boolean {
	const byText = new Map<string, CharBox[]>();
	for (const ch of after) {
		const l = byText.get(ch.c);
		if (l) l.push(ch);
		else byText.set(ch.c, [ch]);
	}
	const near = (a: Rect, b: Rect) => Math.abs(a[0] - b[0]) <= 0.5 && Math.abs(a[1] - b[1]) <= 0.5;
	for (const ch of before) {
		if (ch.c.trim() === '' || !ch.ink || boxes.some((b) => touches(ch.ink!, b, 0))) continue;
		const n = ch.nominal;
		// A character without width is a mark on, or a part of, another glyph (a ligature
		// lists its letters, all but the first with no width): it goes with that glyph.
		if (n[2] - n[0] < 0.01 || n[3] - n[1] < 0.01) continue;
		if (cores.some(([x, y]) => x >= n[0] && x <= n[2] && y >= n[1] && y <= n[3])) continue;
		const same = byText.get(ch.c) ?? [];
		const i = same.findIndex((o) => near(o.nominal, ch.nominal));
		if (i < 0) return true;
		same.splice(i, 1);
	}
	return false;
}

function shrinkBy(r: Rect, f: number): Rect {
	const w = (r[2] - r[0]) * f;
	const h = (r[3] - r[1]) * f;
	return [r[0] + w, r[1] + h, r[2] - w, r[3] - h];
}

/** Share of a rectangle's area inside the boxes (0 for an empty rectangle). */
function shareInside(r: Rect, boxes: Rect[]): number {
	const area = (r[2] - r[0]) * (r[3] - r[1]);
	if (area <= 0) return 0;
	let best = 0;
	for (const b of boxes) {
		const i = intersect(r, b);
		if (i) best = Math.max(best, ((i[2] - i[0]) * (i[3] - i[1])) / area);
	}
	return best;
}

interface CharBox {
	c: string;
	/** Index of its structured-text line (for allowed strings). */
	line: number;
	/** Font ascent/descent quad. */
	nominal: Rect;
	/**
	 * Where the glyph has ink: its outline box ("accurate-bboxes"); the nominal quad
	 * when MuPDF found no outline for a visible character; null for whitespace without
	 * ink.
	 */
	ink: Rect | null;
}

/**
 * The page's characters, each with its nominal quad and its ink box. Both come from
 * two structured-text passes that list the same characters in the same order; if they
 * ever do not, every character of both passes is returned with its quad as its ink
 * (the stricter rule: a nominal quad that touches a box counts).
 */
function readChars(page: MU.PDFPage, ignoreActualText = false): CharBox[] {
	const read = (opts: string) => {
		const out: { c: string; line: number; r: Rect }[] = [];
		let line = -1;
		const st = page.toStructuredText(opts);
		try {
			st.walk({
				beginLine() {
					line++;
				},
				onChar(c, _o, _f, _s, quad) {
					out.push({ c, line, r: quadRect(quad as number[]) });
				}
			});
		} finally {
			destroy(st);
		}
		return out;
	};
	const extra = ignoreActualText ? ',ignore-actualtext' : '';
	const nominal = read(`preserve-whitespace${extra}`);
	const ink = read(`preserve-whitespace,accurate-bboxes${extra}`);
	const blank = (c: string) => c.trim() === '';
	if (ink.length === nominal.length && ink.every((x, i) => x.c === nominal[i].c)) {
		return nominal.map((n, i) => {
			const r = ink[i].r;
			const hasInk = r[2] > r[0] && r[3] > r[1];
			return { c: n.c, line: n.line, nominal: n.r, ink: hasInk ? r : blank(n.c) ? null : n.r };
		});
	}
	const offset = nominal.length ? nominal[nominal.length - 1].line + 1 : 0;
	return [
		...nominal.map((n) => ({ c: n.c, line: n.line, nominal: n.r, ink: n.r })),
		...ink.map((n) => ({ c: n.c, line: n.line + offset, nominal: n.r, ink: n.r }))
	];
}

// ---------------------------------------------------------------------------
// Our pass over MuPDF's output

class ContentError extends Error {
	constructor(
		readonly pageNo: number,
		message: string
	) {
		super(message);
	}
}

type Usage = Record<ResourceKind, Set<string>>;
function newUsage(): Usage {
	const u = {} as Usage;
	for (const k of RESOURCE_KINDS) u[k] = new Set();
	return u;
}

interface Edit {
	start: number;
	end: number;
	text: string;
}

interface StreamWork {
	obj: Obj;
	bytes: Uint8Array;
	edits: Map<number, Edit>;
}

interface PassCtx {
	doc: Doc;
	pageNo: number;
	pageTf: Matrix;
	boxes: Rect[];
	preCount: number;
	streams: Map<number, StreamWork>;
	/** Resource dictionaries we own (made local) and the names their content uses. */
	resources: { dict: Obj; usage: Usage }[];
	extGStates: Obj[];
	patterns: PatternUse[];
	active: Set<number>;
	/** Area of the displayed page (pt²). */
	pageArea: number;
	/** Counts for the export's warnings. */
	notes: { partly: number; drawings: number };
}

/** A gradient or pattern fill that goes whole may cover at most this share of the page outside the boxes. */
const LARGE_FILL = 0.25;

/** A drawing removed whole that also covered a noticeable area outside the boxes (more than 4 pt² and than a tenth of the box area it touches). */
function visibleOutside(ctx: PassCtx, r: Rect | null): boolean {
	if (!r) return false;
	const area = (q: Rect) => Math.max(0, q[2] - q[0]) * Math.max(0, q[3] - q[1]);
	const inside = ctx.boxes.reduce((n, b) => n + area(intersect(r, b) ?? [0, 0, 0, 0]), 0);
	const outside = area(r) - inside;
	return outside > 4 && outside > 0.1 * Math.max(inside, 1);
}

/**
 * A colour gradient (`sh`) or a pattern-filled shape that touches a box is removed
 * whole (its data under the box cannot be removed alone). When it also covers a large
 * area outside the boxes (a page background), removing it would visibly change the
 * page far from the boxes (white text on a removed gradient becomes invisible), so the
 * export is refused instead.
 */
function refuseLargeFill(ctx: PassCtx, r: Rect | null) {
	if (!r) return;
	const area = (q: Rect) => Math.max(0, q[2] - q[0]) * Math.max(0, q[3] - q[1]);
	const outside = area(r) - ctx.boxes.reduce((n, b) => n + area(intersect(r, b) ?? [0, 0, 0, 0]), 0);
	if (outside > LARGE_FILL * ctx.pageArea) {
		throw new EngineError(
			'unsupported',
			`Page ${ctx.pageNo}: a colour gradient or pattern runs under a redaction box and across a large part of the page (a background, for example). It can only be removed whole, which would change the page far from the box, so nothing was exported.`
		);
	}
}

interface GState {
	ctm: Matrix;
	clip: Rect | null;
	/** Pattern set as the fill / stroke colour, if any. */
	fillPat: PatternUse | null;
	strokePat: PatternUse | null;
}

/** A `scn`/`SCN` that selects a pattern; rewritten to a plain colour if nothing paints with it. */
interface PatternUse {
	name: string;
	usage: Usage;
	work: StreamWork;
	s: number;
	e: number;
	stroke: boolean;
	used: boolean;
}

/**
 * MuPDF's redaction rewrites the content of the page and its forms, and that rewrite
 * writes line width, caps, joins, miter limit and dash (`w J j M d`) only before a
 * path it strokes: before stroked text (render modes 1, 2, 5, 6; word processors draw
 * "bold" for fonts without a bold face as fill plus a thin stroke) they were dropped,
 * and that text came out heavier on the whole page. `gs` operators are kept where they
 * are, so on a page with stroked text every such operator in the page's content and
 * in the forms it draws is replaced by an ExtGState with the same values (exactly
 * equivalent drawing). Content our tokenizer cannot read is left as it was (only its
 * stroked text can change weight, nothing is lost).
 */
function keepStrokeState(doc: Doc, pageObj: Obj) {
	interface Part {
		ref: Obj;
		res: Obj;
		data: Uint8Array;
		ops: Op[];
	}
	const parts: Part[] = [];
	const seen = new Set<number>();
	const read = (ref: Obj, res: Obj, depth: number): boolean => {
		if (!ref.isIndirect() || seen.has(ref.asIndirect()) || depth > 20) return true;
		seen.add(ref.asIndirect());
		const data = readBytes(ref);
		const ops: Op[] = [];
		try {
			const lexer = new Lexer(data, 0);
			for (let op = lexer.next(); op; op = lexer.next()) ops.push(op);
		} catch (e) {
			rethrowFault(e);
			return false;
		}
		parts.push({ ref, res, data, ops });
		for (const op of ops) {
			if (op.op !== 'Do' || op.args[0]?.k !== 'name' || res.isNull()) continue;
			const xo = res.get('XObject').get(op.args[0].v);
			if (!xo.isIndirect() || xo.get('Subtype').asName() !== 'Form') continue;
			const own = xo.get('Resources');
			if (!read(xo, own.isNull() ? res : own, depth + 1)) return false;
		}
		return true;
	};
	const res = pageObj.getInheritable('Resources');
	const contents = pageObj.get('Contents');
	const refs = contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : [contents];
	for (const ref of refs) if (!read(ref, res, 0)) return;
	const strokedText = parts.some((pt) =>
		pt.ops.some((op) => op.op === 'Tr' && op.args[0]?.k === 'num' && [1, 2, 5, 6].includes(op.args[0].v))
	);
	if (!strokedText) return;

	const KEYS: Record<string, string> = { w: 'LW', J: 'LC', j: 'LJ', M: 'ML', d: 'D' };
	const names = new Map<string, string>();
	let counter = 0;
	for (const pt of parts) {
		const edits: Edit[] = [];
		for (const op of pt.ops) {
			const key = KEYS[op.op];
			if (!key) continue;
			let value: string;
			if (op.op === 'd') {
				const [arr, phase] = op.args.slice(-2);
				if (arr?.k !== 'arr' || phase?.k !== 'num') continue;
				value = `[${latin1(pt.data, arr.s, arr.e)} ${n4(phase.v)}]`;
			} else {
				const a = op.args[op.args.length - 1];
				if (a?.k !== 'num') continue;
				value = n4(a.v);
			}
			if (pt.res.isNull() || !pt.res.isDictionary()) return;
			let gsDict = pt.res.get('ExtGState');
			if (gsDict.isNull()) {
				pt.res.put('ExtGState', doc.newDictionary());
				gsDict = pt.res.get('ExtGState');
			}
			const id = `${key} ${value}`;
			let name = names.get(id);
			if (!name) {
				do name = `RdxS${counter++}`;
				while (!gsDict.get(name).isNull());
				names.set(id, name);
			}
			if (gsDict.get(name).isNull()) {
				const g = doc.newDictionary();
				g.put('Type', doc.newName('ExtGState'));
				if (op.op === 'd') {
					const a = op.args[op.args.length - 2] as Extract<Val, { k: 'arr' }>;
					const dash = doc.newArray();
					for (const v of a.v) if (v.k === 'num') dash.push(v.v);
					const pair = doc.newArray();
					pair.push(dash);
					pair.push((op.args[op.args.length - 1] as Extract<Val, { k: 'num' }>).v);
					g.put('D', pair);
				} else {
					g.put(key, (op.args[op.args.length - 1] as Extract<Val, { k: 'num' }>).v);
				}
				gsDict.put(name, doc.addObject(g));
			}
			edits.push({ start: op.args[0]?.s ?? op.s, end: op.e, text: `/${name} gs` });
		}
		if (edits.length) pt.ref.writeStream(applyEdits(pt.data, edits));
	}
}

function cleanContent(
	m: Mupdf,
	doc: Doc,
	pageObj: Obj,
	pageTf: Matrix,
	boxes: Rect[],
	preCount: number,
	pageNo: number,
	bounds: Rect,
	notes: { partly: number; drawings: number } = { partly: 0, drawings: 0 }
) {
	void m;
	const ctx: PassCtx = {
		doc,
		pageNo,
		pageTf,
		boxes,
		preCount,
		streams: new Map(),
		resources: [],
		extGStates: [],
		patterns: [],
		active: new Set(),
		pageArea: Math.max(1, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])),
		notes
	};
	const res = localResources(doc, pageObj, pageObj.getInheritable('Resources'));
	const usage = newUsage();
	ctx.resources.push({ dict: res, usage });

	const contents = pageObj.get('Contents');
	const parts: Obj[] = [];
	if (contents.isArray()) {
		const a = contents.resolve();
		for (let i = 0; i < a.length; i++) parts.push(a.get(i));
	} else if (!contents.isNull()) parts.push(contents);
	const state: GState[] = [{ ctm: [1, 0, 0, 1, 0, 0], clip: bounds, fillPat: null, strokePat: null }];
	for (const part of parts) {
		if (!part.isIndirect() || part.asIndirect() < preCount) {
			throw new ContentError(pageNo, 'page content was not rewritten by MuPDF');
		}
		walkStream(ctx, part, res, usage, state);
	}

	// A pattern selected but never painted with (MuPDF removed the painting) is dropped,
	// so its cell (which may hold text) does not stay in the file.
	for (const p of ctx.patterns) {
		if (!p.usage.Pattern.has(p.name)) p.work.edits.set(p.s, { start: p.s, end: p.e, text: p.stroke ? '0 G' : '0 g' });
	}
	for (const w of ctx.streams.values()) {
		if (w.edits.size) w.obj.writeStream(applyEdits(w.bytes, [...w.edits.values()]));
	}
	for (const { dict, usage: u } of ctx.resources) pruneResources(doc, dict, u);
	// Soft masks are not rewritten: refuse when one could hold text or pictures.
	for (const gs of ctx.extGStates) {
		const smask = gs.get('SMask');
		if (smask.isNull() || !smask.resolve().isDictionary()) continue;
		const group = smask.resolve().get('G');
		if (group.isNull()) continue;
		if (containsTextOrImages(group, new Set(), 0)) {
			throw new EngineError(
				'unsupported',
				`Page ${pageNo} uses a transparency mask that contains text or pictures. It cannot be redacted reliably, so nothing was exported.`
			);
		}
	}
}

/** Makes `holder`'s /Resources a direct dictionary owned by `holder` (a shallow copy). */
function localResources(doc: Doc, holder: Obj, current: Obj): Obj {
	const copy = doc.newDictionary();
	const src = current.isNull() ? null : current.resolve();
	if (src?.isDictionary()) src.forEach((v, k) => copy.put(k as string, v));
	holder.put('Resources', copy);
	return holder.get('Resources');
}

function walkStream(ctx: PassCtx, ref: Obj, res: Obj, usage: Usage, state: GState[]) {
	const num = ref.asIndirect();
	let work = ctx.streams.get(num);
	if (!work) {
		work = { obj: ref, bytes: readBytes(ref), edits: new Map() };
		ctx.streams.set(num, work);
	}
	const w = work;
	const lexer = new Lexer(w.bytes, ctx.pageNo);
	const top = () => state[state.length - 1];
	let path = new PathRec();
	let clipPending = false;
	const pt = (x: number, y: number): Pt => applyMatrix(multiply(top().ctm, ctx.pageTf), x, y);
	const edit = (start: number, end: number, text: string) => w.edits.set(start, { start, end, text });
	const nums = (op: Op, n: number) => {
		const out: number[] = [];
		if (op.args.length < n) throw new ContentError(ctx.pageNo, `missing operands for ${op.op}`);
		for (let i = op.args.length - n; i < op.args.length; i++) {
			const a = op.args[i];
			if (a.k !== 'num') throw new ContentError(ctx.pageNo, `bad operands for ${op.op}`);
			out.push(a.v);
		}
		return out;
	};
	const nameArg = (op: Op, i: number) => {
		const a = op.args[i];
		return a && a.k === 'name' ? a.v : null;
	};
	const paint = (fill: boolean, stroke: boolean) => {
		for (const p of [fill ? top().fillPat : null, stroke ? top().strokePat : null]) {
			if (p && !p.used) {
				p.used = true;
				p.usage.Pattern.add(p.name);
			}
		}
	};
	const lookup = (kind: ResourceKind, name: string): Obj | null => {
		const dict = res.get(kind);
		if (dict.isNull()) return null;
		const v = dict.resolve().get(name);
		return v.isNull() ? null : v;
	};

	for (let op = lexer.next(); op; op = lexer.next()) {
		switch (op.op) {
			case 'q':
				state.push({ ...top() });
				break;
			case 'Q':
				if (state.length > 1) state.pop();
				break;
			case 'cm': {
				const [a, b, c, d, e, f] = nums(op, 6);
				top().ctm = multiply([a, b, c, d, e, f], top().ctm);
				break;
			}
			case 'm': {
				const [x, y] = nums(op, 2);
				path.moveTo(pt(x, y));
				break;
			}
			case 'l': {
				const [x, y] = nums(op, 2);
				path.lineTo(pt(x, y));
				break;
			}
			case 'c': {
				const v = nums(op, 6);
				path.curveTo([pt(v[0], v[1]), pt(v[2], v[3]), pt(v[4], v[5])]);
				break;
			}
			case 'v':
			case 'y': {
				const v = nums(op, 4);
				path.curveTo([pt(v[0], v[1]), pt(v[2], v[3])]);
				break;
			}
			case 'h':
				path.close();
				break;
			case 're': {
				const [x, y, wd, ht] = nums(op, 4);
				path.moveTo(pt(x, y));
				path.lineTo(pt(x + wd, y));
				path.lineTo(pt(x + wd, y + ht));
				path.lineTo(pt(x, y + ht));
				path.close();
				break;
			}
			case 'W':
			case 'W*':
				clipPending = true;
				break;
			case 'S':
			case 's':
			case 'f':
			case 'F':
			case 'f*':
			case 'B':
			case 'B*':
			case 'b':
			case 'b*':
			case 'n': {
				const p = path.bbox;
				if (op.op !== 'n') {
					const fill = !/^[Ss]$/.test(op.op);
					const stroke = /^([Ss]|[Bb]\*?)$/.test(op.op);
					const pattern = (fill && top().fillPat !== null) || (stroke && top().strokePat !== null);
					// Removed unless it is a plain rule/border/background (see the header).
					if (p && ctx.boxes.some((b) => touches(p, b, 0)) && (pattern || !path.keepable(ctx.boxes, fill))) {
						if (pattern) refuseLargeFill(ctx, intersect(p, top().clip ?? p));
						else if (visibleOutside(ctx, intersect(p, top().clip ?? p))) ctx.notes.drawings++;
						edit(op.s, op.e, 'n');
					}
					else paint(fill, stroke);
				}
				if (clipPending && p) {
					const c = top().clip;
					top().clip = c ? (intersect(c, p) ?? [p[0], p[1], p[0], p[1]]) : p;
				}
				path = new PathRec();
				clipPending = false;
				break;
			}
			case 'sh': {
				const name = nameArg(op, 0);
				const area = top().clip;
				if (!area || ctx.boxes.some((b) => touches(area, b, 0))) {
					refuseLargeFill(ctx, area);
					edit(op.args[0]?.s ?? op.s, op.e, '');
				}
				else if (name) usage.Shading.add(name);
				break;
			}
			case 'Do': {
				const name = nameArg(op, 0);
				if (!name) break;
				usage.XObject.add(name);
				const x = lookup('XObject', name);
				if (!x || !x.isIndirect()) break;
				const xo = x.resolve();
				const sub = xo.get('Subtype');
				if (!sub.isName() || sub.asName() !== 'Form') {
					paint(true, false);
					break;
				}
				// An image mask, or a form, may paint with the current colours.
				paint(true, true);
				const fnum = x.asIndirect();
				if (ctx.active.has(fnum)) break;
				if (ctx.active.size > 30) throw new ContentError(ctx.pageNo, 'forms nested too deeply');
				const ctm = multiply(readMatrix(xo.get('Matrix')), top().ctm);
				let clip = top().clip;
				const bbox = readRect(xo.get('BBox'));
				if (bbox) {
					const r = transformRect(multiply(ctm, ctx.pageTf), bbox);
					clip = clip ? (intersect(clip, r) ?? [r[0], r[1], r[0], r[1]]) : r;
				}
				if (fnum < ctx.preCount) {
					// MuPDF copies every form of a redacted page; an original one here must not need edits.
					if (formNeedsEdits(ctx, x, { ...top(), ctm, clip }, res, usage)) throw new ContentError(ctx.pageNo, 'a shared form needs edits');
					break;
				}
				ctx.active.add(fnum);
				const own = xo.get('Resources');
				let fres = res;
				let fusage = usage;
				if (!own.isNull()) {
					fres = localResources(ctx.doc, xo, own);
					fusage = newUsage();
					ctx.resources.push({ dict: fres, usage: fusage });
				}
				walkStream(ctx, x, fres, fusage, [{ ...top(), ctm, clip }]);
				ctx.active.delete(fnum);
				break;
			}
			case 'gs': {
				const name = nameArg(op, 0);
				if (!name) break;
				usage.ExtGState.add(name);
				const gs = lookup('ExtGState', name);
				if (gs && gs.resolve().isDictionary()) ctx.extGStates.push(gs.resolve());
				break;
			}
			case 'Tf': {
				const name = nameArg(op, 0);
				if (name) usage.Font.add(name);
				break;
			}
			case 'cs':
			case 'CS': {
				const name = nameArg(op, 0);
				if (name && !DEVICE_SPACES.has(name)) usage.ColorSpace.add(name);
				if (op.op === 'cs') top().fillPat = null;
				else top().strokePat = null;
				break;
			}
			case 'g':
			case 'rg':
			case 'k':
			case 'sc':
				top().fillPat = null;
				break;
			case 'G':
			case 'RG':
			case 'K':
			case 'SC':
				top().strokePat = null;
				break;
			case 'scn':
			case 'SCN': {
				const name = nameArg(op, op.args.length - 1);
				const stroke = op.op === 'SCN';
				let use: PatternUse | null = null;
				if (name) {
					use = { name, usage, work: w, s: op.args[0].s, e: op.e, stroke, used: false };
					ctx.patterns.push(use);
				}
				if (stroke) top().strokePat = use;
				else top().fillPat = use;
				break;
			}
			case 'Tj':
			case 'TJ':
			case "'":
			case '"':
				paint(true, true);
				break;
			case 'BDC':
			case 'DP': {
				const props = op.args[1];
				if (props?.k === 'dict') {
					const kept = props.v.filter((en) => KEEP_STRING_KEYS.has(en.key) || !hasText(en.val));
					if (kept.length !== props.v.length) {
						edit(props.s, props.e, `<<${kept.map((en) => latin1(w.bytes, en.ks, en.e)).join(' ')}>>`);
					}
				} else if (props?.k === 'name') {
					usage.Properties.add(props.v);
				}
				break;
			}
			case 'BI': {
				paint(true, false);
				const dict = op.args[0];
				if (dict?.k !== 'dict') break;
				for (const en of dict.v) {
					if ((en.key === 'CS' || en.key === 'ColorSpace') && en.val.k === 'name' && !DEVICE_SPACES.has(en.val.v)) {
						usage.ColorSpace.add(en.val.v);
					}
				}
				break;
			}
			default:
				break;
		}
	}
}

/**
 * Read-only walk of a form MuPDF did not copy: true when anything in it would need an
 * edit. A form without its own resources uses the caller's, so its names count there.
 */
function formNeedsEdits(ctx: PassCtx, ref: Obj, state: GState, parentRes: Obj, parentUsage: Usage): boolean {
	const shadow: PassCtx = { ...ctx, streams: new Map(), resources: [], extGStates: [], patterns: [], active: new Set(ctx.active) };
	shadow.active.add(ref.asIndirect());
	const own = ref.resolve().get('Resources');
	const res = own.isNull() ? parentRes : own.resolve();
	walkStream(shadow, ref, res, own.isNull() ? parentUsage : newUsage(), [state]);
	ctx.extGStates.push(...shadow.extGStates);
	return [...shadow.streams.values()].some((w) => w.edits.size > 0) || shadow.patterns.some((p) => !p.usage.Pattern.has(p.name));
}

function pruneResources(doc: Doc, res: Obj, usage: Usage) {
	for (const kind of RESOURCE_KINDS) {
		const sub = res.get(kind);
		if (sub.isNull()) continue;
		const dict = sub.resolve();
		if (!dict.isDictionary()) continue;
		const kept = doc.newDictionary();
		let count = 0;
		for (const name of usage[kind]) {
			const v = dict.get(name);
			if (v.isNull()) continue;
			kept.put(name, kind === 'Properties' ? strippedProperties(doc, v) : v);
			count++;
		}
		if (count) res.put(kind, kept);
		else res.delete(kind);
	}
}

/** A named marked-content property list without string values (layers are kept as they are). */
function strippedProperties(doc: Doc, v: Obj): Obj {
	const d = v.resolve();
	if (!d.isDictionary()) return v;
	const type = d.get('Type');
	if (type.isName() && (type.asName() === 'OCG' || type.asName() === 'OCMD')) return v;
	let leaks = false;
	d.forEach((val, k) => {
		if (!KEEP_STRING_KEYS.has(k as string) && objHasString(val, 0)) leaks = true;
	});
	if (!leaks) return v;
	const copy = doc.newDictionary();
	d.forEach((val, k) => {
		if (KEEP_STRING_KEYS.has(k as string) || !objHasString(val, 0)) copy.put(k as string, val);
	});
	return copy;
}

function objHasString(o: Obj, depth: number): boolean {
	if (depth > 6) return false;
	const v = o.isIndirect() ? o.resolve() : o;
	if (v.isString()) return true;
	if (!(v.isArray() || v.isDictionary())) return false;
	let found = false;
	v.forEach((val) => {
		if (!found && objHasString(val, depth + 1)) found = true;
	});
	return found;
}

/** Static scan: does this form (a soft-mask group) draw text or images, directly or in nested forms? */
function containsTextOrImages(ref: Obj, seen: Set<number>, depth: number): boolean {
	if (depth > 20) return true;
	if (ref.isIndirect()) {
		if (seen.has(ref.asIndirect())) return false;
		seen.add(ref.asIndirect());
	}
	if (!ref.isStream()) return false;
	try {
		const data = readBytes(ref);
		const res = ref.resolve().get('Resources');
		const lexer = new Lexer(data, 0);
		for (let op = lexer.next(); op; op = lexer.next()) {
			if (op.op === 'Tj' || op.op === 'TJ' || op.op === "'" || op.op === '"' || op.op === 'BI') return true;
			if (op.op !== 'Do') continue;
			const a = op.args[0];
			if (a?.k !== 'name' || res.isNull()) return true;
			const xs = res.resolve().get('XObject');
			const xo = xs.isNull() ? null : xs.resolve().get(a.v);
			if (!xo || xo.isNull()) continue;
			const sub = xo.resolve().get('Subtype');
			if (!sub.isName() || sub.asName() !== 'Form') return true;
			if (containsTextOrImages(xo, seen, depth + 1)) return true;
		}
	} catch (e) {
		rethrowFault(e);
		// Unreadable (e.g. a binary inline image): assume the worst.
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Annotations, black boxes

function removeAnnotations(doc: Doc, pageObj: Obj, pageTf: Matrix, boxes: Rect[]) {
	const annots = pageObj.get('Annots');
	if (annots.isNull()) return;
	const arr = annots.resolve();
	if (!arr.isArray()) return;
	const entries: Obj[] = [];
	for (let i = 0; i < arr.length; i++) entries.push(arr.get(i));
	const removed = new Set<number>();
	const keyOf = (o: Obj) => (o.isIndirect() ? o.asIndirect() : -1);
	// Without a usable /Rect we cannot tell where it is, so it goes.
	const under = (d: Obj) => {
		const rect = readRect(d.get('Rect'));
		return !rect || boxes.some((b) => touches(transformRect(pageTf, rect), b, 0));
	};
	// A popup's /Parent or a reply's /IRT may point at a copy of the annotation that is not
	// the object in /Annots (qpdf copies them when assembling), so targets are judged by
	// identity and by where they are.
	// (A widget's /Parent is its field, not an annotation: only annotations are judged by place.)
	const isRemoved = (o: Obj) => {
		if (o.isNull()) return false;
		if (o.isIndirect() && removed.has(o.asIndirect())) return true;
		const d = o.resolve();
		return d.isDictionary() && !d.get('Subtype').isNull() && under(d);
	};
	const drop: boolean[] = entries.map((e) => {
		const hit = under(e.resolve());
		if (hit && keyOf(e) >= 0) removed.add(keyOf(e));
		return hit;
	});
	// Popups of removed annotations and replies to them, until nothing changes.
	for (let changed = true; changed; ) {
		changed = false;
		entries.forEach((e, i) => {
			if (drop[i]) return;
			const d = e.resolve();
			if (isRemoved(d.get('Parent')) || isRemoved(d.get('IRT'))) {
				drop[i] = true;
				if (keyOf(e) >= 0) removed.add(keyOf(e));
				changed = true;
			}
		});
	}
	if (!drop.some(Boolean)) return;
	const kept = doc.newArray();
	entries.forEach((e, i) => {
		if (!drop[i]) kept.push(e);
	});
	if (kept.length) pageObj.put('Annots', kept);
	else pageObj.delete('Annots');
	removeFields(doc, removed);
}

/** Takes removed widgets out of the AcroForm field tree (and parents left without kids). */
function removeFields(doc: Doc, removed: Set<number>) {
	if (removed.size === 0) return;
	const form = doc.getTrailer().get('Root').get('AcroForm');
	if (form.isNull()) return;
	const f = form.resolve();
	const isGone = (node: Obj) => node.isIndirect() && removed.has(node.asIndirect());
	const prune = (arr: Obj, depth: number): Obj => {
		const out = doc.newArray();
		for (let i = 0; i < arr.length; i++) {
			const node = arr.get(i);
			if (isGone(node)) continue;
			const kids = node.resolve().get('Kids');
			if (depth < 30 && !kids.isNull() && kids.resolve().isArray()) {
				const left = prune(kids.resolve(), depth + 1);
				if (left.length === 0) {
					if (node.isIndirect()) removed.add(node.asIndirect());
					continue;
				}
				node.resolve().put('Kids', left);
			}
			out.push(node);
		}
		return out;
	};
	const fields = f.get('Fields');
	if (!fields.isNull() && fields.resolve().isArray()) f.put('Fields', prune(fields.resolve(), 0));
	const co = f.get('CO');
	if (!co.isNull() && co.resolve().isArray()) {
		const out = doc.newArray();
		const arr = co.resolve();
		for (let i = 0; i < arr.length; i++) if (!isGone(arr.get(i))) out.push(arr.get(i));
		f.put('CO', out);
	}
}

function paintBlack(doc: Doc, pageObj: Obj, pageTf: Matrix, boxes: Rect[]) {
	const inv = invert(pageTf);
	const rects = boxes
		.map((b) => {
			const u = transformRect(inv, b);
			return `${n4(u[0])} ${n4(u[1])} ${n4(u[2] - u[0])} ${n4(u[3] - u[1])} re f`;
		})
		.join('\n');
	const head = doc.addStream('q\n', doc.newDictionary());
	const tail = doc.addStream(`\nQ\nq 0 g\n${rects}\nQ\n`, doc.newDictionary());
	const contents = pageObj.get('Contents');
	const arr = doc.newArray();
	arr.push(head);
	if (contents.isArray()) {
		const a = contents.resolve();
		for (let i = 0; i < a.length; i++) arr.push(a.get(i));
	} else if (!contents.isNull()) arr.push(contents);
	arr.push(tail);
	pageObj.put('Contents', arr);
}

// ---------------------------------------------------------------------------
// The check

interface CheckOptions {
	allowed: string[][];
	password?: string;
	/** Stage check: nothing of ours is on the page yet except the black boxes. */
	strict: boolean;
	imagesReencoded?: boolean;
}

async function checkRedactions(deps: EngineDeps, bytes: Uint8Array, jobs: RedactJob[], opts: CheckOptions): Promise<VerifyCheck[]> {
	const m = await deps.mupdf();
	const problems: string[] = [];
	let doc: Doc | null = null;
	try {
		doc = openDoc(m, bytes, opts.password);
		if (hasOptionalContent(doc)) {
			const plain = withoutOptionalContent(m, doc);
			destroy(doc);
			doc = plain;
		}
		for (const [ji, job] of jobs.entries()) {
			const pageNo = job.pageIndex + 1;
			if (job.pageIndex >= doc.countPages()) {
				problems.push(`Page ${pageNo} is missing, so its redactions cannot be checked.`);
				continue;
			}
			const page = doc.loadPage(job.pageIndex);
			try {
				const b = page.getBounds() as Rect;
				if (Math.abs(b[2] - b[0] - job.expected.width) > SIZE_TOLERANCE || Math.abs(b[3] - b[1] - job.expected.height) > SIZE_TOLERANCE) {
					problems.push(`Page ${pageNo} is not the planned size, so its redactions cannot be checked.`);
					continue;
				}
				const boxes = job.boxes.map((s) => fractionRect(b, s));
				const overlays = opts.strict ? [] : (job.overlays ?? []).map((s) => pad(fractionRect(b, s), 1));
				problems.push(
					...checkPageMupdf(m, page, pageNo, boxes, opts.strict ? [] : (opts.allowed[ji] ?? []), overlays, opts.strict, opts.imagesReencoded === true)
				);
			} finally {
				destroy(page);
			}
		}
	} catch (e) {
		rethrowFault(e);
		problems.push(`MuPDF could not check the redactions (${e instanceof Error ? e.message : String(e)}).`);
	} finally {
		if (doc) destroy(doc);
	}
	try {
		problems.push(...(await checkPdfjs(await deps.pdfjs(), bytes, jobs, opts.strict ? [] : opts.allowed, opts.password)));
	} catch (e) {
		problems.push(`PDF.js could not check the redactions (${e instanceof Error ? e.message : String(e)}).`);
	}
	if (isRetired(m)) throw new EngineError('internal', 'The PDF engine had to restart. Try again.');
	if (problems.length) return problems.map((detail) => ({ name: 'redaction', ok: false, detail }));
	const areas = jobs.reduce((n, j) => n + j.boxes.length, 0);
	return [
		{
			name: 'redaction',
			ok: true,
			detail: `${areas} ${areas === 1 ? 'area' : 'areas'} redacted on ${jobs.length} ${jobs.length === 1 ? 'page' : 'pages'}; no text, pictures, drawings or annotations remain under them.`
		}
	];
}

function checkPageMupdf(
	m: Mupdf,
	page: MU.PDFPage,
	pageNo: number,
	boxes: Rect[],
	allowedText: string[],
	overlays: Rect[],
	strict: boolean,
	imagesReencoded: boolean
): string[] {
	const problems: string[] = [];
	const allowedRegions: Rect[] = [...overlays];

	// Text (MuPDF structured text), with our own stamp text allowed. A character is under
	// a box when its ink touches the box (see readChars; a nominal quad that only reaches
	// in from the next line hides nothing).
	let textHits = 0;
	const lines = new Map<number, CharBox[]>();
	for (const ch of readChars(page)) {
		const l = lines.get(ch.line);
		if (l) l.push(ch);
		else lines.set(ch.line, [ch]);
	}
	for (const chars of lines.values()) {
		const ok = allowedMask(
			chars.map((x) => x.c),
			allowedText
		);
		chars.forEach((ch, i) => {
			if (ok[i]) {
				allowedRegions.push(pad(ch.nominal, 1.5));
				if (ch.ink) allowedRegions.push(pad(ch.ink, 1.5));
				return;
			}
			if (ch.c.trim() === '' || !ch.ink) return;
			const ink = ch.ink;
			if (boxes.some((b) => touches(ink, b, 0.01))) textHits++;
		});
	}
	if (textHits) problems.push(`Page ${pageNo}: MuPDF still reads text under a redaction box.`);

	// Everything the interpreter draws (contents and annotations).
	const inAllowed = (r: Rect) => allowedRegions.some((a) => inside(r, a));
	const found = { glyphs: 0, paths: 0, shades: 0, images: 0 };
	runDevice(m, page, {
		glyph: (g) => {
			if (g.space) return;
			if (boxes.some((b) => touches(g.core, b, 0.01)) && !inAllowed(g.core)) found.glyphs++;
		},
		path: (r, info) => {
			if (!boxes.some((b) => touches(r, b, 0.01))) return;
			if (info.blackRect && boxes.some((b) => inside(r, pad(b, 0.01)))) return;
			if (info.keep(boxes)) return;
			if (!strict && inAllowed(r)) return;
			found.paths++;
		},
		shade: (area) => {
			if (boxes.some((b) => touches(area, b, 0.01))) found.shades++;
		},
		tile: (area) => {
			if (boxes.some((b) => touches(area, b, 0.01))) found.shades++;
		},
		image: (image, ctm, bounds) => {
			if (!boxes.some((b) => touches(bounds, b, 0.01))) return;
			if (!strict && inAllowed(bounds)) return;
			if (!imageBlankUnder(image, ctm, boxes, imagesReencoded ? FINAL_IMAGE_INSET : 0)) found.images++;
		}
	});
	if (found.glyphs) problems.push(`Page ${pageNo}: text is still drawn under a redaction box.`);
	if (found.paths) problems.push(`Page ${pageNo}: drawings are still present under a redaction box.`);
	if (found.shades) problems.push(`Page ${pageNo}: a colour gradient or pattern is still drawn under a redaction box.`);
	if (found.images) problems.push(`Page ${pageNo}: picture data under a redaction box was not removed.`);

	// Annotations, links and form fields.
	const tf = page.getTransform() as Matrix;
	const annots = page.getObject().get('Annots');
	if (!annots.isNull()) {
		const arr = annots.resolve();
		let hits = 0;
		for (let i = 0; arr.isArray() && i < arr.length; i++) {
			const rect = readRect(arr.get(i).resolve().get('Rect'));
			if (!rect || boxes.some((b) => touches(transformRect(tf, rect), b, 0.01))) hits++;
		}
		if (hits) {
			problems.push(
				`Page ${pageNo}: ${hits === 1 ? 'an annotation, link or form field still overlaps' : `${hits} annotations, links or form fields still overlap`} a redaction box.`
			);
		}
	}

	// The boxes render black.
	const share = blackShare(m, page, boxes, strict ? [] : allowedRegions);
	if (strict ? share < 1 : share < 0.995) {
		problems.push(`Page ${pageNo}: a redaction box is not solid black (${r2(share * 100)}% black).`);
	}
	return problems;
}

/** Share of rendered pixels inside the boxes (inset 1 px, outside `skip`) that are black. */
function blackShare(m: Mupdf, page: MU.PDFPage, boxes: Rect[], skip: Rect[]): number {
	const bounds = page.getBounds() as Rect;
	const area = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
	const scale = Math.max(0.25, Math.min(2, Math.sqrt(8e6 / Math.max(area, 1))));
	const pix = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, true);
	try {
		const w = pix.getWidth();
		const h = pix.getHeight();
		const stride = pix.getStride();
		const n = pix.getNumberOfComponents() + pix.getAlpha();
		const data = pix.getPixels();
		const ox = pix.getX();
		const oy = pix.getY();
		let checked = 0;
		let light = 0;
		for (const b of boxes) {
			const x0 = Math.max(0, Math.ceil(b[0] * scale - ox) + 1);
			const y0 = Math.max(0, Math.ceil(b[1] * scale - oy) + 1);
			const x1 = Math.min(w, Math.floor(b[2] * scale - ox) - 1);
			const y1 = Math.min(h, Math.floor(b[3] * scale - oy) - 1);
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					if (skip.length) {
						const cx = (x + ox + 0.5) / scale;
						const cy = (y + oy + 0.5) / scale;
						if (skip.some((a) => cx >= a[0] && cx <= a[2] && cy >= a[1] && cy <= a[3])) continue;
					}
					const o = y * stride + x * n;
					checked++;
					if (data[o] > 40 || data[o + 1] > 40 || data[o + 2] > 40) light++;
				}
			}
		}
		return checked ? 1 - light / checked : 1;
	} finally {
		destroy(pix);
	}
}

/** For each character of a line: is it part of an occurrence of an allowed string? */
function allowedMask(chars: string[], allowed: string[]): boolean[] {
	const ok = chars.map(() => false);
	if (!allowed.length) return ok;
	const text = chars.join('');
	const starts: number[] = [];
	let pos = 0;
	for (const c of chars) {
		starts.push(pos);
		pos += c.length;
	}
	for (const a of allowed) {
		const needle = a.trim();
		if (!needle) continue;
		for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
			const end = at + needle.length;
			starts.forEach((s, i) => {
				if (s >= at && s < end) ok[i] = true;
			});
		}
	}
	return ok;
}

/**
 * Stored pixels (and soft-mask values) of an image under the boxes are uniform (all
 * within ±2 of one value): the data holds no picture there. A pixel counts by its
 * middle half (a pixel only grazed by a box is mostly visible outside it anyway).
 *
 * On the final file, compress-to-target may have resampled and JPEG-encoded the
 * image after the stage proved its pixels under the box flat. The re-encoded data
 * is computed only from that proven data, so no structure from before redaction can
 * come back; but next to the box edge, resampling and 16×16 JPEG blocks (4:2:0) mix
 * the flat area with the visible picture beside it. So when (and only when) images
 * were re-encoded, pixels within FINAL_IMAGE_INSET of the area's edge are not
 * compared on the final file, and everything
 * deeper must still be flat within ±2 (an honest encoder turns a flat area into
 * flat blocks; there is no wider "JPEG tolerance"). The proof for the band at the
 * edge is the stage's own check of the same data before re-encoding.
 */
function imageBlankUnder(image: MU.Image, ctm: Matrix, boxes: Rect[], inset: number): boolean {
	const check = (img: MU.Image): boolean => {
		const pix = img.toPixmap();
		try {
			const w = pix.getWidth();
			const h = pix.getHeight();
			const stride = pix.getStride();
			const n = w > 0 ? Math.max(1, Math.round(stride / w)) : 1;
			const data = pix.getPixels();
			const inv = invert(ctm);
			const tol = 2;
			for (const b of boxes) {
				const u = transformRect(inv, b);
				const xa = Math.max(0, Math.floor(u[0] * w) - 1);
				const xb = Math.min(w, Math.ceil(u[2] * w) + 1);
				const ya = Math.max(0, Math.floor(u[1] * h) - 1);
				const yb = Math.min(h, Math.ceil(u[3] * h) + 1);
				let cells: [number, number][] = [];
				for (let y = ya; y < yb; y++) {
					for (let x = xa; x < xb; x++) {
						const cell = transformRect(ctm, [(x + 0.25) / w, (y + 0.25) / h, (x + 0.75) / w, (y + 0.75) / h]);
						if (touches(cell, b, 0)) cells.push([x, y]);
					}
				}
				if (inset) {
					const set = new Set(cells.map(([x, y]) => y * w + x));
					cells = cells.filter(([x, y]) => {
						for (const dy of [-inset, 0, inset]) {
							for (const dx of [-inset, 0, inset]) {
								if (x + dx < 0 || x + dx >= w || !set.has((y + dy) * w + (x + dx))) return false;
							}
						}
						return true;
					});
				}
				let ref: number[] | null = null;
				for (const [x, y] of cells) {
					const o = y * stride + x * n;
					if (!ref) {
						ref = Array.from(data.subarray(o, o + n));
						continue;
					}
					for (let k = 0; k < n; k++) if (Math.abs(data[o + k] - ref[k]) > tol) return false;
				}
			}
			return true;
		} finally {
			destroy(pix);
		}
	};
	if (!check(image)) return false;
	const mask = image.getMask();
	return mask ? check(mask) : true;
}

async function checkPdfjs(lib: PdfjsLib, bytes: Uint8Array, jobs: RedactJob[], allowed: string[][], password?: string): Promise<string[]> {
	const problems: string[] = [];
	const task = lib.getDocument({
		data: bytes.slice(),
		password,
		useWasm: false,
		useWorkerFetch: false,
		useSystemFonts: false,
		disableFontFace: true,
		enableXfa: false,
		stopAtErrors: true,
		verbosity: 0
	});
	try {
		const doc = await task.promise;
		for (const [ji, job] of jobs.entries()) {
			const page = await doc.getPage(job.pageIndex + 1);
			const vp = page.getViewport({ scale: 1 });
			const tc = await page.getTextContent();
			const ok = (allowed[ji] ?? []).map(normalizeSpace).filter(Boolean);
			const eps = 0.25 / Math.max(vp.width, vp.height);
			let hits = 0;
			for (const it of tc.items) {
				if (!('str' in it)) continue;
				const str = normalizeSpace(it.str);
				if (!str || ok.some((a) => a.includes(str))) continue;
				const t = it.transform as number[];
				const dir = unit(t[0], t[1]);
				const up = unit(t[2], t[3]);
				const height = it.height || Math.hypot(t[2], t[3]);
				const pts: [number, number][] = [];
				for (const along of [0, it.width]) {
					for (const across of [0, PDFJS_CORE * height]) {
						pts.push(applyMatrix(vp.transform as Matrix, t[4] + dir[0] * along + up[0] * across, t[5] + dir[1] * along + up[1] * across));
					}
				}
				const r: Rect = [
					Math.min(...pts.map((p) => p[0])) / vp.width,
					Math.min(...pts.map((p) => p[1])) / vp.height,
					Math.max(...pts.map((p) => p[0])) / vp.width,
					Math.max(...pts.map((p) => p[1])) / vp.height
				];
				if (job.boxes.some((s) => touches(r, [s.x, s.y, s.x + s.w, s.y + s.h], eps))) hits++;
			}
			if (hits) problems.push(`Page ${job.pageIndex + 1}: PDF.js still reads text under a redaction box.`);
			page.cleanup();
		}
	} finally {
		await task.destroy().catch(() => undefined);
	}
	return problems;
}

// ---------------------------------------------------------------------------
// MuPDF device pass

interface GlyphInfo {
	/** Advance × [-0.25, 1] em. */
	em: Rect;
	/** The middle of the glyph's nominal box (its true advance, which may be 0): what to redact to remove it. */
	mark: Rect;
	/** Middle 80% of the advance × [0, 0.6] em: for the check. */
	core: Rect;
	space: boolean;
}
interface DeviceHandlers {
	glyph?: (g: GlyphInfo) => void;
	path?: (bounds: Rect, info: { blackRect: boolean; keep: (boxes: Rect[]) => boolean }) => void;
	shade?: (area: Rect) => void;
	tile?: (area: Rect) => void;
	image?: (image: MU.Image, ctm: Matrix, bounds: Rect) => void;
}

const INFINITE: Rect = [-1e9, -1e9, 1e9, 1e9];
/**
 * PDF.js check: a text item counts from its baseline up to this share of its height
 * (the same band as the device pass's glyph core). Ink above it (the top of capitals,
 * at 0.66 to 0.72 em) is MuPDF's outline check's job; at 0.75 the PDF.js band reached
 * into a box drawn tightly over the line above while no ink of the item did, and the
 * export was refused.
 */
const PDFJS_CORE = 0.6;
/** Image pixels next to a box edge not compared on the final file (see imageBlankUnder). */
const FINAL_IMAGE_INSET = 16;
const SPACES = new Set([9, 10, 13, 32, 0xa0]);

function runDevice(m: Mupdf, page: MU.PDFPage, h: DeviceHandlers) {
	const clips: Rect[] = [INFINITE];
	const clip = () => clips[clips.length - 1];
	const pushClip = (r: Rect) => clips.push(intersect(clip(), r) ?? [r[0], r[1], r[0], r[1]]);
	const zero = new m.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 0, miterLimit: 10 });
	const glyphs = (text: MU.Text, ctm: Matrix) => {
		const on = h.glyph;
		if (!on) return;
		text.walk({
			showGlyph(font, trm, glyph, unicode, wmode) {
				const advance = font.advanceGlyph(glyph, wmode) || 0;
				const adv = advance || 0.5;
				const full = multiply(trm as Matrix, ctm);
				const em: Rect = wmode ? [-0.5, -adv, 0.5, 0] : [0, -0.25, adv, 1];
				const core: Rect = wmode ? [-0.3, -adv * 0.9, 0.3, -adv * 0.1] : [adv * 0.1, 0, adv * 0.9, 0.6];
				const mark: Rect = wmode ? [-0.2, -advance * 0.75, 0.2, -advance * 0.25] : [advance * 0.25, 0.15, advance * 0.75, 0.45];
				on({ em: transformRect(full, em), core: transformRect(full, core), mark: transformRect(full, mark), space: SPACES.has(unicode) });
			}
		});
	};
	const imageBounds = (ctm: Matrix) => transformRect(ctm, [0, 0, 1, 1]);
	const isBlack = (cs: MU.ColorSpace, color: number[]) => {
		const name = cs?.getName?.() ?? '';
		if (/CMYK/i.test(name)) return color.length === 4 && color[0] === 0 && color[1] === 0 && color[2] === 0 && color[3] === 1;
		return color.length > 0 && color.every((c) => c === 0);
	};
	const dev = new m.Device({
		fillPath(path, _eo, ctm, cs, color, alpha) {
			if (!h.path) return;
			const b = pathBounds(path, ctm as Matrix);
			const rec = recordPath(path, ctm as Matrix);
			if (b) h.path(b, { blackRect: alpha === 1 && isBlack(cs, color) && isAxisRect(path, ctm as Matrix), keep: (boxes) => rec.keepable(boxes, true) });
		},
		strokePath(path, _s, ctm) {
			if (!h.path) return;
			const b = pathBounds(path, ctm as Matrix);
			const rec = recordPath(path, ctm as Matrix);
			if (b) h.path(b, { blackRect: false, keep: (boxes) => rec.keepable(boxes, false) });
		},
		clipPath(path, _eo, ctm) {
			pushClip(pathBounds(path, ctm as Matrix) ?? [0, 0, 0, 0]);
		},
		clipStrokePath(path, s, ctm) {
			pushClip(path.getBounds(s, ctm) as Rect);
		},
		fillText(text, ctm) {
			glyphs(text, ctm as Matrix);
		},
		strokeText(text, _s, ctm) {
			glyphs(text, ctm as Matrix);
		},
		clipText(text, ctm) {
			glyphs(text, ctm as Matrix);
			pushClip(text.getBounds(zero, ctm) as Rect);
		},
		clipStrokeText(text, s, ctm) {
			glyphs(text, ctm as Matrix);
			pushClip(text.getBounds(s, ctm) as Rect);
		},
		ignoreText(text, ctm) {
			glyphs(text, ctm as Matrix);
		},
		fillShade(shade) {
			// mupdf.js wraps the device's borrowed shade without taking a reference, so the
			// wrapper's finalizer would free a shade MuPDF still owns (a heap corruption that
			// surfaced later as "memory access out of bounds"). Keep the wrapper from dropping it.
			disown(shade);
			h.shade?.(clip());
		},
		fillImage(image, ctm) {
			h.image?.(image, ctm as Matrix, imageBounds(ctm as Matrix));
		},
		fillImageMask(image, ctm) {
			h.image?.(image, ctm as Matrix, imageBounds(ctm as Matrix));
		},
		clipImageMask(image, ctm) {
			h.image?.(image, ctm as Matrix, imageBounds(ctm as Matrix));
			pushClip(imageBounds(ctm as Matrix));
		},
		popClip() {
			if (clips.length > 1) clips.pop();
		},
		endMask() {
			// The mask now acts as a clip until its popClip.
			clips.push(clip());
		},
		beginTile(area, _view, _xs, _ys, ctm) {
			const r = transformRect(ctm as Matrix, area as Rect);
			h.tile?.(intersect(clip(), r) ?? [r[0], r[1], r[0], r[1]]);
			return 0;
		}
	});
	try {
		page.run(dev, m.Matrix.identity);
		dev.close();
	} finally {
		destroy(dev);
		destroy(zero);
	}
}

type Pt = [number, number];

/**
 * A path in page space, recorded segment by segment, and the rule that decides
 * whether it may stay when it touches a box (see the header, "Kept drawings").
 */
class PathRec {
	bbox: Rect | null = null;
	private subs: { pts: Pt[]; closed: boolean }[] = [];
	private curves = false;
	private add(p: Pt) {
		this.bbox = this.bbox ? union(this.bbox, [p[0], p[1], p[0], p[1]]) : [p[0], p[1], p[0], p[1]];
	}
	private current() {
		return this.subs[this.subs.length - 1];
	}
	moveTo(p: Pt) {
		this.add(p);
		this.subs.push({ pts: [p], closed: false });
	}
	lineTo(p: Pt) {
		this.add(p);
		const c = this.current();
		if (c && !c.closed) c.pts.push(p);
		else this.subs.push({ pts: [c ? c.pts[0] : p, p], closed: false });
	}
	curveTo(ps: Pt[]) {
		this.curves = true;
		for (const p of ps) this.add(p);
		this.lineTo(ps[ps.length - 1]);
	}
	close() {
		const c = this.current();
		if (!c) return;
		c.closed = true;
		// After h, drawing continues from the subpath's start in a new subpath.
		this.subs.push({ pts: [c.pts[0]], closed: false });
	}
	/**
	 * True when every piece of this path under any box is the straight continuation of
	 * pieces outside it: no curves, and every segment that enters a box's interior is
	 * horizontal or vertical and runs right through the box (both ends outside, across
	 * its full width or height). Fills close their subpaths, so a filled rectangle is
	 * judged by its four edges.
	 */
	keepable(boxes: Rect[], fill: boolean): boolean {
		if (this.curves) return !boxes.some((b) => this.bbox && touches(this.bbox, b, 0));
		const e = 0.01;
		for (const sp of this.subs) {
			const pts = sp.closed || fill ? [...sp.pts, sp.pts[0]] : sp.pts;
			// A lone point (a dot with round caps) counts as a zero-length segment.
			const segs: [Pt, Pt][] = pts.length === 1 ? [[pts[0], pts[0]]] : pts.slice(1).map((q, i) => [pts[i], q] as [Pt, Pt]);
			for (const [a, c] of segs) {
				const r: Rect = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
				for (const b of boxes) {
					if (!touches(r, b, 0)) continue;
					const horizontal = r[3] - r[1] <= e;
					const vertical = r[2] - r[0] <= e;
					if (horizontal && !vertical && r[0] < b[0] - e && r[2] > b[2] + e) continue;
					if (vertical && !horizontal && r[1] < b[1] - e && r[3] > b[3] + e) continue;
					return false;
				}
			}
		}
		return true;
	}
}

/** Records a MuPDF path (with its transform) as a PathRec. */
function recordPath(path: MU.Path, ctm: Matrix): PathRec {
	const rec = new PathRec();
	path.walk({
		moveTo: (x, y) => rec.moveTo(applyMatrix(ctm, x, y)),
		lineTo: (x, y) => rec.lineTo(applyMatrix(ctm, x, y)),
		curveTo: (x1, y1, x2, y2, x3, y3) => rec.curveTo([applyMatrix(ctm, x1, y1), applyMatrix(ctm, x2, y2), applyMatrix(ctm, x3, y3)]),
		closePath: () => rec.close()
	});
	return rec;
}

/** Bounding box of a path's points and control points (its geometry, no stroke width). */
function pathBounds(path: MU.Path, ctm: Matrix): Rect | null {
	let r: Rect | null = null;
	const add = (x: number, y: number) => {
		const [px, py] = applyMatrix(ctm, x, y);
		r = r ? union(r, [px, py, px, py]) : [px, py, px, py];
	};
	path.walk({
		moveTo: add,
		lineTo: add,
		curveTo(x1, y1, x2, y2, x3, y3) {
			add(x1, y1);
			add(x2, y2);
			add(x3, y3);
		}
	});
	return r;
}

function isAxisRect(path: MU.Path, ctm: Matrix): boolean {
	const pts: [number, number][] = [];
	let curves = false;
	let moves = 0;
	path.walk({
		moveTo(x, y) {
			moves++;
			pts.push(applyMatrix(ctm, x, y));
		},
		lineTo(x, y) {
			pts.push(applyMatrix(ctm, x, y));
		},
		curveTo() {
			curves = true;
		}
	});
	if (curves || moves !== 1 || pts.length < 4 || pts.length > 5) return false;
	const xs = new Set(pts.map((p) => Math.round(p[0] * 100)));
	const ys = new Set(pts.map((p) => Math.round(p[1] * 100)));
	return xs.size <= 2 && ys.size <= 2;
}

// ---------------------------------------------------------------------------
// Content-stream tokenizer (enough for MuPDF's own output and plain content)

interface Entry {
	key: string;
	/** Start of the key, end of the value: the entry's bytes. */
	ks: number;
	e: number;
	val: Val;
}
type Val =
	| { k: 'num'; v: number; s: number; e: number }
	| { k: 'name'; v: string; s: number; e: number }
	| { k: 'str'; s: number; e: number }
	| { k: 'arr'; v: Val[]; s: number; e: number }
	| { k: 'dict'; v: Entry[]; s: number; e: number }
	| { k: 'kw'; v: string; s: number; e: number };
interface Op {
	op: string;
	args: Val[];
	/** Span of the operator keyword (for BI: the whole inline image). */
	s: number;
	e: number;
}

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

class Lexer {
	private i = 0;
	constructor(
		private readonly d: Uint8Array,
		private readonly pageNo: number
	) {}

	private fail(what: string): never {
		throw new ContentError(this.pageNo, what);
	}

	private skip() {
		const d = this.d;
		while (this.i < d.length) {
			const c = d[this.i];
			if (WS[c]) this.i++;
			else if (c === 0x25) while (this.i < d.length && d[this.i] !== 10 && d[this.i] !== 13) this.i++;
			else break;
		}
	}

	/** Next operator with its operands, or null at the end. */
	next(): Op | null {
		const args: Val[] = [];
		for (;;) {
			this.skip();
			if (this.i >= this.d.length) {
				if (args.length) this.fail('operands without operator');
				return null;
			}
			const v = this.value(0);
			if (v.k !== 'kw' || v.v === 'true' || v.v === 'false' || v.v === 'null') {
				args.push(v);
				if (args.length > 64) this.fail('too many operands');
				continue;
			}
			if (v.v === 'BI') return this.inlineImage(v.s);
			return { op: v.v, args, s: v.s, e: v.e };
		}
	}

	private value(depth: number): Val {
		if (depth > 64) this.fail('nesting too deep');
		const d = this.d;
		const s = this.i;
		const c = d[s];
		if (c === 0x28) {
			let nest = 0;
			while (this.i < d.length) {
				const ch = d[this.i++];
				if (ch === 0x5c) this.i++;
				else if (ch === 0x28) nest++;
				else if (ch === 0x29 && --nest === 0) return { k: 'str', s, e: this.i };
			}
			this.fail('unterminated string');
		}
		if (c === 0x3c) {
			if (d[s + 1] === 0x3c) {
				this.i += 2;
				const entries: Entry[] = [];
				for (;;) {
					this.skip();
					if (this.i >= d.length) this.fail('unterminated dictionary');
					if (d[this.i] === 0x3e && d[this.i + 1] === 0x3e) {
						this.i += 2;
						return { k: 'dict', v: entries, s, e: this.i };
					}
					const key = this.value(depth + 1);
					if (key.k !== 'name') this.fail('dictionary key');
					this.skip();
					const val = this.value(depth + 1);
					entries.push({ key: key.v, ks: key.s, e: val.e, val });
				}
			}
			const end = d.indexOf(0x3e, s);
			if (end < 0) this.fail('unterminated hex string');
			this.i = end + 1;
			return { k: 'str', s, e: this.i };
		}
		if (c === 0x5b) {
			this.i++;
			const items: Val[] = [];
			for (;;) {
				this.skip();
				if (this.i >= d.length) this.fail('unterminated array');
				if (d[this.i] === 0x5d) {
					this.i++;
					return { k: 'arr', v: items, s, e: this.i };
				}
				items.push(this.value(depth + 1));
			}
		}
		if (c === 0x2f) {
			this.i++;
			while (this.i < d.length && !WS[d[this.i]] && !DELIM[d[this.i]]) this.i++;
			const raw = latin1(d, s + 1, this.i).replace(/#([0-9a-fA-F]{2})/g, (_m, hx: string) => String.fromCharCode(parseInt(hx, 16)));
			return { k: 'name', v: raw, s, e: this.i };
		}
		if (DELIM[c]) this.fail(`unexpected ${String.fromCharCode(c)}`);
		while (this.i < d.length && !WS[d[this.i]] && !DELIM[d[this.i]]) this.i++;
		const word = latin1(d, s, this.i);
		if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { k: 'num', v: Number(word), s, e: this.i };
		return { k: 'kw', v: word, s, e: this.i };
	}

	/** BI <key value>* ID <data> EI. Data must be ASCIIHex or ASCII85 (MuPDF always writes ASCIIHex). */
	private inlineImage(start: number): Op {
		const d = this.d;
		const entries: Entry[] = [];
		for (;;) {
			this.skip();
			if (this.i >= d.length) this.fail('unterminated inline image');
			const key = this.value(1);
			if (key.k === 'kw' && key.v === 'ID') break;
			if (key.k !== 'name') this.fail('inline image key');
			this.skip();
			const val = this.value(1);
			entries.push({ key: key.v, ks: key.s, e: val.e, val });
		}
		const filter = entries.find((en) => en.key === 'F' || en.key === 'Filter')?.val;
		const first = filter?.k === 'name' ? filter.v : filter?.k === 'arr' && filter.v[0]?.k === 'name' ? filter.v[0].v : null;
		this.i++; // the single whitespace after ID
		let end = 0;
		if (first === 'AHx' || first === 'ASCIIHexDecode') {
			end = d.indexOf(0x3e, this.i) + 1;
		} else if (first === 'A85' || first === 'ASCII85Decode') {
			for (let at = d.indexOf(0x7e, this.i); at >= 0; at = d.indexOf(0x7e, at + 1)) {
				if (d[at + 1] === 0x3e) {
					end = at + 2;
					break;
				}
			}
		} else this.fail('binary inline image');
		if (end <= 0) this.fail('unterminated inline image data');
		this.i = end;
		this.skip();
		if (d[this.i] !== 0x45 || d[this.i + 1] !== 0x49) this.fail('inline image without EI');
		this.i += 2;
		return { op: 'BI', args: [{ k: 'dict', v: entries, s: start, e: end }], s: start, e: this.i };
	}
}

function hasText(v: Val): boolean {
	if (v.k === 'str') return true;
	if (v.k === 'arr') return v.v.some(hasText);
	if (v.k === 'dict') return v.v.some((en) => hasText(en.val));
	return false;
}

function applyEdits(bytes: Uint8Array, edits: Edit[]): Uint8Array {
	edits.sort((a, b) => a.start - b.start);
	const parts: Uint8Array[] = [];
	let at = 0;
	for (const ed of edits) {
		if (ed.start < at) continue;
		parts.push(bytes.subarray(at, ed.start), latin1Bytes(` ${ed.text} `));
		at = ed.end;
	}
	parts.push(bytes.subarray(at));
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

// ---------------------------------------------------------------------------
// MuPDF helpers

function openDoc(m: Mupdf, bytes: Uint8Array, password?: string): Doc {
	const doc = new m.PDFDocument(bytes);
	if (doc.needsPassword() && (password === undefined || doc.authenticatePassword(password) === 0)) {
		destroy(doc);
		throw new Error('the file did not open with its password');
	}
	return doc;
}

function hasOptionalContent(doc: Doc): boolean {
	return !doc.getTrailer().get('Root').get('OCProperties').isNull();
}

/** A decrypted copy of the document without /OCProperties, so every layer is visible. */
function withoutOptionalContent(m: Mupdf, doc: Doc): Doc {
	const copy = new m.PDFDocument(saveBuffer(doc, 'encrypt=none'));
	try {
		copy.getTrailer().get('Root').delete('OCProperties');
		return new m.PDFDocument(saveBuffer(copy, ''));
	} finally {
		destroy(copy);
	}
}

/** A stream's decoded data as a plain copy; MuPDF's buffer is freed at once. */
function readBytes(ref: Obj): Uint8Array {
	const buf = ref.readStream();
	try {
		return buf.asUint8Array().slice();
	} finally {
		destroy(buf);
	}
}

/** The saved bytes as a plain copy; MuPDF's buffer is freed at once. */
function saveBuffer(doc: Doc, options: string): Uint8Array {
	const buf = doc.saveToBuffer(options);
	try {
		return buf.asUint8Array().slice();
	} finally {
		destroy(buf);
	}
}

function readMatrix(o: Obj): Matrix {
	const a = o.isNull() ? o : o.resolve();
	if (a.isArray() && a.length === 6) {
		const v: number[] = [];
		for (let i = 0; i < 6; i++) v.push(a.get(i).asNumber());
		if (v.every(Number.isFinite)) return v as Matrix;
	}
	return [1, 0, 0, 1, 0, 0];
}

function readRect(o: Obj): Rect | null {
	if (o.isNull()) return null;
	const a = o.resolve();
	if (!a.isArray() || a.length !== 4) return null;
	const v: number[] = [];
	for (let i = 0; i < 4; i++) {
		const x = a.get(i);
		if (!x.isNumber()) return null;
		v.push(x.asNumber());
	}
	if (!v.every(Number.isFinite)) return null;
	return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

function destroy(o: unknown) {
	try {
		(o as { destroy?: () => void })?.destroy?.();
	} catch (e) {
		rethrowFault(e);
		// already gone
	}
}

// ---------------------------------------------------------------------------
// Geometry

/** True when the rectangles overlap by more than eps (a zero-size rect strictly inside counts). */
function touches(r: Rect, b: Rect, eps: number): boolean {
	return r[0] < b[2] - eps && r[2] > b[0] + eps && r[1] < b[3] - eps && r[3] > b[1] + eps;
}
function inside(r: Rect, b: Rect): boolean {
	return r[0] >= b[0] && r[1] >= b[1] && r[2] <= b[2] && r[3] <= b[3];
}
function union(a: Rect, b: Rect): Rect {
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
function intersect(a: Rect, b: Rect): Rect | null {
	const r: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
	return r[0] <= r[2] && r[1] <= r[3] ? r : null;
}
function pad(r: Rect, d: number): Rect {
	return [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
}
function transformRect(t: Matrix, r: Rect): Rect {
	const pts = [applyMatrix(t, r[0], r[1]), applyMatrix(t, r[2], r[1]), applyMatrix(t, r[0], r[3]), applyMatrix(t, r[2], r[3])];
	return [
		Math.min(...pts.map((p) => p[0])),
		Math.min(...pts.map((p) => p[1])),
		Math.max(...pts.map((p) => p[0])),
		Math.max(...pts.map((p) => p[1]))
	];
}
function quadRect(q: number[]): Rect {
	const xs = [q[0], q[2], q[4], q[6]];
	const ys = [q[1], q[3], q[5], q[7]];
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function invert(t: Matrix): Matrix {
	const det = t[0] * t[3] - t[1] * t[2];
	if (!det) return [1, 0, 0, 1, 0, 0];
	return [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det];
}
function unit(x: number, y: number): [number, number] {
	const l = Math.hypot(x, y) || 1;
	return [x / l, y / l];
}
function normalizeSpace(s: string) {
	return s.replace(/\s+/g, ' ').trim();
}
function latin1(d: Uint8Array, s: number, e: number): string {
	let out = '';
	for (let i = s; i < e; i++) out += String.fromCharCode(d[i]);
	return out;
}
function latin1Bytes(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
	return out;
}
function n4(v: number) {
	return String(Math.round(v * 10000) / 10000);
}
function r2(v: number) {
	return String(Math.round(v * 100) / 100);
}
