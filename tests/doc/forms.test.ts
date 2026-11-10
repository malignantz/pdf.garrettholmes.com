import { describe, expect, it } from 'vitest';
import { checkInvariants, exportOptions, ids, makeSource, makeStore } from './helpers';

function setup() {
	const ctx = makeStore();
	ctx.store.addSource(makeSource('a', 2));
	ctx.store.addSource(makeSource('b', 1));
	return ctx;
}

describe('form values', () => {
	it('starts empty and is part of the snapshot', () => {
		const { store } = makeStore();
		expect(store.state.formValues).toEqual({});
		expect(Object.isFrozen(store.state.formValues)).toBe(true);
	});

	it('setFormValue is one undoable step labelled "Fill form field"', () => {
		const { store } = setup();
		const before = store.state;
		expect(store.setFormValue('a', 'name', 'Ada')).toBe(true);
		expect(store.state.formValues).toEqual({ a: { name: 'Ada' } });
		expect(store.undoLabel).toBe('Fill form field');
		expect(store.state.lastEvent).toEqual({ kind: 'do', label: 'Fill form field' });
		expect(store.isDirty).toBe(true);
		// Immutable: old snapshot untouched, new values frozen, pages keep identity.
		expect(before.formValues).toEqual({});
		expect(Object.isFrozen(store.state.formValues.a)).toBe(true);
		expect(store.state.pages).toBe(before.pages);
		store.undo();
		expect(store.state.formValues).toEqual({});
		store.redo();
		expect(store.state.formValues).toEqual({ a: { name: 'Ada' } });
	});

	it('accepts every value shape and copies arrays', () => {
		const { store } = setup();
		const list = ['x', 'y'];
		store.setFormValue('a', 'text', 'hello');
		store.setFormValue('a', 'check', true);
		store.setFormValue('a', 'radio', '');
		store.setFormValue('b', 'list', list);
		list.push('z');
		expect(store.state.formValues).toEqual({ a: { text: 'hello', check: true, radio: '' }, b: { list: ['x', 'y'] } });
	});

	it('consecutive edits of the same field coalesce into one step', () => {
		const { store } = setup();
		store.setFormValue('a', 'name', 'A');
		const token = store.undoToken;
		store.setFormValue('a', 'name', 'Ad');
		store.setFormValue('a', 'name', 'Ada');
		expect(store.undoToken).toBe(token);
		expect(store.state.formValues.a.name).toBe('Ada');
		store.undo();
		expect(store.state.formValues).toEqual({});
		expect(store.canUndo).toBe(true); // the addSource steps remain
	});

	it('a different field, another command, undo or markClean ends coalescing', () => {
		const { store } = setup();
		store.setFormValue('a', 'name', 'A');
		store.setFormValue('a', 'city', 'X');
		store.setFormValue('a', 'name', 'Ad');
		store.undo();
		expect(store.state.formValues.a).toEqual({ name: 'A', city: 'X' });
		store.undo();
		expect(store.state.formValues.a).toEqual({ name: 'A' });

		store.setFormValue('a', 'name', 'B');
		store.rotatePages([ids(store)[0]], 90);
		store.setFormValue('a', 'name', 'Bo');
		store.undo();
		expect(store.state.formValues.a.name).toBe('B');

		store.setFormValue('a', 'name', 'C');
		store.undo();
		store.redo();
		store.setFormValue('a', 'name', 'Co');
		store.undo();
		expect(store.state.formValues.a.name).toBe('C');

		store.setFormValue('a', 'name', 'D');
		store.markClean();
		store.setFormValue('a', 'name', 'Do');
		store.undo();
		expect(store.state.formValues.a.name).toBe('D');
		expect(store.isDirty).toBe(false);
	});

	it('the same field in another source does not coalesce', () => {
		const { store } = setup();
		store.setFormValue('a', 'name', 'A');
		store.setFormValue('b', 'name', 'B');
		store.undo();
		expect(store.state.formValues).toEqual({ a: { name: 'A' } });
	});

	it('an equal value is a no-op with no step and no notification', () => {
		const { store } = setup();
		store.setFormValue('a', 'list', ['x']);
		store.setFormValue('a', 'other', 'q');
		const token = store.undoToken;
		let notified = 0;
		store.subscribe(() => notified++);
		expect(store.setFormValue('a', 'list', ['x'])).toBe(false);
		expect(store.undoToken).toBe(token);
		expect(notified).toBe(0);
	});

	it('throws on an unknown source, a bad field name or a bad value', () => {
		const { store } = setup();
		expect(() => store.setFormValue('ghost', 'name', 'x')).toThrow(/unknown source/);
		expect(() => store.setFormValue('a', '', 'x')).toThrow();
		expect(() => store.setFormValue('a', 'n', 3 as never)).toThrow();
		expect(() => store.setFormValue('a', 'n', [1] as never)).toThrow();
		expect(store.state.formValues).toEqual({});
	});

	it('inside a gesture or transaction it joins the outer step', () => {
		const { store } = setup();
		store.transaction('Fill in', () => {
			store.setFormValue('a', 'name', 'A');
			store.setFormValue('a', 'city', 'X');
		});
		expect(store.undoLabel).toBe('Fill in');
		store.undo();
		expect(store.state.formValues).toEqual({});
	});

	it('clearFormValues drops one source, as one step; no-op when empty', () => {
		const { store } = setup();
		expect(store.clearFormValues('a')).toBe(false);
		expect(store.clearFormValues('ghost')).toBe(false);
		store.setFormValue('a', 'name', 'A');
		store.setFormValue('b', 'name', 'B');
		expect(store.clearFormValues('a')).toBe(true);
		expect(store.undoLabel).toBe('Clear form answers');
		expect(store.state.formValues).toEqual({ b: { name: 'B' } });
		store.undo();
		expect(store.state.formValues).toEqual({ a: { name: 'A' }, b: { name: 'B' } });
	});

	it('answers leave with the last page of their source and come back on undo', () => {
		const { store, released } = setup();
		store.setFormValue('a', 'name', 'A');
		store.setFormValue('b', 'name', 'B');
		const aPages = store.state.pages.filter((p) => p.sourceId === 'a').map((p) => p.id);
		store.removePages([aPages[0]]);
		expect(store.state.formValues.a).toEqual({ name: 'A' });
		store.removePages([aPages[1]]);
		expect(store.state.formValues).toEqual({ b: { name: 'B' } });
		checkInvariants(store);
		store.undo();
		expect(store.state.formValues.a).toEqual({ name: 'A' });
		expect(released).toEqual([]);
	});

	it('answers of a garbage-collected source are gone for good', () => {
		const { store, released } = makeStore({ maxHistory: 1 });
		store.addSource(makeSource('a', 1));
		store.setFormValue('a', 'name', 'A');
		store.removePages(ids(store));
		store.addSource(makeSource('c', 1)); // evicts the step that could bring 'a' back
		expect(released).toEqual(['a']);
		expect(store.state.formValues).toEqual({});
	});

	it('clear() and reset() empty them', () => {
		const { store } = setup();
		store.setFormValue('a', 'name', 'A');
		store.clear();
		expect(store.state.formValues).toEqual({});
		store.undo();
		expect(store.state.formValues).toEqual({ a: { name: 'A' } });
		store.reset();
		expect(store.state.formValues).toEqual({});
		expect(store.canUndo).toBe(false);
	});

	it('toExportPlan passes the answers of the sources it uses, and omits them when there are none', () => {
		const { store } = setup();
		expect('formValues' in store.toExportPlan(exportOptions)).toBe(false);
		store.setFormValue('a', 'name', 'A');
		store.setFormValue('b', 'name', 'B');
		expect(store.toExportPlan(exportOptions).formValues).toEqual({ a: { name: 'A' }, b: { name: 'B' } });
		const bPage = store.state.pages.find((p) => p.sourceId === 'b')!.id;
		expect(store.toExportPlan(exportOptions, [bPage]).formValues).toEqual({ b: { name: 'B' } });
		store.clearFormValues('a');
		store.clearFormValues('b');
		expect('formValues' in store.toExportPlan(exportOptions)).toBe(false);
	});
});

describe('new stamp kinds', () => {
	it('addStamp / updateStamp / duplicate handle highlight and redact', () => {
		const { store } = setup();
		const pid = ids(store)[0];
		const h = store.addStamp(pid, { kind: 'highlight', color: 'yellow', box: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 } });
		const r = store.addStamp(pid, { kind: 'redact', box: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } });
		expect(store.updateStamp(pid, h, { color: 'green', box: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 } })).toBe(true);
		expect(store.updateStamp(pid, r, { color: 'pink' })).toBe(false); // foreign key ignored
		const [copy] = store.duplicatePages([pid]);
		const stamps = store.state.pages.find((p) => p.id === copy)!.stamps;
		expect(stamps.map((s) => s.kind)).toEqual(['highlight', 'redact']);
		expect(stamps[0]).toMatchObject({ color: 'green', box: { w: 0.5 } });
		checkInvariants(store);
	});

	it('refuses an unknown highlight colour', () => {
		const { store } = setup();
		const pid = ids(store)[0];
		expect(() => store.addStamp(pid, { kind: 'highlight', color: 'orange' as never, box: { x: 0, y: 0, w: 0.1, h: 0.1 } })).toThrow();
		const h = store.addStamp(pid, { kind: 'highlight', color: 'pink', box: { x: 0, y: 0, w: 0.1, h: 0.1 } });
		expect(() => store.updateStamp(pid, h, { color: 'blue' })).toThrow();
	});
});
