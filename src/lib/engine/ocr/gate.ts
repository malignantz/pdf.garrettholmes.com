/**
 * The page gate of "Make scanned pages searchable": whether an OCR result is good
 * enough to write as a text layer, from the OCR output alone. Signals and thresholds
 * are the measurement's (tools/ocr/lib/score.ts `norm`, `signals`; tools/ocr/report.ts
 * `accept`; the gate tuned for at most 5% bad pages on the dev pools in
 * tools/ocr/gate.ts): mean word confidence at least 84 and at least 8% of the words
 * among the 100 commonest English words. tests/engine/ocr-gate.test.ts checks this
 * copy against the harness, so the two cannot drift apart.
 *
 * The gate reads every word OCR returned; words under WORD_MIN_CONF are dropped only
 * afterwards, from what is written (as measured).
 */

/** OCR word: text, box in image pixels (x0, y0, x1, y1), confidence 0..100. */
export type OcrWord = [string, number, number, number, number, number];

/** Gate thresholds (tools/ocr/gate.ts, "at most 5% bad among accepted on dev"). */
export const GATE = { minConf: 84, minStop: 0.08 } as const;
/** Words below this confidence are not written. */
export const WORD_MIN_CONF = 50;

export function norm(s: string): string {
	return s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

/** Page-level signals for the gate, from the OCR output alone. */
export interface Signals {
	words: number;
	meanConf: number;
	/** Share of words with confidence below 60. */
	low60: number;
	/** Share of words with confidence below 30. */
	low30: number;
	/** Share of word tokens that are among the 100 most common English words. */
	stop: number;
	/** Share of words that look like words: letters only (an inner hyphen or apostrophe allowed), or plain numbers. */
	wordy: number;
	/** Median OCR word height, px. */
	medH: number;
}

const STOP = new Set(
	'the of and to a in is it you that he was for on are with as i his they be at one have this from or had by not word but what some we can out other were all there when up use your how said an each she which do their time if will way about many then them write would like so these her long make thing see him two has look more day could go come did number sound no most people my over know water than call first who may down side been now find any new work part take get place made live where after back little only round man year came show every good me give our under name very through just form sentence great think say help low line differ turn cause much mean before move right boy old too same tell does set three want air well also play small end put home read hand port large spell add even land here must big high such follow act why ask men change went light kind off need house picture try us again animal point mother world near build self earth father'.split(' ')
);

export function signals(ocr: OcrWord[]): Signals {
	const ws = ocr.filter((o) => norm(o[0]).length > 0);
	if (!ws.length) return { words: 0, meanConf: 0, low60: 1, low30: 1, stop: 0, wordy: 0, medH: 0 };
	const conf = ws.map((o) => o[5]);
	const hs = ws.map((o) => o[4] - o[2]).sort((a, b) => a - b);
	const toks = ws.map((o) => norm(o[0]));
	return {
		words: ws.length,
		meanConf: conf.reduce((a, b) => a + b, 0) / ws.length,
		low60: conf.filter((c) => c < 60).length / ws.length,
		low30: conf.filter((c) => c < 30).length / ws.length,
		stop: toks.filter((t) => STOP.has(t)).length / ws.length,
		wordy: ws.filter((o) => /^[\p{L}]+(['’-][\p{L}]+)*[.,;:!?)]*$|^[(]?[$€£]?\d[\d.,/:-]*%?[.,;:)]*$/u.test(o[0].replace(/^[("“‘']+|[)"”’']+$/g, ''))).length / ws.length,
		medH: hs[Math.floor(hs.length / 2)]
	};
}

/** True when a page's OCR may be written as its text layer. */
export function gateAccepts(s: Signals): boolean {
	return s.meanConf >= GATE.minConf && s.stop >= GATE.minStop;
}
