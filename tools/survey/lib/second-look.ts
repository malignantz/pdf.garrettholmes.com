/**
 * Pieces of the redact scenario's second look at a pixel doubt (run-worker.ts,
 * secondOpinion), kept here so they can be tested.
 */
import * as mupdf from 'mupdf';
import type { StampBox } from '../../../src/lib/core/types';
import { SUSPECT_FRACTION, openDoc, renderScale, type Raster, type Region } from './raster';

/**
 * The second look settles a doubt only when it finds practically no difference: a tenth of
 * SUSPECT_FRACTION (at full resolution a page has many more ink pixels, so a real but small
 * change, such as a removed gradient strip, falls under SUSPECT_FRACTION itself).
 */
export const SECOND_LOOK_FRACTION = SUSPECT_FRACTION / 10;

/**
 * Where a redaction may change the page: the box plus 0.01 of the page or 2 rendered pixels,
 * whichever is more, per side (its anti-aliased edge; on a 200×50 pt page 0.01 of the height
 * is a third of a pixel at the comparison resolution).
 */
export function redactAllowance(page: { width: number; height: number }, box: StampBox): Region {
	const px = 2 / renderScale(page.width, page.height);
	const mx = Math.max(0.01, px / page.width);
	const my = Math.max(0.01, px / page.height);
	return { x0: box.x - mx, y0: box.y - my, x1: box.x + box.w + mx, y1: box.y + box.h + my };
}

/** A binary PPM (P6, 8 bit) as a Raster, or null. */
export function parsePpm(buf: Uint8Array): Raster | null {
	const head = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(Buffer.from(buf.subarray(0, 64)).toString('latin1'));
	if (!head) return null;
	const w = Number(head[1]);
	const h = Number(head[2]);
	const px = new Uint8Array(buf.subarray(head[0].length, head[0].length + w * h * 3));
	return px.length === w * h * 3 ? { w, h, px } : null;
}

/**
 * Scale (pixels per point) at which the largest image touching the box on page 1 renders at
 * its own resolution; 0 when no image touches the box (the redaction then rewrote none).
 */
export function imageScaleUnderBox(bytes: Uint8Array, box: StampBox): number {
	try {
		const doc = openDoc(mupdf, bytes);
		try {
			const pg = doc.loadPage(0);
			const [x0, y0, x1, y1] = pg.getBounds();
			const r = [x0 + box.x * (x1 - x0), y0 + box.y * (y1 - y0), x0 + (box.x + box.w) * (x1 - x0), y0 + (box.y + box.h) * (y1 - y0)];
			let scale = 0;
			const seen = (image: InstanceType<typeof mupdf.Image>, ctm: number[]) => {
				const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
				const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
				if (!(Math.min(...xs) < r[2] && Math.max(...xs) > r[0] && Math.min(...ys) < r[3] && Math.max(...ys) > r[1])) return;
				const wPt = Math.hypot(ctm[0], ctm[1]);
				const hPt = Math.hypot(ctm[2], ctm[3]);
				scale = Math.max(scale, image.getWidth() / Math.max(wPt, 1e-3), image.getHeight() / Math.max(hPt, 1e-3));
			};
			const dev = new mupdf.Device({
				fillImage: (i, ctm) => seen(i, ctm),
				fillImageMask: (i, ctm) => seen(i, ctm),
				clipImageMask: (i, ctm) => seen(i, ctm)
			});
			pg.run(dev, mupdf.Matrix.identity);
			dev.close();
			pg.destroy();
			return scale;
		} finally {
			doc.destroy();
		}
	} catch {
		return 0;
	}
}

