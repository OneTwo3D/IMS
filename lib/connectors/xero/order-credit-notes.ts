/**
 * THE ORDER'S SALES CREDIT NOTES AS XERO HOLDS THEM (o3d-0lpnb MED-3, o3d-pnc8p note 1): read-only, before IMS settles or creates a sales credit note.
 *
 * WHY. Before the cut-over Xeroom raised the order's credit notes, and people raised some by hand. Neither leaves an IMS row, so IMS cannot see:
 *   - the cash a Xeroom-era credit note was paid out with (the invoice's AmountPaid does not fall when a credit note is refunded), so a refund-payment cap built from
 *     IMS rows alone allows 40 + 40 against 50 received;
 *   - a credit note that already credits THIS refund, so IMS would raise or pay out a second one (162199 was duplicated that way on 2026-11-21, and voided).
 *
 * HOW A CREDIT NOTE IS TIED TO THE ORDER. Xeroom references its credit notes `<order id>-<name>`; hand-raised ones often carry the WooCommerce REFUND id instead
 * (CN-11453 '161212', CN-11573 '162752'); o3d-store-credit-refund numbers its own `SC-<refund id>`. Order and refund ids share one id sequence, so a number is
 * unambiguous. A credit note matches when a whole digit run in its Reference (or its number) is the order id or ANY refund id of the order, or its number is
 * `SC-<refund id>`. A digit run, never a prefix: `1586710` is not order 158671.
 *
 * WHAT IS COUNTED. Only PAYMENTS on a credit note are cash out (a refund paid out of the bank). An ALLOCATION of a credit note to an invoice moves no cash, and a
 * credit note allocated to a REPLACEMENT order's invoice is correct, not a double credit (CN-11394 -> 157026, CN-11421 -> 159884): it is never counted as cash.
 *
 * FAIL CLOSED. Every read goes through `xeroGet` (the one Xero read client: the network egress controls and the no-outbound-network test guard apply). A search
 * that fills its page, a credit note that cannot be read on its own, a payment in another currency, or more matches than MAX_MATCHED_CREDIT_NOTES is UNKNOWN,
 * and the caller sends nothing.
 *
 * COST. One search, plus one read per matched credit note that is not voided. The Xero day allowance is shared with Xeroom: the search is per settlement or create,
 * never a collection walk.
 */
import { xeroGet } from './api'
import { readSingleXeroDocument } from './single-document'
import { XERO_SALES_CREDIT_NOTE_TYPE } from './credit-notes'
import { PAGE_SIZE } from './invoice-delta'

/** More matched credit notes than this is refused rather than read one by one (an order with this many credit notes needs a person). */
export const MAX_MATCHED_CREDIT_NOTES = 20

export type OrderCreditNoteKeys = {
  /** The WooCommerce order id(s) the order is linked to. */
  orderIds: readonly string[]
  /** EVERY WooCommerce refund id known for the order: IMS refunds and parked refunds. */
  refundIds: readonly string[]
}

/** How a Xero credit note matched the order. */
export type CreditNoteMatch = {
  creditNoteId: string
  creditNoteNumber: string | null
  reference: string | null
  status: string
  currency: string | null
  total: number | null
  /** The order ids the credit note names. */
  byOrder: string[]
  /** The refund ids it names (by Reference, by number, or as `SC-<id>`). */
  byRefund: string[]
}

const digitRuns = (text: string | null): string[] => (text ?? '').match(/\d+/g) ?? []

/** The credit note's tie to the order, or null when it names neither the order nor any of its refunds. Pure. */
export function matchOrderCreditNote(
  row: { CreditNoteID?: unknown; CreditNoteNumber?: unknown; Reference?: unknown; Status?: unknown; Type?: unknown; CurrencyCode?: unknown; Total?: unknown },
  keys: OrderCreditNoteKeys,
): CreditNoteMatch | null {
  const id = typeof row.CreditNoteID === 'string' ? row.CreditNoteID.trim() : ''
  if (id === '') return null
  if (typeof row.Type === 'string' && row.Type.toUpperCase() !== XERO_SALES_CREDIT_NOTE_TYPE) return null
  const number = typeof row.CreditNoteNumber === 'string' && row.CreditNoteNumber.trim() !== '' ? row.CreditNoteNumber.trim() : null
  const reference = typeof row.Reference === 'string' && row.Reference.trim() !== '' ? row.Reference.trim() : null
  const runs = new Set([...digitRuns(reference), ...digitRuns(number)])
  const byOrder = keys.orderIds.filter((orderId) => runs.has(orderId))
  const byRefund = keys.refundIds.filter((refundId) => runs.has(refundId) || (number !== null && number.toUpperCase() === `SC-${refundId}`))
  if (byOrder.length === 0 && byRefund.length === 0) return null
  return {
    creditNoteId: id,
    creditNoteNumber: number,
    reference,
    status: typeof row.Status === 'string' ? row.Status.toUpperCase() : 'UNKNOWN',
    currency: typeof row.CurrencyCode === 'string' ? row.CurrencyCode.toUpperCase() : null,
    total: typeof row.Total === 'number' && Number.isFinite(row.Total) ? row.Total : null,
    byOrder,
    byRefund,
  }
}

/** A void or deleted credit note credits nothing and holds no cash. */
export function isDeadCreditNote(status: string): boolean {
  return status === 'VOIDED' || status === 'DELETED'
}

/** Xero's where-clause for the search. Ids are digits only (anything else is refused by the caller), so nothing here can re-punctuate the clause. */
export function orderCreditNoteSearchWhere(keys: OrderCreditNoteKeys): string {
  const terms: string[] = []
  for (const id of [...keys.orderIds, ...keys.refundIds]) terms.push(`(Reference != null AND Reference.Contains("${id}"))`)
  for (const id of keys.refundIds) terms.push(`CreditNoteNumber == "SC-${id}"`)
  return `Type == "${XERO_SALES_CREDIT_NOTE_TYPE}" AND (${terms.join(' OR ')})`
}

/** Cash paid out on one credit note: the sum of its live Payments, in minor units. Null = unreadable (fail closed). Pure. */
export function creditNotePaidOutCents(payments: unknown): number | null {
  if (payments === undefined || payments === null) return 0
  if (!Array.isArray(payments)) return null
  let cents = 0
  for (const payment of payments) {
    if (typeof payment !== 'object' || payment === null) return null
    const p = payment as { Amount?: unknown; Status?: unknown }
    if (typeof p.Status === 'string' && p.Status.toUpperCase() === 'DELETED') continue
    if (typeof p.Amount !== 'number' || !Number.isFinite(p.Amount) || p.Amount < 0) return null
    cents += Math.round(p.Amount * 100)
  }
  return cents
}

export type OrderCreditNoteRead = CreditNoteMatch & { paidOutCents: number }

export type OrderCreditNotesResult =
  | { ok: true; creditNotes: OrderCreditNoteRead[] }
  | { ok: false; error: string }

type Get = <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string }>

/**
 * Read the order's sales credit notes from Xero (READ ONLY): one search by every key, then each live match on its own for its Payments. `currency` is the order's:
 * a matched credit note that paid out cash in another currency cannot be counted against the order's receipts, so it is UNKNOWN.
 */
export async function readOrderCreditNotesFromXero(
  keys: OrderCreditNoteKeys,
  currency: string,
  deps: { get: Get } = { get: (path) => xeroGet(path) },
): Promise<OrderCreditNotesResult> {
  const clean = {
    orderIds: [...new Set(keys.orderIds.map((id) => String(id).trim()).filter((id) => id !== ''))],
    refundIds: [...new Set(keys.refundIds.map((id) => String(id).trim()).filter((id) => id !== ''))],
  }
  // An order IMS raised itself (no storefront link, no storefront refund): Xeroom never saw it and no storefront id can name it, so there is nothing to search by.
  if (clean.orderIds.length === 0 && clean.refundIds.length === 0) return { ok: true, creditNotes: [] }
  const bad = [...clean.orderIds, ...clean.refundIds].find((id) => !/^\d+$/.test(id))
  if (bad !== undefined) return { ok: false, error: `the id ${JSON.stringify(bad)} is not a WooCommerce number, so IMS cannot search Xero for credit notes by it` }

  let res: Awaited<ReturnType<Get>>
  try {
    res = await deps.get<{ CreditNotes?: unknown[]; pagination?: { pageCount?: unknown } }>(`CreditNotes?where=${encodeURIComponent(orderCreditNoteSearchWhere(clean))}&page=1&pageSize=${PAGE_SIZE}`)
  } catch (error) {
    return { ok: false, error: `the search of Xero for the order's credit notes threw: ${String(error)}` }
  }
  if (!res.ok) return { ok: false, error: `the search of Xero for the order's credit notes failed: ${res.error ?? `HTTP ${res.status}`}` }
  const body = res.data as { CreditNotes?: unknown[]; pagination?: { pageCount?: unknown } } | undefined
  if (!body || !Array.isArray(body.CreditNotes)) return { ok: false, error: 'the search of Xero for the order\'s credit notes returned no CreditNotes list' }
  if (body.CreditNotes.length >= PAGE_SIZE || (typeof body.pagination?.pageCount === 'number' && body.pagination.pageCount > 1)) {
    return { ok: false, error: `the search of Xero for the order's credit notes filled its page (${body.CreditNotes.length}), so IMS cannot show it saw every one` }
  }
  const matches = body.CreditNotes
    .map((row) => (typeof row === 'object' && row !== null ? matchOrderCreditNote(row as Record<string, unknown>, clean) : null))
    .filter((match): match is CreditNoteMatch => match !== null)
  const live = matches.filter((match) => !isDeadCreditNote(match.status))
  if (live.length > MAX_MATCHED_CREDIT_NOTES) {
    return { ok: false, error: `Xero holds ${live.length} live credit notes naming this order or its refunds, more than IMS reads one by one (${MAX_MATCHED_CREDIT_NOTES})` }
  }
  const out: OrderCreditNoteRead[] = matches.filter((match) => isDeadCreditNote(match.status)).map((match) => ({ ...match, paidOutCents: 0 }))
  for (const match of live) {
    let one: Awaited<ReturnType<Get>>
    try {
      one = await deps.get(`CreditNotes/${encodeURIComponent(match.creditNoteId)}`)
    } catch (error) {
      return { ok: false, error: `reading credit note ${match.creditNoteNumber ?? match.creditNoteId} from Xero threw: ${String(error)}` }
    }
    if (!one.ok) return { ok: false, error: `credit note ${match.creditNoteNumber ?? match.creditNoteId} could not be read from Xero: ${one.error ?? `HTTP ${one.status}`}` }
    const read = readSingleXeroDocument<{ Payments?: unknown; CurrencyCode?: unknown; Total?: unknown; Status?: unknown }>(one.data, 'CreditNotes', 'CreditNoteID', match.creditNoteId)
    if (read.status === 'unreadable') return { ok: false, error: `credit note ${match.creditNoteNumber ?? match.creditNoteId} was not read from Xero: ${read.reason}` }
    const paidOutCents = creditNotePaidOutCents(read.document.Payments)
    if (paidOutCents === null) return { ok: false, error: `credit note ${match.creditNoteNumber ?? match.creditNoteId} states payments IMS cannot read, so the cash it paid out is unknown` }
    const cnCurrency = typeof read.document.CurrencyCode === 'string' ? read.document.CurrencyCode.toUpperCase() : match.currency
    if (paidOutCents > 0 && cnCurrency !== null && cnCurrency !== currency.toUpperCase()) {
      return { ok: false, error: `credit note ${match.creditNoteNumber ?? match.creditNoteId} paid out cash in ${cnCurrency}, not the order's ${currency}, so IMS cannot count it against the order's receipts` }
    }
    const total = typeof read.document.Total === 'number' && Number.isFinite(read.document.Total) ? read.document.Total : match.total
    const status = typeof read.document.Status === 'string' ? read.document.Status.toUpperCase() : match.status
    out.push({ ...match, currency: cnCurrency, total, status, paidOutCents })
  }
  return { ok: true, creditNotes: out }
}

/** How a credit note found in Xero is described to an operator. */
export function describeCreditNote(cn: Pick<CreditNoteMatch, 'creditNoteNumber' | 'creditNoteId' | 'reference' | 'status'>): string {
  return `${cn.creditNoteNumber ?? cn.creditNoteId}${cn.reference ? ` (reference "${cn.reference}")` : ''}, ${cn.status}`
}

/** The DB delegates the key reader asks. */
export type OrderCreditNoteKeyReader = {
  shoppingOrderLink: { findMany(args: { where: { orderId: string; connector: string }; select: { externalOrderId: true } }): Promise<Array<{ externalOrderId: string }>> }
  salesOrderRefund: { findMany(args: { where: { orderId: string }; select: { id: true; externalRefundId: true; accountingCreditNoteId: true } }): Promise<Array<{ id: string; externalRefundId: number | null; accountingCreditNoteId: string | null }>> }
  shoppingSyncLog: { findMany(args: { where: { entityId: string; recordKind: string; connector: string }; select: { externalId: true } }): Promise<Array<{ externalId: string | null }>> }
}

/**
 * What IMS knows that ties a Xero credit note to the order: its WooCommerce order id, EVERY refund id (IMS refunds, deleted ones included, and refunds parked on Sync
 * exceptions, in any status), and the credit notes IMS itself recorded for those refunds (id -> IMS refund id).
 */
export async function readOrderCreditNoteKeys(client: OrderCreditNoteKeyReader, orderId: string): Promise<{ keys: OrderCreditNoteKeys; imsCreditNotes: Map<string, string>; externalRefundIdOf: Map<string, string> }> {
  const [links, refunds, parks] = await Promise.all([
    client.shoppingOrderLink.findMany({ where: { orderId, connector: 'woocommerce' }, select: { externalOrderId: true } }),
    // soft-delete exception (identity check): a deleted refund's credit note may still stand in Xero, and its refund id still names it.
    client.salesOrderRefund.findMany({ where: { orderId }, select: { id: true, externalRefundId: true, accountingCreditNoteId: true } }),
    client.shoppingSyncLog.findMany({ where: { entityId: orderId, recordKind: 'WC_REFUND_PARK', connector: 'woocommerce' }, select: { externalId: true } }),
  ])
  const imsCreditNotes = new Map<string, string>()
  const externalRefundIdOf = new Map<string, string>()
  for (const refund of refunds) {
    if (refund.accountingCreditNoteId) imsCreditNotes.set(refund.accountingCreditNoteId, refund.id)
    if (refund.externalRefundId != null) externalRefundIdOf.set(refund.id, String(refund.externalRefundId))
  }
  return {
    keys: {
      orderIds: links.map((link) => link.externalOrderId),
      refundIds: [...externalRefundIdOf.values(), ...parks.map((park) => park.externalId ?? '').filter((id) => /^\d+$/.test(id))],
    },
    imsCreditNotes,
    externalRefundIdOf,
  }
}

/** The system switch (lib/domain/settings/system-switches.ts) for the check made before IMS CREATES a sales credit note. ON only for the exact string `true`. */
export const CREDIT_NOTE_DUPLICATE_CHECK_SETTING_KEY = 'xero_credit_note_duplicate_check_enabled'

/**
 * BEFORE IMS CREATES A SALES CREDIT NOTE (o3d-pnc8p note 1): does Xero already hold one, raised by Xeroom or by hand, for THIS refund? Pure.
 *
 * A live credit note IMS did not record is this refund's when it names the refund (Reference, or the number `SC-<refund id>`), when it names only the order and
 * credits exactly this credit note's total, or when it carries the very number IMS minted for this one and no earlier attempt of this row was made (so it cannot be
 * IMS's own, landed after a lost response: a re-post of that converges, since POST /CreditNotes is create-or-update on the number). Null: nothing found.
 */
export function creditNoteCreateDuplicates(input: {
  creditNotes: readonly OrderCreditNoteRead[]
  imsCreditNotes: ReadonlyMap<string, string>
  selfExternalRefundId: string | null
  creditNoteNumber: string | null
  totalCents: number | null
  attemptedBefore: boolean
}): OrderCreditNoteRead[] {
  const known = new Set([...input.imsCreditNotes.keys()].map((id) => id.trim().toLowerCase()))
  const own = input.creditNoteNumber?.trim().toLowerCase() ?? null
  return input.creditNotes.filter((cn) => {
    if (isDeadCreditNote(cn.status) || known.has(cn.creditNoteId.trim().toLowerCase())) return false
    if (own !== null && cn.creditNoteNumber?.toLowerCase() === own) return !input.attemptedBefore
    if (input.selfExternalRefundId !== null && cn.byRefund.includes(input.selfExternalRefundId)) return true
    return cn.byRefund.length === 0 && input.totalCents !== null && cn.total !== null && Math.round(cn.total * 100) === input.totalCents
  })
}
