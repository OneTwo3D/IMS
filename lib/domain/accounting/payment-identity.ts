/**
 * WHICH PAYMENT IS WHICH — the one rule every money gate asks about a rival registration.
 *
 * An invoice may be settled by several payments (a deposit and a balance). What must never happen is
 * the SAME payment reaching the ledger twice. The gates that guard against that — the registration
 * decision, the post-site capacity guard, the money-post fence and the manual retry planner — used to
 * judge every other registration on the invoice as a rival of the one being sent, so a deposit that had
 * posted blocked its own balance. They now ask this module, and only this module, whether a rival is a
 * DIFFERENT payment or possibly the same one.
 *
 * IDENTITY IS `Payment.id` — the local receipt a registration was queued for (`payload.paymentId`).
 * Not the idempotency token (a re-queued row for the same receipt gets a new token and must still be
 * judged the same payment), not the sync row id (same reason), and not `Payment.reference` (a free-text
 * field that genuine part payments often share, such as an order number used as a bank reference).
 *
 * PROVEN DIFFERENT IS NARROW AND FAILS CLOSED. A rival is a different payment from the target only when
 * ALL of these hold, and everything else is "possibly the same", judged exactly as it always was:
 *
 *   1. both registrations name a receipt, and the two are not equal;
 *   2. the rival's receipt STILL EXISTS. A deleted receipt's posted row is evidence about money that may
 *      be re-entered under a new id, so it stays a rival;
 *   3. that receipt belongs to the SAME ORDER as the target (a defence against a cross-scope anchor
 *      match), and is a receipt rather than a refund payment.
 *
 * A null identity (an imported registration, a row queued before the payload recorded one) is therefore
 * always "possibly the same" — unknown must read as "possibly this one" where money is concerned.
 *
 * WHAT A DIFFERENT PAYMENT MAY NOT DO is refuse by its own verdict. What it IS used for is attributing
 * ledger records: a settlement carrying the other payment's mark is that payment's, and is set aside
 * from the matching of the target — see {@link setAsideRecordsOfOtherPayments}.
 */

import type { LedgerSettlementProbe, LedgerSettlementRecord } from './ledger-settlement-evidence'

/** The receipts of one order that still exist, by id. Built by {@link liveReceiptsFrom}. */
export type LiveReceipts = ReadonlyMap<string, { orderId: string }>

export const NO_LIVE_RECEIPTS: LiveReceipts = new Map()

/**
 * The local receipt an INVOICE_PAYMENT payload was queued for, or null when it records none. The single
 * reading of the field (`operator-ledger-check`'s `invoicePaymentReceiptId` is the same function).
 */
export function receiptIdOfPayload(payload: unknown): string | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  return typeof p.paymentId === 'string' && p.paymentId !== '' ? p.paymentId : null
}

/** The part of a registration this module reads. */
export type PaymentIdentityRef = { paymentId?: string | null }

/** The registration being judged: its receipt and the order it settles (null when not order-scoped). */
export type PaymentIdentityTarget = { paymentId: string | null; orderId: string | null }

/**
 * Receipt rows -> the lookup. REFUND payments (those settling a credit note) are not receipts of an
 * invoice and are never admitted, so a payload naming one reads as "possibly the same".
 */
export function liveReceiptsFrom(
  rows: ReadonlyArray<{ id: string; orderId: string; refundId?: string | null }>,
): LiveReceipts {
  const map = new Map<string, { orderId: string }>()
  for (const row of rows) {
    if (row.refundId != null) continue
    map.set(row.id, { orderId: row.orderId })
  }
  return map
}

/** Is `rival` PROVEN to be a different payment from `target`? The single predicate. */
export function isProvenDifferentPayment(
  target: PaymentIdentityTarget,
  rival: PaymentIdentityRef,
  liveReceipts: LiveReceipts,
): boolean {
  if (target.paymentId == null || rival.paymentId == null) return false
  if (target.paymentId === rival.paymentId) return false
  if (target.orderId == null) return false
  const receipt = liveReceipts.get(rival.paymentId)
  return receipt !== undefined && receipt.orderId === target.orderId
}

/**
 * Split rival registrations into those that may be the SAME payment as the target (judged as before) and
 * those PROVEN to be different ones. The only function in the tree that makes this call.
 */
export function partitionByPaymentIdentity<R extends PaymentIdentityRef>(
  target: PaymentIdentityTarget,
  rivals: readonly R[],
  liveReceipts: LiveReceipts,
): { same: R[]; different: R[] } {
  const same: R[] = []
  const different: R[] = []
  for (const rival of rivals) {
    if (isProvenDifferentPayment(target, rival, liveReceipts)) different.push(rival)
    else same.push(rival)
  }
  return { same, different }
}

/**
 * The ledger records ATTRIBUTED to other payments, set aside from the target's matching.
 *
 * ATTRIBUTION IS BY MARK ONLY. A record is another payment's when its reference carries that payment's
 * mark. It is never attributed by the ledger id IMS recorded for that payment: the issuer of a recorded id
 * is not recorded, so an id cannot exclude a record (see the note above `classifyLedgerSettlement`). A mark
 * is proof of authorship by a token that is not the target's.
 *
 * EXACTLY ONE RECORD PER MARK. A mark found on two or more records means the ledger already holds that
 * payment twice; the answer is `ambiguous` and the caller withholds. A record that ALSO carries the
 * target's own mark is never set aside — it may be the target's payment.
 *
 * Records with no mark of a different payment stay: a hand-entered payment with the same amount and date
 * as the target still refuses it, exactly as before. The reading's completeness is unchanged — the set
 * aside records were READ, so `provedComplete` is carried through.
 */
export function setAsideRecordsOfOtherPayments(
  probe: LedgerSettlementProbe,
  otherMarks: readonly string[],
  ownMark: string | null,
): { probe: LedgerSettlementProbe; setAside: LedgerSettlementRecord[]; ambiguous: Array<{ mark: string; count: number }> } {
  if (!probe.ok) return { probe, setAside: [], ambiguous: [] }
  const ambiguous: Array<{ mark: string; count: number }> = []
  const aside = new Set<LedgerSettlementRecord>()
  for (const mark of new Set(otherMarks)) {
    if (!mark) continue
    const carrying = probe.records.filter((r) => typeof r.reference === 'string' && r.reference.includes(mark))
    if (carrying.length > 1) {
      ambiguous.push({ mark, count: carrying.length })
      continue
    }
    const [only] = carrying
    if (!only) continue
    if (ownMark && typeof only.reference === 'string' && only.reference.includes(ownMark)) continue
    aside.add(only)
  }
  if (aside.size === 0) return { probe, setAside: [], ambiguous }
  return {
    probe: { ...probe, records: probe.records.filter((r) => !aside.has(r)) },
    setAside: [...aside],
    ambiguous,
  }
}

/** The structural slice of a Prisma client {@link loadLiveReceipts} needs. */
export type ReceiptReader = {
  payment: {
    findMany: (args: {
      where: { orderId: string; refundId: null }
      select: { id: true; orderId: true; refundId: true }
    }) => Promise<Array<{ id: string; orderId: string; refundId: string | null }>>
  }
}

/**
 * The live receipts of one order. A read that FAILS answers {@link NO_LIVE_RECEIPTS}, which makes every
 * rival "possibly the same" — the refusing direction — rather than throwing out of a money path.
 */
export async function loadLiveReceipts(client: ReceiptReader, orderId: string): Promise<LiveReceipts> {
  try {
    return liveReceiptsFrom(await client.payment.findMany({
      where: { orderId, refundId: null },
      select: { id: true, orderId: true, refundId: true },
    }))
  } catch {
    return NO_LIVE_RECEIPTS
  }
}
