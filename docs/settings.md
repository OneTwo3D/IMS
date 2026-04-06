# Settings

Settings are organised in the sidebar under seven sub-sections. Each section controls a different aspect of the system.

## Company Settings

Found at **Settings > Company**, this is where you configure your organisation's core details and branding.

### Company Details

- **Company name** and **legal name**
- **VAT number** and **company number**
- **Address** (used on documents and invoices)
- **Contact information**

### Logos

Upload two logos for use across the system:

- **Icon logo** — a square image used in the sidebar and on the login page
- **Document logo** — a rectangular image used in PDF headers (invoices, sales orders, etc.)

### Branding

Customise the look of the application and your documents:

- **Primary colour** — sets the title bar colour
- **Accent colour** — sets the table header colour

A live preview updates as you adjust colours, so you can see the result before saving.

### Document Numbering

Configure the prefix and padding for auto-generated document numbers:

| Document Type | Example |
|---|---|
| Sales Order | SO-00001 |
| Purchase Order | PO-00001 |
| Invoice | INV-00001 |
| Credit Note | CN-00001 |

Set your preferred prefix (e.g. `SO`, `INV`) and padding length (e.g. 5 digits) for each type.

### Email / SMTP

Configure outbound email for sending documents and notifications:

- **SMTP host**, **port**, and **security** (TLS/SSL)
- **Credentials** (username and password)
- **From name** and **from email address**
- **Reply-to address**

### Department Emails

Set dedicated email addresses for each department. These appear on the relevant documents:

- **Sales email** — shown on invoices and sales orders
- **Purchases email** — shown on purchase orders and RFQs
- **Support email** — for general enquiries

### Document Templates

Configure templates for seven document types:

- Sales Order
- Purchase Order
- Invoice
- Packing Slip
- Credit Note
- RFQ (Request for Quotation)
- Manufacturing Order

Each template supports:

- **Header note** — text displayed at the top of the document
- **Footer note** — text displayed at the bottom of the document body
- **Terms & conditions** — printed on the document
- **Custom page footer** — appears at the very bottom of each page
- **Show logo** toggle
- **Show VAT** toggle
- **Show payment terms** toggle

Use the **PDF preview** and **Email preview** buttons to see how your template looks with sample data. Previews open in a new tab.

## Inventory Settings

Configure **stock adjustment reasons** used when manually adjusting inventory. Each reason can be mapped to a **Xero account code** for seamless accounting integration.

## Sales Settings

Set the **invoice generation trigger** to control when invoices are created automatically:

- **Manual** — generate invoices yourself
- **On ship** — invoice created when the order is shipped
- **On paid** — invoice created when the order is fully paid

## Purchasing Settings

- **Purchase units** — define units of measure with conversion factors (e.g. 1 case = 12 units)
- **Landed cost distribution method** — choose how landed costs are allocated across purchase order lines

## Accounting Settings

- **Financial year start** — set your financial year start date (UK format)
- **VAT rates** — manage VAT rates with Xero tax type mapping
- **Currencies & FX rates** — add currencies and manage exchange rates
- **FX rate schedule** — enable automatic exchange rate updates, set the update interval, or trigger an immediate update with the **Update Now** button

## Backup & Restore

Full system backup and restore functionality. See the [Backup & Restore](backup-restore.md) guide for details.

## System Settings

- **Activity log retention** — set how many days to keep log entries, configurable per log level
- **Database reset** — reset system data with three levels of severity:
  - **Transactions only** — clears orders, invoices, and movements but keeps products and settings
  - **Products** — clears products and all related data
  - **Full reset** — returns the system to a blank state

All reset options require a typed confirmation to prevent accidental data loss.
