'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertTriangle, Pencil, Undo2, Plug, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  setManualFxRate,
  clearManualFxRate,
  setFxRateSource,
  type FxRateRow,
  type FxPushLogRow,
  type FxHealth,
} from '@/app/actions/currencies'
import { probeShoppingFxHelperPlugin } from '@/app/actions/shopping-sync'
import { useFormatDateTime } from '@/components/providers/timezone-provider'

type Props = {
  baseCurrency: string
  rates: FxRateRow[]
  pushLog: FxPushLogRow[]
  health: FxHealth
}

export function FxRatesTable({ baseCurrency, rates, pushLog, health }: Props) {
  const formatDateTime = useFormatDateTime()
  const [editing, setEditing] = useState<FxRateRow | null>(null)

  return (
    <div className="space-y-6">
      <FxHealthCard health={health} />
      <FxSourceCard source={health.fxSource} />

      <div>
        <p className="text-sm text-muted-foreground mb-3">
          Latest rate per currency — direction <code className="text-xs bg-muted px-1 rounded">1 {baseCurrency} = X</code>.
          The rate stamped on each PO/SO and forwarded to your accounting and shopping connectors comes from this table.
          Pin a manual override when the daily ECB rate is wrong for a particular currency; the override stays in effect
          until you clear it.
        </p>

        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead>Currency</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>{rates.some((r) => r.source === 'aelia') ? 'Rate time' : 'Last fetched'}</TableHead>
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
                  {formatDateTime(r.fetchedAt)}
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

      <PushLogSection rows={pushLog} pushDisabledByAelia={health.fxSource === 'aelia'} />

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
  if (source === 'aelia') {
    return <span className="text-xs text-muted-foreground">Aelia (before markup)</span>
  }
  return <span className="text-xs text-muted-foreground">{source}</span>
}

function FxSourceCard({ source }: { source: 'ecb' | 'aelia' }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function choose(next: 'ecb' | 'aelia') {
    if (next === source) return
    if (next === 'aelia' && !confirm('Read the exchange rates from Aelia on the store (before its markup) and stop pushing rates to WooCommerce? The onetwoInventory Helper plugin 1.3.0 or later must already be deployed on the store.')) return
    setError(null)
    startTransition(async () => {
      const result = await setFxRateSource(next)
      if (!result.success) setError(result.error ?? 'Could not change the FX source')
      else router.refresh()
    })
  }

  return (
    <div className="rounded-md border bg-muted/20 p-4 space-y-2">
      <h3 className="text-sm font-medium">Exchange-rate source</h3>
      <p className="text-xs text-muted-foreground">
        <strong>ECB (frankfurter)</strong> is the default: rates are fetched daily and may be pushed to the store.
        {' '}<strong>Aelia</strong> makes the store&apos;s currency switcher the master: IMS reads Aelia&apos;s rate <em>before</em> its
        markup (the markup is a storefront price uplift and is never stored) and does not push rates to the store.
        Needs the onetwoInventory Helper plugin 1.3.0 or later, deployed by the owner. Pinned manual overrides keep working under either source.
      </p>
      <div className="flex items-center gap-2">
        <Button variant={source === 'ecb' ? 'default' : 'outline'} size="sm" disabled={isPending} onClick={() => choose('ecb')}>ECB (frankfurter)</Button>
        <Button variant={source === 'aelia' ? 'default' : 'outline'} size="sm" disabled={isPending} onClick={() => choose('aelia')}>Aelia</Button>
        {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
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
            While set, the daily fetch will skip this currency and every read site (PO/SO, accounting and shopping pushes) will
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

function PushLogSection({ rows, pushDisabledByAelia }: { rows: FxPushLogRow[]; pushDisabledByAelia: boolean }) {
  const formatDateTime = useFormatDateTime()
  return (
    <div>
      <h3 className="text-sm font-medium mb-2">Recent pushes to shopping connectors</h3>
      {pushDisabledByAelia && (
        <p className="text-xs text-amber-700 mb-3 dark:text-amber-300">
          Pushing is disabled: the FX source is Aelia, which owns the exchange rates. IMS reads them and never writes them to the store. The rows below are earlier pushes.
        </p>
      )}
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
                  {formatDateTime(r.pushedAt)}
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

function formatAge(ms: number | null): string {
  if (ms == null) return 'never'
  const hours = Math.floor(ms / (60 * 60 * 1000))
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function FxHealthCard({ health }: { health: FxHealth }) {
  const formatDateTime = useFormatDateTime()
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<{
    status: string
    message: string
    httpStatus?: number
  } | null>(null)

  async function handleProbe() {
    setProbing(true)
    setProbeResult(null)
    try {
      const result = await probeShoppingFxHelperPlugin()
      setProbeResult(result)
    } catch (e) {
      setProbeResult({ status: 'UNREACHABLE', message: String(e) })
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className="rounded-md border bg-muted/20 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Integration health</h3>
      </div>

      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <HealthRow
          ok={!health.fetchStale}
          label={health.fxSource === 'aelia' ? 'Aelia last updated its rates' : 'Last ECB fetch'}
          value={health.lastFetchedAt
            ? `${formatDateTime(health.lastFetchedAt)} (${formatAge(health.lastFetchAgeMs)})`
            : 'never'}
          warning={health.fetchStale ? (health.fxSource === 'aelia' ? 'Stale — Aelia has not updated its rates in over 36h. Check Aelia\'s update schedule on the store.' : 'Stale — fetch hasn\'t run in over 36h. Check the cron schedule.') : null}
        />
        <HealthRow
          ok={health.lastFetchAttemptStatus !== 'failed'}
          label="Last fetch attempt"
          value={formatFetchAttempt(health, formatDateTime)}
          warning={formatFetchAttemptWarning(health)}
        />
        <HealthRow
          ok={health.wcPushEnabled ? !health.wcPushStale : true}
          label="Last WooCommerce push"
          value={
            health.wcPushEnabled
              ? health.lastWcPushAt
                ? `${formatDateTime(health.lastWcPushAt)} (${formatAge(health.lastWcPushAgeMs)})`
                : 'pending — not yet pushed'
              : 'disabled'
          }
          warning={
            health.wcPushEnabled && health.wcPushStale
              ? 'WC push enabled but no successful push in over 36h. Run the probe and check Recent Pushes for failures.'
              : null
          }
        />
        <HealthRow
          ok={health.manualOverrideCount === 0}
          label="Currencies under manual override"
          value={String(health.manualOverrideCount)}
          warning={
            health.manualOverrideCount > 0
              ? 'Override currencies are skipped by the daily ECB fetch. Review them periodically.'
              : null
          }
        />
      </div>

      <div className="pt-2 border-t flex items-center gap-3 flex-wrap">
        <Button variant="outline" size="sm" onClick={handleProbe} disabled={probing}>
          {probing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Plug className="h-3.5 w-3.5 mr-1" />}
          Probe helper plugin
        </Button>
        {probeResult && <ProbeResultPill result={probeResult} />}
        <p className="text-xs text-muted-foreground">
          Verifies the onetwoInventory Helper plugin is installed and the FX endpoint is reachable. Sends a deliberately invalid signature; the plugin should reply with HTTP 401.
        </p>
      </div>
    </div>
  )
}

function formatFetchAttempt(health: FxHealth, formatDateTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string): string {
  const status = health.lastFetchAttemptStatus ?? 'unknown'
  const when = health.lastFetchAttemptAt ? `${formatDateTime(health.lastFetchAttemptAt)} ` : ''
  const retrySuffix = health.lastFetchRetryCount > 0 ? ` (${health.lastFetchRetryCount} attempt${health.lastFetchRetryCount === 1 ? '' : 's'})` : ''
  return `${when}${status.replaceAll('_', ' ')}${retrySuffix}`.trim()
}

function formatFetchAttemptWarning(health: FxHealth): string | null {
  if (health.lastFetchAttemptStatus === 'failed') {
    const failed = health.failedCurrencies.length ? ` Affected: ${health.failedCurrencies.join(', ')}.` : ''
    return `${health.lastFetchError ?? 'FX fetch failed.'}${failed}`
  }
  if (health.lastFetchAttemptStatus === 'skipped_manual_override' && health.skippedManualOverrideCurrencies.length) {
    return `Skipped because these currencies are manually pinned: ${health.skippedManualOverrideCurrencies.join(', ')}.`
  }
  return null
}

function HealthRow({ ok, label, value, warning }: { ok: boolean; label: string; value: string; warning: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        {ok
          ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
          : <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <span className="font-mono text-sm">{value}</span>
      {warning && <span className="text-xs text-amber-700 dark:text-amber-400">{warning}</span>}
    </div>
  )
}

function ProbeResultPill({ result }: { result: { status: string; message: string; httpStatus?: number } }) {
  const ok = result.status === 'OK'
  const Icon = ok ? CheckCircle2 : XCircle
  const colourClass = ok
    ? 'bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-200'
    : 'bg-destructive/10 text-destructive'
  return (
    <span
      className={`inline-flex items-start gap-1.5 rounded-md px-2 py-1 text-xs ${colourClass}`}
      title={result.message}
    >
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span className="max-w-md">
        <strong>{result.status}</strong>
        {result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''} — {result.message}
      </span>
    </span>
  )
}
