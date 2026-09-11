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
 * o3d-i0o6 r3 — AND THE QUESTION IS ASKED OF THE WHOLE DEBIT, NOT OF ITS LAST INSTALMENT.
 *
 * r2 asked it of the three attribution columns, which is the SAME defect one level deeper. Both A2
 * writers ACCUMULATE `allocationBatchAmount` across incremental passes — the declared allocation
 * rewrite hands a stamped order back with its debit standing and A2 posts the increment alone — and
 * REPLACE the journal id, the connector and the account code with the latest pass's. So the amount
 * was cumulative and the attribution was not, and the two were being compared:
 *
 *   a first pass debits £50 under a journal that FAILS, or settles on another ledger. A later pass
 *   debits a £5 increment into a SYNCED batch with £900 of room. The order records £55 attributed to
 *   the £5 journal, the proof resolves that journal and answers `posted` for £55 — and the refund's
 *   residue and the orphan reverser credit £55, of which £50 was never debited in these books.
 *
 * A fact about the LATEST pass is not a fact about the WHOLE debit. The rule enforced from r3 on is
 * therefore: a verdict of `posted` for an amount means EVERY pass making up that amount is proved,
 * on ONE ledger. The evidence that makes that askable is `SalesOrder.allocationBatchPasses`, written
 * by the same statement that accumulates the amount — see
 * `@/lib/domain/accounting/allocation-debit-passes`. Where the pass history cannot establish it, the
 * verdict is not `posted`, and no verdict but `posted` carries a figure anyone can credit.
 *
 * IT IS DELIBERATELY NOT {@link resolveStagedAllocationDebit}, WHICH ANSWERS THE OPPOSITE POLARITY.
 * That one asks "may pounds still be sitting in Allocated Inventory?" and answers YES whenever the
 * fact cannot be established, because its caller is deciding whether to DESTROY EVIDENCE and the
 * safe side there is to keep it. A reversal's safe side is the other one: where the fact cannot be
 * established it must NOT post. Reusing that verdict here would turn every "we cannot know" into a
 * journal, which is precisely the defect. Two questions, two functions, one file each — and neither
 * caller can reach for the other's answer by accident.
 */

import {
  parseAllocationDebitPasses,
  sumAllocationDebitPasses,
} from '@/lib/domain/accounting/allocation-debit-passes'

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

/**
 * WHAT A2 RECORDED ABOUT ITS DEBIT — the cumulative amount, the LATEST pass's three-part attribution,
 * and (o3d-i0o6 r3) THE WHOLE PASS HISTORY BEHIND THAT AMOUNT.
 *
 * The first two cannot be compared with each other and that was the defect: `allocationBatchAmount`
 * accumulates across incremental passes while the three columns beside it are replaced by the
 * latest, so proving the latest journal proved a fraction of the figure it was being read as proving.
 * `allocationBatchPasses` is the list those columns are the last element of — see
 * `@/lib/domain/accounting/allocation-debit-passes`.
 */
export type AllocationDebitAttribution = {
  inventoryAllocatedDate: Date | null
  /** Prisma Decimal | number | null. CUMULATIVE across every A2 pass this order has been through. */
  allocationBatchAmount: { toString(): string } | number | null
  /** The raw `SalesOrder.allocationBatchPasses` JSON; parsed here, never trusted unparsed. */
  allocationBatchPasses: unknown
  /** The LATEST pass only. Kept for the paths that ask about it; never the basis of a verdict. */
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
export type AllocationDebitCreditTarget<C extends string = string> = {
  /**
   * The connector the credit would be raised on, or null when that cannot be established.
   *
   * o3d-i0o6: parameterised so a caller whose connector is a UNION (`'xero' | 'quickbooks'`) gets
   * that union back out of a `posted` verdict, and can hand it straight to an enqueue that demands
   * one. Widening it to `string` here would force a cast at the pin site, and a cast is exactly the
   * place a re-resolution creeps back in.
   */
  activeConnector: C | null
  /** The Allocated Inventory account the credit would be raised against, as configured NOW. */
  allocatedInventoryAccount: string
}

export type AllocationDebitPostingProof<C extends string = string> =
  /**
   * POSITIVE evidence that no A2 debit stands: A2 never staged this order, or staged it and
   * recorded a debit of exactly £0.00. "Nothing to reverse" is a different fact from "we do not
   * know", and this is the one that is known.
   */
  | { kind: 'none'; reason: string }
  /**
   * THE PASSES MAKING UP THIS AMOUNT ARE NOT ON RECORD — the order was staged before the attribution
   * columns existed, or before the pass history did, so there is an amount and nothing that can say
   * which journals carried it.
   *
   * o3d-i0o6 r3 — AND IT CARRIES NO FIGURE, WHICH IS THE POINT. It used to hand back `recordedDebit`
   * "under its own name" so each caller could decide whether the old amount-implies-posting
   * inference was good enough. One of them then used it as a CEILING: a verdict whose own definition
   * is "the posting and the ledger cannot be established" authorised a positive credit, while a
   * plain refusal authorised nothing. Two unprovable states, two different ceilings, and the more
   * ignorant one was the more permissive.
   *
   * A number nobody may act on has no business being in the type, so it is not: the union now gives
   * a figure to `posted` and to nothing else, and a caller that tries to cap on an unprovable
   * verdict does not compile. The recorded amount is still NAMED IN `reason`, for the operator who
   * has to repair it by hand — which is the only reader it was ever safe for.
   */
  | { kind: 'unattributed'; reason: string }
  /**
   * EVERY pass making up the cumulative debit is on record, named a journal, and that journal is
   * settled, on this connector, against this account, with its own lines carrying the pounds.
   *
   * `provedOnConnector` is THE LEDGER THIS VERDICT IS ABOUT (o3d-i0o6), carried out of the proof so
   * a caller cannot go and resolve "the active connector" a second time to act on it. It is
   * non-nullable because the proof refuses outright on a null target, so a `posted` verdict always
   * names one — which is what lets the type system, rather than a comment, stop the credit being
   * queued against a connector the proof was never made on. `connector` beside it is a DIFFERENT
   * fact: what A2's own record says it debited, which is null on a pre-attribution row.
   *
   * `journalIds` is PLURAL (o3d-i0o6 r3) because a cumulative debit is carried by as many journals
   * as there were passes. A singular field here would be the same falsehood the three columns told:
   * one journal's identity standing for a figure several journals carry.
   */
  | {
      kind: 'posted'
      recordedDebit: number
      journalIds: readonly string[]
      provedOnConnector: C
      connector: string | null
      accountCode: string | null
      reason: string
    }
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

/** A pass moved pounds if it is more than half a penny either side of zero. */
function passContributes(amount: number): boolean {
  return Math.abs(amount) > 0.005
}

/**
 * Answers, for ONE order: is the Group A2 debit proved to have posted where this credit would land?
 *
 * The refusals are the ones o3d-o97 r3/r5 established on the refund side of this same contra, in the
 * same order and in the same words, because they are the same refusals — a second wording would be a
 * second rule.
 *
 * o3d-i0o6 r3 — AND EVERY ONE OF THEM IS NOW ASKED OF EVERY PASS, NOT OF THE LATEST ONE.
 *
 * `allocationBatchAmount` is the sum of what every A2 pass debited for this order; the three
 * attribution columns describe only the pass that wrote them last. Resolving that one journal and
 * returning the cumulative figure was a fact about one pass read as a fact about the whole debit —
 * the same defect class this module exists to close, one level deeper. So the question is asked of
 * `allocationBatchPasses`: the passes must SUM to the recorded amount, every pass that moved pounds
 * must name a journal, every one of those journals must be SYNCED on the ONE connector this credit
 * would land in and against the ONE account it would credit, and each journal's own lines must carry
 * at least the pounds this order's passes attributed to it. Anything less is not `posted`.
 */
export async function proveAllocationDebitPosting<C extends string = string>(
  client: AllocationDebitPostingProofClient,
  order: AllocationDebitAttribution,
  target: AllocationDebitCreditTarget<C>,
): Promise<AllocationDebitPostingProof<C>> {
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
  // THE HISTORY, OR NOTHING. A missing or illegible list is the same position as a pre-column row:
  // an amount with nothing that can say which journals carried it. It is NOT a licence to fall back
  // on the latest pass — that fallback is the defect — so it ends here, with a verdict that carries
  // no figure for anyone to cap on.
  const passes = parseAllocationDebitPasses(order.allocationBatchPasses)
  if (!passes) {
    return {
      kind: 'unattributed',
      reason: order.allocationBatchSyncLogId
        ? `Group A2 staged this order for £${recorded.toFixed(2)} across an unrecorded number of passes — the row names journal ${order.allocationBatchSyncLogId}, but that is the LATEST pass only and the amount is the cumulative total of all of them, so how much of it that journal carried cannot be established`
        : `Group A2 staged this order for £${recorded.toFixed(2)} and named no journal, so whether that debit reached a ledger — and which ledger — cannot be established`,
    }
  }
  if (!target.activeConnector) {
    return {
      kind: 'refused',
      reason: 'the accounting connector this reversal would be raised on cannot be established, so there is no way to tell whether it is the ledger A2 debited',
    }
  }
  // THE HISTORY MUST ACCOUNT FOR THE FIGURE. A list that sums to less than the recorded amount has
  // pounds in it that no pass claims — a pass that was never recorded, or an amount written by
  // something that did not go through `buildAllocationDebitOrderUpdate` — and proving the passes
  // present would prove a strict subset of the debit while returning the whole of it.
  const passTotal = sumAllocationDebitPasses(passes)
  if (Math.abs(passTotal - recorded) > 0.005) {
    return {
      kind: 'refused',
      reason: passes.length === 0
        ? `this order records an A2 debit of £${recorded.toFixed(2)} and a pass history containing no passes at all, so nothing on record says which journals carried those pounds`
        : `this order records an A2 debit of £${recorded.toFixed(2)} but its ${passes.length} recorded A2 pass(es) account for £${passTotal.toFixed(2)} — the difference was debited by something that recorded no pass, so the whole figure is unproved`,
    }
  }
  const contributing = passes.filter((pass) => passContributes(pass.amount))
  // AND THE PASSES THAT ARE CHECKED MUST BE THE PASSES THAT MADE THE FIGURE. Everything below
  // examines only passes that moved more than half a penny, so a debit assembled out of passes
  // BELOW that threshold — four of £0.004, no journal between them — would otherwise walk past every
  // check and come out `posted` naming no journal at all. The sub-threshold tail may not be ignored
  // unless it is genuinely a rounding tail.
  const contributingTotal = sumAllocationDebitPasses(contributing)
  if (Math.abs(contributingTotal - recorded) > 0.005) {
    return {
      kind: 'refused',
      reason: `this order's £${recorded.toFixed(2)} A2 debit is made up of passes of which only £${contributingTotal.toFixed(2)} is in passes large enough to carry a journal — the rest was debited in amounts too small to have been posted individually, so the figure cannot be proved`,
    }
  }
  for (const pass of contributing) {
    // A NEGATIVE PASS IS NOT A SMALLER DEBIT. Nothing writes one today; if something starts to, it is
    // a credit hiding inside a figure this proof hands out as a debit, and it must not be netted
    // silently against the passes either side of it.
    if (pass.amount < 0) {
      return {
        kind: 'refused',
        reason: `one of the A2 passes recorded against this order carries a NEGATIVE £${pass.amount.toFixed(2)}, which is a credit and not a debit — the pounds standing in Allocated Inventory for this order cannot be established from a history that nets one against the other`,
      }
    }
    if (!pass.syncLogId) {
      return {
        kind: 'refused',
        reason: `one of the A2 passes making up this order's £${recorded.toFixed(2)} debit valued it at £${pass.amount.toFixed(2)} and raised NO journal, so those pounds reached no ledger and the cumulative figure cannot be reversed as if they had`,
      }
    }
    if (pass.connector && pass.connector !== target.activeConnector) {
      return {
        kind: 'refused',
        reason: `A2 debited Allocated Inventory on ${pass.connector}, but this reversal would be raised on ${target.activeConnector} — crediting it there would leave the ${pass.connector} debit standing and move pounds a ${target.activeConnector} ledger never held`,
      }
    }
    if (!pass.connector) {
      return {
        kind: 'refused',
        reason: `one of the A2 passes making up this order's £${recorded.toFixed(2)} debit names journal ${pass.syncLogId} but no ledger, so whether those pounds are in the books this reversal would credit cannot be established`,
      }
    }
    if (pass.accountCode && pass.accountCode !== target.allocatedInventoryAccount) {
      return {
        kind: 'refused',
        reason: `A2 debited account ${pass.accountCode}, but Allocated Inventory is configured as ${target.allocatedInventoryAccount} today — the reversal would credit an account that was never debited for this order`,
      }
    }
    if (!pass.accountCode) {
      return {
        kind: 'refused',
        reason: `one of the A2 passes making up this order's £${recorded.toFixed(2)} debit names journal ${pass.syncLogId} but no account, so whether the account this reversal would credit is the one that was debited cannot be established`,
      }
    }
  }
  // ONE READ PER JOURNAL, AND EACH JOURNAL ANSWERS FOR THE PASSES THAT NAMED IT. Several passes can
  // share one batch (two increments on the same day), so the share checked against a journal's own
  // lines is the SUM of this order's passes into it — not one pass, and not the cumulative total,
  // which is what made a small increment inside a large batch vouch for everything before it.
  const byJournal = new Map<string, number>()
  for (const pass of contributing) {
    const journalId = pass.syncLogId as string
    byJournal.set(journalId, (byJournal.get(journalId) ?? 0) + pass.amount)
  }
  for (const [journalId, share] of byJournal) {
    const journal = await client.accountingSyncLog.findUnique({
      where: { id: journalId },
      select: { status: true, connector: true, payload: true },
    })
    if (!journal) {
      return {
        kind: 'refused',
        reason: 'the A2 journal this order was staged into is no longer on record (retention), so whether it reached the ledger cannot be established',
      }
    }
    if (journal.connector !== target.activeConnector) {
      // o3d-o97 r5: the ROW's connector, not only the stamp beside the amount. The stamp is written by
      // the batch in the same statement as the figure; the row is the ledger's own record of which
      // books it was raised into, and they are two different assertions.
      //
      // o3d-i0o6 r4: `journal.connector &&` used to guard this, so a row whose connector was ABSENT
      // skipped the comparison entirely and read as a match — an unknown ledger taken as the right
      // one. The column is non-nullable in the schema and both writers set it explicitly, so nothing
      // reaches this arm today; it is written as an equality anyway, because "nobody writes null"
      // is a fact about today's writers and this is a money decision.
      return {
        kind: 'refused',
        reason: journal.connector
          ? `the A2 journal this order was staged into was raised on ${journal.connector}, but this reversal would be raised on ${target.activeConnector} — a credit there would move pounds that ledger never held`
          : `the A2 journal this order was staged into names no ledger, so whether its pounds are in the books this ${target.activeConnector} reversal would credit cannot be established`,
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
    // fit inside it.
    //
    // o3d-i0o6 r4 (Codex round 3, HIGH 2) — AND AN UNREADABLE JOURNAL IS NOT A JOURNAL THAT CHECKS
    // OUT. r3 ran both figure checks under `proof.kind === 'proved'`, so an `illegible` verdict —
    // `backReferenceEvidenceCompactedAt` compaction drops `payload` from a row it keeps — performed
    // NO account check and NO amount check and walked straight on to `posted`. Compaction therefore
    // turned a journal whose readable lines would CONTRADICT the recorded pass (wrong account, zero
    // debit, a debit smaller than this order's share) into authority to credit the whole recorded
    // amount. That is the defect class this module exists for, in its purest form: the absent answer
    // taken as the permissive one.
    //
    // So the verdict is destructured the other way round — anything that is not a PROVED figure ends
    // here. `posted` is now unreachable without a number that came off the journal's own lines,
    // which is what the rule "every journal's own lines cover the passes attributed to it" says.
    // Failing closed caps the caller at £0.00, the same ceiling `unattributed` already carries.
    const proof = proveJournalPosting([journal], target.allocatedInventoryAccount, 'debit')
    if (proof.kind !== 'proved') {
      return {
        kind: 'refused',
        reason: proof.kind === 'illegible'
          ? `the A2 journal this order was staged into has settled but its lines are no longer readable (evidence compaction), so whether it debited Allocated Inventory (${target.allocatedInventoryAccount}) at all — let alone the £${share.toFixed(2)} recorded against this order — cannot be established`
          : `the A2 journal this order was staged into cannot be read as evidence (${proof.statuses}), so the £${share.toFixed(2)} recorded against this order is not proved to have reached Allocated Inventory (${target.allocatedInventoryAccount})`,
      }
    }
    if (proof.amount <= 0) {
      return {
        kind: 'refused',
        reason: `the A2 journal this order was staged into has settled, but its lines debit nothing to Allocated Inventory (${target.allocatedInventoryAccount}) — the £${share.toFixed(2)} recorded against this order is contradicted by the journal that was to carry it`,
      }
    }
    if (share > proof.amount + 0.005) {
      return {
        kind: 'refused',
        reason: `this order records a £${share.toFixed(2)} share of an A2 journal that debited Allocated Inventory only £${proof.amount.toFixed(2)} in total — a share cannot exceed its batch, so the pounds standing against this order cannot be established`,
      }
    }
  }
  const journalIds = [...byJournal.keys()]
  return {
    kind: 'posted',
    recordedDebit: recorded,
    journalIds,
    // The target, not a re-resolution of it: every refusal above compared A2's record against THIS
    // value, so this is the only connector the verdict says anything about.
    provedOnConnector: target.activeConnector,
    connector: contributing[0]?.connector ?? null,
    accountCode: contributing[0]?.accountCode ?? null,
    reason: journalIds.length === 1
      ? `Group A2 debited Allocated Inventory £${recorded.toFixed(2)} for this order under journal ${journalIds[0]} (SYNCED)`
      : `Group A2 debited Allocated Inventory £${recorded.toFixed(2)} for this order across ${journalIds.length} passes, under journals ${journalIds.join(', ')} (all SYNCED)`,
  }
}
