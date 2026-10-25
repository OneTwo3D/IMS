'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getVatDifferenceReport, type VatDifferenceActionResult } from '@/app/actions/settings'
import { VAT_DIFFERENCE_REASONS } from '@/lib/tax/vat-difference-reasons'
import { VAT_SCHEMES, VAT_SCHEME_TITLES, type VatScheme } from '@/lib/tax/vat-scheme'
import type { VatDifference } from '@/lib/tax/vat-difference-report'

/**
 * Read-only: compares the VAT rates of Xero (the stored copy of its list), IMS and WooCommerce and lists every difference with a reason.
 * Xero is the master and the three systems must use the same set of rates. At P1 you correct WooCommerce by hand in its own screens; this panel
 * changes nothing in any system.
 */
export function VatDifferencePanel() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<VatDifferenceActionResult | null>(null)
  const [tab, setTab] = useState<VatScheme>('uk')

  async function run() {
    setBusy(true)
    try {
      setResult(await getVatDifferenceReport())
    } catch {
      setResult({ success: false, error: 'An unexpected error occurred.' })
    }
    setBusy(false)
  }

  const report = result?.success ? result.report : null
  return (
    <div className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-semibold">VAT rate differences (Xero, IMS, WooCommerce)</h3>
      <p className="text-xs text-muted-foreground">
        Xero is the master: IMS and WooCommerce must use the same set of VAT rates. This compares them (read-only, nothing is changed anywhere) and lists each difference with a reason.
        Correct WooCommerce by hand in its own tax screens, then run it again.
      </p>
      <Button variant="outline" size="sm" onClick={run} disabled={busy}>
        {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Compare VAT rates
      </Button>
      {result && !result.success && <p className="text-sm text-destructive">{result.error}</p>}
      {report?.status === 'refused' && (
        <p className="text-sm text-destructive">Not compared ({report.code}): {report.detail} This is not &quot;no differences&quot;.</p>
      )}
      {report?.status === 'compared' && (
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground">
            Xero: {report.xero.active} active tax types. IMS: {report.ims.activeRates} active rates, {report.ims.mappings} WooCommerce mappings. WooCommerce: {report.woo.rates} rates.
            One report per VAT scheme; a rate whose scheme cannot be told is listed under Unclassified.
          </p>
          <div className="flex flex-wrap gap-1">
            {VAT_SCHEMES.map((scheme) => (
              <Button key={scheme} size="sm" variant={tab === scheme ? 'default' : 'outline'} onClick={() => setTab(scheme)}>
                {VAT_SCHEME_TITLES[scheme]} ({report.schemes[scheme].differences.length})
              </Button>
            ))}
          </div>
          <SchemeTable title={VAT_SCHEME_TITLES[tab]} rows={report.schemes[tab].differences} />
          {report.schemes.unclassified.differences.length > 0 && (
            <div className="rounded-md border border-destructive/50 p-2">
              <SchemeTable title="Unclassified (scheme cannot be told; never dropped)" rows={report.schemes.unclassified.differences} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SchemeTable({ title, rows }: { title: string; rows: VatDifference[] }) {
  if (rows.length === 0) return <p className="font-medium">{title}: no differences.</p>
  return (
    <div className="overflow-x-auto">
      <p className="font-medium">{title}: {rows.length} difference(s)</p>
      <table className="w-full text-left">
        <thead><tr><th className="pr-3">Reason</th><th className="pr-3">Rate</th><th className="pr-3">Xero</th><th className="pr-3">IMS</th><th className="pr-3">WooCommerce</th><th>Region (information)</th></tr></thead>
        <tbody>
          {rows.map((difference, index) => (
            <tr key={`${difference.reason}-${difference.subjectId}-${difference.wooRateId ?? ''}-${index}`} className="border-t align-top">
              <td className="pr-3" title={`${VAT_DIFFERENCE_REASONS[difference.reason]} Scheme: ${difference.schemeSource}`}>{difference.reason}</td>
              <td className="pr-3">{difference.label}{difference.wooRateId ? ` (Woo #${difference.wooRateId})` : ''}</td>
              <td className="pr-3">{difference.xero ?? '-'}</td>
              <td className="pr-3">{difference.ims ?? '-'}</td>
              <td className="pr-3">{difference.woo ?? '-'}</td>
              <td>{difference.region ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
