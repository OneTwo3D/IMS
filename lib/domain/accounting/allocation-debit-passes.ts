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
  /**
   * The pounds this order's recorded passes attribute to the batch it is stamped with, ON THE LEDGER
   * ASKING. `foreign` is the rest: passes of the SAME batch that debited ANOTHER ledger, carried out
   * rather than discarded, because whether those pounds are safe to ignore is a question about the
   * cron's schedule that this pure function cannot answer (o3d-i0o6 r6).
   */
  | { kind: 'known'; amount: number; foreign: readonly AllocationDebitForeignPass[] }
  /** The history cannot divide this order's cumulative debit between batches. `reason` names it. */
  | { kind: 'unattributed'; reason: string }

/** One order's A2 pass into this batch that debited a DIFFERENT ledger from the one rebuilding it. */
export type AllocationDebitForeignPass = {
  /** The order, for the report only — never part of a decision. */
  order: string
  /** The ledger those pounds were actually debited in. Never the sweep's own. */
  connector: string
  /** The Allocated Inventory account they were debited to THERE. */
  accountCode: string
  amount: number
  /** The journal that pass named, or null where it raised none. */
  syncLogId: string | null
}

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
  if (recorded <= 0) return { kind: 'known', amount: 0, foreign: [] }
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
  // A PASS THAT NAMES NO LEDGER IS NOT SOMEBODY ELSE'S — IT IS NOBODY'S (o3d-i0o6 r6).
  // `passIsOfLedger` is an equality on two NULLABLE fields, so a contributing pass with a null
  // connector or a null account fell out of the filter below and was subtracted from this batch in
  // silence — the same silent-zero this round is here to remove, one field along.
  //
  // TODAY'S A2 WRITER CANNOT REACH THIS. `buildAllocationDebitOrderUpdate` nulls the connector and
  // the account exactly when the pass raised NO journal, and a window raises no journal only when
  // its ROUNDED total is not positive — while every order's share of that window is non-negative, so
  // each of them is bounded by the same zero and falls under the half-penny threshold. It is written
  // as a refusal anyway, for the same reason the posting proof spells out its own null-connector
  // arm: "nobody writes null" is a fact about today's writers, and this is a money decision. It is
  // the answer `proveAllocationDebitPosting` already gives such a pass on the credit side.
  const unnamed = named.find((pass) => (
    Math.abs(pass.amount) > 0.005 && (!pass.connector || !pass.accountCode)
  ))
  if (unnamed) {
    return {
      kind: 'unattributed',
      reason: `${describeBatchRow(order)} recorded £${unnamed.amount.toFixed(2)} of its A2 debit for this batch naming ${unnamed.connector ? `no account (on ${unnamed.connector})` : 'no ledger'}, so whether those pounds are this rebuild's to raise cannot be established`,
    }
  }
  // A PASS ON ANOTHER LEDGER IS NOT THIS SWEEP'S TO REBUILD — AND IS NOT AUTOMATICALLY SOMEBODY
  // ELSE'S EITHER (o3d-i0o6 r6, Codex round 5 HIGH 1).
  //
  // r5 made it a positive share of £0.00 and said nothing, arguing that the other connector's own
  // sweep can see its own log and will rebuild it. The daily-batch cron runs exactly ONE sweep — the
  // first enabled plugin's — so after a switch that sweep never runs, and the pounds were abandoned
  // in silence with this function's own verdict saying they were accounted for. Silent abandonment
  // of money is worse than a refusal repeated daily.
  //
  // The share stays £0.00, because rebuilding another ledger's pounds into these accounts is the
  // duplicate-debit defect this ledger filter exists for. What changes is that the pass is HANDED
  // BACK instead of dropped, so the caller — which can see whether that ledger's journal is still
  // standing and whether its sweep is the one the cron runs — can report the ones nobody is coming
  // for. Anything this function decided on its own would be a scheduling rule written by a pure
  // function with no way to read the schedule.
  const foreign = named
    .filter((pass) => !passIsOfLedger(pass, ledger) && Math.abs(pass.amount) > 0.005)
    .map((pass) => ({
      order: describeBatchRow(order),
      // Non-null by the `unnamed` refusal above, and not `!`-asserted: a cast that survives a later
      // edit to that refusal would put `undefined` into a report about money.
      connector: pass.connector ?? '',
      accountCode: pass.accountCode ?? '',
      amount: pass.amount,
      syncLogId: pass.syncLogId,
    }))
  return {
    kind: 'known',
    amount: sumAllocationDebitPasses(named.filter((pass) => passIsOfLedger(pass, ledger))),
    foreign,
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
  /**
   * o3d-i0o6 r6: the passes of this batch that debited ANOTHER ledger. Not part of `total` — this
   * sweep may not raise them — and not part of `unattributed` either, because "not mine" is not
   * "unknowable". They are carried so the caller can ask the one question that decides whether they
   * are abandoned: is their own ledger's journal still standing, and is its sweep the one that runs?
   */
  foreign: AllocationDebitForeignPass[]
}

/** A fresh, empty A2 recreate bucket. One spelling, so the two sweeps cannot seed different shapes. */
export function newA2RecreateSummary(): A2RecreateSummary {
  return { orderCount: 0, total: 0, unattributed: [], orders: [], foreign: [] }
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
  summary.foreign.push(...share.foreign)
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
/**
 * o3d-i0o6 r6 (Codex round 5, HIGH 1) — THE POUNDS NO SWEEP WILL EVER RAISE, REPORTED.
 *
 * A rebuild may only raise its OWN ledger's share of a batch. That leaves the other ledger's share,
 * and r5 treated it as settled by somebody else's sweep. The daily-batch cron runs ONE sweep, so
 * "somebody else's sweep" is often nobody at all, and the pounds were dropped in silence.
 *
 * Three states, and only one of them is loud:
 *
 *   the other ledger's journal is LIVE      nothing is missing there; silent, and the common case
 *                                           after a switch — every pre-switch batch in the retention
 *                                           window is in exactly this state, which is why an
 *                                           unconditional report would be pure noise.
 *   it is missing, but that ledger's sweep   it will be rebuilt on that ledger's next tick; silent.
 *     is the one the cron runs
 *   it is missing and nothing runs it        nobody is coming. REPORTED, every run, until a human
 *                                           posts it or re-enables that sweep.
 *
 * Both sweeps call this, because the answer must not depend on which one happens to be running.
 */
export function allocationDebitForeignLedgerReports(input: {
  /** The batch being rebuilt, for the report. */
  referenceId: string
  foreign: readonly AllocationDebitForeignPass[]
  /** Whether the journal a foreign pass named is still a live row in its OWN ledger. */
  journalIsLive: (syncLogId: string | null) => boolean
  /** The connector whose daily-batch sweep the cron runs, or null when none runs at all. */
  scheduledSweepConnector: string | null
}): string[] {
  const abandoned = input.foreign.filter((pass) => (
    !input.journalIsLive(pass.syncLogId) && pass.connector !== input.scheduledSweepConnector
  ))
  if (abandoned.length === 0) return []
  const byConnector = new Map<string, AllocationDebitForeignPass[]>()
  for (const pass of abandoned) {
    const entries = byConnector.get(pass.connector)
    if (entries) entries.push(pass)
    else byConnector.set(pass.connector, [pass])
  }
  return [...byConnector].map(([connector, entries]) => {
    const total = entries.reduce((sum, entry) => sum + entry.amount, 0)
    const detail = entries
      .map((entry) => `${entry.order} £${entry.amount.toFixed(2)}${entry.syncLogId ? ` under journal ${entry.syncLogId}` : ', which raised no journal at all'} (account ${entry.accountCode})`)
      .join('; ')
    return (
      `Daily batch DAILY_BATCH_INVENTORY_ALLOC not recreated in full: ${input.referenceId} — £${total.toFixed(2)} of it `
      + `was debited to Allocated Inventory on ${connector}, and that journal is NOT on record: ${detail}. `
      + 'This sweep must not rebuild another ledger\'s pounds into its own accounts — that is a duplicate '
      + `debit no refund could ever reverse — and ${input.scheduledSweepConnector ? `the daily batch runs ${input.scheduledSweepConnector}'s sweep, not ${connector}'s` : 'no daily-batch sweep is scheduled at all'}, `
      + `so nothing will ever raise it. Post it in ${connector} by hand from the orders' own pass history, `
      + `or re-enable ${connector}'s daily batch long enough for its own sweep to rebuild it.`
    )
  })
}

export function allocationDebitRecreateRefusal(referenceId: string, reasons: readonly string[]): string {
  return (
    `Daily batch DAILY_BATCH_INVENTORY_ALLOC not recreated: ${referenceId} — ${reasons.join('; ')}. `
    + '`allocationBatchAmount` is the CUMULATIVE total of every Group A2 pass an order has been '
    + 'through, not this batch\'s share of it, so rebuilding the batch from it would re-post pounds '
    + 'an EARLIER batch already carried. If this batch really is missing from the ledger, post it '
    + 'there by hand from the orders it named and leave the stamps alone.'
  )
}
