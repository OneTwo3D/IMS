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
  /** The credit note's date (YYYY-MM-DD) as Xero states it; null when unreadable. */
  date: string | null
  /** The order ids the credit note names. */
  byOrder: string[]
  /** The refund ids it names (by Reference, by number, or as `SC-<id>`). */
  byRefund: string[]
}

const digitRuns = (text: string | null): string[] => (text ?? '').match(/\d+/g) ?? []

/** The credit note's tie to the order, or null when it names neither the order nor any of its refunds. Pure. */
export function matchOrderCreditNote(
  row: { CreditNoteID?: unknown; CreditNoteNumber?: unknown; Reference?: unknown; Status?: unknown; Type?: unknown; CurrencyCode?: unknown; Total?: unknown; DateString?: unknown; Date?: unknown },
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
    date: xeroDocumentDate(row),
    byOrder,
    byRefund,
  }
}

/** A Xero document's date as YYYY-MM-DD: `DateString` ("2026-11-10T00:00:00"), else the `/Date(ms+0000)/` form. Null when neither reads. Pure. */
export function xeroDocumentDate(row: { DateString?: unknown; Date?: unknown }): string | null {
  if (typeof row.DateString === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.DateString)) return row.DateString.slice(0, 10)
  if (typeof row.Date === 'string') {
    const ms = /\/Date\((-?\d+)/.exec(row.Date)
    if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}/.test(row.Date)) return row.Date.slice(0, 10)
  }
  return null
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
  | { ok: false; error: string; /** The run's Xero call budget ran out: a wait, not a failure. */ budget?: true }

type Get = <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string }>

/**
 * Read the order's sales credit notes from Xero (READ ONLY): one search by every key, then each live match on its own for its Payments. `currency` is the order's:
 * a matched credit note that paid out cash in another currency cannot be counted against the order's receipts, so it is UNKNOWN.
 */
export async function readOrderCreditNotesFromXero(
  keys: OrderCreditNoteKeys,
  currency: string,
  deps: { get?: Get; /** o3d-0lpnb R1 H1: spends one call from the run's Xero budget; false = none left (nothing is asked). */ spend?: () => boolean | Promise<boolean> } = {},
): Promise<OrderCreditNotesResult> {
  const spend = deps.spend ?? (() => true)
  const get: Get = deps.get ?? ((path) => xeroGet(path))
  const clean = {
    orderIds: [...new Set(keys.orderIds.map((id) => String(id).trim()).filter((id) => id !== ''))],
    refundIds: [...new Set(keys.refundIds.map((id) => String(id).trim()).filter((id) => id !== ''))],
  }
  // An order IMS raised itself (no storefront link, no storefront refund): Xeroom never saw it and no storefront id can name it, so there is nothing to search by.
  if (clean.orderIds.length === 0 && clean.refundIds.length === 0) return { ok: true, creditNotes: [] }
  const bad = [...clean.orderIds, ...clean.refundIds].find((id) => !/^\d+$/.test(id))
  if (bad !== undefined) return { ok: false, error: `the id ${JSON.stringify(bad)} is not a WooCommerce number, so IMS cannot search Xero for credit notes by it` }

  let res: Awaited<ReturnType<Get>>
  if (!(await spend())) return { ok: false, budget: true, error: 'today\'s Xero call budget for credit-note settlements is spent' }
  try {
    res = await get<{ CreditNotes?: unknown[]; pagination?: { pageCount?: unknown } }>(`CreditNotes?where=${encodeURIComponent(orderCreditNoteSearchWhere(clean))}&page=1&pageSize=${PAGE_SIZE}`)
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
    if (!(await spend())) return { ok: false, budget: true, error: 'today\'s Xero call budget for credit-note settlements is spent' }
    try {
      one = await get(`CreditNotes/${encodeURIComponent(match.creditNoteId)}`)
    } catch (error) {
      return { ok: false, error: `reading credit note ${match.creditNoteNumber ?? match.creditNoteId} from Xero threw: ${String(error)}` }
    }
    if (!one.ok) return { ok: false, error: `credit note ${match.creditNoteNumber ?? match.creditNoteId} could not be read from Xero: ${one.error ?? `HTTP ${one.status}`}` }
    const read = readSingleXeroDocument<{ Payments?: unknown; CurrencyCode?: unknown; Total?: unknown; Status?: unknown; DateString?: unknown; Date?: unknown }>(one.data, 'CreditNotes', 'CreditNoteID', match.creditNoteId)
    if (read.status === 'unreadable') return { ok: false, error: `credit note ${match.creditNoteNumber ?? match.creditNoteId} was not read from Xero: ${read.reason}` }
    const paidOutCents = creditNotePaidOutCents(read.document.Payments)
    if (paidOutCents === null) return { ok: false, error: `credit note ${match.creditNoteNumber ?? match.creditNoteId} states payments IMS cannot read, so the cash it paid out is unknown` }
    const cnCurrency = typeof read.document.CurrencyCode === 'string' ? read.document.CurrencyCode.toUpperCase() : match.currency
    if (paidOutCents > 0 && cnCurrency !== null && cnCurrency !== currency.toUpperCase()) {
      return { ok: false, error: `credit note ${match.creditNoteNumber ?? match.creditNoteId} paid out cash in ${cnCurrency}, not the order's ${currency}, so IMS cannot count it against the order's receipts` }
    }
    const total = typeof read.document.Total === 'number' && Number.isFinite(read.document.Total) ? read.document.Total : match.total
    const status = typeof read.document.Status === 'string' ? read.document.Status.toUpperCase() : match.status
    out.push({ ...match, currency: cnCurrency, total, status, date: xeroDocumentDate(read.document) ?? match.date, paidOutCents })
  }
  return { ok: true, creditNotes: out }
}

/** How a credit note found in Xero is described to an operator. */
export function describeCreditNote(cn: Pick<CreditNoteMatch, 'creditNoteNumber' | 'creditNoteId' | 'reference' | 'status'>): string {
  return `${cn.creditNoteNumber ?? cn.creditNoteId}${cn.reference ? ` (reference "${cn.reference}")` : ''}, ${cn.status}`
}

/** One IMS refund of the order, as the duplicate test reads it. */
export type OrderRefundKey = {
  id: string
  externalRefundId: string | null
  /** The credit note IMS recorded for it (null: none, e.g. a Xeroom-era refund). */
  creditNoteId: string | null
  /** The gross the storefront returned, in minor units (null: unknown). */
  grossCents: number | null
  /** The refund's own date (YYYY-MM-DD). */
  refundedOn: string | null
  /** Credit notes an operator acknowledged as NOT this refund's duplicate (lower-cased ids). */
  notDuplicateOf: string[]
  /** #1127 R2 MED-4: the refund is deleted in IMS. */
  deleted?: boolean
  /** #1127 R2 MED-4: IMS has a live CREDIT_NOTE row for it (queued, in flight, posted or failed), so IMS will raise (or has raised) its credit note. */
  imsRaisesCreditNote?: boolean
}

/** The DB delegates the key reader asks (a Prisma client or transaction satisfies it). */
export type OrderCreditNoteKeyReader = {
  shoppingOrderLink: { findMany(args: { where: { orderId: string; connector: string }; select: { externalOrderId: true } }): Promise<Array<{ externalOrderId: string }>> }
  salesOrderRefund: { findMany(args: { where: { orderId: string }; select: { id: true; externalRefundId: true; accountingCreditNoteId: true; statedGrossForeign: true; refundedAt: true; creditNoteNotDuplicate: true; deletedAt: true } }): Promise<Array<{ id: string; externalRefundId: number | null; accountingCreditNoteId: string | null; statedGrossForeign: { toString(): string } | null; refundedAt: Date; creditNoteNotDuplicate: unknown; deletedAt: Date | null }>> }
  accountingSyncLog: { findMany(args: { where: { type: 'CREDIT_NOTE'; referenceType: string; referenceId: { in: string[] }; status: { not: 'CANCELLED' } }; select: { referenceId: true } }): Promise<Array<{ referenceId: string }>> }
  shoppingSyncLog: { findMany(args: { where: { entityId: string; recordKind: string; connector: string }; select: { externalId: true } }): Promise<Array<{ externalId: string | null }>> }
}

/** The acknowledgements stored on a refund (`creditNoteNotDuplicate`): `[{ creditNoteId, creditNoteNumber, by, reason, at }]`. */
export type NotDuplicateAck = { creditNoteId: string; creditNoteNumber: string | null; by: string; reason: string; at: string }
export function readNotDuplicateAcks(value: unknown): NotDuplicateAck[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is NotDuplicateAck => typeof entry === 'object' && entry !== null && typeof (entry as { creditNoteId?: unknown }).creditNoteId === 'string')
}

/**
 * What IMS knows that ties a Xero credit note to the order: its WooCommerce order id, EVERY refund id (IMS refunds, deleted ones included, and refunds parked on Sync
 * exceptions, in any status), and per IMS refund the credit note IMS recorded, its gross, its date and the operator's "not a duplicate" acknowledgements.
 */
export async function readOrderCreditNoteKeys(client: OrderCreditNoteKeyReader, orderId: string): Promise<{ keys: OrderCreditNoteKeys; imsCreditNotes: Map<string, string>; externalRefundIdOf: Map<string, string>; refunds: OrderRefundKey[] }> {
  const [links, refunds, parks] = await Promise.all([
    client.shoppingOrderLink.findMany({ where: { orderId, connector: 'woocommerce' }, select: { externalOrderId: true } }),
    // soft-delete exception (identity check): a deleted refund's credit note may still stand in Xero, and its refund id still names it.
    client.salesOrderRefund.findMany({ where: { orderId }, select: { id: true, externalRefundId: true, accountingCreditNoteId: true, statedGrossForeign: true, refundedAt: true, creditNoteNotDuplicate: true, deletedAt: true } }),
    client.shoppingSyncLog.findMany({ where: { entityId: orderId, recordKind: 'WC_REFUND_PARK', connector: 'woocommerce' }, select: { externalId: true } }),
  ])
  const liveCreditNoteRows = refunds.length === 0 ? [] : await client.accountingSyncLog.findMany({
    where: { type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: { in: refunds.map((refund) => refund.id) }, status: { not: 'CANCELLED' } },
    select: { referenceId: true },
  })
  const raised = new Set(liveCreditNoteRows.map((row) => row.referenceId))
  const imsCreditNotes = new Map<string, string>()
  const externalRefundIdOf = new Map<string, string>()
  const keyed: OrderRefundKey[] = []
  for (const refund of refunds) {
    if (refund.accountingCreditNoteId) imsCreditNotes.set(refund.accountingCreditNoteId, refund.id)
    if (refund.externalRefundId != null) externalRefundIdOf.set(refund.id, String(refund.externalRefundId))
    const gross = refund.statedGrossForeign == null ? NaN : Number(refund.statedGrossForeign.toString())
    keyed.push({
      id: refund.id,
      externalRefundId: refund.externalRefundId == null ? null : String(refund.externalRefundId),
      creditNoteId: refund.accountingCreditNoteId,
      grossCents: Number.isFinite(gross) ? Math.round(Math.abs(gross) * 100) : null,
      refundedOn: refund.refundedAt.toISOString().slice(0, 10),
      notDuplicateOf: readNotDuplicateAcks(refund.creditNoteNotDuplicate).map((ack) => ack.creditNoteId.trim().toLowerCase()),
      deleted: refund.deletedAt !== null,
      imsRaisesCreditNote: raised.has(refund.id),
    })
  }
  return {
    keys: {
      orderIds: links.map((link) => link.externalOrderId),
      // EVERY refund id of the order, older and newer than the one being decided: a hand-raised credit note may name any of them, and one naming another refund
      // is that refund's, never a duplicate of this one (but its cash is still counted).
      refundIds: [...externalRefundIdOf.values(), ...parks.map((park) => park.externalId ?? '').filter((id) => /^\d+$/.test(id))],
    },
    imsCreditNotes,
    externalRefundIdOf,
    refunds: keyed,
  }
}

/** The system switch (lib/domain/settings/system-switches.ts) for the check made before IMS CREATES a sales credit note. ON only for the exact string `true`. */
export const CREDIT_NOTE_DUPLICATE_CHECK_SETTING_KEY = 'xero_credit_note_duplicate_check_enabled'

/** Everything the duplicate test reads about the refund being decided and its order. */
export type DuplicateContext = {
  self: {
    refundId: string
    externalRefundId: string | null
    totalCents: number | null
    refundedOn: string | null
    creditNoteNumber: string | null
    /** #1127 R2 MED-3: this CREDIT_NOTE row was claimed before (attemptRevision > 1 or retryCount > 0), so a document under its number may be its own, landed. */
    earlierClaim?: boolean
    /** #1127 R2 MED-3: the Reference IMS puts on this credit note. */
    reference?: string | null
  }
  /** Every credit note id IMS recorded for the order's refunds, to its IMS refund id. */
  imsCreditNotes: ReadonlyMap<string, string>
  /** The order's IMS refunds (self included; it is skipped). */
  refunds: readonly OrderRefundKey[]
}

/**
 * IS THIS XERO CREDIT NOTE A DUPLICATE OF THE REFUND BEING DECIDED? (o3d-pnc8p note 1, #1127 R1 M4/M5/M6). Pure.
 *   'own'        IMS's: a credit note IMS recorded for one of the order's refunds, or one under the very number IMS minted for this refund (POST /CreditNotes is
 *                create-or-update on the number, so a re-post after a lost response converges on it; IMS's numbers are minted, never reused).
 *   'duplicate'  a live credit note IMS did not raise that credits THIS refund: it names this refund (its id, or `SC-<id>`), or it names only the order, credits
 *                exactly this refund's total, is not dated before this refund, and cannot belong to another refund of the order (no other refund without an IMS
 *                credit note credits the same total). An operator's "not a duplicate" acknowledgement for this refund and this credit note overrides it.
 *   'other'      anything else: a voided one, one naming another refund, an order-only one of another total or dated before this refund, or one another refund of
 *                the order could own. Its PAYMENTS are still cash out of the order.
 */
export function duplicateVerdict(cn: { creditNoteId: string; creditNoteNumber: string | null; reference?: string | null; status: string; total: number | null; date?: string | null; byRefund: readonly string[] }, ctx: DuplicateContext): 'own' | 'duplicate' | 'other' {
  if (isDeadCreditNote(cn.status)) return 'other'
  const id = cn.creditNoteId.trim().toLowerCase()
  if ([...ctx.imsCreditNotes.keys()].some((known) => known.trim().toLowerCase() === id)) return 'own'
  const ownNumber = ctx.self.creditNoteNumber?.trim().toLowerCase()
  if (ownNumber && cn.creditNoteNumber?.trim().toLowerCase() === ownNumber) {
    // #1127 R2 MED-3: IMS's own number converges only when the document can be IMS's own: this row was claimed before (a lost response), or the document carries
    // exactly what IMS would have sent (its total and its reference). Otherwise another system holds the number (an SC-<refund id> raised by Xeroom's store-credit
    // plugin before the cut-over): POST would overwrite it, so it is held.
    const sameContent = ctx.self.totalCents !== null && cn.total !== null && Math.round(cn.total * 100) === ctx.self.totalCents
      && (ctx.self.reference ?? null) !== null && (cn as { reference?: string | null }).reference?.trim() === ctx.self.reference?.trim()
    return ctx.self.earlierClaim === true || sameContent ? 'own' : 'duplicate'
  }
  const self = ctx.refunds.find((refund) => refund.id === ctx.self.refundId)
  if (self?.notDuplicateOf.includes(id)) return 'other'
  if (ctx.self.externalRefundId !== null && cn.byRefund.includes(ctx.self.externalRefundId)) return 'duplicate'
  if (cn.byRefund.length > 0) return 'other'
  if (ctx.self.totalCents === null || cn.total === null || Math.round(cn.total * 100) !== ctx.self.totalCents) return 'other'
  if (cn.date != null && ctx.self.refundedOn !== null && cn.date < ctx.self.refundedOn) return 'other'
  // #1127 R2 MED-4: another owner is a refund of the order that is not deleted and for which IMS will never raise a credit note of its own (a Xeroom-era refund,
  // or one with no live CREDIT_NOTE row): only such a refund's credit note can be in Xero without IMS having raised it.
  const anotherOwner = ctx.refunds.some((refund) => refund.id !== ctx.self.refundId && refund.deleted !== true && refund.creditNoteId === null && refund.imsRaisesCreditNote !== true
    && (refund.grossCents === null || refund.grossCents === ctx.self.totalCents))
  return anotherOwner ? 'other' : 'duplicate'
}

/** Before IMS creates a sales credit note: the live credit notes Xero already holds that credit this refund (see duplicateVerdict). Pure. */
export function creditNoteCreateDuplicates(creditNotes: readonly OrderCreditNoteRead[], ctx: DuplicateContext): OrderCreditNoteRead[] {
  return creditNotes.filter((cn) => duplicateVerdict(cn, ctx) === 'duplicate')
}

/**
 * The gross a credit note payload credits, in minor units (#1127 R1 M5): the refund's stated gross where IMS kept it; else the payload's own lines when they are
 * tax-inclusive; else its `orderTotal` (a full refund or a chargeback). Null when none of those can be read (the same-total test is then not made).
 */
export function creditNotePayloadGrossCents(payload: { lines?: unknown; lineAmountsIncludeTax?: unknown; orderTotal?: unknown }, statedGross: number | null): number | null {
  if (statedGross !== null && Number.isFinite(statedGross)) return Math.round(Math.abs(statedGross) * 100)
  if (payload.lineAmountsIncludeTax === true && Array.isArray(payload.lines)) {
    let cents = 0
    for (const line of payload.lines as Array<{ quantity?: unknown; unitAmount?: unknown }>) {
      const qty = Number(line?.quantity)
      const unit = Number(line?.unitAmount)
      if (!Number.isFinite(qty) || !Number.isFinite(unit)) return null
      cents += Math.round(qty * unit * 100)
    }
    return Math.abs(cents)
  }
  if (typeof payload.orderTotal === 'number' && Number.isFinite(payload.orderTotal)) return Math.round(Math.abs(payload.orderTotal) * 100)
  return null
}

/**
 * o3d-pnc8p #1127 R1 L10: IS THERE A SALES CREDIT NOTE UNDER THIS NUMBER IN XERO? Read only (one GET). For the operator acknowledgements that name the credit note
 * a refund was settled with. `found` carries the live (not voided or deleted) documents under the number.
 */
export async function lookupSalesCreditNoteByNumber(
  creditNoteNumber: string,
  deps: { get: Get } = { get: (path) => xeroGet(path) },
): Promise<{ ok: true; found: Array<{ creditNoteId: string; status: string; reference: string | null; total: number | null }> } | { ok: false; error: string }> {
  const wanted = creditNoteNumber.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,49}$/.test(wanted)) return { ok: false, error: `"${creditNoteNumber}" is not a credit note number IMS can look up` }
  let res: Awaited<ReturnType<Get>>
  try {
    res = await deps.get(`CreditNotes?where=${encodeURIComponent(`Type == "${XERO_SALES_CREDIT_NOTE_TYPE}" AND CreditNoteNumber == "${wanted}"`)}&page=1&pageSize=${PAGE_SIZE}`)
  } catch (error) {
    return { ok: false, error: `the credit-note lookup threw: ${String(error)}` }
  }
  if (!res.ok) return { ok: false, error: res.error ?? `the credit-note lookup failed with HTTP ${res.status}` }
  const rows = (res.data as { CreditNotes?: unknown[] } | undefined)?.CreditNotes
  if (!Array.isArray(rows)) return { ok: false, error: 'the credit-note lookup returned no CreditNotes list' }
  const found = rows
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .filter((row) => typeof row.CreditNoteNumber === 'string' && row.CreditNoteNumber.trim().toLowerCase() === wanted.toLowerCase() && typeof row.CreditNoteID === 'string')
    .map((row) => ({ creditNoteId: row.CreditNoteID as string, status: typeof row.Status === 'string' ? row.Status.toUpperCase() : 'UNKNOWN', reference: typeof row.Reference === 'string' ? row.Reference : null, total: typeof row.Total === 'number' ? row.Total : null }))
    .filter((row) => !isDeadCreditNote(row.status))
  return { ok: true, found }
}

/** #1127 R2 L4: does a credit note found by number belong to this order or refund (its number or reference names the order id or one of the refund ids)? Pure. */
export function creditNoteBelongsTo(found: { creditNoteId: string; creditNoteNumber: string; reference: string | null }, keys: OrderCreditNoteKeys): boolean {
  return matchOrderCreditNote({ CreditNoteID: found.creditNoteId, CreditNoteNumber: found.creditNoteNumber, Reference: found.reference }, keys) !== null
}
