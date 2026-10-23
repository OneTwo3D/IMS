/**
 * RUNNING THE ITEMS: which run, which are skipped and why, which streams they stand on, and what a runner that misbehaves
 * becomes. No file, no database and no clock of its own: everything comes in through the ports below, so a test drives the
 * whole of it and the command only wires the real ones (lib/reconciliation-pack/default-ports.ts).
 *
 *   - An item the phase does not apply is not-applicable; one the run was not asked for is inconclusive NOT_SELECTED; one with
 *     no runner on this build is inconclusive NO_RUNNER. Nothing here is ever a pass by omission.
 *   - THE LIVENESS BRACKET. The read-sync status report is read at the START and again at the END (liveness.ts). An item is not
 *     run unless the start read alone allows it, and its result is replaced by the bracket's verdict if the two reads together do
 *     not: STALE_BASIS (a dependent stream not fresh, or the scheduler not trusted), BASIS_MOVED (the stamp or the instance set
 *     moved), SOURCE_UNREADABLE (a read failed, or there is no liveness reader at all). This applies to EVERY item, one with no
 *     dependent stream included: liveness that could not be read is never taken as healthy.
 *   - THE LEDGER ITEMS (R6, R10) stand on the as-of basis. It is READ inside the bracket (after the start read, before any item)
 *     and SETTLED after the end read, and the item runs on the settled basis only. No basis port is an unreadable source.
 *   - A runner that throws, names another item, or returns something the report builder refuses is INTERNAL_ERROR for that item
 *     alone; the others still publish. The report builder is the judge of every item, here in isolation and again in the
 *     publication, so no runner can loosen its own test.
 */

import type { ReadinessPhase } from '@/lib/ops/readiness-gate-constants'
import type { AcceptanceFile } from '@/lib/ops/readiness-gate'
import type { AsOfBasis, BasisRead } from '@/lib/reconciliation-pack/basis'
import { type SettlingInput } from '@/lib/reconciliation-pack/compare'
import type { CarriedState } from '@/lib/reconciliation-pack/settling'
import { PACK_ITEM_IDS, getPackItem, itemApplicability, itemNeedsVendor, type PackItemId, type PackReasonCode } from '@/lib/reconciliation-pack/constants'
import { runInvariantItem } from '@/lib/reconciliation-pack/invariant-items'
import type { ImsRead, ImsReadOptions } from '@/lib/reconciliation-pack/ims-readers'
import { isLedgerItem, runLedgerItem, type LedgerItemId } from '@/lib/reconciliation-pack/ledger-items'
import { bracketLiveness, itemLivenessVerdict, publishedStreamBrackets, type LivenessBracket, type LivenessRead } from '@/lib/reconciliation-pack/liveness'
import { buildReport, type ItemInput, type StreamBracket } from '@/lib/reconciliation-pack/report'
import { runVatItem } from '@/lib/reconciliation-pack/vat-item'
import { runVendorItem, type VendorPorts } from '@/lib/reconciliation-pack/vendor-items'
import type { WooSourceOptions } from '@/lib/reconciliation-pack/woo-source'
import type { XeroSourceOptions } from '@/lib/reconciliation-pack/xero-source'

/** Reads the read-sync status report, reduced and checked against itself (reduceStatusReport). May throw: the run treats that as an unreadable read. */
export interface LivenessPort { read(): Promise<LivenessRead> }
/**
 * The as-of basis in its two phases (basis.ts): `read` INSIDE the liveness bracket, `settle` AFTER its end read. Neither throws in
 * the real port; a port that does is an unreadable basis.
 */
export interface BasisPort {
  read(asOf: string): Promise<BasisRead>
  settle(read: BasisRead, bracket: LivenessBracket): Promise<AsOfBasis>
}

export type RunContext = {
  phase: ReadinessPhase
  asOf: string
  now: () => Date
  acceptances: AcceptanceFile
  /** The invariant report, run at most once per pack run and shared. null when it could not be run. */
  invariant: () => Promise<unknown>
  /** Reads the IMS side in one READ ONLY REPEATABLE READ transaction (ims-readers.ts). Absent = an item that needs it is inconclusive. */
  ims?: (options: ImsReadOptions) => Promise<ImsRead>
  /** The explicit opt-in to contact a vendor (--vendor-reads-only). Anything but the boolean true is off: an item that needs a vendor is then inconclusive VENDOR_READS_OFF and nothing is called. */
  vendorReads?: boolean
  /** The vendor ports (WooCommerce, the stored Xero rate list). Only ever touched by an item that needs them, and only when vendorReads is true. */
  vendor?: VendorPorts
  /** Test seam for the vendor walks' pacing and budget. */
  wooOptions?: WooSourceOptions
  /** Test seam for the Xero walks' pacing and budget (R12). */
  xeroOptions?: XeroSourceOptions
  /**
   * Only for an item that settles (its catalogue row), and set per item by runItems, never by the caller: the state carried from the
   * previous report and the stream stamp this run's start read saw. Absent on any other item.
   */
  settling?: SettlingInput
}
export type ItemRunner = (context: RunContext) => Promise<ItemInput>
/** A ledger item runs on the SETTLED basis, after the liveness bracket is closed. */
export type LedgerRunner = (context: RunContext, basis: AsOfBasis) => Promise<ItemInput>

export type RunPlan = {
  phase: ReadinessPhase
  asOf: string
  selected: readonly PackItemId[] | null
  context: RunContext
  liveness?: LivenessPort
  basis?: BasisPort
  runners?: Partial<Record<PackItemId, ItemRunner>>
  ledgerRunners?: Partial<Record<LedgerItemId, LedgerRunner>>
  /** The settling state carried from the previous report, per item that settles (settling.ts). An item with no entry has none: every difference is first seen. */
  carried?: Partial<Record<PackItemId, CarriedState>>
}

/** The runners this build has. R3, R4 and R15 read the shared invariant report. */
export function builtInRunners(): Partial<Record<PackItemId, ItemRunner>> {
  const fromInvariant = (id: 'R3' | 'R4' | 'R15'): ItemRunner => async (context) =>
    runInvariantItem(id, await context.invariant(), { phase: context.phase, now: context.now(), acceptances: context.acceptances })
  const fromVendor = (id: 'R9' | 'R13'): ItemRunner => (context) =>
    runVendorItem(id, { asOf: context.asOf, vendorReads: context.vendorReads, vendor: context.vendor, ims: context.ims, wooOptions: context.wooOptions, settling: context.settling })
  const fromVat: ItemRunner = (context) =>
    runVatItem('R12', { asOf: context.asOf, vendorReads: context.vendorReads, vendor: context.vendor, ims: context.ims, wooOptions: context.wooOptions, xeroOptions: context.xeroOptions })
  return { R3: fromInvariant('R3'), R4: fromInvariant('R4'), R15: fromInvariant('R15'), R9: fromVendor('R9'), R13: fromVendor('R13'), R12: fromVat }
}

/** R6 and R10 read the settled as-of basis (ledger-items.ts). */
export function builtInLedgerRunners(): Record<LedgerItemId, LedgerRunner> {
  const run = (id: LedgerItemId): LedgerRunner => (context, basis) => runLedgerItem(id, basis, { phase: context.phase, asOf: context.asOf, ims: context.ims })
  return { R6: run('R6'), R10: run('R10') }
}

/** Run the invariant report once and share the answer; a throw is a null answer (every dependent item is then inconclusive). */
export function memoisedInvariant(run: () => Promise<unknown>): () => Promise<unknown> {
  let pending: Promise<unknown> | null = null
  return () => {
    pending ??= run().catch(() => null)
    return pending
  }
}

const inconclusive = (id: PackItemId, reason: PackReasonCode): ItemInput => ({ id, outcome: 'inconclusive', reasons: [reason] })

export async function readLivenessSafe(port: LivenessPort | undefined): Promise<LivenessRead> {
  if (!port) return { ok: false }
  try {
    const read = await port.read()
    return typeof read === 'object' && read !== null && (read as { ok?: unknown }).ok === true ? read : { ok: false }
  } catch {
    return { ok: false }
  }
}

/**
 * The report builder is the judge: an item it refuses (in isolation, against empty defaults for the others) becomes
 * INTERNAL_ERROR so one bad runner cannot take the publication down, and cannot loosen its own test either.
 */
/** A sequence no real chain reaches, so a carried first-seen sequence (always an earlier report's) is never ahead of the report this check builds. */
const JUDGED_SEQUENCE = 2 ** 31

function judged(item: ItemInput, plan: Pick<RunPlan, 'phase' | 'asOf'>, brackets: readonly StreamBracket[]): ItemInput {
  const stamp = '2026-01-01T00:00:00.000Z'
  const others = PACK_ITEM_IDS.filter((id) => id !== item.id).map((id): ItemInput => itemApplicability(id, plan.phase) === 'not-applicable' ? { id, outcome: 'not-applicable', reasons: ['PHASE_NOT_APPLICABLE'] } : inconclusive(id, 'NO_RUNNER'))
  try {
    buildReport({ runId: '20260101T000000Z-000000000000', systemIdentifier: '1000000000', phase: plan.phase, asOf: plan.asOf, startedAt: stamp, finishedAt: stamp, streams: [...brackets], items: [item, ...others] }, JUDGED_SEQUENCE, '0'.repeat(64))
    return item
  } catch {
    // ReportInvalid or anything else the builder throws: this item cannot be published as it is.
    return inconclusive(item.id, 'INTERNAL_ERROR')
  }
}

function settlingFor(id: PackItemId, carried: RunPlan['carried'], startOnly: LivenessBracket): SettlingInput {
  const state = carried?.[id] ?? { usable: false, carried: new Map() }
  const [stream] = getPackItem(id).streams
  const stamp = stream === undefined ? null : publishedStreamBrackets(startOnly, [stream])[0]?.start ?? null
  return { carried: state.carried, usable: state.usable, stamp }
}

export async function runItems(plan: RunPlan): Promise<{ items: ItemInput[]; streams: StreamBracket[] }> {
  const runners = { ...builtInRunners(), ...(plan.runners ?? {}) }
  const ledgerRunners: Partial<Record<LedgerItemId, LedgerRunner>> = { ...builtInLedgerRunners(), ...(plan.ledgerRunners ?? {}) }
  const start = await readLivenessSafe(plan.liveness)
  // What the START read alone allows: an item that could not pass on it is not even run (its runner may be expensive).
  const startOnly = bracketLiveness(start, start)
  const results = new Map<PackItemId, ItemInput>()
  const attempted: PackItemId[] = []
  const ledgerAttempted: LedgerItemId[] = []
  const plain: PackItemId[] = []

  for (const id of PACK_ITEM_IDS) {
    if (itemApplicability(id, plan.phase) === 'not-applicable') { results.set(id, { id, outcome: 'not-applicable', reasons: ['PHASE_NOT_APPLICABLE'] }); continue }
    if (plan.selected !== null && !plan.selected.includes(id)) { results.set(id, inconclusive(id, 'NOT_SELECTED')); continue }
    const hasRunner = isLedgerItem(id) ? ledgerRunners[id] !== undefined : runners[id] !== undefined
    if (!hasRunner) { results.set(id, inconclusive(id, 'NO_RUNNER')); continue }
    // An item that needs a vendor is not read, and nothing is called, unless the run opted in. Before the liveness verdict, so the
    // reason a reader sees is the operator's choice and not a stale stream that would not have been read either way.
    if (plan.context.vendorReads !== true && itemNeedsVendor(id)) { results.set(id, inconclusive(id, 'VENDOR_READS_OFF')); continue }
    const verdict = itemLivenessVerdict(startOnly, id)
    if (!verdict.ok) { results.set(id, inconclusive(id, verdict.reason)); continue }
    attempted.push(id)
    if (isLedgerItem(id)) ledgerAttempted.push(id)
    else plain.push(id)
  }

  // The basis is read INSIDE the bracket: after the start read and before the end read, whatever the items do in between.
  let basisRead: BasisRead | null = null
  let basisReadable = true
  if (ledgerAttempted.length > 0) {
    try { basisRead = plan.basis ? await plan.basis.read(plan.asOf) : null } catch { basisRead = null }
    basisReadable = basisRead !== null
  }

  for (const id of plain) {
    try {
      // An item that settles is handed what the previous report carried and the stamp of its stream at the START read, the one the
      // published bracket records. If the end read differs, the verdict below replaces the result (BASIS_MOVED), so a stamp that moved
      // is never counted as a run of the stream.
      const context = getPackItem(id).settles ? { ...plan.context, settling: settlingFor(id, plan.carried, startOnly) } : plan.context
      const produced = await runners[id]!(context)
      results.set(id, produced.id === id ? produced : inconclusive(id, 'INTERNAL_ERROR'))
    } catch {
      results.set(id, inconclusive(id, 'INTERNAL_ERROR'))
    }
  }

  // The status report again, after every read.
  const end = attempted.length > 0 ? await readLivenessSafe(plan.liveness) : ({ ok: false } as LivenessRead)
  const bracket = bracketLiveness(start, end)
  const verdicts = new Map(attempted.map((id) => [id, itemLivenessVerdict(bracket, id)] as const))

  for (const id of ledgerAttempted) {
    const verdict = verdicts.get(id)!
    if (!verdict.ok) { results.set(id, inconclusive(id, verdict.reason)); continue }
    if (!basisReadable || !plan.basis || basisRead === null) { results.set(id, inconclusive(id, 'SOURCE_UNREADABLE')); continue }
    try {
      const basis = await plan.basis.settle(basisRead, bracket)
      const produced = await ledgerRunners[id]!(plan.context, basis)
      results.set(id, produced.id === id ? produced : inconclusive(id, 'INTERNAL_ERROR'))
    } catch {
      results.set(id, inconclusive(id, 'INTERNAL_ERROR'))
    }
  }
  // A result is kept only if the bracket allows it: the verdict may take it away, and nothing here gives one back.
  for (const id of plain) {
    const verdict = verdicts.get(id)!
    if (!verdict.ok) results.set(id, inconclusive(id, verdict.reason))
  }

  const brackets = publishedStreamBrackets(bracket, [...new Set(attempted.flatMap((id) => [...getPackItem(id).streams]))])
  const items = PACK_ITEM_IDS.map((id) => {
    const item = results.get(id)!
    return attempted.includes(id) ? judged(item, plan, brackets) : item
  })
  return { items, streams: brackets }
}
