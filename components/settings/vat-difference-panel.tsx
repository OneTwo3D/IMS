'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getVatDifferenceReport, type VatDifferenceActionResult } from '@/app/actions/settings'
import { VAT_DIFFERENCE_REASONS } from '@/lib/tax/vat-difference-reasons'

/**
 * Read-only: compares the VAT rates of Xero (the stored copy of its list), IMS and WooCommerce and lists every difference with a reason.
 * Xero is the master and the three systems must use the same set of rates. At P1 you correct WooCommerce by hand in its own screens; this panel
 * changes nothing in any system.
 */
export function VatDifferencePanel() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<VatDifferenceActionResult | null>(null)

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
          </p>
          {report.differences.length === 0
            ? <p className="font-medium">No differences: the three systems use the same set of VAT rates.</p>
            : (
              <div className="overflow-x-auto">
                <p className="font-medium">{report.differences.length} difference(s)</p>
                <table className="w-full text-left">
                  <thead><tr><th className="pr-3">Reason</th><th className="pr-3">Rate</th><th className="pr-3">Xero</th><th className="pr-3">IMS</th><th>WooCommerce</th></tr></thead>
                  <tbody>
                    {report.differences.map((difference, index) => (
                      <tr key={`${difference.reason}-${difference.subjectId}-${difference.wooRateId ?? ''}-${index}`} className="border-t align-top">
                        <td className="pr-3" title={VAT_DIFFERENCE_REASONS[difference.reason]}>{difference.reason}</td>
                        <td className="pr-3">{difference.label}{difference.wooRateId ? ` (Woo #${difference.wooRateId})` : ''}</td>
                        <td className="pr-3">{difference.xero ?? '-'}</td>
                        <td className="pr-3">{difference.ims ?? '-'}</td>
                        <td>{difference.woo ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}
    </div>
  )
}
