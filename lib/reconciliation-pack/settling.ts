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
import { FINDING_BUCKETS, getPackItem, type ComparisonBucket, type PackItemId, type PackReasonCode } from '@/lib/reconciliation-pack/constants'
import type { ReadinessPhase } from '@/lib/ops/readiness-gate-constants'
import type { ChainEntry, ChainResult } from '@/lib/reconciliation-pack/trend'

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
    if (!carriedMatchesChain(chain.reports, id, where, entry.key, kind, differenceSignature(kind, entry), settling, head)) return unusableCarriedState()
    carried.set(entry.key, { kind, signature: differenceSignature(kind, entry), sequence: settling.sequence, first: settling.first, later: [...settling.later] })
  }
  // Every difference the item lists has its state, and every state belongs to a listed difference.
  if (carried.size !== item.counts.unsettled + findings) return unusableCarriedState()
  return { usable: true, carried }
}

/** The difference an evidence line records, as the carry reader classifies it (null: it is not a difference at all). */
function kindOfLine(bucket: ComparisonBucket, entry: { imsPresent: boolean; vendorPresent: boolean }): DifferenceKind | null {
  if (bucket === 'unsettled') return entry.imsPresent && !entry.vendorPresent ? 'onlyIms' : !entry.imsPresent && entry.vendorPresent ? 'onlyVendor' : entry.imsPresent && entry.vendorPresent ? 'bothDiffer' : null
  return bucket === 'onlyIms' || bucket === 'onlyVendor' || bucket === 'bothDiffer' ? bucket : null
}

/**
 * A carried stamp is taken only if the chain itself bears it out. The newest report claims "first seen in report S, with these later
 * stamps"; that claim is checked against every report from S to the newest, so a forged (hash-valid) report cannot bring a failure
 * forward by asserting stamps no earlier report saw:
 *
 *   - report S lists the same identity, of the same kind and signature (values and currencies), with the same first stamp, no later
 *     stamp, and that first stamp is the report's own stable bracket start for the item's stream;
 *   - every report after S lists it again, with the same sequence, first stamp, kind and signature, and a later-stamp list that
 *     extends the one before it by at most ONE stamp (a run counts once);
 *   - a stamp added by a report is that report's own stable bracket start for the stream, never one it did not read;
 *   - every one of those reports is the same phase and installation, and has the item compared to the end (reasons this reader knows).
 *
 * Anything else: no carried state (every difference starts over), which delays a failure and can never bring one forward.
 */
function carriedMatchesChain(
  reports: readonly ChainEntry[],
  id: PackItemId,
  where: { phase: ReadinessPhase; systemIdentifier: string },
  key: string,
  kind: DifferenceKind,
  signature: string,
  claimed: { sequence: number; first: string; later: readonly string[] },
  head: ChainEntry,
): boolean {
  const [stream] = getPackItem(id).streams
  if (stream === undefined) return false
  const from = claimed.sequence
  if (!Number.isSafeInteger(from) || from < 1 || from > head.sequence) return false
  let previousLater: readonly string[] = []
  for (let sequence = from; sequence <= head.sequence; sequence += 1) {
    const report = reports[sequence - 1]
    if (report === undefined || report.sequence !== sequence) return false
    const { record } = report
    if (record.systemIdentifier !== where.systemIdentifier || record.phase !== where.phase) return false
    const item = record.items.find((candidate) => candidate.id === id)
    if (item === undefined || item.applicability !== 'applicable' || !item.reasons.every((reason) => KNOWN_REASONS.includes(reason))) return false
    const bracket = record.streams.find((candidate) => candidate.stream === stream)
    if (bracket === undefined || !bracketStable(bracket.start, bracket.end) || bracket.start === null) return false
    const lines = report.settling.filter((line) => line.item === id && line.entry.key === key)
    if (lines.length !== 1) return false
    const line = lines[0]!
    const state = line.entry.settling
    if (state === undefined || kindOfLine(line.bucket, line.entry) !== kind || differenceSignature(kind, line.entry) !== signature) return false
    if (state.sequence !== from || state.first !== claimed.first) return false
    if (state.later.length < previousLater.length || state.later.length > previousLater.length + 1) return false
    if (!previousLater.every((stamp, index) => state.later[index] === stamp)) return false
    if (sequence === from) {
      if (state.later.length !== 0 || state.first !== bracket.start) return false
    } else if (state.later.length === previousLater.length + 1 && state.later[state.later.length - 1] !== bracket.start) return false
    previousLater = state.later
  }
  return previousLater.length === claimed.later.length && previousLater.every((stamp, index) => claimed.later[index] === stamp)
}
