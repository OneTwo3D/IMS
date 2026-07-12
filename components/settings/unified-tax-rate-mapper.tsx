'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, Check, Loader2, RefreshCw, Sparkles, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import {
  matchTaxRates,
  suggestedAutoApply,
  type MatchConfidence,
  type TaxMatchResult,
} from '@/lib/tax/tax-rate-match'
import { getTaxRateMatchData, applyTaxRateMatches, type TaxRateMatchData } from '@/app/actions/tax-mapping'
import { importShoppingTaxRatesFromApi, updateShoppingTaxRateMapping, deleteShoppingTaxRateMapping } from '@/app/actions/shopping-sync'
import { updateTaxRate } from '@/app/actions/settings'

const SELECT_CLASS =
  'flex h-8 w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

const CONFIDENCE_LABEL: Record<MatchConfidence, string> = {
  'rate+name': 'matched by rate & name',
  rate: 'matched by rate (names differ)',
  name: 'name matches but rate differs',
  none: '',
}

type Props = {
  wcConnected: boolean
  xeroConnected: boolean
  onChanged?: () => void
  context: 'onboarding' | 'settings'
}

export function UnifiedTaxRateMapper({ wcConnected, xeroConnected, onChanged, context }: Props) {
  const [data, setData] = useState<TaxRateMatchData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null) // action key currently running
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await getTaxRateMatchData({ includeWc: wcConnected, includeXero: xeroConnected })
      setData(next)
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Failed to load tax rates.' })
    } finally {
      setLoading(false)
    }
  }, [wcConnected, xeroConnected])

  useEffect(() => { void load() }, [load])

  const result: TaxMatchResult | null = useMemo(() => {
    if (!data) return null
    return matchTaxRates({ imsRates: data.imsRates, wcRates: data.wcRates, xeroRates: data.xeroRates })
  }, [data])

  const notify = useCallback((kind: 'ok' | 'error', text: string) => {
    setMessage({ kind, text })
    if (kind === 'ok') onChanged?.()
  }, [onChanged])

  async function handleImportWc() {
    setBusy('import-wc'); setMessage(null)
    try {
      const res = await importShoppingTaxRatesFromApi()
      if (!res.success) { notify('error', res.error ?? 'Import failed.'); return }
      await load()
      notify('ok', `Imported ${res.importedRates ?? 0} new and reused ${res.reusedRates ?? 0} existing tax rate(s) from WooCommerce.`)
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Import failed.')
    } finally { setBusy(null) }
  }

  async function handleRefreshXero() {
    setBusy('refresh-xero'); setMessage(null)
    try { await load(); notify('ok', 'Refreshed Xero tax rates.') }
    finally { setBusy(null) }
  }

  async function handleAutoApply() {
    if (!result) return
    setBusy('auto'); setMessage(null)
    try {
      const links = suggestedAutoApply(result)
      if (links.wcLinks.length === 0 && links.xeroLinks.length === 0) {
        notify('ok', 'No new confident matches to apply — everything is already mapped or needs manual review.')
        return
      }
      const res = await applyTaxRateMatches(links)
      if (!res.success) { notify('error', res.error ?? 'Failed to apply matches.'); return }
      await load()
      notify('ok', `Auto-applied ${res.wcLinked} WooCommerce and ${res.xeroLinked} Xero link(s).`)
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Failed to apply matches.')
    } finally { setBusy(null) }
  }

  async function handleWcChange(imsId: string, externalTaxRateId: string) {
    setBusy(`wc:${imsId}`); setMessage(null)
    try {
      if (!externalTaxRateId) {
        // "Not mapped" — delete the WC mapping that currently points at this IMS rate.
        const current = data?.wcRates.find((w) => w.taxRateId === imsId)
        if (current?.mappingId) {
          const res = await deleteShoppingTaxRateMapping(current.mappingId)
          if (!res.success) { notify('error', 'Failed to unmap.'); return }
        }
      } else {
        const res = await updateShoppingTaxRateMapping(externalTaxRateId, imsId)
        if (!res.success) { notify('error', 'Failed to update mapping.'); return }
      }
      await load(); onChanged?.()
    } finally { setBusy(null) }
  }

  async function handleXeroChange(imsId: string, taxType: string) {
    setBusy(`xero:${imsId}`); setMessage(null)
    try {
      const res = await updateTaxRate(imsId, { accountingTaxType: taxType })
      if (!res.success) { notify('error', res.error ?? 'Failed to set Xero tax type.'); return }
      await load(); onChanged?.()
    } finally { setBusy(null) }
  }

  const showWc = wcConnected
  const showXero = xeroConnected
  const hasProviders = showWc || showXero

  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Tax rate mapping</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {hasProviders
              ? 'Match your WooCommerce and Xero tax rates to the IMS tax rates. Matches are suggested by rate then name — review and adjust below.'
              : 'Connect WooCommerce or Xero (previous step / Settings) to import and map their tax rates. Your IMS tax rates are shown below.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {showWc && (
            <Button type="button" variant="outline" size="sm" onClick={handleImportWc} disabled={busy != null}>
              {busy === 'import-wc' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5 mr-1" />}
              Import from store
            </Button>
          )}
          {showXero && (
            <Button type="button" variant="outline" size="sm" onClick={handleRefreshXero} disabled={busy != null}>
              {busy === 'refresh-xero' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
              Refresh from Xero
            </Button>
          )}
          {hasProviders && (
            <Button type="button" size="sm" onClick={handleAutoApply} disabled={busy != null || !result}>
              {busy === 'auto' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
              Auto-apply suggestions
            </Button>
          )}
        </div>
      </div>

      {message && (
        <p className={`text-xs ${message.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{message.text}</p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading tax rates…</div>
      ) : !result || result.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No IMS tax rates yet. Add one above (or import from WooCommerce).</p>
      ) : (
        <Table className="rounded-md border">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="text-xs">IMS Tax Rate</TableHead>
              <TableHead className="text-xs text-right">Rate</TableHead>
              {showWc && <TableHead className="text-xs">WooCommerce rate</TableHead>}
              {showXero && <TableHead className="text-xs">Xero tax code</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((row) => {
              const ims = row.ims
              const wcCurrent = data?.wcRates.find((w) => w.taxRateId === ims.id)?.externalTaxRateId
                ?? (row.wc.confidence === 'rate+name' || row.wc.confidence === 'rate' ? row.wc.match?.externalTaxRateId : '')
                ?? ''
              const xeroCurrent = ims.accountingTaxType ?? ''
              const wcSuggestionDiffers = row.wc.match && row.wc.match.externalTaxRateId !== wcCurrent
              return (
                <TableRow key={ims.id} className={row.wc.rateConflict ? 'bg-destructive/5' : undefined}>
                  <TableCell className="font-medium">
                    {ims.name}
                    {ims.active === false && <span className="ml-1.5 text-[10px] text-muted-foreground">(inactive)</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">{ims.ratePct.toFixed(2)}%</TableCell>
                  {showWc && (
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <select
                          className={SELECT_CLASS}
                          value={wcCurrent}
                          onChange={(e) => handleWcChange(ims.id, e.target.value)}
                          disabled={busy != null}
                        >
                          <option value="">— Not mapped —</option>
                          {data?.wcRates.map((w) => (
                            <option key={w.externalTaxRateId} value={w.externalTaxRateId}>
                              {w.externalName} ({w.externalRatePct.toFixed(2)}%)
                            </option>
                          ))}
                        </select>
                        {busy === `wc:${ims.id}` && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
                      </div>
                      {row.wc.match && row.wc.confidence !== 'none' && (
                        <p className={`mt-0.5 text-[10px] inline-flex items-center gap-1 ${row.wc.rateConflict ? 'text-destructive' : 'text-muted-foreground'}`}>
                          {row.wc.rateConflict ? <AlertTriangle className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                          {wcSuggestionDiffers ? `suggested: ${row.wc.match.externalName} — ` : ''}{CONFIDENCE_LABEL[row.wc.confidence]}
                        </p>
                      )}
                    </TableCell>
                  )}
                  {showXero && (
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <select
                          className={SELECT_CLASS}
                          value={xeroCurrent}
                          onChange={(e) => handleXeroChange(ims.id, e.target.value)}
                          disabled={busy != null}
                        >
                          <option value="">— Not mapped —</option>
                          {data?.xeroRates.map((x) => (
                            <option key={x.taxType} value={x.taxType}>{x.name} ({x.ratePct.toFixed(2)}%) — {x.taxType}</option>
                          ))}
                          {xeroCurrent && !data?.xeroRates.some((x) => x.taxType === xeroCurrent) && (
                            <option value={xeroCurrent}>{xeroCurrent} (unknown)</option>
                          )}
                        </select>
                        {busy === `xero:${ims.id}` && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
                      </div>
                      {row.xero.match && !xeroCurrent && (row.xero.confidence === 'rate+name' || row.xero.confidence === 'rate') && (
                        <p className="mt-0.5 text-[10px] inline-flex items-center gap-1 text-muted-foreground">
                          <Check className="h-3 w-3" /> suggested: {row.xero.match.name} ({row.xero.match.taxType})
                        </p>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      {showWc && result && result.unmatchedWc.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          <AlertTriangle className="h-3 w-3 inline mr-1 -mt-0.5" />
          {result.unmatchedWc.length} WooCommerce rate(s) don&apos;t match any IMS rate by rate or name
          {' '}({result.unmatchedWc.map((w) => `${w.externalName} ${w.externalRatePct.toFixed(2)}%`).join(', ')}).
          Add a matching IMS rate above, then re-import.
        </p>
      )}

      {context === 'onboarding' && (
        <p className="text-[11px] text-muted-foreground">
          This step is optional — you can finish setup and refine mappings later from Settings → Integrations.
        </p>
      )}
    </Card>
  )
}
