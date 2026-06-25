/**
 * Pure selection-state logic for the Reorder Planning per-row selection
 * (onetwo3d-ims-vt49a). Kept React-free so the state transitions are unit
 * testable; lib/analytics/reorder-selection-context.tsx wraps this in a
 * useReducer-backed context.
 *
 * Selection is keyed by productId. "Visible ids" are the productIds currently
 * rendered on the page — toggle-all and the tri-state header operate over them.
 */

export type ReorderSelectionState = {
  /** productIds the operator has ticked. */
  selected: ReadonlySet<string>
}

export type ReorderSelectionAction =
  | { type: 'toggle'; id: string }
  | { type: 'toggleAll'; visibleIds: readonly string[] }
  | { type: 'clear' }
  /** Replace the whole selection (e.g. hydrating from a URL param). */
  | { type: 'set'; ids: readonly string[] }

/** Tri-state of the "select all visible" header checkbox. */
export type SelectAllState = 'none' | 'some' | 'all'

export const emptyReorderSelection: ReorderSelectionState = { selected: new Set() }

export function reorderSelectionReducer(
  state: ReorderSelectionState,
  action: ReorderSelectionAction,
): ReorderSelectionState {
  switch (action.type) {
    case 'toggle': {
      const next = new Set(state.selected)
      if (next.has(action.id)) next.delete(action.id)
      else next.add(action.id)
      return { selected: next }
    }
    case 'toggleAll': {
      // Tri-state: if every visible id is already selected, clear them all;
      // otherwise (none or partial) select every visible id. Selections for
      // rows that are no longer visible are preserved.
      const next = new Set(state.selected)
      const allVisibleSelected = action.visibleIds.length > 0
        && action.visibleIds.every((id) => next.has(id))
      if (allVisibleSelected) {
        for (const id of action.visibleIds) next.delete(id)
      } else {
        for (const id of action.visibleIds) next.add(id)
      }
      return { selected: next }
    }
    case 'set':
      return { selected: new Set(action.ids) }
    case 'clear':
      return emptyReorderSelection
    default:
      return state
  }
}

/** Resolve the header tri-state from the current selection over the visible ids. */
export function selectAllState(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): SelectAllState {
  if (visibleIds.length === 0) return 'none'
  let selectedCount = 0
  for (const id of visibleIds) {
    if (selected.has(id)) selectedCount++
  }
  if (selectedCount === 0) return 'none'
  if (selectedCount === visibleIds.length) return 'all'
  return 'some'
}

/** Count of selected ids that are currently visible. */
export function selectedVisibleCount(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): number {
  let count = 0
  for (const id of visibleIds) {
    if (selected.has(id)) count++
  }
  return count
}
