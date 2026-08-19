#!/usr/bin/env tsx
/**
 * o3d-y14: clear the DUPLICATED order-level coupon on legacy WooCommerce orders.
 *
 * All of the judgement lives in lib/connectors/woocommerce/sync/coupon-discount-backfill.ts — read
 * that file for why each decision is made. This is the reporting and driving shell.
 *
 * IT IS A TWO-PHASE, OPT-IN WORKFLOW, because it rewrites amounts on invoices that are already
 * posted to the ledger, and no field on a row distinguishes "written by the pre-fix importer" from
 * "corrected by hand afterwards" or "written by the fixed importer before it stamped the marker".
 * So a machine may PROPOSE, and only a human may APPROVE:
 *
 *   1. REPORT / PROPOSE (no writes)
 *        tsx scripts/backfill-wc-coupon-order-discount.ts \
 *          --imported-before 2026-07-25T14:00:00Z --allowlist-out y14-allowlist.json
 *
 *   2. REVIEW — see "WHAT A REVIEWER CHECKS" below. Move rows, delete rows, then sign the file.
 *
 *   3. APPLY (writes; consumes ONLY the reviewed file, never a fresh scan)
 *        tsx scripts/backfill-wc-coupon-order-discount.ts --allowlist y14-allowlist.json --apply
 *
 *   4. REPRINT (read-only; re-derives the LEDGER HANDOFF from live state, at any time)
 *        tsx scripts/backfill-wc-coupon-order-discount.ts --reprint y14-allowlist.json
 *
 *      This is the ONLY way to see the handoff for an order that has already been corrected: the
 *      correction stamps `discountModel` and writes the ActivityLog marker, so every later report
 *      SKIPS that order and prints nothing for it (o3d-y14 r8 finding 4). Anywhere the operator text
 *      says a handoff can be re-derived, this is the invocation it means.
 *
 * WHAT A REVIEWER CHECKS, per entry:
 *   • `importedAt` vs the DEPLOYMENT RECORD. The cutoff must be the EARLIEST moment the fixed
 *     importer could have written a row on this instance — earlier is safe (fewer candidates),
 *     later silently sweeps in correct rows. Every entry with `"nearCutoff": true` is one the
 *     cutoff CHOICE decided rather than a comfortable margin; those are the markerless-interval
 *     risk and each needs an individual answer.
 *   • MANUAL CORRECTIONS. If this order's discount was ever fixed by hand (raw SQL, an ad-hoc
 *     script), its amount is ALREADY the residual: move the entry to `stampOnly`. Clearing it would
 *     subtract the line discounts a second time and then stamp the wrong figure permanently.
 *   • `storedOrderDiscount` / `lineDiscountTotal` / `keptOrderLevel` — does the residual make sense
 *     for that order's coupons? `"partial": true` means a residual SURVIVES; those are unmodelled
 *     coupon shapes and are worth opening individually.
 *   • `accountingInvoiceId` — non-null means a ledger document exists for this order. It does NOT
 *     by itself mean that document is wrong: the report classifies each one under "LEDGER HANDOFF"
 *     below by replaying the connector's own posting rule over what was actually sent, and a Xero
 *     invoice enqueued without a discount account code carries no order-level discount line at all
 *     (o3d-y14 r5). Read the classification, not the column.
 *   • `postedInvoiceExternalIds` — SYNCED invoice jobs whose external id the order does NOT carry.
 *     A post can succeed and then fail to write its id back (o3d-9kek), so a non-empty list here
 *     with a null `accountingInvoiceId` is a REAL ledger document the column denies. It is
 *     classified exactly like `accountingInvoiceId`, and approving the entry is you saying you have
 *     seen it. Apply compares this list against live state and refuses if it has moved, so approving
 *     the row is what unsticks it — there is no separate repair to run first.
 *   • `revenueDeferredBatchRef` — non-null means a daily-batch Group A1 journal ALSO deferred this
 *     order's revenue using the same wrong discount, and stamped the result on the order. That
 *     journal is deliberately left alone: IMS recognises back out the SAME stamped
 *     `unearnedRevenueAmount`, so the deferral/recognition pair still nets to zero and adjusting one
 *     half of it by hand would strand the difference in unearned revenue forever.
 *   • `refunds` — the refund position (o3d-y14 r6, r7). FOUR signals, and any one of them means
 *     value has already been credited back on this order: `disposition` other than NONE, any
 *     `refundIds`, any `postedCreditNoteExternalIds`, and any `unresolvedRefundParkExternalIds` — a
 *     WooCommerce refund that ARRIVED and could not be recorded (o3d-y14 r7 finding 1). That last
 *     one writes no refund row, no status and no credit note, so an order carrying only a park looks
 *     unrefunded in every other field while the money has already left the business; a quarantined
 *     refund in particular is one IMS refused to post because it could not do so safely, which makes
 *     it the shape a wrong remedy is most likely to reach.
 *
 *     WHAT THE HANDOFF DOES WITH IT. Where the posted credit notes REVERSE THE WHOLE ORDER by
 *     mirroring its invoice — a FULL disposition, every refund a chargeback, each named by one
 *     credit note that is in the ledger, NET totals, and no park — the position is NETTED and a
 *     remedy IS prescribed, in whichever direction the net actually points (o3d-y14 r7 finding 4).
 *     In every other shape no remedy is prescribed at all: the discrepancy may already have been
 *     credited away with the invoice, so "raise a further invoice for the difference" would re-bill
 *     a refunded customer and "raise a credit note" would refund the same money twice. Those
 *     entries are still correctable — the duplicated coupon is duplicated either way — but the
 *     accounting follow-up is a manual netting job, and the report prints every credit-note leg it
 *     COULD derive so the netting starts from figures rather than from documents. Apply compares
 *     this whole position against live state and refuses if it has moved.
 *
 *     AND THE NET IS WITHDRAWN WHERE THE SUBTRACTION IS NOT DEFINED (o3d-y14 r8 findings 1-3, r9
 *     finding 1), even when both sides derive: a TAX-INCLUSIVE invoice states its order-level
 *     discount GROSS while every credit-note refund line IMS stores is NET, and nothing persisted
 *     inverts the conversion (a refund line records a tax TYPE, never a rate); TWO POSTED INVOICES
 *     that AGREE hold that discount twice, and agreement is a rule built for the chargeback resolver
 *     rather than a statement that there is one document; a credit note the mirror shows as VOID,
 *     REVERSED, re-posted or never posted is not a document whose persisted lines describe what
 *     stands; and the invoice and the credit notes must have been posted to THE SAME LEDGER — the
 *     active accounting connector can be switched, IMS keeps every historical document under the
 *     connector that posted it, and an order invoiced in Xero and credited in QuickBooks has an
 *     invoice standing at full value that the credit memo reduces by nothing. Each names the
 *     condition that failed and prescribes nothing.
 *
 *     AND A SUPPRESSED NETTING STATES NO NETTING CONCLUSION EITHER (o3d-y14 r10 finding 1). Two of
 *     those refusal paragraphs used to end with the netting's own answer — "so on a full refund the
 *     two errors cancel and the net owed is nothing", "crediting an invoice that has already been
 *     credited away refunds the same money a second time" — asserted in exactly the cases where no
 *     subtraction could be performed. An operator reading "the two errors cancel" files the order as
 *     square, which is what the suppression exists to prevent. The conclusion is now a value the
 *     netting branch alone constructs, with one renderer; a suppressed path carries none, states
 *     both sides' facts, and gives the same reasoning as the conditional it is.
 *
 *   • SEVERAL POSTED SALES-INVOICE DOCUMENTS PRESCRIBE NOTHING (o3d-y14 r10 finding 2). The
 *     document reference names EVERY posted document rather than the newest, and where there is
 *     more than one the remedy is withdrawn: the reported difference is per document, not what the
 *     ledger is out by, and multiplying it is equally unfounded because nothing IMS records says
 *     whether those documents each bill the whole order or divide it. Correcting the one document
 *     the report happened to name left the other carrying the duplicate.
 *
 *   • A REMEDY CAN BE WITHDRAWN AFTER THE FACT (o3d-y14 r7 finding 2, r8 finding 4). Every remedy
 *     printed at the end of an apply run is re-validated against the live refund position TWICE:
 *     once for the whole batch, which decides which of the two lists each order goes on, and again
 *     PER ENTRY immediately before that entry's own lines are printed. A refund can be recorded in
 *     the moments after a correction commits and leave a directional instruction on the screen that
 *     is no longer true, and an entry re-read at the top of a 70-order print run is not re-read
 *     "immediately before" anything. A withdrawn remedy keeps its FACTS and loses its instruction,
 *     and is listed with the declines; one withdrawn by the SECOND pass is named again at the end,
 *     because the heading it was printed under had already been written. Every surviving remedy also
 *     names the exact refund position it depends on and tells you to re-check it before posting —
 *     that check is not optional, and it is the only thing that closes the window between this
 *     report being printed and you acting on it.
 *
 *     EVERY netted outcome names THE CREDIT NOTES ITS FIGURE WAS DERIVED AGAINST (o3d-y14 r8
 *     finding 3, r9 finding 2) — including the one that nets to ZERO. IMS can see a credit note it
 *     never posted, one it re-posted and one it retired — all of those suppress the netting — but
 *     NOT one voided or edited by hand in Xero or QuickBooks, because nothing writes that back, and
 *     it records which CONNECTOR posted a document but never which ORGANISATION inside it. Confirming
 *     those documents still stand, and are in the same organisation as the invoice, is part of the
 *     output rather than an optional extra. A zero net needs it MOST: a hand-voided credit note
 *     there means the reversal never happened, the invoice stands at its full posted value and the
 *     customer still owes it — and a zero is the one answer that says there is nothing to look at.
 *   • Anything you are not sure about: DELETE the entry. Skipping is re-runnable; a wrong correction
 *     is not.
 *
 * Signing means setting `"reviewed": true` and `"reviewedBy": "<your name>"`. Apply refuses
 * otherwise. Apply also re-verifies every evidence field against the live row and RE-DERIVES the
 * amount it writes, so a row that moved between review and apply is SKIPPED, and an edited
 * `keptOrderLevel` causes a refusal rather than a write. `stampOnly` entries are re-verified just
 * as hard — amount, LINE discounts and import timestamp — because a stamp is the one write no later
 * run can reconsider (o3d-y14 r3 finding 3).
 *
 * EVERY REFUSAL IS RECOVERABLE BY RE-RUNNING THE REPORT, and that is a property rather than a hope:
 * a refusal writes nothing, and the report reads every field apply compares (posting state included,
 * o3d-y14 r3 finding 2), so the re-generated proposal shows the reviewer the state that caused the
 * refusal. Approve it again and apply proceeds. A file generated by an older build is refused on its
 * `version` instead, which is the same instruction: re-run the report.
 *
 * A CORRECTED ROW IS THE ONE THING THE REPORT CANNOT RE-SHOW (o3d-y14 r8 finding 4), and it is
 * exactly the row that carries a ledger handoff. The correction stamps `discountModel` and writes
 * the ActivityLog marker, which is what makes the operation safely re-runnable — and which makes
 * `decideWcCouponBackfill` answer SKIP for that order in every later scan, so no report will ever
 * print its handoff again. `--reprint <allowlist>` is the path for that, and it is the invocation
 * every "re-derive this" sentence in the operator text names. Without it, "re-run the report and
 * nothing is lost" was true of the rows nothing happened to and false of the rows something did.
 *
 * POSTING STATE IS NEVER READ FROM THE FILE. The allowlist decides WHICH ORDERS may be touched and
 * nothing else. What the accounting system holds is re-read at apply time under the correction's own
 * lock: a row whose posting state moved since the review is REFUSED, and the LEDGER HANDOFF printed
 * at the end is built from that live read. A file-derived list would report an invoice posted between
 * review and apply as unposted — telling the operator that nothing needs fixing about the one order
 * that most does.
 *
 * THE LEDGER HANDOFF IS DERIVED PER DOCUMENT (o3d-y14 r5 finding 1). Earlier revisions printed one
 * sentence for every order that had any accounting document — "still understates, needs a manual
 * credit/adjustment" — and that sentence is wrong twice over. A Xero invoice enqueued without a
 * discount ACCOUNT CODE never had the negative "Order discount" line appended, so it already charges
 * the full goods less the per-line coupon and needs NOTHING done to it; and where a document DID
 * carry the duplicate it charged too LITTLE, so its balance has to go UP and a credit note is the
 * wrong instrument entirely. Both report and apply now replay each connector's posting rule over the
 * payload that was actually mirrored — the same `readPostedInvoiceOrderDiscount` the chargeback path
 * uses — and print the job that matches what the document carries, or refuse to prescribe one when
 * the derivation cannot establish it.
 *
 * IT ONLY EVER TOUCHES SalesOrder.discountAmount + discountModel, and only on orders with a
 * WooCommerce link. It never touches the accounting queue: an order with unposted invoice work
 * (o3d-5ct) or an unposted daily revenue-deferral journal is DECLINED and reported.
 *
 * THE COMMAND LINE IS PARSED STRICTLY (o3d-y14 r9 finding 3). Every flag above must be spelled
 * exactly, appear at most once, and be followed by its own value — an unknown flag, a `--flag=value`,
 * a bare path, or a flag with nothing after it REFUSES the run rather than being ignored. The old
 * reader could not tell a flag from a value, so `--apply --reprint` silently ran the WRITING mode
 * the operator had asked to avoid, and `--allowlist-out` with nothing after it silently produced no
 * proposal at all. Refusal costs a retyped command; the alternative cost real writes.
 *
 * --imported-before is the moment the o3d-y14 importer fix went LIVE on this instance. It is dated
 * against ShoppingOrderLink.createdAt — when IMS imported the order — and never against
 * SalesOrder.createdAt, which the initial import backdates to the historical Woo order date.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { config } from 'dotenv'

import {
  WC_COUPON_BACKFILL_ACTION,
  WC_COUPON_MAX_CANDIDATES,
  WC_COUPON_SCAN_PAGE_SIZE,
  CREDIT_NOTE_SYNC_TYPES,
  LIVE_SALES_INVOICE_STATUSES,
  POSTED_SALES_INVOICE_STATUSES,
  SALES_INVOICE_SYNC_TYPES,
  WC_COUPON_REFUND_PARK_WHERE,
  applyWcCouponCorrection,
  buildWcCouponAllowlistEntry,
  chunkWcCouponIds,
  collectWcCouponCandidates,
  decideWcCouponBackfill,
  isNearWcCouponCutoff,
  normalizeWcCouponRefundDisposition,
  parseWcCouponAllowlist,
  parseWcCouponCliFlags,
  parseWcCouponCutoff,
  reprintWcCouponLedgerHandoff,
  revalidateWcCouponHandoff,
  sortedPostedInvoiceIds,
  sortedWcCouponRefundEvidence,
  stampWcCouponDiscountModel,
  sumLineDiscounts,
  type WcCouponAllowlist,
  type WcCouponAllowlistEntry,
  type WcCouponBackfillDecision,
  type WcCouponBackfillRow,
} from '../lib/connectors/woocommerce/sync/coupon-discount-backfill'
import {
  buildWcCouponLedgerHandoff,
  isWcCouponOrderRefunded,
  type WcCouponLedgerHandoff,
} from '../lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff'
import { liveDailyBatchDeferralWhere } from '../lib/domain/accounting/daily-batch-discount-fence'

// .env MUST load before lib/db is imported: that module builds its pg Pool from
// process.env.DATABASE_URL at IMPORT time (see scripts/backfill-refund-basis.ts).
config({ path: '.env.local', quiet: true })
config({ quiet: true })

// NO ad-hoc argv reading anywhere in this file (o3d-y14 r9 finding 3). `parseWcCouponCliFlags` is
// the ONLY thing that looks at the command line, it refuses everything it does not exactly
// understand, and it is unit-tested — the previous `indexOf(flag) + 1` reader turned `--apply
// --reprint` into a WRITING run, because a flag with nothing after it read as absent and the
// read-only branch was never entered.

const LOG = '[backfill-wc-coupon-order-discount]'

/**
 * Print ONE order's ledger handoff.
 *
 * The lines come from `coupon-discount-ledger-handoff.ts` verbatim: this script must not paraphrase
 * a remedy, because the classification and the wording are the same decision (o3d-y14 r5 finding 1).
 */
function printHandoff(
  order: { orderId: string; orderNumber: string },
  handoff: { lines: string[] },
): void {
  console.log(`${LOG}   ${order.orderNumber || order.orderId}:`)
  for (const line of handoff.lines) console.log(`${LOG}     ${line}`)
}

// ---------------------------------------------------------------------------
// APPLY — consumes the reviewed allowlist and nothing else
// ---------------------------------------------------------------------------

async function apply(allowlistPath: string) {
  const { db } = await import('../lib/db/index')

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  } catch (error) {
    console.error(`${LOG} could not read ${allowlistPath}: ${String(error)}`)
    process.exitCode = 1
    return
  }

  const parsed = parseWcCouponAllowlist(parsedJson)
  if (!parsed.ok) {
    console.error(`${LOG} REFUSING to apply ${allowlistPath}: ${parsed.reason} — ${parsed.detail}`)
    process.exitCode = 1
    return
  }
  const allowlist = parsed.allowlist

  console.log(`${LOG} mode: APPLY`)
  console.log(
    `${LOG} allowlist: ${allowlistPath} — generated ${allowlist.generatedAt || '(unrecorded)'} under cutoff ` +
      `${allowlist.cutoff || '(unrecorded)'}, reviewed by ${allowlist.reviewedBy}` +
      (allowlist.reviewedAt ? ` on ${allowlist.reviewedAt}` : ''),
  )
  console.log(
    `${LOG} ${allowlist.stampOnly.length} order(s) to STAMP as already-correct, ` +
      `${allowlist.clear.length} to CLEAR. No other order can be touched by this run.`,
  )

  // STAMP FIRST, deliberately. A stamped row is excluded from every later run by its own evidence
  // rather than by anyone remembering to exclude it — so if this run dies half way, the rows that
  // must never be re-derived are the ones already protected.
  let stamped = 0
  const declined: string[] = []
  for (const entry of allowlist.stampOnly) {
    const result = await db.$transaction((tx) => stampWcCouponDiscountModel(tx, entry))
    if (result.outcome === 'CORRECTED') stamped += 1
    else declined.push(`stamp ${entry.orderNumber || entry.orderId}: ${result.reason} — ${result.detail}`)
  }

  let corrected = 0
  // The posting state reported here is the one READ AT APPLY TIME, under the same lock as the
  // correction — never `entry.accountingInvoiceId`. The allowlist is a list of WHICH ORDERS may be
  // touched; it was written when the proposal was generated and says nothing about what the ledger
  // holds now. An invoice queued after the review and posted before this run would be reported as
  // "not posted" from the file, and the operator would be told no manual ledger correction is
  // needed for the one order that most needs it (o3d-y14 r2).
  //
  // And what it says about each of those documents is DERIVED from what that document carries
  // (o3d-y14 r5 finding 1), so the two lists below are genuinely different jobs rather than one
  // sentence printed twice.
  const handoffs: Array<{ entry: WcCouponAllowlistEntry; handoff: WcCouponLedgerHandoff }> = []
  for (const entry of allowlist.clear) {
    const result = await db.$transaction((tx) => applyWcCouponCorrection(tx, entry))
    if (result.outcome === 'CORRECTED') {
      corrected += 1
      if (result.handoff) handoffs.push({ entry, handoff: result.handoff })
    } else {
      declined.push(`clear ${entry.orderNumber || entry.orderId}: ${result.reason} — ${result.detail}`)
    }
  }

  // REVALIDATED, TWICE, AND THE SECOND TIME PER PRINT (o3d-y14 r7 finding 2, r8 finding 4).
  //
  // Each handoff above was derived inside its own correction transaction, behind the order lock. The
  // lock proves the refund position at the moment that order's amount was rewritten and nothing
  // more: a refund can take the same lock the instant that transaction commits — before the NEXT
  // order is even corrected, let alone before this loop prints — and leave a live directional
  // instruction on the screen against a customer who has just been refunded. The correction itself
  // stands either way (the coupon was duplicated whatever happened afterwards); what is withdrawn is
  // the REMEDY. The residual window between the read and the operator reading the line is closed by
  // the precondition `wcCouponRemedySteps` prints on every remedy.
  //
  // WHY TWICE. r7 claimed the re-read happened "immediately before each handoff is printed" and
  // implemented one pass over every handoff followed, much later, by the printing — so order 1 was
  // re-read and then printed an unbounded number of queries afterwards. This pass DECIDES THE TWO
  // LISTS (a withdrawal forces `needsAccountingAction`, which is what a list membership is), and the
  // per-entry pass inside `printSection` is the one the claim is about. Withdrawal is MONOTONIC —
  // it only ever moves an entry from "settled" towards "look at this" — so the second pass can
  // discover that a settled entry has moved, and never the reverse; when it does, the entry is named
  // again at the end rather than silently printed under a heading that says it needs nothing.
  const supersededOrders = new Set<string>()
  for (let index = 0; index < handoffs.length; index += 1) {
    const { entry, handoff } = handoffs[index]
    const revalidated = await revalidateWcCouponHandoff(db, entry.orderId, handoff)
    if (revalidated.outcome === 'SUPERSEDED') {
      supersededOrders.add(entry.orderId)
      handoffs[index] = { entry, handoff: revalidated.handoff }
      declined.push(
        `handoff ${entry.orderNumber || entry.orderId}: REMEDY WITHDRAWN — ${revalidated.detail}`,
      )
    }
  }
  const superseded = supersededOrders.size

  // The names of orders the PER-PRINT pass withdrew, i.e. ones that moved after the partition above.
  const movedWhilePrinting: string[] = []

  /**
   * Print one section, re-validating each entry IMMEDIATELY BEFORE its own lines go out.
   *
   * An entry the pass above already superseded is not re-read: it already carries its withdrawal
   * line and `needsAccountingAction`, and re-running the same comparison would append a second copy
   * of a sentence that is already true.
   */
  async function printSection(section: Array<{ entry: WcCouponAllowlistEntry; handoff: WcCouponLedgerHandoff }>) {
    for (const { entry, handoff } of section) {
      if (supersededOrders.has(entry.orderId)) {
        printHandoff(entry, handoff)
        continue
      }
      const revalidated = await revalidateWcCouponHandoff(db, entry.orderId, handoff)
      if (revalidated.outcome === 'SUPERSEDED') {
        supersededOrders.add(entry.orderId)
        movedWhilePrinting.push(entry.orderNumber || entry.orderId)
        declined.push(
          `handoff ${entry.orderNumber || entry.orderId}: REMEDY WITHDRAWN — ${revalidated.detail}`,
        )
      }
      printHandoff(entry, revalidated.handoff)
    }
  }

  console.log('')
  console.log(
    `${LOG} stamped ${stamped} order(s) as already-correct; corrected ${corrected} order(s). ` +
      'No queued or posted accounting payload was modified.' +
      (superseded
        ? ` ${superseded} handoff(s) had their REMEDY WITHDRAWN because a refund was recorded after ` +
          'the correction committed (more may be withdrawn below, as each entry is re-checked ' +
          'immediately before it is printed) — re-derive those with --reprint.'
        : ''),
  )

  const actionable = handoffs.filter(({ handoff }) => handoff.needsAccountingAction)
  const settled = handoffs.filter(({ handoff }) => !handoff.needsAccountingAction)
  if (actionable.length) {
    console.log('')
    console.log(
      `${LOG} ${actionable.length} corrected order(s) NEED WORK IN THE ACCOUNTING SYSTEM. Each entry ` +
        'names what its document actually carries — replayed from the connector rule that built it — ' +
        'and the remedy that matches THAT case. Do not generalise one entry to another:',
    )
    await printSection(actionable)
  }
  if (settled.length) {
    console.log('')
    console.log(
      `${LOG} ${settled.length} corrected order(s) have accounting documents that need NOTHING done ` +
        'to them. They are listed so the list is complete, and so nobody "tidies them up" later:',
    )
    await printSection(settled)
  }
  if (movedWhilePrinting.length) {
    console.log('')
    console.log(
      `${LOG} ${movedWhilePrinting.length} order(s) had their refund position MOVE WHILE THIS REPORT ` +
        'WAS BEING PRINTED, after the two lists above were decided. Their remedy is withdrawn in the ' +
        'lines printed for them, but the heading they appear under was already written — treat these ' +
        `as needing a look whichever list they are in: ${movedWhilePrinting.join(', ')}. ` +
        'Re-derive them with --reprint.',
    )
  }
  if (declined.length) {
    console.log(
      `${LOG} ${declined.length} entr(ies) were declined at write time — the row no longer matches the ` +
        'evidence it was reviewed with, so it was left untouched. Re-run the report to re-propose them:',
    )
    for (const line of declined) console.log(`${LOG}   ${line}`)
  }
}

// ---------------------------------------------------------------------------
// REPORT / PROPOSE — never writes
// ---------------------------------------------------------------------------

async function report(importedBefore: Date | null, csvPath: string | null, allowlistOut: string | null) {
  const { db } = await import('../lib/db/index')

  console.log(`${LOG} mode: DRY RUN`)
  console.log(
    `${LOG} cutoff: ${
      importedBefore
        ? `orders IMPORTED (ShoppingOrderLink.createdAt) before ${importedBefore.toISOString()}`
        : '(none — every unstamped order will report as UNPROVEN)'
    }`,
  )

  // NO cutoff in this query. Scoping the SELECT by SalesOrder.createdAt is the o3d-9te bug: that
  // column is backdated to the Woo order date by the initial import. Provenance is decided per row,
  // from the link timestamp and the recorded discount model.
  //
  // KEYSET-PAGED, and capped (o3d-y14 r2 finding 3). The previous shape loaded every matching order
  // and every line in one statement, then used the whole id list in two more — which is bounded by
  // the catalogue rather than by the work, and past ~65k ids the `IN` lists stop being slow and
  // start being errors. Ordering is by id because that is what makes the keyset sound; the display
  // order is restored below, where it costs nothing.
  type ScannedOrder = Awaited<ReturnType<typeof scanPage>>[number]
  async function scanPage(afterId: string | null) {
    return await db.salesOrder.findMany({
      where: {
        discountAmount: { gt: 0 },
        shoppingLinks: { some: { connector: 'woocommerce' } },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        currency: true,
        discountAmount: true,
        discountModel: true,
        accountingInvoiceId: true,
        revenueDeferredBatchRef: true,
        // o3d-y14 r6 finding 1: whether this order has been credited against decides whether the
        // handoff below may prescribe an invoice remedy for it at all.
        refundStatus: true,
        lines: { select: { discountAmount: true } },
        shoppingLinks: {
          where: { connector: 'woocommerce' },
          select: { createdAt: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
      orderBy: { id: 'asc' },
      take: WC_COUPON_SCAN_PAGE_SIZE,
    })
  }

  const scan = await collectWcCouponCandidates<ScannedOrder>(scanPage)
  if (!scan.ok) {
    // REFUSE rather than truncate. A truncated proposal is indistinguishable from a complete one,
    // and the orders it silently omitted are the ones nobody will ever look at again.
    console.error(
      `${LOG} REFUSING: more than ${WC_COUPON_MAX_CANDIDATES} WooCommerce orders carry an order-level ` +
        `discount (${scan.scanned} scanned). That is far beyond any real catalogue, so the filter is wrong ` +
        'rather than the estate large — this backfill targets a defect affecting tens of orders. Nothing ' +
        'was written.',
    )
    process.exitCode = 1
    return
  }
  const orders = scan.rows
  // The scan order is by id; the reviewer reads by import date, which is the evidence they check.
  orders.sort((a, b) => (a.shoppingLinks[0]?.createdAt?.getTime() ?? 0) - (b.shoppingLinks[0]?.createdAt?.getTime() ?? 0))
  console.log(`${LOG} ${orders.length} WooCommerce order(s) carry an order-level discount`)

  const orderIds = orders.map((order) => order.id)

  // Chunked for the same reason the scan is paged: one `IN` list of every candidate is a statement
  // whose parameter count is set by the catalogue.
  const alreadyBackfilled = new Set<string>()
  for (const batch of chunkWcCouponIds(orderIds)) {
    const marks = await db.activityLog.findMany({
      where: { action: WC_COUPON_BACKFILL_ACTION, entityId: { in: batch } },
      select: { entityId: true },
    })
    for (const mark of marks) if (mark.entityId) alreadyBackfilled.add(mark.entityId)
  }

  const liveJobCounts = new Map<string, number>()
  for (const batch of chunkWcCouponIds(orderIds)) {
    const grouped = await db.accountingSyncLog.groupBy({
      by: ['referenceId'],
      where: {
        referenceType: 'SalesOrder',
        referenceId: { in: batch },
        type: { in: [...SALES_INVOICE_SYNC_TYPES] },
        status: { in: [...LIVE_SALES_INVOICE_STATUSES] },
      },
      _count: { _all: true },
    })
    for (const group of grouped) liveJobCounts.set(group.referenceId, group._count._all)
  }

  // POSTED-BUT-UNLINKED INVOICES (o3d-y14 r3 finding 2). Read here, in the REPORT, and not only at
  // apply time: apply refuses any row whose posting evidence has moved since the review, so evidence
  // the report cannot show is evidence the reviewer can never approve. The o3d-9kek shape — a post
  // that succeeded and then failed to write its id back — lives entirely in these rows and is
  // invisible in `accountingInvoiceId`, which is exactly why the previous revision re-proposed those
  // orders forever and refused them every time.
  const postedInvoiceIds = new Map<string, string[]>()
  for (const batch of chunkWcCouponIds(orderIds)) {
    const syncedRows = await db.accountingSyncLog.findMany({
      where: {
        referenceType: 'SalesOrder',
        referenceId: { in: batch },
        type: { in: [...SALES_INVOICE_SYNC_TYPES] },
        status: { in: [...POSTED_SALES_INVOICE_STATUSES] },
        externalTransactionId: { not: null },
      },
      select: { referenceId: true, externalTransactionId: true },
    })
    for (const row of syncedRows) {
      if (!row.externalTransactionId) continue
      postedInvoiceIds.set(row.referenceId, [
        ...(postedInvoiceIds.get(row.referenceId) ?? []),
        row.externalTransactionId,
      ])
    }
  }

  // REFUNDS AND THEIR CREDIT NOTES (o3d-y14 r6 finding 1). Read in the REPORT for exactly the
  // reason the posted-but-unlinked invoices are: apply refuses a row whose refund position has moved
  // since the review, so a position the report cannot show is one the reviewer can never approve.
  // Both sources again — the back-reference column AND the SYNCED credit-note rows — because a
  // credit note can post and fail to write its id back (o3d-9kek) just as an invoice can.
  const refundRows = new Map<string, Array<{ id: string; accountingCreditNoteId: string | null }>>()
  for (const batch of chunkWcCouponIds(orderIds)) {
    const rows = await db.salesOrderRefund.findMany({
      where: { orderId: { in: batch } },
      select: { id: true, orderId: true, accountingCreditNoteId: true },
    })
    for (const row of rows) {
      refundRows.set(row.orderId, [
        ...(refundRows.get(row.orderId) ?? []),
        { id: row.id, accountingCreditNoteId: row.accountingCreditNoteId },
      ])
    }
  }
  // UNRESOLVED REFUND PARKS (o3d-y14 r7 finding 1). Read in the REPORT for exactly the reason the
  // refund rows and posted credit notes are: apply refuses a row whose refund position has moved
  // since the review, so a position the report cannot show is one the reviewer can never approve.
  // The predicate is `WC_COUPON_REFUND_PARK_WHERE` — the partial unique index's own — so the set
  // shown here is the set apply compares against, not a looser approximation of it.
  const refundParks = new Map<string, string[]>()
  for (const batch of chunkWcCouponIds(orderIds)) {
    const parks = await db.shoppingSyncLog.findMany({
      where: { ...WC_COUPON_REFUND_PARK_WHERE, entityId: { in: batch } },
      select: { entityId: true, externalId: true },
    })
    for (const park of parks) {
      if (!park.entityId || !park.externalId) continue
      refundParks.set(park.entityId, [...(refundParks.get(park.entityId) ?? []), park.externalId])
    }
  }

  const refundIdToOrderId = new Map<string, string>()
  for (const [orderId, rows] of refundRows) for (const row of rows) refundIdToOrderId.set(row.id, orderId)
  const syncedCreditNoteIds = new Map<string, string[]>()
  for (const batch of chunkWcCouponIds([...refundIdToOrderId.keys()])) {
    const rows = await db.accountingSyncLog.findMany({
      where: {
        referenceType: 'SalesOrderRefund',
        referenceId: { in: batch },
        type: { in: [...CREDIT_NOTE_SYNC_TYPES] },
        status: { in: [...POSTED_SALES_INVOICE_STATUSES] },
        externalTransactionId: { not: null },
      },
      select: { referenceId: true, externalTransactionId: true },
    })
    for (const row of rows) {
      const orderId = refundIdToOrderId.get(row.referenceId)
      if (!orderId || !row.externalTransactionId) continue
      syncedCreditNoteIds.set(orderId, [
        ...(syncedCreditNoteIds.get(orderId) ?? []),
        row.externalTransactionId,
      ])
    }
  }

  // The daily-batch producer (o3d-y14 r2 finding 1). Its rows are keyed on the BATCH, not on the
  // order, so they are looked up by the batch reference each order carries — an order-scoped query
  // of any shape would find none of them.
  const batchRefs = [...new Set(orders.map((order) => order.revenueDeferredBatchRef).filter((ref): ref is string => !!ref))]
  const liveBatchCounts = new Map<string, number>()
  for (const batch of chunkWcCouponIds(batchRefs)) {
    const grouped = await db.accountingSyncLog.groupBy({
      by: ['referenceId'],
      where: liveDailyBatchDeferralWhere(batch),
      _count: { _all: true },
    })
    for (const group of grouped) liveBatchCounts.set(group.referenceId, group._count._all)
  }

  const rows: Array<{ row: WcCouponBackfillRow; decision: WcCouponBackfillDecision }> = []
  for (const order of orders) {
    const row: WcCouponBackfillRow = {
      orderId: order.id,
      orderNumber: order.orderNumber ?? '',
      externalOrderNumber: order.externalOrderNumber ?? '',
      currency: order.currency,
      storedOrderDiscount: Number(order.discountAmount),
      lineDiscountTotal: sumLineDiscounts(order.lines),
      accountingInvoiceId: order.accountingInvoiceId,
      postedInvoiceExternalIds: sortedPostedInvoiceIds(postedInvoiceIds.get(order.id) ?? []),
      discountModel: order.discountModel,
      importedAt: order.shoppingLinks[0]?.createdAt ?? null,
      alreadyBackfilled: alreadyBackfilled.has(order.id),
      liveInvoiceJobs: liveJobCounts.get(order.id) ?? 0,
      revenueDeferredBatchRef: order.revenueDeferredBatchRef,
      liveBatchDeferralJobs: order.revenueDeferredBatchRef
        ? (liveBatchCounts.get(order.revenueDeferredBatchRef) ?? 0)
        : 0,
      refunds: sortedWcCouponRefundEvidence({
        disposition: normalizeWcCouponRefundDisposition(order.refundStatus),
        refundIds: (refundRows.get(order.id) ?? []).map((refund) => refund.id),
        postedCreditNoteExternalIds: [
          ...(refundRows.get(order.id) ?? []).map((refund) => refund.accountingCreditNoteId),
          ...(syncedCreditNoteIds.get(order.id) ?? []),
        ].filter((id): id is string => !!id),
        // r7 finding 1. A refund that ARRIVED and could not be recorded produces none of the three
        // signals above, so without this the order reads as unrefunded and gets the full remedy.
        unresolvedRefundParkExternalIds: refundParks.get(order.id) ?? [],
      }),
    }
    rows.push({ row, decision: decideWcCouponBackfill(row, { importedBefore }) })
  }

  type Entry<A extends WcCouponBackfillDecision['action']> = {
    row: WcCouponBackfillRow
    decision: Extract<WcCouponBackfillDecision, { action: A }>
  }
  function pick<A extends WcCouponBackfillDecision['action']>(action: A): Array<Entry<A>> {
    return rows.filter((entry): entry is Entry<A> => entry.decision.action === action)
  }
  const corrections = pick('CORRECT')
  const unproven = pick('UNPROVEN')
  const blocked = pick('BLOCKED')
  const skipped = pick('SKIP')

  console.log('')
  console.log('order              external   ccy    stored  onLines  keep   clear  posted  verdict')
  for (const { row, decision } of rows) {
    if (decision.action === 'SKIP' && decision.reason !== 'NOTHING_DUPLICATED') continue
    const keep = decision.action === 'CORRECT' ? String(decision.keptOrderLevel) : '-'
    const clear = decision.action === 'CORRECT' ? String(decision.clearedBy) : '-'
    const near = isNearWcCouponCutoff(row.importedAt, importedBefore) ? ' [NEAR CUTOFF]' : ''
    console.log(
      `${(row.orderNumber || row.orderId).padEnd(18)} ${row.externalOrderNumber.padEnd(10)} ` +
        `${row.currency.padEnd(6)} ${String(row.storedOrderDiscount).padStart(6)} ` +
        `${String(row.lineDiscountTotal).padStart(8)} ${keep.padStart(5)} ${clear.padStart(6)} ` +
        `${(row.accountingInvoiceId ? 'YES' : 'no').padEnd(7)} ${decision.action}` +
        (decision.action === 'CORRECT' ? (decision.partial ? ' (PARTIAL)' : '') : ` — ${decision.reason}`) +
        near,
    )
  }

  // Both accounting artefacts, not just the invoice: an order whose revenue deferral has already
  // been journaled has a SECOND document derived from the amount about to change (o3d-y14 r2).
  const postedCandidates = corrections.filter(
    (entry) =>
      entry.row.accountingInvoiceId ||
      entry.row.postedInvoiceExternalIds.length > 0 ||
      entry.row.revenueDeferredBatchRef ||
      // o3d-y14 r6 finding 1: a credit note is a document derived from the same amount, and an
      // order can carry one with no invoice evidence at all. It is the same set apply classifies
      // (`wcCouponCorrectionNeedsLedgerAdjustment`), so the reviewer sees what apply will act on.
      isWcCouponOrderRefunded(entry.row.refunds),
  )
  const nearCutoff = corrections.filter((entry) => isNearWcCouponCutoff(entry.row.importedAt, importedBefore))
  console.log('')
  console.log(
    `${LOG} ${corrections.length} candidate(s) ` +
      `(${corrections.filter((e) => e.decision.action === 'CORRECT' && e.decision.partial).length} keep a residual), ` +
      `${skipped.length} skipped, ${unproven.length} UNPROVEN, ${blocked.length} BLOCKED`,
  )

  if (postedCandidates.length) {
    console.log('')
    console.log(
      `${LOG} ${postedCandidates.length} of the candidates ALREADY HAVE ACCOUNTING DOCUMENTS derived ` +
        'from the amount about to change. What each of those documents actually CARRIES is derived ' +
        "below by replaying the connector's own posting rule over the payload that was mirrored — a " +
        'Xero invoice enqueued without a discount account code never had an "Order discount" line ' +
        'appended and needs nothing done to it (o3d-y14 r5). An order that has been REFUNDED is ' +
        'judged on its net position instead and gets NO prescribed remedy, because a credit note ' +
        'may already have reversed the discrepancy along with the invoice (o3d-y14 r6). This is the ' +
        'state AT REPORT TIME; apply ' +
        're-reads it live, refuses any row whose posting state has moved since you reviewed it, and ' +
        're-derives this same handoff from the state at the moment of correction.',
    )
    // ONE PAIR OF QUERIES PER POSTED CANDIDATE, and only for the posted ones. The candidate set is
    // already capped at WC_COUPON_MAX_CANDIDATES and this defect affects tens of orders, so the
    // bound is the operator list rather than the catalogue.
    for (const { row, decision } of postedCandidates) {
      const handoff = await buildWcCouponLedgerHandoff(db, {
        orderId: row.orderId,
        currency: row.currency,
        keptOrderLevel: decision.keptOrderLevel,
        evidence: {
          accountingInvoiceId: row.accountingInvoiceId,
          // Listed SEPARATELY from the column, because "posted but the id was never written back"
          // (o3d-9kek) is a different thing for the reviewer to check than a linked invoice — and it
          // is the one apply used to refuse forever.
          postedInvoiceExternalIds: row.postedInvoiceExternalIds,
          revenueDeferredBatchRef: row.revenueDeferredBatchRef,
          // o3d-y14 r6 finding 1. Passed, never defaulted: the handoff prescribes a DIFFERENT job
          // for a refunded order, and an omitted refund position here would print the unrefunded
          // remedy — the instruction that bills an already-refunded customer a second time.
          refunds: row.refunds,
        },
      })
      console.log(
        `${LOG}   ${row.orderNumber || row.orderId} — ` +
          `${handoff.needsAccountingAction ? 'ACCOUNTING ACTION REQUIRED' : 'no accounting action'}:`,
      )
      for (const line of handoff.lines) console.log(`${LOG}     ${line}`)
    }
  }

  if (nearCutoff.length) {
    console.log('')
    console.log(
      `${LOG} ${nearCutoff.length} candidate(s) were classified by the CUTOFF CHOICE rather than by a ` +
        'comfortable margin — they were imported shortly before it. The fixed importer ran for a while ' +
        'WITHOUT stamping discountModel, so a cutoff even slightly late sweeps in correct rows. Check ' +
        'each of these against the deployment record before approving it:',
    )
    for (const { row } of nearCutoff) {
      console.log(`${LOG}   ${row.orderNumber || row.orderId}: imported ${row.importedAt?.toISOString()}`)
    }
  }

  if (unproven.length) {
    // These are NOT skipped-and-forgotten: the meaning of their stored amount could not be
    // established, so reinterpreting it could destroy a genuine discount. They are listed so they can
    // be settled by hand (or by stamping discountModel) and the run repeated.
    console.log('')
    console.log(
      `${LOG} ${unproven.length} order(s) are UNPROVEN — nothing establishes what their stored ` +
        'discountAmount means, so it is LEFT EXACTLY AS IT IS rather than re-derived:',
    )
    for (const { row, decision } of unproven) {
      console.log(`${LOG}   ${row.orderNumber || row.orderId}: ${decision.reason} — ${decision.detail}`)
    }
  }

  if (blocked.length) {
    console.log('')
    console.log(
      `${LOG} ${blocked.length} order(s) are BLOCKED by live accounting work — a queued SALES_INVOICE, ` +
        'or a daily revenue-deferral journal that has not posted yet. Both carry a payload snapshot the ' +
        'processors post from, and a worker may already hold it, so this run will not propose them. Let ' +
        'the queue and the daily batch drain (or resolve the failed jobs) and re-run:',
    )
    for (const { row, decision } of blocked) {
      console.log(`${LOG}   ${row.orderNumber || row.orderId}: ${decision.detail}`)
    }
  }

  if (csvPath) {
    const header =
      'salesOrderId,orderNumber,externalOrderNumber,currency,storedOrderDiscount,lineDiscountTotal,' +
      'importedAt,nearCutoff,discountModel,accountingInvoiceId,postedInvoiceExternalIds,liveInvoiceJobs,revenueDeferredBatchRef,' +
      'liveBatchDeferralJobs,refundStatus,refundIds,postedCreditNoteExternalIds,unresolvedRefundParks,action,reason,keptOrderLevel,clearedBy,detail'
    const body = rows.map(({ row, decision }) =>
      [
        row.orderId,
        row.orderNumber,
        row.externalOrderNumber,
        row.currency,
        row.storedOrderDiscount,
        row.lineDiscountTotal,
        row.importedAt?.toISOString() ?? '',
        isNearWcCouponCutoff(row.importedAt, importedBefore) ? 'NEAR_CUTOFF' : '',
        row.discountModel ?? '',
        row.accountingInvoiceId ?? '',
        // Space-separated inside ONE field: the separator must not be the CSV separator, or a row
        // with two posted invoices silently shifts every column after it.
        row.postedInvoiceExternalIds.join(' '),
        row.liveInvoiceJobs,
        row.revenueDeferredBatchRef ?? '',
        row.liveBatchDeferralJobs,
        row.refunds.disposition,
        // Space-separated inside ONE field, for the same reason the invoice ids are: the separator
        // must not be the CSV separator.
        row.refunds.refundIds.join(' '),
        row.refunds.postedCreditNoteExternalIds.join(' '),
        row.refunds.unresolvedRefundParkExternalIds.join(' '),
        decision.action,
        decision.action === 'CORRECT' ? (decision.partial ? 'PARTIAL' : 'FULL') : decision.reason,
        decision.action === 'CORRECT' ? decision.keptOrderLevel : '',
        decision.action === 'CORRECT' ? decision.clearedBy : '',
        decision.action === 'CORRECT' ? '' : JSON.stringify(decision.detail),
      ].join(','),
    )
    writeFileSync(csvPath, [header, ...body].join('\n') + '\n')
    console.log(`${LOG} wrote ${csvPath} (EVERY order, including the ones left alone)`)
  }

  if (allowlistOut) {
    const proposal: WcCouponAllowlist = {
      version: 4,
      generatedAt: new Date().toISOString(),
      cutoff: importedBefore ? importedBefore.toISOString() : '',
      // UNSIGNED. Apply refuses this file until a human sets these three.
      reviewed: false,
      reviewedBy: null,
      reviewedAt: null,
      stampOnly: [],
      clear: corrections.map(({ row, decision }) => buildWcCouponAllowlistEntry(row, decision, importedBefore)),
    }
    writeFileSync(allowlistOut, JSON.stringify(proposal, null, 2) + '\n')
    console.log('')
    console.log(
      `${LOG} wrote ${allowlistOut} — a PROPOSAL of ${proposal.clear.length} order(s), unsigned.\n` +
        `${LOG} Review every entry (see the header of this script for what to check), move any row ` +
        'whose amount is ALREADY correct into "stampOnly", delete anything you are unsure of, then set\n' +
        `${LOG}   "reviewed": true, "reviewedBy": "<your name>", "reviewedAt": "<ISO>"\n` +
        `${LOG} and run:  --allowlist ${allowlistOut} --apply`,
    )
  }

  console.log('')
  console.log(
    `${LOG} DRY RUN — nothing written. Apply consumes a REVIEWED allowlist only: ` +
      're-run with --allowlist-out <path> if you did not produce one.',
  )
}

// ---------------------------------------------------------------------------
// REPRINT — re-derive the ledger handoff for orders that have ALREADY been corrected
// ---------------------------------------------------------------------------

/**
 * o3d-y14 r8 finding 4 — THE INVOCATION THAT MAKES "NOTHING IS LOST" TRUE.
 *
 * Every refusal in this workflow, every withdrawn remedy and the whole refund-netting fallback end
 * in "re-run and nothing is lost". For a DECLINED row that is exactly right: nothing was written, so
 * the next report re-proposes it. For a CORRECTED row — the only kind that carries a ledger handoff
 * at all — it was false. The correction stamps `discountModel` and writes the ActivityLog marker, so
 * `decideWcCouponBackfill` answers SKIP for that order forever after and the report builds handoffs
 * only for CORRECT rows. The handoff an operator was told to reproduce could not be reproduced.
 *
 * This reads the allowlist for the ORDER IDS ONLY — no signature is required and none is honoured,
 * because nothing is decided and nothing is written; it is a query, and refusing to run a query
 * until a file is signed would just leave the operator without the answer. Each order's handoff is
 * re-derived from LIVE state through the same `buildWcCouponLedgerHandoff` apply uses, so what is
 * printed is what the ledger holds now rather than what it held during the run.
 */
async function reprint(allowlistPath: string) {
  const { db } = await import('../lib/db/index')

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  } catch (error) {
    console.error(`${LOG} could not read ${allowlistPath}: ${String(error)}`)
    process.exitCode = 1
    return
  }

  // NO SIGNATURE REQUIRED. This mode writes nothing and decides nothing, and a signature gate on a
  // query is friction with no property behind it — the operator reaching for --reprint is usually
  // holding the file they have ALREADY applied, but they may equally be holding an unsigned proposal
  // and asking what the ledger holds. Apply's own gate is untouched (o3d-y14 r8 finding 4).
  const parsed = parseWcCouponAllowlist(parsedJson, { requireSignature: false })
  if (!parsed.ok) {
    console.error(`${LOG} could not read ${allowlistPath}: ${parsed.reason} — ${parsed.detail}`)
    process.exitCode = 1
    return
  }
  // BOTH lists. A stamped row was never corrected, so it carries no handoff of its own — but the
  // reviewer may have moved an entry between the two since, and an operator asking "what does the
  // ledger hold for this order" is owed the answer either way.
  const entries = [...parsed.allowlist.clear, ...parsed.allowlist.stampOnly]

  console.log(`${LOG} mode: REPRINT (read-only)`)
  console.log(
    `${LOG} re-deriving the LEDGER HANDOFF for ${entries.length} order(s) from ${allowlistPath}, ` +
      'against LIVE state. Nothing is written, no lock is taken and no evidence is re-verified — ' +
      'this reports what the accounting system holds NOW, which is what a plain report cannot do for ' +
      'an order that has already been corrected.',
  )

  let missing = 0
  let nothingInLedger = 0
  for (const entry of entries) {
    const result = await reprintWcCouponLedgerHandoff(db, { orderId: entry.orderId, currency: entry.currency })
    if (result.outcome === 'ORDER_GONE') {
      missing += 1
      console.log(`${LOG}   ${entry.orderNumber || entry.orderId}: the order no longer exists.`)
      continue
    }
    console.log(
      `${LOG}   ${entry.orderNumber || entry.orderId} — ${result.detail}; ` +
        (result.handoff
          ? result.handoff.needsAccountingAction
            ? 'ACCOUNTING ACTION REQUIRED:'
            : 'no accounting action:'
          : 'nothing derived from the pre-correction amount is in the accounting system.'),
    )
    if (!result.handoff) {
      nothingInLedger += 1
      continue
    }
    for (const line of result.handoff.lines) console.log(`${LOG}     ${line}`)
  }

  console.log('')
  console.log(
    `${LOG} REPRINT complete — nothing written. ${missing} order(s) no longer exist; ` +
      `${nothingInLedger} have no accounting document derived from the corrected amount.`,
  )
}

async function main() {
  const parsedFlags = parseWcCouponCliFlags(process.argv.slice(2))
  if (!parsedFlags.ok) {
    console.error(`${LOG} REFUSING to run: ${parsedFlags.detail}.`)
    process.exitCode = 1
    return
  }
  const APPLY = parsedFlags.flags.apply
  const importedBeforeRaw = parsedFlags.flags['imported-before']
  const csvPath = parsedFlags.flags.csv
  const allowlistPath = parsedFlags.flags.allowlist
  const allowlistOut = parsedFlags.flags['allowlist-out']
  const reprintPath = parsedFlags.flags.reprint

  if (reprintPath) {
    // Deliberately checked BEFORE --apply, and mutually exclusive with it: this mode exists to be
    // safe to run at any moment, including while someone is deciding what to do about a remedy, and
    // a flag combination that could write would defeat that.
    if (APPLY) {
      console.error(`${LOG} --reprint is read-only and cannot be combined with --apply.`)
      process.exitCode = 1
      return
    }
    await reprint(reprintPath)
    return
  }

  if (APPLY) {
    if (!allowlistPath) {
      console.error(
        `${LOG} REFUSING to apply without --allowlist <path>.\n` +
          'This rewrites the discount on orders whose invoices are already in the ledger, and no field on\n' +
          'a row distinguishes a pre-fix import from one corrected by hand or written by the fixed importer\n' +
          'before it stamped its marker. So apply consumes a REVIEWED list of order ids, never a fresh scan.\n' +
          'Produce one with:  --imported-before <ISO> --allowlist-out <path>',
      )
      process.exitCode = 1
      return
    }
    if (importedBeforeRaw) {
      // The cutoff belongs to the PROPOSAL. Accepting it here would invite "apply with a different
      // cutoff", which is exactly the re-scan the review exists to prevent.
      console.error(
        `${LOG} --imported-before is not accepted with --apply. The cutoff decided which orders were ` +
          'PROPOSED; what apply may touch is decided by the reviewed allowlist alone.',
      )
      process.exitCode = 1
      return
    }
    await apply(allowlistPath)
    return
  }

  let importedBefore: Date | null = null
  if (importedBeforeRaw) {
    const parsed = parseWcCouponCutoff(importedBeforeRaw, new Date())
    if (!parsed.ok) {
      console.error(`${LOG} --imported-before rejected: ${parsed.reason} — ${parsed.detail}`)
      process.exitCode = 1
      return
    }
    importedBefore = parsed.cutoff
  }
  if (allowlistOut && !importedBefore) {
    console.error(
      `${LOG} --allowlist-out needs --imported-before <ISO instant>: without a cutoff every unstamped ` +
        'order is UNPROVEN, so the proposal would be empty.',
    )
    process.exitCode = 1
    return
  }

  await report(importedBefore, csvPath, allowlistOut)
}

// Only when RUN, not when imported: the unit tests import the decision helpers, and a module-load
// side effect would have them open a database connection.
if (process.argv[1]?.includes('backfill-wc-coupon-order-discount')) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      const { db } = await import('../lib/db/index')
      await db.$disconnect()
    })
}
