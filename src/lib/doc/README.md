# DocStore API

Single source of truth for the workspace: open sources, ordered pages, assets,
selection, undo/redo. Framework-free (`store.ts`); `store.svelte.ts` is a tiny
Svelte 5 adapter.

```ts
import { createDocStore, newPageRef } from '$lib/doc/store';
import { useDocStore } from '$lib/doc/store.svelte';

const store = createDocStore({ onSourceReleased: (id) => renderer.release(id) });
const doc = useDocStore(store); // in a component
// {#each doc.state.pages as page (page.id)} ... {/each}
// <button disabled={!doc.state.canUndo} onclick={() => store.undo()}>
```

Options: `maxHistory` (default 200), `onSourceReleased(sourceId)`, `generateId` (tests).

## State (`store.state`, immutable, replaced on every change)

`sources`, `pages`, `assets`, `formValues` (`FormValues`: source id -> field name -> value),
`selection` (`ReadonlySet<PageId>`), `anchor`,
`canUndo`, `canRedo`, `undoLabel`, `redoLabel`, `lastEvent` (`{kind: 'do'|'undo'|'redo', label}`,
use it for "Undid: Rotate 3 pages" toasts), `isDirty`.

- Unchanged `PageRef` objects keep identity across updates; a changed page gets a new object.
  Key `{#each}` by `page.id`.
- `sources` lists only sources that have pages. Emptied sources disappear from state but their
  bytes stay alive while undo/redo can still bring them back (see GC).
- `formValues` only has entries for sources in `sources`. When a source's last page goes, its
  answers go with it (undo brings both back); once the source is garbage-collected they are gone.
  Answers belong to the source, so duplicated pages share them.
- Never mutate anything you read from state.

## Commands

Each is one undo step labelled for a toast (`store.undoLabel` right after the call: "Rotate 3 pages",
"Delete page", "Move 2 pages", ...). A call that changes nothing returns `false`/`[]`, records no
step and does not notify. Unknown ids are ignored.

| Command | Notes |
|---|---|
| `addSource(source, at?) -> PageId[]` | one `PageRef` per source page; appended, or inserted at `at` (insertion slot, see below). Throws if the id is already open. |
| `insertPages(refs, at) -> PageId[]` | refs are copied. Throws on unknown source, bad `pageIndex`/rotation, missing asset, duplicate page id. May reference a source that was emptied but is still alive in history. Use `newPageRef(sourceId, pageIndex)`. |
| `removePages(ids)` | |
| `movePages(ids, toIndex)` | see below |
| `rotatePages(ids, delta)` | `delta` is a multiple of 90 (negative ok), added mod 360. Throws otherwise. |
| `duplicatePages(ids) -> PageId[]` | each copy goes right after its original; new page ids; stamps deep-copied with new stamp ids. Returns new ids in document order. |
| `reversePages(ids?)` | no ids: reverse all. With ids: those pages swap places among their own positions. |
| `sortBySource()` | stable group by source order (order of `state.sources`). |
| `addStamp(pageId, stamp) -> stampId` | `id` optional. Any stamp kind (`image`, `text`, `mark`, `highlight`, `redact`). Throws on unknown page, image stamp whose asset is missing, or unknown highlight colour. |
| `updateStamp(pageId, stampId, patch)` | shallow merge; `id`/`kind` and keys foreign to the stamp kind are ignored; equal values are a no-op. |
| `removeStamp(pageId, stampId)` | |
| `addAsset(asset)` | throws on duplicate id. |
| `removeAsset(id, {cascade?})` | **Refuses (returns false) if any stamp uses the asset**, unless `cascade: true`, which also removes those stamps in the same step ("Remove signature and 2 stamps"). Check `assetUsage(id)` first to ask the user. |
| `setFormValue(sourceId, fieldName, value)` | answer one form field (`string`, `boolean` or `string[]`, see `FormValue`). Step "Fill form field"; **consecutive calls for the same source and field merge into one step** (typing), until another command, undo/redo or `markClean()`. Equal value: no-op. Throws on a source not in `sources`, an empty field name or a bad value. Arrays are copied. |
| `clearFormValues(sourceId)` | drops every answer of that source. Step "Clear form answers"; no-op (false) when it has none. |
| `clear()` | removes pages, sources, assets and form answers; undoable. |
| `reset()` | new workspace: wipes everything **and history**, releases all sources. Not undoable. |

### Index semantics (`movePages`, `insertPages`, `addSource`)

An index is an **insertion slot in the page list as it is before the command**: `0` = before the
first page, `n` = before the page currently at `n`, `pageCount` = after the last. Out of range is
clamped (`< 0` -> 0, `> pageCount` -> pageCount). `NaN` throws.

`movePages(ids, toIndex)` takes the matching pages out (keeping **document order**, not the order
of `ids`) and drops them as one contiguous block at the slot. Because the slot is measured in the
original list, the drag-and-drop target index can be passed unchanged; the store subtracts the
moved pages that sat before it.

```
[a b c d e f]  movePages([b], 4)      -> [a c d b e f]   (slot 4 = before e)
[a b c d e f]  movePages([b c], 6)    -> [a d e f b c]
[a b c d e f]  movePages([a c e], 3)  -> [b a c e d f]   (gathered before d)
[a b c d e f]  movePages([b c d], 1..4) -> unchanged: no step, returns false
```

## Selection (not in undo history)

`select(id)`, `toggle(id)` (sets anchor), `selectRange(toId, {additive?})` (anchor..toId inclusive,
replacing the selection unless `additive`; no anchor -> `select`), `selectAll()`, `setSelection(ids)`
(marquee), `clearSelection()`.

Pruned automatically when pages disappear. **Undo/redo restore the selection the command had before
/after it**, filtered to pages that exist, so deleting a selected page and undoing re-selects it.

## History

`undo()`, `redo()` return whether they did anything. A new command clears the redo stack. At most
`maxHistory` steps are kept.

`undoToken` / `redoToken` are opaque identities of the next undo / redo step (or null). Save them
when a session starts (the page editor does) and treat undo as out of scope once `undoToken` is
back to the saved one, redo once `redoToken` is.

### Gestures and transactions (coalescing)

- `beginGesture(label)` ... `commitGesture()` / `cancelGesture()`: for drags. Between begin and
  commit every command applies live (listeners are notified for rendering) but only **one** step is
  recorded, with `label`. Commit with no net change records nothing; cancel restores the start.
  While a gesture is active `undo()`/`redo()` return false and `canUndo`/`canRedo` are false.
  Starting a gesture while one is active throws. Always commit or cancel (pointercancel, Escape).
- `transaction(label, fn)`: runs `fn` as one step with a single notification at the end; if `fn`
  throws, everything is rolled back and the error rethrown. Nested/inside a gesture it just runs
  `fn` and merges into the outer step.

Typical stamp drag: `beginGesture('Move stamp')`, `updateStamp(...)` per pointermove, `commitGesture()`.

## Source garbage collection

`Source.bytes` is large. A source stays alive while the **document, any undo entry, or any redo
entry** references it, even if it has no pages. When the last reference goes (history cap eviction,
redo stack discarded by a new command, `reset()`, gesture rollback), `onSourceReleased(sourceId)`
fires exactly once; free renderer caches there. Exceptions thrown by the callback are logged and
swallowed.

## Derived

`pageCount`, `totalOriginalBytes` (sum of `originalSize` of open sources), `isDirty` + `markClean()`
(call after a successful export/save; undo back to the clean point is clean again),
`sourceOf(pageId)`, `displayedSize(ref)` (size after user rotation; `undefined` if the source is
already released), `assetUsage(assetId)`,
`toExportPlan(options, ids?)`: all pages, or only `ids` **in document order** (pass
`store.state.selection` to extract the selected pages; an empty iterable gives an empty plan, so
check `plan.pages.length`). The returned `pages` array is a fresh copy. `plan.formValues` holds the
answers of the sources the plan's pages use, and is omitted when there are none.

## Svelte adapter

`useDocStore(store)` returns `{ store, state }`; reading `.state` in a template, `$derived` or
`$effect` subscribes (via `createSubscriber`, released automatically). Call commands on `store`.
