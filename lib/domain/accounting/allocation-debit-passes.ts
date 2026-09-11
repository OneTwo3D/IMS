/**
 * o3d-i0o6 r3 — THE PASS HISTORY OF A GROUP A2 DEBIT: WRITTEN IN ONE PLACE, READ IN ONE PLACE.
 *
 * THE DEFECT THIS EXISTS FOR. `SalesOrder.allocationBatchAmount` is CUMULATIVE — both A2 writers add
 * this pass's value to whatever the order already recorded, because the declared allocation rewrite
 * (`resetAllocationAccountingIfStaged`) hands a stamped order back with its debit standing and A2
 * then posts the INCREMENT alone. The three attribution columns written by the SAME statement —
 * `allocationBatchSyncLogId`, `allocationBatchConnector`, `allocationBatchAccountCode` — are
 * REPLACED, not accumulated, so they describe the LATEST pass and nothing else.
 *
 * Those two cannot be compared, and comparing them is how money moved:
 *
 *   A2 debits GBP 50 under journal J1, which FAILS (or settles on another ledger). An allocation
 *   edit un-stages the order; A2 comes back and debits the GBP 5 increment under J2, a SYNCED batch
 *   whose own DR to Allocated Inventory is GBP 900. The order now records GBP 55 attributed to J2.
 *   The proof resolves J2, finds it SYNCED, on this connector, against this account, with GBP 900 of
 *   room — and returns `posted` for GBP 55. The refund's residue and the orphan reverser then CREDIT
 *   GBP 55, of which GBP 50 was never debited in these books.
 *
 * A fact about the LATEST pass is not a fact about the WHOLE debit. The amount is cumulative; the
 * attribution was not. So the attribution is cumulative too, from here on: EVERY pass records
 * ITSELF, appended in the same UPDATE that accumulates the amount.
 *
 * THE RULE THE PROOF CAN NOW ENFORCE. A verdict of `posted` for an amount means every pass making up
 * that amount is proved, on ONE ledger. If the pass history cannot establish that — it is missing,
 * it does not sum to the recorded amount, a contributing pass named no journal, two passes name two
 * ledgers — the verdict is NOT `posted`, and every caller's ceiling is GBP 0.00.
 *
 * WHY THE WRITE LIVES HERE AND NOT IN THE TWO CONNECTORS. {@link buildAllocationDebitOrderUpdate}
 * produces the accumulated amount AND the appended history AND the three latest-pass columns as ONE
 * object, which is the whole of what an A2 pass writes to the order about its debit. A connector
 * cannot accumulate the amount while forgetting the history, because it does not compute the amount
 * — this does. A connector that bypasses it writes no history at all, and an order with no history
 * is UNPROVABLE rather than falsely proved: the failure mode of forgetting is refusal, not a credit.
 *
 * THE THREE LATEST-PASS COLUMNS STAY. They are read by paths that ask a different question from the
 * proof's — `resolveStagedAllocationDebit` asks "may pounds still be sitting in Allocated
 * Inventory?", the delete guard asks "is a journal carrying this order's pounds still live?",
 * `recreateMissingDailyBatchLogs` rebuilds a lost batch — and they are still true about the pass
 * that wrote them. What they are no longer allowed to do is stand in for the history.
 */

import { addMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

/** One Group A2 pass's own contribution to an order's cumulative Allocated Inventory debit. */
export type AllocationDebitPass = {
  /** The pounds THIS pass added to `allocationBatchAmount`. Never the running total. */
  amount: number
  /**
   * The journal this pass raised, or null where it raised none — a window whose ROUNDED total was
   * not positive creates no batch log at all, while the per-order amount is written regardless. A
   * pass that contributed pounds and named no journal is exactly the "amount without a posting"
   * state, and it is what makes the whole cumulative debit unprovable.
   */
  syncLogId: string | null
  /** The ledger that journal was raised into, and the Allocated Inventory account it debited. */
  connector: string | null
  accountCode: string | null
  /** The batch's own referenceId, so a later reader can find the journal by name as well as by id. */
  batchRef: string | null
  /** When the pass ran, for an operator reading the history by hand. Not used in any decision. */
  at: string | null
}

/** The JSON shape persisted in `SalesOrder.allocationBatchPasses`. Amounts are 4dp strings. */
export type SerializedAllocationDebitPass = {
  amount: string
  syncLogId: string | null
  connector: string | null
  accountCode: string | null
  batchRef: string | null
  at: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : undefined
}

/**
 * The recorded pass history, or NULL when there is none that can be read.
 *
 * ONE null for two causes — absent (a row staged before the column existed, or by a writer that did
 * not record one) and illegible (anything that is not the shape this module writes) — because they
 * are the same epistemic position and lead to the same verdict: the passes making up this amount are
 * not on record. A caller that could tell them apart would have nothing different to do.
 *
 * ALL-OR-NOTHING: one malformed entry voids the whole list rather than being skipped. A skipped
 * entry is a pass whose pounds are still in the cumulative amount but whose journal nobody checked,
 * which is the defect this file exists for, reintroduced by a lenient parser.
 */
export function parseAllocationDebitPasses(value: unknown): AllocationDebitPass[] | null {
  if (!Array.isArray(value)) return null
  const passes: AllocationDebitPass[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return null
    const amount = typeof entry.amount === 'number' ? entry.amount : Number(entry.amount)
    if (!Number.isFinite(amount)) return null
    const syncLogId = optionalString(entry.syncLogId)
    const connector = optionalString(entry.connector)
    const accountCode = optionalString(entry.accountCode)
    const batchRef = optionalString(entry.batchRef)
    const at = optionalString(entry.at)
    if (syncLogId === undefined || connector === undefined || accountCode === undefined
      || batchRef === undefined || at === undefined) {
      return null
    }
    passes.push({ amount, syncLogId, connector, accountCode, batchRef, at })
  }
  return passes
}

/** The pounds the recorded history accounts for — what `allocationBatchAmount` must equal. */
export function sumAllocationDebitPasses(passes: readonly AllocationDebitPass[]): number {
  return roundQuantity(
    passes.reduce((sum, pass) => addMoney(sum, toDecimal(pass.amount)), toDecimal(0)),
    4,
  ).toNumber()
}

/**
 * EVERYTHING A GROUP A2 PASS WRITES TO THE ORDER ABOUT ITS DEBIT — the accumulated amount, the pass
 * appended to the history, and the three columns describing this pass, produced together so they
 * cannot disagree.
 *
 * `passAmount` is THIS pass's own valuation of the order, not a running total: the accumulation is
 * done here, from `existingAmount`, exactly as both connectors did it inline before.
 *
 * A journal id of null is a real answer and is recorded as one — the pass ran, valued the order, and
 * raised nothing. The three latest-pass columns are then nulled, as they always were; the history
 * keeps the pass, which is what stops the nulling from erasing the fact that those pounds are in the
 * cumulative figure with no posting behind them.
 */
export function buildAllocationDebitOrderUpdate(input: {
  existingAmount: DecimalInput
  existingPasses: unknown
  passAmount: DecimalInput
  syncLogId: string | null
  connector: string | null
  accountCode: string | null
  batchRef: string | null
  at: Date
}): {
  allocationBatchAmount: number
  allocationBatchPasses: SerializedAllocationDebitPass[]
  allocationBatchSyncLogId: string | null
  allocationBatchConnector: string | null
  allocationBatchAccountCode: string | null
} {
  const passAmount = roundQuantity(toDecimal(input.passAmount ?? 0), 4)
  const recorded = parseAllocationDebitPasses(input.existingPasses) ?? []
  return {
    allocationBatchAmount: roundQuantity(
      addMoney(toDecimal(input.existingAmount ?? 0), passAmount),
      4,
    ).toNumber(),
    allocationBatchPasses: [
      ...recorded.map(serializePass),
      serializePass({
        amount: passAmount.toNumber(),
        syncLogId: input.syncLogId,
        connector: input.syncLogId ? input.connector : null,
        accountCode: input.syncLogId ? input.accountCode : null,
        batchRef: input.batchRef,
        at: input.at.toISOString(),
      }),
    ],
    allocationBatchSyncLogId: input.syncLogId,
    allocationBatchConnector: input.syncLogId ? input.connector : null,
    allocationBatchAccountCode: input.syncLogId ? input.accountCode : null,
  }
}

function serializePass(pass: AllocationDebitPass): SerializedAllocationDebitPass {
  return {
    amount: roundQuantity(toDecimal(pass.amount), 4).toFixed(4),
    syncLogId: pass.syncLogId,
    connector: pass.connector,
    accountCode: pass.accountCode,
    batchRef: pass.batchRef,
    at: pass.at,
  }
}

/**
 * o3d-i0o6 r4 (Codex round 3, HIGH 1) — THE POUNDS ONE ORDER PUT INTO ONE BATCH, WHICH IS NEVER ITS
 * CUMULATIVE FIGURE.
 *
 * `recreateMissingDailyBatchLogs` rebuilds a daily batch whose log went missing before it posted. It
 * is keyed to ONE batch reference, and it summed `allocationBatchAmount` — the running total of
 * EVERY A2 pass the order has ever been through — into that one batch. That is the same category
 * error the pass history exists to close, seen from the writing side instead of the reading side:
 *
 *   A2 debits GBP 50 under batch R1, which posts and settles. An allocation edit un-stages the
 *   order; A2 comes back under a NEW batch reference R2, values the order at nothing, and so creates
 *   no journal at all — while the order keeps its cumulative GBP 50 and is re-stamped with R2. The
 *   sweep then finds no log for R2, rebuilds it from the cumulative GBP 50, and the ledger carries
 *   the same GBP 50 twice. The pass history still proves only the original GBP 50, so a later refund
 *   reverses GBP 50 and the duplicate stands for ever.
 *
 * So the rebuild asks the history instead: how much did THIS order's passes attribute to THE BATCH
 * IT IS STAMPED WITH? For a pass that rounded to zero that is GBP 0.00, and a batch of zero pounds
 * is no journal at all — which is exactly what the live writer did when it declined to create the
 * log in the first place.
 *
 * WHERE THE HISTORY CANNOT ANSWER, THE BATCH IS NOT REBUILT. A row staged before the history column
 * existed carries a cumulative amount and nothing that can divide it between batches, and dividing
 * it by guessing is the defect above. The recreate path POSTS A JOURNAL, so its fail-closed side is
 * to post nothing and say so: the caller surfaces the refusal on the run, exactly as it already does
 * for a batch whose only log is cancelled. That is the same answer
 * {@link proveAllocationDebitPosting} gives such a row on the credit side ('unattributed'), for the
 * same reason, so one row cannot be unprovable to one path and self-evident to the other.
 */
export type AllocationDebitBatchShare =
  /** The pounds this order's recorded passes attribute to the batch it is stamped with. */
  | { kind: 'known'; amount: number }
  /** The history cannot divide this order's cumulative debit between batches. `reason` names it. */
  | { kind: 'unattributed'; reason: string }

export type AllocationDebitBatchRow = {
  /** Prisma Decimal | number | null. CUMULATIVE across every A2 pass this order has been through. */
  allocationBatchAmount: { toString(): string } | number | null
  /** The raw `SalesOrder.allocationBatchPasses` JSON; parsed here, never trusted unparsed. */
  allocationBatchPasses: unknown
  /** The referenceId of the batch this order is CURRENTLY stamped with — the one being rebuilt. */
  inventoryAllocatedBatchRef: string | null
  /** For the refusal text only; never part of a decision. */
  orderNumber?: string | null
  id?: string | null
}

/**
 * o3d-i0o6 r5 (Codex round 4, HIGH 1) — THE LEDGER A REBUILD WOULD POST INTO, WHICH IS THE HALF OF
 * A BATCH'S IDENTITY THE REFERENCE ID DOES NOT CARRY.
 *
 * A batch reference is `<group>-<date>[-<digest>]`. It names no connector, because it was minted by
 * one writer for one ledger and nothing needed to say which. Two things then made that omission a
 * money defect:
 *
 *   * the recreate sweep probes for a live log with `connector` in the WHERE clause, so a batch that
 *     posted on QuickBooks is INVISIBLE to Xero's sweep — it reads as missing;
 *   * the share it rebuilt was every pass that named the reference, on ANY ledger.
 *
 * Put together: after a connector switch, one sweep rebuilds the OTHER ledger's journal into its
 * own accounts. The QuickBooks debit stands, a duplicate Xero debit appears, and the pass history
 * still proves only the QuickBooks one — so no refund will ever reverse the duplicate.
 *
 * The passes have carried `connector` and `accountCode` since r3. Using them is the whole fix: a
 * sweep rebuilds THE POUNDS ITS OWN LEDGER'S PASSES PUT INTO THE BATCH, and nothing else. Each
 * connector's sweep then answers for its own share of a shared reference, and neither can post the
 * other's.
 */
export type AllocationDebitBatchLedger = {
  /** The connector whose recreate sweep is asking — the ledger a rebuild would post into. */
  connector: string
  /** The Allocated Inventory account that rebuild would debit, as configured NOW. */
  accountCode: string
}

function batchRowAmount(value: AllocationDebitBatchRow['allocationBatchAmount']): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number(value.toString())
  return Number.isFinite(parsed) ? parsed : 0
}

function describeBatchRow(order: AllocationDebitBatchRow): string {
  return order.orderNumber || order.id || 'an order'
}

/** A pass belongs to a rebuild when it named that batch AND the ledger the rebuild would post into. */
function passIsOfLedger(pass: AllocationDebitPass, ledger: AllocationDebitBatchLedger): boolean {
  return pass.connector === ledger.connector && pass.accountCode === ledger.accountCode
}

export function allocationDebitShareOfBatch(
  order: AllocationDebitBatchRow,
  ledger: AllocationDebitBatchLedger,
): AllocationDebitBatchShare {
  const recorded = batchRowAmount(order.allocationBatchAmount)
  // NO RECORDED DEBIT, NO SHARE — and no refusal either. A2 nulls this column on the paths that
  // withdraw an unposted staging, so "nothing recorded" is a POSITIVE answer of zero, not an
  // absence that has to be resolved by a human.
  if (recorded <= 0) return { kind: 'known', amount: 0 }
  const passes = parseAllocationDebitPasses(order.allocationBatchPasses)
  if (!passes) {
    return {
      kind: 'unattributed',
      reason: `${describeBatchRow(order)} records a cumulative A2 debit of £${recorded.toFixed(2)} with no pass history, so how much of it this batch carried cannot be established`,
    }
  }
  // THE HISTORY MUST ACCOUNT FOR THE FIGURE, the same test `proveAllocationDebitPosting` applies. A
  // history that sums to less than the recorded amount has pounds in it no pass claims, so the share
  // it reports for any one batch is a share of a figure it does not describe.
  const passTotal = sumAllocationDebitPasses(passes)
  if (Math.abs(passTotal - recorded) > 0.005) {
    return {
      kind: 'unattributed',
      reason: `${describeBatchRow(order)} records a cumulative A2 debit of £${recorded.toFixed(2)} but its ${passes.length} recorded pass(es) account for £${passTotal.toFixed(2)}, so how much of it this batch carried cannot be established`,
    }
  }
  // THE STAMP IS THE BATCH BEING REBUILT. The sweep folds this row into the bucket for the reference
  // persisted beside its stamp, so the passes that named THAT reference are this order's share of
  // it. A row with no persisted reference is a pre-column row: it is bucketed by a key derived from
  // its stage stamp, which no pass can be matched against.
  if (!order.inventoryAllocatedBatchRef) {
    return {
      kind: 'unattributed',
      reason: `${describeBatchRow(order)} records a cumulative A2 debit of £${recorded.toFixed(2)} and names no batch reference, so which batch carried which part of it cannot be established`,
    }
  }
  const named = passes.filter((pass) => pass.batchRef === order.inventoryAllocatedBatchRef)
  // SAME LEDGER, SAME BATCH, ANOTHER ACCOUNT — the one arm that is genuinely ambiguous rather than
  // simply somebody else's. The rebuild would debit the account configured TODAY while the pass
  // that owed the pounds names a different one in the SAME books, so neither figure describes the
  // other and no rebuild can be right. Refused, like every other state the history cannot settle.
  const otherAccount = named.find((pass) => (
    pass.connector === ledger.connector && pass.accountCode !== null && pass.accountCode !== ledger.accountCode
  ))
  if (otherAccount) {
    return {
      kind: 'unattributed',
      reason: `${describeBatchRow(order)} recorded its A2 debit for this batch against account ${otherAccount.accountCode} on ${ledger.connector}, but Allocated Inventory is configured as ${ledger.accountCode} today, so what this batch owes that account cannot be established`,
    }
  }
  // A PASS ON ANOTHER LEDGER IS A POSITIVE ANSWER OF ZERO, NOT A REFUSAL. The pounds are in the
  // other connector's books, its own sweep can see its own log, and this one has nothing to rebuild
  // — so the honest share here is £0.00 and the batch is skipped in silence. Refusing instead would
  // report every pre-switch batch in the retention window, every day, as a problem that is not one.
  return {
    kind: 'known',
    amount: sumAllocationDebitPasses(named.filter((pass) => passIsOfLedger(pass, ledger))),
  }
}

/**
 * o3d-i0o6 r5 (Codex round 4, HIGH 2) — A REBUILT JOURNAL REPLACES THE EVIDENCE, NOT JUST THE ROW.
 *
 * `recreateMissingDailyBatchLogs` mints a NEW sync log for a batch whose own log went missing (or
 * was cancelled and resolved). The orders in that batch still record the OLD id in their pass
 * history — and that id is exactly what {@link proveAllocationDebitPosting} resolves before it will
 * authorise a credit.
 *
 * So the rebuild used to post a debit that could never be reversed. The recreated journal settles,
 * the pounds are genuinely in Allocated Inventory, and every later refund and orphan reversal reads
 * a pass naming a row that is absent (retention) or CANCELLED, refuses, and withholds the credit —
 * for ever, because nothing ever rewrites that id. Money in, no way out.
 *
 * The evidence therefore moves with the journal, inside the SAME transaction that creates it: every
 * pass that named THIS batch on THIS ledger is re-pointed at the row that now carries its pounds.
 * Only those passes — a pass on another ledger, or naming another batch, is about a journal this
 * rebuild did not replace and must keep saying so.
 *
 * Returns null when nothing was re-pointed (an unreadable history, or no pass of this batch and
 * ledger), so the caller writes nothing rather than an update that says the same as the row.
 */
export function repointAllocationDebitPassesToRecreatedJournal(input: {
  /** The raw `SalesOrder.allocationBatchPasses` JSON. */
  existingPasses: unknown
  /** The batch reference the rebuild was raised under — the order's OWN persisted reference. */
  batchRef: string
  /** The ledger and account the rebuild posts into; only passes naming both are re-pointed. */
  ledger: AllocationDebitBatchLedger
  /** The id of the sync log just created for that batch. */
  syncLogId: string
}): {
  allocationBatchPasses: SerializedAllocationDebitPass[]
  /**
   * The three latest-pass columns' new values, or NULL when the latest pass is not one of the ones
   * that moved. Handed back as data rather than as a ready-made Prisma `data` object so the caller
   * spells out every column it writes — o3d-psrx's write census reads those literals, and a write
   * assembled elsewhere is a hole in it.
   */
  latestPass: { syncLogId: string; connector: string; accountCode: string } | null
} | null {
  const passes = parseAllocationDebitPasses(input.existingPasses)
  if (!passes) return null
  let changed = false
  let lastChanged = false
  const rewritten = passes.map((pass, index) => {
    if (pass.batchRef !== input.batchRef || !passIsOfLedger(pass, input.ledger)) return pass
    if (pass.syncLogId === input.syncLogId) return pass
    changed = true
    if (index === passes.length - 1) lastChanged = true
    return { ...pass, syncLogId: input.syncLogId }
  })
  if (!changed) return null
  return {
    allocationBatchPasses: rewritten.map(serializePass),
    // THE THREE LATEST-PASS COLUMNS FOLLOW THE LATEST PASS, and only when it is one of the ones
    // that moved. They describe the pass that wrote them; re-pointing an EARLIER pass says nothing
    // about the latest one, and rewriting them anyway would make this function a second writer of
    // facts it did not establish.
    latestPass: lastChanged
      ? {
          syncLogId: input.syncLogId,
          connector: input.ledger.connector,
          accountCode: input.ledger.accountCode,
        }
      : null,
  }
}

/**
 * One A2 recreate bucket's accumulator, shared by both connectors (o3d-i0o6 r4).
 *
 * `total` is the sum of the orders' own SHARES of this batch and never of their cumulative debits;
 * `unattributed` is the reason, per order, that a share could not be established. The two are kept
 * apart because they lead to opposite acts — a total of zero means "raise no journal", an
 * unattributed entry means "raise no journal AND tell somebody".
 *
 * `orders` (o3d-i0o6 r5) is the rows whose evidence the rebuild must re-point at the journal it
 * mints. It is carried on the bucket rather than re-queried after the fact because the re-point has
 * to happen in the same transaction as the create — see
 * {@link repointAllocationDebitPassesToRecreatedJournal}.
 */
export type A2RecreateSummary = {
  orderCount: number
  total: number
  unattributed: string[]
  orders: Array<{ id: string; batchRef: string; allocationBatchPasses: unknown }>
}

/** A fresh, empty A2 recreate bucket. One spelling, so the two sweeps cannot seed different shapes. */
export function newA2RecreateSummary(): A2RecreateSummary {
  return { orderCount: 0, total: 0, unattributed: [], orders: [] }
}

/**
 * Fold one staged order into an A2 recreate bucket: its share of the batch, or the reason there
 * is none to be had (o3d-i0o6 r5).
 *
 * Shared by both sweeps, because the rule is the same on both and a second spelling of it is how
 * the two drift — which is the whole reason the ledger filter above exists.
 */
export function foldA2RecreateOrder(
  summary: A2RecreateSummary,
  order: AllocationDebitBatchRow & { id: string },
  ledger: AllocationDebitBatchLedger,
): void {
  summary.orderCount += 1
  const share = allocationDebitShareOfBatch(order, ledger)
  if (share.kind === 'unattributed') {
    summary.unattributed.push(share.reason)
    return
  }
  summary.total += share.amount
  if (order.inventoryAllocatedBatchRef) {
    summary.orders.push({
      id: order.id,
      batchRef: order.inventoryAllocatedBatchRef,
      allocationBatchPasses: order.allocationBatchPasses,
    })
  }
}

/**
 * The one wording both connectors report an unattributable A2 rebuild with (o3d-i0o6 r4).
 *
 * Two spellings of one refusal is how the two sweeps drift apart, and this one has to say the same
 * thing on both because the defect it refuses is the same on both.
 */
export function allocationDebitRecreateRefusal(referenceId: string, reasons: readonly string[]): string {
  return (
    `Daily batch DAILY_BATCH_INVENTORY_ALLOC not recreated: ${referenceId} — ${reasons.join('; ')}. `
    + '`allocationBatchAmount` is the CUMULATIVE total of every Group A2 pass an order has been '
    + 'through, not this batch\'s share of it, so rebuilding the batch from it would re-post pounds '
    + 'an EARLIER batch already carried. If this batch really is missing from the ledger, post it '
    + 'there by hand from the orders it named and leave the stamps alone.'
  )
}
