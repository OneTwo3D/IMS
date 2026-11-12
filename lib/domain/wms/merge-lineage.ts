import type { WmsConnector, WmsOrderItemRef } from '@/lib/connectors/wms/types'

/**
 * PROOF THAT A CANDIDATE WAREHOUSE ORDER REALLY ABSORBED OURS, before IMS persists its id on a link.
 *
 * A merged survivor's combined number ("a+b") only NAMES its parts: another order's survivor "A+B+C" lists "B" too, and a number search
 * cannot tell whether that B is ours. So the number is a CANDIDATE FILTER, never proof. The proof is the lines: Mintsoft keeps every
 * original line on the survivor under its original id (live-confirmed), so a genuine survivor holds ALL of this order's recorded line
 * ids, each with the recorded SKU and quantity. A missing, untrusted or partial record, an unreadable survivor, or any id that is absent or
 * different means the lineage is NOT proven, and the link must not be re-pointed.
 */
export type MergeLineageProof = { proven: true } | { proven: false; reason: string }

export async function proveMergeLineage(
  connector: Pick<WmsConnector, 'fetchOrderItemRefs'>,
  survivorExternalId: string,
  stored: ReadonlyArray<WmsOrderItemRef>,
): Promise<MergeLineageProof> {
  if (stored.length === 0) {
    return { proven: false, reason: 'IMS holds no trustworthy record of this order\'s WMS line ids, so it cannot tell whether the merged order really contains it' }
  }
  if (!connector.fetchOrderItemRefs) {
    return { proven: false, reason: 'the WMS connector cannot read an order\'s lines, so the merge cannot be proven' }
  }
  let present: WmsOrderItemRef[]
  try {
    present = await connector.fetchOrderItemRefs(survivorExternalId)
  } catch {
    return { proven: false, reason: `the lines of the candidate merged order ${survivorExternalId} could not be read` }
  }
  const missing: string[] = []
  for (const line of stored) {
    const found = present.find((item) => item.externalItemId === line.externalItemId)
    if (!found || found.sku !== line.sku || found.quantity !== line.quantity) missing.push(`${line.quantity} x ${line.sku} (line ${line.externalItemId})`)
  }
  return missing.length === 0
    ? { proven: true }
    : { proven: false, reason: `the candidate merged order ${survivorExternalId} does not hold this order's recorded lines (${missing.join(', ')})` }
}
