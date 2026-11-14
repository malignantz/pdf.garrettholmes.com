/**
 * Marked content in a content stream: which MCIDs a page (or a form XObject) uses, which
 * named property lists its BDC operators point at, and how many marked-content
 * sequences are still open at the end. Used by the accessibility-tags checks (tags.ts)
 * and by the stages that append drawing to a tagged page (stamps, OCR text), which
 * close any sequence the original leaves open before adding their own `/Artifact`.
 *
 * A small lexer, not a full parser: strings, hex strings, comments, arrays, dictionaries
 * and inline images (BI … ID <data> EI) are skipped as units, so text that merely looks
 * like "/MCID 3" inside a string is not counted.
 */

export interface MarkedContent {
	/** MCIDs of inline property lists (`/Tag << /MCID n >> BDC`), in order. */
	mcids: number[];
	/** Names of property lists given by name (`/Tag /Name BDC`), in order: resolve them in /Properties. */
	named: string[];
	/** Marked-content sequences (BMC/BDC) still open at the end. */
	open: number;
	/** An EMC without a matching BMC/BDC was seen. */
	unbalanced: boolean;
}

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

class Name {
	constructor(readonly name: string) {}
}
class Op {
	constructor(readonly op: string) {}
}
type Val = number | string | boolean | null | Val[] | Name | Op | { [k: string]: Val };

export function markedContent(data: Uint8Array): MarkedContent {
	const out: MarkedContent = { mcids: [], named: [], open: 0, unbalanced: false };
	const n = data.length;
	let i = 0;
	let operands: Val[] = [];

	const skipWs = () => {
		for (;;) {
			while (i < n && WS[data[i]]) i++;
			if (i < n && data[i] === 0x25) {
				while (i < n && data[i] !== 10 && data[i] !== 13) i++;
				continue;
			}
			return;
		}
	};
	const word = (): string => {
		const s = i;
		while (i < n && !WS[data[i]] && !DELIM[data[i]]) i++;
		let w = '';
		for (let k = s; k < i; k++) w += String.fromCharCode(data[k]);
		return w;
	};
	const literal = () => {
		// After '('.
		let depth = 1;
		while (i < n && depth > 0) {
			const c = data[i++];
			if (c === 0x5c) i++;
			else if (c === 0x28) depth++;
			else if (c === 0x29) depth--;
		}
		return '';
	};
	const hexString = () => {
		while (i < n && data[i] !== 0x3e) i++;
		i++;
		return '';
	};
	const value = (depth: number): Val => {
		skipWs();
		if (i >= n) return null;
		const c = data[i];
		if (c === 0x28) {
			i++;
			return literal();
		}
		if (c === 0x3c) {
			if (data[i + 1] === 0x3c) {
				i += 2;
				const d: { [k: string]: Val } = {};
				for (;;) {
					skipWs();
					if (i >= n) return d;
					if (data[i] === 0x3e && data[i + 1] === 0x3e) {
						i += 2;
						return d;
					}
					if (data[i] !== 0x2f) {
						// Not a key: skip a value so the loop always advances.
						const before = i;
						value(depth + 1);
						if (i === before) i++;
						continue;
					}
					i++;
					const key = word();
					d[key] = depth < 32 ? value(depth + 1) : null;
				}
			}
			i++;
			return hexString();
		}
		if (c === 0x5b) {
			i++;
			const a: Val[] = [];
			for (;;) {
				skipWs();
				if (i >= n) return a;
				if (data[i] === 0x5d) {
					i++;
					return a;
				}
				const before = i;
				a.push(depth < 32 ? value(depth + 1) : null);
				if (i === before) i++;
			}
		}
		if (c === 0x2f) {
			i++;
			return new Name(word());
		}
		if (c === 0x3e || c === 0x5d || c === 0x29 || c === 0x7b || c === 0x7d) {
			i++;
			return null;
		}
		const w = word();
		if (w === '') {
			i++;
			return null;
		}
		const num = Number(w);
		if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w) && Number.isFinite(num)) return num;
		return new Op(w);
	};

	while (i < n) {
		skipWs();
		if (i >= n) break;
		const v = value(0);
		if (v instanceof Op) {
			const op = v.op;
			if (op === 'BDC') {
				out.open++;
				const props = operands[operands.length - 1];
				if (props instanceof Name) out.named.push(props.name);
				else if (props && typeof props === 'object' && !Array.isArray(props) && !(props instanceof Op)) {
					const m = (props as Record<string, Val>).MCID;
					if (typeof m === 'number' && Number.isInteger(m) && m >= 0) out.mcids.push(m);
				}
			} else if (op === 'BMC') out.open++;
			else if (op === 'EMC') {
				if (out.open > 0) out.open--;
				else out.unbalanced = true;
			} else if (op === 'BI') {
				skipInlineImage();
			}
			operands = [];
		} else operands.push(v);
		if (operands.length > 64) operands = operands.slice(-8);
	}
	return out;

	function skipInlineImage() {
		// Key/value pairs up to ID, then binary data up to whitespace EI whitespace.
		for (;;) {
			skipWs();
			if (i >= n) return;
			if (data[i] === 0x49 && data[i + 1] === 0x44 && (i + 2 >= n || WS[data[i + 2]] || DELIM[data[i + 2]])) {
				i += 3;
				break;
			}
			const before = i;
			value(1);
			if (i === before) i++;
		}
		while (i < n) {
			if (WS[data[i]] && data[i + 1] === 0x45 && data[i + 2] === 0x49 && (i + 3 >= n || WS[data[i + 3]] || DELIM[data[i + 3]])) {
				i += 3;
				return;
			}
			i++;
		}
	}
}

/** Content streams joined as a page's content is read (with a newline between them). */
export function joinParts(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length + 1, 0);
	const data = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		data.set(p, off);
		off += p.length;
		data[off++] = 10;
	}
	return data;
}
