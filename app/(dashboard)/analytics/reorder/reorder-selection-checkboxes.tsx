'use client'

import { useEffect, useRef } from 'react'
import { useReorderSelection } from '@/lib/analytics/reorder-selection-context'

const CHECKBOX_CLASS = 'h-4 w-4 cursor-pointer rounded border-input align-middle'

/** Tri-state "select all visible" header checkbox for the reorder report. */
export function ReorderSelectAllCheckbox() {
  const { headerState, toggleAll } = useReorderSelection()
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = headerState === 'some'
  }, [headerState])

  return (
    <input
      ref={ref}
      type="checkbox"
      className={CHECKBOX_CLASS}
      checked={headerState === 'all'}
      onChange={toggleAll}
      aria-label="Select all visible rows"
    />
  )
}

/** Per-row selection checkbox keyed by productId. */
export function ReorderRowCheckbox({ productId, label }: { productId: string; label?: string }) {
  const { isSelected, toggle } = useReorderSelection()
  return (
    <input
      type="checkbox"
      className={CHECKBOX_CLASS}
      checked={isSelected(productId)}
      onChange={() => toggle(productId)}
      aria-label={label ? `Select ${label}` : 'Select row'}
    />
  )
}
