import { Prisma } from '@/app/generated/prisma/client'
import type { RefundAccountingSettlement } from '@/lib/domain/sales/refund-accounting-obligations'
import type { db } from '@/lib/db'
import { lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'
import { ledgerStanding, rowsThatMayHaveReachedLedger } from '@/lib/domain/accounting/ledger-standing'
import { PRIOR_ATTEMPT_SELECT } from '@/lib/domain/accounting/prior-posting-evidence'

/**
 * THE ONE WRITE THAT DISCHARGES A REFUND'S ACCOUNTING OBLIGATION (o3d-fj4m).
 *
 * It takes `accountingRetryRequired` down and erases `accountingRetrySyncs`, and it does so in ONE
 * statement together with the one fact the hand-off knows at that moment and nothing else records:
 *
 *   If this refund's UNEARNED_REV_REVERSAL was settled by the "will never exist" decision (the pinned
 *   configuration does not post that type), then no journal exists for it and none ever will, so the
 *   `allocatedReliefAmount` staging recorded for it - "what the journal this refund is about to queue
 *   WILL raise" - is a claim about a posting with no counterpart. It is written down to 0 here, in the
 *   same statement that clears the flag, because the next refund of the order reads an ABSENT journal
 *   as "retention deleted it" and counts the recorded amount as relief it never was. 0 is the vocabulary
 *   the reader already has - a recorded zero is "this refund raised no CR Allocated line at all".
 *
 * BUT "DECIDED NEVER" IS A VERDICT ABOUT THE CONFIGURATION NOW, NOT ABOUT WHAT ALREADY HAPPENED (Codex
 * HIGH on #733). The enqueue asks "is posting enabled" BEFORE it looks for a prior journal, so a refund
 * whose reversal was queued (or posted) and whose process died before this discharge, retried after the
 * sync was switched off, reads "decided never" for a journal that EXISTS. Zeroing then makes the next
 * refund skip that journal and credit the whole open balance a second time. So before zeroing, every
 * prior attempt for THIS refund's reversal is read - under the same follow-up scope lock the enqueue
 * takes, in the same transaction as the write, so there is no check-then-act gap - and classified by the
 * ledger-standing module. Only when every attempt is PROVEN_NOT_POSTED, or none exists, is the relief
 * written down. A CONFIRMED_POSTED attempt means the journal posted: the obligation is DISCHARGED (the flag
 * and the staged record come down) and the relief is KEPT. Any other standing (LIVE_WORK, ASSERTED_*,
 * UNKNOWN) means a journal may have posted or may still post: the relief is KEPT and the obligation is left
 * UNRESOLVED (nothing is discharged; the flag stays), so a retry once posting is back on settles against the
 * real row.
 *
 * WHAT IT DOES NOT DO: it never touches the amount when the reversal was QUEUED, and it is never called
 * for a refund whose hand-off refused or threw.
 *
 * ONE STATEMENT, NOT TWO: clearing the flag first and zeroing afterwards would leave a window in which
 * the refund no longer blocks the next one and its relief stands.
 */
export function refundReversalDecidedNeverToPost(
  refundId: string,
  settlement: RefundAccountingSettlement,
): boolean {
  return settlement.decidedNeverToPost.some((obligation) => (
    obligation.type === 'UNEARNED_REV_REVERSAL'
    && obligation.referenceType === 'SalesOrderRefund'
    && obligation.referenceId === refundId
  ))
}

export type RefundDischargeResult =
  | { discharged: true; reliefWrittenDown: boolean }
  | { discharged: false; reason: string }

export async function dischargeRefundAccountingObligation(
  client: Pick<typeof db, '$transaction'>,
  refundId: string,
  settlement: RefundAccountingSettlement,
): Promise<RefundDischargeResult> {
  const decidedNever = refundReversalDecidedNeverToPost(refundId, settlement)
  return client.$transaction(async (tx) => {
    let zero = false
    if (decidedNever) {
      const where = { type: 'UNEARNED_REV_REVERSAL' as const, referenceType: 'SalesOrderRefund', referenceId: refundId }
      // Lock every connector an enqueue for this posting could take the scope lock under: the pinned one
      // (a concurrent enqueue) and each one a prior row sits on. Then read under the locks.
      const seen = await tx.accountingSyncLog.findMany({ where, select: { connector: true } })
      const connectors = new Set<string>(seen.map((row) => row.connector))
      if (settlement.pinnedConnector) connectors.add(settlement.pinnedConnector)
      for (const connector of [...connectors].sort()) {
        await lockFollowUpScope(tx, { connector, type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: refundId })
      }
      const rows = await tx.accountingSyncLog.findMany({ where, select: PRIOR_ATTEMPT_SELECT })
      // The SAME predicate the amount reader uses (rowsThatMayHaveReachedLedger): attempts proven never to have
      // reached the ledger are not part of what posted, so the two cannot disagree about a mixed set.
      const counted = rowsThatMayHaveReachedLedger(rows)
      const standings = counted.map((row) => ledgerStanding(row))
      const unsettled = standings.filter((standing) => standing !== 'PROVEN_NOT_POSTED' && standing !== 'CONFIRMED_POSTED')
      if (unsettled.length > 0) {
        const live = unsettled.includes('LIVE_WORK')
        return {
          discharged: false as const,
          reason: `the reversal journal for refund ${refundId} was settled as "will never post" under the current configuration, but ${unsettled.length} earlier attempt(s) for it exist (${[...new Set(unsettled)].join(', ')}): it may have posted or may still post, so its recorded relief is kept and the refund's accounting stays outstanding. `
            + (live
              ? 'A queued row drains once posting is enabled again; if the connector has been retired, settle that row from the sync exceptions list (per-row settlement) after checking the ledger, then retry. '
              : 'Check the ledger for that journal and settle the row from the sync exceptions list (per-row settlement), then retry. ')
            + 'Until then this refund blocks further refunds on the order.',
        }
      }
      zero = counted.length === 0
    }
    await tx.salesOrderRefund.update({
      where: { id: refundId },
      data: {
        accountingRetryRequired: false,
        accountingWarning: null,
        accountingRetrySyncs: Prisma.DbNull,
        ...(zero ? { allocatedReliefAmount: 0 } : {}),
      },
    })
    return { discharged: true as const, reliefWrittenDown: zero }
  })
}
