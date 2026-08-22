import type { AccountingSyncType } from '@/app/generated/prisma/client'
import type { AccountingEnqueueOutcome } from '@/lib/accounting'

/**
 * WHAT COUNTS AS PROOF THAT A REFUND'S ACCOUNTING WAS QUEUED (o3d-2sm1 r7, Codex HIGH).
 *
 * WHAT ROUND 6 GOT RIGHT AND WHERE IT STOPPED. r6 moved the clear of `accountingRetryRequired` to
 * after `queueRefundAccountingActions` returns cleanly, so the obligation set at refund INSERT is
 * carried unbroken through staging and through queueing. The POSITION is right. The CONTRACT it
 * rested on was not: `queueAccountingSync` returned `void`, and it returned early — having written
 * nothing — whenever there was no active connector, the connector's sync or this type was switched
 * off, the order had been deleted under the enqueue, or the payload it was built from had been
 * superseded. A clean return was therefore not evidence that anything had been queued, and the flag
 * came down on a no-op. That is the r5/r6 defect through a third seam.
 *
 * SO EVERY ENQUEUE ANSWERS NOW, AND THE ANSWERS ARE COUNTED HERE. `AccountingEnqueueOutcome`
 * separates a durable row (written, or already standing) from a DECISION that nothing will ever
 * post, from a refusal that leaves the posting owed — the same distinction this branch drew one
 * level down between a recorded `[]` and a missing list, and for the same reason: a silent no-op
 * must not read as success. Every recorded obligation is handed to an enqueue, its answer is
 * accounted for, and `settle()` throws unless all of them are met.
 *
 * AND THE CONFIGURATION IS PINNED FOR THE WHOLE HAND-OFF. Each enqueue resolves the active connector
 * and its per-type switch for itself, so a flip part-way through could leave some postings queued
 * and others silently decided away, with one flag coming down over the mixture. The connector and
 * the per-type verdict are read ONCE, when the ledger is opened; every answer is checked against
 * them, and a disagreement is an unmet obligation rather than a settled one.
 *
 * AND BOTH ARMS APPLY THAT CHECK — r8, Codex HIGH. r7 pinned the connector and then checked it in one
 * arm only. The in-transaction arm took a bare `true`, which cannot say WHICH connector produced it,
 * while `queueAccountingSyncTx` resolves the active connector for itself after the pin was taken — so
 * a flip mid-hand-off satisfied the ledger with work queued against a connector the obligations were
 * never reckoned against. The transactional enqueue now answers with the same structured outcome the
 * facade does (`queueAccountingSyncTxWithOutcome`, whose connector is read from inside the enqueue
 * rather than resolved a second time), and this applies the SAME sequence of checks to it. One rule,
 * both arms.
 */
export type RefundAccountingObligation = {
  type: AccountingSyncType
  referenceType: string
  referenceId: string
}

export class RefundAccountingObligationsUnmet extends Error {
  readonly unmet: readonly string[]
  constructor(unmet: string[]) {
    super(
      `${unmet.length} accounting posting${unmet.length === 1 ? ' was' : 's were'} not queued for this `
      + `refund, so its accounting obligation is still outstanding: ${unmet.join('; ')}`,
    )
    this.name = 'RefundAccountingObligationsUnmet'
    this.unmet = unmet
  }
}

export type RefundAccountingObligationLedger = {
  /** The connector every answer in this hand-off is checked against. */
  readonly pinnedConnector: string | null
  /** An obligation handed to the facade enqueue, which reports the connector it answered for. */
  account(obligation: RefundAccountingObligation, outcome: AccountingEnqueueOutcome): void
  /**
   * An obligation queued inside a caller-owned transaction. It answers with the SAME structured
   * outcome the facade arm takes — see `queueAccountingSyncTxWithOutcome`, the adapter that carries
   * the enqueue's own resolved connector out without changing the boolean its other call sites read.
   */
  accountInTransaction(obligation: RefundAccountingObligation, outcome: AccountingEnqueueOutcome): void
  /** Throws unless EVERY recorded obligation was handed to an enqueue and accounted for. */
  settle(): void
}

export async function openRefundAccountingObligationLedger(
  obligations: readonly RefundAccountingObligation[],
  deps: {
    activeConnector: () => Promise<string | null>
    isTypeEnabled: (type: AccountingSyncType) => Promise<boolean>
  },
): Promise<RefundAccountingObligationLedger> {
  // PINNED, ONCE, BEFORE THE FIRST ENQUEUE.
  const pinnedConnector = await deps.activeConnector()
  const willPost = new Map<AccountingSyncType, boolean>()
  for (const type of new Set(obligations.map((obligation) => obligation.type))) {
    willPost.set(type, pinnedConnector ? await deps.isTypeEnabled(type) : false)
  }

  const unmet: string[] = []
  let accounted = 0
  const name = (obligation: RefundAccountingObligation) =>
    `${obligation.type} for ${obligation.referenceType} ${obligation.referenceId}`

  return {
    pinnedConnector,

    account(obligation, outcome) {
      accounted++
      if (outcome.connector !== pinnedConnector) {
        unmet.push(
          `${name(obligation)} (the active accounting connector changed from `
          + `${pinnedConnector ?? 'none'} to ${outcome.connector ?? 'none'} during this hand-off)`,
        )
        return
      }
      if (outcome.queued) return
      // THE ONLY NO-OP THAT SETTLES AN OBLIGATION: the pinned configuration already said this
      // posting will never exist, so there is nothing left outstanding for it to leave behind.
      if (outcome.reason === 'not-configured' && willPost.get(obligation.type) === false) return
      unmet.push(
        `${name(obligation)} (${outcome.reason === 'not-configured'
          ? 'the enqueue reported this posting switched off, though it was enabled when the hand-off began'
          : 'the enqueue wrote nothing'})`,
      )
    },

    /**
     * THE SAME THREE CHECKS AS `account`, IN THE SAME ORDER (r8). The connector first, because work
     * queued against a connector this hand-off did not pin is not this obligation's work whatever
     * else the answer says; then a queued row settles; then the ONE no-op that may settle — the
     * pinned verdict already said this posting will never exist.
     *
     * The wording differs where the arms genuinely differ (`queueAccountingSyncTx` refuses on a
     * deleted order scope, which the facade cannot produce), and nowhere else.
     */
    accountInTransaction(obligation, outcome) {
      accounted++
      if (outcome.connector !== pinnedConnector) {
        unmet.push(
          `${name(obligation)} (the active accounting connector changed from `
          + `${pinnedConnector ?? 'none'} to ${outcome.connector ?? 'none'} during this hand-off, so `
          + 'this posting was queued against a connector it was not reckoned against)',
        )
        return
      }
      if (outcome.queued) return
      // THE ONLY NO-OP THAT SETTLES AN OBLIGATION, exactly as in `account`: the pinned configuration
      // already said this posting will never exist, so nothing is left outstanding for it.
      if (outcome.reason === 'not-configured' && willPost.get(obligation.type) === false) return
      unmet.push(
        `${name(obligation)} (${outcome.reason === 'not-configured'
          ? 'the in-transaction enqueue reported this posting switched off, though it was enabled when '
            + 'the hand-off began'
          : `the in-transaction enqueue wrote nothing while ${obligation.type} was enabled`})`,
      )
    },

    settle() {
      if (accounted !== obligations.length) {
        unmet.push(
          `${obligations.length - accounted} recorded obligation(s) were never handed to an enqueue at all`,
        )
      }
      if (unmet.length > 0) throw new RefundAccountingObligationsUnmet(unmet)
    },
  }
}
