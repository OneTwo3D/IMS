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
