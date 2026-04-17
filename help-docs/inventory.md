# Inventory Management

The Inventory section is where you manage your product catalogue, view stock levels, and maintain product details.


## Product List

The main inventory page displays all products in a searchable, filterable table.

### Search and Filter

- **Search** -- Type a SKU, product name, or barcode to find products instantly.
- **Filter by Type** -- Narrow the list to a specific product type (Simple, Variable, Variant, Kit, BOM, Non-Inventory).
- **Filter by Status** -- Show only active or inactive products.

### Bulk Actions

Select multiple products using the checkboxes, then choose a bulk action:

- **Delete** -- Permanently remove the selected products.
- **Deactivate** -- Mark the selected products as inactive so they no longer appear in order forms.

### Column Visibility

Click the **Columns** button to show or hide table columns. Your selection is saved in the browser so it persists between sessions. Available columns include:

- **SKU**, **Name**, **Type**, **Status** — visible by default
- **Parent SKU**, **Barcode**, **Dimensions**, **Weight** — hidden by default
- **Regular Price**, **Sale Price**, **Tax Incl.** — pricing columns
- **Stock** — total on-hand quantity (visible by default)
- **Allocated** — quantity reserved by active sales or manufacturing orders (amber when > 0)
- **Available** — on hand minus allocated (red when negative)
- **Incoming** — quantity expected from open purchase orders or in-transit transfers (blue)
- **COGS Value** — total inventory value from FIFO cost layers
- **Variants**, **Created**, **Updated** — additional metadata columns

### CSV Export

Click **Export** to download the current filtered product list as a CSV file.


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


## Suppliers per Product

Each product can be linked to one or more suppliers. For each supplier, the system records:

- The last purchase order price.
- The currency and FX rate at the time of the last PO.

This information is used to pre-fill prices when creating new purchase orders.


## Variable Products -- Options and Variants

When editing a Variable product, you define **options** (e.g. Size with values S, M, L and Colour with values Red, Blue). The system can then **generate variants** for every combination automatically. Each generated child SKU inherits the parent's details and can be customised individually.

The child table on a Variable product's detail page shows each variant with its thumbnail, SKU, name, stock, allocated, available, incoming, price, and status. Click any child SKU to open its detail page.

For advanced catalogues, a Variable parent can mix normal variants with bundle variants and BOM variants. The parent remains a grouping layer only; stock and fulfillment behavior always comes from the child SKU type.


## Kit Products -- Component Stock

On a Kit product's detail page, the stock section shows the **calculated available quantity** per warehouse. This is the maximum number of Kits that can be assembled from the components currently in stock at that warehouse.

When a kit contains another kit as a component, the system expands that structure automatically and still calculates the final shippable quantity from the underlying stockable items.


## BOM Products -- Manufactured Stock

A BOM product's detail page shows both its own on-hand stock and the component list. Stock is added to a BOM product through build orders in the Manufacturing section, which consume the listed components.
