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

1. **Lookup by number**, read-only and fail-closed (`lookupXeroInvoiceNumberClaim`; the credit note equivalent asks for sales credit notes only). A page that cannot prove it holds the whole answer, an answer that cannot be attributed to an organisation and a number the ledger's filter cannot express are failures, never "nobody holds it".
2. **Selection** (`claim-selection.ts`): exactly one live (authorised or paid) document is taken. A draft or submitted document, or none yet, is **waited for**. Two live documents, several voided ones with no live one, or a status IMS does not know need **a person** and are not retried. A single voided document is taken (a cancelled order's invoice is still the customer's document).
3. **Download** the PDF (`Accept: application/pdf`), validated before it is kept: starts with `%PDF-`, ends with an end-of-file marker, at least 200 bytes, at most `INVOICE_DOCUMENT_MAX_BYTES` (default 10 MB). A login page or a truncated download is refused and retried.
4. **Store** it content-addressed under `INVOICE_PDF_STORAGE_DIR/documents/<order id>/<sha256>.pdf` and record a `SalesOrderInvoiceDocument` row (ledger id, number, status, SHA-256, size, path, fetched at). A re-issued or amended document is a **new row**; the previous one is marked superseded and its file stays. For an invoice the order's flat `<order id>.pdf` and `invoicePdfPath` are updated to the current version, which is what the existing customer download route and the invoice e-mail read.

Every ledger call is a GET through the connector's own request path, so its minute and daily budget, egress authorisation and tenant pinning apply. A document costs at most two GETs.

## The four order kinds

Paid orders, store-credit orders and cancelled orders are all fetched the same way: the document is chosen by number and status, not by the order's own state. Credit notes are separate documents tied to their refund (`refundId`) and are fetched only when `invoice_documents_credit_notes_enabled` is `true`. **Unverified:** that the number the ledger's credit note carries is the refund's `creditNoteNumber`, and that the ledger serves a credit note as a PDF. Until both are confirmed against the real tenant a credit note is simply not found and waits, then escalates; nothing wrong is stored.

## When it runs

* **Sweep** (`invoice-documents`, off by default, every 15 minutes when on): fetches for WooCommerce-linked orders created at or after the date in setting `invoice_documents_sweep_floor`. **With no date it does nothing.** At most 20 documents per run; it stops at once when the ledger refuses or rate-limits, and after three failures in a row.
* **Lazy fetch** for historic orders: when a customer asks for a PDF IMS does not hold (the signed customer download route, after the caller has proved they own the order and the request's one-time nonce is spent), and `invoice_documents_lazy_fetch_enabled` is `true`, IMS asks the ledger for that one order. Repeated clicks are throttled per document by the same backoff, so a customer cannot drive ledger traffic. There is no bulk backfill.

## Waiting, backoff, attention

A document the ledger does not hold yet is retried after 10 minutes, 30 minutes, 2 hours, 6 hours, then daily. Missing for 14 days, ambiguous in the ledger, or an unaskable number: the fetch state becomes **needs attention**, an `invoice_document_needs_attention` WARNING is written to the activity log for the order, and the sweep does not retry it. The cron run result reports the totals (`needsAttentionTotal`, `pendingTotal`).

## Retention and backup

A statutory record, kept six years. **Nothing in IMS deletes a document row or a stored file** (pinned by `tests/invoice-documents/retention.test.ts`); a retention job is an owner decision. The storage directory **must be in the backup set**, restored with the database (see installation.md). The tables are `MUST_BE_EMPTY` for a first load.

## Not here (next step)

Publishing to the customer's WooCommerce My Account (the order meta that makes the helper plugin show the button, including for historic orders that have no flag) and the credit note download route are the publish side and are not part of this change.
