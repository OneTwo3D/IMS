'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { applyTaxRekey, previewTaxRekey, type TaxRekeyActionResult } from '@/app/actions/settings'
import { REKEY_OUTCOMES, REKEY_OUTCOME_MEANING } from '@/lib/tax/tax-rekey-outcomes'

/**
 * Re-key IMS tax rates to the custom tax codes of the connected Xero organisation. Xero numbers custom codes (TAX001..) per organisation, so rates created against another
 * (Demo) organisation carry codes that mean other rates in the live one. Preview shows, for each rate, the live type of the same name; Apply needs the digest of that preview,
 * so nothing can change between the two. New rates are created and the old ones deactivated (never edited); orders that can still post are re-pointed only on request.
 */
export function TaxRekeyPanel() {
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  const [result, setResult] = useState<TaxRekeyActionResult | null>(null)
  const [digest, setDigest] = useState<string | null>(null)
  const [allowUnposted, setAllowUnposted] = useState(false)

  async function run(kind: 'preview' | 'apply') {
    setBusy(kind)
    try {
      if (kind === 'preview') {
        const next = await previewTaxRekey()
        setResult(next)
        setDigest(next.success && next.plan ? next.plan.digest : null)
      } else if (digest) {
        const next = await applyTaxRekey({ confirm: digest, allowUnposted })
        setResult(next)
        setDigest(null)
      }
    } catch {
      setResult({ success: false, error: 'An unexpected error occurred.' })
    }
    setBusy(null)
  }

  const plan = result?.success ? result.plan : null
  const worklist = plan ? plan.rows.filter((row) => row.outcome !== 'ALREADY_CORRECT') : []
  return (
    <div className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-semibold">Re-key VAT rates to the Xero organisation&apos;s tax codes</h3>
      <p className="text-xs text-muted-foreground">
        Xero numbers its custom tax codes (TAX001, TAX002 ...) per organisation, so rates created against another organisation (for example a Demo one) can carry codes that mean a different rate in the live one.
        This ties each rate to the live Xero type with the <strong>same name</strong> (never by code), the same percentage and status Active. Preview first; Apply creates a new rate with the live code,
        deactivates the old one (it is never edited) and moves supplier defaults and WooCommerce mappings to the new rate. Documents that already posted keep the old rate. A component code of the old rate that is not a live active type is cleared on the new rate. Queued payloads carrying an old code, including FAILED ones, always block the Apply until they are retried or cancelled.
      </p>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={allowUnposted} onChange={(e) => setAllowUnposted(e.target.checked)} />
        Also re-point the lines of orders and purchase orders that can still post, posted or not (otherwise they block the Apply)
      </label>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => run('preview')} disabled={busy !== null}>
          {busy === 'preview' && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Preview
        </Button>
        <Button size="sm" onClick={() => run('apply')} disabled={busy !== null || digest === null || plan === null || plan.counts.REKEY === 0}>
          {busy === 'apply' && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Apply the previewed plan
        </Button>
      </div>
      {result && !result.success && <p className="text-sm text-destructive">{result.error}</p>}
      {result && result.success && result.refusal && <p className="text-sm text-destructive">Refused: {result.refusal.code}. {result.refusal.detail} Nothing was written.</p>}
      {result && result.success && result.applied && !result.refusal && (
        <p className="text-xs font-medium">
          {result.wrote && result.written
            ? `Applied: ${result.written.created.length} rate(s) re-keyed; ${result.written.suppliersRepointed} supplier default(s) and ${result.written.mappingsRepointed} storefront mapping(s) re-pointed. Run the VAT rate difference report to confirm.`
            : 'Nothing to re-key.'}
        </p>
      )}
      {plan && (
        <div className="space-y-1 text-xs">
          <p>{plan.inScope} rate(s) with a custom code: {REKEY_OUTCOMES.map((o) => `${o} ${plan.counts[o]}`).join(', ')}. {plan.outOfScope} left alone (no code or a Xero built-in).</p>
          {worklist.map((row) => {
            const refs = plan.references[row.imsRateId]
            return (
              <p key={row.imsRateId} title={REKEY_OUTCOME_MEANING[row.outcome]}>
                <strong>{row.outcome}</strong> {row.name} ({row.usedFor}{row.countryCode ? ` ${row.countryCode}` : ''}) {row.currentCode} {row.imsPercent}%
                {row.target ? ` -> ${row.target.taxType} "${row.target.name}" ${row.target.percent ?? '?'}%` : ''} ({row.matchedBy ?? 'no name match'}: {row.reason}){row.clearedComponents.length > 0 ? ` [component code(s) cleared: ${row.clearedComponents.map((c) => c.taxType).join(', ')}]` : ''}
                {refs ? ` [${refs.suppliers} supplier(s), ${refs.storefrontMappings} storefront mapping(s)${refs.isDefault ? ', default rate' : ''}, ${refs.unpostedSalesOrders + refs.unpostedPurchaseOrders} never-posted and ${refs.postedSalesOrders + refs.postedPurchaseOrders} posted order(s) that can still post, ${refs.queuedSyncRows + refs.queuedEvents} queued payload(s)]` : ''}
              </p>
            )
          })}
          {plan.blockers.map((b) => <p key={`${b.imsRateId}-${b.code}`} className="text-destructive">Blocker {b.code} ({b.taxType}): {b.detail}</p>)}
          <p className="text-muted-foreground">Plan digest: <span className="font-mono">{plan.digest}</span></p>
        </div>
      )}
    </div>
  )
}
