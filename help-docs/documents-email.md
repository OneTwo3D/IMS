# Documents & Email

## PDF Document Generation

The system generates branded PDF documents for all key business transactions. PDFs are created server-side and open in a new browser tab for viewing or downloading.

### Branding

- **Document logo** — a rectangular logo displayed at the top of every document. SVG logos are supported and automatically converted to PNG for PDF embedding. Logo loading includes path traversal protection to prevent unauthorised file access.
- **Accent colours** — your brand colours are applied to document headers and table styling.
- **Auto-contrast text** — text colour on coloured backgrounds (title bar, table headers) automatically adapts for readability on both light and dark backgrounds.
- **Company address** — formatted on separate lines as configured in company settings.

### Template Fields

All PDF routes now correctly load and render the full set of template fields:

- **Header note** — text displayed above the line items
- **Footer note** — text displayed below the line items
- **Terms & conditions** — printed at the end of the document
- **Payment terms** — payment terms text included on the document
- **Custom page footer** — text at the bottom of every page

### Footer & Contact Details

- **Department email** — each document type shows the relevant contact email in the footer. Sales-related documents (invoices, sales orders) display the sales email. Purchase-related documents (purchase orders, RFQs) display the purchases email.
- **Custom page footer** — configurable per document type, printed at the bottom of every page. Use this for your registered address, company number, VAT number, or other legal text.

### Layout

- Totals are right-aligned with the last column of the line items table for a clean, professional appearance.


## Secure PDF Links

Invoice and credit-note PDFs are served behind **single-use, time-limited tokens** rather than direct file paths. When you click "View PDF" or "Email PDF":

1. The system generates a token bound to your current session **and your IP address**.
2. The token is short-lived. Its lifetime comes from `INVOICE_PDF_TOKEN_TTL_SECONDS`; with that
   unset the code default is `DEFAULT_INVOICE_PDF_TOKEN_TTL_SECONDS` in `lib/invoice-pdf.ts`,
   which is ten minutes (the sample `.env` ships `259200`, 72 hours). Whatever is configured is
   capped at `INVOICE_PDF_TOKEN_MAX_TTL_SECONDS`, thirty days. Documented as "15 minutes" until
   r34's duration audit, which matched no constant in the file.
3. The PDF route checks the token, the bound session, and the requesting IP before streaming the file.

A token issued on one network cannot be replayed from another, and tokens cannot be shared between users. If a customer needs the PDF, use the **Email PDF** action — the recipient receives the file as an attachment, not a link.

### WooCommerce customer-facing PDF download

WooCommerce customers can download their invoice PDF from their Order page in the WC storefront. The flow is:

1. The customer clicks "Download Invoice" on the WC order page.
2. The WordPress helper plugin (`wc-invoice-handoff`) calls IMS with a customer-scoped token.
3. IMS verifies the WC order maps to a real IMS invoice and that the requesting customer owns it.
4. The PDF is streamed back to the customer through the WC storefront.

No IMS login is required for the customer — authorisation comes from the WC session plus the order-ownership check on the IMS side. The handoff token is single-use and short-lived.


## Document Types

| Document | Notes |
|---|---|
| Sales Order | Order confirmation for customers |
| Invoice | Customer invoice with auto-generated number |
| Packing Slip | Picking/packing checklist with SKU, product name, location, quantity, and a tick box per line. Available from the sales order detail page. Groups items by shipment when an order has multiple shipments from different warehouses. If shipments have not yet been created, it falls back to the sales order lines. |
| Credit Note | Generated from refunds |
| Purchase Order | Includes product barcode/EAN column |
| RFQ (Request for Quotation) | Purchase order without prices; includes barcode/EAN |
| Manufacturing Order | Production order sent to third-party manufacturers; includes component barcode/EAN |


## Document Templates

Configure templates for each document type in **Settings > Company > Documents** tab.

### Template Fields

| Field | Description |
|---|---|
| Header note | Text displayed above the line items table |
| Footer note | Text displayed below the line items table |
| Terms & conditions | Printed at the end of the document |
| Custom page footer | Text at the bottom of every page |
| Payment terms | Payment terms text included on the document |

### Toggles

- **Show logo** — include or exclude the document logo
- **Show VAT** — show or hide VAT details and breakdown
- **Show payment terms** — include or exclude payment terms text

### Preview

Each document type has two preview buttons:

- **PDF Preview** — generates a sample PDF with placeholder data and opens it in a new tab
- **Email Preview** — generates a sample email and opens it in a new tab

Previews always use the latest saved settings and are never cached, so you see your changes immediately.


## Email Templates

When you email a document (e.g. sending a purchase order to a supplier or an invoice to a customer), the system sends a branded HTML email via SMTP with the PDF attached.

### SMTP Sending

Emails are sent server-side using nodemailer via your configured SMTP settings (see **Settings > Company > Email/SMTP**) rather than by opening a mailto link in your browser. The email buttons on sales orders and invoices do **not** reach SMTP themselves — they add the email to the outbox described under [The Email Queue](#the-email-queue) below, and the background job is what connects to your SMTP server. The following email functions are available:

- **sendSalesOrderEmail** — queues the sales order PDF for delivery to the customer
- **sendInvoiceEmail** — queues the invoice PDF for delivery to the customer

Both functions attach the generated PDF document to the queued email automatically.

### The Email Queue

Emails are not sent from the button click. They are written to an outbox and delivered by a
background job (`/api/cron/email-outbox`), so a slow or unreachable SMTP server never blocks the
screen you are on. That job runs on whatever schedule your cron daemon calls it with — the
expected cadence is in the cron table under **Settings > System** — so a queued email goes out on
the job's next run, not immediately.

- **One undelivered copy per document.** If you press the email button again while the first
  copy is still waiting to go out, the system does **not** queue a second one — the activity log
  records "already queued and undelivered — not duplicated". Once the email has actually been
  sent (or has permanently failed), pressing the button again queues a fresh copy, so a
  deliberate re-send after correcting an address still works.
- **Retries.** A temporary SMTP failure is retried with a growing delay, up to five attempts,
  after which the email is marked failed with the last error.
- **Suppression.** A recipient the SMTP provider rejects as invalid is added to the suppression
  list, and later emails to that address fail immediately instead of being retried.
- **What the four contention counts in the activity log mean.** Each run logs a line like
  `Email outbox: 3 sent, 0 failed, 0 reclaimed after a send, 0 reclaimed before one, 0 unresolved
  after a send, 0 unresolved before one, out of 3 processed`. All four count a row this run had
  claimed and was then refused the final write on. They split along two questions, and the split
  matters because only one corner means a customer may have got two emails.

  *Was another run's takeover actually established?* **Reclaimed** means yes: the row was read back
  afterwards and it was either holding another run's claim, or holding no claim at all when every
  write this run issued had come back — so something else released it. **Unresolved** means no: the
  row could not be read, or it was gone, or it still carried this run's own claim, or this run's own
  final write never answered and may itself be what settled the row. An unresolved count is a count
  of *missing evidence*, not of contention — a rising "unresolved" with "reclaimed" at zero points at
  a database connection problem, not at two runs fighting.

  *Had this run already entered the sender?* **After a send** means yes — the send call had been
  made, so a copy may be on the wire. It is not proof the message reached SMTP: if SMTP is not
  configured, or the from-address is rejected, the send call returns an error without contacting a
  mail server at all, and it is counted here just the same. **Before one** means the send was never
  called, so this run put nothing on the wire whatever the cause.

  So **reclaimed after a send** is the one that means the customer may have received two copies —
  *may*, because it rests on the send having actually reached a mail server, which is not something
  the run records: with SMTP unconfigured, or a rejected from-address, both runs can be counted here
  having delivered nothing at all. It is a duplicate that is *possible*, not one that is "likely".
  **Unresolved after a send** means a copy may be on the wire but nothing establishes that a second
  one follows — it is not a duplicate report. The server log line for each row names the specific
  diagnosis behind it. None of the four leaves the email stuck: whichever run settled the row is the
  one that finished it.

### Dispatch Email (direct orders)

Direct (non-storefront) sales orders can optionally email the customer a branded dispatch notification when the order ships. Storefront orders are always excluded — the storefront (e.g. WooCommerce) sends its own dispatch email once IMS pushes tracking back, so customers are never emailed twice.

- **Opt-in** — off by default; enable in **Settings > Sales > Dispatch Email** (`dispatch_email_enabled`).
- **Trigger** — queued when the order transitions to SHIPPED (all shipments dispatched); queued at most once per order, deduped under the order row lock.
- **Content** — branded HTML email (no PDF attachment) with the order reference, the dispatched items, carrier and tracking number(s) per shipment, and a "Track your delivery" button linking to the carrier's tracking page (falls back to a universal tracker for unknown carriers).
- **Delivery** — sent through the email outbox (`SHIPMENT_DISPATCHED` kind) with the same retry/suppression handling as other queued emails.

### Email Structure

- **Header** — company logo (document logo or icon logo) with your brand accent colours
- **Greeting** — personalised greeting to the recipient
- **Body** — document-specific content
- **Header note** — from the document template, included in the email body
- **Footer note** — from the document template, included below the body
- **Company footer** — company name, address, and contact details

### Branding

Email templates use the same branding configuration as PDF documents — your logo, accent colours, and company details are applied consistently across both formats.
