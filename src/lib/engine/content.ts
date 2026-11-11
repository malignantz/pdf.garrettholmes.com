/**
 * Minimal content-stream scanner: finds how a page's content nests q/Q so stamps can
 * be drawn in the page's initial graphics state even when the original content
 * leaves a `cm` or an unclosed `q` behind. It also reports where the content leaves
 * the lexer (an unclosed string, array, dictionary or inline image would swallow
 * anything appended after it) and whether a text object (BT) is still open.
 */

export interface GraphicsNesting {
	/** Lowest depth reached (0 or negative: more Q than q at some point). */
	minDepth: number;
	/** Depth after the last operator. */
	finalDepth: number;
	/** A BT is still open at the end (more BT than ET). */
	inText: boolean;
	/**
	 * Why content appended after this would not be read as operators (the content
	 * ends inside a string, array, dictionary or inline image), or null when it is
	 * safe to append.
	 */
	unterminated: string | null;
}

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const q = 0x71;
const Q = 0x51;

/** Scans the concatenation of `parts` (content streams are joined with whitespace). */
export function graphicsNesting(parts: Uint8Array[]): GraphicsNesting {
	const total = parts.reduce((n, p) => n + p.length + 1, 0);
	const data = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		data.set(p, off);
		off += p.length;
		data[off++] = 10;
	}
	return scan(data);
}

function scan(d: Uint8Array): GraphicsNesting {
	let depth = 0;
	let minDepth = 0;
	let text = 0;
	let arrays = 0;
	let dicts = 0;
	let unterminated: string | null = null;
	let i = 0;
	const n = d.length;
	while (i < n) {
		const c = d[i];
		if (WS[c]) {
			i++;
		} else if (c === 0x25) {
			// % comment to end of line
			while (i < n && d[i] !== 10 && d[i] !== 13) i++;
		} else if (c === 0x28) {
			// ( literal string ), balanced parentheses, backslash escapes
			let nest = 1;
			i++;
			while (i < n && nest > 0) {
				const ch = d[i];
				if (ch === 0x5c) i += 2;
				else {
					if (ch === 0x28) nest++;
					else if (ch === 0x29) nest--;
					i++;
				}
			}
			if (nest > 0) unterminated = 'string';
		} else if (c === 0x3c) {
			if (d[i + 1] === 0x3c) {
				dicts++;
				i += 2;
			} else {
				i++;
				while (i < n && d[i] !== 0x3e) i++;
				if (i >= n) unterminated = 'hex string';
				i++;
			}
		} else if (c === 0x3e) {
			if (d[i + 1] === 0x3e) {
				if (dicts > 0) dicts--;
				i += 2;
			} else i++;
		} else if (DELIM[c]) {
			// / name, [ ] { }
			if (c === 0x5b) arrays++;
			else if (c === 0x5d && arrays > 0) arrays--;
			i++;
			if (c === 0x2f) while (i < n && !WS[d[i]] && !DELIM[d[i]]) i++;
		} else {
			const start = i;
			while (i < n && !WS[d[i]] && !DELIM[d[i]]) i++;
			const len = i - start;
			if (len === 1 && d[start] === q) depth++;
			else if (len === 1 && d[start] === Q) {
				depth--;
				if (depth < minDepth) minDepth = depth;
			} else if (len === 2 && d[start] === 0x42 && d[start + 1] === 0x54) {
				text++; // BT
			} else if (len === 2 && d[start] === 0x45 && d[start + 1] === 0x54) {
				if (text > 0) text--; // ET
			} else if (len === 2 && d[start] === 0x49 && d[start + 1] === 0x44) {
				// ID: inline image data runs to whitespace + EI + whitespace/EOF.
				i = skipInlineImage(d, i);
				if (i < 0) {
					unterminated = 'inline image';
					i = n;
				}
			}
		}
	}
	if (!unterminated && arrays > 0) unterminated = 'array';
	if (!unterminated && dicts > 0) unterminated = 'dictionary';
	return { minDepth, finalDepth: depth, inText: text > 0, unterminated };
}

/** Index just past EI, or -1 when the image data never ends. */
function skipInlineImage(d: Uint8Array, i: number): number {
	const n = d.length;
	i++; // single whitespace after ID
	while (i < n) {
		if (
			WS[d[i]] &&
			d[i + 1] === 0x45 &&
			d[i + 2] === 0x49 &&
			(i + 3 >= n || WS[d[i + 3]] || DELIM[d[i + 3]])
		) {
			return i + 3;
		}
		i++;
	}
	return -1;
}
