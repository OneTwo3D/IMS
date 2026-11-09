# Customer invoice documents (read side)

IMS keeps the customer-facing invoice (and credit note) PDF that the accounting ledger issued, so it can show it to the
customer, attach it to e-mails and keep it as the statutory record. This page covers the read side: finding the document in
the ledger, fetching it, storing it. **Nothing here writes to the ledger or to the storefront**, and nothing here writes
`SalesOrder.accountingInvoiceId`.

## Why IMS has to go and look

The ledger document is created by another writer (the sales invoicing incumbent keeps that job in every phase), so IMS never
posts it and holds no ledger id for it. IMS finds it by its **number**, the same number the order carries from the storefront
(`SalesOrder.invoiceNumber`, the storefront's own invoice number, used verbatim). For a credit note the number is the
refund's `creditNoteNumber`.

## What it does

1. **Per-document lease first.** The document's fetch state is leased (3 minutes, taken by an atomic compare-and-set) BEFORE the ledger is read, and held through lookup, download, version promotion and the `invoicePdfPath` pointer. A second fetch of the same document answers `busy` and does nothing, so two overlapping fetches run one after the other and the later one reads the ledger as it then is: an older PDF can never be promoted over a newer one. An expired lease is a crashed holder and is taken over.
2. **The number must be unique in IMS.** The storefront's invoice number is not unique in IMS, so if any other order (or, for a credit note, refund) carries the same number the document **needs a person** and nothing is fetched.
3. **Lookup by number**, read-only and fail-closed (`lookupXeroInvoiceNumberClaim`; the credit note equivalent asks for sales credit notes only). A page that cannot prove it holds the whole answer, an answer that cannot be attributed to an organisation and a number the ledger's filter cannot express are failures, never "nobody holds it".
4. **Selection** (`claim-selection.ts`): exactly one live (authorised or paid) document is taken. A draft or submitted document, or none yet, is **waited for**. Two live documents, or a status IMS does not know, need **a person** and are not retried. A **voided** document is taken only for an order IMS holds as **cancelled** (exactly one voided and no live one); on an active order a voided invoice is waited for (the replacement is usually coming) and escalated after 14 days.
5. **The document must be THIS order's** (`order-evidence.ts`). A number does not prove it. The ledger's own record must agree with the order on independent keys: for an invoice the **total** (within 0.02, required, and the ledger must report it). The expected gross is the order's `totalForeign` PLUS `storeCreditForeign` (store credit, wallet and gift card): the import records what the customer PAID, while the invoice states the full goods value and the credit is settled against it as a payment (the importer proves lines + tax + shipping - discount - credit = total before it accepts the credit). It is derived only for an order whose credit was assessed; credit that was never assessed, or an order held for store-credit review, needs a person and **currency**, plus at least one of **reference** (contains the order's storefront or IMS order number, on token boundaries), **customer name** (normalised) and **date** (within 14 days of the order). A credit note has no gross total to compare (a refund stores net amounts), so it needs two of the three. Any mismatch needs a person and stores nothing, and the PDF is not even downloaded. **Unverified:** what the invoicing writer puts in the ledger's Reference field; the reference key is used when it matches and never required, so a store whose Reference is empty is tied by total plus customer or date.
6. **Download** the PDF (`Accept: application/pdf`) BOUND to the organisation and connection generation that answered the lookup (the download is refused before it is sent if either changed), then **re-read the document** and require that the same connection answers and that its id, status, total, currency, customer, reference, date and last-modified stamp are unchanged and it still passes selection and the order evidence. A change between the check and the download discards the bytes and the next pass starts again. A document therefore costs three GETs (lookup, PDF, re-read). The PDF is validated before it is kept: starts with `%PDF-`, ends with an end-of-file marker, at least 200 bytes, at most `INVOICE_DOCUMENT_MAX_BYTES` (default 10 MB). A login page or a truncated download is refused and retried.
7. **Store and publish** (nothing goes through a mutable file). The bytes are written to an immutable, hash-named file `INVOICE_PDF_STORAGE_DIR/documents/<order id>/<sha256>.pdf` and a `SalesOrderInvoiceDocument` row records the version (ledger id, number, status, SHA-256, size, path, fetched at). **Promotion is one database transaction whose first statement checks the lease token**: it sets the new row current, supersedes the previous one and points `SalesOrder.invoicePdfPath` (kept only as a compatibility "an invoice exists" marker) at the new file. An expired holder fails that check and publishes nothing, and because files never change only the row decides what is served. A re-issued or amended document is a new row; the previous file stays.

Every ledger call is a GET through the connector's own request path, so its minute and daily budget, egress authorisation and tenant pinning apply. A document costs at most three GETs.

## How the PDF is read

Every reader (the customer download route, the staff routes, the invoice e-mail) resolves the order's CURRENT document row and streams its hash-named file (`loadCurrentInvoicePdf`). The bytes are hashed on the way out and must equal the row's SHA-256: a missing or altered file is **not served**, and the document is made due for a re-fetch. An order with no document row (an invoice IMS posted itself) falls back to the legacy flat file; once a row exists the flat file is never read. The sweep also verifies stored files on a rolling scan (100 per run, cursor in `invoice_documents_integrity_cursor`) and makes a bad one due. A crash between the file write and the promotion leaves a file with no row: nothing is current, the orphan is never served, and the next sweep fetches the document again.

## The order changes under a stored document

The importer can correct an order's invoice number while no ledger invoice is linked, and the ledger can void a stored invoice. Both are handled on the READ and the PROMOTION:

* A document is served only while its number equals the order's CURRENT invoice number; a document fetched under the old number is not served and is made due, and the sweep fetches the one under the corrected number.
* Promotion takes a share lock on the order row, re-reads the fields the document was judged against (invoice number, status, total, store credit, customer, currency) and aborts, discarding the bytes, if any moved while the three GETs were in flight.
* A recheck that finds the current document **voided on an order that is not cancelled** marks it **withdrawn**: bytes and history stay, no customer-facing reader serves it, staff can still open it (labelled `-WITHDRAWN`, header `X-Invoice-Document-Status`), until a valid replacement is promoted.

## Amended documents: rechecks

The ledger can amend or re-issue a document after IMS stored it, so a stored document is looked at again **1 day, then 7 days, then every 30 days** after the last look (the next time is on the document's fetch state). The sweep picks due rechecks up (they are not limited to the floor date), and the customer download route looks again, on the first request after one falls due, before it serves (setting `invoice_documents_lazy_fetch_enabled`; the stored PDF is served if the ledger cannot be asked). A changed document (different hash) is promoted by the versioning rule above; a recheck that cannot get an answer leaves the stored version in place and never escalates a "missing" document.

## The four order kinds

Paid orders, store-credit orders and cancelled orders are fetched the same way, except that a voided document is accepted only for a cancelled order (see above). Credit notes are separate documents tied to their refund (`refundId`) and are fetched only when `invoice_documents_credit_notes_enabled` is `true`. **Unverified:** that the number the ledger's credit note carries is the refund's `creditNoteNumber`, and that the ledger serves a credit note as a PDF. Until both are confirmed against the real tenant a credit note is simply not found and waits, then escalates; nothing wrong is stored.

## When it runs

* **Sweep** (`invoice-documents`, off by default, every 15 minutes when on): fetches for WooCommerce-linked orders created at or after the date in setting `invoice_documents_sweep_floor`. **With no date it does nothing.** At most 20 documents per run; it stops at once when the ledger refuses or rate-limits, and after three failures in a row.
* **Lazy fetch** for historic orders: when a customer asks for a PDF IMS does not hold (the signed customer download route, after the caller has proved they own the order and the request's one-time nonce is spent), and `invoice_documents_lazy_fetch_enabled` is `true`, IMS asks the ledger for that one order. Repeated clicks are throttled per document by the same backoff, so a customer cannot drive ledger traffic. There is no bulk backfill.

## Waiting, backoff, attention

A document the ledger does not hold yet is retried after 10 minutes, 30 minutes, 2 hours, 6 hours, then daily. Missing for 14 days, ambiguous in the ledger, or an unaskable number: the fetch state becomes **needs attention**, an `invoice_document_needs_attention` WARNING is written to the activity log for the order, and the sweep does not retry it. The cron run result reports the totals (`needsAttentionTotal`, `pendingTotal`).

## Retention and backup

A statutory record, kept six years. **Nothing in IMS deletes a document row or a stored file** (pinned by `tests/invoice-documents/retention.test.ts`); a retention job is an owner decision. The storage directory **must be in the backup set**, restored with the database (see installation.md). The tables are `MUST_BE_EMPTY` for a first load.

## Not here (next step)

Publishing to the customer's WooCommerce My Account (the order meta that makes the helper plugin show the button, including for historic orders that have no flag) and the credit note download route are the publish side and are not part of this change.
