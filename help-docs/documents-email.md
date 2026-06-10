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
2. The token is valid for a short TTL (default 15 minutes).
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

Emails are sent server-side using nodemailer via your configured SMTP settings (see **Settings > Company > Email/SMTP**). The email buttons on sales orders and invoices send directly via SMTP rather than opening a mailto link. The following email functions are available:

- **sendSalesOrderEmail** — sends the sales order PDF to the customer
- **sendInvoiceEmail** — sends the invoice PDF to the customer

Both functions attach the generated PDF document to the email automatically.

### Email Structure

- **Header** — company logo (document logo or icon logo) with your brand accent colours
- **Greeting** — personalised greeting to the recipient
- **Body** — document-specific content
- **Header note** — from the document template, included in the email body
- **Footer note** — from the document template, included below the body
- **Company footer** — company name, address, and contact details

### Branding

Email templates use the same branding configuration as PDF documents — your logo, accent colours, and company details are applied consistently across both formats.
