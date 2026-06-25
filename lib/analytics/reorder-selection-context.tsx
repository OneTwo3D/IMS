'use client'

import { createContext, useCallback, useContext, useMemo, useReducer } from 'react'
import {
  emptyReorderSelection,
  reorderSelectionReducer,
  selectAllState,
  selectedVisibleCount,
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

export function ReorderSelectionProvider({
  visibleIds,
  children,
}: {
  /** productIds rendered on the current page — drives toggle-all + tri-state. */
  visibleIds: readonly string[]
  children: React.ReactNode
}) {
  const [state, dispatch] = useReducer(reorderSelectionReducer, emptyReorderSelection)

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
