'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertTriangle, Pencil, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  setManualFxRate,
  clearManualFxRate,
  type FxRateRow,
  type FxPushLogRow,
} from '@/app/actions/currencies'

type Props = {
  baseCurrency: string
  rates: FxRateRow[]
  pushLog: FxPushLogRow[]
}

export function FxRatesTable({ baseCurrency, rates, pushLog }: Props) {
  const [editing, setEditing] = useState<FxRateRow | null>(null)

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground mb-3">
          Latest rate per currency — direction <code className="text-xs bg-muted px-1 rounded">1 {baseCurrency} = X</code>.
          The rate stamped on each PO/SO and forwarded to Xero / WooCommerce comes from this table.
          Pin a manual override when the daily ECB rate is wrong for a particular currency; the override stays in effect
          until you clear it.
        </p>

        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead>Currency</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Last fetched</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rates.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-6 text-center">
                  No rates yet. Trigger an FX update or add a non-base currency to start tracking rates.
                </TableCell>
              </TableRow>
            )}
            {rates.map((r) => (
              <TableRow key={r.toCurrency}>
                <TableCell className="font-mono">{r.toCurrency}</TableCell>
                <TableCell className="text-right font-mono">{r.rate.toFixed(6).replace(/\.?0+$/, '')}</TableCell>
                <TableCell>
                  <SourceBadge source={r.source} manualOverride={r.manualOverride} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(r.fetchedAt).toLocaleString('en-GB')}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(r)} title="Set manual override">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {r.manualOverride && <ClearOverrideButton currency={r.toCurrency} />}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <PushLogSection rows={pushLog} />

      {editing && (
        <ManualOverrideDialog
          row={editing}
          baseCurrency={baseCurrency}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function SourceBadge({ source, manualOverride }: { source: string; manualOverride: boolean }) {
  if (manualOverride) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-900 px-2 py-0.5 text-xs font-medium dark:bg-amber-900/30 dark:text-amber-200">
        <AlertTriangle className="h-3 w-3" />
        Manual override
      </span>
    )
  }
  if (source === 'frankfurter') {
    return <span className="text-xs text-muted-foreground">ECB (frankfurter)</span>
  }
  return <span className="text-xs text-muted-foreground">{source}</span>
}

function ClearOverrideButton({ currency }: { currency: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleClear() {
    if (!confirm(`Clear the manual override for ${currency} and re-fetch the rate from frankfurter?`)) return
    startTransition(async () => {
      const result = await clearManualFxRate(currency)
      if (result.success) {
        setError(null)
        router.refresh()
      } else {
        setError(result.error ?? 'Failed to clear override')
      }
    })
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={handleClear} disabled={isPending} title="Clear override (re-fetch from ECB)">
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
      </Button>
      {error && <span className="text-xs text-destructive ml-1">{error}</span>}
    </>
  )
}

function ManualOverrideDialog({
  row,
  baseCurrency,
  onClose,
}: {
  row: FxRateRow
  baseCurrency: string
  onClose: () => void
}) {
  const router = useRouter()
  const [rate, setRate] = useState(String(row.rate))
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSave() {
    const value = Number(rate)
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter a positive number')
      return
    }
    startTransition(async () => {
      const result = await setManualFxRate(row.toCurrency, value)
      if (result.success) {
        onClose()
        router.refresh()
      } else {
        setError(result.error ?? 'Save failed')
      }
    })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Manual FX rate — {row.toCurrency}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-xs text-muted-foreground">
            Pin a rate for <code className="bg-muted px-1 rounded">1 {baseCurrency} = X {row.toCurrency}</code>.
            While set, the daily fetch will skip this currency and every read site (PO/SO, Xero, WooCommerce push) will
            use this value.
          </p>
          <div className="space-y-1.5">
            <Label>Rate (1 {baseCurrency} =)</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="any"
                min="0.000001"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className="h-9 font-mono"
              />
              <span className="text-xs text-muted-foreground font-mono">{row.toCurrency}</span>
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={isPending}>
            {isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Save override
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PushLogSection({ rows }: { rows: FxPushLogRow[] }) {
  return (
    <div>
      <h3 className="text-sm font-medium mb-2">Recent pushes to shopping connectors</h3>
      <p className="text-xs text-muted-foreground mb-3">
        One row per fan-out attempt to a shopping connector (currently WooCommerce via the
        onetwoInventory Helper plugin). The cron writes here after each daily fetch, and the
        manual <em>Push Now</em> button on the WC sync page also records here.
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No pushes recorded yet.</p>
      ) : (
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Connector</TableHead>
              <TableHead className="text-right">Rates</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-muted-foreground whitespace-nowrap">
                  {new Date(r.pushedAt).toLocaleString('en-GB')}
                </TableCell>
                <TableCell className="font-mono">{r.connector}</TableCell>
                <TableCell className="text-right">{r.ratesCount}</TableCell>
                <TableCell>
                  <span
                    className={
                      r.status === 'OK'
                        ? 'text-xs text-green-600 font-medium'
                        : 'text-xs text-destructive font-medium'
                    }
                  >
                    {r.status}
                  </span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-md truncate" title={r.errorMessage ?? undefined}>
                  {r.errorMessage ?? ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
