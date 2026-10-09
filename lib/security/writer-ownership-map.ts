/**
 * WHO WRITES WHAT, PER DESTINATION AND OPERATION, PER PHASE. DECLARATIVE AND SINGLE-SOURCED.
 *
 * IMS shares each destination (Xero, Mintsoft, WooCommerce) with incumbent writers until the live
 * phase. This table is the one place that says, for every operation IMS can produce, which writer owns
 * it in each phase:
 *
 *   P0  before anything is built: IMS owns nothing.
 *   P1  IMS is built but held: it records shadows; the incumbent writes.
 *   P2  IMS is live for the operations it owns; the others stay with their owner.
 *
 * `producerDisposition` (producer-disposition.ts) is the only reader that decides anything: it returns
 * LIVE only for an operation whose owner in the installation's phase is IMS. Every other owner,
 * including `unknown`, resolves to SHADOW. `unknown` means exactly that nobody has established the
 * owner yet; it is a decision to be made, not a default, and it can never be LIVE.
 *
 * Sources: the producer-side hold plan (inventory of producers and incumbents) and the owner decisions
 * of 2026-10-08. A row's `note` says which answer settled it or why it is `unknown`.
 */

import type { OutboundConnector } from './outbound-write-hold-constants'

export const WRITER_OWNERS = [
  'IMS',
  'xeroom',
  'o3d-ioss-xero',
  'woo-mintsoft-plugin',
  'mintsoft-native',
  'nobody',
  'unknown',
] as const
export type WriterOwner = (typeof WRITER_OWNERS)[number]

/** Destinations that exist in the map. `customer-email` is mapped only: it is not a connector and has no grant. */
export type MappedDestination = OutboundConnector | 'customer-email'

export type PhaseOwners = { P0: WriterOwner; P1: WriterOwner; P2: WriterOwner }

export type OwnershipRow = {
  destination: MappedDestination
  operation: string
  owners: PhaseOwners
  /** Whether a producer must pass the business-event time of its work (see `producerDisposition`). */
  obligationTime: 'required' | 'not-applicable'
  /** AccountingSyncType members whose queued rows are this operation. */
  accountingSyncTypes?: readonly string[]
  /** `<connector>/<operation>` names in INTEGRATION_OUTBOX_REGISTRY that carry this operation. */
  outboxOperations?: readonly string[]
  note: string
}

const NOBODY_YET = 'nobody' as const

function row<const D extends MappedDestination, const O extends string>(
  destination: D,
  operation: O,
  owners: Omit<PhaseOwners, 'P0'>,
  rest: Omit<OwnershipRow, 'destination' | 'operation' | 'owners'>,
): { destination: D; operation: O; owners: PhaseOwners } & Omit<OwnershipRow, 'destination' | 'operation' | 'owners'> {
  return { destination, operation, owners: { P0: NOBODY_YET, ...owners }, ...rest }
}

export const WRITER_OWNERSHIP_MAP = [
  // ---- Xero: sales (the incumbent keeps SALES invoicing; IMS shadows it in every phase) ----------
  row('xero', 'sales.invoice', { P1: 'xeroom', P2: 'xeroom' }, {
    obligationTime: 'required',
    accountingSyncTypes: ['SALES_INVOICE'],
    note: 'Xeroom posts sales invoices; o3d-ioss-xero only filters Xeroom\'s payloads, so it stays with Xeroom. IMS shadows for ever.',
  }),
  row('xero', 'sales.invoice-update', { P1: 'xeroom', P2: 'xeroom' }, {
    obligationTime: 'required',
    accountingSyncTypes: ['SALES_INVOICE_UPDATE'],
    note: 'As sales.invoice.',
  }),
  row('xero', 'sales.credit-note', { P1: 'xeroom', P2: 'xeroom' }, {
    obligationTime: 'required',
    accountingSyncTypes: ['CREDIT_NOTE'],
    note: 'As sales.invoice.',
  }),
  row('xero', 'sales.payment', { P1: 'nobody', P2: 'IMS' }, {
    obligationTime: 'required',
    accountingSyncTypes: ['INVOICE_PAYMENT'],
    note: 'Owner answer 5: payment postings are disabled in Xeroom (payments are only logged in Xero at bank reconciliation), so there is no incumbent; shadow in P1, IMS owns from P2, matching by payment system and currency.',
  }),
  // ---- Xero: purchasing, inventory, daily batches ---------------------------------------------------
  row('xero', 'purchase.bill', { P1: 'unknown', P2: 'IMS' }, {
    obligationTime: 'required',
    accountingSyncTypes: ['PURCHASE_INVOICE', 'PURCHASE_INVOICE_UPDATE'],
    note: 'P1 owner unknown: whether Qoblex writes bills into Xero is unverified.',
  }),
  row('xero', 'purchase.bill-payment', { P1: 'unknown', P2: 'IMS' }, {
    obligationTime: 'required',
    accountingSyncTypes: ['BILL_PAYMENT'],
    note: 'P1 owner unknown (as purchase.bill).',
  }),
  row('xero', 'purchase.bill-attachment', { P1: 'unknown', P2: 'IMS' }, {
    obligationTime: 'required',
    accountingSyncTypes: ['BILL_ATTACHMENT'],
    note: 'P1 owner unknown (as purchase.bill).',
  }),
  row('xero', 'purchase.supplier-credit', { P1: 'unknown', P2: 'IMS' }, {
    obligationTime: 'required',
    accountingSyncTypes: ['PURCHASE_CREDIT_NOTE', 'PURCHASE_CREDIT_NOTE_ALLOCATION'],
    note: 'P1 owner unknown (as purchase.bill).',
  }),
  row('xero', 'inventory.journals', { P1: 'unknown', P2: 'IMS' }, {
    obligationTime: 'required',
    accountingSyncTypes: [
      'STOCK_RECEIPT', 'INVENTORY_ADJUSTMENT', 'COGS_JOURNAL', 'COGS_REVERSAL', 'STOCK_IN_TRANSIT', 'STOCK_ALLOCATION',
      'UNEARNED_REV_REVERSAL', 'ALLOCATION_REVERSAL', 'MANUFACTURING_JOURNAL', 'MANUFACTURING_RECLASS',
    ],
    note: 'P1 owner unknown: Qoblex\'s Xero write set is unverified.',
  }),
  row('xero', 'daily-batch', { P1: 'unknown', P2: 'IMS' }, {
    obligationTime: 'required',
    accountingSyncTypes: [
      'DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B',
      'DAILY_BATCH_INVENTORY_RECONCILIATION', 'DAILY_BATCH_COGS_RECONCILIATION', 'DAILY_BATCH_TRANSIT_RECONCILIATION',
    ],
    note: 'P1 owner unknown (as inventory.journals). The obligation time is the batch date. Whether IMS\'s batches are correct on top of invoices posted by Xeroom is an open accountant question.',
  }),
  row('xero', 'tax-rate', { P1: 'unknown', P2: 'unknown' }, {
    obligationTime: 'not-applicable',
    accountingSyncTypes: ['TAX_RATE_SYNC'],
    note: 'Unresolved: the recommendation is that an operator maintains tax rates by hand, which is not an owner IMS may be replaced by; until decided IMS shadows.',
  }),
  row('xero', 'fx-journal', { P1: 'nobody', P2: 'nobody' }, {
    obligationTime: 'not-applicable',
    accountingSyncTypes: ['REALISED_FX_JOURNAL', 'UNREALISED_FX_JOURNAL'],
    note: 'Never produced for Xero (suppressed).',
  }),
  row('xero', 'demo-provisioning', { P1: 'nobody', P2: 'nobody' }, {
    obligationTime: 'not-applicable',
    note: 'A manual script against a demo tenant; the tenant grant is its only barrier.',
  }),
  // ---- Mintsoft -----------------------------------------------------------------------------------------
  row('mintsoft', 'order.create', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    obligationTime: 'required',
    note: 'IMS creates only orders paid from the live-from instant; it never creates an order the bridge created (the obligation time is the paid time).',
  }),
  row('mintsoft', 'order.amend', { P1: 'woo-mintsoft-plugin', P2: 'unknown' }, {
    obligationTime: 'required',
    note: 'Unresolved: whether IMS may amend an order the bridge created (decision D8 settles cancel and hold only). Unknown resolves to SHADOW until decided.',
  }),
  row('mintsoft', 'order.cancel', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    note: 'Decision D8: IMS owns cancel for orders imported from the bridge once the plugin is gone, so no obligation time is passed.',
  }),
  row('mintsoft', 'order.hold', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    note: 'As order.cancel (D8).',
  }),
  row('mintsoft', 'order.comment', { P1: 'unknown', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    note: 'P1 owner unknown.',
  }),
  row('mintsoft', 'product.upsert', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    note: 'Owner answer 3: product content is authored in WooCommerce and flows Woo -> IMS -> Mintsoft; the plugin\'s Python product sync is retired at P2.',
  }),
  row('mintsoft', 'product.bundle', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    note: 'As product.upsert.',
  }),
  row('mintsoft', 'asn.create', { P1: 'unknown', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    note: 'P1 owner unknown: Qoblex or an operator in Mintsoft\'s own screens.',
  }),
  row('mintsoft', 'auth.login', { P1: 'nobody', P2: 'nobody' }, {
    obligationTime: 'not-applicable',
    note: 'Key minting is not a business write; the login grant of the transport hold governs it and the producer hold is never consulted for it.',
  }),
  // ---- WooCommerce ----------------------------------------------------------------------------------------
  row('woocommerce', 'stock', { P1: 'unknown', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    outboxOperations: ['woocommerce/stock.push'],
    note: 'P1 owner unknown: the bridge, Qoblex or Mintsoft\'s native channel. An absolute state push, so no obligation time.',
  }),
  row('woocommerce', 'product.meta', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    note: 'Owner answer 3: the plugin owns product meta pushes in P1, IMS in P2.',
  }),
  row('woocommerce', 'order.status', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    obligationTime: 'required',
    outboxOperations: ['woocommerce/order.complete', 'woocommerce/order.cancel', 'woocommerce/order.hold'],
    note: 'The plugin\'s /order/{id}/status route. The obligation time is the status change time.',
  }),
  row('woocommerce', 'order.tracking', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    obligationTime: 'required',
    note: 'The plugin\'s /order/{id}/tracking route.',
  }),
  row('woocommerce', 'order.partial-shipment', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    obligationTime: 'required',
    note: 'The plugin\'s /status route with partial_shipment data.',
  }),
  row('woocommerce', 'order.withdrawal-outcome', { P1: 'woo-mintsoft-plugin', P2: 'woo-mintsoft-plugin' }, {
    obligationTime: 'not-applicable',
    note: 'Owner answer 6: the endpoint stays in the WooCommerce plugin; IMS exposes an authenticated receiving API that the plugin calls. Not an IMS outbound write, so IMS shadows if it is ever asked.',
  }),
  row('woocommerce', 'order.trackship-reconcile', { P1: 'woo-mintsoft-plugin', P2: 'woo-mintsoft-plugin' }, {
    obligationTime: 'not-applicable',
    note: 'Owner answer 6: as order.withdrawal-outcome.',
  }),
  row('woocommerce', 'order.wms-status-meta', { P1: 'nobody', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    note: 'IMS-only metadata on the order.',
  }),
  row('woocommerce', 'order.invoice-note', { P1: 'xeroom', P2: 'IMS' }, {
    obligationTime: 'required',
    accountingSyncTypes: ['WC_INVOICE_NOTE'],
    note: 'Owner answer 4: Xeroom writes the note today; IMS replaces it at P2. The destination of this queued type is WooCommerce, not Xero.',
  }),
  row('woocommerce', 'order.invoice-document', { P1: 'xeroom', P2: 'IMS' }, {
    obligationTime: 'required',
    note: 'Owner answer 4: IMS puts the one invoice (generated in Xero) into the customer\'s My Account, replacing what Xeroom and the PDF-invoices plugin do today.',
  }),
  row('woocommerce', 'fx-rates', { P1: 'unknown', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    note: 'P1 owner unknown.',
  }),
  row('woocommerce', 'webhooks', { P1: 'nobody', P2: 'IMS' }, {
    obligationTime: 'not-applicable',
    note: 'No webhooks are registered on the live store in P1; an operator registers them through IMS at P2.',
  }),
  // ---- Customer e-mail: mapped only (decision D7); enforcement stays the existing settings ---------------------
  row('customer-email', 'despatch', { P1: 'unknown', P2: 'unknown' }, {
    obligationTime: 'not-applicable',
    note: 'Mapped only. Would duplicate the WooCommerce despatch e-mail; enforced by its existing setting, not by the producer hold.',
  }),
  row('customer-email', 'order-confirmation', { P1: 'unknown', P2: 'unknown' }, {
    obligationTime: 'not-applicable',
    note: 'Mapped only (as despatch).',
  }),
  row('customer-email', 'invoice', { P1: 'unknown', P2: 'unknown' }, {
    obligationTime: 'not-applicable',
    note: 'Mapped only (as despatch).',
  }),
] as const satisfies readonly OwnershipRow[]

export type OwnershipEntry = (typeof WRITER_OWNERSHIP_MAP)[number]

/** The operations of one connector destination, as a union tsc checks: an unmapped pair does not compile. */
export type MappedOperation<D extends MappedDestination> = Extract<OwnershipEntry, { destination: D }>['operation']

/** `<destination>.<operation>` -> row. Built once; the map is constant. */
const BY_KEY: ReadonlyMap<string, OwnershipRow> = new Map(
  WRITER_OWNERSHIP_MAP.map((entry) => [`${entry.destination}.${entry.operation}`, entry as OwnershipRow]),
)

/** Captured at load: a later patch of Map.prototype.get cannot forge a row. */
const mapGet = Map.prototype.get

export function ownershipRowFor(destination: string, operation: string): OwnershipRow | null {
  if (typeof destination !== 'string' || typeof operation !== 'string') return null
  return (mapGet.call(BY_KEY, `${destination}.${operation}`) as OwnershipRow | undefined) ?? null
}

/**
 * AccountingSyncType members that are not outbound writes to a destination, with the reason. Shrink-only:
 * a new member must be mapped in a row above, never added here without an owner's reason.
 */
export const ACCOUNTING_SYNC_TYPE_EXCLUSIONS: Readonly<Record<string, string>> = {
  INVOICE_PDF: 'A GET of the invoice PDF from Xero: not a write.',
  INVOICE_EMAIL: 'Goes to the local e-mail queue: not a destination write (customer-email is mapped only).',
}

/**
 * Integration outbox operations that are not an outbound write to a destination, with the reason.
 * `xero/accounting.post` is not here: it carries every Xero row, so it is claimed by the xero rows through
 * `ACCOUNTING_POST_OUTBOX_OPERATION` below. Shrink-only.
 */
export const OUTBOX_OPERATION_EXCLUSIONS: Readonly<Record<string, string>> = {
  'mintsoft/inbound.booked-in': 'Inbound processing of a Mintsoft webhook: its effects are IMS ledger rows, which reach Xero through the sync log.',
  'accounting/landed-cost.adjustment-journal': 'Internal: its effect is a sync-log row, which meets the Xero rows above.',
  'accounting/posting-refusal.provisional': 'Internal bookkeeping of a refused posting: no destination write.',
  'sales/refund.reservation-release': 'Internal: releases a stock reservation.',
  'sales/refund.unmatched-warning': 'Internal: raises an operator warning.',
}

/** The one Xero outbox operation; each Xero row's `accountingSyncTypes` say what it carries. */
export const ACCOUNTING_POST_OUTBOX_OPERATION = 'xero/accounting.post'

/** Whether the map names this outbox operation for some row, directly or as the Xero carrier. */
export function outboxOperationIsMapped(name: string): boolean {
  if (name === ACCOUNTING_POST_OUTBOX_OPERATION) return true
  return WRITER_OWNERSHIP_MAP.some((entry) => (entry as OwnershipRow).outboxOperations?.includes(name) === true)
}
