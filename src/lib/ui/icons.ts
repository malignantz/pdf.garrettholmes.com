/**
 * Inline SVG icon set. Drawn on a 24-unit grid and shown at 20px, so a 1.8-unit
 * stroke renders as 1.5px. Each icon is a list of path `d` strings; a path can
 * carry its own stroke width (used for dots).
 */
export type IconPath = string | { d: string; width: number };

export const icons = {
	add: ['M12 5v14', 'M5 12h14'],
	'rotate-left': ['M5 12a7 7 0 1 0 2.05-4.95', 'M6.5 3.5v4h4'],
	'rotate-right': ['M19 12a7 7 0 1 1-2.05-4.95', 'M17.5 3.5v4h-4'],
	trash: [
		'M4 7h16',
		'M6 7l1 12.1a2 2 0 0 0 2 1.9h6a2 2 0 0 0 2-1.9L18 7',
		'M9 7V4.8a1.3 1.3 0 0 1 1.3-1.3h3.4A1.3 1.3 0 0 1 15 4.8V7',
		'M10 11v6',
		'M14 11v6'
	],
	duplicate: [
		'M10.5 9h8A1.5 1.5 0 0 1 20 10.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5v-8A1.5 1.5 0 0 1 10.5 9z',
		'M15 5.5v-1A1.5 1.5 0 0 0 13.5 3h-8A1.5 1.5 0 0 0 4 4.5v8A1.5 1.5 0 0 0 5.5 14h1'
	],
	undo: ['M8.5 13.5L4 9l4.5-4.5', 'M4 9h10a5.5 5.5 0 0 1 0 11h-3'],
	redo: ['M15.5 13.5L20 9l-4.5-4.5', 'M20 9H10a5.5 5.5 0 0 0 0 11h3'],
	download: ['M12 4v11', 'M7 10.5l5 5 5-5', 'M5 20h14'],
	lock: [
		'M7 10.5h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z',
		'M8 10.5V7.5a4 4 0 0 1 8 0v3',
		'M12 14.5v2'
	],
	sign: ['M15 5l4 4L9 19H5v-4L15 5z', 'M12.5 7.5l4 4', 'M14 20h6'],
	text: ['M5 7V5h14v2', 'M12 5v14', 'M9 19h6'],
	check: ['M5 12.5l4.5 4.5L19 7'],
	cross: ['M6 6l12 12', 'M18 6L6 18'],
	close: ['M7 7l10 10', 'M17 7L7 17'],
	more: [
		{ d: 'M6 12h.01', width: 3 },
		{ d: 'M12 12h.01', width: 3 },
		{ d: 'M18 12h.01', width: 3 }
	],
	/** Three tiles and a plus: "more tools" in the editor's phone bar. */
	'more-tools': [
		'M5.5 4h3A1.5 1.5 0 0 1 10 5.5v3A1.5 1.5 0 0 1 8.5 10h-3A1.5 1.5 0 0 1 4 8.5v-3A1.5 1.5 0 0 1 5.5 4z',
		'M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 14 8.5v-3A1.5 1.5 0 0 1 15.5 4z',
		'M5.5 14h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3A1.5 1.5 0 0 1 5.5 14z',
		'M17 14v6',
		'M14 17h6'
	],
	select: [
		'M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z',
		'M8.5 12l2.5 2.5 4.5-5'
	],
	'grid-size': [
		'M5.5 4h3A1.5 1.5 0 0 1 10 5.5v3A1.5 1.5 0 0 1 8.5 10h-3A1.5 1.5 0 0 1 4 8.5v-3A1.5 1.5 0 0 1 5.5 4z',
		'M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 14 8.5v-3A1.5 1.5 0 0 1 15.5 4z',
		'M5.5 14h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3A1.5 1.5 0 0 1 5.5 14z',
		'M15.5 14h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5v-3a1.5 1.5 0 0 1 1.5-1.5z'
	],
	file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
	image: [
		'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z',
		'M10.5 9.75a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z',
		'M20.5 15.5l-4.5-4.5-9.5 8.5'
	],
	'shield-check': [
		'M12 3l7 2.8v5.7c0 4.4-2.9 7.9-7 9.5-4.1-1.6-7-5.1-7-9.5V5.8L12 3z',
		'M9 12l2.2 2.2L15.2 10'
	],
	warning: [
		'M10.3 4.3L3 17a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z',
		'M12 9.5v4',
		{ d: 'M12 17h.01', width: 2.6 }
	],
	extract: [
		'M11 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v3',
		'M14 3v5h5',
		'M13 16.5h8',
		'M18 13.5l3 3-3 3'
	],
	initials: ['M6 18V6', 'M11 18V6l7 12V6'],
	calendar: [
		'M6 5.5h12a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z',
		'M4 10h16',
		'M8.5 3.5v4',
		'M15.5 3.5v4'
	],
	dot: [{ d: 'M12 12h.01', width: 9 }],
	highlight: ['M14 4.5l5.5 5.5-7 7H8.5L7 15.5V12z', 'M11 7.5l5.5 5.5', 'M7 15.5L4.5 18h5', 'M13 20h7'],
	/** Highlight shapes: selected text (lines and a text cursor), a freehand stroke, and a box. */
	'hl-text': ['M4 8h9', 'M4 12h7', 'M4 16h9', 'M17.5 6v12', 'M15.5 5.5h4', 'M15.5 18.5h4'],
	'hl-pen': [{ d: 'M5 14.5c1.6-2.8 3.4-3.3 5-1.2s3.3 2.2 5 .1 2.6-2.6 4-1.9', width: 3.2 }],
	'hl-box': ['M6.5 8h11A2.5 2.5 0 0 1 20 10.5v3a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 13.5v-3A2.5 2.5 0 0 1 6.5 8z'],
	redact: ['M4 6h16', { d: 'M5.5 12h13', width: 5 }, 'M4 18h10'],
	'zoom-in': ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.3 15.3L20 20', 'M10.5 8v5', 'M8 10.5h5'],
	'zoom-out': ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.3 15.3L20 20', 'M8 10.5h5'],
	'chevron-left': ['M14.5 6l-6 6 6 6'],
	'chevron-right': ['M9.5 6l6 6-6 6'],
	upload: ['M12 16V4', 'M7 8.5l5-5 5 5', 'M5 20h14'],
	/** Four arrows pointing in: "make it smaller". */
	shrink: ['M4 4l6 6', 'M10 5.5V10H5.5', 'M20 4l-6 6', 'M14 5.5V10h4.5', 'M4 20l6-6', 'M10 18.5V14H5.5', 'M20 20l-6-6', 'M14 18.5V14h4.5'],
	'blank-page': ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z', 'M14 3v5h5', 'M12 11.5v6', 'M9 14.5h6']
} satisfies Record<string, IconPath[]>;

export type IconName = keyof typeof icons;
