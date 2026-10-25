'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { importPurchaseTaxRatesFromXero, previewPurchaseTaxImport, type PurchaseTaxImportActionResult } from '@/app/actions/settings'

/**
 * Import the purchase-side tax rates from Xero's stored tax-rate list. Xero is the tax-rate master: this reads the copy the hourly tax-rate job stored (it never calls Xero and never writes
 * to it), creates the missing PURCHASE rates (INPUT2, ZERORATEDINPUT, NONE), and ONLY when ticked narrows sales-side "Both" rates to Sales and deactivates rates Xero does not list.
 * Always preview first; nothing is deleted and no existing rate's value or type is changed.
 */
export function PurchaseTaxImportPanel() {
  const [narrow, setNarrow] = useState(false)
  const [deactivate, setDeactivate] = useState(false)
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null)
  const [result, setResult] = useState<PurchaseTaxImportActionResult | null>(null)

  async function run(kind: 'preview' | 'import') {
    setBusy(kind)
    try {
      const options = { narrowSalesTypes: narrow, deactivateAbsent: deactivate, replaceDiffering: replace }
      setResult(kind === 'preview' ? await previewPurchaseTaxImport(options) : await importPurchaseTaxRatesFromXero(options))
    } catch {
      setResult({ success: false, error: 'An unexpected error occurred.' })
    }
    setBusy(null)
  }

  return (
    <div className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-semibold">Import purchase tax rates from Xero</h3>
      <p className="text-xs text-muted-foreground">
        Creates the missing <strong>Purchases</strong> rates (INPUT2, ZERORATEDINPUT, NONE) from the tax-rate list stored from Xero. Nothing is deleted, and no existing rate&apos;s value or type is changed.
      </p>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={narrow} onChange={(e) => setNarrow(e.target.checked)} />
        Also narrow &quot;Both&quot; rates whose Xero tax type is sales-only to Sales
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={deactivate} onChange={(e) => setDeactivate(e.target.checked)} />
        Also deactivate rates whose tax type Xero does not list as active (for example leftover demo-organisation rates)
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
        Also replace rates whose percentage differs from Xero&apos;s (a new rate is created and the old one deactivated; the old one is never edited)
      </label>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => run('preview')} disabled={busy !== null}>
          {busy === 'preview' && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Preview
        </Button>
        <Button size="sm" onClick={() => run('import')} disabled={busy !== null}>
          {busy === 'import' && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Import
        </Button>
      </div>
      {result && !result.success && <p className="text-sm text-destructive">{result.error}</p>}
      {result && result.success && (
        <div className="space-y-1 text-xs">
          <p className="font-medium">{result.applied ? (result.wrote ? 'Imported.' : 'Nothing to change.') : 'Preview (nothing written).'}</p>
          {result.warning && <p className="text-amber-600">{result.warning}</p>}
          <p>{result.plan.creates.length} to create: {result.plan.creates.map((c) => `${c.taxType} "${c.name}" ${c.rate}`).join('; ') || 'none'}</p>
          <p>{result.plan.present.length} already present: {result.plan.present.map((p) => p.taxType).join(', ') || 'none'}</p>
          {result.plan.narrow.length > 0 && <p>Narrowed to Sales: {result.plan.narrow.map((n) => `${n.name} (${n.taxType})`).join('; ')}</p>}
          {result.plan.notInXero.length > 0 && (
            <p>Not active in Xero ({result.plan.notInXero.filter((r) => r.deactivate).length} deactivated, others only reported): {result.plan.notInXero.map((r) => `${r.name} (${r.taxType})`).join('; ')}</p>
          )}
          {result.plan.refusals.length > 0 && (
            <p className="text-destructive">Refused: {result.plan.refusals.map((r) => `${r.code}${r.taxType ? ` (${r.taxType})` : ''}: ${r.detail}`).join('; ')}</p>
          )}
          {result.plan.differs.length > 0 && <p>Percentage differs from Xero: {result.plan.differs.map((d) => `${d.name} (${d.taxType}) IMS ${d.imsRate} vs Xero ${d.xeroRate}${d.replaced ? ' - replaced' : ''}`).join('; ')}</p>}
          {result.plan.unmapped.length > 0 && <p>No Xero tax type (no counterpart in the single rate set): {result.plan.unmapped.map((u) => `${u.name}${u.countryCode ? ` [${u.countryCode}]` : ''}`).join('; ')}</p>}
          <p className="text-muted-foreground">Rate set: {result.plan.rateSet.length} entr{result.plan.rateSet.length === 1 ? 'y' : 'ies'} (in the action result for the storefront sync).</p>
          {result.plan.notes.map((n) => <p key={n} className="text-muted-foreground">{n}</p>)}
        </div>
      )}
    </div>
  )
}
