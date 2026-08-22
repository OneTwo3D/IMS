# WooCommerce Integration

One Two Inventory connects to your WooCommerce store to automatically import orders, sync products, push stock levels, and keep order statuses aligned between both systems. Configuration is managed from the **Integrations** page when the WooCommerce plugin is enabled.

## Getting Connected

1. Enable the WooCommerce plugin under **Settings > System > Plugins** if it is not already enabled
2. Navigate to **Integrations** in the sidebar and click the **WooCommerce** connector card
3. On the **Connection** tab, enter:
   - **Store URL** — your WooCommerce site address (e.g. `https://yourstore.com`)
   - **Consumer Key** — generated in WooCommerce under Settings > Advanced > REST API
   - **Consumer Secret** — shown once when you create the key in WooCommerce
4. Click **Save Settings**
5. **Click "Test Connection"** — sync remains disabled until you successfully run the connection test. The system stores a fingerprint of the saved credentials at test time; if you later change any of them, you must re-test before sync re-activates. See [Connection Test Gate](#connection-test-gate) below.

Once connected AND tested, a green "Connected" badge appears and the remaining tabs become available.

### How to get your WooCommerce API keys

The Consumer Key and Consumer Secret are generated inside your WooCommerce store, not the IMS:

1. Sign in to your WooCommerce site's **WordPress admin**.
2. Go to **WooCommerce → Settings → Advanced → REST API**.
3. Click **Add key** (or **Create an API key**).
4. Set a **Description** (e.g. "One Two Inventory"), choose the **User** the key acts as, and set **Permissions** to **Read/Write**.
5. Click **Generate API key**.
6. Copy the **Consumer key** (`ck_…`) and **Consumer secret** (`cs_…`) — the secret is shown **only once**, so copy it before leaving the page.
7. Paste both into the IMS connection form along with your store URL.

Official guide: <https://woocommerce.com/document/woocommerce-rest-api/>

> **Note:** The consumer secret is masked after saving. To change it, enter the full new value — the system detects and ignores the masked placeholder.
>
> **Settings own the credentials.** `WC_STORE_URL`, `WC_CONSUMER_KEY` and `WC_CONSUMER_SECRET` in `.env` are used **once**, at install time, to seed these fields. After that the connection form is the only place that changes them, and editing the `.env` values has no effect. Rotate the key here, not in the file.
>
> **Base currency check:** the WooCommerce store currency must match the IMS base currency before credentials or sync settings can be enabled. Order currencies may still vary per transaction; the IMS converts them into its own base currency for reporting and valuation.

### Connection Test Gate

The connection test gate prevents sync from running with stale or wrong credentials. The flow is:

1. You save credentials → status `not tested`. Sync is disabled.
2. You click Test Connection → IMS calls the WooCommerce API with the saved credentials.
3. If the test succeeds, the system stores:
   - Test status: `success`
   - Tested-at timestamp
   - A fingerprint (hash of URL + key) of the credentials at test time.
4. Sync can now be enabled.
5. If you later change the URL, key, or secret, the fingerprint comparison detects the change and reverts the status to `stale`. You must re-test.

This means a credential rotation can't silently leave sync running with old (or broken) credentials.

### What happens to in-flight work when you rebind

Changing the URL, key or secret is a **rebind**. It clears every cached WooCommerce product id (the next sync re-matches products by SKU). Work that belongs to the old binding is then refused rather than applied:

- A product import or stock push that started before the rebind abandons its writes instead of writing the old store's ids over the freshly cleared cache.
- A **product webhook sent by the previous store** is refused, and is acknowledged rather than retried — its payload describes that store, and no number of retries can make it describe the new one. Nothing is imported and no stock is corrected from it. These appear in the activity log at ERROR level, naming the store that sent the delivery and the store you are bound to. The reconcile sync re-imports the affected products from the current store, so nothing needs replaying by hand.

Every delivery is judged on **which store sent it**, taken from the store's own statement of its address in the delivery and compared against the store URL in your Connection settings. The statement is read from the **signed body first** (the product's own REST link or permalink) and only from the `X-WC-Webhook-Source` header when the body carries neither — the header travels outside the signature, so it never overrides what the signed body says about itself. The comparison includes the **subdirectory**, so two stores sharing one host (`example.com/store-a` and `example.com/store-b`, as in path-based multisite) are told apart. That is deliberately not the same as "did anything change since the delivery arrived":

- Rotating the key or secret **for the same store**, or pressing *Reset cached product IDs*, is not a rebind of the store. Deliveries keep flowing normally through both.
- A delivery that was already on its way when you changed the store URL is still recognised as coming from the old store, even though it lands afterwards.
- A delivery that does not say which store sent it is refused as well, rather than assumed to be current. If that happens for every delivery, something between WooCommerce and IMS is stripping headers.
- A handful of refusals immediately after an IMS upgrade is expected: deliveries accepted by the previous version during the changeover carry no store statement, so they cannot be shown to describe the current store. The reconcile sync covers them.

A burst of refusals after a store change is normal for a few minutes (the old store's queued deliveries draining). A burst that keeps going means the old store is still sending webhooks — remove the webhook in that store's WooCommerce admin.

## Order Sync

### Initial Import

Before ongoing sync begins, you must import your existing active orders:

1. Go to the **Orders** tab on the WooCommerce connector page
2. Click **Import Active Orders** — this fetches all orders with `processing`, `pending`, or `on-hold` status from WooCommerce
3. A progress bar shows pages processed, orders imported, and orders skipped (already in the system)
4. Once complete, a green checkmark appears and the "Sync Orders Now" button becomes available

This is a one-time operation. Ongoing sync is blocked until the initial import finishes.

### Ongoing Order Sync

With the initial import complete, new and updated WooCommerce orders are imported automatically.

**Configuration options:**

- **Enable/disable** order sync with the toggle
- **Status filter** — choose which WooCommerce statuses trigger an import (e.g. `processing`, `on-hold`, `completed`). At least one status must be ticked: an empty selection is rejected when you save, because it is not a filter WooCommerce can be asked for. To stop importing orders altogether, turn **Enable order sync** off instead.
- **Sync interval** — how often the system polls WooCommerce for changes (default: 5 minutes). This field is disabled when webhooks are active.

**What happens when an order is imported:**

- A new sales order is created with all line items, prices, discounts, shipping, and tax
- **Cart coupons ride on the line items.** WooCommerce allocates coupon money *into* the lines — each line's total is already its subtotal minus that line's share — so IMS imports the coupon as a per-line discount and leaves the order-level discount field at zero. The coupon codes are still recorded on the order for display. Only money WooCommerce left unallocated (a coupon shape IMS does not model) is stored as an order-level discount, and that is logged as a warning when it happens. Storing it in both places made every downstream document — the Xero/QuickBooks invoice, the credit note, the order totals — deduct the same coupon twice. Every order imported since the fix records `LINE_ALLOCATED` in its discount model field, which is what says the order-level amount is only the unallocated residual
- **Orders imported before that fix still carry the duplicate** and are corrected by a separate one-off backfill. It is a **two-phase, opt-in** workflow, because it rewrites amounts on invoices that are already in the ledger, and nothing on a row distinguishes "written by the old importer" from "corrected by hand afterwards". A machine may propose; only a person may approve:

  ```bash
  # 1. PROPOSE — writes nothing
  npm run wc:coupon-discount:backfill -- --imported-before <ISO> --allowlist-out y14.json --csv out.csv

  # 2. REVIEW y14.json by hand, then sign it:
  #      "reviewed": true, "reviewedBy": "<your name>", "reviewedAt": "<ISO>"

  # 3. APPLY — consumes ONLY the reviewed file, never a fresh scan
  npm run wc:coupon-discount:backfill -- --allowlist y14.json --apply
  ```

  `--imported-before` is the moment the fix went live on this instance. It must be an unambiguous ISO instant (`2026-07-25T14:00:00Z`) — a bare date is refused, because it silently means UTC midnight and orders import at all hours. It is dated against when **IMS imported** the order, never against the order date: the initial import backdates a sales order's `createdAt` to the historical WooCommerce date, so an old order imported yesterday would otherwise look legacy and have a correct discount erased. It is **not accepted with `--apply`** — the cutoff decided what was proposed; what gets written is decided by the reviewed file alone.

  Reviewing means checking each entry against the deployment record and against any manual corrections you know about. An entry whose amount is **already** correct belongs in the file's `stampOnly` list, which records that fact permanently without changing any number; anything you are unsure of should be deleted from the file, since skipping is re-runnable and a wrong correction is not. Apply re-verifies every field against the live row and re-derives the amount it writes, so a row that moved since you reviewed it is skipped and a hand-edited figure is refused rather than obeyed. `stampOnly` entries are re-verified just as hard — the amount, the line discounts and the import timestamp — because the stamp is the one write no later run can reconsider.

  Reviewing an entry also means reading its **`refunds`** block — the order's refund status, its refund rows, and any credit notes of theirs that reached the ledger. It changes nothing about the amount (a duplicated coupon is duplicated whether or not the order was refunded) but it decides what you may safely do about the documents; see the refunded-orders note below.

  **Every refusal is fixed by re-running the proposal.** Nothing is written when a row is refused, and the report reads every field apply checks, so the regenerated file shows you the state that caused the refusal; approve it again and apply proceeds. That includes an invoice that posted without its reference being written back onto the order — the report lists it as a *posted-but-unlinked* invoice, and approving the entry with that evidence on it is what lets the correction through. A proposal generated by an older build is refused on its version, which means the same thing: re-run the proposal.

  **A row that was corrected is the one thing the proposal will not show you again.** The correction stamps the order and writes its audit marker, which is exactly what makes the operation safely re-runnable — and which makes every later scan skip that order, so no proposal will ever print its ledger handoff a second time. To re-read the accounting position for an order that has already been corrected, use the read-only reprint mode:

  ```bash
  npm run wc:coupon-discount:backfill -- --reprint y14.json
  ```

  The command line is parsed strictly: a misspelled flag, a `--flag=value`, a bare path, a repeated flag, or a flag with nothing after it **refuses the run** instead of being ignored. That matters most for `--reprint`, which used to fall through to `--apply` when given no value — the read-only mode silently becoming the writing one.

  It writes nothing, takes no lock and re-verifies nothing — it re-derives each order's handoff against **live** state and prints it. The file does not need to be signed, because nothing is decided; `--apply` still refuses an unsigned file and always will, and the two flags cannot be combined. Anywhere the tool tells you a position can be re-derived, this is the command it means.

  Verdicts in the report and the CSV:

  - **UNPROVEN** — nothing establishes what the stored amount means, so it is left exactly as it is
  - **BLOCKED** — the order has live accounting work: an unposted invoice job, or a daily revenue-deferral journal that has not posted yet. Both hold their own copy of the figures, which the backfill deliberately never edits. Let the queue and the daily batch drain, then re-run
  - **SKIP** / **CORRECT** — nothing duplicated, or a proposal to clear the duplicated part

  Orders that already have accounting documents — a linked invoice, a posted-but-unlinked invoice, a revenue-deferral journal, or a credit note from a refund — are listed separately, at both phases, and **each one is classified rather than assumed to be wrong**. Clearing the IMS field does not reach a document that has already posted, but that does not mean every posted document understates: the report replays the connector's own posting rule over the payload IMS actually sent, so a Xero invoice enqueued without a discount account code — which never had an "Order discount" line appended, and therefore never carried the duplicate — is reported as needing **nothing**, and crediting it would put a wrong entry in your ledger. Where a document *does* disagree, the instruction names the direction: an invoice that discounted too much charged the customer too little, so its balance has to go **up** (edit it, or raise a further invoice) and a credit note is the wrong instrument; the reverse case is the one a credit note settles. Where the figure cannot be established at all, no remedy is prescribed and you are told how to read it off the document instead — except where the reason it could not be established is that **several posted documents disagree**, in which case there is no single document to read it off and nothing is prescribed at all.

  **Where the ledger holds more than one posted sales invoice for the order, every one of them is named and nothing is prescribed.** Two posted documents that agree on the discount are two distinct documents that each carry it, so the difference reported is per document, not what the ledger is out by — and multiplying it is no better founded, because nothing IMS records says whether those documents each bill the whole order or divide it between them. Correcting the one the report happened to name would have left the other standing. You are told to open all of them and establish the total by hand.

  **Refunded orders are judged on the whole position, not on the invoice.** If any refund or credit note stands against the order — including a WooCommerce refund that arrived and could not be recorded — the invoice is only half of it: the credit note that reversed it was computed from the same pre-correction figure, so the two errors can cancel and the amount "outstanding" on the invoice may not be outstanding at all. Raising a further invoice on the invoice finding alone would bill a customer who has already been refunded, and raising a credit note would refund the same money twice.

  Where the credit notes **mirror** the invoice, IMS nets the two for you and prescribes the remainder in whichever direction it actually points. That needs the whole position to line up: a full refund, every refund raised as a chargeback that mirrored the invoice, each named by one credit note that is in the ledger and by no other, net (not legacy gross) totals, no unrecorded refund left parked — and, additionally, an invoice whose order-level discount can be **compared** with the credit note's:

  - the invoice must have been sent **tax-exclusive**. A tax-inclusive invoice states its order-level discount gross while every refund line IMS stores is net, and nothing recorded lets one be converted into the other (a refund line records a tax *type*, never a rate), so the subtraction is not defined;
  - there must be exactly **one** posted sales invoice. Two invoices that agree on the discount charged it twice, and netting one credit-note total against one of them describes a set of documents the ledger does not hold;
  - each credit note must still **stand as IMS recorded it** — mirrored as posted, once, under the id the refund names, with no retry pending. A credit note IMS retired or re-posted no longer carries the lines its refund rows describe;
  - the invoice and the credit notes must have been posted to the **same accounting system**. The active accounting connector can be switched (Xero → QuickBooks), and IMS keeps every historical document under the connector that posted it — so an order invoiced before a switch and credited after it has an invoice standing at its full value in one ledger and an unrelated credit memo in the other, and the difference between their discount lines describes no balance that exists.

  In every other shape IMS reports the invoice finding, prints every credit-note leg it *could* derive, names the exact condition that stopped it, and prescribes **nothing** — including any conclusion about whether the two sides cancel. Where the subtraction was withdrawn, no line says the errors cancel, that the invoice was already credited away, or that the order is square: those are results of a netting, and on these orders no netting was performed. What you get instead is both sides' facts, the condition that stopped the comparison, and the same reasoning stated as the *conditional* it is ("**if** the credit note reversed the same figure, then …"). An order whose netting was suppressed is never filed as settled.

  A netted answer is also **withdrawn** if the refund position moves after the correction commits — the "nothing to do" as well as the remedy. The conclusion is removed from the printed handoff, the order goes back on the must-look list, and `--reprint` re-derives it against the new position.

  **Every netted answer names the credit notes it was derived against — including the one that nets to nothing.** IMS cannot see a credit note voided or edited by hand in Xero or QuickBooks (nothing writes that back), and it records which *connector* posted each document but never which *organisation* inside it. So both netted outcomes tell you to open those documents and confirm they still stand, in the same organisation as the invoice, before you act on the figure. A net of **zero** carries that warning most heavily: it is the one answer that says there is nothing to look at, and if one of the credit notes was voided by hand then the reversal never happened, the invoice stands at its full posted value and the customer still owes it.

  The revenue-deferral journal is deliberately left alone in all cases: IMS recognises back out the same stamped figure, so adjusting one half of that pair by hand would strand the difference in unearned revenue permanently.

  At apply time that whole list is rebuilt from **live** state rather than from the reviewed file, and any order whose posting **or refund** state changed since you reviewed it is refused instead of corrected — so you are never told a posted order needs nothing, and never handed a remedy that was derived before the refund existed

  **Chargebacks on corrected orders go to a person.** A credit note must reverse the document the ledger actually holds, and on a corrected order the invoice charged the old discount while the order now carries the new one. Rather than guess which of the two the accounting system holds today — that depends on whether the manual credit/adjustment above has been made, which happens outside IMS — the automatic payment-reversal chargeback stops and logs a manual-handling warning naming both figures and the invoice. Raise that credit note by hand against the document as it stands.

  It stops **just as firmly when the posted figure cannot be established at all** — no readable record of the invoice IMS sent, an invoice update that never confirmed, or two posted documents that disagree — rather than falling back to the order's current figure. The warning says which. Every one of those is raised by hand too, against the invoice in the accounting system.

  Only orders this backfill actually **rewrote** are affected. The correction records that fact on the order itself, in the same write as the amount, so orders it never touched — every native, manual and pre-fix order, everything the fixed importer has imported since, and rows the reviewer merely marked as already-correct via `stampOnly` — keep raising their chargebacks automatically, exactly as before.
- The customer is matched by WooCommerce customer ID or email, or created if new
- Multi-currency orders are converted to the IMS base currency using the FX rate from `frankfurter.dev` (ECB) at import time. The same rate is stamped on the order's `fxRateToBase` field and forwarded to Xero as `CurrencyRate` on the resulting invoice — so the WooCommerce store, IMS, and Xero all see the same base-currency total for the order. See `docs/xero-sync.md` § Multi-Currency FX Rates.
- Tax rates are resolved using the tax rate mappings you configure (see Tax Rates below)
- **Shipping is taxed at its own rate, not the goods' rate.** A store that charges zero-rated postage
  beside standard-rated goods (or the reverse) would otherwise post an accounting invoice that does
  not total to the WooCommerce order — and the payment IMS registers for the order total would only
  part-settle it, leaving a balance in the ledger while IMS showed the order settled. The shipping
  line now takes the tax rate that reproduces the tax WooCommerce actually charged on shipping
- **A document that will not total to the order is NOT posted at all.** Before queueing the invoice,
  IMS checks the tax the accounting document will produce against the tax WooCommerce charged, per
  line and for shipping. When they disagree, the invoice is queued but the accounting connector
  refuses to send it: the sync row fails with the reason on it, no payment is registered, and an
  ERROR is logged against the order naming each component and both figures. This happens whether or
  not the order is paid.

  Posting it anyway is the worse option, and is what IMS used to do. Xero accepts a payment smaller
  than the invoice as a *part* payment, so an invoice built at the wrong total sits AUTHORISED with a
  balance for ever while IMS — comparing the order total it sent against the order total it holds —
  shows the order settled. A refusal you can see is recoverable; a receivable in the ledger at the
  wrong total takes a credit note to undo.

  **The remedy** is named on the failure: map the WooCommerce tax rate the order used (Tax Rates,
  below) and re-import the order. The rebuilt document posts normally.

  **"Disagree" is measured in the order's own currency.** The allowance is one posted minor unit
  either way — a penny in GBP/EUR/USD, a whole yen in a 0-decimal currency (JPY, KRW, ISK, CLP, VND),
  a fils in a 3-decimal one (KWD, BHD, JOD, OMR, TND) — and the figures in the message are printed at
  that precision. It used to be a penny in every currency, which was wrong in both directions: in a
  3-decimal currency a real ten-fils error read as "within a penny" and the invoice posted, and in a
  0-decimal one WooCommerce's own whole-unit rounding read as a mismatch and correct orders were
  refused.

  **One case has no mapping that will help.** WooCommerce can tax a single shipping line at several
  rates at once — a standard rate plus a regional surcharge, say — and an accounting invoice carries
  exactly one tax type on shipping. If those rates happen to add up to a rate IMS holds (15% + 5%
  where the order is 20%), the invoice is right and posts as usual. If they do not, no tax type
  expresses the charge, and the message says so rather than sending you looking for a mapping. Such
  an order has to be invoiced in the ledger by hand
- The order number uses your configured WooCommerce prefix (e.g. `WC-1234`, set in Settings > Company > Document Numbering)
- **The accounting invoice number comes from WooCommerce, not from IMS.** IMS reads `_wcpdf_invoice_number` — the number WooCommerce PDF Invoices & Packing Slips assigned and printed on the customer's PDF — and uses it *verbatim* as both the IMS invoice number and the `InvoiceNumber` on the Xero invoice. No prefix is added, so the Xero document, the customer's PDF and the WooCommerce order all carry the same number. The **Invoice Prefix** field for WooCommerce under Settings > Company > Document Numbering no longer affects it
- Stock is auto-allocated from warehouses marked **Sync to Store**

#### When WooCommerce has not numbered the invoice yet

The PDF plugin assigns `_wcpdf_invoice_number` when it first creates the invoice document, which can
happen slightly after IMS imports the order. When the number is missing, **IMS does not invent one
and does not post anything to the accounting system.** The order still imports normally; the
accounting sales invoice is held back and a warning appears in the activity log
(`sales_invoice_number_unavailable`), naming the order and the meta key it looked for.

This is deliberate. The accounting sales-invoice create is an *update-or-create on the invoice
number*, so a document posted under a stand-in number cannot be renumbered later — a second post
under the real number would create a **second invoice** rather than replacing the first. Holding the
order back is recoverable; a wrongly numbered document in a live ledger is not.

**It clears itself.** The invoice IMS would have posted is kept against the order, waiting for the
number. As soon as WooCommerce assigns one and the order resyncs — a webhook redelivery, or the next
order poll, which picks the order up precisely because writing that meta touches it — IMS records
the number and queues the accounting invoice automatically, using the payload it built at import
time (so the invoice date, tax treatment and payment registration are exactly what they would have
been). The activity log shows `sales_invoice_number_captured`.

There is nothing to do unless an order *stays* here. If one does, the order is not being resynced:
check that WooCommerce actually generated the invoice document for it, and that order sync is
running. You can always queue the sales invoice from the sales order by hand once the number shows.

One case is called out separately, because the release can be a no-op through no fault of the order:
if the accounting connector is disconnected, its sync is switched off, or Sales Invoices are set to
**off**, queueing the released invoice does nothing at all. IMS checks that the accounting sync row
really exists before it closes the hold, so the order stays held, its queue row says why, and the
activity log gets `sales_invoice_release_not_queued`.

**That one does not wait for the storefront.** Waiting for another order sync would be waiting for
nothing: the event that would have caused one — WooCommerce writing the number — has already
happened. Instead the WooCommerce reconcile job retries every held order that has a number and no
accounting document, on its own schedule, so switching the connector or the Sales Invoices setting
back on is enough — the invoices queue themselves on the next run without anyone touching the
orders. While orders are stuck this way you get one `sales_invoice_release_still_stuck` warning per
run naming the total, rather than one per order. Holds that can never be released — the sales order
was deleted, or it has since been invoiced another way — are closed with a reason instead of being
retried forever.

#### If WooCommerce changes an order's invoice number

IMS follows the storefront **until something has committed to the number** — that is, until an
accounting document exists for the order, or a sales-invoice sync has been queued for it. Before
that point a changed `_wcpdf_invoice_number` simply replaces the stored one (logged as
`sales_invoice_number_corrected`).

After that point the number is frozen and IMS keeps what it has, logging
`sales_invoice_number_correction_refused` with both numbers. Renumbering then is not a correction:
the accounting create is update-or-create on the number, so posting the new one would add a *second*
document rather than renumber the first. The order's invoice in the accounting system and the
customer's PDF have genuinely diverged, and somebody has to decide which is right.

The same applies to orders that have **no** number recorded but already carry an accounting
document — every WooCommerce order invoiced before this change is in that state, with a document
numbered `INWC-…` in Xero. IMS does not fill the blank for those either (logged as
`sales_invoice_number_capture_refused`): doing so would make the next invoice update try to renumber
a live document onto the storefront's number.

**WooCommerce "completed" orders** receive special handling: the system auto-allocates stock, creates shipments, applies any tracking information from the WC order meta (AST plugin), and transitions the shipments through to Shipped status.

This uses the same shared external-fulfillment path that future WMS plugins will use. WooCommerce does not bypass the IMS shipment model or dispatch stock directly at order level.

**A completion that cannot become a shipment is now reported, not swallowed.** There are two reasons
IMS will refuse one, and they are handled differently because only one of them clears by itself:

- **The order is on backorder** — there is no physical stock for IMS to consume, so nothing can be
  marked shipped. The webhook delivery is **retried**, because the refusal describes IMS stock at
  that instant and a receipt landing later is the fix. A warning is recorded against the order.
- **The shipment lines do not cover what was ordered**, net of refunds. The goods have already left
  the warehouse, so recording the smaller quantity would under-book stock movement and COGS
  permanently. Re-delivering the same order reaches the same conclusion, so the delivery is
  **acknowledged rather than retried**, and a warning naming the uncovered quantities is recorded
  against the order for someone to act on.

  This one is only decided **after the order's refunds have been read**. A delivery that carries both
  the completion and a refund — eight of ten shipped, two refunded, which is a complete dispatch —
  would otherwise be judged against demand that still counted the refunded units and be refused
  seconds before the refund was applied. The completion is therefore re-checked once the refund sweep
  for that order has finished, and only the second answer is recorded. If the refunds could not be
  read to the end, nothing is recorded at all and the delivery is retried.

Previously both took the same route and neither reached the caller at all: the store showed the order
as completed, IMS never created the shipment, the webhook was acknowledged, and nothing retried.

### Webhooks (Recommended)

Webhooks deliver order changes to One Two Inventory in real-time, rather than waiting for the next poll. To set up:

1. In the **Orders** tab, find the **Webhook Secret** section
2. Click **Generate Secret** — a random secret is created and saved immediately
3. **Copy the secret now** — it is only displayed once and cannot be retrieved later
4. Click **Setup Webhooks in WooCommerce** to auto-register the three required webhooks via the WC API:
   - `order.created` — imports new orders
   - `order.updated` — syncs status changes and refunds
   - `product.updated` — syncs product changes

Once the first webhook is verified, the polling interval field is replaced with a "Last received" timestamp. Webhooks and polling can coexist safely — order import is idempotent (duplicate imports are silently skipped).

### Status Mapping

The **Status Mapping** tab controls how WooCommerce statuses translate to One Two Inventory statuses. Each WooCommerce status (e.g. `processing`, `on-hold`, `completed`) maps to an IMS status via a dropdown. Changes are saved automatically.

**IMS to WooCommerce** status pushes are automatic for:

| IMS Status | WooCommerce Status |
|---|---|
| Shipped | `completed` |
| Cancelled | `cancelled` |
| On Hold | `on-hold` |

Other IMS status changes are not pushed back to WooCommerce.

### Tracking Sync (IMS to WC)

Shipment tracking is pushed back to WooCommerce when:

- a shipment is first shipped in IMS, or
- tracking on an already-shipped shipment is edited later in IMS

The WooCommerce connector writes AST-compatible order meta to `_wc_shipment_tracking_items`, matching the same tracking source that IMS already reads inbound for completion and delivery-status flows.

Behavior notes:

- Tracking is pushed per shipped shipment where shipment records exist
- Current fulfillment is shipment-based. Historical order-level tracking fallback exists only for older records that pre-date shipment rows.
- Re-saving the same tracking is idempotent and does not intentionally create duplicate upstream entries
- Reflected WooCommerce `order.updated` webhooks from IMS-originated status/tracking pushes are explicitly suppressed

## Product Sync

The **Products** tab controls bidirectional product synchronisation.

### Direction

- **WC to IMS** — product changes in WooCommerce are imported into inventory (name, description, images, weight, dimensions, GTIN, HS code, country of origin)
- **IMS to WC** — product changes in One Two Inventory are pushed to WooCommerce (name, description, prices)
- **Both** — sync runs in both directions

### What Syncs

**WooCommerce to IMS:**
- Product name, description (HTML stripped), image URL
- Weight and dimensions (length, width, height)
- GTIN/barcode from WooCommerce's `global_unique_id` field (only written if the IMS barcode field is empty)
- HS code and country of origin from WC product attributes (only written if the IMS fields are empty)
- **Categories** — the WC product-category tree is mirrored into IMS. Each WC category becomes an IMS reporting category with its WC parent chain preserved (so `Apparel > T-Shirts > V-Neck` arrives as a 3-level path). The product is linked to its **deepest** WC category. The mirror is cached for 5 minutes so per-product webhooks do not re-fetch the whole tree. If the WC categories endpoint is unreachable — or the category list cannot be read to its end — the product's existing category link is left alone rather than wiped or linked to a partial tree.
- Variable products: all variations are synced as child VARIANT products linked to the parent
- Variation attributes are synced for the options panel

**There is a supported size for a variable product: 1,000 variations.** A product's variations are
read in full *before* anything is written, and then applied in a single transaction, so a failure
anywhere leaves the catalogue exactly as it was. That transaction has a budget, and 1,000 variations
is what fits inside it. A larger product is **refused before the first write**, naming the count —
importing part of a product and reporting success would leave the catalogue silently incomplete. The
remedy is to split the product in WooCommerce; raising the limit means raising the write
transaction's budget with it.

Two related refusals come from the same place, and both are retried rather than needing a person. If
reading a product's variations takes longer than **five minutes**, the import gives up and comes back
later, so a slow store cannot leave a webhook in flight long enough for a second worker to pick the
same one up. And if the store serves **fewer variations than it says the product has**, the import is
refused rather than applied — a truncated variation list applied as if whole is the silent
incompleteness this connector exists to avoid.

**How the connector decides it has read a whole list.** Every paged read here — variations,
categories, tax rates, refunds — ends on an **empty page**, never on what the response headers say.
A store that does not send a page count is indistinguishable from one reporting a single page, and
`per_page` is a request rather than a grant, so a store that answers with its own smaller page size
does so with no error at all. Ending on either would silently import the first page of a list and
report it as the lot. Each walk also has a page ceiling so that a store ignoring the `page` parameter
is not asked for ever; reaching that ceiling is reported as an incomplete read, not treated as the
end of the collection.

### What the connector will NOT change

WooCommerce models two product shapes (`simple`, `variable`); IMS models six. A WooCommerce type is therefore an *absence* of information about everything else IMS knows, never an assertion that the product has none — so the import may set a product's type only when the existing IMS row is **SIMPLE**. On any other type the type write is dropped and everything else in the payload (name, price, images, dimensions, trade fields, category, WooCommerce mapping) still applies:

| Existing IMS type | Why the connector may not change it |
|---|---|
| KIT / BOM | Composition is IMS-owned and WooCommerce cannot express it. Flattening to SIMPLE left the component rows in place and stopped in-flight orders expanding into components |
| VARIABLE | Other rows carry its id as their `parentId`, and a parent must be VARIABLE. Flattening it orphans its children and leaves its option rows behind |
| VARIANT | A variant must stay attached to a variable parent. The import writes `type` but never `parentId`, so a detach would leave a SIMPLE row still carrying a parent |
| NON_INVENTORY | Means "not stock-tracked" (a service or fee). Converting it silently gives it stock levels, allocation and COGS |

A brand-new product still takes its type from WooCommerce: a row that does not exist yet has no structure to protect.

Two further refusals apply to rows the table above allows the connector to change:

- **A product that is in use is not restructured.** Before turning a SIMPLE row into a variable parent, or into a variation of one, the import runs the same checks the product editor runs: a product carrying stock, reserved stock, or open sales / purchase / manufacturing / stock-transfer documents is left exactly as it is. The exception row names what is blocking it — "stock on hand (5.00)", "1 open sales order line" — so the fix is the same one the editor would ask for. The structural write itself re-asserts that condition, so an order placed or stock received *while the import was running* still refuses the change rather than sneaking past a check that had already been answered.
- **A product that is already somebody's variation never becomes a parent.** If the IMS row carries a parent of its own, no variations are attached to it, whatever its type currently says.
- **A product that already has child rows is neither flattened nor promoted.** Only a variable product may have children, but nothing in the database enforces that, and older versions of this connector could leave a flattened product with its variants still attached. The import asks whether other IMS rows point at this one — it does not take the type's word for it — and if they do while the type says otherwise, it changes nothing: it will not price the row as a standalone product (which would bury the problem), and it will not turn it into a variable parent (which would silently adopt rows WooCommerce never mentioned). Repair it in the product editor — detach or remove the child rows, or make it a variable parent — and the next sync goes through.

When a refusal applies, the row is left **structurally and commercially** untouched: its type, its own regular/sale price and its variation options all stay as they are. Only the fields WooCommerce genuinely owns — name, description, images, dimensions, trade fields, category, status, WooCommerce mapping — are still written.

A variation is also only matched to an existing IMS row when that row is genuinely the one the WooCommerce variation owns: not mapped to a different WooCommerce object, not already a child of a *different* IMS parent, not itself a parent, of a type that can sit under a variable parent, and not carrying stock or open documents. A bare SKU match is not enough.

When a refusal means WooCommerce data goes **unimported**, the import is reported as failed, the product is not marked synced, and a row appears in the [Sync Exception Inbox](sync-exceptions.md). Resolve it in IMS or in WooCommerce; the next successful sync clears the row by itself. There are four ways to reach that state, and they are one rule — *the two systems disagree about whether the row is a variable parent*, asked of the row's **type and its actual child rows**, not of its type alone:

- a **variable** WooCommerce product paired with an IMS row that cannot be a parent (a kit, a row that is already somebody's variation, a row that already has child rows its type does not allow, or a row carrying stock or open documents) — none of its variations are imported;
- a **simple** WooCommerce product paired with an IMS **VARIABLE** row — its type and its price are not applied, and the IMS variants stay where they are. The connector will not delete IMS children that WooCommerce never asked it to remove;
- a **simple** WooCommerce product paired with an IMS row that has child rows while its type says it cannot — the same disagreement, reached through a row that is already invalid. Its type and price are not applied either;
- a single variation whose SKU resolves to an incompatible IMS row.

A kit or BOM paired with a **simple** WooCommerce product is **not** one of these. That is the ordinary bundle pairing: neither side claims the row is a parent, WooCommerce simply has nothing to say about composition, and nothing goes unimported — so the sync is clean and the product keeps receiving its price and status updates.

**IMS to WooCommerce:**
- Product name, description, regular price, sale price
- GTIN (only if purely numeric)

### Stock Sync (IMS to WC)

Stock levels are pushed from One Two Inventory to WooCommerce. Enable this in the **Products** tab under "Stock Sync".

- Only warehouses with **Sync to Store** enabled contribute to the stock count (configured per-warehouse in Settings > Inventory)
- Available stock = on-hand quantity minus reserved quantity, summed across all synced warehouses
- **Include COGS** — optionally pushes the oldest FIFO cost layer unit cost to WooCommerce's native COGS field (requires WooCommerce 9.2+ or the WC COGS plugin)
- Stock is pushed in batches of 100 products via the WC batch API

Use **Push Stock Now** for an immediate sync. Stock is still primarily event-driven from IMS changes, but the daily WooCommerce reconcile job also performs a forced stock catch-up and drains queued retry jobs as a safety net.

The manual push runs against the **saved** setting: ticking "Push stock levels to WooCommerce" takes effect only after **Save Settings**. Until then the Push Stock Now button is blocked with a hint. If a push is refused server-side anyway (sync disabled, missing credentials, or no Sync-to-Store warehouses), it reports a red error — e.g. "Stock sync is disabled in settings — nothing was pushed" — rather than completing quietly.

## Tax Rates

The **Tax Rates** tab maps WooCommerce tax rates to One Two Inventory tax rates. This ensures imported orders have the correct tax treatment.

1. Click **Import from WooCommerce** to fetch all tax rates from your WC store
2. The system automatically creates matching IMS tax rates or links to existing ones by name
3. Review the mapping table — each row shows the WC rate name, ID, country, percentage, and the linked IMS tax rate
4. Use the dropdown to change the target IMS tax rate if needed
5. Delete mappings that are no longer relevant

### Tax fallback policy

When a WC order line arrives with a tax rate ID that has no IMS mapping, the system falls through to the IMS tax-rate resolver. If the resolver finds a matching rate based on country and product category, that rate is used.

If the resolver also can't find a match, the system would fall back to the order-default tax rate. This is the point where things get dangerous: a misconfigured default could silently apply the wrong VAT to imports.

The system handles this two ways:

- **Non-zero fallback → import BLOCKED.** If the order-default rate is non-zero (most common case) and a line would use it, the import is rejected with a clear error message. A `tax_rate_fallback_blocked` activity log entry is written with the order details and the lines that hit fallback.
- **Zero-rated fallback → import allowed, but logged.** If the fallback is to a zero-rate, the import proceeds but a `tax_rate_fallback` warning activity entry is written so operators can review.

**To unblock a blocked order:** import the missing tax rates from WC, ensure the relevant country + category combination resolves, then retry the import from Sync > WooCommerce > Sync Log.

The Sales Settings page surfaces recent fallback events as a widget so you can spot misconfigurations early.

### Pending FX retry queue

WooCommerce orders in a currency for which IMS has no stored FX rate are queued rather than failed. The system writes a `PENDING` shoppingSyncLog row with the full order payload and a `wc_order_fx_pending` activity log entry.

When the next FX rate fetch succeeds, the queue is drained automatically and the queued orders are imported. If the queue grows beyond 5 entries (configurable via `WC_PENDING_FX_ORDER_NOTIFY_THRESHOLD`), an admin notification is sent.

## Refund Sync

Refunds created in WooCommerce are automatically synced to One Two Inventory:

- **Line-item refunds** (with quantities) create itemised refund lines and restock items to the default return warehouse
- **Monetary-only refunds** (no quantities) create a single refund line with the full amount and the WC refund reason

Refunds are deduplicated by WooCommerce refund ID, so they are safe to re-process.

**All of them, not the first ten.** WooCommerce returns refunds ten at a time unless asked for more, so an
order with many separate refunds used to sync only its ten most recent. Every page is now read. If a page
cannot be read, the sync keeps what it got and logs `wc_refund_read_incomplete` (WARNING) naming the order
and how far it reached — until the rest arrive, that order shows a smaller refunded amount than the store
does, and a 3PL despatch for it can be refused as uncovered. The next sweep re-reads the order from the
first page, so it clears itself.

### Parked refunds, and a refund parked against the wrong order

A refund the system cannot apply safely is **parked** and appears in **Sync → Exceptions** under
"WooCommerce refunds — parked". The refund, its credit note and its restock have not posted. **Retry**
re-fetches that order's refunds fresh from WooCommerce and re-attempts it.

A WooCommerce refund belongs to exactly one order, so a park recorded against the *wrong* order is an
anomaly the system deliberately refuses to resolve by itself — it will not move one order's refund
evidence onto another. Retry cannot fix it either: it re-fetches the order the park is sitting on,
and that order does not have the refund. Meanwhile the refund's real order cannot have it applied,
and neither order can be deleted.

Use **"Wrong order"** on the parked row. It offers two things, and checks both with WooCommerce
before changing anything:

- **It belongs to another WooCommerce order** — give the WooCommerce **order ID**, which is the
  `id=` in the address bar with that order open in WooCommerce (or the refund's own `parent_id`), and
  is *not* necessarily the order number shown to the customer. The two are the same on a plain store
  and differ wherever order numbering has been customised — and the wrong one addresses a different
  order or none. One Two Inventory asks WooCommerce which refunds that order actually has, right now,
  and refuses if this refund is not one of them. If it is, the park moves to that order and becomes
  retryable there. The refund itself has still not been applied — retry it from its new order.
- **WooCommerce no longer has it on this order** — for a refund that has since been deleted in
  WooCommerce. One Two Inventory asks WooCommerce which refunds *this* order has and refuses if the
  refund is still one of them. Dismissing only clears a park WooCommerce contradicts; it does not
  apply the refund anywhere, so if money did leave the business, reassign it instead.

Either way the WooCommerce answer it acted on — the order asked, the refunds returned, and the time —
is recorded in the activity log alongside who did it.

Both checks need WooCommerce's answer to be **complete**, because "this refund is not on that order"
is what they turn on. One Two Inventory reads every page of an order's refunds and works out where
the collection ends **from the pages themselves**. It does not take the store's page-count header for
an answer, since a store that sends no header is indistinguishable from one reporting a single page.
Nor does it compare a page against the size it *asked* for: `per_page` is a request, and a store
configured to serve fewer (a hosting limit, a security plugin, a proxy) answers a request for a
hundred with its own smaller page and no error at all — so "shorter than we asked for" would end the
walk on the very first page of such a store and call a tenth of the refunds the whole list.

**Only a page that comes back empty ends the walk.** A short page ends nothing, however short: the
size a store serves is not fixed, and a page trimmed by a proxy or by a plugin shedding load looks
exactly like the last page of a list. So the check keeps asking until a page comes back with nothing
on it. That costs **one extra request** for any order whose refunds do not happen to fill their last
page, and it is deliberate — a refusal can be retried, but a park dismissed over money that has
already left the business cannot be undone.

As a second guard, if the store states how many refunds the order has (the `X-WP-Total` header) and
serves fewer than that, the check is refused: that is the signature of a page trimmed in transit,
which no rule about page lengths can catch.

**And a list that changes while it is being read is refused as well.** WooCommerce serves refunds a
page at a time *by position* — "rows 100 to 199 of whatever is there when you ask" — so a refund
created or deleted on that order in the middle of the read shifts every later row along, and a refund
can slip through the gap between two pages without any page looking short. Nothing in the pages
themselves reveals it, and the totals do not either: the list still carries the refund that was
deleted, so it is one too long by exactly as much as it is one too short.

Two things catch it. If the same refund is served twice, on different pages, the read is refused —
that only happens when the list has moved. And **before a park is dismissed, the whole list is read a
second time and the two answers must match**, refund for refund. The refund that goes missing goes
missing because another one was deleted, and the store cannot serve that deleted refund again, so the
two reads disagree and the dismissal is refused. If it keeps happening, that order is being refunded
right now; leave the park alone until it settles.

This is only required for **dismissing** a park, and doubles the requests that check makes.
Reassigning is allowed by WooCommerce *listing* the refund on the order you named, and a list that is
short can only fail to show something — it can never invent it. Dismissing is allowed by the refund
being *absent*, and a list that is short produces absence out of nothing.

If the read cannot be completed — the store errors, an order carries more refunds than the check will
read, the list never ends within the pages the check reads, the store serves fewer refunds than it
says the order has, the list changes while it is being read, or a refund comes back with no readable
id — the recovery is **refused and nothing is changed**, rather than treating a list that might be
short as proof the refund is missing.

## Invoice Notes and Customer PDF Downloads

When an invoice is generated for a WooCommerce order, the system pushes invoice metadata to the WC order. The customer-facing invoice PDF download is then handled by the **OneTwoInventory Helper** WordPress plugin via a server-to-server handoff.

### How customer PDF downloads work

1. WC customer logs into their account and visits the My Account → Orders page (or the order detail page).
2. The helper plugin renders an **Invoice** button. The button URL is a WordPress nonce-protected REST endpoint on the WC site, NOT a direct IMS URL.
3. The customer clicks the button. The helper plugin:
   - Verifies the WC customer is logged in and owns the order (WordPress nonce + capability check).
   - Calls the IMS endpoint `POST /api/shopping/woocommerce/invoice-pdf` with an HMAC-signed payload containing the order ID, customer ID, timestamp, and nonce.
4. IMS verifies the HMAC signature, checks the order ownership, and streams the invoice PDF back to the helper plugin.
5. The helper plugin proxies the PDF to the customer's browser.

This means the customer never sees a direct IMS URL, no reusable token leaves the IMS, and order ownership is verified at both the WC and IMS layers.

### Shared secret

The HMAC signing key is the same value as the **WC webhook secret** (`wc_webhook_secret`). When you generate or rotate this secret in **Sync > WooCommerce > Orders**, paste the same value into the helper plugin's settings page (WP admin → Settings → OneTwoInventory Helper). The secret has two purposes:

1. Verifying incoming WC webhooks at IMS
2. Signing outgoing PDF requests from the helper plugin to IMS

Rotating this secret requires updating it in BOTH places — IMS and the WP helper plugin — or webhooks AND invoice PDF downloads will both break.

### Admin-only links

When the invoice is also synced to Xero, the system pushes an admin-only WC order note with a "View in Xero" link. This link is stored as WC order meta (`_accounting_invoice_url`) and is only visible to WC admin users.

## onetwoInventory Helper WordPress plugin

A single companion WordPress plugin provides every WC-side hook IMS uses. The plugin is **installable directly from the IMS sync page** — go to **Sync → WooCommerce → Connection** and click **Download plugin (.zip)**.

### What it does

- **Invoice buttons** (Customer My Account orders list, customer order detail, wp-admin order screen meta box). Reads `_invoice_pdf_url` and `_accounting_invoice_url` order meta. HPOS-compatible.
- **FX rate receiver** — exposes `POST /wp-json/oti/v1/fx-rates`. IMS pushes daily ECB rates here, signed with HMAC-SHA256 using the same shared secret as WC webhooks. Stored rates are surfaced to Aelia Currency Switcher via the `wc_aelia_currencyswitcher_exchange_rate` filter, so the storefront, IMS, and Xero see the same exchange rate.

### Installation

1. In the IMS, go to **Sync → WooCommerce → Connection** and click **Download plugin (.zip)**.
2. In WordPress admin, go to **Plugins → Add New → Upload Plugin**, choose the zip, and click **Install Now**.
3. Activate the plugin.
4. In WordPress admin go to **Settings → onetwoInventory** and paste the same shared secret used for WC webhooks (visible in the IMS Sync → WooCommerce → Orders tab).
5. Back in IMS, on the same Connection page, tick **Push FX rates daily** and click **Push Now** to verify connectivity.

### Aelia Currency Switcher

If you use Aelia, you do not need to register a custom rate provider — the helper plugin's filter takes effect automatically as soon as IMS has pushed at least one set of rates. Aelia's transient cache is invalidated on each push so new rates take effect immediately. Aelia per-currency markups still apply on top of the IMS rate; only the *base* rate is overridden.

### Other multi-currency plugins

The helper plugin only ships with the Aelia filter today. If you use a different multi-currency plugin (CURCY, WPML, Shopify Markets, etc.) the rates are still stored in WP options and exposed via `get_option('oti_fx_rates')` — write a small adapter in your theme's `functions.php` to feed them into your plugin's rate model.

## Sync Log

The **Sync Log** tab shows the last 100 synchronisation events. Each entry includes:

- **Direction** — From store (import) or To store (push)
- **Type** — ORDER, Product, or StockLevel
- **External ID** — the storefront entity ID
- **Status** — SYNCED, FAILED, or SKIPPED
- **Error** — details if the sync failed

Use this log to troubleshoot sync issues and verify that orders and products are flowing correctly.

## Cron Jobs

WooCommerce is now webhook-first. Scheduled jobs exist for backup reconciliation and retry draining, not as the primary intake path.

### Primary scheduled endpoint

Use `/api/cron/wc-reconcile` as the scheduled WooCommerce endpoint. By default it should run roughly daily.

What it does:

1. Reconciles orders if order webhooks are not active or the daily backup reconcile is due
2. Reconciles products if product webhooks are not active or the daily backup reconcile is due
3. Runs the daily stock catch-up by draining queued retry jobs and force-pushing current stock

Order reconcile also backfills orders that were intentionally skipped while `wc_initial_import_completed` was not yet `true`. The reconcile path uses its own `last_wc_order_reconcile_at` cursor, so the first reconcile after initial import completion can import those missed live orders.

**A product that can never import does not stall the rest of the catalogue.** Each product sync
carries a cursor — the point in WooCommerce's own modification history the next run reads from — and
it only moves forward on a run with no failures a retry could fix. A failure that *no* retry can fix
is treated as the opposite: a duplicate GTIN, a WooCommerce id already mapped to a different IMS
product, or a product-structure conflict is **counted and named at ERROR level, and the cursor moves
past it**. Holding the cursor for those was a stall, not caution — every later run re-read the whole
catalogue from the same watermark, re-imported all of it, and re-failed on the same product, for
ever.

The log line names each blocked SKU, and the manual product sync shows them as **blocked (needs an
operator)** separately from the error count, because re-running is the one thing that cannot help.
That line and the cursor move are written together: if the line cannot be recorded, the cursor does
not move either, so products are never skipped past with nothing naming them.
One thing to know when you fix one: if the remedy is on the IMS side — clearing a product's external
mapping, or resolving a structure conflict on [Sync Exceptions](sync-exceptions.md) — WooCommerce's
own record of the product has not changed, so the cursor has nothing to find. **Re-save the product
in WooCommerce** after fixing it and the next sync picks it up.

The cron endpoints require a `CRON_SECRET` header for security. Cron setup is usually handled by your administrator during deployment.

## Historical Order Import (Forecasting)

Separately from the order sync, you can import past completed WooCommerce orders for **demand forecasting** from the Analytics page. This creates stock movement records (not sales orders) used by the forecast algorithm. See the [Analytics documentation](analytics.md) for details.

## Warehouse Configuration

Stock sync and order allocation use warehouses marked with **Sync to Store**:

- Stock push aggregates available quantities across all synced warehouses
- Imported orders are assigned to the first synced warehouse that is also marked as default
- Configure this per-warehouse in **Settings > Inventory**

## Troubleshooting

| Issue | Solution |
|---|---|
| Orders not importing | Check that order sync is enabled, the initial import is complete, and the relevant WC statuses are selected |
| Webhooks not received | Verify the webhook secret matches in both systems. Check the Sync Log for entries. Try "Setup Webhooks" again. |
| Wrong tax on imported orders | Import tax rates from WooCommerce and verify the mappings on the Tax Rates tab |
| Stock not updating in WC | Ensure stock sync is enabled and at least one warehouse has **Sync to Store** checked |
| Duplicate orders | Order import is idempotent — duplicates are skipped. Check the Sync Log for SKIPPED entries. |
| Consumer secret rejected | Re-enter the full consumer secret (not the masked version). Generate a new key in WooCommerce if needed. |
