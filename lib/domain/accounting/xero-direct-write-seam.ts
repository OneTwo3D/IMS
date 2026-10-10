import { db } from '@/lib/db'
import { recordOutboundShadow } from '@/lib/domain/outbound-shadow/record'
import { producerShadowNotice } from '@/lib/security/producer-disposition-constants'
import { producerSeamVerdict } from '@/lib/security/producer-seam'

/**
 * THE SEAM FOR A XERO WRITE THAT HAS NO QUEUE ROW: the operator action that creates tax rates in Xero directly
 * (generateMissingXeroTaxRates). It asks the producer-side hold before it calls Xero.
 *
 *   null              go ahead: the hold is not enforced for Xero, or the decision is LIVE.
 *   { notice }        the decision is SHADOW: nothing was sent. A shadow record was kept (best effort: a failed record
 *                     is logged and never turns the refusal into a throw) and `notice` is the single-sourced sentence
 *                     to show the operator.
 *
 * The ownership map says an operator maintains Xero tax rates by hand and, from the live phase, no component writes
 * them (Xero is the master), so with the hold enforced this action is always a shadow. It lives in lib/ and not in the
 * 'use server' action file because that file may export only async functions.
 */
export async function xeroTaxRateWriteShadow(input: {
  taxRateIds: readonly string[]
  reportTypeOverrides?: Record<string, string>
}): Promise<{ notice: string } | null> {
  const verdict = producerSeamVerdict('xero', 'tax-rate')
  if (verdict.kind !== 'shadow') return null
  const ids = [...input.taxRateIds].sort()
  try {
    await recordOutboundShadow(db, {
      destination: 'xero',
      operation: 'tax-rate',
      subjectType: 'TaxRate',
      subjectId: ids.join(',').slice(0, 500) || '(none)',
      payload: { taxRateIds: ids, reportTypeOverrides: input.reportTypeOverrides ?? {} },
      summary: { taxRateCount: ids.length },
      decision: verdict.decision,
    })
  } catch (error) {
    console.error(`[producer-hold] could not record the shadow of a Xero tax-rate creation: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { notice: producerShadowNotice({ connector: 'xero', reason: verdict.decision.reason, owner: verdict.decision.owner }) }
}
