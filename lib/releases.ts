import { db } from '@/lib/db'

export type AppRelease = {
  version: string
  date: string
  title: string
  summary: string
  userMessage: string
  userHighlights: string[]
  technicalHighlights: string[]
  // Things an operator must do before or after deploying this release. Optional: older releases have none.
  operatorActions?: string[]
}

export const RELEASES: AppRelease[] = [
  {
    version: '5.1.0',
    date: '2026-11-18',
    title: 'Sales quotations, purchase order approval and minimum margin, GR/IR accrual, typed custom fields, document numbering, exchanges, Edit by CSV, and a security and audit-fix pass',
    summary: 'Release with operator actions: set TRUSTED_PROXY_IPS before deploying (login throttling reads the client address only from configured proxies), and check where the reverse proxy runs before deploying the stage unit file, which now binds 127.0.0.1. Migrations (all additive) apply automatically on deploy. New and changed: sales quotations, purchase order approval above a threshold and a minimum margin on purchase order lines, a GR/IR accrual sub-ledger and report, typed custom fields on products and sales orders, document numbering patterns, order attachments, sales-order to purchase-order pegging, exchanges inside a return, Edit by CSV on the Inventory list, WooCommerce native customs fields and duty and tax mirrored from the store, a Delete invoice and Delete bill action in Xero, and a large batch of security, accounting, WooCommerce and Mintsoft audit fixes. Built, switched off: refund delete, Xero document delete, WooCommerce order divergence reporting, TrackShip re-fire, the warehouse not-found strike count, the tracking reconcile sweep, lazy invoice fetch, and three new settings (mintsoft_align_up_requires_receipt_evidence, supplier_quote_shipping_landed_enabled, stock_adjustment_release_reserved).',
    userMessage: 'IMS 5.1 adds sales quotations, purchase order approval and minimum margin, typed custom fields, document numbering patterns, order attachments, exchanges inside a return and Edit by CSV on the Inventory list. Administrators: set TRUSTED_PROXY_IPS before deploying.',
    userHighlights: [
      'Sales: quotations with a PDF (emailing them is built, switched off), exchanges recorded inside a return, order attachments on sales and purchase orders, and pegging a sales order line to a purchase order line so received stock is allocated to it first.',
      'Purchasing: purchase orders above a threshold need approval before they are sent, a minimum gross margin per purchase order line can warn or block, and the sales price can be edited from the margin column.',
      'Inventory: Edit by CSV on the Inventory list gives a pre-filled download and a per-product diff before anything is applied; typed custom fields on products, variants and sales orders are managed under Settings > Custom fields.',
      'Settings: number patterns and counters for sales orders, purchase orders, credit notes and shipments, under Settings > Company > Numbering.',
      'Accounting: a GR/IR report under Analytics shows goods received and not invoiced, and billed and not received, by supplier and purchase order. Posting it to Xero is built, switched off.',
      'Xero: an invoice or bill that IMS pushed can be deleted in IMS and Xero together, freeing its number. Built, switched off.',
      'WooCommerce: native customs fields, the IOSS number, delivery term and duty and tax components are mirrored read-only onto the order; webhook secret rotation keeps the previous secret valid for 48 hours, with a Revoke previous secret button.',
      'Security: sign-in, two-factor, backup and settings-secret hardening, with optional backup encryption before upload.',
    ],
    technicalHighlights: [
      'Migrations (all additive): wc_order_divergences; so_po_pegging columns and table; mirror_woo_duty_tax columns; accounting document delete sync types and the accounting_document_deletions table; order_attachments and order_attachment_file_deletions; custom_field_definitions and custom_field_values; product_sync_marks; product_customs_clears and product_customs_inherited; sales_quotations; purchase_orders approval columns (six nullable); sales_order_lines exchange_for_refund link; new operator-task reason wms_not_found; the TrackShip re-fire state table and two columns with constant defaults on the order status snapshot table; the GR/IR sub-ledger tables; document numbering counters; customs clear lease and manual discrepancy columns; wms_discrepancy sku renamed; the push warehouse column on wms_order_push_links.',
      'Security: forwarded client address headers are trusted only for TRUSTED_PROXY_IPS / TRUSTED_PROXY_CIDRS; a password reset removes passkeys; getSetting returns sensitive values masked; backup target settings sit behind step-up; cost and margin data, cross-site request and CSV formula fixes; authorization fixes on stock adjustment edits, product prices and forecast settings.',
      'Accounting: GR/IR movements are written in the same transaction as the event, idempotent on the source event; refunds without a stock return no longer reverse COGS into Inventory; order-level purchase discounts reach the cost layer; supplier returns consume the returned order layers; a snapshot-day, short-close freight and supplier-quoted shipping pass; unrealised FX; sub-ledger reconciliations in the invariant report.',
      'WooCommerce: reconcile cadence and buried product recovery, stale delivery handling, inbound import fixes, failed product pushes recorded and retried, and the product.updated webhook following the product sync settings.',
      'Mintsoft: customs data cleared in IMS now clears in Mintsoft without holding a lock across the call; ASN, align and returns fixes; the IOSS number is sent only with mintsoft_send_ioss_number on (default off).',
      'Built, switched off: refund_delete_enabled, xero_document_delete_enabled, wc_order_divergence_detection_enabled, trackship_refire_enabled (needs helper plugin 1.4.0), wms_not_found_after_strikes_enabled, wc_tracking_reconcile_enabled, invoice_documents_lazy_fetch_enabled, grir_xero_posting_enabled, sales_quote_email_enabled, return_exchange_enabled, mintsoft_send_ioss_number, mintsoft_align_up_requires_receipt_evidence, supplier_quote_shipping_landed_enabled and stock_adjustment_release_reserved. With each off, payloads and reports are unchanged.',
    ],
    operatorActions: [
      'Set TRUSTED_PROXY_IPS (or TRUSTED_PROXY_CIDRS) in the server environment before deploying: the client address from X-Forwarded-For and X-Real-IP is trusted only for configured proxies, and without it login throttling sees every client as unknown (#1007).',
      'Optional: set BACKUP_ENCRYPTION_KEY in the server environment to make the Encrypt backups before upload option available (Settings > Backup & Restore > Storage, off by default); the key lives apart from the backups, which cannot be decrypted without it (#1003).',
      'Three new settings default off and stay off unless the owner decides otherwise: mintsoft_align_up_requires_receipt_evidence (#1025), supplier_quote_shipping_landed_enabled (#1028) and stock_adjustment_release_reserved (#1017).',
      'Keep these flags off: refund_delete_enabled, xero_document_delete_enabled, wc_order_divergence_detection_enabled, trackship_refire_enabled, wms_not_found_after_strikes_enabled, invoice_documents_lazy_fetch_enabled and wc_tracking_reconcile_enabled.',
      'The repository stage systemd unit now binds 127.0.0.1: check where the reverse proxy runs before deploying the unit file, because a proxy on another host cannot reach an app bound to 127.0.0.1.',
      'Webhook secret rotation has a 48-hour grace window: the previous WooCommerce webhook secret stays valid for 48 hours after a new one is saved, and the Revoke previous secret button ends the window early (#1026).',
    ],
  },
  {
    version: '5.0.0',
    date: '2026-11-17',
    title: 'Xero rounding account required, Mintsoft operator tasks instead of order comments, purchase order PDF, prepared stocktakes, reorder planning dates',
    summary: 'Breaking release: one Xero setting must be mapped before the first Xero push after deploy (the Rounding account, setting xero_rounding_difference_account), and warehouse cases that used to be Mintsoft order comments are now operator tasks on Sync > Exceptions. Migrations (all additive) apply automatically on deploy. New and changed: a priced purchase order PDF and per-line expected delivery dates, prepared stocktakes, Reorder Planning latest PO date, required receipt, coverage weeks, demand chart and richer draft POs, sales-order list bulk actions, a Needs attention dashboard card and bell, Xero journals dated by event with the Xero lock date respected, COGS booked when goods ship, and many WooCommerce, Mintsoft and accounting audit fixes. Built, switched off: purchase order emailing (purchase_order_email_enabled), the GTIN / MPN identifier split (product_identifier_split_enabled) and Mintsoft merge-candidate flagging (wms_merge_candidate_mode).',
    userMessage: 'IMS 5.0 adds a purchase order PDF, prepared stocktakes, reorder planning dates and charts, bulk actions on the sales-order list and a Needs attention card. Administrators: map the Xero Rounding account in Settings > Accounting.',
    userHighlights: [
      'Purchase orders: a priced PO PDF, an expected delivery date per line, and a profit margin per line for users who may see prices. Emailing the PO to the supplier is built, switched off.',
      'Stock Control: prepared stocktakes, where you choose the products to count and can add or remove them while the count is open.',
      'Reorder Planning: Latest PO date, Required receipt, Order qty and Coverage weeks on every row, a per-product demand chart, optional per-warehouse reorder points and safety stock, an Ignore stockouts option, forecast sales and margin with a growth factor, and draft POs that carry a destination warehouse, line delivery dates and a per-row supplier choice.',
      'Sales orders: tick orders on the list to allocate, advance status or print packing slips together; the status badge shows picking, packing and partial dispatch; each shipment has its own packing slip.',
      'Documents: order references, VAT and company numbers, non-Latin characters and a new credit note PDF are corrected on customer PDFs.',
      'A Needs attention card on the dashboard and bell notifications bring failed pushes, parked refunds, failed accounting rows and paused receipts into one view.',
      'Sales orders can be edited: drafts freely, confirmed orders after a WooCommerce-desync warning, addresses and notes after dispatch. Refunds can carry a return reason, PO lines carry internal notes, and a per-warehouse channel buffer can hold units back from WooCommerce.',
      'Warehouse (Mintsoft): IMS no longer writes order comments. Cases the warehouse must act on appear as tasks under Sync > Exceptions > Raise a warehouse query. Merge-candidate flagging for same-customer orders is built, switched off.',
    ],
    technicalHighlights: [
      'Migrations (all additive): wms_operator_tasks table and enums; needs_attention_announcements table; stock_counts.prepared and a unique index on stock_count_lines (countId, productId); PurchaseOrderLine.expectedDelivery; wms_order_push_links columns courier_task_service, courier_task_episode, double_postage_at and double_postage_detail; shipments accounting_cogs_relieved_from_inventory_at, _amount and _sync_log_id; deferral_adjustment_ref; sales_order_refunds return_cost_split and return_shipment_qty; the wc_stock_dirty_orders table; the reorder_threshold_overrides table; the per-warehouse channel buffer column on stock_levels; refused_actions table; xero_payment_matches table; sales_orders payment_removed_foreign, payment_removed_at, edited_in_ims_at and wc_line_baseline; the payment_removal_reconciliations table; return_reasons table and sales_order_refunds.return_reason_id; purchase_order_lines.notes; warehouses availableForPurchaseOrders; stock_sync_states.lastPushedEtaDate; payload_account_nets on accounting_sync_logs; invoice-document customer request columns; the refund delete table and sync type; sales_orders.invoicing_state; new values on the operator-task reason enum.',
      'Xero: every document write carries unitdp=4; the lost penny is posted as an untaxed Rounding adjustment line sized from the predicted whole-document total, tax included, and the write is refused unless the prediction equals the IMS total. The daily batch dates journals by event, imports and respects the Xero books lock date, nets pre-batch refunds, and books COGS when goods ship, paid or not.',
      'WooCommerce: the stock push subtracts orders IMS has not reserved under a completeness proof and records deleted or released orders; a resumable cancellation backstop runs on every reconcile pass; a status can no longer move a shipped order backwards; edits after import are surfaced on Sync > Exceptions.',
      'Mintsoft: systemic-failure circuit breaker on the order push and dispatch sweeps; WMS-cancelled orders, refused completions and possible double postage are surfaced; align-down is held for units already despatched; an approved over-receipt books the full quantity; a partly delivered ASN can be closed short.',
      'Built, switched off: purchase_order_email_enabled, product_identifier_split_enabled, wms_merge_candidate_mode (flag mode only; IMS never merges), mintsoft_product_parity_enabled, mintsoft_parent_sku_delete_enabled, xero_payment_matching_mode (off, shadow or live), wc_ast_provider_mapping_enabled and wc_back_in_stock_date_enabled, refund_delete_enabled (keep off until its open defect is fixed) and wc_invoice_document_enabled, invoice_documents_credit_notes_enabled and invoice_documents_lazy_fetch_enabled; the Reorder Planning Ignore stockouts box is off by default. With each off, payloads and reports are unchanged.',
      'Also: a sales order Invoicing state (Not, Partially or Fully invoiced), retention compaction that keeps the account nets the Allocated Inventory proof needs, and refused or stalled actions are recorded, aged and escalated; a partial payment removal in Xero is measured and recorded on the order; IMS-initiated refunds on WooCommerce orders raise a Refund in WooCommerce task; supplier credits against reverse-charge bills carry the net payable.',
      'New read-only tools: npm run crm:identity-report and scripts/report-identifier-reclassification.ts write nothing.',
    ],
    operatorActions: [
      'Map the Xero Rounding account (Settings > Accounting > Xero, setting xero_rounding_difference_account, for example account 860). Without it, a Xero document whose 4-decimal unit prices leave a rounding gap is refused and nothing is sent.',
      'Keep the stored Xero tax-rate list fresh (sync the chart of accounts and tax rates before the first batch after deploy); a line whose tax rate is missing from it, or a stale list, refuses the Xero write.',
      'Work the new warehouse queries: IMS no longer writes Mintsoft order comments, so each case the warehouse must act on is a task under Sync > Exceptions > Raise a warehouse query (copy the text into a Mintsoft query, then press Done).',
      'After deploying, run npm run sales:invoicing-state:recompute once (add -- --dry-run first to report without writing); the migration marks existing invoiced orders as Fully invoiced and the recompute refines partly invoiced ones.',
      'Keep refund delete switched off: refund_delete_enabled ships off by default and stays off until the open defect on it is fixed.',
      'Keep the wms-order-status cron on: the new align-down gate holds a stock write-off for orders pushed to Mintsoft and not yet shipped in IMS unless their cached Mintsoft status is fresh.',
      'Work the new refund and payment follow-up tasks: a refund recorded in IMS on a WooCommerce order raises a Refund in WooCommerce task (IMS writes nothing to the store; confirm a later parked WooCommerce refund against the IMS refund so no second credit note is raised), and an order whose payment was partly removed in Xero reads Part paid until the owner credits or writes it off.',
      'Watch the new Sync > Exceptions sections (refused WooCommerce completions, possible double postage on merged orders, orders cancelled in Mintsoft, WMS connector-wide failure); IMS changes nothing on its own for these.',
    ],
  },
  {
    version: '4.4.1',
    date: '2026-11-15',
    title: 'Warehouse note for removed merged-order lines is no longer lost; order push runs one at a time',
    summary: 'Backend fix, no migration and no action on upgrade. When IMS removes lines from a merged warehouse order, the note telling the warehouse which lines were removed is now saved before the removal and retried after a clear refusal. A note whose delivery is uncertain, or a removal that stopped part-way, is not retried automatically: the order push heartbeat turns red once and the case waits for an operator. Until the planned screen exists, resolve it in two steps. First, open the warehouse order in Mintsoft and confirm that EVERY line the removal named is gone; if any is still there, the removal stopped part-way, so remove those lines or escalate the cancellation, and leave the IMS record alone until that is done. Only then check the order\'s comments for the note (it starts with [IMS removal-note), add it if it is missing, and ask for the wms_order_push_removal_note setting for that order to be cleared. Two order push runs can no longer overlap. Correction to the 4.4.0 notes: a refund already recorded under the EU VAT scheme, or a held rate-182 credit note, keeps that treatment or hold after the Sales Invoices switch is turned off.',
    userMessage: 'IMS 4.4.1 makes the note to the warehouse about removed order lines reliable, and stops two order push runs overlapping.',
    userHighlights: [
      'Mintsoft: the note naming lines removed from a merged order is no longer lost if IMS stops or the first attempt is clearly refused, and IMS never sends it a second time on its own.',
      'Mintsoft: if IMS cannot tell whether a note reached the warehouse, the order push heartbeat turns red once and the case waits for an operator to check the warehouse order in Mintsoft, lines first, then the note. There is no screen for these yet; a follow-up is planned, and until then the check is done by hand as described in the summary.',
    ],
    technicalHighlights: [
      'The removal note is a durable obligation stored as a setting per link and warehouse order (ids, SKUs and quantities only): intended before the first remote delete, owed once the removal is verified, needs_check when the outcome is uncertain or the removal was partial. Cleared by the transaction reset; dropped for erased or deleted orders.',
      'The order push sweep takes a per-connector session advisory lock and answers skipped when another run holds it. The dispatch sweep no longer repoints a link while the push sweep holds its amendment lease.',
      'Correction to 4.4.0: the EU VAT credit-note treatment reaches new refunds only while the Sales Invoices switch is on; a refund already recorded under the scheme, or a held rate-182 credit note, keeps that treatment or hold after switch-off.',
    ],
  },
  {
    version: '4.4.0',
    date: '2026-11-15',
    title: 'WooCommerce refunds with fees are recorded, safer EU VAT credit notes, EU VAT comparison report',
    summary: 'Nothing in 4.4.0 needs an operator action on upgrade; the migration (one nullable column on refund lines) applies automatically on deploy. WooCommerce refunds that include a fee are now recorded instead of waiting as pending for ever; any fee refund IMS cannot match safely is quarantined for an operator. The EU VAT credit-note changes are built, switched off: new refunds get them only while the Sales Invoices switch is on, and a refund already recorded under the scheme, or a held rate-182 credit note, keeps that treatment or hold after the switch is turned off. The new read-only EU VAT comparison report is meant to be run BEFORE that switch is turned on, as the go-live runbook describes.',
    userMessage: 'IMS 4.4 records WooCommerce refunds that include a fee. A fee refund IMS cannot match safely is set aside in the exceptions inbox for an operator, instead of waiting as pending.',
    userHighlights: [
      'WooCommerce refunds that include a fee are now recorded, with the fee matched to the order fee of the same name.',
      'A fee refund IMS cannot match safely (two fees with the same name, a fee refunding VAT but no net, more than the fee had left after earlier refunds, or an amount-only goods refund mixed with a fee) is quarantined in the exceptions inbox for an operator, and nothing is sent to Xero. The money has already gone back to the customer in the store, so do not refund it again there.',
    ],
    technicalHighlights: [
      'Migration (additive): nullable column sales_order_refund_lines.charged_tax_foreign, the VAT stated on each refund line; no backfill. Cumulative refunded net and VAT per fee are capped under the refund write order lock.',
      'Built, switched off (Sales Invoices switch; a refund already recorded under the scheme keeps its treatment after switch-off): a whole-order reversal credit note is built from the invoice version Xero has confirmed, reverses its rounding line, must match it account by account, and refuses to a hand-post row otherwise; an unmarked untaxed fee keeps No VAT on its credit note.',
      'Available before go-live: npm run eu-vat:shadow -- --live-read --orders <ids> (or --from/--to) compares, read-only, what IMS would send for chosen EU orders with the invoice Xero holds (GETs only; it never refreshes the Xero token or writes anything). Running it on live data is the owner\'s decision. The go-live runbook is in help-docs/xero-sync.md.',
      'The VAT difference report now states, for --scheme ioss/voec, that it compares rate configuration only.',
    ],
  },
  {
    version: '4.3.0',
    date: '2026-11-15',
    title: 'WooCommerce webhooks no longer move the sweep cursor',
    summary: 'Nothing in 4.3.0 needs an operator action on upgrade. A delivered WooCommerce order or product webhook no longer moves the sweep position, so an older order or product whose webhook was missed is still picked up by the next sweep. The Sync page "Last order intake" and "Last product intake" now show the last sweep position rather than the last webhook. The EU VAT pieces behind the Sales Invoices switch remain built, switched off.',
    userMessage: 'IMS 4.3 makes the WooCommerce sweep more reliable: an order or product whose webhook was missed is no longer skipped because a later webhook arrived.',
    userHighlights: [
      'WooCommerce: an order or product whose webhook was missed is still picked up by the next sweep, even if a later webhook for another order arrived first.',
      'Sync page: "Last order intake" and "Last product intake" now show where the last sweep read up to, not when the last webhook arrived.',
    ],
    technicalHighlights: [
      'Webhooks write wc_order_webhook_last_processed_at and wc_product_webhook_last_processed_at instead of last_wc_order_sync_at and last_wc_product_sync_at; only a clean sweep moves the sweep cursors. Both new keys are cleared by the operator reset. No migration.',
      'Webhook-primary mode: a clean reconcile carries its position to the poll cursor (atomic max, in the same locked commit), only when its status list covers the poll list and the carry would not widen the stored poll fingerprint. The initial import writes that fingerprint with the cursor, in one transaction, from the status list it started with.',
      'Accepted limits: after a status is added in webhook-primary mode, reconciles do not carry until a poll has run, so a very large backlog (over 100,000 changed orders) could reach the page-walk ceiling on the first poll. On a legacy install with no fingerprint, the first carry cannot recover a status widening made before it. Both are filed as follow-ups.',
    ],
  },
  {
    version: '4.2.0',
    date: '2026-11-14',
    title: 'Gift-card answers for unsettled order lines, safer WooCommerce sweep cursors, held-invoice sweep failures now visible',
    summary: 'Nothing in 4.2.0 needs an operator action on upgrade. Sync > Exceptions gains a section where an operator answers "gift card or not" for order lines the store flagged unknown; the section is live, but it only matters once the EU VAT gift-card cut-in is set, which the owner can now do safely. The EU VAT pieces behind the Sales Invoices switch remain built, switched off. WooCommerce pull cursors no longer skip an order modified while a sweep was finishing, and a failed held-invoice sweep read now turns the wc-reconcile heartbeat red instead of staying green.',
    userMessage: 'IMS 4.2 adds a "Gift card or not?" section to Sync > Exceptions, where you can answer for an order line the store could not settle. WooCommerce order and product sweeps are also less likely to miss an order changed while a sweep was finishing.',
    userHighlights: [
      'Sync > Exceptions: a new section, "Gift card or not? Order lines the store could not settle", lists held orders and the lines in question. Gift card or Not a gift card records the answer with who and when, and re-importing the order releases its held invoice. It is relevant only once the gift-card cut-in is set; until then no order is held for this reason.',
      'Sync > Exceptions: the section is paged 50 orders at a time, its heading shows the true count, and the count is included in the Exceptions badge.',
      'WooCommerce: an order modified while a sweep was finishing is no longer skipped; pull cursors now start from when the run began, less a 120 second overlap.',
      'WooCommerce reconcile: a failed read while releasing held invoices now shows as a failure on the heartbeat instead of passing as ok.',
    ],
    technicalHighlights: [
      'Migration (additive): new table eu_vat_gift_card_line_resolutions, with a store_identity column binding each answer to the store it was given for; answers are deleted when the store connection changes to another store and by the operator reset.',
      'The eu_vat_gift_card_flag_cut_in setting may now be set by the owner: an unknown line no longer causes a permanent refusal, because an operator answer settles it. A flagged yes or no is never overridden, and an unanswered line keeps refusing.',
      'Built, switched off: the EU VAT treatment itself stays behind the Sales Invoices switch. Only the answer section is live.',
      'All WooCommerce pull cursors (order and product poll and reconcile, initial import completion) take the run start time minus WC_PULL_CURSOR_OVERLAP_MS (120 s). A commit writes the later of the stored and new value in one atomic upsert, so a cursor never moves backwards.',
      'The held sales-invoice release sweep returns heldSalesInvoices.readError when a read throws; the cron outcome mapping counts it as a failure and the wc-reconcile route answers 500.',
    ],
  },
  {
    version: '4.1.1',
    date: '2026-11-14',
    title: 'WooCommerce order sweep can save its progress again',
    summary: 'Backend fix only, no operator action. In 4.1.0 the WooCommerce order sweep read orders correctly but failed when saving its progress, so it reported a failure every run and did not move forward. Nothing was lost; the sweep re-read the same window each time.',
    userMessage: 'IMS 4.1.1 fixes the WooCommerce order sweep, which in 4.1.0 could not save its progress. No orders were lost.',
    userHighlights: [
      'WooCommerce: the order sweep saves its progress again, so its last-success time moves forward and the Healthchecks heartbeat for the WooCommerce reconcile is no longer red because of it.',
    ],
    technicalHighlights: [
      'The sweep commit took its per-cursor advisory lock with $queryRaw; pg_advisory_xact_lock returns void, which Prisma cannot deserialize. It now uses $executeRaw, and a source test forbids $queryRaw for pg_advisory lock calls.',
    ],
  },
  {
    version: '4.1.0',
    date: '2026-11-14',
    title: 'Blocked WooCommerce orders recorded, cron failures reach Healthchecks, EU VAT credit notes built and switched off',
    summary: 'Nothing in 4.1.0 needs an operator action on upgrade. Orders the WooCommerce import refuses are now recorded and listed under Sync > Exceptions instead of being lost, the order sweep copes with a store that does not have the withdrawal plugin active, and cron routes now answer a failure with HTTP 500, so a Healthchecks heartbeat can go red on a real failure that used to stay green. The EU VAT credit-note treatment and the hold on the first rate-182 credit notes are built and switched off behind the Sales Invoices switch.',
    userMessage: 'IMS 4.1 records WooCommerce orders that the import blocks (for example an unmapped tax rate) and lists them under Sync > Exceptions with the reason, so they are no longer missed. The order sweep also keeps working when the store does not have the EU withdrawal plugin active.',
    userHighlights: [
      'WooCommerce: an order blocked by the tax-rate or coupon guard is recorded and listed under Sync > Exceptions as "WooCommerce orders: blocked from import", with the order number, the reason and what to fix. Once the cause is fixed the order is imported automatically.',
      'WooCommerce: the initial import no longer completes silently over orders it refused; the progress card shows the blocked count.',
      'WooCommerce: the order poll and reconciliation skip an EU withdrawal status the store has not registered, with a warning in the activity log, instead of failing the whole run.',
      'Data retention no longer deletes a refused or blocked order that is still waiting to be imported.',
    ],
    technicalHighlights: [
      'Ops note: every route under app/api/cron/ now answers 500 when its run genuinely failed (ok, skipped and held answer 200). Healthchecks heartbeats can turn red on real failures that were silently green before; nothing needs to be changed, and a stage installation with no outbound grant stays green by design.',
      'Cron failure mapping lives in lib/ops/cron-outcomes.ts, one entry per route, with a census test that fails CI when a new failure-like field in a producer is not mapped or justified.',
      'Migrations (additive, nullable, no backfill): refund_scheme_posting_snapshot, refund_line_scheme_tax_rate_value, refund_eas182_hold and refund_scheme_treated_at.',
      'CI: every workflow job is pinned to ubuntu-24.04.',
      'Built, switched off: the EU IOSS / VOEC / DDP credit-note treatment, and the hold of the first 10 rate-182 refund credit notes, both behind the Sales Invoices switch. With the switch off, new refunds skip the treatment; a refund already recorded under the scheme, or already held, keeps that treatment or hold even after the switch is turned off.',
    ],
  },
  {
    version: '4.0.0',
    date: '2026-11-13',
    title: 'Xero supplier-document tax checks, merged Mintsoft order handling, report export notices, EU VAT invoice treatment built and switched off',
    summary: 'Numbered 4.0.0 because supplier-document changes need operator action when Xero sync is on: a supplier bill or supplier credit note whose line has no mapped tax type, or uses an inactive purchase tax rate, is now refused instead of posting as "No VAT", so every VAT rate used on supplier bills must be mapped and active first, and supplier credits against reverse-charge or mixed-treatment bills are raised in Xero directly. See the Operator actions list at the top of the 4.0.0 section of CHANGELOG.md. The rest: bill VAT is worked out line by line, a cancelled order that Mintsoft merged into another is taken out of the combined order, report CSV exports that hit the row limit download a notice file, and the EU VAT invoice treatment and the gift-card flag cut-in are built and switched off.',
    userMessage: 'IMS 4.0 tightens supplier bills in Xero: a bill or supplier credit note on a VAT rate with no mapped Xero tax type, or on an inactive rate, is now refused instead of posting as No VAT. Administrators should map the purchase tax rates before raising bills. Cancelled orders that Mintsoft merged into another are now taken out of the combined order, and over-limit report exports download a clear notice file.',
    userHighlights: [
      'Xero bills: a supplier bill or supplier credit note line with no mapped tax type, or priced on an inactive purchase tax rate, is refused instead of posting as "No VAT", with the reason shown at the point of saving or posting: the bill is not saved, and the supplier credit note stays a draft. Neither appears as a row on the Sync page, because nothing is queued.',
      'Xero bills: the VAT on a bill is the sum of each line\'s own rate, rounded per line as Xero does, so it agrees with Xero. A bill keeps the tax treatment it was booked with if the order\'s rate changes later.',
      'Xero bills: a supplier credit note copies the tax treatment of the bill it credits. A supplier credit note against a bill that mixes tax treatments, or has a reverse-charge line, is not posted from IMS and stays a draft.',
      'Xero payments: a paid bill or invoice whose payment date is missing or unreadable is skipped with a warning and revisited on every poll until the date can be read.',
      'Mintsoft: when an order that Mintsoft merged into another is cancelled or fully refunded in IMS, its own lines are removed from the combined order, and anything IMS cannot do safely raises a notice naming the lines to take out by hand. A merged order is never amended or cancelled by mistake.',
      'Reports: a report CSV export that hits its row limit now downloads a file marked REPORT NOT COMPUTED instead of failing with an error.',
    ],
    technicalHighlights: [
      'Operator actions (breaking): the full list is at the top of the 4.0.0 section of CHANGELOG.md; it covers the Xero tax types for supplier bills and queued bills with a non-vatable cost line.',
      'Bill VAT is computed per line and rounded to the bill currency\'s minor unit; the tax type, effective rate, IMS rate id and reverse-charge flag are stored per bill line, and a bill booked before that is trusted only when its reconstruction matches within one minor unit.',
      'Xero dates go through one parser for the `/Date(ms)/` form; documents with an unreadable payment date are remembered in xero_payment_date_pending and re-read by id on every poll.',
      'Mintsoft push: recorded warehouse line ids (wms_order_push_items), a per-link amendment lease, a generation token on the line snapshot, an identity check before every write to an existing order, and a merge followed only when the combined order holds every recorded line.',
      'Migrations (additive, nullable, no backfill): purchase_invoice_line_tax_snapshot, xero_payment_date_pending (and its tenant column), wms_order_push_items, wms_push_link_amend_notice_and_snapshot_unsafe, wms_push_link_line_snapshot_token and wms_push_link_amend_lease.',
      'CI: the validate job and the ledger standing-reader check now run with a 5632 MB heap.',
      'Built, switched off: the EU IOSS / VOEC / DDP invoice treatment behind the Sales Invoices switch (nothing is read or rewritten while the switch is off), and the gift-card flag cut-in setting eu_vat_gift_card_flag_cut_in (unset by default; the resolver is not yet called by a posting path).',
    ],
    operatorActions: [
      'With Xero sync on, map a Xero tax type to every VAT rate that supplier bills use and keep those rates active (Settings > Accounting > Tax; the purchase tax rates can be imported from Xero). A supplier bill or supplier credit note line with no mapped tax type, or on an inactive purchase rate, is now refused instead of posting as "No VAT".',
      'A queued supplier bill that has a non-vatable cost line needs one edit-and-save, so it is re-derived on the corrected rules.',
      'With Xero sync on, a supplier credit against a bill that has a reverse-charge line, or that mixes tax treatments, is refused and stays a draft in IMS. Mapping tax rates does not unblock it: IMS leaves these credits unsent in this release, so Xero has no record of such a credit unless it was made in Xero.',
      'A supplier credit against a bill booked before this release is refused when the order\'s current rates no longer reproduce the VAT that bill recorded. One edit-and-save of that bill records its tax treatment, after which the credit is accepted.',
    ],
  },
  {
    version: '3.1.0',
    date: '2026-11-12',
    title: 'Dispatch completion, searchable order lists, Mintsoft push hardening, reconciling refund and PDF figures, one revenue basis',
    summary: 'User-facing, non-breaking release on top of 3.0.0. Dispatching the last shipment now moves a ready order on in the same step, IMS refuses to dispatch a Draft, On Hold or Pending payment order, and a warehouse despatch of such an order is either recorded without moving the order on or held on Sync > Exceptions, the Sales and Purchase Order lists search every order, the Mintsoft order push recovers from lost creates, merged orders and holds or cancels the warehouse cannot honour, refunds entered by hand are strictly bounded and the order page, refund dialog and PDFs reconcile, and every revenue and receivables report uses one invoiced basis that includes archived orders. Everything in it is live: nothing is behind a flag. The two migrations are additive and nullable, and no operator action is required.',
    userMessage: 'IMS 3.1 makes dispatch and refunds safer and the order lists complete: you can search every sales and purchase order, a Draft, On Hold or Pending payment order can no longer be dispatched from IMS by mistake (a warehouse despatch of one is recorded or held for review, never silently completed), refunds entered by hand cannot exceed what was paid, and financial reports now include archived orders so their totals match across screens.',
    userHighlights: [
      'Dispatch: dispatching the last shipment of an order now moves the order on in the same step, so it no longer fails after the goods have left. Dispatching a Draft, On Hold or Pending payment order from IMS is refused with a message naming the next step. When the warehouse reports a despatch for an On Hold or Pending payment order that already has a shipment, the despatch and stock are recorded but the order is not moved on and administrators get a notice; a warehouse despatch for a Draft order, or for a held order with no shipment, is held as a stuck despatch on Sync > Exceptions. Also, a service, fee or delivery-charge line no longer keeps an order in Allocated.',
      'Orders: the Sales Orders and Purchase Orders lists search every order, 50 per page, with the result count shown. Completed and archived orders can be shown with the Hide completed and Include archived ticks, and a search always includes them.',
      'Reports: a report that hits its row limit now says so with a red banner, dashes and "Report not computed" instead of showing zeros, and its CSV export is refused rather than downloaded as zeros.',
      'Refunds: the amount of a refund entered by hand is limited to what the order line has left and what the customer paid, its product always matches the line it refunds, and a full refund includes its share of the order discount. The refund dialog shows and sends the credit note, and credit-note VAT and totals are marked as estimates.',
      'Orders and PDFs: the order page and the sales order and invoice PDFs print one basis (all gross or all net), with VAT rows that add up to the Total.',
      'Reports: revenue is what has been invoiced, on every report, and archived orders are included, so AR Aging, Customer Aging, Currency Summary and Sales Analytics agree. Figures for a past period can differ from before.',
      'Mintsoft: a create that timed out is looked up and linked instead of being parked, merged orders are detected, holds and cancels the warehouse cannot honour show on Sync > Exceptions, and a despatch for an order cancelled or fully refunded in IMS is held for a person to decide.',
    ],
    technicalHighlights: [
      'Dispatch: the order promotion runs inside the dispatch transaction under the order lock, an in-app dispatch of DRAFT, ON_HOLD or PENDING_PAYMENT is refused before any stock or cost work, a warehouse despatch for an ON_HOLD or PENDING_PAYMENT order that already has a shipment is booked without touching the order and raises a notice, while a warehouse despatch for a DRAFT order or a held order with no shipment is not recorded and becomes a stuck despatch on Sync > Exceptions, and a WMS dispatch retry reconciles the order under its lock. Service lines are excluded from the completion check.',
      'Order lists: search, status filter and paging run in the database over the existing tables ordered by the createdAt index (no new index); searches under 3 characters match an order number or reference exactly. Row-limit refusals carry a reportNotComputed flag and the CSV export still returns HTTP 413.',
      'Mintsoft push: read-only lookup of a landed create linked only on exactly one live order carrying the order number and its own reference, read back by id; merged-order detection by one read-only search; hold and cancel 404s are no longer recorded as success; a despatch is refused for an order IMS no longer intends to ship.',
      'Migrations (additive, nullable, no backfill): 20261110100000_wms_push_link_operator_notices and 20261110120000_wms_push_link_notice_comment_delivery add notice columns to wms_order_push_links.',
      'Refunds: the manual-refund ceiling is enforced on the server under the order lock per line, per currency column and cumulatively at the rate each row posts under; the header total is the sum of its lines per currency column; the discount reversal is one shared function used by the server and the dialog.',
      'Reports: one invoiced-revenue basis, one report date (invoice date, else paid date, else order date, flagged approximate), and one receivable balance in lib/domain/sales/receivable-balance.ts shared by AR Aging, Customer Aging, the Invoices tab and the Currency Summary. Archived orders are included; the retention job only hides them from operational lists.',
      'Live versus switched off: all of the above is live. Nothing new is behind a flag, and the 3.0.0 switched-off items (customer invoice publish, Aelia rate source, EU VAT regime) are unchanged.',
    ],
  },
  {
    version: '3.0.0',
    date: '2026-11-10',
    title: 'Catch-up release: posting safeguards, purchase-order lifecycle, WooCommerce store fence, VAT/IOSS groundwork, scheduler and deploy hardening',
    summary: 'Catch-up release covering everything landed since 2.0.0 (about 1,800 commits). Sales documents and payments are stricter about what they will post, purchase orders can be edited, closed and cancelled at every stage, WooCommerce deliveries are judged on which store sent them, and the VAT/IOSS, Aelia exchange-rate and reconciliation work is built but mostly switched off. It is numbered 3.0.0 because several changes need operator action before or after deploying: see the Operator actions list at the top of the 3.0.0 section of CHANGELOG.md.',
    userMessage: 'IMS 3.0 is a large catch-up release: purchase orders can now be edited, closed and cancelled at every stage, and invoices and payments are stricter about what they will post. Administrators should read the operator actions in the release notes before relying on scheduled jobs, product push and CSV exports.',
    userHighlights: [
      'Sales and refunds: a manual order with VAT-inclusive prices no longer posts its VAT twice, and a draft is finalised only when its invoice would book to the order total. Finalising and creating a live order are now one step with the invoice, so a newly created or finalised order is either saved with its invoice queued or not saved. Clones that were already shipped before the fix have no invoice and need one raising by hand.',
      'Sales and refunds: a sales invoice or credit note line with no tax type, or an order paid on an unmapped or inactive tax rate, is refused and shown as a failed row on the Sync page instead of posting on "No VAT".',
      'Payments: a balance recorded after a deposit that has already posted is no longer refused, and several payments on one invoice are told apart by their receipt.',
      'Purchasing: a purchase order can be edited from Draft to Part-received, and Close and Cancel are available at every stage. Cancelling a part-received order now closes it short: received stock and its costs stay, and freight is re-spread over the units that arrived.',
      'Purchasing: a manual receipt is refused while the line has an open warehouse ASN, and warehouse stock-sync alignment can no longer double-count units on a purchase-order line.',
      'Purchasing: the supplier portal no longer shows draft purchase orders, a submitted quote opens read-only instead of an error, and suppliers land on their portal after login.',
      'WooCommerce: order and refund webhooks from a staging clone or a previous store are ignored and logged, and the IMS-to-WooCommerce product push only runs when product sync is enabled with direction "to WooCommerce" or "both".',
      'WooCommerce: the daily stock catch-up now works through the catalogue in windows (hourly pass), a paid order whose total differs is retried instead of forgotten, and invoice notes post once and are not sent for cancelled orders.',
      'Mintsoft: the despatch poll is now a scheduled job (every 15 minutes), and a bundle create that may have been sent is looked up rather than sent again.',
      'Xero, VAT and IOSS: Settings > Accounting > Tax can import the purchase tax rates from Xero, and a read-only VAT rate differences report compares Xero, IMS and WooCommerce. The EU IOSS/VOEC regime, rate declaration and WooCommerce tax-rate writer are built, switched off.',
      'Exchange rates: the Aelia exchange-rate source is built, switched off; ECB stays the default until an owner-approved switch.',
      'Reports: CSV exports are data rows only by default (add ?metadata=1 for the metadata rows), planning and production reports use the claimed recipe and the recipe frozen on a started order, and a daily Xero chart-of-accounts refresh and extra admin alerts were added.',
      'Inventory: late freight on stock in transit between warehouses now reaches Inventory, the unused Kit tables are retired, and the products CSV rejects malformed recipe quantities instead of loading a wrong one.',
      'Security: purchasing analytics and Purchase Statistics are limited to Admin, Manager and Finance, the Public App URL is validated strictly, and saved WooCommerce credentials only work with the saved store URL.',
    ],
    technicalHighlights: [
      'Operator actions (breaking): move DEPLOY_ADMIN_DATABASE_URL to /etc/ims-db-admin/deploy-admin.env and ensure the <role>_migrator role exists; Save & Apply on Settings > System > Scheduler once; Public App URL must be https; set shipping and discount accounts; map WooCommerce tax rates; set wc_sync_product_enabled/direction if product push is wanted; use ?metadata=1 on CSV consumers; fix products CSV components cells; read the full list at the top of the 3.0.0 section of CHANGELOG.md.',
      'The deploy admin database credential is root-only: the migration logs in as a no-privilege <role>_migrator with a fresh per-window password, the fence helper runs as root with a scrubbed environment, and FENCE_STATE=held|restored|unknown is read back from the ACL.',
      'Accounting posting: the Xero connector no longer defaults a missing TaxType to NONE on sales documents; one emit decision is shared by the invoice builder, tax-type check and reconciliation; finalising a draft and creating a live order are one transaction with the queued invoice; one function decides an order\'s VAT basis.',
      'Payments are identified by the receipt (payment row), sales_orders.cancelled_at is stamped by the database, and a receipt dated after cancellation is held rather than booked as an overpayment.',
      'Purchase orders: close-short semantics, freight re-spread BY_VALUE over landed units, a landed-quantity definition (qty - landed) enforced under the order lock, wms_asn_line_maps.manualQtyBaseline, credited ASN reservations retired rather than resized, and booked-in callbacks held for cancelled or closed orders.',
      'WooCommerce: signed ?rest_route self-links resolve the store root, shopping_webhook_events carries a never-reset claimGeneration, order and refund webhooks get the same foreign-store judgement as product webhooks, the invoice note and meta paths are fixed (leading slash), and the invoice note is floored by WC_WRITES_LIVE_FROM.',
      'Built, switched off: customer invoice publish (wc_invoice_document_enabled, invoice_store_publications table), Aelia FX source (fx_rate_source default ECB, helper plugin 1.3.0 not deployed), EU VAT regime resolver and order stamp (nothing builds a document from it), TaxRate.schemePostingTaxType and the 65-rate declaration, and npm run woo:tax-plan held at P1.',
      'Reconciliation pack: R1 Mintsoft stock against IMS on-hand behind --vendor-reads-only with a GET-only Mintsoft reader that can never log in, pure comparators and a self-proving report writer; the first-load apply runner core and npm run first-load:prepare exist, with no database side yet.',
      'New operator tooling: npm run readiness:gate (GO / GO-WITH-ACCEPTED-WARNINGS / NO-GO), npm run rehearse:woo-import, npm run vat:diff, npm run eu-vat:preflight and eu-vat:seed; /api/admin/rollout-readiness now returns 412 for a PARTIAL or unproven newest reconciliation run, allowWarnings or not.',
      'Scheduler: mintsoft-dispatch-sync is a registered job (15 minutes), wc-reconcile runs hourly with a persisted cursor in 150-product windows, xero-chart-sync runs daily at 00:30, and the Public App URL is validated and stored canonical so it cannot inject into the managed crontab.',
      'Manufacturing readers: production variance, WIP, reservation attribution and the component shortage report use the recipe frozen at start (componentSnapshot); planning uses only the claimed recipe, enforced by a census test.',
      'Reports and exports: CSV bodies are data rows only unless ?metadata=1, with X-IMS-Export-Metadata and X-IMS-Export-Notices headers; the stock-position, ledger, costing, sales-analytics and supplier-aging dashboard links request metadata.',
      'Landed cost: a late freight change posts the in-transit share (DR Inventory / CR Stock in Transit) and the revaluation audit lists inTransitResidue.',
      'Retired and removed: the Kit and KitItem tables (migration refuses if rows exist) and the Shopify and QuickBooks connectors (archived under archive/connectors with tags; generic registries unchanged).',
      'Migrations are forward-only and additive apart from the Kit drop (new columns such as claimGeneration, manualQtyBaseline, euVatRegime stamp fields, cancelled_at; new tables invoice_store_publications and migration_verification_passes).',
    ],
    operatorActions: [
      'Move `DEPLOY_ADMIN_DATABASE_URL` out of the application `.env` into `/etc/ims-db-admin/deploy-admin.env` (root:root 0600) before deploying: a copy left in `.env` is refused before anything is stopped. Make sure the `<application role>_migrator` migration role exists (`fence-db-connections.mjs --ensure-migration-role` for an external database).',
      'Open Settings > System > Scheduler and use Save & Apply once after deploy, so the new `mintsoft-dispatch-sync` job (every 15 minutes) and the hourly `wc-reconcile` schedule reach an existing crontab. Use a fixed Mintsoft API key for the unattended poll. Then run `npm run read-sync:status` as the application user and confirm it exits 0. Any other exit code is a problem: run `npm run --silent read-sync:status -- --json` and check its scheduler section shows `examined: true`, `unreadable` and `blockProblem` null, and empty `unscheduled` and `disabled` lists (a stale feed exits 1 before a missing or disabled job is reported).',
      'Check the Public App URL setting: it must now be an `https://` URL (`http://` only for localhost or 127.0.0.1) with no whitespace, credentials, query or fragment; a value that fails refuses the crontab write.',
      'Set the shipping and discount accounts under Settings > Accounting before raising orders with shipping or a discount: such an order is now refused at creation and at finalisation when the account is missing.',
      'Cloned orders already shipped before the fix have no invoice and need one raising by hand; a draft stored as VAT-inclusive with no default rate is not finalised.',
      'Map every WooCommerce tax rate and give every sales line a tax type: a sales invoice or credit note line with no tax type, and a WooCommerce order that moved money on an unmapped or inactive rate, is now refused (a failed row on /sync) instead of posting on "No VAT". Use Settings > Accounting > Tax > Import purchase tax rates from Xero where rates are missing.',
      'Set `wc_sync_product_enabled` and `wc_sync_product_direction` (`to_wc` or `both`) if IMS should push products to WooCommerce: the default (`from_wc`), a missing value or an unreadable setting now pushes nothing.',
      'A staging clone or previous store that still posts signed webhooks is now ignored (logged `wc_order_webhook_foreign_store` / `wc_refund_webhook_foreign_store`), and a delivery that names no store is refused; confirm the saved store URL is the live store. Saved WooCommerce credentials are only used with the saved URL, so type the key and secret again when changing the URL.',
      'Deploy helper plugin 1.3.1 to the store to get the partial-shipment status rule (1.3.0 for the Aelia rates endpoint before `fx_rate_source` can be switched to Aelia); neither plugin is deployed by this release.',
      'Report CSV consumers: exports are data rows only by default. Append `?metadata=1` to get the trailing `# IMS export metadata` rows back, or read the `X-IMS-Export-Metadata` / `X-IMS-Export-Notices` response headers.',
      'Fix products CSV `components` cells to `SKU:qty` with a plain positive quantity of at most 4 decimals: `1,5`, `2 units` or a part with no `:` now refuses the row\'s whole recipe. The transfers import also accepts an optional `dispatchedAt` column and invalidates a whole `transferKey` group on a bad row.',
      'The migration drops the `kits` and `kit_items` tables and refuses to run if either holds rows; inventory aging filtered to type KIT is empty (age the component SKUs instead). Shopify and QuickBooks cards and their `SHOPIFY_*` / `QUICKBOOKS_*` environment variables are gone.',
      'Purchasing analytics and Purchase Statistics are now Admin, Manager and Finance only, and a manufacturing cost line whose account override is not the configured Manufacturing Overhead account is refused until cleared.',
      'A manual purchase-order receipt is refused while the line has an open warehouse ASN, and a purchase order with an open ASN cannot be closed or cancelled until the ASN is booked in or retired; cancelling a part-received order is now "close short" and no longer reverses the received stock.',
      'Deploy gates that call `/api/admin/rollout-readiness` now get HTTP 412 for a PARTIAL, FAILED, running or unrecognised newest reconciliation run, even with `?allowWarnings=true`; let a COMPLETED run land first.',
      'First load: every supplier default tax rate is held to Xero\'s stored row, and the manifest\'s `maxPurchaseTaxRate` is required whenever a suppliers file is supplied; run the purchase-rate import first.',
      'Switched-off features need a deliberate decision, not an upgrade step: `wc_invoice_document_enabled` (customer invoice in My Account), `fx_rate_source` (Aelia, default ECB), `eu_vat_regime_mode` (default `adopt_plugin`) and the EU IOSS/VOEC declaration (`npm run eu-vat:preflight`, `eu-vat:seed`) change nothing until set.',
      'Forward migrations apply on deploy (additive columns and tables, plus the Kit table drop above); take the usual backup first.',
    ],
  },
  {
    version: '2.0.0',
    date: '2026-06-12',
    title: 'Tax model, accounting sync, manufacturing-aware reorder, decimal-precision overhaul',
    summary: 'Major release covering 16 cleared release blockers and ~190 PRs since 1.5.0. Highlights: a full VAT/tax-profile model with bidirectional Xero sync, post-push edits for invoices and bills, the Reorder Planning report extended to manufactured products and their raw materials, end-to-end Decimal precision across landed cost / allocation / refund / COGS, hardened cron and webhook authentication, and breaking changes operators must action before deploying.',
    userMessage: 'IMS 2.0 brings compound and reverse-charge VAT with Xero round-trips, lets you edit invoices and bills after they have synced, and surfaces manufactured goods plus their raw materials in one Reorder Planning report so you can generate POs and draft MOs in a single click. See the release notes for actionable operator changes (cron auth, settings connection-test gate, upload storage roots).',
    userHighlights: [
      'VAT rate profiles in Settings > Accounting: ordered components, compound math (e.g. GST + PST 12.35%), reverse-charge flag, reporting category (DOMESTIC / REVERSE_CHARGE / EC_SALES / OSS).',
      'Multi-component VAT rates auto-sync to Xero TaxRates with the matching TaxComponents on every save.',
      'Sales invoices and purchase bills that have already pushed to Xero now sync edits back as updates instead of silently dropping the change. QuickBooks logs a clear "not supported" warning.',
      'Failed accounting updates surface as an amber alert on the related sales order or purchase order with connector, timestamp, retry count, and a safe error message.',
      'VAT analytics report groups and filters by reporting category; OSS and reverse-charge entries no longer mix with domestic.',
      'Reorder Planning report covers manufactured products: BOM rows show the most recent manufacturer (or "Manufactured in-house"), raw materials show "Needed for" each parent BOM with their demand rolled up, and a "Generate POs + draft MOs for visible rows" button creates draft orders in one click.',
      'Sales allocation now distinguishes physical reservations from backorder demand; allocation activity logs include the backorder breakdown so operators can see why an order sits in a status.',
      'Report description and methodology notices now hide behind an (i) tooltip next to the title, freeing ~24px on every analytics page for the data table.',
      'Mintsoft booked-in webhook flow is more reliable: HMAC binds the freshness timestamp, acknowledgements wait for durable persistence, retries are configurable and queryable, reconciliation uses direct ASN lookup.',
      'Integration settings now require a successful connection test before sync can be enabled (Xero / WooCommerce / Mintsoft / SMTP) — the test result, timestamp, and configuration fingerprint are persisted and re-checked on save.',
    ],
    technicalHighlights: [
      'TaxRateComponent schema + idempotent migration; TaxRate gains isCompound / reverseCharge / reportingCategory and a components relation. Effective rate snapshotted on document lines so historical documents stay stable.',
      'AccountingSyncType extended with SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, TAX_RATE_SYNC; processor handles each with payload-derived idempotency keys (DB-level dedupe + Xero-level idempotency).',
      'lib/connectors/xero/tax-rates.ts wraps POST /TaxRates; lib/accounting/tax-rate-sync-trigger.ts queues a sync when an IMS TaxRate with components is saved.',
      'queueSalesInvoiceForOrder, createInvoice, and updateInvoice emit multi-component WARNING logs via shared lib/accounting/multi-component-warning.ts. Reverse-charge tax-type swap on both sales and purchase paths.',
      'getReorderReport rebuilt as a two-phase loader: candidates first, BOM-driven component demand folded into reorderPoint, then filter. Latest ProductionOrder labels BOM supplier column. createReorderMOs creates DRAFT ProductionOrders copying manufacturer + warehouse from the latest MO.',
      'PO currency/rate edits now rebase line + freight + parent base amounts inside a single transaction; FX resolver lifted into a dedicated rate-only update path.',
      'Decimal precision overhaul across landed-cost recalculation (Decimal throughout, revaluation audit runs), allocation availability (Decimal arithmetic), refund correctness (return-stock idempotency now includes return warehouse, restocking requires shipped-stock evidence), COGS entries (six-decimal consumed quantities), cost-layer snapshots (Decimal-safe six-decimal strings).',
      'Manufacturing WIP and cost-layer timing align with finance expectations; manufacturing domain helpers extracted into testable modules.',
      'Inventory invariant SQL collector + integration outbox payload registry with backoff retry give operators introspection into ingest health.',
      'Report CSV exports moved metadata out of per-row schemas into trailing comment rows and base64url-encoded X-IMS-Export-Metadata response header (breaking change for column-pinned consumers).',
      'High-volume Xero daily batch journals split into multiple entries per day with deterministic hash suffixes; reconciliation groups by payload metadata (batchDate / batchGroup / batchReferenceId).',
      'Account-balance snapshots now have a daily cron dependency (GET /api/cron/account-balance-snapshot) — production-readiness check treats stale runs as a blocker.',
      'Upload storage roots are now environment-configured: UPLOAD_STORAGE_DIR for private uploads (supplier invoice PDFs) and PUBLIC_UPLOAD_STORAGE_DIR for branding/avatar assets.',
      'Invoice PDF uploads can be scanned before storage via FILE_SCAN_MODE=command with a configurable quarantine + scanner command.',
      'Decimal boundary guard, integration outbox registry, and the inventory invariant SQL collector tighten precision and observability across the stack.',
      'CHANGELOG and docs/help-docs cover the full cycle; legacy production-readiness blockers plan moved to docs/completed/.',
      'Breaking: production cron endpoints now require bearer authentication by default (CRON_SECRET). Update existing production crontabs to include the Authorization header; emergency bypass is explicit and narrow. Fresh installs are handled by scripts/install.',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-04-19',
    title: 'Onboarding company-step flow cleanup',
    summary: 'The onboarding wizard now uses a single Next action on Company Details, which saves the form and advances without a redundant separate save button.',
    userMessage: 'The Company Details step in onboarding is simpler: Next now saves your details and moves you forward in one action.',
    userHighlights: [
      'Removed the separate Save Company Details button from onboarding.',
      'Made Next save the company details step and advance in one click.',
      'Added coverage for the Company Details Next flow in end-to-end tests.',
    ],
    technicalHighlights: [
      'Moved the company-step save trigger behind the shared onboarding navigation so the footer action can persist state before changing steps.',
      'Bumped the visible release version and release notes for the onboarding flow change.',
    ],
  },
  {
    version: '1.4.1',
    date: '2026-04-19',
    title: 'Deployment script hotfix',
    summary: 'The bundled production update script no longer aborts after printing recent commits during a git-based deploy.',
    userMessage: 'Deployment automation is more reliable: the bundled update script now completes cleanly when showing recent changes from git.',
    userHighlights: [
      'Fixed the bundled update script so git-based production updates complete cleanly instead of aborting after printing recent commits.',
    ],
    technicalHighlights: [
      'Replaced the pipefail-sensitive `git log | head` pipeline in `scripts/update.sh` with a single `git log --max-count` invocation.',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-04-19',
    title: 'Onboarding, opening stock import, and profitability usability',
    summary: 'New instances now have a guided onboarding flow, opening stock can be imported directly by warehouse, and the product profitability report is easier to work with on larger datasets.',
    userMessage: 'Onboarding is smoother for new installs, opening stock can be imported in bulk, and the product profitability report now has pagination, column visibility, and better scrolling.',
    userHighlights: [
      'Added a guided onboarding setup flow for new instances with tighter integration gating.',
      'Added opening stock CSV import by SKU, warehouse, quantity, and base unit cost.',
      'Improved the product profitability report with pagination, column visibility controls, and scroll behavior fixes.',
    ],
    technicalHighlights: [
      'Hardened FIFO, allocation, refund, shipment, and landed-cost accounting flows across the Xero and commerce workflows.',
      'Fixed CSV import regressions and added end-to-end onboarding coverage for the new setup workflow.',
    ],
  },
  {
    version: '1.3.1',
    date: '2026-04-17',
    title: 'Bundle fulfillment hardening and help consolidation',
    summary: 'Bundle and BOM handling now uses stronger fulfillment safeguards, mirrored help files are centralized, and duplicate component configurations are flagged before they proliferate.',
    userMessage: 'Bundle and BOM workflows are safer: duplicate component setups are flagged, help content is unified, and stock/accounting behavior is documented more clearly.',
    userHighlights: [
      'Added warnings when a bundle or BOM matches the exact component makeup of an existing bundle or BOM.',
      'Expanded bundle, BOM, shipment-only fulfillment, and refund guidance across the in-app help.',
      'Unified mirrored help content so the app and repo share one maintained source of truth.',
    ],
    technicalHighlights: [
      'Added component-signature matching for KIT/BOM configuration warnings and enforced barcode uniqueness in the database and product flows.',
      'Added bundle fulfillment coverage and component-allocation migration work, plus live WC-to-Xero bundle refund E2E coverage.',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-04-16',
    title: 'Shopify integration setup and stock sync',
    summary: 'Integrations now includes a real Shopify connector screen with credential setup, manual stock sync, and connector-aware sync visibility.',
    userMessage: 'Shopify can now be configured in Integrations, with manual stock sync, sync logs, and Shopify link support where matches are resolved safely.',
    userHighlights: [
      'Added a Shopify connector screen in Integrations for credentials and webhook-secret setup.',
      'Added manual Shopify stock sync and visible Shopify sync log history.',
      'Added Shopify product and sales-order admin links where the IMS can resolve a safe Shopify match.',
    ],
    technicalHighlights: [
      'Implemented the first real Shopify connector layer and shared shopping-facade wiring.',
      'Added duplicate-SKU safeguards, webhook retry-safe rejection, and Shopify sync log persistence.',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-04-16',
    title: 'QuickBooks Online accounting connector',
    summary: 'QuickBooks Online is now available alongside Xero, with end-to-end accounting sync and OAuth setup in Integrations.',
    userMessage: 'QuickBooks Online can now be connected in Integrations and used for accounting sync alongside Xero.',
    userHighlights: [
      'Added QuickBooks Online as a fully available accounting connector.',
      'Added QuickBooks setup and selection in the Integrations dashboard.',
    ],
    technicalHighlights: [
      'Implemented the full QuickBooks connector, including OAuth, account sync, transaction sync, and payment polling.',
      'Updated the accounting facade, OAuth callback, and cron routes to dispatch to the active accounting connector.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-04-16',
    title: 'Visible app version in System Settings',
    summary: 'Added the current release number directly to the System Settings header for faster support and deployment verification.',
    userMessage: 'System Settings now shows the current app version directly in the page header.',
    userHighlights: [
      'Added a visible version badge to the System Settings header.',
      'Kept the Releases tab as the place for fuller release history and notes.',
    ],
    technicalHighlights: [
      'Bumped the application release to 1.1.0 and recorded it in the repo changelog.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-04-16',
    title: 'Release tracking and operational hardening',
    summary: 'Introduced repo-backed release versioning, user-visible release notes, deployment hardening, and health checks.',
    userMessage: 'New product profitability analytics are live, login protection has been tightened with Turnstile, and the app now shows release updates directly in the UI.',
    userHighlights: [
      'Added the Product Profitability analytics view.',
      'Added Turnstile protection to password login.',
      'Added in-app release notifications and a release history view in System Settings.',
    ],
    technicalHighlights: [
      'Added connector groundwork for Shopify and QuickBooks, including multi-connector shopping foundations.',
      'Hardened install and update scripts for git-based deployments, Prisma generation, and webhook routing.',
      'Added a real /api/health endpoint for deployment checks.',
    ],
  },
]

export const CURRENT_RELEASE = RELEASES[0]

export function getReleaseNotificationId(version: string): string {
  return `release-${version.replace(/\./g, '-')}`
}

type ReleaseNotificationData = {
  id: string
  userId: string | null
  type: string
  title: string
  message: string
  actionUrl: string | null
}

type ReleaseNotificationStore = {
  createMany(args: { data: ReleaseNotificationData[]; skipDuplicates: boolean }): Promise<{ count: number }>
  findUnique(args: {
    where: { id: string }
    select: Record<keyof Omit<ReleaseNotificationData, 'id'>, true>
  }): Promise<Omit<ReleaseNotificationData, 'id'> | null>
  update(args: {
    where: { id: string }
    data: Omit<ReleaseNotificationData, 'id'>
  }): Promise<unknown>
}

function releaseNotificationHasDrift(
  existing: Omit<ReleaseNotificationData, 'id'>,
  desired: Omit<ReleaseNotificationData, 'id'>,
): boolean {
  return existing.userId !== desired.userId
    || existing.type !== desired.type
    || existing.title !== desired.title
    || existing.message !== desired.message
    || existing.actionUrl !== desired.actionUrl
}

export async function ensureCurrentReleaseNotificationInStore(
  notificationStore: ReleaseNotificationStore,
): Promise<void> {
  const release = CURRENT_RELEASE
  const id = getReleaseNotificationId(release.version)
  const title = `What's New in ${release.version}`
  const actionUrl = '/help/releases'
  const desired = {
    id,
    userId: null,
    type: 'info',
    title,
    message: release.userMessage,
    actionUrl,
  }

  const created = await notificationStore.createMany({
    data: [desired],
    skipDuplicates: true,
  })
  if (created.count > 0) return

  const existing = await notificationStore.findUnique({
    where: { id },
    select: {
      userId: true,
      type: true,
      title: true,
      message: true,
      actionUrl: true,
    },
  })

  if (!existing) return

  const desiredUpdate = {
    userId: desired.userId,
    type: desired.type,
    title: desired.title,
    message: desired.message,
    actionUrl: desired.actionUrl,
  }

  if (releaseNotificationHasDrift(existing, desiredUpdate)) {
    await notificationStore.update({
      where: { id },
      data: desiredUpdate,
    })
  }
}

export async function ensureCurrentReleaseNotification(): Promise<void> {
  await ensureCurrentReleaseNotificationInStore(db.notification)
}
