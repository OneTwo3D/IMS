/**
 * CARRIED SETTLING STATE: what a run may take from the report before it, and nothing else.
 *
 * A difference is not a failure the first time it is seen (the settling block of the docs). What a run knows about differences seen
 * before comes from ONE place: the trusted report chain (readPackChain, the same trust rules the readiness gate uses), and from the
 * newest report of it only. Anything short of a clean reading yields NO carried state, never a guess:
 *
 *   - an unreadable, untrusted or forked chain, or no previous report at all;
 *   - a previous report for another phase or another installation (system identifier);
 *   - a previous report whose item was not compared to the end: not a pass, a fail or an unsettled-pending result, or one with a
 *     capped listing (CAP_EXCEEDED: the entries that were cut are unknown), or with a reason this reader does not recognise;
 *   - a previous report whose dependent stream moved between its start and end read (the bracket is not stable);
 *   - evidence whose settling entries do not add up to the item's own counts (a difference with no state, a state with no difference).
 *
 * With no carried state every current difference is first seen and the item says so (SETTLING_STATE_UNUSABLE beside UNSETTLED_PENDING):
 * it can never mature into a failure, and it is never a pass and never taken as settled. The state is not looked for further back than
 * the newest report: an item that was not compared in between (not selected, vendor reads off, a stale or moved stream) starts over,
 * which delays a failure and can never bring one forward.
 *
 * Pure: the chain is read by the caller.
 */

import { bracketStable, differenceSignature, type CarriedDifference, type DifferenceKind } from '@/lib/reconciliation-pack/compare'
import { FINDING_BUCKETS, getPackItem, type PackItemId, type PackReasonCode } from '@/lib/reconciliation-pack/constants'
import type { ReadinessPhase } from '@/lib/ops/readiness-gate-constants'
import type { ChainResult } from '@/lib/reconciliation-pack/trend'

export type CarriedState = { usable: boolean; carried: Map<string, CarriedDifference> }

const KNOWN_REASONS: readonly PackReasonCode[] = ['DIFFERENCES', 'UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE']

export function unusableCarriedState(): CarriedState {
  return { usable: false, carried: new Map() }
}

export function carriedStateFromChain(chain: ChainResult, id: PackItemId, where: { phase: ReadinessPhase; systemIdentifier: string }): CarriedState {
  const spec = getPackItem(id)
  if (!spec.settles || spec.streams.length === 0) return unusableCarriedState()
  if (!chain.ok || chain.head === null) return unusableCarriedState()
  const head = chain.head
  const { record } = head
  if (record.systemIdentifier !== where.systemIdentifier || record.phase !== where.phase) return unusableCarriedState()
  for (const stream of spec.streams) {
    const bracket = record.streams.find((entry) => entry.stream === stream)
    if (!bracket || !bracketStable(bracket.start, bracket.end)) return unusableCarriedState()
  }
  const item = record.items.find((entry) => entry.id === id)
  if (!item || item.applicability !== 'applicable') return unusableCarriedState()
  if (!item.reasons.every((reason) => KNOWN_REASONS.includes(reason))) return unusableCarriedState() // includes CAP_EXCEEDED
  const findings = FINDING_BUCKETS.reduce((sum, bucket) => sum + item.counts[bucket], 0)
  const compared = item.outcome === 'pass'
    || (item.outcome === 'fail' && item.reasons.includes('DIFFERENCES'))
    || (item.outcome === 'inconclusive' && item.reasons.includes('UNSETTLED_PENDING'))
  if (!compared) return unusableCarriedState()

  const carried = new Map<string, CarriedDifference>()
  for (const line of head.settling) {
    if (line.item !== id) continue
    const { entry, bucket } = line
    const settling = entry.settling
    if (settling === undefined || carried.has(entry.key)) return unusableCarriedState()
    const kind: DifferenceKind | null = bucket === 'unsettled'
      ? (entry.imsPresent && !entry.vendorPresent ? 'onlyIms' : !entry.imsPresent && entry.vendorPresent ? 'onlyVendor' : entry.imsPresent && entry.vendorPresent ? 'bothDiffer' : null)
      : (bucket === 'onlyIms' || bucket === 'onlyVendor' || bucket === 'bothDiffer') ? bucket : null
    if (kind === null) return unusableCarriedState()
    carried.set(entry.key, { kind, signature: differenceSignature(kind, entry), sequence: settling.sequence, first: settling.first, later: [...settling.later] })
  }
  // Every difference the item lists has its state, and every state belongs to a listed difference.
  if (carried.size !== item.counts.unsettled + findings) return unusableCarriedState()
  return { usable: true, carried }
}
