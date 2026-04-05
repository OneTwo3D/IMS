# OneTwo3D IMS -- User Guide

This guide covers how to use OneTwo3D IMS, the inventory management system for One Two Enterprises Ltd (trading as OneTwo3D).

---

## Getting Started

### Logging In

Navigate to your IMS URL (e.g. `https://ims.yourdomain.com`). Enter your email address and password on the login screen.

If two-factor authentication (TOTP) is enabled on your account, you will be prompted to enter a six-digit code from your authenticator app (Google Authenticator, Authy, 1Password, etc.).

### Navigation

The sidebar on the left provides access to all modules:

- **Dashboard** -- key metrics and charts
- **Inventory** -- product catalog and stock levels
- **Stock Control** -- stock adjustments and warehouse transfers
- **Purchases** -- purchase orders and supplier management
- **Sales** -- sales orders and customer management
- **Manufacturing** -- production orders (placeholder)
- **Sync** -- WooCommerce and Xero integration status
- **Analytics** -- reporting and forecasts (placeholder)
- **Activity** -- audit log of all system actions
- **Settings** -- system configuration

The sidebar can be collapsed to save screen space by clicking the collapse button.

### User Profile

Click your name or avatar in the top bar to access your profile. From there you can:

- Change your password
- Enable or disable TOTP two-factor authentication (with QR code setup)

---

## Inventory Management

### Products

The Inventory page displays all products in a searchable, filterable table. Each product has:

- **SKU** -- unique stock-keeping unit identifier
- **Name** -- product name
- **Type** -- SIMPLE, VARIABLE, VARIANT, KIT, BOM, or NON_INVENTORY
- **Price** -- selling price
- **Stock** -- total quantity across all warehouses
- **Stock Unit** -- unit of measure (e.g. pcs, kg, m)

Product names and SKUs throughout the system are clickable links that open the product detail page in a new tab.

#### Product Types

| Type | Description |
|---|---|
| SIMPLE | A standalone product with its own stock level |
| VARIABLE | A parent grouping for variants (e.g. a T-shirt available in multiple sizes). Not stockable itself. |
| VARIANT | A child of a VARIABLE parent, with its own SKU and stock level (e.g. "T-shirt - Large") |
| KIT | A virtual bundle. Components are deducted from stock when the kit is sold. Stock is calculated from component availability. |
| BOM | A manufactured product. Has a bill of materials. Stock exists after production. |
| NON_INVENTORY | A service or fee that is not tracked in stock (e.g. shipping charge, consultation fee) |

#### Creating a Product

Click the create button on the Inventory page. A dialog form opens where you enter:

- SKU, name, type
- Dimensions (length, width, height, weight)
- Pricing
- Stock unit
- For VARIABLE products: define options (e.g. Color, Size) and variants are generated
- For KIT / BOM products: define component products and quantities

#### Product Detail

The product detail page (`/inventory/[id]`) shows:

- Product information and pricing
- Stock levels per warehouse
- Cost layers (FIFO) with unit costs and remaining quantities
- Stock movement history
- Supplier product links with pricing
- For VARIABLE parents: list of all variants
- For KIT / BOM: component list

### Stock Levels

Stock levels are tracked per product per warehouse. Each stock level record shows:

- **Quantity** -- total stock on hand
- **Reserved** -- stock allocated to orders or in-transit transfers (not available for sale)
- **Available** -- quantity minus reserved

Stock levels are updated automatically by:
- Purchase order receipts (increases stock)
- Sales order dispatches (decreases stock)
- Stock adjustments (increases or decreases)
- Warehouse transfers (moves stock between locations)
- Production orders (consumes components, produces finished goods)

### Stock Units

Each product has a stock unit that defines how it is counted (e.g. "pcs", "kg", "m", "sheets"). Purchase units can define conversion factors (e.g. "Box of 100" = 100 pcs) so that purchasing can be done in bulk packaging while stock is tracked in individual units.

---

## Stock Control

### Stock Adjustments

Stock adjustments allow you to add or remove stock for any product at any warehouse. Each adjustment requires:

- **Product** -- which product to adjust
- **Warehouse** -- which warehouse
- **Quantity** -- positive to add, negative to remove
- **Reason** -- selected from the configurable list of adjustment reasons (e.g. "Damaged", "Miscounted", "Returned to stock")
- **Notes** -- optional free-text notes

Adjustments that add stock create new FIFO cost layers. Adjustments that remove stock consume cost layers oldest-first.

#### Bulk Adjustments

You can perform multiple adjustments at once using the bulk adjustment form or by importing a CSV file. This is useful for opening stock entry or periodic stock corrections.

### Warehouse Transfers

Transfers move stock between warehouses. The workflow is:

1. **Create transfer** -- select source warehouse, destination warehouse, and add line items with quantities
2. **Ship transfer** -- marks the transfer as IN_TRANSIT. Stock is reserved (unavailable) at the source warehouse.
3. **Receive transfer** -- completes the transfer. Stock is removed from the source and added to the destination.

Transfers can also be cancelled if not yet received.

---

## Purchases

### Creating a Purchase Order

Click the create button on the Purchase Orders page. A dialog form opens where you specify:

- **Supplier** -- select from the supplier list
- **Type** -- GOODS (standard product PO) or FREIGHT (shipping/customs costs linked to a goods PO)
- **Currency** -- the PO currency (FX rate to GBP is captured automatically)
- **Tax rate** -- applied to all lines

Add line items by searching for products. For each line, specify:

- **Product** -- the product being ordered
- **Quantity** -- in the selected purchase unit
- **Purchase unit** -- packaging unit with automatic conversion to stock units
- **Unit price** -- in the PO currency
- **Tax** -- line-level tax if different from the PO default

The system auto-populates prices from the last PO to the same supplier for each product, when available. Products can be filtered by supplier.

### Purchase Order Workflow

| Status | Description |
|---|---|
| DRAFT | PO created but not yet sent |
| RFQ_SENT | Request for quotation sent to supplier (PDF without prices) |
| PO_SENT | Purchase order sent to supplier (PDF with prices) |
| PARTIALLY_RECEIVED | Some lines received |
| RECEIVED | All lines received |
| INVOICED | Supplier invoice recorded |
| PARTIALLY_RETURNED | Some lines returned to supplier |
| RETURNED | All lines returned to supplier |
| CANCELLED | PO cancelled |

### Receiving a Purchase Order

When goods arrive, use the Receive action on the PO detail page. For each line, enter the quantity received. Receiving creates:

- Stock level increases at the destination warehouse
- FIFO cost layers with the unit cost (in GBP) including any applicable landed costs
- Stock movement records for audit

Partial receives are supported -- you can receive in multiple batches.

### Purchase Returns

If goods need to be sent back to the supplier, create a return from the PO detail page. Select the lines and quantities to return. This reverses the stock and cost layer entries.

### Supplier Invoices

Record the supplier's invoice against a PO. You can upload the invoice PDF for reference. Invoice data includes invoice number, date, and amounts. Invoices can be synced to Xero.

### Suppliers

Manage suppliers from the Suppliers page (under Purchase Orders in the sidebar). Each supplier has:

- Contact details (name, email, phone)
- Address
- Default currency and tax rate
- Supplier product catalog with per-supplier pricing

### Landed Costs and Freight POs

Landed costs (shipping, customs duties, insurance, etc.) can be tracked in two ways:

1. **Freight PO** -- create a separate purchase order of type FREIGHT, linked to a goods PO. Add cost lines for each charge (e.g. shipping, customs duty, inspection fee).
2. **Direct freight** -- enter shipping/fee amounts directly on the goods PO.

Landed costs are distributed across the goods PO lines to calculate accurate unit costs. Distribution methods:

- **By value** -- proportional to each line's value
- **By weight** -- proportional to product weight
- **By quantity** -- proportional to line quantity
- **Equal split** -- divided equally across all lines

If freight costs arrive after goods have been received, the system recalculates cost layers retrospectively.

---

## Sales

### Creating a Sales Order

Click the create button on the Sales Orders page. A dialog form opens where you specify:

- **Customer** -- select from the customer list or create a new one
- **Currency** -- the order currency (FX rate to GBP captured automatically)
- **Tax rate** -- default tax rate for the order

Add line items by searching for products. For each line, specify quantity and unit price. Per-line discounts can be applied.

### Sales Order Workflow

| Status | Description |
|---|---|
| PENDING | Order created, awaiting processing |
| PROCESSING | Order accepted and being prepared |
| PICKING | Stock being picked from warehouse |
| PACKED | Order packed and ready for shipping |
| SHIPPED | Order dispatched to customer |
| COMPLETED | Order delivered and finalised |
| CANCELLED | Order cancelled |
| ON_HOLD | Order paused |
| REFUNDED | Full refund issued |
| PARTIALLY_REFUNDED | Partial refund issued |

Orders imported from WooCommerce follow the same workflow. Status changes in WooCommerce are synced to the IMS, and vice versa.

### Discounts

Discounts can be applied at two levels:

- **Order-level discount** -- applies to the entire order subtotal. Enter as a percentage (e.g. "10%") or a fixed amount (e.g. "5.00").
- **Line-level discount** -- applies to an individual line item. Same format.

The original discount input is stored alongside the computed discount amount, so the intent is always clear.

### Shipping

Each order can include:

- **Shipping service** -- free-text field for the carrier/method (e.g. "Royal Mail Tracked", "DPD Next Day")
- **Shipping cost** -- in the order currency

### Invoices

Invoices are generated from sales orders. The trigger for automatic invoice generation is configurable in Settings:

- **On ship** -- invoice created automatically when the order is shipped
- **On paid** -- invoice created when payment is recorded
- **Manual** -- invoices must be generated manually from the order detail page

Each invoice receives an auto-generated invoice number. Invoices can be downloaded as PDF.

### Payments

Record payments against a sales order from the order detail page. Each payment includes:

- Amount
- Payment method / reference
- Date

Multiple partial payments are supported.

### Refunds and Credit Notes

Issue a full or partial refund from the order detail page. For each refund:

- Select the lines and quantities to refund
- Choose the return warehouse (defaults to the configured default return warehouse)
- A credit note number is generated automatically

Refunding stock reverses the FIFO cost consumption, returning cost layers to the pool.

### Customers

Manage customers from the Contacts page (under Sales in the sidebar). Each customer has:

- Name, email, phone
- Billing and shipping addresses
- Tax number (VAT number)
- WooCommerce customer ID (if synced)

Customers can be imported and exported via CSV.

---

## Settings

The Settings page (`/settings`) provides access to all system configuration. Changes take effect immediately.

### VAT Rates

Manage tax rates for purchases and sales:

- Name, percentage, and usage (Sales, Purchase, or Both)
- Xero tax type code for integration
- Default flag for pre-selection on new orders

### Currencies

- Add or remove active currencies (ISO 4217 codes, e.g. GBP, EUR, USD)
- Set whether each currency is used for Sales, Purchases, or Both
- View current FX rates (updated daily at 06:00 from frankfurter.dev)
- Override rates manually if needed

All amounts are displayed with the currency code after the value (e.g. "2.99 GBP").

### Purchase Units

Define packaging-to-stock unit conversions:

- Name (e.g. "Box of 100")
- Abbreviation (e.g. "box")
- Conversion factor (e.g. 100 stock units per purchase unit)
- Stock unit name (e.g. "pcs")

### Invoice Triggers

Control when sales invoices are generated automatically: on ship, on paid, or manual.

### Adjustment Reasons

Configure the list of reasons available when making stock adjustments:

- Name (e.g. "Damaged", "Miscounted", "Returned to stock", "Write-off")
- Optional Xero account code for expense tracking
- Sort order and active/inactive flag

### Organisation Details

Company information that appears on PDFs and system-wide:

- Company name, legal name
- VAT number, company registration number
- Address, phone, email, website
- Logo URL
- Base currency and financial year start

### Warehouses

Configure warehouse locations:

- Code and name
- Type: STANDARD, QUARANTINE, or RESTOCK
- Whether stock is available for sale
- Whether stock syncs to WooCommerce
- Default warehouse and default return warehouse flags

---

## CSV Import and Export

### Exports

CSV exports are available for the following data sets. Each export downloads a CSV file via the browser.

| Export | Content |
|---|---|
| Products | Full product catalog with SKU, name, type, pricing, dimensions |
| Stock Levels | Current stock quantities per product per warehouse |
| Adjustments | Stock adjustment history |
| Contacts | Customer list with addresses |
| Suppliers | Supplier list with contact details |
| Sales | Sales order data |
| Transfers | Stock transfer history |
| Purchase Orders | Purchase order data |

Export buttons are available on the relevant list pages and typically include filter options to narrow the data.

### Imports

CSV imports are available for:

- **Products** -- import product catalog. Uses a two-pass approach: parent products (SIMPLE, VARIABLE, BOM, KIT) are created first, then child products (VARIANT) and component links. The CSV template includes columns for SKU, name, type, parent SKU (for variants), price, weight, dimensions, stock unit, and more.
- **Stock Adjustments** -- bulk import adjustments with columns for SKU, warehouse code, quantity, and reason.
- **Customers** -- import customer records with billing and shipping addresses.
- **Suppliers** -- import supplier records with contact details and default currency/tax settings.

When importing, the system validates data before committing changes and reports any errors by row number.

---

## PDF Generation

The system generates professional PDF documents using PDFKit. All PDFs include company branding from the Organisation settings (company name, address, logo). PDFs are downloaded directly through the browser.

### Available PDF Types

| PDF | Description | Route |
|---|---|---|
| RFQ (Request for Quotation) | Purchase order sent to a supplier without prices, requesting a quote | Download from PO detail page |
| Purchase Order | Full PO with prices and terms, sent to the supplier | Download from PO detail page |
| Sales Order (Order Confirmation) | Order summary sent to the customer as confirmation | Download from SO detail page |
| Invoice | Customer invoice with auto-generated invoice number, line items, totals, and tax | Download from SO detail page |

### Generating a PDF

On the relevant detail page (purchase order or sales order), click the PDF download button. The PDF is generated on the server and streamed to your browser as a download. No files are stored permanently -- PDFs are generated on demand.

### Branding

PDF branding is configured through the Organisation settings in the Settings page:

- Company name and legal name
- Address and contact details
- Logo URL
- VAT and company registration numbers

These details appear in the header and footer of all generated PDFs.
