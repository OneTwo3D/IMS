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
 * including `unknown`, `operator-manual`, `qoblex-native`, `aelia` and `woocommerce-native`, resolves to SHADOW. `unknown` means exactly that nobody has established the
 * owner yet; it is a decision to be made, not a default, and it can never be LIVE.
 *
 * Sources: the producer-side hold plan (inventory of producers and incumbents) and the owner decisions
 * of 2026-10-08 and 2026-10-09. A row's `note` says which answer settled it or why it is `unknown`.
 */

import type { OutboundConnector } from './outbound-write-hold-constants'

export const WRITER_OWNERS = [
  'IMS',
  'xeroom',
  'o3d-ioss-xero',
  'woo-mintsoft-plugin',
  'mintsoft-native',
  /** A person doing it by hand in the destination's own screens (no automation anywhere). */
  'operator-manual',
  /** Qoblex's own integration with the destination (Xero journals and bills, the WooCommerce stock push). */
  'qoblex-native',
  /** The Aelia currency switcher plugin on the WooCommerce store. */
  'aelia',
  /** WooCommerce itself (its own customer e-mails). */
  'woocommerce-native',
  'nobody',
  'unknown',
] as const
export type WriterOwner = (typeof WRITER_OWNERS)[number]

/** Destinations that exist in the map. `customer-email` is mapped only: it is not a connector and has no grant. */
export type MappedDestination = OutboundConnector | 'customer-email'

/**
 * THE SWITCHOVER STEP THAT RETIRES THE INCUMBENT OF A ROW, AND THEREFORE MOVES ITS OWNER TO IMS (design: o3d-zvec.3, one writer retired as a unit).
 *
 *   mintsoft     step M: the bridge (its order sweep, webhook service and plugin) stops. Every row the bridge owns moves to IMS with it,
 *                including the WooCommerce rows it wrote (status, tracking, partial shipments, product meta, withdrawal outcome, TrackShip).
 *   woocommerce  step W: WooCommerce stock, webhooks and the customer e-mail that WooCommerce sends natively.
 *   xero         step X: Qoblex's native Xero posting and Xeroom's WooCommerce invoice note.
 *   never        no step moves this row to IMS: another writer keeps it in every phase (or nobody writes it, or the operator does).
 *
 * The producer decision reads the live-from instant of the ROW'S step (PRODUCER_CUTOFF_ENV[step]), not of its destination.
 */
export const WRITER_STEPS = ['mintsoft', 'woocommerce', 'xero', 'never'] as const
export type WriterStep = (typeof WRITER_STEPS)[number]

export type PhaseOwners = { P0: WriterOwner; P1: WriterOwner; P2: WriterOwner }

export type OwnershipRow = {
  destination: MappedDestination
  operation: string
  owners: PhaseOwners
  /** The switchover step that moves this row's owner from its P1 owner to its P2 owner. */
  step: WriterStep
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
    step: 'never',
    obligationTime: 'required',
    accountingSyncTypes: ['SALES_INVOICE'],
    note: 'Xeroom posts sales invoices; o3d-ioss-xero only filters Xeroom\'s payloads, so it stays with Xeroom. IMS shadows for ever.',
  }),
  row('xero', 'sales.invoice-update', { P1: 'xeroom', P2: 'xeroom' }, {
    step: 'never',
    obligationTime: 'required',
    accountingSyncTypes: ['SALES_INVOICE_UPDATE'],
    note: 'As sales.invoice.',
  }),
  row('xero', 'sales.invoice-delete', { P1: 'xeroom', P2: 'xeroom' }, {
    step: 'never',
    obligationTime: 'required',
    accountingSyncTypes: ['SALES_INVOICE_DELETE'],
    note: 'As sales.invoice: the writer that owns a sales invoice owns its removal, so IMS shadows the delete too (and the document-delete action refuses an invoice IMS did not itself create).',
  }),
  row('xero', 'sales.credit-note', { P1: 'xeroom', P2: 'xeroom' }, {
    step: 'never',
    obligationTime: 'required',
    accountingSyncTypes: ['CREDIT_NOTE'],
    note: 'As sales.invoice.',
  }),
  row('xero', 'sales.credit-note-void', { P1: 'xeroom', P2: 'xeroom' }, {
    step: 'never',
    obligationTime: 'required',
    accountingSyncTypes: ['CREDIT_NOTE_VOID'],
    note: 'o3d-ngmt.22: voiding the credit note of a refund deleted in IMS. As sales.credit-note: Xeroom owns sales credit notes, so IMS shadows the void in P1 and P2 like the document it undoes.',
  }),
  row('xero', 'sales.credit-note-allocation', { P1: 'xeroom', P2: 'xeroom' }, {
    step: 'never',
    obligationTime: 'required',
    accountingSyncTypes: ['CREDIT_NOTE_ALLOCATION'],
    note: 'o3d-hqvrp.39: settling a sales credit note (allocating it to its invoice, or paying it out as a refund against it). As sales.credit-note: Xeroom owns sales credit notes in P1 and P2, so IMS shadows the settlement of a credit note it does not own; the producer hold and the claim-boundary seam govern it exactly like the credit note. Dated from the credit note.',
  }),
  row('xero', 'sales.payment', { P1: 'nobody', P2: 'IMS' }, {
    step: 'xero',
    obligationTime: 'required',
    accountingSyncTypes: ['INVOICE_PAYMENT'],
    note: 'Owner answer 5: payment postings are disabled in Xeroom (payments are only logged in Xero at bank reconciliation), so there is no incumbent; shadow in P1, IMS owns from P2, matching by payment system and currency.',
  }),
  // ---- Xero: purchasing, inventory, daily batches ---------------------------------------------------
  row('xero', 'purchase.bill', { P1: 'qoblex-native', P2: 'IMS' }, {
    step: 'xero',
    obligationTime: 'required',
    accountingSyncTypes: ['PURCHASE_INVOICE', 'PURCHASE_INVOICE_UPDATE'],
    note: 'Owner answer 2026-10-09: Qoblex writes bills into Xero natively (its own Xero integration) today; IMS owns from P2.',
  }),
  row('xero', 'purchase.bill-delete', { P1: 'qoblex-native', P2: 'IMS' }, {
    step: 'xero',
    obligationTime: 'required',
    accountingSyncTypes: ['PURCHASE_INVOICE_DELETE'],
    note: 'As purchase.bill: whoever writes the bill writes its removal (o3d-ngmt.21); IMS owns it from P2.',
  }),
  row('xero', 'purchase.bill-payment', { P1: 'qoblex-native', P2: 'IMS' }, {
    step: 'xero',
    obligationTime: 'required',
    accountingSyncTypes: ['BILL_PAYMENT'],
    note: 'Owner answer 2026-10-09: as purchase.bill (native Qoblex in P1).',
  }),
  row('xero', 'purchase.bill-attachment', { P1: 'qoblex-native', P2: 'IMS' }, {
    step: 'xero',
    obligationTime: 'required',
    accountingSyncTypes: ['BILL_ATTACHMENT'],
    note: 'Owner answer 2026-10-09: as purchase.bill (native Qoblex in P1).',
  }),
  row('xero', 'purchase.supplier-credit', { P1: 'qoblex-native', P2: 'IMS' }, {
    step: 'xero',
    obligationTime: 'required',
    accountingSyncTypes: ['PURCHASE_CREDIT_NOTE', 'PURCHASE_CREDIT_NOTE_ALLOCATION'],
    note: 'Owner answer 2026-10-09: as purchase.bill (native Qoblex in P1).',
  }),
  row('xero', 'inventory.journals', { P1: 'qoblex-native', P2: 'IMS' }, {
    step: 'xero',
    obligationTime: 'required',
    accountingSyncTypes: [
      'STOCK_RECEIPT', 'INVENTORY_ADJUSTMENT', 'COGS_JOURNAL', 'COGS_REVERSAL', 'STOCK_IN_TRANSIT', 'STOCK_ALLOCATION',
      'UNEARNED_REV_REVERSAL', 'ALLOCATION_REVERSAL', 'MANUFACTURING_JOURNAL', 'MANUFACTURING_RECLASS',
    ],
    note: 'Owner answer 2026-10-09: Qoblex posts these journals natively in Xero today; IMS owns from P2.',
  }),
  row('xero', 'daily-batch', { P1: 'qoblex-native', P2: 'IMS' }, {
    step: 'xero',
    obligationTime: 'required',
    accountingSyncTypes: [
      'DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B',
      'DAILY_BATCH_INVENTORY_RECONCILIATION', 'DAILY_BATCH_COGS_RECONCILIATION', 'DAILY_BATCH_TRANSIT_RECONCILIATION',
      'DAILY_BATCH_GRIR_RECLASS',
    ],
    note: 'Owner answer 2026-10-09: Qoblex does the daily batches natively in Xero today; IMS owns from P2. The obligation time is the batch date. Whether IMS\'s batches are correct on top of invoices posted by Xeroom is an open accountant question.',
  }),
  row('xero', 'tax-rate', { P1: 'operator-manual', P2: 'nobody' }, {
    step: 'never',
    obligationTime: 'not-applicable',
    accountingSyncTypes: ['TAX_RATE_SYNC'],
    note: 'Owner answer 2026-10-09: Xero is the MASTER for tax rates. P1: an operator maintains them by hand in Xero. P2: no component writes tax rates to Xero; IMS only reads them and syncs onward, so nobody is the writer and IMS shadows if asked. The IMS write path (generateMissingXeroTaxRates / provisioning) stays declared in the producer census until it is retired; its behaviour is unchanged here.',
  }),
  row('xero', 'fx-journal', { P1: 'nobody', P2: 'nobody' }, {
    step: 'never',
    obligationTime: 'not-applicable',
    accountingSyncTypes: ['REALISED_FX_JOURNAL', 'UNREALISED_FX_JOURNAL'],
    note: 'Never produced for Xero (suppressed).',
  }),
  row('xero', 'demo-provisioning', { P1: 'nobody', P2: 'nobody' }, {
    step: 'never',
    obligationTime: 'not-applicable',
    note: 'A manual script against a demo tenant; the tenant grant is its only barrier.',
  }),
  // ---- Mintsoft -----------------------------------------------------------------------------------------
  row('mintsoft', 'order.create', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'required',
    note: 'IMS creates only orders paid from the live-from instant; it never creates an order the bridge created (the obligation time is the paid time).',
  }),
  row('mintsoft', 'order.amend', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'required',
    note: 'Owner answer 2026-10-09: IMS amends orders in P2, including ones the bridge created (decision D8 separately settles cancel and hold). The obligation time is the time of the CHANGE being propagated (the order\'s updatedAt, which is what makes the link due), never the paid time: the paid-time cut-off belongs to order.create alone.',
  }),
  row('mintsoft', 'order.cancel', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'Decision D8: IMS owns cancel for orders imported from the bridge once the plugin is gone, so no obligation time is passed.',
  }),
  row('mintsoft', 'order.hold', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'As order.cancel (D8). Owner answer Q9 (2026-11-18): the merge-candidate hold passes from the Python sync to IMS at step M, gated on zero open merge holds (no state import); the merge-candidate FLAG is IMS-local (it writes nothing to a destination), so it has no row.',
  }),
  row('mintsoft', 'order.comment', { P1: 'operator-manual', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'Owner answer 2026-10-09: order comments are added by hand in Mintsoft today, no automation. Owner answer Q8 (2026-11-18): IMS owns them from step M, not at the master switch.',
  }),
  row('mintsoft', 'product.upsert', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'Owner answer 3: product content is authored in WooCommerce and flows Woo -> IMS -> Mintsoft; the plugin\'s Python product sync is retired at P2.',
  }),
  row('mintsoft', 'product.content', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'Owner answer 3: description, short description and pictures are authored in WooCommerce and flow Woo -> IMS -> Mintsoft (IMS is the hub). Distinct from product.upsert, which is product META. Whether the bridge pushes descriptions today is unverified, so P1 is treated as plugin-owned and IMS shadows. An absolute state push of changed fields, so no obligation time.',
  }),
  row('mintsoft', 'product.delete', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'The plugin\'s Python sync deletes a variable product\'s parent SKU in Mintsoft once every variation is confirmed there (o3d-zvec.20). Destructive, so IMS does it only behind its own setting (default off), only on proof from the stored product links, and refuses rather than deletes when unsure.',
  }),
  row('mintsoft', 'product.bundle', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'As product.upsert.',
  }),
  row('mintsoft', 'asn.create', { P1: 'operator-manual', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'Owner answer 2026-10-09: ASNs are created by hand in Mintsoft today, no automation. Owner answer Q8 (2026-11-18): IMS owns them from step M; if IMS ASN creation does not work, the fallback is manual creation.',
  }),
  row('mintsoft', 'supplier.create', { P1: 'operator-manual', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'Owner 2026-11-19: Mintsoft suppliers are needed on every ASN and most already exist there with minimal details, so IMS maps to them first and creates only when an operator chooses "create in Mintsoft" on the supplier mapping screen. Suppliers are created by hand in Mintsoft today; IMS owns the create from step M, behind mintsoft_supplier_create_enabled (default off; off records the choice as pending and sends nothing). Create-only: IMS never updates an existing Mintsoft supplier.',
  }),
  row('mintsoft', 'auth.login', { P1: 'nobody', P2: 'nobody' }, {
    step: 'never',
    obligationTime: 'not-applicable',
    note: 'Key minting is not a business write; the login grant of the transport hold governs it and the producer hold is never consulted for it.',
  }),
  // ---- WooCommerce ----------------------------------------------------------------------------------------
  row('woocommerce', 'stock', { P1: 'qoblex-native', P2: 'IMS' }, {
    step: 'woocommerce',
    obligationTime: 'not-applicable',
    outboxOperations: ['woocommerce/stock.push'],
    note: 'Owner answer 2026-10-09: Qoblex pushes stock to WooCommerce today; IMS owns from P2. An absolute state push, so no obligation time.',
  }),
  row('woocommerce', 'product.meta', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'Owner answer 3: the plugin owns product meta pushes in P1. Owner answer Q10 (2026-11-18): IMS owns them from step M, because the bridge\'s webhook service that pushes them is retired there.',
  }),
  row('woocommerce', 'order.status', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'required',
    outboxOperations: ['woocommerce/order.complete', 'woocommerce/order.cancel', 'woocommerce/order.hold'],
    note: 'The plugin\'s /order/{id}/status route. The obligation time is the status change time.',
  }),
  row('woocommerce', 'order.tracking', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'required',
    note: 'The plugin\'s /order/{id}/tracking route.',
  }),
  row('woocommerce', 'order.partial-shipment', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'required',
    note: 'The plugin\'s /status route with partial_shipment data.',
  }),
  row('woocommerce', 'order.withdrawal-outcome', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'Owner decision 2026-11-18 (1): in step M IMS takes the withdrawal outcome over from the bridge, which is fully disabled then. The IMS writer is built (lib/connectors/woocommerce/sync/withdrawal-outcome.ts, the companion plugin\'s /order/{id}/withdrawal-outcome route, 1.5.0) behind the setting wc_withdrawal_outcome_enabled (default off); it is held until step M is live.',
  }),
  row('woocommerce', 'order.trackship-reconcile', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'Owner decision 2026-11-18 (1): the bridge\'s TrackShip reconcile is taken over at step M; it is the same work as trackship-refire and is driven by the same setting (trackship_refire_enabled).',
  }),
  row('woocommerce', 'order.trackship-refire', { P1: 'woo-mintsoft-plugin', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    outboxOperations: ['woocommerce/trackship.refire'],
    note: 'Step M (owner 2026-11-18). Owner decision D10: customer-facing tracking stays with WooCommerce, AST and TrackShip; IMS stores tracking and, when TrackShip holds no shipment for a shipped order, asks the storefront to fire TrackShip\'s own trigger again, as the plugin\'s Python sweep did through /trackship/reconcile (that route above stays the plugin\'s, and is what runs in P1). P1: the plugin\'s sweep does it, so IMS shadows. P2: IMS does it through the companion plugin\'s /order/{id}/trackship-refire route, behind the setting trackship_refire_enabled (default off). A repeat of the same order\'s look is harmless (TrackShip upserts), so no obligation time.',
  }),
  row('woocommerce', 'order.wms-status-meta', { P1: 'nobody', P2: 'IMS' }, {
    step: 'mintsoft',
    obligationTime: 'not-applicable',
    note: 'IMS-only metadata on the order.',
  }),
  row('woocommerce', 'order.invoice-note', { P1: 'xeroom', P2: 'IMS' }, {
    step: 'xero',
    obligationTime: 'required',
    accountingSyncTypes: ['WC_INVOICE_NOTE'],
    note: 'Owner answer 4: Xeroom writes the note today; IMS replaces it at P2. The destination of this queued type is WooCommerce, not Xero.',
  }),
  row('woocommerce', 'order.invoice-document', { P1: 'xeroom', P2: 'IMS' }, {
    step: 'xero',
    obligationTime: 'required',
    outboxOperations: ['woocommerce/order.invoice-document'],
    note: 'Owner answer 4: IMS puts the one invoice (generated in Xero) into the customer\'s My Account, replacing what Xeroom and the PDF-invoices plugin do today.',
  }),
  row('woocommerce', 'fx-rates', { P1: 'aelia', P2: 'aelia' }, {
    step: 'never',
    obligationTime: 'not-applicable',
    note: 'Owner ruling 2026-10-26 (replaces the 2026-10-09 answer): Aelia, the currency switcher on the store, is the exchange-rate master in P1 AND P2, and IMS only reads its pre-markup rates into fx_rates (FX source setting `fx_rate_source` = aelia). IMS never writes Aelia\'s rates; the IMS to WooCommerce rate push is disabled while that source is on.',
  }),
  row('woocommerce', 'webhooks', { P1: 'nobody', P2: 'IMS' }, {
    step: 'woocommerce',
    obligationTime: 'not-applicable',
    note: 'No webhooks are registered on the live store in P1; an operator registers them through IMS at P2.',
  }),
  row('woocommerce', 'tax-rate', { P1: 'operator-manual', P2: 'operator-manual' }, {
    step: 'never',
    obligationTime: 'not-applicable',
    note: 'Owner answer Q5 (2026-11-18): stays with the operator in P2 until its writer is built; the map will give it to IMS then. Owner ruling 2026-10-25: WooCommerce, IMS and Xero use the SAME set of VAT rates and Xero is the master. In P1 and P2 the owner maintains WooCommerce tax rates by hand, guided by the read-only VAT difference report (`npm run vat:diff`); the IMS writer (`npm run woo:tax-plan`, lib/connectors/woocommerce/tax-rate-writer.ts) is built but held: it records shadows and sends nothing. It only ever touches rates mapped in ShoppingTaxRateMapping or recorded as created by it; rates IMS does not own are never touched.',
  }),
  // ---- Customer e-mail: mapped only (decision D7); enforcement stays the existing settings ---------------------
  row('customer-email', 'despatch', { P1: 'woocommerce-native', P2: 'IMS' }, {
    step: 'woocommerce',
    obligationTime: 'not-applicable',
    note: 'Mapped only. Owner answers 2026-10-09: WooCommerce sends the despatch e-mail today (P1); long term every customer e-mail comes from IMS (P2); owner answer Q4 (2026-11-18): it moves at step W (WooCommerce native off first, then IMS on). Enforced by its existing setting, not by the producer hold.',
  }),
  row('customer-email', 'order-confirmation', { P1: 'woocommerce-native', P2: 'IMS' }, {
    step: 'woocommerce',
    obligationTime: 'not-applicable',
    note: 'Mapped only (as despatch): WooCommerce in P1, IMS in P2 (owner answers 2026-10-09).',
  }),
  row('customer-email', 'invoice', { P1: 'woocommerce-native', P2: 'IMS' }, {
    step: 'woocommerce',
    obligationTime: 'not-applicable',
    note: 'Mapped only (as despatch): WooCommerce in P1, IMS in P2 (owner answers 2026-10-09).',
  }),
  row('customer-email', 'quote', { P1: 'IMS', P2: 'IMS' }, {
    step: 'never',
    obligationTime: 'not-applicable',
    note: 'Mapped only. A sales quotation exists only in IMS (the storefront has no quote), so IMS is the sender in P1 and P2: customer e-mail comes from IMS. Enforced by its own setting `sales_quote_email_enabled` (default off), read when the e-mail is queued and again at send time, not by the producer hold.',
  }),
] as const satisfies readonly OwnershipRow[]

/** The steps in the order they go live. A later step may not be live while an earlier one is not. */
export const LIVE_WRITER_STEPS = ['mintsoft', 'woocommerce', 'xero'] as const
export type LiveWriterStep = (typeof LIVE_WRITER_STEPS)[number]

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

/**
 * The (destination, operation) of the map row that carries an integration outbox operation, named `<connector>/<operation>`
 * as in `outboxOperations`. Null for an operation no row names (the Xero carrier is claimed by the xero rows through
 * ACCOUNTING_POST_OUTBOX_OPERATION and is not an answer here: its seam is the sync-log row).
 */
export function ownershipTargetForOutboxOperation(name: string): { destination: Exclude<MappedDestination, 'customer-email'>; operation: string } | null {
  for (const entry of WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]) {
    if (entry.destination === 'customer-email') continue
    if (entry.outboxOperations?.includes(name) === true) return { destination: entry.destination, operation: entry.operation }
  }
  return null
}
