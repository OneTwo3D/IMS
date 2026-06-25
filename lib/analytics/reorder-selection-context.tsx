'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react'
import {
  reorderSelectionReducer,
  selectAllState,
  selectedVisibleCount,
  serializeSelectedParam,
  type ReorderSelectionState,
  type SelectAllState,
} from '@/lib/analytics/reorder-selection'

type ReorderSelectionContextValue = {
  /** productIds currently selected. */
  selected: ReadonlySet<string>
  /** Number of selected rows that are currently visible. */
  selectedVisibleCount: number
  /** Tri-state for the header "select all visible" checkbox. */
  headerState: SelectAllState
  isSelected: (id: string) => boolean
  toggle: (id: string) => void
  /** Tri-state toggle over the currently-visible ids (none/some → all, all → none). */
  toggleAll: () => void
  clear: () => void
}

const ReorderSelectionContext = createContext<ReorderSelectionContextValue | null>(null)

function initSelection(initialSelected: readonly string[] | undefined): ReorderSelectionState {
  return { selected: new Set(initialSelected ?? []) }
}

export function ReorderSelectionProvider({
  visibleIds,
  initialSelected,
  children,
}: {
  /** productIds rendered on the current page — drives toggle-all + tri-state. */
  visibleIds: readonly string[]
  /** Selection hydrated from the `selected` URL param (already capped + filtered to visible). */
  initialSelected?: readonly string[]
  children: React.ReactNode
}) {
  const [state, dispatch] = useReducer(reorderSelectionReducer, initialSelected, initSelection)

  // Round-trip the selection to the URL via history.replaceState so a refresh
  // restores it, WITHOUT triggering a Next navigation (which would re-run the
  // server report on every checkbox tick). Pagination/filter links are rendered
  // server-side without `selected`, so navigating away naturally drops it.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const serialized = serializeSelectedParam(state.selected)
    if (serialized) params.set('selected', serialized)
    else params.delete('selected')
    const qs = params.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
  }, [state.selected])

  const toggle = useCallback((id: string) => dispatch({ type: 'toggle', id }), [])
  const toggleAll = useCallback(() => dispatch({ type: 'toggleAll', visibleIds }), [visibleIds])
  const clear = useCallback(() => dispatch({ type: 'clear' }), [])
  const isSelected = useCallback((id: string) => state.selected.has(id), [state.selected])

  const value = useMemo<ReorderSelectionContextValue>(() => ({
    selected: state.selected,
    selectedVisibleCount: selectedVisibleCount(state.selected, visibleIds),
    headerState: selectAllState(state.selected, visibleIds),
    isSelected,
    toggle,
    toggleAll,
    clear,
  }), [state.selected, visibleIds, isSelected, toggle, toggleAll, clear])

  return (
    <ReorderSelectionContext.Provider value={value}>
      {children}
    </ReorderSelectionContext.Provider>
  )
}

export function useReorderSelection(): ReorderSelectionContextValue {
  const ctx = useContext(ReorderSelectionContext)
  if (!ctx) {
    throw new Error('useReorderSelection must be used within a ReorderSelectionProvider')
  }
  return ctx
}
