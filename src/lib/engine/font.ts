import { normalizeStampText } from './geometry';

interface FontkitFont {
	hasGlyphForCodePoint(cp: number): boolean;
}
interface Fontkit {
	create(bytes: Uint8Array): FontkitFont;
}

/** Characters that need shaping or have no meaning on a page. */
const NEVER = /[\p{C}\p{M}\p{Zl}\p{Zp}]/u;

/** The bundled stamp font (Noto Sans Regular), loaded once on first use. */
export class StampFont {
	#load: () => Promise<Uint8Array>;
	#bytes: Promise<Uint8Array> | null = null;
	#parsed: Promise<FontkitFont> | null = null;
	#fontkit: Promise<Fontkit> | null = null;

	constructor(load: () => Promise<Uint8Array>) {
		this.#load = load;
	}

	bytes(): Promise<Uint8Array> {
		this.#bytes ??= this.#load().catch((e) => {
			this.#bytes = null;
			throw e;
		});
		return this.#bytes;
	}

	fontkit(): Promise<Fontkit> {
		this.#fontkit ??= import('@cantoo/fontkit').then((m) => {
			const mod = m as unknown as { default?: Fontkit } & Fontkit;
			return mod.default ?? mod;
		});
		return this.#fontkit;
	}

	#font(): Promise<FontkitFont> {
		this.#parsed ??= Promise.all([this.fontkit(), this.bytes()]).then(([fk, bytes]) => fk.create(bytes));
		return this.#parsed;
	}

	/** Unique characters (in order of first use) the font cannot draw. Newlines are fine. */
	async unsupportedChars(text: string): Promise<string> {
		const font = await this.#font();
		const seen = new Set<string>();
		let bad = '';
		for (const ch of normalizeStampText(text)) {
			if (ch === '\n' || seen.has(ch)) continue;
			seen.add(ch);
			const cp = ch.codePointAt(0) ?? 0;
			if (NEVER.test(ch) || !font.hasGlyphForCodePoint(cp)) bad += ch;
		}
		return bad;
	}
}
