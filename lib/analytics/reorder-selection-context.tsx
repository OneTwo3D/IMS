'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState } from 'react'
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
  /**
   * Timestamp-ish counter bumped when an active selection was auto-cleared by a
   * page/filter change. 0 until the first such clear. Consumers watch it to show
   * a one-time "selection cleared" notice.
   */
  clearedByNavigationAt: number
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
  const [clearedByNavigationAt, setClearedByNavigationAt] = useState(0)

  // When the visible page changes (pagination / filter apply), drop the
  // selection — it is a single-page model, and keeping off-page ids around would
  // silently re-persist them to the URL. Signal the clear so the UI can show a
  // one-time notice. Compared by value so same-page re-renders (e.g. an action's
  // router.refresh) don't trigger it. Detected during render (the documented
  // "adjust state when a prop changes" pattern) rather than in an effect.
  const visibleKey = visibleIds.join(',')
  const [prevVisibleKey, setPrevVisibleKey] = useState(visibleKey)
  if (visibleKey !== prevVisibleKey) {
    setPrevVisibleKey(visibleKey)
    if (state.selected.size > 0) {
      dispatch({ type: 'clear' })
      setClearedByNavigationAt((n) => n + 1)
    }
  }

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
    clearedByNavigationAt,
  }), [state.selected, visibleIds, isSelected, toggle, toggleAll, clear, clearedByNavigationAt])

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
