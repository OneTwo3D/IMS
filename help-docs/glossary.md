# Glossary

A plain-English reference for terms used throughout One Two Inventory. If a phrase in the help docs ever feels opaque, this is the first place to check.

> **Tip:** Most terms below show up in the **Inventory**, **Sales**, **Purchasing**, and **Settings** sections of the app. Where useful, the page that uses the term is linked.


## Inventory and costing

**Cost layer (FIFO layer)**
A row in the system's stock ledger that records a specific quantity of a product received at a specific unit cost. Each receipt — from a purchase order or a manufacturing build — creates a new cost layer. When you sell stock, the system consumes the oldest layer first. See `FIFO` and `COGS` below.

**FIFO** — First In, First Out
The accounting rule for which units leave stock first. The unit you sell today is costed against the *oldest* purchase price still in stock. This keeps your COGS realistic across long periods of price changes and means the unit cost on an invoice can differ from today's purchase price.

**COGS** — Cost of Goods Sold
The accounting value of stock that has been dispatched to a customer. The system books COGS at shipment time by consuming FIFO cost layers oldest-first. COGS is what your profit-and-loss reports use for the "cost" side of margin.

**Landed cost**
The all-in cost of getting a unit of stock into your warehouse, including the supplier price plus freight, customs, duties, and other inbound charges. The system distributes landed-cost POs across the underlying goods POs so the cost layers reflect the true unit cost, not just the supplier invoice.

**Stock unit**
The unit of measure a product is counted in (pcs, kg, m, etc.). Distinct from `Purchase unit` — e.g. you might count a fabric in metres internally but buy it from the supplier as 100-metre rolls.

**Purchase unit**
The unit of measure a supplier sells in, with a conversion factor to your stock unit. "1 case = 12 units", "1 roll = 100 m", etc.

**On hand, Allocated, Available, Incoming**
Four numbers shown per product per warehouse:
- **On hand** — physical stock in the warehouse right now.
- **Allocated** — quantity reserved for confirmed sales orders.
- **Available** — On hand minus Allocated. This is what you can sell or transfer today.
- **Incoming** — quantity expected from open purchase orders or inbound transfers.


## Products

**SKU** — Stock Keeping Unit
A unique product code. The SKU is how the system identifies a specific product, variant, or component everywhere it shows up — orders, reports, integrations, scanners.

**Product type**
Five categories that change how the product behaves:
- **Simple** — a standalone product with its own SKU and stock.
- **Variable** — a parent that groups variants (e.g. "T-Shirt") but is not stocked itself.
- **Variant** — a child of a Variable parent representing one option combination (e.g. "T-Shirt / Large / Blue").
- **Kit / Bundle** — a virtual product sold as one unit but assembled from components on the fly; no stock is held on the bundle itself.
- **BOM (Bill of Materials)** — a manufactured product whose stock is built from components via a production order.
- **Non-Inventory** — a sellable line that is not stocked (services, fees, digital goods).

**Lifecycle status**
The publishing state of a product. Four values:
- **Draft** — the product is being prepared. Can be purchased but is not yet sellable. Useful for catalogue additions that aren't ready for the storefront.
- **Active** — the product is live, sellable, and re-orderable. The normal operating state.
- **EOL (End of Life)** — the product is being sold off. Can still be sold from existing stock, but cannot be re-ordered and is excluded from reorder forecasts. When EOL stock and incoming supply reach zero, the system auto-archives it.
- **Archived** — the product is withdrawn. Cannot be sold or re-ordered. Stock and incoming supply are zero (or have been zeroed out).

**Preferred supplier**
The supplier the system associates with a product for reorder forecasting. Updated automatically the first time you send a purchase order to a supplier for that product. If you ever need to override (for example, you placed a one-off PO with a backup supplier), you can lock the preferred supplier on the product page.

**Category path**
A reporting category for a product, written as `Parent > Child > Grand-child` with `>` as the nesting separator. The category tree is managed in **Settings > Inventory**. The same leaf name can be reused under different parents (so `Apparel > T-Shirts` and `Promo > T-Shirts` are distinct), and the path is what the inventory table, exports, and filter dropdowns display. WooCommerce mirrors its store category tree into this list on product sync.


## Purchasing

**Purchase Order (PO)**
A confirmed buying document sent to a supplier. The PO commits the buyer to receive specified goods at specified prices. POs have their own state machine (DRAFT → PO_SENT → RECEIVED, with several intermediate states).

**RFQ** — Request For Quotation
A pre-purchase document sent to a supplier asking them to quote prices on a list of items. The RFQ PDF includes product details and quantities but NOT prices. Once the supplier responds, you can convert their quote into a PO.

**Goods receipt**
The point in the workflow where the supplier's goods physically arrive in your warehouse. Receiving creates FIFO cost layers and increments stock-on-hand. The PO moves to PARTIALLY_RECEIVED or RECEIVED depending on whether everything came in one shipment.

**Landed-cost PO (freight PO)**
A separate purchase order that captures shipping, customs, duties, and other inbound charges associated with one or more primary goods POs. The landed cost gets distributed across the primary POs' lines so the cost layers reflect the true all-in unit cost.

**Reorder evidence**
Forecast metadata attached to a PO line generated from a supplier-scoped reorder draft. Records why the system suggested this quantity at this time (current stock, daily sales rate, lead-time days, etc.). Operators and auditors can replay the suggestion later.


## Sales

**Sales Order (SO)**
A confirmed customer order. The SO is the top-level fulfilment document; allocation, shipment, invoice, and refund all attach to it.

**Allocation**
The process of binding specific stock-on-hand quantities to a sales order line. Allocation reserves stock — it isn't a physical movement; the goods stay in the warehouse until shipment. An auto-allocator chooses warehouses to minimise the number of shipments needed.

**Shipment**
A physical dispatch of allocated goods. One sales order can have multiple shipments (typical for multi-warehouse fulfilment). Each shipment has its own status (PENDING → PICKING → PACKED → SHIPPED) and its own tracking number.

**Backorder**
A sales order line where insufficient stock is available. The system shows backorder quantities in the allocation panel so you can decide whether to part-ship or wait. Backorders typically resolve when a purchase receipt lands and triggers re-allocation.

**Invoice**
The formal tax document tied to a sales order. Invoices can be generated manually, on shipment, or on payment (configurable per tenant). The invoice number is auto-assigned using your configured prefix.

**Credit note**
The reverse of an invoice — issued when a refund is processed. Credit notes have their own number sequence and link back to the original invoice and refund.

**Refund**
A workflow that returns money to the customer and optionally restocks goods. Refunds can be line-level (partial) or full-order. For shipped items, the system creates COGS reversal entries and adds the returned stock back to a configured return warehouse.


## Accounting and FX

**Base currency**
The currency in which the system reports value (stock, COGS, revenue). Set once during initial setup. All multi-currency transactions are converted to base currency for valuation. **Cannot be changed without a database reset** once live data exists.

**FX rate**
Foreign exchange rate. The system stores rates as `1 base = X foreign currency`. Rates are fetched daily from the European Central Bank via frankfurter.dev and stamped on documents at creation time so the same rate is used end-to-end (storefront → IMS → Xero).

**fxRateToBase**
The FX rate stored on a document (Sales Order, Purchase Order, Refund) that locks in the conversion the document was created under. Even if the daily rate changes tomorrow, this document's base-currency totals don't drift.

**Realised FX gain/loss**
The difference between the base-currency value of a foreign-currency invoice when it was issued vs when it was settled. The system books realised FX at payment time. Example: a EUR invoice booked at €1 = £0.85 but paid two months later at €1 = £0.88 books an £0.03/EUR FX gain.

**VAT (sales tax)**
Value Added Tax. Stored as a named rate (e.g. "UK Standard 20%") with a country code and Xero tax type. Each line on a sales or purchase order can use a different rate. The system supports both inclusive pricing (price includes VAT) and exclusive pricing (price is net, VAT added).

**Sub-ledger**
A separate ledger that feeds the main accounting system (Xero, in this case) in summarised form. The IMS acts as a sub-ledger: it tracks every transaction in detail and pushes daily batch journals to Xero so Xero sees clean totals rather than thousands of individual events.

**A1 / A2 / Group B**
Three daily batches the Xero sub-ledger posts each night:
- **A1 — Revenue Deferral** — pulls back revenue that Xero auto-recognised when an invoice was paid, parking it in unearned revenue until goods actually ship.
- **A2 — Inventory Reclassification** — moves the value of allocated stock from "Inventory Asset" to "Allocated Inventory" so the balance sheet reflects what's reserved vs available.
- **B — Shipment Recognition** — at shipment, recognises the revenue (out of unearned) and books COGS (consuming FIFO cost layers).


## Integrations

**Connector**
A plugin that links the IMS to an external system. There are three categories:
- **Shopping connectors** — WooCommerce, Shopify. Order intake.
- **Accounting connectors** — Xero, QuickBooks. Journal posting.
- **WMS connectors** — Mintsoft. Outbound warehouse management.

**Webhook**
A push notification from an external system. When WooCommerce creates an order, it can POST to a IMS endpoint instead of waiting for IMS to poll. Webhooks need a shared secret for signature verification.

**Connection test gate**
A check the system runs before activating an integration. Requires you to successfully test the credentials AND not change them after testing. If credentials change, you must re-test. Prevents the situation where sync silently fails because the credentials were wrong from the start.

**ASN — Advance Shipping Notice**
A document that tells the warehouse what stock to expect from a supplier and when. Used in the WMS integration to reconcile booked-in stock against expected.


## Security

**TOTP** — Time-based One-Time Password
The standard "Google Authenticator" 6-digit code. The IMS supports TOTP as a second factor on top of password login.

**Passkey / WebAuthn**
Passwordless authentication using a hardware key or device biometrics (Face ID, Touch ID, Windows Hello). FIDO2-compliant.

**Activity log**
The audit trail. Every state-changing action records an entry (who, when, what entity, what changed). Used for compliance reviews, debugging "why did this change?", and forensics.

**CRON_SECRET**
A shared secret in the environment that the IMS expects on every scheduled-job HTTP request. Without it, scheduled jobs can't run in production. The cron daemon (or whichever scheduler you use) must include it in the `Authorization: Bearer ...` header.


## Workflow states (at a glance)

- **Sales Order:** DRAFT → PENDING_PAYMENT → ON_HOLD → PROCESSING → ALLOCATED → PICKING → PACKING → SHIPPED → COMPLETED (or DELIVERED with tracking module)
- **Purchase Order:** DRAFT → RFQ_SENT → QUOTE_RECEIVED → PO_SENT → SHIPPED → PARTIALLY_RECEIVED → RECEIVED → INVOICED → CLOSED
- **Shipment:** PENDING → PICKING → PACKED → SHIPPED
- **Product lifecycle:** DRAFT → ACTIVE → EOL → ARCHIVED (auto-transitions: EOL → ARCHIVED on stock exhausted)

For the canonical state-machine reference (allowed transitions, etc.), see `docs/workflows.md`.
