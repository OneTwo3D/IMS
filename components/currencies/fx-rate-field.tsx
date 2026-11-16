import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { describeFxSource, FX_RATES_SETTINGS_PATH, usableRate, type FormFxRate } from '@/lib/currencies/form-fx-rate'

/** The read-only rate box: the real table rate, never an invented 1. Blank while loading or missing. */
export function FxRateInput({ fx, className, disabled }: { fx: FormFxRate | null; className?: string; disabled?: boolean }) {
  const rate = fx ? usableRate(fx) : null
  return (
    <Input
      type="text"
      value={rate === null ? '' : String(rate)}
      placeholder={fx === null ? 'Loading…' : '—'}
      readOnly
      disabled={disabled}
      aria-label="Exchange rate (from the FX Rates table)"
      title="Set by the FX Rates table (Settings, Accounting). It cannot be typed here."
      className={className}
    />
  )
}

/** Source and date under the field, or the blocking message when the currency has no rate. */
export function FxRateNotice({ fx }: { fx: FormFxRate | null }) {
  if (fx === null) return <p className="text-xs text-muted-foreground">Reading the exchange rate…</p>
  if (fx.state === 'base') return null
  if (fx.state === 'ok' && fx.source === 'order') return <p className="text-xs text-muted-foreground">Rate as stored on this order.</p>
  if (fx.state === 'ok') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="fx-rate-source">
        Rate from {describeFxSource(fx.source, fx.manualOverride)}, {fx.fetchedAt.slice(0, 10)}.
      </p>
    )
  }
  return (
    <div role="alert" data-testid="fx-rate-missing" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>
        {fx.message}{' '}
        <Link href={FX_RATES_SETTINGS_PATH} className="underline" target="_blank">Open FX Rates</Link>
      </span>
    </div>
  )
}
