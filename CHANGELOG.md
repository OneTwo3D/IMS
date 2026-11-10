# Changelog

This repository uses an `x.y.z` release scheme.

- Increment `x` for breaking changes.
- Increment `y` for user-facing non-breaking changes.
- Increment `z` for backend-only non-breaking changes that do not affect users directly.

Every stage or production deploy cuts a version: see "Cut a release" in [docs/development.md](docs/development.md).

## Unreleased

### Xero accounting audit fixes: bill VAT, supplier-document tax types and payment dates

- **Fixed: bill VAT uses each line's own rate.** IMS recorded a bill's VAT as the order's total VAT divided by its goods subtotal, so goods 100 at 20% plus vatable freight 50 recorded 45 of VAT (a "30%" rate) instead of 30, and a mixed-rate order billed in part was wrong too. The bill's VAT is now the sum of each billed line's own rate on its own net (a vatable cost line at the order's rate, a non-vatable one at none), so its total agrees with what Xero computes from the tax types. Tax types sent to Xero are unchanged.
- **Fixed: a supplier bill or supplier credit note line with no tax type is refused, not posted as "No VAT".** The connector defaulted a blank type to `NONE`, so input VAT recorded in IMS was not claimed in Xero. A blank type, or an unexplained explicit `NONE`, now fails the sync row (*NOTHING WAS SENT...*, naming the line) before anything is sent. `NONE` is posted only where IMS decided it: a cost line marked not vatable, a rate that is itself "No VAT", or a credit note against a bill with no VAT. Bills queued before this change with a non-vatable cost line need one edit-and-save.
- **Fixed: the payment poller and the payment reconcile read Xero's `/Date(ms)/` dates.** `FullyPaidOnDate` was read with `new Date()`, which is an Invalid Date for Xero's `/Date(1750000000000+0000)/` form, and a missing date became "now". Both now go through one Xero date parser (zone-less ISO is read as UTC). A paid invoice whose date is missing or unreadable is skipped with a WARNING on the activity log (`payment_date_unreadable` / `bill_payment_date_unreadable`) and `paidAt` is not set; the poll cursor is not held, and the payment reconcile lists the document.
- Help: *Xero sync*, "Supplier bills and supplier credit notes: no tax type, no document" and "Bill VAT: each line's own rate".

### Mintsoft order push: landed creates, merged orders, holds and cancels the warehouse cannot honour

- **A create that timed out or lost its link write is no longer parked for good.** The sweep (and **Replay** on the "Create outcome unknown" row) now looks the order up in Mintsoft by read only, and links it only when exactly one live order of this client carries this order's own number AND its own reference, read back by id. Anything else (another reference, several matches, a full 10-row result page, a cancelled order, a read that fails) stays parked with the reason on the row. The same rule applies when Mintsoft answers a create with "Order Number already exists!": a cancelled order keeps its number, and IMS no longer links to it. A create that landed but whose link write failed keeps the id Mintsoft returned instead of discarding it.
- **Verification is stricter.** An order is proved ours only when it carries both the number IMS sent and its own reference, exactly, and a present status other than cancelled. A missing field leaves it unverified (retried, then quarantined for an operator); a cancelled order is never proved ours.
- **Merged orders are detected.** When Mintsoft merges an order into another, IMS no longer cancels or holds the surviving order for one absorbed order, because it also holds the other order's goods. A hold or cancel that finds the order gone (404) does one read-only search: a flagged same-client survivor that lists this order's number as a part re-points the link to it as merged and raises a "merged" notice with a note for the warehouse; a search that cannot tell (an error, a full page, several candidates) is retried for 5 sweeps and then raises an operator notice; only a conclusive "no such order" gives the plain not-found notice. A merged-order create that was absorbed is parked with guidance that names the survivor and says not to cancel it.
- **A 404 is no longer recorded as a successful cancel or hold,** and a hold or cancel past NEW no longer dead-letters the link. The link stays live so a later despatch is still recorded, and **Sync > Exceptions** shows "Hold not honoured" / "Cancel not honoured" rows with the reason. The warehouse gets one note per notice; a failed note is retried until it is posted. A notice is cleared when the IMS order leaves the held or cancelled state. A cancel on a backordered Mintsoft order now works, and an order Mintsoft already cancelled is reported as already cancelled rather than as a fresh cancellation.
- **A despatch is refused for an order IMS no longer intends to ship.** If an order is cancelled, or fully refunded and not yet despatched, in IMS when the warehouse despatches it, the despatch is not applied (no shipment, stock movement or storefront write, split orders included). It surfaces as a stuck despatch for a person to decide. The decision follows the order's current state, so a cancel that was reversed does not block a real shipment.
- **Migrations (additive, nullable, no backfill):** `20261110100000_wms_push_link_operator_notices` adds `hold_notice_at` and `cancel_notice_at` to `wms_order_push_links`; `20261110120000_wms_push_link_notice_comment_delivery` adds `hold_notice_comment_at` and `cancel_notice_comment_at`. Existing links read as "no notice".
- **Not changed:** IMS never removes an absorbed order's items from a merged survivor (Mintsoft allows it; that is an owner decision), and nothing in a notice changes an order's status, stock or money.

### Sales order, refund dialog and PDF figures: one basis, reconciling

- **Fixed: the order page no longer grosses its figures up a second time.** Line totals, subtotal and shipping were multiplied by the order's header rate whenever the display flag said "prices include VAT", so a WooCommerce order (stored net) or an order whose lines carry a different rate (for example 0%) showed a subtotal larger than its total. The page now follows the basis the amounts are stored in (`storedAmountsIncludeVat`), takes each line's own VAT, grosses shipping up exactly as the invoice is sent, labels every column and total "incl. VAT" or "excl. VAT", and says so on screen if the figures do not add up to the stored total.
- **Fixed: the refund dialog now shows, and sends, the credit note.** It used to send quantity x the typed unit price as the NET refund, so on a VAT-inclusive order the credit note added VAT to a gross price (28.80 confirmed, 34.56 credited). It now sends the refunded line's stored net pro rata and shows net, VAT and the credit-note total incl. VAT before Confirm; the Refunds panel and the invoice dialog show the same credit-note figure from the same helper.
- **Fixed: partial refunds of one line can no longer add up to more than the line.** An operator-typed refund is now cut on the server, under the order lock, from what the order line has left (the last remaining unit takes exactly the remainder), and the per-target ceiling is enforced for every manual refund. The dialog's figure is a preview of the same calculation. Refunds posted from storefront sync and chargebacks are unchanged.
- **Fixed: a refund entered by hand can no longer offset the ceiling.** It carries order lines only (no discount line, no amount attributed to no order line), and its credit note, grossed up at the rate it posts under, must stay within what the customer paid for each line. Storefront sync, chargebacks and the exception inbox are unchanged.
- **Fixed: a hand-entered refund line must match its target.** A shipping row naming an order line, or a line that is not on the order, is refused, and a line can never be refunded above its own remaining quantity (two lines of one product no longer lend each other units).
- **Fixed: a refund's header total is the sum of its lines in each currency column.** It used to be converted from the base sum, so many small foreign lines drifted by their per-line base rounding against what the credit note posts.
- **Fixed: the refund row-shape checks run on the request as sent**, so a negative-quantity row with no money beside a valid row refuses the whole request instead of being dropped silently while the rest is recorded.
- **Fixed: a hand refund must refund units.** A line-linked sale row with quantity 0, and any refund quantity that is negative or not a number (for every caller), is refused, and a legacy negative quantity never counts as a credit in the quantity history, so -1 then +2 can no longer record 2 refunded against 1 sold. Amount-only rows remain for the internal storefront and inbox paths.
- **Fixed: each row of a hand refund is valued at the rate it will post at in the cumulative VAT ceiling** (a reversal such as the discount at no VAT when its code cannot be priced, never at a higher rate), so a changed default tax code cannot let a full refund exceed what was paid.
- **Fixed: earlier refunds are valued at the rate each was posted at in the cumulative VAT ceiling, so a mixed-rate order can be refunded line by line in either order**, and the refund dialog now previews the order discount the server reverses (one shared function), showing the recorded figure if it differs.
- **Fixed: a full refund of an order with an order-level discount is possible again, and reverses the discount.** The server adds the refunded share of the discount as one negative discount line (the same mirrored line a chargeback raises, posting under the order default's identity), never taken from the caller; earlier refunds' reversals are tracked and the refund that completes the order takes the exact remainder.
- **Fixed: a hand-entered refund cannot over-credit a foreign-currency order through its shipping row.** The shipping row's base amount is derived from its amount in the order currency at the order's booked rate (a stated base that differs is refused), and the cumulative credit note net, and the same grossed up at the rate each row posts under, are held to what the order was paid in its own currency.
- **Fixed: a hand-entered refund line takes its product from the order line it refunds**; a different (or missing) product is refused, so a line's money cannot be taken without its stock. A credit note's total is summed from unrounded amounts and rounded once.
- **Changed: a recorded credit note's VAT and total are marked "≈" / "est."** because they are priced at the current tax rate; the accounting system holds the posted figure.
- **Fixed: the PDF VAT rows put the shipping/discount VAT in the order's default-rate row**, or print it as a separate "VAT adjustment" row when the order has no default rate; the rows still add up to the stored VAT.
- **Fixed: a credit note is shown on the column and at the VAT rate it posts.** On a base-currency order the base column posts (a refund line may carry money in only that one), and the VAT is read from the tax code persisted on the refund line, using the same definitions the credit-note payload uses.
- **Fixed: the sales order and invoice PDFs print one basis.** Lines, subtotal, discount and shipping are all gross or all net (labelled), the VAT rows reconcile with the Total, and a gross-basis document states the VAT it includes after the Total.

### One invoiced-revenue basis across the revenue and receivables reports

- **Changed: revenue is what has been invoiced, on every report.** An order counts if it is not cancelled and not a draft, paid or not, and it has an IMS-posted Xero invoice or, during the parallel phase, the invoice number Xeroom generated for a WooCommerce order (an invoice number IMS generated itself does not count until the invoice is posted). The dashboard, Sales Statistics (including the Details tab, now "Invoiced sales details"), Sales Analytics, Customer Mix, Gross Margin, the COGS report, product profitability, the forecast ABC ranking, Currency Summary and customer turnover all use the one definition (`lib/domain/sales/invoiced-revenue-basis.ts`). The Xero daily batch and the VAT report keep their own bases on purpose.
- **Changed: reports bounded by invoice date use one date.** The invoice date, else the paid date, else the order date, with the order-date fallback flagged as approximate (notice, marker and CSV column). Nothing writes `invoicedAt` for Xeroom orders, so the VAT tax point is untouched.
- **Changed: AR Aging, Customer Aging, the Invoices tab balance and the Currency Summary receivable share one balance** (`lib/domain/sales/receivable-balance.ts`): invoice total less credit notes less receipts, in the base currency, as of the report date. An order marked paid counts as settled, cash refunded out goes back on the receivable, a paid and credited order shows as a customer credit balance, own-currency payments reduce the receivable at the order's booked rate (exchange differences are FX gain or loss, not receivable), and a figure that includes a credit or payment that could not be placed exactly is marked less-than-or-equal or approximate, on screen and in the CSV.
- **Changed: customer lifetime value and turnover are VAT-inclusive on the invoiced basis with refunds netted**, converting an ex-VAT credit at the refunded line's stored tax, and marked when a credit could not be placed.
- **Changed: archived orders are included in every revenue and receivables report.** The retention job only hides old completed orders from operational lists; AR Aging, the Currency Summary and Sales Analytics no longer drop them, so every screen shows the same figures for the same period.
- **Note: during the parallel phase an order with a WooCommerce (Xeroom) invoice number counts as invoiced; IMS does not check that Xeroom's post to Xero succeeded.**

## 3.0.0 - 2026-11-10

### Operator actions (breaking)

Before or after deploying 3.0.0, work through this list. Each line names the topic below that it comes from.

- **Move `DEPLOY_ADMIN_DATABASE_URL` out of the application `.env`** into `/etc/ims-db-admin/deploy-admin.env` (root:root 0600) before deploying: a copy left in `.env` is refused before anything is stopped. Make sure the `<application role>_migrator` migration role exists (`fence-db-connections.mjs --ensure-migration-role` for an external database). See *The deploy admin database credential is root's alone*.
- **Open Settings > System > Scheduler and use Save & Apply once** after deploy, so the new `mintsoft-dispatch-sync` job (every 15 minutes) and the hourly `wc-reconcile` schedule reach an existing crontab. Use a fixed Mintsoft API key for the unattended poll. Then run `npm run read-sync:status` as the application user and confirm it exits 0. Any other exit code is a problem: run `npm run --silent read-sync:status -- --json` and check its scheduler section shows `examined: true`, `unreadable` and `blockProblem` null, and empty `unscheduled` and `disabled` lists (a stale feed exits 1 before a missing or disabled job is reported). See *Mintsoft: the despatch poll is scheduled* and *Reconcile, exports and the pre-call stamp*.
- **Check the Public App URL setting:** it must now be an `https://` URL (`http://` only for localhost or 127.0.0.1) with no whitespace, credentials, query or fragment; a value that fails refuses the crontab write. See *Security: scheduler URL, purchasing analytics, cost-line journals, WooCommerce test*.
- **Set the shipping and discount accounts under Settings > Accounting** before raising orders with shipping or a discount: such an order is now refused at creation and at finalisation when the account is missing. See *Manual orders and bills: three posting defects*.
- **Cloned orders already shipped before the fix have no invoice** and need one raising by hand; a draft stored as VAT-inclusive with no default rate is not finalised. See *Manual orders and bills: three posting defects*.
- **Map every WooCommerce tax rate and give every sales line a tax type:** a sales invoice or credit note line with no tax type, and a WooCommerce order that moved money on an unmapped or inactive rate, is now refused (a failed row on /sync) instead of posting on "No VAT". Use Settings > Accounting > Tax > Import purchase tax rates from Xero where rates are missing. See *No tax type, no sales document* and *Tax rates: import the purchase rates from Xero's stored list*.
- **Set `wc_sync_product_enabled` and `wc_sync_product_direction` (`to_wc` or `both`) if IMS should push products to WooCommerce:** the default (`from_wc`), a missing value or an unreadable setting now pushes nothing. See *Store fence on orders, product push gating, split-shipment status rule*.
- **A staging clone or previous store that still posts signed webhooks is now ignored** (logged `wc_order_webhook_foreign_store` / `wc_refund_webhook_foreign_store`), and a delivery that names no store is refused; confirm the saved store URL is the live store. Saved WooCommerce credentials are only used with the saved URL, so type the key and secret again when changing the URL. See *Store fence on orders...* and *Security: scheduler URL...*.
- **Deploy helper plugin 1.3.1 to the store to get the partial-shipment status rule** (1.3.0 for the Aelia rates endpoint before `fx_rate_source` can be switched to Aelia); neither plugin is deployed by this release. See *Store fence on orders...* and *Aelia as the exchange-rate master*.
- **Report CSV consumers: exports are data rows only by default.** Append `?metadata=1` to get the trailing `# IMS export metadata` rows back, or read the `X-IMS-Export-Metadata` / `X-IMS-Export-Notices` response headers. See *Retired Kit tables, clean CSV bodies...* and *Reconcile, exports and the pre-call stamp*.
- **Fix products CSV `components` cells to `SKU:qty`** with a plain positive quantity of at most 4 decimals: `1,5`, `2 units` or a part with no `:` now refuses the row's whole recipe. The transfers import also accepts an optional `dispatchedAt` column and invalidates a whole `transferKey` group on a bad row. See *Invoice note path, strict recipe quantities, purchase tax names* and *Manual purchase-order receipts and the warehouse ASN*.
- **The migration drops the `kits` and `kit_items` tables and refuses to run if either holds rows;** inventory aging filtered to type KIT is empty (age the component SKUs instead). Shopify and QuickBooks cards and their `SHOPIFY_*` / `QUICKBOOKS_*` environment variables are gone. See *Retired Kit tables...* and *Parked connectors removed*.
- **Purchasing analytics and Purchase Statistics are now Admin, Manager and Finance only,** and a manufacturing cost line whose account override is not the configured Manufacturing Overhead account is refused until cleared. See *Security: scheduler URL, purchasing analytics, cost-line journals, WooCommerce test*.
- **A manual purchase-order receipt is refused while the line has an open warehouse ASN,** and a purchase order with an open ASN cannot be closed or cancelled until the ASN is booked in or retired; cancelling a part-received order is now "close short" and no longer reverses the received stock. See *Manual purchase-order receipts and the warehouse ASN*, *Purchase orders: edit, close and cancel at every stage* and *Purchase-order lines have a landed-quantity definition*.
- **Deploy gates that call `/api/admin/rollout-readiness` now get HTTP 412 for a PARTIAL, FAILED, running or unrecognised newest reconciliation run, even with `?allowWarnings=true`;** let a COMPLETED run land first. See *Readiness gate and a stricter rollout-readiness endpoint*.
- **First load: every supplier default tax rate is held to Xero's stored row, and the manifest's `maxPurchaseTaxRate` is required whenever a suppliers file is supplied;** run the purchase-rate import first. See *Tax rates: import the purchase rates...*.
- **Switched-off features need a deliberate decision, not an upgrade step:** `wc_invoice_document_enabled` (customer invoice in My Account), `fx_rate_source` (Aelia, default ECB), `eu_vat_regime_mode` (default `adopt_plugin`) and the EU IOSS/VOEC declaration (`npm run eu-vat:preflight`, `eu-vat:seed`) change nothing until set. See *Customer invoice: publish side*, *Aelia as the exchange-rate master* and *EU IOSS / VOEC rate configuration*.
- **Forward migrations apply on deploy** (additive columns and tables, plus the Kit table drop above); take the usual backup first.

### EU VAT regime resolver and order stamp (decision only)

- **Added: the EU VAT regime resolver** (`lib/domain/accounting/eu-vat-regime.ts`, pure) and the facts it reads from a WooCommerce order (`lib/connectors/woocommerce/sync/eu-vat-facts.ts`): the VAT record, the B2B exemption flag, the gift-card flag, the EAS cross-check and the plugin's recorded VAT account. In the parallel phase (setting `eu_vat_regime_mode`, default `adopt_plugin`) it adopts the storefront plugin's decision from `_o3d_ioss_vat_account` (refusing an order with scheme VAT and no such meta) and records the plugin's conversion (`_o3d_ioss_fx_rate`, `_o3d_ioss_fx_pair`, `_o3d_ioss_threshold_value`); in `decide` mode, after the switchover, it decides IOSS, VOEC or DDP itself (strictly over EUR 150 or NOK 3000, converted at the order date with IMS's own rates), skips an order with no scheme VAT, and refuses one it cannot classify (including an EU-rated order that is not on the scheme). A value within 5% of the threshold, an EAS figure that disagrees, an accounting regime that disagrees with the customs label and an adopted decision that IMS's value test disagrees with are warnings, not refusals. Gift cards are recognised by the order-line flag only (the product-level marker is not imported); in decide mode an unflagged line that could decide the regime, a zero-tax EU order with an unknown B2B flag and tax that the scheme rates do not explain refuse. In adopt mode an incomplete or conflicting plugin conversion record refuses, a conversion pair that is not the order's own refuses, so does a recorded value that contradicts the recorded account or that the plugin's rate does not produce from the order's goods (within 0.02), figures that are present but unreadable (goods and tax amounts, order tax, currency, a non-empty EU VAT record) refuse instead of becoming 0, and an order from before the plugin wrote one is stamped from the account with the conversion recorded as not recorded.
- **Added: the regime stamp on the sales order** (`euVatRegime`, `euVatLineAccount`, `euVatRegimeStampedAt`, `euVatRegimeBasis`) with a forward migration and a database check that a regime travels with its account. It is written once by a compare-and-set and never re-derived. **Nothing builds a document from it yet and nothing calls the writer yet: no posted line, invoice total or credit note changes, and the Sales Invoices switch is untouched.**

### Manual orders and bills: three posting defects

- **Fixed: a manual order with VAT-inclusive prices and "No VAT" as its default rate no longer posts its VAT twice.** The stored amounts cut each line's net out of the typed gross at the line's own rate, but the invoice was sent inclusive or exclusive from the header rate alone, so a £120 line at 20% reached the ledger as £120 net + £24 VAT. That combination (Incl. VAT with no default rate while a line carries VAT) is now refused when the order is saved, in the form and in `createSalesOrder`; with the default rate chosen the order is stored and posted inclusive at the prices typed. The Incl. VAT box is shown even when the rate is "No VAT". A draft already stored that way is not finalised and no invoice is queued for it. Orders already queued or posted are not changed.
- **Fixed: a clone is a Draft until it is finalised like any other order.** Cloning (and any allocation of a Draft) promoted the order straight to Allocated and skipped finalisation, so no sales invoice was ever queued. Allocation now declines a Draft; finalising allocates and queues the invoice once. A clone also carries the source's VAT basis: a manual order's "prices include VAT" flag is copied (it was left at the default, which read an inclusive order's gross prices as net), and a clone of a WooCommerce order is an exclusive document, because the importer stores every amount net whatever the store displays. Clones already made and shipped before this fix have no invoice and need one raising by hand.
- **Added: a draft is not finalised when its invoice would not book to the order's total.** Before finalisation moves anything, the invoice that would be queued is built and its total (from the payload: inclusive or exclusive, shipping and the order discount at the order's default rate) is compared with the order's stored total, within one penny per line plus two. A mismatch refuses the finalisation with both figures. This catches an order whose shipping is taxed differently from its default rate (a WooCommerce order with zero-rated shipping, whose clone cannot carry the shipping rate because the order does not store it), and the next basis defect of the same kind.
- **Fixed: a WooCommerce fee the shop charged no tax on no longer picks up VAT on a re-queued or cloned invoice, and the reconciliation prices tax from the codes actually sent.** A fee stored with no product, no tax rate and no VAT is sent on the no-tax code naming why (as the importer's own invoice does), instead of falling through to the order's taxable code. The invoice-to-order reconciliation now computes an exclusive document's tax from the code each line, shipping and the discount is sent on (a code no single active rate carries falls back to the stored VAT), not from the VAT stored on the order, so a change of code is caught.
- **Changed: a live order whose invoice would not book to its total is refused at creation, and the reconciliation allowance is capped.** `createSalesOrder` builds the invoice from the rows it has just written, inside the creating transaction, and a mismatch rolls the order back (nothing saved, allocated or queued) instead of leaving a live order with only a warning. The allowance is 0.005 per line plus 0.03 (half a minor unit per computed tax figure, the shipping and discount together, and the total), capped at 1.00 in the order currency.
- **Fixed: an invoice is reconciled against the lines the connector will actually send.** Shipping and the order discount are sent only when their accounting account is set; a positive amount with no account used to count in the reconciliation while the connector dropped it, so the invoice posted short of (or over) that money. The Xero builder, the tax-type check and the reconciliation now share one emit decision, and an order with shipping or a discount whose account is not set is refused (at creation and at finalisation) with a message naming the missing account. Set the shipping and discount accounts under Settings, Accounting before raising orders with shipping or a discount.
- **Fixed: finalising a draft, and creating a live order, are each ONE transaction with the invoice.** Finalising a draft used to commit the status, then allocate stock, then build and queue the invoice, and swallowed a failure of the last step, leaving a live order with no invoice. The status flip, the stock allocation and the sales invoice (built, reconciled to the order's total, and queued) now commit together; a failure of any of them (no stock, an invoice that does not reconcile, an unmapped account, a refused or failing enqueue) rolls everything back and the order is still the draft it was. A live order created in the form is invoiced inside its creating transaction in the same way, so it is either saved with its invoice queued or not saved. Only one place decides what basis an order's stored amounts are in: a WooCommerce order is always net (whatever the store displays), any other order follows its "prices include VAT" flag; the invoice builder, the reconciliation, the clone and the chargeback discount all use it, so an inclusive WooCommerce draft now finalises as a 120 invoice for net 100 + 20 VAT instead of being refused.
- **Changed: a live order created with no stock to allocate is created, invoiced, and the shortfall is shown.** Creation (order and invoice) is atomic; allocation is a separate step that may legitimately leave the order unallocated (a backorder), as a WooCommerce import does. The result of that allocation was previously dropped, so a shortfall or a failed allocation was silent unless the allocator happened to log it; it is now returned to the create screen as a warning, and an `allocation_failed` entry is written on the order's activity log where the allocator wrote none.
- **Fixed: two edits of one bill can no longer overwrite each other.** An edit calculates its figures from the bill as it read it; if another edit committed before the bill lock was taken, the late edit is refused with a request to reload, instead of silently replacing the first.
- **Fixed: editing a bill before its first posting reached the ledger is no longer lost.** The queued posting kept the pre-edit figures and went out unchanged, so the ledger and IMS disagreed. The edit is now written into the still-unsent first posting (no update, no second posting) and the transit subledger takes the difference. If the first posting is in flight, was sent but not linked back, or failed after a request left, the edit is refused with nothing saved. A bill created before postings were keyed to the bill has a posting keyed to its purchase order: it is refreshed only when it is provably this bill's (the only bill on the order still waiting for a document, the only such posting, and the same supplier invoice number) and unsent; otherwise the edit is refused until posting is resolved.

### EU IOSS / VOEC rate configuration and parity (configuration only)

- **Added: `TaxRate.schemePostingTaxType`**, the zero-rated Xero tax type an IOSS or VOEC sale's goods, shipping and discount lines will post on (for example `TAX131` for DE VAT 19%), beside the existing reporting category (`IOSS`, `VOEC`) that marks the rate. A nullable column with a forward migration. **Nothing reads it to post a line yet and the Sales Invoices switch is untouched**; the invoice treatment follows in later changes.
- **Added: a versioned declaration of the 65 live WooCommerce rates** (`lib/tax/eu-vat-seed.json`), `npm run eu-vat:preflight` (read only: what is missing or mismatched against the database and the stored Xero list) and `npm run eu-vat:seed` (a dry run unless `--apply --confirm <digest>`; sets only the two rate fields through the WooCommerce mappings, stamped for the configured store). WooCommerce rates on the same Xero type share one IMS rate (the 33 on `ZERORATEDOUTPUT`); the set-identity report accepts exactly that declared sharing. A change of Xero organisation now also clears `schemePostingTaxType`. Nothing writes a tax rate to Xero and nothing applies the declaration automatically.
- **Added: a parity test** (`tests/tax/eu-vat-parity.test.ts`) that judges the declaration against the measured Xeroom resolution of every one of the 65 rates, and **a drift check** that the hourly tax-rate sweep now makes, by code, on every rate's scheme posting type.
- **Added: settings.** Three Xero account roles (*EU IOSS/VOEC VAT collected*, *EU DDP charges collected*, *EU landed-cost fees*) and two credit-note hold settings (`eu_vat_refund182_hold_threshold`, `eu_vat_refund182_held_count`); configuration only. A tax re-key now copies `schemePostingTaxType` to the replacement rate.

### Purchase orders: edit, close and cancel at every stage

- **Changed: a purchase order can be edited from Draft through Part-received.** An order nothing has touched (no goods received, no supplier bill, no return, no warehouse ASN) is fully editable at RFQ Sent, Quote Received, PO Sent and Shipped, so quoted prices can be entered and a typo in quantity, price or warehouse corrected after sending. Once goods, a bill or an ASN touch it, it is amended in place: line ids are kept, received, billed or returned lines keep their price and cannot be removed, a quantity cannot go below what was received, billed or returned, and supplier, currency, exchange rate and VAT are fixed. On a part-received order with freight or cost lines, quantity and line-set changes are refused because they would change the cost of goods already in stock.
- **Changed: Close and Cancel are available at every stage from RFQ Sent to Part-received.** With nothing received, Close ends Closed and Cancel ends Cancelled. A Draft can only be cancelled and a fully received order can only be closed.
- **Changed: cancelling a part-received order no longer reverses the received stock.** Cancel and Close are now the same operation on a part-received order, **close short**: the unreceived balance is dropped, the received stock, its cost layers and its journals stay as they are, and the order ends Closed (shown as "Closed short: received 60 of 100"). No reversal movement or journal is created. To take received goods back out, use Return Items first. The confirmation says exactly what will happen, with the quantities.
- **Changed: closing short re-spreads the order's freight over the units that arrived.** The freight on the order (its own cost lines and linked freight orders) was spread over the full ordered quantity at receipt. Closing or cancelling a part-received order now spreads all of it over what landed (BY_VALUE by landed value): the remaining cost layers are revalued, the sold units' share goes to cost of sales, in-transit units carry theirs, and the journals (DR Inventory / CR Transit, DR Cost of sales / CR Transit) are posted behind the usual holds, once. A freight credit larger than the goods cost is floored at 0.00 with a warning. Other orders sharing a freight order keep their own share. Orders without freight post nothing.
- **Changed: an order with an open warehouse ASN cannot be closed or cancelled, and its lines cannot be reduced or removed,** until the ASN is booked in or retired. Closing with a supplier bill for more than was received succeeds with a warning naming the lines and the amount billed ahead of receipt.
- **Fixed: a supplier return on a part-received order no longer strands the unreceived balance.** The order stays Part-received while any quantity is still due, so it can still be received, edited, closed or cancelled and stays in the incoming figures; it moves to Partially Returned or Returned only when nothing is left to receive. An order already stranded in Partially Returned can be closed or cancelled. A return is also refused if the order was closed while it waited.

### Store fence on orders, product push gating, split-shipment status rule

- **Fixed: stores without pretty permalinks are recognised.** A signed `?rest_route=/wc/...` self-link on an order or refund delivery yields the exact site root (scheme, host, site path; `index.php` and the query dropped), so it is no longer held for ever as an "under the store" statement. **Accepted limits, documented in the WooCommerce guide:** a credential rebind landing between the origin check and the import write can let one in-flight delivery through (pause webhooks around a rebind), and a product push already past its final settings read completes.
- **Fixed: a WooCommerce webhook worker whose claim had expired can no longer overwrite the row after it was reclaimed, dead-lettered or replayed.** Every claim of a `shopping_webhook_events` row now increments a never-reset `claimGeneration` (new column, default 0), and the processed / failed / dead-letter writes match on it and on status PROCESSING; a stale finisher changes nothing and is logged as `shopping_webhook_stale_claim`. Sync > Exceptions lists and replays dead letters only for connectors whose inbox is drained (WooCommerce), so archived rows are not offered.
- **Fixed: order and refund webhooks are now judged on which store sent them, as product webhooks already were.** A staging clone (or the previous store) that still posts correctly signed deliveries is acknowledged, logged at ERROR as `wc_order_webhook_foreign_store` / `wc_refund_webhook_foreign_store`, and imports nothing. A delivery that names no store is refused too. An order or refund whose sender cannot be proven exactly (unreadable store URL setting, or only a location under the store) is held: answered 503, logged `wc_order_webhook_held` / `wc_refund_webhook_held`, retried, then visible and replayable under Sync > Exceptions. Evidence that is only the unsigned `X-WC-Webhook-Source` header counts as unproven for orders and refunds (recorded as `store-header:`), and an unreadable store URL is checked before any evidence is judged, so such a delivery is held rather than acknowledged. Sync > Exceptions now lists dead-lettered store (WooCommerce) webhook deliveries and offers **Replay** for them (the dead-letter section previously listed only the warehouse tables).
- **Fixed: the IMS to WooCommerce product push honours `wc_sync_product_enabled` and `wc_sync_product_direction`.** It pushes only when sync is enabled and the direction is `to_wc` or `both`; the default (`from_wc`), a missing value or an unreadable setting pushes nothing. This covers product create, edit, variant changes, deactivation and CSV import. The check runs before the producer seam and again immediately before the write.
- **Fixed (helper plugin 1.3.1, not deployed by this change): the partial-shipment route no longer changes the status of an order that is not in flight.** Parts are still recorded, but the status moves only from `processing` or `partial-shipped`; a cancelled, refunded, on-hold or completed order is left alone with an order note. Custom in-flight statuses opt in with the `oti_partial_shipment_status_eligible` filter (strictly boolean `true`). The store keeps the old behaviour until plugin 1.3.1 is installed.

### Supplier portal drafts, supplier landing, customer list columns

- **Fixed: the supplier portal no longer shows a buyer's unsent draft purchase orders.** The RFQ list, the RFQ detail page, quote submission and the RFQ PDF route all accepted a DRAFT order, so a supplier could see (and quote on) quantities and products the buyer had not sent. Suppliers now see an order as an RFQ only from RFQ Sent; the Purchase Orders list also hides drafts and cancelled orders that were never sent. All supplier-facing reads share one definition (`lib/domain/purchasing/supplier-portal-visibility.ts`).
- **Fixed: the RFQ PDF route reads once.** Ownership, sent-status and the rendered data now come from one query scoped by id, the session's supplier and the sent-order predicate (a miss is a 403), so a reassignment or status change between a check and a reload cannot leak another order's data.
- **Fixed: submitting a quote no longer ends on a 404.** The order moves to Quote Received on submit, and the detail page 404'd for that status. A quoted RFQ now opens read-only with a "Quote submitted" confirmation.
- **Fixed: a supplier logging in lands on the supplier portal, not an error screen.** `/` and `/dashboard` send a SUPPLIER to `/supplier/rfqs`; the dashboard query no longer runs for a supplier.
- **Fixed: the customers list showed only the Name column.** The default column set was returned as a function instead of being called. Saved column preferences are now merged over the defaults, so a partial saved preference no longer hides every other column.

### Security: scheduler URL, purchasing analytics, cost-line journals, WooCommerce test

- **Fixed: the Public App URL is validated strictly and cannot inject into the managed crontab.** The value is stored as typed, so a newline (or a quote, `$`, backtick, `%`) inside an otherwise parseable URL became part of the crontab. It must now be an `https://` URL (`http://` only for `localhost` or `127.0.0.1`) with no whitespace, control or shell characters, credentials, query or fragment. The crontab builder applies the same rule to the stored value and refuses to write the crontab if it fails. Saved cron schedules were already validated field by field and are unchanged.
- **Fixed: the five purchasing-analytics pages (open POs, purchase price variance, spend, supplier performance, lead times) are restricted to Admin, Manager and Finance,** matching their CSV export and the sidebar. Other roles are sent back to the dashboard before any report is read.
- **Fixed: editing manufacturing cost lines needs the cost-price permission, and an account override must be the configured Manufacturing Overhead account.** A warehouse user could previously queue a reclass journal to any account code. An existing line whose override is some other code is refused on the next save until the override is cleared.
- **Fixed: Purchase Statistics (page, its data actions and the purchasing CSV types) follows the same Admin/Manager/Finance rule.** It was open to every role holding the analytics permission, including read-only users, and returned supplier names and unit and landed costs.
- **Changed: the Public App URL is stored in canonical form and `https:example.com` style values are refused.** The raw text must start with `https://` (or `http://` for localhost); the stored value is the parsed lower-case form.
- **Changed: the cost-line account override is checked where the journal is built.** Completing an order, and editing the costs of a completed order, now stop with a message naming the cost line when its stored account is not the configured Manufacturing Overhead account, instead of posting to it. An edit also acts on the order status read under the row lock, so a completion that lands first is no longer missed. The override is not checked while accounting posting is off.
- **Changed: the crontab renderer keeps accepting operator-supplied internal base URLs** (`http://127.0.0.1:3000`, a private container name) because they come from the install command line, not from a setting; only the Public App URL setting, and the stored value when the in-app crontab is rebuilt, must be https (or loopback http).
- **Fixed: saved WooCommerce credentials are only used with the saved store URL.** Testing or saving a different URL with a masked key or blank secret is refused; the key and secret must be typed in the same request. The saved URL, key and secret are read in one query, and a save that reuses them re-checks the stored URL under its lock.

### No tax type, no sales document

- **Changed: a sales invoice or credit note line with no tax type is refused instead of posting on "No VAT".** The Xero connector no longer defaults a missing `TaxType` to `NONE` on sales invoices, sales invoice updates or credit notes (supplier bills and supplier credit notes are unchanged). The refusal is an ordinary failed sync row on /sync, raised at the head of the poster case and again in the connector, before any contact, item or document request. An explicit `NONE` is refused too unless the line names an allowed kind; the only one today is a WooCommerce fee the shop charged no tax on. Shipping and the order discount can never be on `NONE`.
- **Changed: a WooCommerce order that moved money on an unmapped or inactive tax rate has its invoice refused.** Previously an unmapped rate id was replaced by the default rate and a mapping to an inactive IMS rate posted as if it were live. The invoice is now marked at import and refused at the poster with the rate ids named, and no payment is registered against it. See *No tax type, no document* in the Xero sync guide.

### Invoice note path, strict recipe quantities, purchase tax names

- **Fixed: the WooCommerce invoice note, the invoice-link order meta and the invoice-document marker are now sent to the right route.** Their paths had no leading slash, so the transport built `/wp-json/wc/v3orders/...`, which does not exist; the writes (and the read of the order's existing notes) failed as if the store were down. A source scan now refuses any literal WooCommerce request path without a leading slash.
- **Fixed: the products CSV `components` cell is read strictly.** Each part must be `SKU:qty` with a plain positive quantity of at most 4 decimal places. A quantity such as `1,5`, `2 units` or `3abc` used to load as 1, 2 and 3 with nothing reported, and a part with no `:` silently took quantity 1; both are now refused by name, and the whole recipe for that row is not written (as for an unknown component SKU). The quantity is what follows the last `:`, so a component SKU that itself contains `:` still round-trips through the product export.
- **Fixed: a purchase order that names its tax rate by name now resolves it the way the purchase-order importer does.** `createPurchaseOrder` and `updatePurchaseOrder` looked the name up exactly (and among every active rate, sales-only ones included), so a file that passed the importer's check took no rate at all. A rate id still wins. A name alone matches active PURCHASE or BOTH rates, comparing names trimmed, with runs of spaces collapsed and case ignored (stored names are not trimmed, so a stored `VAT ` matches `vat`); a sales-only or inactive rate never matches. Tax names are not unique, so if several rates still match, the one that spells the name exactly is taken, and otherwise the order is refused with `choose the rate by id` and nothing is written. A line's own rate is an override, so it is never used to settle which default was meant. A name that matches nothing takes no rate, as before (callers send a bare header name with a value, for example a "No VAT" supplier).

### Retired Kit tables, clean CSV bodies, and a retention exemption that lifts itself

- **Removed: the unused Kit and KitItem tables and the KIT-filtered component view of inventory aging.** A KIT's recipe is its component list, which every allocation and availability reader already uses; Kit and KitItem had no writer and one reader. Inventory aging filtered to Type KIT now returns an empty report with a notice (age the component SKUs instead), and the "KIT mode" summary and the kit-components source label are gone. A new forward migration drops `kits` and `kit_items`; it refuses to run if either table holds rows, so nothing is lost silently (production is schema-only).
- **Changed: report CSV exports are data rows only by default.** The trailing `# IMS export metadata` rows, which standard CSV parsers read as records, are now added only when the request carries `?metadata=1`. The same metadata still travels in the `X-IMS-Export-Metadata` response header on every export that has it, and the dashboard's CSV download links (sales analytics, inventory costing, inventory ledger, stock position, supplier aging) request `?metadata=1`, so a download from the dashboard still carries the period totals and disclosures that exist only as metadata. Affects the stock-position, inventory-ledger, inventory-costing (COGS, valuation, landed cost), sales-analytics and supplier-aging exports.
- **Changed: the retention exemption for refund-park recovery rows lifts itself.** The verification runner records in a new `migration_verification_passes` table when every check of a migration returned zero, and a later failing run removes the record. Once the record for the sync-log record-kind migration exists, the sweep keeps only the witnessed sync-log rows that check 7 would accuse (now shaped or stamped as a held sales invoice); a clean witnessed row expires by age like any settled row. A required migration whose `verify.sql` goes missing, or an unapplied one, also loses its record. Databases that already passed record it on their next deploy.

### Reconcile, exports and the pre-call stamp

- **Changed: the daily WooCommerce stock catch-up no longer reads the whole catalogue in one cron request.** The forceAll reconcile takes the candidates in id order, 150 at a time, saves a cursor (`wc_stock_daily_reconcile_cursor`) after each window and stops taking windows once about 20 seconds of the request are used, so the proxy's 60 s cut-off is not reached. An unfinished pass continues on the next run even inside the 24-hour window; `last_wc_stock_daily_reconcile_at` is written only when the last window is done. A window cut short by an outage or a credentials rebind keeps the cursor and is retried. The registered `wc-reconcile` schedule changes from daily (`0 4 * * *`) to hourly (`0 * * * *`) so a pass finishes within a day; an existing install keeps its crontab until the next crontab reconcile (Settings > System > Scheduler > Save & Apply, or the next app start that reconciles it), and while webhooks are not the primary order/product source the order and product polls now also run hourly. A window counts as done only when every product in it completed without error (any failed SKU lookup, preflight page or push entry, a mapping that could not be saved or was cleared, a duplicate WooCommerce id, or a kit availability error): any such error keeps the cursor and the stamp where they are, retries that window on the next run and writes a `stock_reconcile_window` warning to the activity log. The saved cursor carries the WooCommerce settings version and is dropped (the pass restarts) after a rebind or cache reset. A refusal before the first window (setting, credentials, warehouses) is no longer stamped as a reconcile, so the pass is due again once the configuration is restored. A product that becomes eligible behind the cursor waits for the next pass. The manual push is unchanged.
- **Fixed: the replenishment (reorder, backorder, component shortage) and manufacturing (production variance, WIP) CSV exports no longer lose the report's notices.** Products with no claimed recipe and started orders with no usable frozen recipe were named only on screen. The CSV stays data rows only; the notices are in the new `X-IMS-Export-Notices` response header, and they are appended after the data as `# notice` rows, in full, only with `?metadata=1` (the in-app CSV links add it) or `?notices=1`.
- **Fixed: the orphan sweep and the sale-cancel invoice sweep stamp `abandonedBeforeRemoteCall` only on a row that carries the canonical never-attempted record** (no attempt stamp, custody present), not on revision 0 alone. A legacy or revived revision-0 row is still retired, but unstamped, so it reads as unknown rather than proven not posted.

### Customer invoice: publish side (off by default)

- **New: IMS can tell the storefront to show the stored invoice in My Account.** A new outbox operation `woocommerce/order.invoice-document` (ownership-map operation `woocommerce.order.invoice-document`) sets the order meta `_ims_invoice_pdf_available` for an order whose stored invoice document IMS would serve. **It is off:** nothing is scanned, queued or written unless the setting `wc_invoice_document_enabled` is exactly `true`, and every write also meets the producer-side hold, the live-from cut-off and the attempt fence. An order created before the storefront's live-from instant is never queued. `npm run writers:check` lists the operation with that setting as its switch.
- **Fixed: a retried invoice note no longer posts a second note.** A failing or held meta write made the whole call fail, and the queue retried it by posting the note again. The note is now written at most once per ledger invoice id (new table `invoice_store_publications`), and the note writer no longer writes the customer download flag; that is the separate writer above. The invoice-note follow-up no longer writes the flag at all: it is written only by its own guarded job, for a stored document.

### Manual purchase-order receipts and the warehouse ASN

- **Changed: a manual purchase-order receipt is refused for a line that still has an open warehouse ASN.** An ASN that is being created at the warehouse (including one demoted after a create whose result was never verified), open, or booked in but not yet reconciled (and not closed) means the goods are booked in through the ASN; receiving the same SKU by hand beside it could not be told apart from the units the warehouse will book, and the stock for different units was silently never added. The message names the SKU and ASN. Other lines of the same order, and lines whose ASN is fully booked in or closed, can still be received by hand. An unclaimed ASN reservation (nothing ever sent to the warehouse) does not block. The ASN table gains a nullable `remoteCreateAttemptedAt` column to tell the two apart.
- **Added: the transfers CSV import reads an optional `dispatchedAt` column** (`YYYY-MM-DD`, read as 12:00 UK time, or an ISO date-time with an offset) for IN_TRANSIT and RECEIVED rows, so a transfer dispatched before the first load carries its real dispatch moment. A row that fails validation now invalidates its whole `transferKey` group (nothing is created for it) instead of creating the valid rows alone. It moves only the dispatch stamp (and so the stranded-in-transit clock), not the stock movement.

### Ops alerting and chart-of-accounts refresh

- **Added: a daily, read-only refresh of the Xero chart of accounts (`xero-chart-sync`, 00:30).** It reads Xero's Accounts list with one GET, stores the whole chart and advances its own read-sync last-success stamp in one connection-fenced transaction; the read-sync liveness alarm now watches it (a seventh feed, stale after 36 hours). An on-demand refresh from the Sync page does not advance the stamp.
- **Changed: the scheduled invariant check also notifies admins about a short named set of warnings.** `stock_cost_layer_quantity_mismatch`, `transfer_stranded_in_transit`, `accounting_sync_failed`, `refund_missing_credit_note_sync`, `refund_missing_reversal_sync` and `refund_reversal_record_undecidable`. It notifies only when a code newly appears or its count rises since the previous complete run; critical findings notify exactly as before.

### WooCommerce invoice notes are floored by the WooCommerce live-from instant

- **Fixed: a queued WooCommerce invoice note is judged against `WC_WRITES_LIVE_FROM`, not `XERO_WRITES_LIVE_FROM`.** The note is a WooCommerce write that rides the accounting queue. Its claim, selection, re-queue refusal and last check before sending now use the WooCommerce cut-off, and every Xero write keeps the Xero one. Before this, a note created after the Xero instant but before the WooCommerce one would have been sent while the former writer still owned that write. `npm run outbound:status` counts the note under WooCommerce, with its own floor. Nothing changes while the producer hold is not enforced.

### Paid-order retry and cancelled-order follow-ups

- **Fixed: a paid WooCommerce order whose total or currency differs from what IMS holds is no longer acknowledged and forgotten.** The delivery still records no receipt and writes its finding (`wc_paid_total_differs` / `wc_paid_currency_differs`), but it now also leaves a durable retry row in the pending queue (written in the same transaction, under the order lock). The scheduled `fx-rates` run replays the stored snapshot on every pass, so correcting the IMS order records the receipt without another WooCommerce delivery. The row is retired only when the receipt is recorded or the order is paid by another route, a retry of a still-mismatched order never marks it done, and after 60 retries it is retired FAILED with an ERROR finding (`wc_paid_block_retry_gave_up`) and a notification to the administrators.
- **Fixed: the invoice email and the WooCommerce invoice note are not sent for a cancelled order.** They are not queued when the invoice posts for a cancelled order (`invoice_followup_not_queued_cancelled_order`), and a row queued before the cancellation is retired CANCELLED with the reason when it drains (`invoice_followup_refused_cancelled_order`), checked under the order lock cancellation takes. The invoice PDF copy is still saved. A payment is decided by when the money arrived against the database-stamped cancellation time, as before: dated after the cancellation it is held (the overpayment path is not built), otherwise it registers.

### Manufacturing recipe readers: history is frozen, planning counts the claimed recipe

- **Fixed: production variance no longer moves when a recipe is re-imported.** Planned consumption is now computed from the recipe frozen onto the order when it started (`componentSnapshot`), the same record consumption and costing use, instead of the live recipe. A started or completed order with no frozen recipe (started before recipes were frozen, or an unreadable snapshot) is left out of the report and named in a note under it; it is never measured against the live recipe.
- **Fixed: planning counts only the claimed recipe.** The replenishment report's component-demand explosion no longer adds the items of every active recipe that lists a product as parent, so a stray duplicate recipe cannot double component demand. Automatic reorder build orders pick the product's claimed recipe instead of the most recently updated one, and a product with no claimed active recipe is skipped with the reason `no_active_bom`.
- **Fixed: the component shortage report plans a started order from its frozen snapshot, and any other open order from the product's claimed recipe,** not from the recipe row the order happens to point at.
- **New: the reorder report names a BOM product that needs building but has no claimed recipe** ("No claimed recipe: component demand not planned ...") instead of silently dropping its component demand. The component shortage report no longer plans a started order with a missing or unreadable snapshot from the live recipe; it names the order instead (the same rule as variance).
- **Fixed: reservation attribution and WIP valuation of a started order use its frozen recipe,** not the current product components, so a recipe edit no longer misattributes its reservation. A started order with no usable snapshot is named (WIP notice, `unfrozenOrderReferences` on the reservation breakdown) and not attributed or valued from the live recipe. The component shortage report also names draft orders whose product has no claimed recipe.
- **New: a census test** (`tests/products/claimed-bom-reader-census.test.ts`) classifies every reader of the recipe tables and fails when a new planning reader is not scoped to the claimed recipe.

### Aelia cutover hardening

- **Fixed: a pinned currency is covered even when Aelia omits or refuses it.** The switch to Aelia (and the coverage the ingest reports) now checks the latest manual override of every active foreign currency, not only those with a usable entry in Aelia's answer. A pinned USD that Aelia leaves out no longer rolls the switch back; the real lookup still has the final say.
- **New: an Aelia update time earlier than the newest stored Aelia row of a currency is refused for that currency** (`aelia_update_regressed`), in the cutover and in the regular refresh, and nothing is stored for it. At the cutover that currency counts as missing. The cutover also compares what each unpinned currency resolves to (rate and time) with this read and refuses on any difference.
- **Fixed: the Aelia ingest and the override clear re-check the source inside the write lock.** A refresh or clear that was in flight when the source went back to ECB now writes no Aelia row (a discarded refresh is logged as a warning, not reported as a failed read).

### VAT switchover fixes: IOSS and VOEC in R13 and the re-key, region and whitespace in the re-key

- **Fixed: R13 and the tax re-key recognise the `IOSS` and `VOEC` reporting categories.** They were refused as `REPORT_TYPE_UNKNOWN`, so an active IOSS or VOEC sales rate always failed R13. They are now decided by the Xero rate generator (`xeroReportTaxType`): a sales rate named for an EU member state or Norway is filed under `MOSSSALES` and compared with the live type; on any other name the box would only be a guess and stays `REPORT_TYPE_UNKNOWN`. One shared check serves both.
- **Changed: the re-key compares the region of the names, not only the country.** `PT-30 VAT` is read by the parser R13 uses (now in `lib/tax/tax-country.ts`); a candidate whose region differs, or cannot be read (`PT Madeira VAT`), is refused as `COUNTRY_DIFFERS` with the reason. Names with no region suffix behave as before.
- **Fixed: the re-key name tiers collapse runs of whitespace**, as R13 does: a live `AT IOSS  VAT` now matches the IMS `AT IOSS VAT`. The case-sensitive tier still comes first.

### WooCommerce tax-rate writer (IMS to WooCommerce), held at P1

- **New: `npm run woo:tax-plan`.** Plans the WooCommerce tax-rate changes (create, update, delete) that make the store's rates the same set as the IMS sales rates, as the reconciliation pack's VAT set-identity check (R13) defines it, and prints a plan digest. `-- --apply --confirm <digest>` applies exactly that plan, behind the WooCommerce producer hold: while held it records outbound shadows and sends nothing; it is refused if the hold is not enforced. Only rates mapped in the tax-rate mapping and stamped with the current store's address, or created and recorded by the writer against it, are ever touched, and only while they still match what IMS last recorded for them; `-- --adopt` stamps legacy mapping rows after an operator-confirmed digest. Every other writer of the mapping table (tax-rate import, mapper re-map, tax re-key, rate copy script) clears that stamp in the same write when it changes the row's IMS rate or identity snapshot. Shipping is always on for a positive rate. New table `woo_tax_rate_writes` records live changes; new nullable `store_identity` columns on it and on `shopping_tax_rate_mappings`. Nothing sends while the hold stands, and nothing is turned on by this change.

### Aelia as the exchange-rate master (behind a flag, default OFF)

- **New: FX source setting `fx_rate_source` (Settings > Accounting > FX Rates > Exchange-rate source).** `ECB (frankfurter)` is the default and changes nothing. `Aelia` makes the scheduled refresh read the store's currency switcher through the helper plugin, stores Aelia's rate BEFORE markup (never rate + markup) as `source = aelia` dated by Aelia's own update time, checks Aelia's freshness in health, and disables the IMS to WooCommerce rate push. A missing, non-positive, non-finite or over-precise rate, a base-currency mismatch and an unknown currency are refused; nothing is substituted. Manual overrides keep working. Every write takes the FX table lock.
- **New: onetwoInventory Helper plugin 1.3.0** with a read-only `GET /wp-json/oti/v1/aelia-rates` endpoint. It must be deployed (owner-approved) before the flag can be switched on. Not deployed by this change.
- **Changed: the exchange-rate lookup is source-aware.** Under the Aelia source, lookups dated at or after the cutover instant (`fx_rate_source_since`) use only Aelia rows and manual overrides and refuse (`no_rate_from_selected_source`) rather than fall back to ECB; earlier dates are unchanged. The source switch takes the exclusive FX table lock; the rate push holds it shared through its POST; ECB writes re-read the source inside the lock.
- **Changed: ownership row `woocommerce` / `fx-rates` is now P1 aelia, P2 aelia** (owner ruling 2026-10-26; was P2 IMS).

### VAT difference report: Xero, IMS and WooCommerce on one set of VAT rates (read-only)

- **New: `npm run vat:diff` and Settings > Accounting > Tax > VAT rate differences.** Compares the stored, proven Xero tax-rate list, the IMS rates (with components and the WooCommerce mappings) and WooCommerce's `GET /taxes` (every page, through the reconciliation pack's GET-only transport) and lists each difference with a closed reason code (missing in IMS, Xero or WooCommerce, percentage mismatch with both values, inactive in Xero, IMS rate with no Xero type, WooCommerce rate with no mapping, ambiguous mapping, country, class, compound or shipping mismatch), as four reports (UK, IOSS, VOEC, other foreign; `--scheme`) plus a visible unclassified section. A Xero type is present in IMS only on a side an active rate usable on that side carries it (Sales needs a revenue type, Purchases an expenses type). Regional WooCommerce rates are compared like any other rate (the region is shown as information); shipping must carry the goods' rate. A stale or untrusted Xero list, or a WooCommerce read that fails, refuses the report instead of saying "no differences". Writes nothing anywhere.
- **New: ownership row `woocommerce` / `tax-rate`: P1 operator-manual, P2 IMS** (owner ruling 2026-10-25). At P1 the owner corrects WooCommerce by hand from the report. No producer exists yet.

### Tax rates: import the purchase rates from Xero's stored list; the first load imports before it refuses

- **New: Settings > Accounting > Tax > Import purchase tax rates from Xero.** Creates the missing active Purchases rate for each of `INPUT2`, `ZERORATEDINPUT` and `NONE` from the stored Xero tax-rate list (name, exact rate, components, tax type). Never calls or writes to Xero, never invents a rate, never deletes a row and never changes an existing row's rate or type; a re-run changes nothing. A type Xero does not list, does not mark `ACTIVE` or does not allow on expenses is refused by name and gets no row. Opt-in: narrow sales-only "Both" rates to Sales, and deactivate rates whose type Xero does not list as active (default: report only). Needs a stored list that is intact, stamped, read within 26 hours and for the connected organisation.
- **New: the import mirrors Xero's rates on both sides** (owner ruling: one set of VAT rates, Xero master). Sales rates are created under the same rules, a percentage that differs from Xero's is reported (replaced only on request, by a new rate and a deactivated old one), and the action returns a machine-readable rate set for a later storefront sync plus the rates that have no Xero counterpart. No WooCommerce write.
- **Changed: the first load imports a supplier's purchase tax rate from Xero before it refuses** (owner ruling). A plan reports what the import would create and writes nothing; the apply imports, all or nothing, inside the suppliers step lock and then re-checks strictly. `tax_rates` / `tax_rate_components` are now tables the runner may write.
- **Changed: the first load holds every existing supplier default tax rate to Xero's stored row** (rate column and effective rate); a difference or an unusable stored list refuses (`SUPPLIER_TAX_RATE_DISAGREES_WITH_XERO`, `SUPPLIER_TAX_XERO_UNTRUSTED`). The fix is the import with replace-differing.
- **Changed: every supplier's default tax rate is held to the manifest's `maxPurchaseTaxRate`** (`SUPPLIER_TAX_RATE_ABOVE_MAX`); the maximum is now required whenever a suppliers file is supplied (`SUPPLIER_TAX_MAX_UNDECLARED`).

### Reconciliation pack: R1, Mintsoft stock against IMS on-hand (read-only, behind `--vendor-reads-only`)

- **New: R1 compares IMS `stock_levels.quantity` with Mintsoft's on-hand figure (`TotalStockLevel`) per (warehouse, SKU), exactly, and settles (D7).** It runs only with `--vendor-reads-only`; without the flag no credential is read and no request is made (`VENDOR_READS_OFF`, which the gate reads as not available). Population: Mintsoft-bound warehouses that are active, sync-enabled and whose alignment is unconfirmed, decided in the same IMS snapshot as the stock and read again after the Mintsoft reads (`BASIS_MOVED` if it changed); linked or Mintsoft-listed SIMPLE, VARIANT and BOM products; KIT products and Mintsoft bundle rows are set aside; a kind mismatch or a product-id swap is `IDENTITY_CONFLICT`. When every alignment is confirmed the claim is retired and R1 passes on the named proof `alignment-confirmed` without asking Mintsoft. The full rules are in the installation guide under "Reconciliation pack" (vendor items).
- **New: a GET-only Mintsoft reader that can never log in** (`lib/connectors/mintsoft/reconciliation-read.ts`). It uses the stored fixed API key only and refuses (`VENDOR_AUTH_REFUSED`, no request) unless `mintsoft_auth_mode` is exactly `api_key`; it has no path to `POST /api/Auth` (which mints a new tenant key and would knock the order sweep and the label service offline), never refreshes a 401, and gives the connector fetch seam a gate that allows exactly `GET /api/Product/StockLevels?WarehouseId=<n>` and `GET /api/Product/List?PageNo=<n>&Limit=<n up to 100>`. The environment fallbacks `MINTSOFT_AUTH_MODE` and `MINTSOFT_STATIC_API_KEY` are not read by the pack.
- **Changed: `GET /api/Product/List` is on the Mintsoft read allow-list** (a read; any other method on that path is still a write). The connector itself does not call it; the pack's product census does.
- **New: the pack proves the Mintsoft lists it compares.** Stock lists ignore paging, so every bound warehouse is read in two full sweeps whose combined populations must be identical; the product list is scanned twice at a page size clamped to 100, each scan proven by exact pages, an empty page after the short last page, no repeated id or SKU and equal contents, and every product a stock list shows must be in it. Anything else is a closed reason and no list at all.

### Reconciliation pack: the comparators and the report writer (no item runners yet)

- **New (backend only, nothing runs yet): the core of the reconciliation pack** in `lib/reconciliation-pack/`. It holds the R1 to R15 catalogue (claim, tolerance rule and value, cadence, phase applicability, dependent streams), pure keyed comparators (identity on one side only, differing, unsettled, outside the recorded population, excluded; counts derived from the lists; exact quantities to 0.0001, absolute tolerances, the R5 composite and the order-currency minor-unit rule), the rule that a difference fails only after two later successful runs of its stream (distinct last-success stamps, never ordered), closed reason codes, and the identity-token sanitiser. It also holds the report writer (evidence file, Markdown, then the JSON as commit record, a hash chain by sequence, an exclusive run lock) and the trend reader that verifies every pair and the chain. There is no command and no vendor call yet, and the readiness gate does not read it yet. The exit-code table, the reason and refusal codes, the item catalogue and a table of the failure classes the design guards against are in the installation guide under "Reconciliation pack".
- **A pass must prove itself, and a live lock holder is never displaced.** In the report builder and again in the reader, an item may only be a pass if it carries a proof (identities compared, or a named proof that an empty population is true), exactly its catalogue sources, and an equal start and end stamp for every stream it depends on; fail, inconclusive and not-applicable have their own invariants. The run lock is reclaimed only when its holder is provably dead (process gone, or start time or boot id changed), never by age; where that cannot be shown the run is refused. The commit claims its sequence number with an exclusive file and links the JSON into place without overwriting.
- **The comparator no longer reads an unreadable input as equal.** A key part that is not a non-empty string or a safe whole number (an object, NaN, negative, empty, a control character) refuses the row (`BAD_KEY`) instead of sharing one canonical form with every other such value. A value-bearing comparison needs a decimal on both sides of every row (`VALUE_MISSING`); presence-only comparison is a mode fixed per item in the catalogue (R13, R14), never a fall-through. A minor-unit comparison checks both currencies against a known list and has no default number of decimals (`CURRENCY_UNKNOWN`); minus zero reads as zero; a missing tolerance, mode, completeness flag, population set or carried state is refused. The installation guide lists every refused input shape with its code, and a test runs a case for each.
- **The evidence now proves what the report claims, and the builder serialises nothing the caller owns.** Every identity, equal ones included, is a line of `evidence.jsonl`; the reader recomputes every count and the digest of the equal identities from those lines and re-judges each line against the item\'s catalogue row (the value shape of its mode, the true delta, the tolerance verdict of the catalogue measure, the currencies). The input is copied field by field into plain objects (unknown fields, accessors, symbol keys, Proxies, class instances, holes and oversized lists are refused), and the finished report passes the reader\'s validation before any file is created.
- **A bucket is derived from what an entry records, and only compared identities prove anything.** Every entry records whether each side had the identity (explicit presence flags); the builder and the reader derive the bucket of a pair entry from those fields in both modes and refuse a label that disagrees (a one-sided identity can no longer be published as an equal one). The comparator issues its "compared" proof only for equal, in-population, non-excluded identities; excluded, out-of-population and unsettled identities are listed but prove nothing, and a comparison with only those needs a named empty-population proof or is inconclusive. A table test runs every combination of buckets in both modes from the comparator to the parsed report.
- **No free-form field reaches output, and a credential-shaped SKU is digested.** The system identifier is exactly what PostgreSQL produces (10 to 20 digits); the lock\'s host is a DNS-style name; every field that can reach the JSON, the Markdown, the evidence, a file name or the lock has an anchored allowlist grammar in a single-sourced table that a test checks against a real published report. Identity tokens keep their allowed-character pattern and now also pass a credential screen (a credential-ish word, a 24-character opaque run, or over 64 characters means a `sku#` digest is printed instead). Tokens are trusted data keys and the screen is defence in depth; the installation guide lists what it does not cover.
- **Changed (internal):** `readTrustedRegularFileBytes` returns the bytes `readTrustedRegularFile` decodes, so a digest can be taken over exactly what was parsed.

### First load: the apply runner core (no database side yet)

- **New (backend only, nothing runs yet): the core of the first-load apply runner** in `lib/first-load/apply/`. It reads and verifies a prepared run from bytes (every file against the prepared report's SHA-256, size, rows and the importer's header; unique keys; every parent, component, warehouse, FX rate and zero-cost pair backed by the files or refused; WooCommerce variant parents only from a re-verified snapshot), computes per step which rows are still to load, and drives plan, apply and resume through ports. The accounting is taken from the database, never from the importers' counters. It opens no database or network connection and adds no command yet. Documented in `docs/first-load-apply.md`.

### Payments: several payments on one invoice, told apart by the receipt

- **Fixed: a balance recorded after a deposit that had already posted is no longer refused.** The last check before a payment is sent judged every payment already sent against the invoice, so a posted deposit blocked its own balance (and a failed one blocked the next receipt). IMS now identifies a payment by the receipt (payment row) it was recorded for. A *different* live receipt never blocks, a *repeat of the same receipt* is always refused, and a registration that cannot be shown to belong to a different receipt (imported before this change, or whose receipt was deleted) still blocks. One rule is shared by the registration decision, the final check, the over-settlement guard and the manual retry, so they cannot disagree. A deposit's payment in Xero is recognised by the reference IMS wrote on it, never by amount and date.
- **Changed: a paid WooCommerce order is imported with a payment row**, and the payment registered in Xero carries that receipt's identity. A hand-recorded receipt on the same order therefore registers normally.
- **New: `sales_orders.cancelled_at`** is stamped by the database when an order becomes cancelled. Receipts can now be recorded on a cancelled order; one dated after the cancellation is held (nothing sent, a warning says so) because Xero books that money as an overpayment, which IMS does not create yet. Paid before or at the cancellation, or with no known cancellation time, registers as before.
- **Unchanged on purpose:** a payment above what is outstanding is still refused (Xero refuses it too), so no excess is ever posted as a payment.

### Mintsoft: the despatch poll is scheduled, and a bundle create is not repeated after an uncertain send

- **The `mintsoft-dispatch-sync` job is now a registered scheduled job (every 15 minutes, on by default).** The installation guide always listed it as automatic, but nothing scheduled it, so a despatch in Mintsoft did not progress the IMS shipment unless someone added a crontab line by hand. **Upgrade step: open Settings > System > Scheduler and use Save & Apply once** so the new job reaches an existing crontab. The poll only reads from Mintsoft, does nothing while the Mintsoft plugin is off, and **never logs in**: a username/password login replaces the tenant API key for every integration that shares it, so with a fixed API key the poll runs, and in username/password mode it runs on the stored key and skips with a reason once that has expired. Use a fixed API key for an unattended poll. The read-sync liveness check now names the job and reports the poll as off when the job is switched off.
- **Fixed: a Mintsoft bundle create that may have been sent no longer releases its claim.** A timeout, a dropped connection or an unusable answer used to delete the claim, so the next run could send the create again. The claim is now kept, the bundle is looked up straight away (a read) and linked only if it matches IMS, and no further create is sent by the clock: a claim whose create may have reached Mintsoft stays until a lookup returns a complete, matching bundle or an operator resolves it on **Sync > Mintsoft > Bundles** (link the Mintsoft bundle, or state that a search found none; that release is refused until the create can no longer be in flight and a fresh lookup reads "no bundle", and it is audited in the same transaction). A worker re-checks its claim immediately before sending (and sends nothing if it changed) and never overwrites a link written meanwhile; a process frozen for longer than the release window between that check and the send can still duplicate, which Mintsoft's lack of idempotency prevents IMS from closing. Only a claim marked as never sent is ever retaken; legacy `pending:<time>` claims count as sent. A bundle answer with component entries IMS cannot read is never compared or linked. A create the outbound-write hold refused before it left still releases its claim. Adds no environment variables.

### Readiness gate (`npm run readiness:gate`) and a stricter rollout-readiness endpoint

- **New: `npm run readiness:gate -- --phase P0|P1|P2`** reduces the switchover checks to one verdict (GO, GO-WITH-ACCEPTED-WARNINGS, NO-GO) with a JSON and Markdown report. It performs no database or checkout write. Documented in docs/installation.md, "Readiness gate".
- **Changed behaviour of `/api/admin/rollout-readiness`: a PARTIAL newest accounting reconciliation run now BLOCKS (HTTP 412, including with `?allowWarnings=true`).** It used to be a warning that `allowWarnings=true` turned into 200. A FAILED newest run also cannot prove completeness, and a RUNNING, queued or unrecognised-status newest row (the newest row of ANY status, not the newest finished one) blocks with a message saying a run is in progress or unrecognised; only a COMPLETED run can clear an earlier truncation; an unreadable newest-run read is a blocker instead of a warning; a truncated newest run is a blocker; runs created at the same instant are read together and judged as the worst of them, and never clear each other's truncations.

### WooCommerce initial-import rehearsal (`npm run rehearse:woo-import`)

- **The real initial order import can now be rehearsed against a local fake WooCommerce store.** It runs the
  actual import and allocation code into a throwaway PostgreSQL cluster and writes a JSON and Markdown report
  (orders fetched, imported and skipped with reason; R9 and R4; the orders that imported but cannot be
  allocated; a second pass that must import nothing; stock landing later; the one-shot stamp). It never
  contacts a real host, never writes (the report proves no request but GET reached the store and the
  outbound-write hold refused nothing), and a rehearsal pass never sets the completion stamp or moves the
  sync cursor (`runInitialImport(progress, { stampCompletion: false })`; the Sync page's own path still
  stamps). Documented in docs/installation.md, "WooCommerce initial-import rehearsal".
- **`wcFetch` (reads only) accepts a loopback `http` store when `E2E_TEST_MODE=1` and `NODE_ENV` is not
  `production`**, the same condition the stored-URL check already applied. Writes do not.

### The deploy admin database credential is root's alone (o3d-1bgr, o3d-bpbv)

- **The application account no longer holds, inherits or can read the admin database credential.** It used to
  sit in the application's own `.env`, was handed to the account on `runuser ... env VAR=secret` command lines
  (readable in `ps`), was inherited by every command started as that account whenever it was typed on
  `sudo env ...`, and the fence helper itself ran as that account. The credential now lives in
  `/etc/ims-db-admin/deploy-admin.env` (root:root 0600 in a root:root 0700 directory) or on the root
  invocation; the fence helper runs as root with a scrubbed environment and nothing secret on any command line;
  the exported variable is un-exported at once. **A copy left in the application `.env` is refused before
  anything is stopped**, naming the file to move it to.
- **The migration no longer connects as the admin.** `options=-c role=<app>` is a session default, so
  `SET ROLE NONE` on that connection was the superuser admin, handed to application-owned bytes (prisma, the
  migration SQL, package scripts) for the whole window. The migration now logs in as a role with no privilege of
  its own (`<application role>_migrator`, created by `install.sh` for a local server; for an external database
  `fence-db-connections.mjs --ensure-migration-role`, or the three statements in docs/installation.md), with a
  fresh random password minted for each window and sent as a SCRAM verifier, and closed again by the release.
  The server is asked, not the configuration: a migration role that is a superuser, holds CREATEROLE/CREATEDB/
  REPLICATION/BYPASSRLS, reaches a role the application cannot, cannot `SET ROLE` to the application role, has no
  `CONNECT` of its own or cannot be altered by the admin is refused by `--preflight` before anything is stopped.
- **A migration role this tool did not create is never adopted** (marker comment; refused before any grant, in one
  transaction), a marked role that owns or is granted anything of its own anywhere in the cluster, carries per-role
  settings or reaches a role the application cannot is refused by `--preflight`, the minted URL keeps only
  transport-trust query parameters from the admin URL (an admin URL carrying `password=`, `user=`, `host=` and the
  like is refused) and is opened once to prove it authenticates as the migration role, and a release whose login the
  server cannot confirm closed now FAILS (retryable) instead of reporting success, **before any CONNECT is
  restored** (the login is closed first; a failure leaves the fence standing). The audit also refuses a marked role
  holding anything beyond CONNECT on the application database, and any direct membership besides the application
  role (PostgreSQL 16+ INHERIT/SET options are not trusted to compare).
  A release that fails after its grants may have committed now reports `FENCE_STATE=held|restored|unknown` read from
  the ACL on a fresh connection, and the three entrypoints and the wrapper clear their "fence is up" state on
  anything but `held`; `--preflight` and `--fence` (again at the end of the drain) refuse a migration login that is
  already open (LOGIN or a stored password). The fresh state read must be on the same server as the release (else
  `unknown`), and the password check no longer requires a superuser admin (separate `pg_authid` statement, only when
  the admin may read it). An unreadable system identifier never matches in the release probe (`unknown`). The
  single-cutover-host assumption is documented.
- **The operator recovery wrappers** read the root file, run the helper as root, and (o3d-bpbv) take the cutover
  lock first, resolve the documented pointer once, hash that directory and execute the helper by the resolved
  path, so a publication landing between the hash and the exec can no longer substitute a different release.
- **Operator action on upgrade:** move `DEPLOY_ADMIN_DATABASE_URL` out of `.env` into the root file, and make sure
  the migration role exists. A fresh installation needs neither step. No migration.

### First-load preparation tool: validates and prepares the incumbent exports for the existing importers (o3d-zjsb5)

- **New command `npm run first-load:prepare`, file in and file out (no database, no network).** It reads Qoblex, 3PL and
  WooCommerce export files through a column map (or already-canonical CSVs) and writes importer-ready files with the
  importers' exact template headers, plus a JSON and Markdown validation report that accounts for every input row as
  emitted, excluded or rejected. It checks SKU coverage across the systems, that the recipe graph has no cycle, collapses FIFO
  lots to one exact weighted-average cost per SKU and warehouse, reports zero on-hand separately from missing, reduces open
  purchase orders to the outstanding quantity, counts in-transit stock once, and splits files below the importers' row and
  size caps. Any rejected row blocks the run and no import file is written. The real column maps wait for the owner's sample
  exports; the maps in the tests use invented headers. Reference: `docs/first-load-input-spec.md`. No migration, nothing
  runs at start-up.

### Late landed cost on stock in transit between warehouses now reaches Inventory (o3d-nrl4)

- **A freight order added, edited or cancelled after the goods were bought now posts the share that belongs
  to units still on a warehouse transfer.** The revaluation used to move only the on-hand units' share out of
  Stock in Transit and queued nothing for units dispatched but not yet received (or aligned by the WMS), so
  the freight debit stayed in Stock in Transit and Inventory stayed understated, in a way no reconciliation
  showed. The landed-cost reclass journal (`STOCK_IN_TRANSIT`) now includes those units at the moment the landed
  cost changes (DR Inventory / CR Stock in Transit, reversed for a decrease); the later receipt or dispatch
  cancellation posts nothing. A manual receipt, a WMS book-in and a WMS alignment credit all count as landed.
  The revaluation audit run lists the amounts under `inTransitResidue`. No migration. Amounts left in transit by
  revaluations made before this change are not repaired.

### Purchase-order lines have a landed-quantity definition (o3d-papk, first half)

- **A manual purchase-order receipt can no longer be booked on top of units the WMS stock-sync
  alignment already brought in.** The alignment lands stock and a cost layer without writing
  `qtyReceived`, so the receipt guard saw the whole line as outstanding: aligning 6 of a 10-unit line
  and then receiving 10 by hand put 16 units into stock for 10 physical ones, with a second cost layer
  and a second `STOCK_RECEIPT` journal. The guard now refuses more than `qty − landed`, read inside the
  transaction under the order lock.
- A purchase order is RECEIVED (after a manual receipt or a WMS book-in) once every line has *landed*,
  not only once `qtyReceived` reaches `qty`; the alignment planner caps a PO line at its own residue and
  refuses an ASN whose order is CANCELLED or CLOSED; the EOL-archive incoming figure and the product
  incoming badges count a PO line by what has landed. No migration.
- **A WMS book-in no longer lets a line's landed quantity fall (o3d-papk follow-up, o3d-67kw3).** The booked-in
  reconciliation took the line-wide `qtyReceived` as "manual receipts against this ASN" and applied it before the
  snapshot cover, so align 6, receive 4 by hand, book 6 left landed at 6 and the guard accepted another 4 (stock 14
  for 10 physical units), and a line partly received by hand and then covered by an ASN sized for the rest lost
  units at book-in (line 10, manual 4, ASN 6, booked 6: only +2). The snapshot cover now comes first, the manual
  term draws on a branded pool (the line's unreconciled manual receipts less the new
  `wms_asn_line_maps.manualQtyBaseline`, written when an ASN row is created or resized), and transfer lines get the
  same fix. **Migration:** one additive column, `NOT NULL DEFAULT 0`, no backfill.
- **A purchase-order ASN is sized by what has landed, and a credited reservation is never deleted or resized in
  place (o3d-papk follow-up; the minimal purchase-order half of o3d-6b9c).** A retry, the post-mismatch discard
  and the finalize conflict used to delete the pending reservation, cascading the alignment credit that is the
  only record that units landed (landed fell from 10 to 4 while stock stayed at 10), and the ASN sent to the live
  warehouse was sized `qty − qtyReceived`, so landed units were asked for again. The creator now sizes by landed
  outstanding (branded all the way to the wire), retires a credited reservation (closed, credit kept) and
  reserves the remainder on a new one, disposes under `purchase_orders` → ASN header → ASN lines, returns
  operator refusals so a retirement commits, and refuses to claim a retired reservation (both creators).
- **The WMS stock-sync alignment advances a purchase order's status (o3d-papk follow-up).** An order stocked
  entirely by alignment stayed PO_SENT with `receivedAt` unset. The alignment now derives the status from the
  landed quantity under the order lock it already holds (forward only); the manual receipt and the book-in use
  the same derivation.

- **A WMS booked-in callback no longer receives against a cancelled or closed purchase order, and never overwrites an
  order's status (o3d-papk round 2, o3d-yaazk).** A partly received order cancelled while its ASN stayed open took stock,
  a cost layer and a journal from a later callback and then had CANCELLED overwritten with PARTIALLY_RECEIVED/RECEIVED. The
  callback is now held for review with an approval-blocked `parent_not_receivable` warning, and the status is only written
  along the purchase-order workflow.
- **Two ASN-create requests that reserved the same row can no longer retire or reopen it under each other (o3d-papk round 2).**
  The discard only touches an unclaimed, open reservation, and the finalize is a compare-and-set that fails closed (retaining
  the id of the ASN the warehouse created) instead of reopening a row whose expectation a retirement had rewritten. Both creators.

### Parked connectors removed (o3d-remove-parked-connectors)

- **Shopify (shopping) and QuickBooks Online (accounting) are no longer shipped.** The owner's
  decision (2026-09) is that WooCommerce, Mintsoft and Xero are the active connectors. ShipHero was
  removed earlier under the same decision. The implementations are archived in-tree under
  `archive/connectors/<name>/` — excluded from the build, the type check, the linter and every
  guard — and the last commit in which each was part of the active tree is pinned by an annotated
  tag (`archive/shopify-connector`, `archive/quickbooks-connector`).
- **The generic connector design is unchanged.** The shopping and accounting registries, the
  connector-keyed dispatches, the plugin-selection machinery and the exclusivity-group table all
  stay, and a new connector is still a registration rather than an edit to the core. What went is
  the two concrete implementations and their registrations.
- **What is no longer proven** by the test suite as a result — a shopping registry with two entries,
  a second id routed through the shopping facade, the commerce exclusivity pair, and (for
  accounting) the whole cross-connector orphan surface — is enumerated per connector in
  `docs/archive/shopify-connector-removal.md` and `docs/archive/quickbooks-connector-removal.md`.
- **No migration. No schema change. No data was touched.** Development databases keep their
  `shopify`/`quickbooks` rows; each note states the decision and why.
- Operator-visible: the Shopify and QuickBooks cards, panels, onboarding switches and credential
  forms are gone from Integrations; their `SHOPIFY_*` / `QUICKBOOKS_*` environment variables are
  gone from `.env.example`.

## 2.0.0 - 2026-06-12

### Reorder Planning & manufacturing (cycle PRs #188–#190)

- **Reorder report covers manufactured products end-to-end.** BOM-typed products no longer show "Unassigned" in the supplier column; they display **Manufactured by [name]** using the manufacturer set on the product's most recent `ProductionOrder`, or **Manufactured in-house** when none has been set.
- **Raw materials inherit demand from BOM parents that need replenishment.** For each BOM row whose own `suggestedReorderQty > 0`, every `BomItem.componentProductId` adds `(bomSuggestedQty × bomItem.qty)` to its component's reorder point. Raw materials used by multiple BOMs aggregate demand across all parents; raw materials that are also sellable add BOM demand on top of their sales-driven demand. Products with `reorderQty = 0` (explicit opt-out) stay out of the report unless a BOM is driving demand into them.
- **New "Needed for" column** lists the demand sources per row: `Direct sales` when daily demand > 0, `BOM <parent SKU>` for each contributing parent BOM (sorted + deduped), `Stock policy` fallback when neither applies.
- **One-click "Generate POs + draft MOs for visible rows" toolbar** on the Reorder Planning page. Splits the visible rows by `productType` and routes purchased rows to `createReorderPOs` (one draft PO per supplier) and manufactured rows to `createReorderMOs` (one draft `ProductionOrder` per BOM product, copying `manufacturerId` + `warehouseId` from the product's latest MO, picking the most recently-updated active `Bom` as parent). Operator scopes via the existing filter form.
- **Replenishment CSV export gains the `neededFor` column** (semicolon-joined). Consumers with pinned column maps need updating.
- **Analytics report description + methodology notices fold into a single (i) tooltip** next to each report title. The paragraph below the title and the amber notices box lower on the page are gone; the same content shows on hover or keyboard focus, and the data table sits ~24px higher on every report page.

### Tax & accounting (cycle PRs #169–#186)

- **Tax rate profiles.** `TaxRate` becomes a full tax profile: ordered `TaxRateComponent` rows for compound or multi-element taxes (e.g. Canada GST + PST compounding to 12.35%), a `reverseCharge` flag, an `isCompound` flag, and a `reportingCategory` (`DOMESTIC` / `REVERSE_CHARGE` / `EC_SALES` / `OSS`). The single effective rate is still snapshotted on each document line so historical documents stay stable; the profile metadata drives connector mapping and VAT reporting.
- **VAT analytics report groups by reporting category.** A 20% UK domestic sale and a 20% EU OSS sale now appear as separate rows. A new **Reporting category** dropdown filter scopes the page to one category for OSS or reverse-charge return preparation; the filter round-trips through the URL so CSV exports and pagination links preserve it.
- **Sales invoice edit syncs back to Xero.** Editing a sales order that has already pushed to Xero (`accountingInvoiceId` present) enqueues a `SALES_INVOICE_UPDATE` instead of silently dropping the change. The payload uses the same builder as the create path; a payload-derived idempotency key prevents duplicates on unchanged re-saves. QuickBooks does not support invoice updates and logs `sales_invoice_update_skipped_unsupported_connector` WARNING instead.
- **Purchase bill edits sync back to Xero.** Unpaid bills can be edited from the PO detail page; saving content changes enqueues `PURCHASE_INVOICE_UPDATE` with the same idempotency-key semantics as the sales-side flow. Editability is re-checked inside the transaction to handle concurrent payment correctly.
- **Reverse-charge accounting tax-type swap.** Lines whose `TaxRate.reverseCharge` is true now post to Xero / QBO with the line's `taxType` swapped to a configurable code (`accounting_reverse_charge_sales_tax_type`, typical Xero: `ECOUTPUTSERVICES`; `accounting_reverse_charge_purchase_tax_type`, typical Xero: `REVERSECHARGES`) so the VAT return classifies them on box 1 / box 8. Empty settings preserve existing posting via the parent `accountingTaxType`.
- **IMS → Xero TaxRate sync with `TaxComponents`.** Multi-component IMS `TaxRate` rows now auto-sync to Xero via `POST /TaxRates` with the matching `TaxComponents` payload (idempotent by `Name`) so the VAT return shows the component breakdown without operator hand-configuration. Gated by `xero_sync_tax_rate` setting. QBO has no equivalent API; the trigger logs `tax_rate_sync_skipped_unsupported_connector` instead.
- **Rejected accounting-update alerts.** Failed `SALES_INVOICE_UPDATE` and `PURCHASE_INVOICE_UPDATE` sync rows surface as an amber alert on the related sales-order or purchase-order detail page with connector, timestamp, retry count, and a safely truncated error message. The raw sync payload is never displayed.
- **PO FX rebase preserves consistency.** Currency- or rate-only edits on a DRAFT purchase order recompute every persisted base amount (header + lines + freight cost lines) inside a single transaction. If any subsequent step fails (tax resolution, validation), the entire rebase rolls back — lines never drift away from the parent header.

### Developer-facing

- **Integration settings now require a successful connection test before enablement.** Xero, WooCommerce, Mintsoft, and SMTP connection tests persist their latest result, timestamp, and configuration fingerprint in the settings store. Newly enabling sync features, activating Mintsoft, or saving SMTP transport settings now fails until the current connection settings have passed their test.
- **Report CSV exports no longer repeat report-level metadata on each data row.** Stock-position, inventory-ledger, and inventory-costing exports move fields such as `asOf`, `source`, `generatedAt`, date windows, and opening/closing totals out of per-row schemas. The CSV file now keeps metadata once in trailing `#` comment rows, while API clients can read the same data from the base64url-encoded `X-IMS-Export-Metadata` response header. Consumers with hardcoded column maps should update them to the new row schemas and read metadata from the comment rows or decoded header.
- **Cron endpoint rate limits now include high-frequency headroom and source-IP scoping.** Daily/hourly jobs default to one accepted run per hour, 5-minute jobs allow 15 runs per hour, and 15-minute jobs allow 6 runs per hour so normal scheduling jitter is not denied. Multi-replica deployments must use `RATE_LIMIT_BACKEND=redis` with `REDIS_URL` for cluster-wide login/TOTP and cron throttles.
- **High-volume Xero daily batch journals can split into multiple entries per day.** Tenants posting more than `XERO_DAILY_BATCH_LIMIT` eligible orders or shipments in a daily-batch group receive multiple Xero journals for the same business date. References include deterministic hash suffixes, and reconciliation should sum entries by the shared date/group prefix or payload metadata (`batchDate`, `batchGroup`, `batchReferenceId`).
- **Account-balance snapshots now have a daily cron dependency.** Installations
  should schedule `GET /api/cron/account-balance-snapshot` daily, before
  accounting reports are reviewed, so inventory and COGS GL variance reports
  have previous-day Xero Trial Balance snapshots available. The production
  rollout readiness check treats a missing or stale run as a blocker.
- **Upload storage roots are now environment-configured.** `UPLOAD_STORAGE_DIR`
  stores private uploads such as supplier invoice PDFs and
  `PUBLIC_UPLOAD_STORAGE_DIR` stores branding/avatar assets. Local defaults
  preserve the previous `./uploads` and `./public/uploads` behavior, while
  production logs a warning if either root is unset. Avatar URLs keep the
  historical `/uploads/avatars/*` shape; branding uploads now rotate filenames
  instead of relying on query-string-only cache busting.
- **Invoice PDF uploads can be scanned before storage.** `FILE_SCAN_MODE=command`
  writes invoice PDFs to quarantine, runs a configured scanner command, and
  moves only clean files into final upload storage. Scanner processes receive an
  explicit environment allowlist, rejected quarantine files are deleted for disk
  hygiene, and audit metadata records scan status without scanner output or file
  paths. The default `disabled` mode preserves existing upload behavior.
- **Decimal boundary guard.** Added `npm run check:decimal-boundaries` and wired it into `npm run validate` plus GitHub Actions so guarded domain/accounting paths must document any direct `decimalToNumber` import with a `decimal-boundary-ok:` rationale. The leading rationale token is now a closed vocabulary, and current `legacy-pre-stage-4` annotations mark Decimal conversion follow-up work planned for Stage 4. Developers rebasing older branches that touch guarded paths may need to add or narrow these comments before validation passes.
- **Integration outbox payload registry.** WooCommerce stock-sync, Xero accounting-post, and Mintsoft booked-in outbox operations now have registered Zod payload schemas. Registered payloads are validated and normalized on enqueue and again by connector processors before execution, while unknown outbox operations remain backwards-compatible for existing rows and future connectors.
- **Integration outbox retry backoff.** Retryable IntegrationOutbox failures now use configurable exponential backoff with tail jitter (`OUTBOX_RETRY_BASE_MS`, `OUTBOX_RETRY_MAX_MS`, `OUTBOX_RETRY_JITTER_MS`) instead of the fixed default delay. WooCommerce stock-sync retries now follow the shared 5/10/20/40/60-minute capped curve, extending the 12-attempt time-to-permanent-failure from roughly 6.5 hours to roughly 9.25 hours before jitter. Connector-specific explicit retry delays, such as rate-limit backoff, remain supported.
- **Inventory invariant SQL collector.** Production inventory invariant reports now use a SQL-backed collector with cursor pagination, product/warehouse/severity filters, and bounded cron defaults. The pure row evaluator remains available for fixture tests; scheduled checks surface cap exhaustion as a critical truncation finding and can be tuned with `INVARIANT_CHECK_PAGE_SIZE` / `INVARIANT_CHECK_MAX_FINDINGS`.
- **Manufacturing domain helpers extracted.** Manufacturing costing, disassembly component-consumption planning, and production-order state decisions now live under `lib/domain/manufacturing` with focused unit coverage. Server actions remain responsible for auth, transactions, stock writes, accounting queueing, and UI revalidation.

### Fixes (landed-cost precision)

- **Retrospective landed-cost deltas now use Decimal arithmetic internally.** Cost-layer revaluation now keeps unit-cost deltas, consumed quantities, COGS deltas, and inventory-in-transit deltas as `Prisma.Decimal` until the accounting payload or snapshot-refresh boundary. This removes binary floating-point drift from fractional landed-cost recalculations while preserving existing journal payload rounding, including the pre-existing `Math.round` behavior for negative half-cent deltas. Existing journal entries are not retroactively re-rounded.
- **Landed-cost snapshot refreshes now keep returned quantities and replacement unit costs Decimal-safe until serialization.** Customer and supplier return helpers now return `Prisma.Decimal`, and cost-layer snapshot refreshes accept Decimal inputs before explicitly preserving the existing JSON number shape for `unitCostBase`. Manufacturing cost-layer recalculation now also keeps unit deltas, consumed quantities, COGS deltas, and inventory deltas Decimal-safe until the journal/server-action return boundary.
- **Landed-cost revaluations now write audit runs.** Direct and linked landed-cost recalculations persist before/after cost-layer snapshots, affected COGS refresh counts, planned accounting adjustment idempotency keys, captured warnings such as BY_WEIGHT fallback, and the triggering user where a server action initiated the recalculation.

### Fixes (allocation precision)

- **Allocation availability now uses Decimal arithmetic internally.** Sales allocation stock maps, product graph component quantities, kit requirement expansion, coverage checks, and reservation deltas now keep fractional quantities as `Prisma.Decimal` through the allocation service. This avoids binary floating-point drift when allocating fractional kit/component quantities while preserving existing UI and report number boundaries.

### Fixes (refund correctness)

- **Refund return-stock idempotency now includes the return warehouse.** Split returns of the same refund line to different warehouses no longer collide on the same `RETURN_INBOUND` idempotency key. Because IMS is not live yet, no old-key compatibility path is kept; persistent dev or staging databases with old-shape refund return keys should reset those `RETURN_INBOUND:refund:*:line:*` movement idempotency keys or rebuild the database before replaying refund returns.
- **Refund restocking now requires shipped-stock evidence.** Allocation-only refund rows no longer silently restock from unshipped reservations when no shipment line exists on the original order. Those attempts now return a clear operator message and should be processed as cash-only refunds or corrected to refund a shipped line.

### Fixes (VAT and tax correctness)

- **Sales-order creation now validates caller-supplied line tax assertions.** Import/API callers may pass `taxForeign` per line as an assertion; IMS rejects values that do not match the resolved line tax rate and inclusive/exclusive pricing mode before creating the order. VAT report coverage now separately pins inclusive taxable-base reporting (`totalBase - taxBase`) and exclusive taxable-base reporting (`totalBase`).

### Fixes (manufacturing valuation)

- **Manufacturing WIP and cost-layer timing now align with finance expectations.** WIP reporting includes both consumed component value and manufacturing cost-line totals, production-created cost layers receive the production completion timestamp for FIFO ordering, and manufacturing cost-line parsing now drops sub-half-penny negative rounding dust while still rejecting real credit-style negative adjustments.

### Fixes (purchase cancellation and freight)

- **Purchase-order cancellation and linked freight receipt guards are stricter.** Cancelling a partially received PO reverses remaining receipt cost layers, and repeated cancellation of an already-cancelled PO is now idempotent. Linked freight POs can only auto-receive from committed states (`PO_SENT`, `SHIPPED`, `PARTIALLY_RECEIVED`, `RECEIVED`), blocking draft, RFQ, and quote freight orders.

### Fixes (stock and cost-layer precision)

- **Stock removals require FIFO cost-layer coverage.** Negative stock movements using strict FIFO consumption now fail before stock levels are written when cost-layer evidence cannot cover the removal.
- **Purchase receipts reject invalid unit costs before stock writes.** Receipt costs must be finite and zero or greater; zero-cost receipts remain allowed for replacement, sample, or consigned stock.
- **Cost-layer snapshots use Decimal-safe six-decimal strings.** Transfer, shipment, refund, WMS, and Mintsoft snapshot writers now share one serializer for persisted FIFO snapshot quantities and unit costs.
- **Landed-cost recalculation adjustments carry freight PO attribution.** Adjustment idempotency now separates different linked freight POs; non-live deployments can rebuild freely, but live queues should be drained or rewritten before deploying this key-shape change.
- **COGS entries preserve six-decimal consumed quantities.** `CogsEntry.qty` is widened to `DECIMAL(14,6)` and COGS writers now share one Decimal-safe create-data helper.

### Fixes (Mintsoft webhook security)

- **Mintsoft ASN booked-in webhooks now bind the freshness timestamp into the HMAC signature.** IMS verifies `HMAC_SHA256(secret, "${timestamp}.${rawBody}")` and rejects body-only signatures.
- **Mintsoft ASN booked-in webhooks now acknowledge after durable persistence.** Accepted webhooks are stored idempotently in `wms_inbound_receipt_events` and return `202 Accepted`; the Mintsoft webhook sweeper applies stock and purchase-order effects asynchronously.
- **Mintsoft booked-in reconciliation now uses direct ASN lookup.** The processor fetches the referenced ASN by id through the WMS connector instead of listing all ASNs and searching client-side. `MINTSOFT_USE_BULK_ASN_LOOKUP=true` is available as a temporary rollback flag if Mintsoft endpoint discovery shows a different direct endpoint shape.
- **Mintsoft booked-in webhook sweeping is configurable.** `MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE` controls how many persisted booked-in events one sweeper run drains; the default remains `250`.
- **Mintsoft booked-in webhook retry state is now queryable.** `wms_inbound_receipt_events` stores typed processing status, retry attempts, next retry time, dead-letter timestamp, and last error, replacing the old `processingError` retry-state mirror so the sweeper no longer scans or parses encoded retry JSON.

### User-facing (sales allocation and backorders)

- **Sales allocation now distinguishes physical reservations from backorder demand.** Auto-allocation reserves only stock that physically exists; oversell-eligible shortfalls remain unallocated and appear as backorder demand instead of inflating `reservedQty`. Operators may see existing phantom over-reservations corrected on the next re-allocation, with affected lines shown as `Backorder` or `Unallocated` in the sales-order allocation panel.
- **Allocation activity logs include backorder details.** Allocation entries can now include unallocated quantities and per-line backorder metadata. The activity-log UI has no action allowlist, but downstream log parsers should expect the new `backorder_recorded` action and the longer allocation descriptions.

### Breaking operator change (cron authentication)

- **Production cron endpoints now require bearer authentication by default.** Localhost-only cron calls without `Authorization: Bearer $CRON_SECRET` will receive `401` in production. This is an operator-facing breaking change and should ship in the next major release (`2.0.0` under the release scheme above).
- **Before deploying this change, update existing production crontabs.** Replace bare localhost cron calls with commands that read `CRON_SECRET` from the protected app environment file and send the cron bearer token, for example:

  ```bash
  CRON_SECRET=$(grep -m 1 '^CRON_SECRET=' /opt/one-two-inventory/.env | cut -d= -f2-) && curl -fsS -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/fx-rates
  ```

- **Fresh installs are handled by `scripts/install.sh`.** Installer-generated cron entries now read only the `CRON_SECRET=` line from `${APP_DIR}/.env` at runtime, keeping the cron secret in the existing `imsapp:imsapp` mode-`600` environment file instead of duplicating it into the crontab or sourcing the full environment file.
- **Emergency bypass is explicit and narrow.** Production localhost bypass is only available when `CRON_SECRET` is not configured and `ALLOW_LOCALHOST_CRON_BYPASS=true` is set. Do not use this on shared or externally reachable deployments.

## 1.10.0 - 2026-04-25

### Features (FX integration cutover tooling)

- **Helper-plugin reachability probe.** Settings → Accounting → FX Rates now has a "Probe helper plugin" button. It POSTs a deliberately invalid HMAC signature to the WordPress endpoint and inspects the response: an HTTP 401 with `oti_fx_bad_sig` proves the plugin is installed *and* signature verification is active; `oti_fx_no_secret` flags that the operator hasn't pasted the shared secret on the WP side; 404/405 means the plugin isn't activated. Lets operators verify the integration in seconds before flipping push on.
- **Integration health card.** Same panel surfaces the ECB last-fetch time, the WooCommerce last-push time, and the count of currencies under manual override — each turning amber once stale (>36 h since last fetch / push). Pulls a single `getFxHealth()` snapshot, no extra round-trips on render.
- **Cutover runbook.** New `docs/todo/unified-fx-rates-cutover.md` with step-by-step operator instructions for switching a live tenant to the unified FX flow: pre-flight checks, plugin install, Aelia handover, smoke test, first-week monitoring, and rollback. Phase 5 of the unified-FX plan.

## 1.9.1 - 2026-04-25

### Fixes (Codex review of Phase 1–4 FX work)

- **QuickBooks now stamps ExchangeRate from `currencyRateToBase`.** Phase 1 added `currencyRateToBase` to every accounting payload but the QuickBooks adapter was dropping it before the API call, so QBO continued applying its own daily rate on multi-currency invoices/bills/credit memos and drifted from IMS by 1–3%. New helper `imsRateToQboExchangeRate()` (sibling of the Xero one) inverts to QBO's `1 doc-currency = X base` convention at 6dp; threaded through `pushSalesInvoice`, `pushPurchaseBill`, and `pushCreditMemo` and wired into `lib/connectors/quickbooks/sync-processor.ts` for all three call sites.
- **Manual *Mark Received* on a partially-booked transfer no longer double-counts inventory.** When a Mintsoft (or other WMS) callback booked in part of a stock transfer and stamped `qtyReceived` + a `TRANSFER_IN` movement + cost-layer slice, the manual close-out path in `app/actions/transfers.ts` was still receiving the *full* line quantity, recreating the entire snapshot, and over-stating destination stock + cost layers by the already-booked amount. The path now reads each line's `qtyReceived`, posts a movement only for the remaining portion, and slices the snapshot via `sliceTransferSnapshotForReceipt` (the same algorithm the WMS handler uses) so each unit is accounted for exactly once across both paths. Lines already fully received via WMS are skipped.

## 1.9.0 - 2026-04-25

### Features (FX rates admin UI)

- **New Settings → Accounting → FX Rates tab.** Shows the current rate per non-base currency with a source badge (ECB/frankfurter or Manual override) and the last-fetched timestamp. Admins can pin a manual rate per currency via a pencil icon — while pinned, the daily ECB fetch skips that currency so the override sticks. Click the undo icon to clear an override and re-fetch from frankfurter.
- **Push log.** Same panel includes a recent-pushes table (one row per fan-out attempt to a shopping connector — currently WooCommerce). Backed by a new `FxRatePushLog` table; both the FX cron and the manual *Push Now* button record success/failure here. Replaces the activity-log-only history.
- **Schema additions.** `FxRate` now carries `source` (`'frankfurter'` or `'manual'`) and `manualOverride` flags so the fetch loop can honour overrides without hard-coding rules. Migration `20260425100000_fx_rate_overrides_and_push_log` adds these plus the new `fx_rate_push_log` table.

## 1.8.0 - 2026-04-25

### Features (FX rate alignment with WooCommerce)

- **onetwoInventory Helper WordPress plugin.** New unified companion plugin that consolidates the existing invoice-buttons module and adds a signed REST endpoint for receiving FX rates from IMS. Old `wc-invoice-buttons.php` removed in favour of `lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php`. Installable directly from the IMS WC sync page via a "Download plugin (.zip)" button — no manual file copying. The plugin exposes a settings screen at WP admin → Settings → onetwoInventory where the shop owner pastes the same shared secret used for WC webhooks.
- **FX rate push to WooCommerce.** With the helper plugin installed and "Push FX rates daily" enabled in the IMS WC sync page, the daily FX cron now fans out to WC after the inbound fetch (HMAC-SHA256 signed). The plugin makes those rates available to Aelia Currency Switcher via the `wc_aelia_currencyswitcher_exchange_rate` filter, so cart conversions, displayed prices and order currency stamps all use the same rate as IMS and Xero. Direct, inverted, and cross-rate conversions are all resolved through IMS's stored rates.
- **Connector-agnostic plumbing.** `ShoppingConnector` interface now carries an optional `pushFxRates(rates)` capability — implemented by the WC adapter today, available for future Shopify/other adapters without IMS changes. `FxRatePush` and `FxRatePushResult` types live in `lib/connectors/types.ts`.

## 1.7.2 - 2026-04-25

### Fixes (Xero FX rate alignment)

- **Xero now uses IMS's stored FX rate.** Sales invoices, purchase bills and credit notes posted to Xero are now stamped with `CurrencyRate` derived from the IMS `fxRateToBase` on the source document. Previously Xero substituted its own daily XE rate, causing 1–3 % drift between IMS and Xero base-currency totals on the same multi-currency document. New helper `imsRateToXeroCurrencyRate()` inverts IMS's "1 base = X foreign" convention into Xero's "1 foreign = X base" at 6dp (matching Xero's `Decimal(18,6)` schema). Connector contract updated: `InvoiceData` / `BillData` / `CreditNoteData` accept an optional `currencyRateToBase` field, kept connector-agnostic so QuickBooks (and future accounting connectors) can adopt the same field. WooCommerce order import, the manual sales invoice queue, the credit-note queue and the purchase-invoice queue all stamp the rate on their payloads. First step toward the unified-FX plan in `docs/todo/unified-fx-rates-plan.md` that aligns rates across IMS, WooCommerce/Aelia and Xero.

## 1.7.1 - 2026-04-25

### Fixes (manufacturing-cost component, post-review)

- **Sync processors now handle the new types.** `MANUFACTURING_JOURNAL` and `MANUFACTURING_RECLASS` were missing from the Xero and QuickBooks sync-processor switches, causing queued rows to fail with `Unknown sync type` and never post. Both processors now route them through `pushManualJournal` / `pushJournalEntry` like other journal types.
- **Reclass journal now captures the inventory leg.** Retro edits previously posted only the COGS delta on consumed units, leaving the remaining-inventory delta unposted (and skipping the journal entirely when no units had shipped). The reclass is now a balanced 3-leg journal: `DR/CR Inventory` for the remaining-inventory delta + `DR/CR COGS` for the consumed-units delta + `DR/CR Manufacturing Overhead` for the total delta.
- **Idempotency keys on both journals.** `MANUFACTURING_JOURNAL` keys on `MFG_JOURNAL:<orderId>` so completion retries dedupe; `MANUFACTURING_RECLASS` keys on `MFG_RECLASS:<orderId>:<oldTotal>:<newTotal>` so identical re-saves dedupe but distinct edits each post.
- **Manufacturing journal queued in-tx.** Moved from post-tx `queueAccountingSync` to in-tx `queueAccountingSyncTx` so the cost-layer changes and the GL post are durable atomically — no more crash-window where inventory moves without a journal.
- **Disassembly zero-recovered fallback now capitalises overhead.** When `totalRecoveredCostBase === 0` the overhead is now distributed equally across recovered component layers rather than silently dropped, so the Inventory debit posted by the journal matches the layer-derived stock value. Aligns with the recalc helper's existing equal-share fallback.
- **Unbalanced-journal guard.** Builder now refuses to post if a credit line is dropped due to a missing account (no DR-only journal) and validates the debit/credit sums match within £0.01.
- **Negative amounts rejected at the action level.** Cost-line amounts must be non-negative; the journal model assumes overhead is a non-negative debit to inventory. UI input adds `min="0"`.
- **Reclass warnings surfaced in the action return** as `{ success: true, warning }` rather than only logged silently.
- **`cost_layers.production_order_id` is now a real FK** with `ON DELETE SET NULL` and a Prisma relation on both sides.

### Tests

- Three additional unit tests in `tests/manufacturing-production-costing.test.ts`: proportional rounding across multiple layers, equal-share fallback for zero-base layers, and value-share split with mixed receivedQty.

## 1.7.0 - 2026-04-25

### User-facing

- **Manufacturing-cost lines** on production orders. Each manufacturing order can now carry a list of per-run overhead lines (labour, machine time, utilities, etc.) with an optional per-line GL account override. Cost lines are managed from the order detail page in a new **Manufacturing costs** card, and appear on the manufacturing-order PDF with a total.
- **Capitalised overhead** — on completion the total of all cost lines is folded into the produced cost layer's unit cost (assembly: spread across `qtyPlanned`; disassembly: distributed proportionally across recovered components by their value share). Margin reporting and FIFO consumption use the fully-loaded unit cost.
- **Manufacturing Journal** accounting type — `DR Inventory / CR Manufacturing Overhead` is queued automatically on assembly/disassembly completion. Lines without a per-line override credit a configurable default account (Settings → Accounting → Manufacturing Overhead account).
- **Retro recalc** — cost lines can be edited after completion. Cost layers are re-priced and a `MANUFACTURING_RECLASS` journal is queued for any units already shipped (delta posts to COGS vs Inventory).

### Technical

- New Prisma model `ManufacturingCostLine` (id, productionOrderId, description, amountForeign, amountBase, accountCode override, sortOrder).
- Added `ProductionOrder.currency` + `fxRateToBase` columns so cost lines can be entered in a non-base currency.
- New `AccountingSyncType` enum values: `MANUFACTURING_JOURNAL` and `MANUFACTURING_RECLASS`. Both connectors (Xero, QuickBooks) gained `*_sync_manufacturing_journal` and `*_manufacturing_overhead_account` setting keys.
- New `CostLayer.production_order_id` foreign key so retro-recalc can find cost layers produced by a given production order. Index added.
- Server actions: `getManufacturingCostLines`, `updateManufacturingCostLines` (transactional replacement, triggers retro-recalc when status === 'COMPLETED').
- Internal helper `recalculateManufacturingCostLayers` mirrors `recalculateDirectLandedCosts`: updates `costLayer.unitCostBase`, posts COGS reclass for consumed qty, and refreshes downstream snapshots via `updateSnapshotsForCostLayerChange` / `refreshShipmentCogsForCostLayerChange` / `refreshSalesOrderLineCogsForCostLayerChange`.

## 1.6.0 - 2026-04-22

### User-facing

- Added Mintsoft bundle sync (Phase 4) with a per-binding direction control (`DISABLED`, `IMS → Mintsoft`, `Mintsoft → IMS` verify only). IMS KIT product create/edit now queues a best-effort Mintsoft bundle push, and operators can run a manual **Run Bundle Verify** from the Mintsoft dashboard.
- Added a Bundles card on the Mintsoft dashboard listing linked Mintsoft bundles with checksum and last-synced timestamp. Composition drift surfaces as an open `BUNDLE_DERIVATION_CONFLICT` discrepancy because the Mintsoft API does not support bundle updates — diverging bundles must be resolved manually.

### Technical

- Added `WmsBundleDto` / `WmsBundleComponent` / `WmsBundleRef` to the WMS connector contract with optional `createBundle` / `fetchBundle` methods, implemented in the Mintsoft connector against `PUT /api/Product/Bundle` and `GET /api/Product/{id}/Bundle`.
- Landed `lib/connectors/mintsoft/sync/bundle-sync.ts` with deterministic composition hashing (sorted by component SKU, quantity rounded to 4 dp), `WmsBundleLink` persistence, `BUNDLE_DERIVATION_CONFLICT` upsert per active binding warehouse, and auto-resolution on match. Bundle sync never mutates IMS stock — it only reconciles composition structure.
- Registered the `mintsoft-bundle-verify` cron (nightly, disabled by default) and added the `runMintsoftBundleVerifyNow` server action under write-scope permission.
- Hooked best-effort bundle sync into the existing `after()` path on product create/update so KIT composition changes propagate to Mintsoft without blocking the interactive submit.
- Serialized Mintsoft bundle creation via a `WmsBundleLink` sentinel claim so concurrent product saves or cron+manual runs can no longer double-PUT to `/api/Product/Bundle`; stale sentinels older than 10 minutes are reclaimable.
- Reordered the Mintsoft bundle normalizer id precedence to prefer the bundle `ID` over any `ProductId` alias so a root `ProductId` can never be mis-selected as the external bundle id.
- Raise a `BUNDLE_DERIVATION_CONFLICT` when an active-binding KIT has no components, instead of silently skipping and leaving the Mintsoft bundle unchanged.
- Made Mintsoft bundle-sync decisions per-binding-scope so a single `IMS_TO_WMS` binding no longer suppresses `WMS_TO_IMS` conflicts on other warehouses: push scopes and pull scopes now each get their own conflict rows with direction-specific wording.
- Extended the Mintsoft bundle verify scan to include KITs with an existing `WmsBundleLink`, not only those with an active `WmsProductLink`, so orphaned bundle mappings stay monitored.
- Escalated Mintsoft bundle finalize-after-create failures with three retry attempts plus an `ERROR`-level `mintsoft_bundle_finalize_failed` activity log carrying the remote bundle id, checksum, and sentinel link id for manual recovery.
- Also schedule Mintsoft bundle sync for parent KITs when a component product is saved, so component SKU or Mintsoft-link changes no longer leave parent bundles stale until the next cron.
- Filtered pending Mintsoft bundle sentinels (`pending:*` external ids) out of the dashboard Bundles table so operators only see real Mintsoft bundle ids.
- Moved the Mintsoft bundle parent-product-link requirement from an early return to the push branch only, so a KIT with a persisted `WmsBundleLink` but no `WmsProductLink` is now fully verified against Mintsoft instead of being skipped the moment verify picks it up.

## 1.5.0 - 2026-04-21

### User-facing

- Added the first Mintsoft WMS integration surface in `/sync`, including connection settings, warehouse bindings, plugin gating, and the signed ASN booked-in webhook endpoint.
- Added Mintsoft notification-only stock sync operations: warehouse discovery in the binding dialog, manual sync runs, recent run exports, open discrepancy visibility, and threshold-based in-app recipient notifications.
- Added Mintsoft Phase 3 product verification: IMS product changes now perform a best-effort Mintsoft product sync, and operators can run a manual product verify from the Mintsoft dashboard.
- Greyed out the future `ALIGN_TO_WMS` Mintsoft stock mode in the binding editor so it remains visible without presenting a dead-end selectable path.

### Technical

- Landed the Mintsoft connector foundation, WMS registry wiring, cron registration scaffolding, encrypted Mintsoft secret storage, and Mintsoft-specific order-lookup support.
- Hardened Mintsoft webhook intake with request-size guards, timing-safe HMAC verification, retry-safe event persistence, and targeted regression coverage for signature handling and concurrent idempotency.
- Implemented the Phase 2 Mintsoft stock polling engine, cron execution path, discrepancy/snapshot/job persistence, soft deactivation handover rows, and pure helper coverage for response normalization and threshold handling.
- Implemented Mintsoft's current authentication flow: store username/password, renew the 24-hour API key through `/api/Auth`, persist auth timing metadata, and retry once after a 401 before surfacing the failure.
- Fixed Mintsoft notification-only stock sync so SKUs missing from the Mintsoft feed now raise `MISSING_IN_WMS` discrepancies instead of silently disappearing from review.
- Fixed the Mintsoft discrepancy persistence race so concurrent sync runs now collapse onto a single `OPEN` discrepancy per warehouse/category/product-or-sku.
- Implemented the Mintsoft product sync engine with payload hashing, authoritative product reads, barcode backfill/conflict handling, `WmsProductLink` persistence, the real `mintsoft-product-verify` cron path, and realistic E2E Mintsoft product endpoints for future workflow coverage.
- Corrected Mintsoft product writes to match the documented API shape: create via `PUT /api/Product`, update via `POST /api/Product` with `ID` in the request body, and tightened the E2E simulator so it now rejects the previously incorrect update path.
- Moved best-effort Mintsoft product sync for IMS product edits out of the interactive submit path using Next.js `after()`, so inventory create/update no longer blocks on Mintsoft round-trips.
- Reworked Mintsoft product verify to process eligible products in paged batches with bounded concurrency, improved JSON payload normalization for sync logs, and counted conflict rows that still pushed non-barcode Mintsoft updates as both mismatches and corrected changes.
- Made Mintsoft booked-in webhook processing durable by adding a `mintsoft-webhook-sweeper` cron that drains any `wmsInboundReceiptEvent` rows whose in-process replay failed or raced with ASN finalization, so accepted callbacks can no longer be stranded unprocessed.
- Revalidated outstanding purchase order quantities under the PO row lock immediately before Mintsoft ASN recover/create, aborting and resetting the pending reservation if a manual receipt consumed the outstanding quantity in the interim, so the remote ASN can never publish stock that is already received.
- Fenced the Mintsoft stock-sync stale-job reclaim with a compare-and-swap on the observed lease token and heartbeat timestamp, so a live worker heartbeat can no longer be overwritten by a reclaim that read its state moments earlier.
- Ordered the Mintsoft alignment and booked-in handler `FOR UPDATE` locks on `wms_asn_line_maps` by `id` so concurrent alignment runs and ASN webhook processing always acquire overlapping row locks in the same order, eliminating a deadlock window.
- Escalated the Mintsoft alignment activity log to WARNING with a `reservedExceedsAvailable` flag when post-align reservations still exceed available stock, surfacing stale allocations instead of silently logging the correction.

## 1.4.1 - 2026-04-19

### Technical

- Fixed `scripts/update.sh` so git-based deploys no longer abort under `set -o pipefail` when printing the recent commit list.

## 1.4.0 - 2026-04-19

### User-facing

- Added a guided onboarding setup flow for fresh instances, including fixes for integration gating and hydration issues in the onboarding path.
- Added opening stock CSV import by SKU and warehouse, with quantity and base unit cost validation.
- Improved the Product Profitability report with pagination, column visibility controls, and better table scrolling for larger result sets.

### Technical

- Hardened FIFO, allocation, shipment, refund, and landed-cost accounting behavior across the commerce and Xero workflows.
- Fixed multiple CSV import regressions and added onboarding E2E coverage for the new setup flow.

## 1.3.0 - 2026-04-16

### User-facing

- Added a Shopify connector screen in Integrations for credential setup, webhook-secret management, manual stock sync, and Shopify sync log visibility.
- Added Shopify product and order admin links in the IMS where Shopify matches can be resolved safely.

### Technical

- Implemented the first real Shopify connector layer and connected it to the shared shopping facade and integrations UI.
- Added duplicate-SKU safety checks, retry-safe webhook rejection for unimplemented Shopify webhooks, and persisted Shopify sync attempts into the shared sync log.

## 1.2.0 - 2026-04-16

### User-facing

- Added QuickBooks Online as a fully available accounting connector (OAuth, chart of accounts sync, invoices, bills, credit memos, journal entries, payment polling, daily batch sub-ledger sync).
- QuickBooks is now selectable in the Integrations dashboard alongside Xero.

### Technical

- Full QuickBooks connector module (16 files): OAuth 2.0 with Intuit, HTTP client with rate limiting, split Customer/Vendor contacts, NonInventory items, idempotent sync processor, payment poller with checkpoint-on-success-only.
- Accounting facade, server actions, OAuth callback, and all cron routes now dispatch to the active accounting connector (Xero or QuickBooks).
- Fixed sync processor idempotency: external writes are no longer replayed after partial follow-up failures.
- Fixed stale contact IDs cleared on disconnect to prevent cross-tenant reuse.

## 1.1.0 - 2026-04-16

### User-facing

- Added the current app version as a visible badge in System Settings.

### Technical

- Bumped the tracked release metadata and package version for the 1.1.0 non-breaking release.

## 1.0.0 - 2026-04-16

### User-facing

- Added the Product Profitability analytics page.
- Added Turnstile protection to password login.
- Added release tracking in the UI, including a release history view and release notifications.

### Technical

- Added groundwork for Shopify and QuickBooks connectors, including multi-connector shopping support.
- Hardened install and update scripts for git-based deployments, Prisma client generation, and deployment metadata preservation.
- Removed the legacy shopping webhook route conflict and added a real `/api/health` endpoint for deployment checks.
