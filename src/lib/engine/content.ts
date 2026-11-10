/**
 * Minimal content-stream scanner: finds how a page's content nests q/Q so stamps can
 * be drawn in the page's initial graphics state even when the original content
 * leaves a `cm` or an unclosed `q` behind.
 */

export interface GraphicsNesting {
	/** Lowest depth reached (0 or negative: more Q than q at some point). */
	minDepth: number;
	/** Depth after the last operator. */
	finalDepth: number;
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
		} else if (c === 0x3c) {
			if (d[i + 1] === 0x3c) i += 2; // <<
			else {
				i++;
				while (i < n && d[i] !== 0x3e) i++;
				i++;
			}
		} else if (c === 0x3e) {
			i += d[i + 1] === 0x3e ? 2 : 1;
		} else if (DELIM[c]) {
			// / name, [ ] { }
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
			} else if (len === 2 && d[start] === 0x49 && d[start + 1] === 0x44) {
				// ID: inline image data runs to whitespace + EI + whitespace/EOF.
				i = skipInlineImage(d, i);
			}
		}
	}
	return { minDepth, finalDepth: depth };
}

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
	return n;
}
