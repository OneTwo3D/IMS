'use client'

import { useCallback, useRef, useState } from 'react'
import { getFormFxRate } from '@/app/actions/currencies'
import { missingFormFxRate, type FormFxRate } from '@/lib/currencies/form-fx-rate'

/**
 * The exchange rate state of a PO / sales-order form. `fx` is null while a rate is being fetched (submit stays blocked).
 * The rate always comes from the fx_rates table through a server action; a missing rate is `{ state: 'missing' }`.
 * Answers that arrive after a newer currency was chosen are dropped.
 */
export function useFormFxRate(initial: FormFxRate) {
  const [fx, setFx] = useState<FormFxRate | null>(initial)
  const seq = useRef(0)

  const load = useCallback((currency: string, isBase: boolean, onResolved?: (r: FormFxRate) => void, fixed?: FormFxRate) => {
    const n = ++seq.current
    if (isBase || fixed) {
      const r: FormFxRate = fixed ?? { state: 'base' }
      setFx(r)
      onResolved?.(r)
      return
    }
    setFx(null)
    getFormFxRate(currency)
      .then((r) => {
        if (n !== seq.current) return
        setFx(r)
        onResolved?.(r)
      })
      .catch(() => {
        if (n !== seq.current) return
        const r = { ...missingFormFxRate(currency), message: `Could not read the exchange rate for ${currency}. Try picking the currency again.` }
        setFx(r)
        onResolved?.(r)
      })
  }, [])

  return { fx, load }
}
