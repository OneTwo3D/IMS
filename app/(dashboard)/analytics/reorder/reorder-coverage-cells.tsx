'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  coverageValuesFromQty,
  coverageValuesFromWeeks,
  hasCoverageDemand,
  systemCoverageValues,
  type CoverageValues,
} from '@/lib/analytics/reorder-coverage'

// Per-row planning scratch: the edited order quantity and coverage weeks live only in this
// component state. They are not persisted, and "Generate" still drafts from the system suggestion.

type CoverageContextValue = {
  valuesFor: (productId: string, suggestedQty: string, demand: string) => CoverageValues
  isEdited: (productId: string) => boolean
  editQty: (productId: string, qty: string, demand: string) => void
  editWeeks: (productId: string, weeks: string, suggestedQty: string, demand: string) => void
  reset: (productId: string) => void
}

const CoverageContext = createContext<CoverageContextValue | null>(null)

function useCoverage(): CoverageContextValue {
  const context = useContext(CoverageContext)
  if (!context) throw new Error('Reorder coverage cells must render inside ReorderCoverageProvider')
  return context
}

export function ReorderCoverageProvider({ children }: { children: ReactNode }) {
  const [edits, setEdits] = useState<Record<string, CoverageValues>>({})

  const valuesFor = useCallback(
    (productId: string, suggestedQty: string, demand: string) => edits[productId] ?? systemCoverageValues(suggestedQty, demand),
    [edits],
  )
  const isEdited = useCallback((productId: string) => productId in edits, [edits])
  const editQty = useCallback((productId: string, qty: string, demand: string) => {
    setEdits((current) => ({ ...current, [productId]: coverageValuesFromQty(qty, demand) }))
  }, [])
  const editWeeks = useCallback((productId: string, weeks: string, suggestedQty: string, demand: string) => {
    setEdits((current) => {
      const applied = coverageValuesFromWeeks(weeks, demand)
      // An unparsable or incomplete entry ("", "1.") keeps the typed weeks and the last good quantity.
      const previous = current[productId] ?? systemCoverageValues(suggestedQty, demand)
      return { ...current, [productId]: applied ?? { qty: previous.qty, weeks } }
    })
  }, [])
  const reset = useCallback((productId: string) => {
    setEdits((current) => {
      const next = { ...current }
      delete next[productId]
      return next
    })
  }, [])

  const value = useMemo(
    () => ({ valuesFor, isEdited, editQty, editWeeks, reset }),
    [valuesFor, isEdited, editQty, editWeeks, reset],
  )
  return <CoverageContext.Provider value={value}>{children}</CoverageContext.Provider>
}

const INPUT_CLASS = 'h-7 w-20 rounded-md border border-input bg-background px-1.5 text-right text-sm tabular-nums disabled:cursor-not-allowed disabled:opacity-60'

type CellProps = { productId: string; suggestedQty: string; averageDailyDemand: string; label: string }

export function ReorderOrderQtyCell({ productId, suggestedQty, averageDailyDemand, label }: CellProps) {
  const { valuesFor, isEdited, editQty } = useCoverage()
  const values = valuesFor(productId, suggestedQty, averageDailyDemand)
  return (
    <input
      type="text"
      inputMode="numeric"
      value={values.qty}
      onChange={(event) => editQty(productId, event.target.value, averageDailyDemand)}
      className={`${INPUT_CLASS} ${isEdited(productId) ? 'border-amber-400 bg-amber-50' : ''}`}
      aria-label={`Order quantity for ${label}`}
    />
  )
}

export function ReorderCoverageWeeksCell({ productId, suggestedQty, averageDailyDemand, label }: CellProps) {
  const { valuesFor, isEdited, editWeeks, reset } = useCoverage()
  const values = valuesFor(productId, suggestedQty, averageDailyDemand)
  const hasDemand = hasCoverageDemand(averageDailyDemand)
  const edited = isEdited(productId)
  return (
    <div className="flex items-center justify-end gap-1.5">
      {hasDemand ? (
        <input
          type="text"
          inputMode="decimal"
          value={values.weeks ?? ''}
          onChange={(event) => editWeeks(productId, event.target.value, suggestedQty, averageDailyDemand)}
          className={`${INPUT_CLASS} ${edited ? 'border-amber-400 bg-amber-50' : ''}`}
          aria-label={`Coverage weeks for ${label}`}
        />
      ) : (
        <span className="inline-block w-20 text-right text-muted-foreground" title="No sales demand, so weeks of cover cannot be calculated">
          {'—'}
        </span>
      )}
      <button
        type="button"
        onClick={() => reset(productId)}
        disabled={!edited}
        className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted disabled:invisible"
        aria-label={`Reset ${label} to the system suggestion`}
        title="Restore the system suggestion"
      >
        Reset
      </button>
    </div>
  )
}
