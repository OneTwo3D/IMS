/**
 * o3d-i0o6 — WAS GROUP A2'S DEBIT ACTUALLY POSTED, TO THE LEDGER AND THE ACCOUNT THIS CREDIT WOULD
 * REACH? ONE ANSWER, FOR EVERY PATH THAT CREDITS ALLOCATED INVENTORY.
 *
 * Two paths reverse the Group A2 contra (DR Allocated Inventory / CR Inventory), and until this
 * module existed they answered that question differently:
 *
 *   * `refund-service.ts` resolves the three-part attribution A2 records with the amount —
 *     `allocationBatchSyncLogId`, `allocationBatchConnector`, `allocationBatchAccountCode` — back to
 *     the journal row, and REFUSES where the journal is absent, not SYNCED, on another connector, or
 *     against another account.
 *   * `allocation-service.reverseOrphanedAllocationPosting` read `postedUnitCostBase` off the
 *     allocation row's snapshot entries and treated it as proof. It is not, and o3d-o97 r3 had
 *     already established that ON THIS EXACT CONTRA about the per-order twin of that field. The
 *     reasons transfer one-for-one, because the two amounts are written by the same statement:
 *
 *       NO JOURNAL     `withPostedUnitCost` stamps every entry the A2 pass values, unconditionally,
 *                      BEFORE the `totalAllocatedValueNumber > 0` guard that decides whether a batch
 *                      log is created at all (`lib/connectors/xero/daily-sync.ts`). A window that
 *                      values at nothing stamps amounts and raises no journal.
 *       NEVER POSTED   the log is created PENDING, inside the batch transaction. The remote call is
 *                      a DIFFERENT transaction, and it can end FAILED, or CANCELLED as a
 *                      cross-connector orphan when the active connector is switched.
 *       NO DESTINATION the entry amount names no ledger and no account. A reversal is raised on the
 *                      connector active NOW, against the Allocated Inventory account configured NOW.
 *
 * The direction of that error is the bad one: it MOVES MONEY THAT WAS NEVER THERE. A credit raised
 * against a debit that never posted takes real pounds out of a real account; a credit raised on the
 * wrong ledger does that AND leaves the original debit standing in the other one.
 *
 * SO THE QUESTION IS ASKED ONCE, HERE, AND IT IS THE QUESTION THE CALLER ACTUALLY NEEDS — not the
 * neighbouring one that is easier to reach. "An amount was recorded" is reachable from the row in
 * front of you. "A journal carrying it settled, on this connector, against this account" is not, and
 * it is the only one a credit may be raised on.
 *
 * IT IS DELIBERATELY NOT {@link resolveStagedAllocationDebit}, WHICH ANSWERS THE OPPOSITE POLARITY.
 * That one asks "may pounds still be sitting in Allocated Inventory?" and answers YES whenever the
 * fact cannot be established, because its caller is deciding whether to DESTROY EVIDENCE and the
 * safe side there is to keep it. A reversal's safe side is the other one: where the fact cannot be
 * established it must NOT post. Reusing that verdict here would turn every "we cannot know" into a
 * journal, which is precisely the defect. Two questions, two functions, one file each — and neither
 * caller can reach for the other's answer by accident.
 */

export type JournalLedgerProof =
  | { kind: 'proved'; amount: number }
  | { kind: 'illegible' }
  | { kind: 'unproved'; statuses: string }

function boundaryNumber(value: unknown): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number((value as { toString(): string }).toString())
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The account's NET movement across a journal payload's own lines, in the direction the caller
 * names. Net, never gross: a batch journal can touch one account on BOTH sides (two settings roles
 * mapped to the same code, a reconciliation rounding line), and a gross read lets a share be
 * "inside its batch" against a journal that moved the account a fraction of that.
 *
 * An empty account code is not a match — an unconfigured account would otherwise sum every line
 * whose own accountCode is blank (o3d-o97 r2).
 */
export function extractPayloadNetMovement(
  payload: unknown,
  accountCode: string,
  side: 'credit' | 'debit',
): number {
  if (!accountCode) return 0
  const linesPayload = (payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> } | null)?.lines
  if (!Array.isArray(linesPayload)) return 0
  return linesPayload.reduce((sum, line) => {
    if (line.accountCode !== accountCode) return sum
    const debit = boundaryNumber(line.debit ?? 0)
    const credit = boundaryNumber(line.credit ?? 0)
    return sum + (side === 'credit' ? credit - debit : debit - credit)
  }, 0)
}

/**
 * o3d-o97 r5 — WHAT A JOURNAL ROW PROVES, WHICH IS NEVER ITS STATUS.
 *
 * SYNCED says the ROW SETTLED; it does not say which accounts the journal touched, nor with how
 * much. CANCELLED says the row was ABANDONED — by the cross-connector orphan sweep, by an order
 * cancellation, or by an operator — none of which can see whether the remote call had already
 * landed, because the processors post BEFORE persisting SYNCED. So proof is (a) every row settled,
 * (b) its lines legible, and then (c) the figure comes from the lines.
 *
 * ILLEGIBLE is its own answer and is not a refusal: `backReferenceEvidenceCompactedAt` compaction
 * drops `payload` from a row it keeps, which is the same epistemic position as a row retention has
 * deleted outright. The CALLER resolves it, to whichever side moves the least money.
 */
/**
 * Whether a sync row still carries readable journal lines. `backReferenceEvidenceCompactedAt`
 * compaction drops `payload` from a row it keeps, so a settled row can be present with nothing
 * readable on it — which is an ANSWER ("finished, outcome no longer legible"), not an error.
 */
export function payloadLinesLegible(payload: unknown): boolean {
  return Array.isArray((payload as { lines?: unknown } | null)?.lines)
}

export function proveJournalPosting(
  rows: Array<{ status: string; payload: unknown }>,
  accountCode: string,
  side: 'credit' | 'debit',
): JournalLedgerProof {
  if (rows.length === 0) return { kind: 'unproved', statuses: 'absent' }
  if (rows.some((row) => row.status !== 'SYNCED')) {
    return { kind: 'unproved', statuses: rows.map((row) => row.status).join('/') }
  }
  if (rows.some((row) => !payloadLinesLegible(row.payload))) return { kind: 'illegible' }
  if (!accountCode) return { kind: 'unproved', statuses: 'no Allocated Inventory account configured' }
  return {
    kind: 'proved',
    // Floored at zero because a negative net is the account moving the OTHER WAY, which is not a
    // smaller debit but none of one.
    amount: Math.max(0, rows.reduce(
      (sum, row) => sum + extractPayloadNetMovement(row.payload, accountCode, side),
      0,
    )),
  }
}

/** The three-part attribution A2 writes in the SAME UPDATE as the stamp, plus the stamp and amount. */
export type AllocationDebitAttribution = {
  inventoryAllocatedDate: Date | null
  /** Prisma Decimal | number | null. */
  allocationBatchAmount: { toString(): string } | number | null
  allocationBatchSyncLogId: string | null
  allocationBatchConnector: string | null
  allocationBatchAccountCode: string | null
}

/**
 * WHERE THIS CREDIT WOULD LAND. Both fields are REQUIRED, and `activeConnector` is `string | null`
 * rather than optional on purpose (o3d-i0o6).
 *
 * An OPTIONAL connector reads as the permissive answer when absent: `if (active && recorded &&
 * active !== recorded)` skips the whole cross-ledger refusal the moment the caller forgets to pass
 * it, and a money decision is silently weakened by an omission the type system was happy with. A
 * caller that cannot say which ledger it is about to post into has not established the one fact this
 * proof is for, so `null` is a REFUSAL and not a pass.
 */
export type AllocationDebitCreditTarget = {
  /** The connector the credit would be raised on, or null when that cannot be established. */
  activeConnector: string | null
  /** The Allocated Inventory account the credit would be raised against, as configured NOW. */
  allocatedInventoryAccount: string
}

export type AllocationDebitPostingProof =
  /**
   * POSITIVE evidence that no A2 debit stands: A2 never staged this order, or staged it and
   * recorded a debit of exactly £0.00. "Nothing to reverse" is a different fact from "we do not
   * know", and this is the one that is known.
   */
  | { kind: 'none'; reason: string }
  /**
   * The order was staged before the attribution columns existed: an amount and a stamp, and nothing
   * that names a journal. Nothing can retroactively prove a 2025 batch posted, so this is NOT a
   * proof — it is the older amount-implies-posting inference, handed back to the caller UNDER ITS
   * OWN NAME so each caller decides whether it is good enough for what it is about to do.
   */
  | { kind: 'unattributed'; recordedDebit: number; reason: string }
  /** The journal is on record, settled, on this connector, against this account, and its own lines carry the debit. */
  | { kind: 'posted'; recordedDebit: number; journalId: string; connector: string | null; accountCode: string | null; reason: string }
  /** The fact cannot be established. `reason` is written for an operator who has to repair it by hand. */
  | { kind: 'refused'; reason: string }

export type AllocationDebitPostingProofClient = {
  accountingSyncLog: {
    findUnique(args: {
      where: { id: string }
      select: { status: true; connector: true; payload: true }
    }): Promise<{ status: string; connector: string | null; payload: unknown } | null>
  }
}

function recordedAmount(value: AllocationDebitAttribution['allocationBatchAmount']): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value.toString())
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Answers, for ONE order: is the Group A2 debit proved to have posted where this credit would land?
 *
 * The refusals are the ones o3d-o97 r3/r5 established on the refund side of this same contra, in the
 * same order and in the same words, because they are the same refusals — a second wording would be a
 * second rule.
 */
export async function proveAllocationDebitPosting(
  client: AllocationDebitPostingProofClient,
  order: AllocationDebitAttribution,
  target: AllocationDebitCreditTarget,
): Promise<AllocationDebitPostingProof> {
  // THE STAMP IS NOT THE DISCRIMINATOR, and this is the one place the two questions could have been
  // confused again. `inventoryAllocatedDate` is a claim about work A2 still has TO DO — the DECLARED
  // un-stage in `resetAllocationAccountingIfStaged` clears it, on an order whose debit is standing,
  // precisely so A2 comes back and posts the INCREMENT — and it deliberately leaves the recorded
  // amount and the journal attribution behind when it does. Gating on the stamp would therefore read
  // a real, proved, still-open A2 debit as "never posted" on every order that has been edited once.
  // What proves a posting is the attribution A2 wrote WITH the amount; the stamp is only consulted to
  // tell "A2 recorded nothing because it never ran" from "A2 ran and recorded no figure".
  const recorded = recordedAmount(order.allocationBatchAmount)
  if (recorded === null) {
    if (!order.inventoryAllocatedDate) {
      return { kind: 'none', reason: 'Group A2 never staged this order, so nothing was debited to Allocated Inventory' }
    }
    return {
      kind: 'refused',
      reason: 'the order carries an A2 stamp with no recorded allocation amount, so the pounds A2 debited to Allocated Inventory are not on record and cannot be reversed automatically',
    }
  }
  if (recorded <= 0) {
    return { kind: 'none', reason: 'Group A2 recorded a debit of £0.00 for this order, so there is nothing in Allocated Inventory to reverse' }
  }
  if (!order.allocationBatchSyncLogId) {
    return {
      kind: 'unattributed',
      recordedDebit: recorded,
      reason: `Group A2 staged this order for £${recorded.toFixed(2)} and named no journal, so whether that debit reached a ledger — and which ledger — cannot be established`,
    }
  }
  if (!target.activeConnector) {
    return {
      kind: 'refused',
      reason: 'the accounting connector this reversal would be raised on cannot be established, so there is no way to tell whether it is the ledger A2 debited',
    }
  }
  const recordedConnector = order.allocationBatchConnector
  const recordedAccount = order.allocationBatchAccountCode
  if (recordedConnector && recordedConnector !== target.activeConnector) {
    return {
      kind: 'refused',
      reason: `A2 debited Allocated Inventory on ${recordedConnector}, but this reversal would be raised on ${target.activeConnector} — crediting it there would leave the ${recordedConnector} debit standing and move pounds a ${target.activeConnector} ledger never held`,
    }
  }
  if (recordedAccount && recordedAccount !== target.allocatedInventoryAccount) {
    return {
      kind: 'refused',
      reason: `A2 debited account ${recordedAccount}, but Allocated Inventory is configured as ${target.allocatedInventoryAccount} today — the reversal would credit an account that was never debited for this order`,
    }
  }
  const journal = await client.accountingSyncLog.findUnique({
    where: { id: order.allocationBatchSyncLogId },
    select: { status: true, connector: true, payload: true },
  })
  if (!journal) {
    return {
      kind: 'refused',
      reason: 'the A2 journal this order was staged into is no longer on record (retention), so whether it reached the ledger cannot be established',
    }
  }
  if (journal.connector && journal.connector !== target.activeConnector) {
    // o3d-o97 r5: the ROW's connector, not only the stamp beside the amount. The stamp is written by
    // the batch in the same statement as the figure; the row is the ledger's own record of which
    // books it was raised into, and they are two different assertions.
    return {
      kind: 'refused',
      reason: `the A2 journal this order was staged into was raised on ${journal.connector}, but this reversal would be raised on ${target.activeConnector} — a credit there would move pounds that ledger never held`,
    }
  }
  if (journal.status !== 'SYNCED') {
    return {
      kind: 'refused',
      reason: `the A2 journal this order was staged into is ${journal.status}, not SYNCED — nothing has been debited to Allocated Inventory for this order to reverse`,
    }
  }
  // o3d-o97 r5 — AND SYNCED IS STILL NOT A STATEMENT ABOUT POUNDS. The batch journal covers a whole
  // day, so its DR to Allocated Inventory is the window's total and this order's recorded share must
  // fit inside it. An ILLEGIBLE payload is not a contradiction — it is the recorded attribution being
  // the only evidence left, which is the state every pre-column order is in already — so it falls
  // through to the recorded figure.
  const proof = proveJournalPosting([journal], target.allocatedInventoryAccount, 'debit')
  if (proof.kind === 'proved' && proof.amount <= 0) {
    return {
      kind: 'refused',
      reason: `the A2 journal this order was staged into has settled, but its lines debit nothing to Allocated Inventory (${target.allocatedInventoryAccount}) — the £${recorded.toFixed(2)} recorded against this order is contradicted by the journal that was to carry it`,
    }
  }
  if (proof.kind === 'proved' && recorded > proof.amount + 0.005) {
    return {
      kind: 'refused',
      reason: `this order records a £${recorded.toFixed(2)} share of an A2 journal that debited Allocated Inventory only £${proof.amount.toFixed(2)} in total — a share cannot exceed its batch, so the pounds standing against this order cannot be established`,
    }
  }
  return {
    kind: 'posted',
    recordedDebit: recorded,
    journalId: order.allocationBatchSyncLogId,
    connector: recordedConnector,
    accountCode: recordedAccount,
    reason: `Group A2 debited Allocated Inventory £${recorded.toFixed(2)} for this order under journal ${order.allocationBatchSyncLogId} (SYNCED)`,
  }
}
