# Customer invoice in My Account: switch-on, overlap and rollback runbook

How the customer invoice (the PDF the accounting ledger issued, stored by IMS) is put in front of WooCommerce customers, in what order
the switches are thrown at the P2 switchover, what the customer sees while the old invoice plugin is still on, and how to take it back.
How the documents are found, fetched and stored is in [../invoice-documents.md](../invoice-documents.md); this page is only the
procedure.

Related code: `lib/domain/invoice-documents/` (fetch, store, read, on-demand queue), `lib/connectors/woocommerce/sync/invoice-document*.ts`
(the My Account flag), `app/api/shopping/[connector]/invoice-pdf` and `.../credit-note-pdf` (customer downloads),
`lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php` (the storefront side), `lib/order-email.ts` (the invoice e-mail).

**Names.** The storefront plugin is the **onetwoInventory Helper** (`onetwoinventory-helper.php`, settings page *Settings > onetwoInventory*).
Older notes call it `wc-invoice-handoff`; that name was never the plugin's. It is a different plugin from the old PDF invoices plugin
(WCPDF), which is the one switched off at step 7.

## What is switched by what

| Switch | Where | Default | What it does |
|---|---|---|---|
| `invoice_documents` cron | Settings > Cron | off | Runs the fetch: stored documents for new orders, the customer-requested queue, rechecks. Read-only toward Xero and the storefront. |
| `invoice_documents_sweep_floor` | Settings (date) | none | Orders created on or after this date are fetched by the cron without anyone asking. With no date the cron fetches nothing for new orders. |
| `invoice_documents_lazy_fetch_enabled` | Settings | off | A customer's first click on an order IMS holds no PDF for **queues** the fetch (historic orders). No bulk backfill. |
| `invoice_documents_credit_notes_enabled` | Settings | off | Credit note documents are fetched too (swept and on demand). |
| `invoice_documents_lazy_daily_cap`, `invoice_documents_lazy_outstanding_cap` | Settings (whole numbers) | 60, 60 | New customer requests per UTC day, and requests still waiting. Past either, the customer is told to try again later and nothing is queued. The defaults are derived from the Xero client's real limit (950 calls per rolling 24 hours, shared with all other Xero work): 60 documents x at most 3 reads = 180 calls, under 20%. Raising them is a decision about that shared limit. |
| `wc_invoice_document_enabled` | Settings | off | The publish side: writes `_ims_invoice_pdf_available = yes` on the WooCommerce order (the helper plugin then shows the button) and makes the invoice **e-mail** attach the stored ledger PDF. Every write also meets the producer-side hold. |
| Producer-side hold for the storefront | the existing hold machinery | held until the switchover | While it stands the publish job is a shadow: a record, nothing sent. |

Nothing in this procedure writes to Xero. Everything written to WooCommerce goes through the outbox operation
`woocommerce/order.invoice-document` and its hold; never by hand with a script.

## Order of operations at the P2 switchover

The decision (owner, 2026-11-09): **IMS goes live first, and the old invoice plugin (WCPDF) is switched off right after.** A customer who
sees two buttons for a short time is the cheaper mistake; a window with no invoice button is the dearer one. The overlap is accepted.

Before anything is switched on (the preconditions, each of which fails closed rather than half-working):

1. The helper plugin is installed on the live store at the current version, and **Settings > onetwoInventory** holds the invoice PDF shared secret
   (the same value as IMS setting `wc_invoice_pdf_secret`; it is NOT the webhook secret) and the HTTPS base URL of IMS. Without them the
   button answers "not configured". Check on stage first (the helper is not installed on stage at the time of writing).
2. `INVOICE_PDF_STORAGE_DIR` is **in the backup set** and a restore of it has been rehearsed. The files are a statutory record kept six years
   and the database rows only say which files exist.
3. Xero is connected and the sweep can read: run the cron once by hand with a floor in the future and confirm the run reports no failure.
4. The invoice the ledger holds carries the same number as the order (the order's invoice number is the storefront's, used verbatim). Check
   five recent orders in Xero by number. The reference field's format is **unverified** (the fetch ties a document to its order by total plus
   customer or date, and uses the reference when it matches); look at what Xero shows and write it down in the switchover notes.

Then, in this order:

1. **Fetch first, publish later.** Set `invoice_documents_sweep_floor` to the P2 go-live date, enable the `invoice_documents` cron.
   Watch the cron results: `stored` rises, `needsAttention` stays at 0 or is explained (Sync > Exceptions).
   Leave `wc_invoice_document_enabled` off. Orders accumulate stored documents with nothing shown to anyone.
2. **Historic orders.** **Not reachable from the storefront yet.** The queue behind `invoice_documents_lazy_fetch_enabled` is only started by a signed request through the helper plugin, and the shipped plugin refuses to show or accept a request for an order without the `_ims_invoice_pdf_available` flag, which is every historic order (see *The button for orders with no flag*). Until the plugin change below is deployed to the store, setting the flag changes nothing for a customer; the queue can only be started by a signed request made by hand. When that plugin change is ready, set `invoice_documents_lazy_fetch_enabled` to `true`. Leave the caps at their defaults. Xero's real limit is 950 calls per rolling 24 hours per organisation (not 5,000), shared with every other Xero job and the invoicing incumbent: each queued document costs at most three Xero reads, so the default 60 a day is at most 180 reads. Rechecks of stored documents are not counted by the cap; to protect other work the cron also leaves queued requests waiting (result `lazyDeferred: ledger-budget-low`) while fewer than 600 of the 950 daily calls are left. That check reads Xero's own `X-DayLimit-Remaining` as every worker last saw it (shared in table `xero_day_limit_observations`, migration `20261122120000_xero_day_limit_observation`; an observation older than an hour is not used), and the lower of that and the worker's own figure. When no worker has seen it in the last hour the budget counts as unknown and the requests wait too (`lazyDeferred: ledger-budget-unknown`). A queued request that has waited 14 days without being fetched is handed to a person (status needs attention, activity `invoice_document_needs_attention`, result `lazyAgedOut`) even if no fetch was ever tried, so a budget that stays low cannot fill the waiting cap for good; the customer is then told the document is not available. Credit notes: leave `invoice_documents_credit_notes_enabled` off until a credit note has been
   fetched and checked by hand (see *Verification*), because the number a credit note carries in Xero is unverified.
3. **Lift the storefront hold and turn publishing on** at the switchover, together: set `wc_invoice_document_enabled` to `true`. The next
   `shopping-webhook-inbox` pass queues one publish job per stored document, and the drain writes the flag.
   From this moment a customer can see the **IMS** button on every order that has a stored document, **and the invoice e-mail carries the
   ledger PDF**.
4. **Right after, switch off the old plugin's customer output** in WordPress (a Woo-side step, owner-run): its My Account button, its invoice
   attachment on order e-mails, and the Xeroom invoice note. Do not deactivate anything that still **numbers** invoices: the order's invoice
   number is the old plugin's `_wcpdf_invoice_number` and Xeroom reads it. Who numbers invoices after the old plugin is gone is an open owner
   question; until it is answered, keep the numbering part running.
5. Verify (below), and write the time of each step in the switchover log.

### What a customer sees while both are on (the overlap)

* **Two download buttons** on the order, the old plugin's and the helper's, and **two renderings of the same invoice number**: the old plugin's
  own PDF and the ledger's PDF. The ledger's is the invoice.
* **Two admin notes** on the order if the incumbent still writes its note.
* The e-mail carries the ledger PDF from step 3; the old plugin's attachment stops at step 4.
* Support answer: "use the **Invoice** button / the attachment in the e-mail", and nothing else. Do not hand-edit order meta to hide a button.

The overlap ends when step 4 is done. If it must be shortened, do step 4 first for the My Account button only.

## Historic orders and the "preparing" answer

No historic order is fetched in advance. The first time a customer clicks, IMS **queues** one read of that order's invoice and answers
"preparing"; the cron fetches it (a few per run, ahead of the other work); a later click is served the PDF. Repeated clicks do not queue
again and never reach Xero; the queue is capped per day and in total (settings above). A document Xero does not hold is retried after 10
minutes, 30 minutes, 2 hours, 6 hours, then daily, and after 14 days it needs a person (Sync > Exceptions).

* **The button for orders with no flag.** The helper plugin shows its button only when the order's `_ims_invoice_pdf_available` is `yes`.
  IMS writes that flag only for an order that has a stored document, and writes nothing to historic orders in bulk. A historic order
  therefore has **no helper button** until the plugin is changed to show it for orders that carry the old invoice number
  (`_wcpdf_invoice_number`, which IMS reads). **This gap is entirely on the WooCommerce plugin side, not an IMS defect:** the plugin hides the button and, in its own permission check, refuses the request itself (404) before IMS is ever called, so nothing IMS can change lets a historic order's customer start the fetch. IMS side is complete and tested (the endpoint queues and answers 202 for an order with no flag). The on-demand flow for customers therefore needs the plugin change deployed first; it is not available merely by turning the setting on. That rule is the plugin's; IMS answers any such order through the same endpoint. It is pinned in
  `tests/fixtures/woo-helper-invoice-contract.json`. Until that plugin change ships, historic customers keep the old plugin's button, so
  **do not remove the old plugin's My Account button for orders older than the go-live date** (decision needed from the owner).
* **What the customer sees on a "preparing" click.** IMS answers HTTP 202 with `{ "status": "preparing", "retryAfterSeconds": 900 }`. The
  helper plugin of today turns any answer other than 200 into a generic "Invoice not found" error, so the customer sees that and clicks again
  later. A friendlier message is a plugin change.
* The cron runs every 15 minutes by default, so "later" is about a quarter of an hour. Tightening the `invoice_documents` schedule shortens it.

## Verification

After step 1 (fetch):

* Cron run results: `stored` > 0, `failed` 0, `needsAttentionTotal` explained. Sync > Exceptions shows nothing new for invoice documents.
* Pick three orders. Open the invoice from the order screen in IMS: it is the **ledger's** PDF (the number and totals match Xero), not IMS's own
  rendering. The header `X-Invoice-Document-Status` is absent (not withdrawn).
* The storage directory holds `documents/<order id>/<sha256>.pdf` for them and the backup job includes the directory.

After step 3 (publish):

* Activity log and `writers:check` show `woocommerce.order.invoice-document` as written; no `held` retries accumulating.
* In WooCommerce, one stored-document order has meta `_ims_invoice_pdf_available = yes` and **no other meta of ours changed**.
* As that order's customer (a test account's own order): My Account > Orders shows **Invoice**; the PDF opens and is the ledger's. As a **different**
  customer, and signed out: not served (the helper refuses at the storefront, IMS refuses at its own check; both are logged).
* Send the invoice e-mail for a stored-document order (**Email PDF**): the attachment is the same PDF. With `wc_invoice_document_enabled` off
  the attachment is IMS's own rendering, as before.
* A historic order (no stored document): click as its customer through the helper (only once the plugin change above is deployed; the shipped plugin shows no button for it) or make a signed request by hand: the answer is 202 "preparing", the
  activity log shows `invoice_document_requested` once however often it is clicked, and after the next cron run the PDF is served.
* Credit notes (only once enabled): a refunded order's credit note is fetched and, through `/api/shopping/woocommerce/credit-note-pdf` with
  the Woo refund id, served to that order's customer and refused for any other order's refund.

After step 4: the old plugin's button and attachment are gone, and one invoice remains.

## Rollback

Fastest, and enough for almost everything: **set `wc_invoice_document_enabled` to `false`.** From that moment no publish job is scanned, queued,
claimed or sent (a job already claimed re-reads the switch immediately before it sends), and the invoice e-mail goes back to attaching IMS's own
rendering. The stored documents stay; nothing is deleted.

That does not take the button off orders already flagged. To do that, **clear the meta on the storefront**:

1. List the flagged orders (WooCommerce, meta `_ims_invoice_pdf_available = yes`).
2. Remove the meta from each, or set it to empty. The helper shows the button only for exactly `yes`, so an empty value hides it. Do this with the
   store's own tools (wp-cli `wc` commands or the admin), **on stage first**, as an owner-run step; IMS has no "clear" writer and does not
   write to the storefront during a rollback. Test the exact command on stage and write it into the switchover notes before the switchover,
   not during an incident.
3. If publishing will be turned back on later, also clear IMS's record of what it wrote, or IMS will believe the flag is still there and send
   nothing: `UPDATE invoice_store_publications SET flag_document_id = NULL, flag_written_at = NULL;` (operator-run SQL, one statement, a
   transaction, after a database backup). Without this, re-enabling republishes nothing.

Turn the old plugin's customer output back on if the rollback is more than a few minutes (the reverse of step 4).

Not part of a rollback: the cron, the fetch and the stored documents. They are read-only and harmless to leave running; to stop them, disable
the `invoice_documents` cron and `invoice_documents_lazy_fetch_enabled`.

## Owner questions this runbook depends on

* Who numbers invoices once the old plugin is gone (Xeroom reads `_wcpdf_invoice_number`)? During the parallel phase the numbers stay the
  Xeroom-generated ones everywhere; no change is made here.
* Should the helper plugin show its button, and a "preparing" message, for historic orders without the flag (a plugin change)? **This blocks the on-demand flow: without it no customer of a historic order can start the fetch.**
* Backup set for `INVOICE_PDF_STORAGE_DIR` (the IMS host's backup status).
