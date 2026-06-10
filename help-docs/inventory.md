# Inventory Management

The Inventory section is where you manage your product catalogue, view stock levels, and maintain product details.


## Product List

The main inventory page displays all products in a searchable, filterable table.

### Search and Filter

- **Search** -- Type a SKU, product name, or barcode to find products instantly.
- **Filter by Type** -- Narrow the list to a specific product type (Simple, Variable, Variant, Kit, BOM, Non-Inventory).
- **Filter by Lifecycle Status** -- Show products in a specific lifecycle state: **Draft**, **Active**, **EOL** (end of life), or **Archived**. See [Lifecycle Status](#lifecycle-status) below for what each state means.
- **Filter by Preferred Supplier** -- Show only products linked to a specific supplier. Useful for supplier-scoped reorder planning.

### Bulk Actions

Select multiple products using the checkboxes, then choose a bulk action:

- **Delete** -- Permanently remove the selected products. Only available for products with no transactional history.
- **Set lifecycle** -- Change the lifecycle status of selected products in bulk (e.g. mark a discontinued line as EOL). See [Lifecycle Status](#lifecycle-status).

### Column Visibility

Click the **Columns** button to show or hide table columns. Your selection is saved in the browser so it persists between sessions. Available columns include:

- **SKU**, **Name**, **Type**, **Lifecycle Status** — visible by default
- **Parent SKU**, **Barcode**, **MPN**, **Category**, **Dimensions**, **Weight** — hidden by default
- **Preferred Supplier** — the supplier auto-recorded from the most recent purchase order (hidden by default; see [Preferred Supplier](#preferred-supplier))
- **Regular Price**, **Sale Price**, **Tax Incl.** — pricing columns
- **Stock** — total on-hand quantity (visible by default)
- **Allocated** — quantity reserved by active sales or manufacturing orders (amber when > 0)
- **Available** — on hand minus allocated (red when negative)
- **Incoming** — quantity expected from open purchase orders, in-transit transfers, manufacturing outputs, or WMS ASN evidence (blue)
- **COGS Value** — total inventory value from FIFO cost layers
- **Variants**, **Created**, **Updated** — additional metadata columns

### CSV Export

Click **Export** to download the current filtered product list as a CSV file.


## CSV Templates & Import Rules

Every screen with a **Templates** menu (Inventory, Customers, Suppliers, Sales Orders, Purchase Orders, Stock Adjustments, Transfers, Stock Levels) follows the same conventions:

- **Download a template** before importing. The template ships with the exact columns the importer expects.
- The template includes a guidance row beginning with **`# REQUIRED`** in the first cell. Cells under each column show `REQUIRED` or `OPTIONAL` so you can see which fields must be filled. **Keep this row in the file** — the importer detects and skips it automatically.
- **Empty cells do not overwrite existing values.** If you re-import a row to update one field, leave every other column blank and only fill the field you want changed. This makes partial updates safe.
- To clear a value, use a sentinel like `NULL` or `-` per column where the importer documents it; a blank cell is read as "leave alone".

These rules apply consistently across every CSV import in the app — if a screen has a Templates menu next to its Import button, the template, the guidance row, and the empty-cell behaviour all work the same way.


## Creating a Product

Click **New Product** to open the product form. The following fields are available:

| Field | Description |
|---|---|
| **SKU** | A unique code that identifies the product. |
| **Name** | The display name shown throughout the system. |
| **Type** | The product type (see below). |
| **Barcode** | An optional barcode or EAN for scanning. |
| **HS Code** | The Harmonised System code for customs declarations. |
| **Country of Origin** | The 2-letter ISO country code where the product is manufactured. |
| **Weight** | Product weight in kg, used for shipping and landed cost calculations. |
| **Dimensions** | Width, height, and depth in cm. |
| **Cost Price** | The default purchase cost (overridden by FIFO layers once stock is received). |
| **Sell Price** | The default selling price. |
| **Stock Unit** | The unit of measure (e.g. each, kg, metre). |
| **Oversell** | Whether the product may be sold when available stock is zero. |
| **Image URL** | A link to the product image, displayed on the product detail page and in PDFs. |


## Product Types in Detail

### Simple

A standard product with its own stock. Most physical goods are Simple products.

### Variable

A parent product that defines shared attributes (e.g. a T-Shirt). It is not stocked or sold directly. Instead, it holds **options** (such as Size and Colour) that are used to generate child SKUs.

### Variant

A child of a Variable product representing one specific combination of options (e.g. T-Shirt / Large / Blue). Each variant has its own SKU, stock levels, and pricing. Variants are what you actually buy, sell, and count.

Variable parents can now have three kinds of child SKU:

- **Variant** — a normal stocked child
- **Kit / Bundle** — a virtual child made from components
- **BOM** — a manufactured child with its own finished stock

### Kit

A bundle of component products sold as a single unit. Kit stock is not held independently -- it is **calculated** from the available stock of its components across each warehouse. When a Kit is sold, each component's stock is allocated individually.

Bundle handling is component-driven:

- kit availability is calculated per warehouse from the limiting component
- nested kits are expanded to their leaf components for fulfillment coverage
- allocations, shipment lines, dispatch, refunds, and stock returns all operate on the underlying components rather than on virtual kit stock

To set up a Kit, use the component search to add products and specify the quantity of each component required per Kit.

### BOM (Bill of Materials)

A product that is manufactured from components. Unlike a Kit, a BOM product holds its own stock. Components are consumed during a build order, and the finished product's stock increases.

Use the component search to define the bill of materials, specifying the quantity of each component consumed per unit produced.

### Non-Inventory

A product that appears in sales and purchase orders but is not tracked in stock. Use this for services, digital goods, or miscellaneous charges.


## Product Detail Page

Click any product to open its detail page. From here you can:

- **Edit details** -- Update any of the product fields.
- **View stock levels** -- See on hand, allocated, available, and incoming quantities per warehouse.

### Product Type Changes

Simple, Variant, Kit, and BOM products can be transformed through the standard editor, but only when they are structurally safe to change.

The system blocks a type change if the product still has any of the following attached:

- stock on hand
- reserved stock
- open sales order lines
- open purchase order lines
- open manufacturing orders
- open stock transfer lines

This is especially important when changing a Bundle or BOM back to a Simple product. Clear the attached stock and operational documents first, then change the type.

Variable parents and Non-Inventory products cannot be converted through the standard product editor.


## Stock Levels

Each product displays four stock figures per warehouse:

- **On Hand** -- Total physical stock in the warehouse.
- **Allocated** -- Quantity reserved by confirmed sales orders. Click the figure to see which orders hold the allocation.
- **Available** -- On Hand minus Allocated.
- **Incoming** -- Quantity on open purchase orders or inbound transfers. Click the figure to see the source POs or transfers.


## FIFO Cost Layers

Every time stock is received (from a purchase order or build order), a new FIFO cost layer is created recording the quantity and unit cost. When stock is sold or consumed, the oldest layers are used first. This ensures your cost of goods sold accurately reflects purchase prices over time.


## Lifecycle Status

Every product has a lifecycle status that controls whether it can be sold, purchased, and what's expected of it in reorder planning. The four states form a typical lifecycle:

| Status | Sellable? | Purchasable? | Appears in reorder forecasts? | Typical use |
|---|---|---|---|---|
| **Draft** | No | Yes | Yes | Catalogue addition that isn't ready for sale yet — you can place POs to stock it, but it won't appear on the storefront. |
| **Active** | Yes | Yes | Yes | The normal operating state. The product is live and re-orderable. |
| **EOL** (End of Life) | Yes (from existing stock) | **No** | **No** | The product is being sold off. Existing stock can be sold; no more can be purchased; reorder forecasts skip it. |
| **Archived** | No | No | No | The product is fully withdrawn. Set when EOL stock is exhausted (auto), or set manually to remove from active workflows. |

### Automatic transitions

- **EOL → Archived (auto)** — when an EOL product has zero stock across every warehouse AND no incoming supply (no open PO lines, no in-transit transfers, no in-progress manufacturing for it, no WMS ASN evidence), a daily cron job auto-archives it. The activity log records the transition with the incoming-stock breakdown at archive time.

### When to use each state

- **Setting up a new SKU?** Start as Draft. Switch to Active when the listing is ready.
- **Phasing out a product?** Set to EOL. The system will keep selling existing stock and won't surface it in reorder suggestions. It auto-archives when stock and incoming supply hit zero.
- **Product is fully discontinued?** Set to Archived directly. (If stock is non-zero, you may want to write it off first.)

### Lifecycle status on bulk import

The CSV import template includes a `lifecycleStatus` column. For first-time bulk imports, set to **Draft** if you want to review the catalogue before going live, or **Active** if everything is publish-ready. Do not use EOL/Archived for fresh imports.


## Preferred Supplier

Each product can be linked to one **preferred supplier** — the supplier the system uses for reorder forecasting. The preferred supplier is updated automatically when you send a purchase order to a supplier for that product.

### How it's set

1. **Automatically on PO_SENT** — the first time you send a PO to Supplier A for Product X, Supplier A becomes Product X's preferred supplier.
2. **Latest wins** — if you later send a PO to Supplier B for Product X, the preferred supplier flips to Supplier B.
3. **Explicit override** — set the preferred supplier directly on the product page if you want to pin it without placing a PO.

### Locking the preferred supplier

If your product is consistently sourced from Supplier A but you occasionally place emergency POs with backup suppliers, set **Preferred Supplier Locked** on the product page. The system will skip the auto-update for that product, preserving Supplier A as the preferred regardless of recent POs.

### Skipping the update per PO

When creating a one-off PO with a non-primary supplier, tick **"Skip preferred-supplier update"** on the PO header. This particular PO won't change the product's preferred supplier, even if it's the most recent.

### Why this matters for reorder planning

Supplier-scoped reorder draft generation (in Analytics > Reorder Forecast) scopes products to their preferred supplier. Without a preferred supplier, the product doesn't appear in the draft PO for any specific supplier. The auto-update ensures the system tracks your actual buying history without manual maintenance.


## Supplier Catalogue (Multi-Supplier Products)

In addition to the preferred supplier, each product can be linked to multiple suppliers via the supplier catalogue. Each catalogue entry records:

- The supplier's own SKU for the product (their reference)
- The last purchase order price
- The currency at the time of the last PO
- Lead time days (used in reorder calculations)

The supplier catalogue is for products genuinely sourced from multiple vendors (different lead times, different costs). The preferred supplier is the one the system suggests for reorder forecasting; the catalogue holds the per-supplier metadata for all suppliers.

When pricing a new PO, the system pre-fills the unit cost from the catalogue entry for the chosen supplier.


## Variable Products -- Options and Variants

When editing a Variable product, you define **options** (e.g. Size with values S, M, L and Colour with values Red, Blue). The system can then **generate variants** for every combination automatically. Each generated child SKU inherits the parent's details and can be customised individually.

The child table on a Variable product's detail page shows each variant with its thumbnail, SKU, name, stock, allocated, available, incoming, price, and status. Click any child SKU to open its detail page.

For advanced catalogues, a Variable parent can mix normal variants with bundle variants and BOM variants. The parent remains a grouping layer only; stock and fulfillment behavior always comes from the child SKU type.


## Kit Products -- Component Stock

On a Kit product's detail page, the stock section shows the **calculated available quantity** per warehouse. This is the maximum number of Kits that can be assembled from the components currently in stock at that warehouse.

When a kit contains another kit as a component, the system expands that structure automatically and still calculates the final shippable quantity from the underlying stockable items.


## BOM Products -- Manufactured Stock

A BOM product's detail page shows both its own on-hand stock and the component list. Stock is added to a BOM product through build orders in the Manufacturing section, which consume the listed components.


## Reorder Forecasting

When the product appears in a reorder forecast (Analytics > Reorder), the forecast considers:

- Available stock today
- Open PO incoming stock (the forecast subtracts inbound PO quantity from the suggested reorder)
- Average daily demand from sales history (the "velocity")
- Lead-time days from the preferred supplier's catalogue entry (or a system default if not set)
- Safety stock and configured reorder thresholds

### Reorder Evidence

When a draft PO is generated from a reorder forecast, each line carries **reorder evidence** — a snapshot of why the system suggested that quantity at that time. The evidence is stored on the PO line and visible from the PO detail page. It includes:

- Stock at forecast time
- Daily demand rate
- Lead time used
- Suggested days of cover
- Forecast generation timestamp

This lets you replay "why did we order 100 of these?" months later when reconciling inventory.

### Exclusions

The reorder forecast excludes:

- **EOL products** — they're being sold off, not re-ordered
- **Archived products** — withdrawn
- **Non-Inventory products** — services, not stocked
- **Kit/bundle parents** — reorder works on components, not on virtual kits
