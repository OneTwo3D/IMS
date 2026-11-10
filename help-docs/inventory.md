# Inventory Management

The Inventory section is where you manage your product catalogue, view stock levels, and maintain product details.


## Product List

The main inventory page displays all products in a searchable, filterable table.

### Search and Filter

- **Search** -- Type a SKU, product name, or barcode to find products instantly.
- **Filter by Type** -- Narrow the list to a specific product type (Simple, Variable, Kit / Bundle, Bill of Materials, Non-Inventory). The **Type** column also tells you where a product sits: **Variant parent** (a Variable product), **Variant child** (an ordinary variant), **Variant child (Kit)** or **Variant child (BOM)** (a Kit or BOM generated under a Variable parent), and plain **Kit** or **BOM** for a standalone bundle or manufactured product.
- **Filter by Category** -- Show only products in one reporting category.
- **Filter by Lifecycle Status** -- Show products in a specific lifecycle state: **Draft**, **Active**, **EOL** (end of life), or **Archived**. See [Lifecycle Status](#lifecycle-status) below for what each state means.
- **Filter by Preferred Supplier** -- Show only products linked to a specific supplier. Useful for supplier-scoped reorder planning.

### Bulk Actions

Select multiple products using the checkboxes, then choose a bulk action from the bar that appears:

- **Deactivate** -- Marks the selected products as **EOL** (end of life) so they stop being re-ordered and are sold down. See [Lifecycle Status](#lifecycle-status). To set any other status, change it on the product page.
- **Delete** -- Permanently remove the selected products. Products with order, stock or other activity, or with variants, are skipped, and the bar lists the SKUs that were skipped.
- **Clear** -- Clear the selection.

### Column Visibility

Click the **Columns** button to show or hide table columns. Your selection is saved in the browser so it persists between sessions. Available columns include:

- **SKU**, **Name**, **Type**, **Status** (the lifecycle status) — visible by default
- **Parent SKU**, **Barcode**, **MPN**, **Category**, **Dimensions**, **Weight** — hidden by default
- **Preferred Supplier** — the supplier auto-recorded from the most recent purchase order (hidden by default; see [Preferred Supplier](#preferred-supplier))
- **Regular Price** (visible by default), **Sale Price**, **Tax Incl.** — pricing columns
- **Stock** — total on-hand quantity (visible by default)
- **Allocated** — quantity reserved by active sales or manufacturing orders (amber when > 0; hidden by default)
- **Available** — on hand minus allocated (red when negative; hidden by default)
- **Incoming** — quantity expected from open purchase orders, in-transit transfers, manufacturing outputs, or WMS ASN evidence (blue; hidden by default).
  A purchase order line counts by what is still **outstanding** on it — quantity that has already landed (received, or booked in by the warehouse) is not counted again.
  An in-transit transfer line is counted once, at what has **not** arrived yet — and "arrived"
  includes units the WMS stock-sync alignment brought in, which raise stock and lay cost layers
  without recording a receipt against the transfer line. A transfer the WMS has fully accounted
  for therefore shows nothing incoming, and its own ASN is not added a second time on top.
- **COGS Value** — total inventory value from FIFO cost layers (visible by default)
- **Variants**, **Created**, **Updated** — additional metadata columns

### CSV Export

The buttons above the list are **Template** (a blank import file with the guidance row), **Export CSV** (the current filtered product list), **Import CSV** and **New Product**.


## CSV Templates & Import Rules

Every screen with a **Templates** menu (Inventory, Customers, Suppliers, Sales Orders, Purchase Orders, Stock Adjustments, Transfers, Stock Levels) follows the same conventions:

- **Download a template** before importing. The template ships with the exact columns the importer expects.
- The template includes a guidance row beginning with **`# REQUIRED`** in the first cell. Cells under each column show `REQUIRED` or `OPTIONAL` so you can see which fields must be filled. **Keep this row in the file** — the importer detects and skips it automatically.
- **Empty cells do not overwrite existing values.** If you re-import a row to update one field, leave every other column blank and only fill the field you want changed. This makes partial updates safe.
- To clear a value, use a sentinel like `NULL` or `-` per column where the importer documents it; a blank cell is read as "leave alone".

These rules apply consistently across every CSV import in the app — if a screen has a Templates menu next to its Import button, the template, the guidance row, and the empty-cell behaviour all work the same way.

**Row and file limits.** Every CSV importer accepts at most **10,000 rows** and **10 MB** per file.
A file over 10 MB is refused outright and nothing is imported. A file with more than 10,000 rows is
**not** refused — the first 10,000 rows are imported and the rest are dropped, with a single error
line reading `File has more than 10000 rows — N row(s) skipped`. That line is the only notice you
get, so check the import result rather than assuming a large file loaded whole. Split a larger
catalogue into several files, and put a product's components in the same file as the product
wherever you can (see below for what happens when you cannot).


### Importing manufacturing recipes (BOM)

A manufactured product's recipe rides in the products CSV's **`components`** column, in the form
`COMPONENT-SKU:qty;OTHER-SKU:qty`. It is the same column Kits use, and on a `BOM`-type row it is
what makes the product manufacturable.

IMS keeps that recipe in two places, for two different sets of readers, and **the products CSV
writes both in one step**: the fulfilment/consumption copy that build orders consume, and the
planning copy that replenishment reports, reorder-MO generation and manufacturing analytics read.
This matters because until both exist, a manufactured product is *sellable but invisible to
planning* — nothing fails, the reorder report simply never suggests building it.

Rules for the `components` column:

- **Every component must exist as a product.** It can be created earlier in the same file, later in
  the same file, or already be in IMS — order within one file does not matter, because components are
  resolved after every row has been read. What does matter is that a component in *another* file
  must be imported **first**.
- **An unknown component SKU refuses the whole recipe for that row, not just that line.** You get
  `Row N: component SKU "X" not found`, and the product is still created or updated — with **no
  recipe at all**. This is the failure worth watching for: it does not stop the import, and a BOM
  with no recipe looks perfectly normal on the product page. Re-import the row once the component
  exists. A partial recipe is never written, which is deliberate: a recipe missing one component
  would produce under-picked builds and mis-picked orders that nothing reports.
- **Every part is `SKU:qty`, and the quantity is read strictly.** A plain positive number with a point
  for the decimal mark and at most 4 decimal places (`1`, `2.5`, `0.0001`). A part with no `:`, a
  quantity such as `1,5`, `2 units`, `3abc`, `1e3` or `-1`, or a zero quantity is refused, and as with
  an unknown SKU the whole recipe for that row is refused (`Row N: invalid component "X": ...`).
  The quantity is what follows the last `:`, so a component SKU that itself contains `:` (`PART:A:2`) is read as SKU `PART:A`.
  The importer used to read a numeric prefix and to give a part with no `:` quantity 1, so a decimal
  comma loaded as 1 with nothing reported.
- **A circular recipe is refused.** A product cannot be a component of itself, directly or through a
  chain. Both the fulfilment copy and the planning copy are checked, and a refusal writes neither.
- **A BOM recipe can be re-imported at any time**, regardless of open sales orders — see the BOM
  section below for why. A **Kit** recipe cannot, while orders are in flight against it.
- Leaving `components` blank leaves an existing recipe alone. It does not clear it.

**Checking that both copies agree.** Nothing in the database forces them to stay in step, so there
is an explicit check:

- `GET /api/export/bom-recipes` — the manufacturing recipes as IMS holds them, with a `bomClaimed`
  column. A row with `bomClaimed=FALSE` came from somewhere other than an import and is **not**
  maintained by it.
- `GET /api/export/bom-recipes?drift=1` — every disagreement between the two copies, one row per
  problem, with a plain-English `detail`.
- `GET /api/export/bom-recipes?template=1` — a minimal worked example of the three columns a recipe
  needs; import it through the **products** importer, not a separate one.
- `npm run check:bom-recipes` — the same check from the command line. It exits non-zero when
  anything disagrees, so it can gate a data load.

**Two active recipes stops an import.** If a product somehow has more than one *active* manufacturing
recipe — usually a legacy recipe left by an older data load — importing it is refused, and the message
names the duplicate recipes. This is deliberate: planning adds up the components of every active recipe,
so it would over-order for that product. Deactivate the duplicates (keep them, so past build orders
still report correctly), leave one as the live recipe, and re-run the import.

To do that, ask whoever administers the system to run the repair command — there is no button for it,
because a stray duplicate recipe is a data-migration leftover rather than something you create in
normal use:

```
npm run repair:duplicate-bom -- --list                # shows the duplicates and their ids
npm run repair:duplicate-bom -- --bom <id> --dry-run  # says what would happen, changes nothing
npm run repair:duplicate-bom -- --bom <id> --expect-db <name> --accept-name-only   # deactivates it
```

Confirming only the database *name* is not proof of which server you are on — a copy of the database has
the same name, and it is also reached at the same address and port — so the command makes you say so
explicitly with `--accept-name-only`, and records that in the activity log. Adding the host or the port
does not remove the need for it, because a copy matches on those too. If you know the cluster's id (your installer should have recorded it), pin that instead
and you do not need the acknowledgement:

```
npm run repair:duplicate-bom -- --bom <id> --expect-db <name> --expect-system-id <recorded id>
```

The last one asks you to confirm which database you are changing — either with `--expect-db`, or by
typing the database name when it asks. It will not make the change without that, because a copy of the
database contains the same recipe ids, so the id alone cannot tell a test copy from the real thing.

Be aware that a copy also keeps the same *name*, so confirming the name is not proof of which server you
are on. Before it writes, the command prints the server's address and cluster id as well; check those if
there is any chance a copy of the database is in play.

It will refuse if the recipe it is asked to deactivate is a product's live recipe, or the only active
recipe another product has — in those cases nothing is changed and it tells you which product is in
the way.

**A retired recipe is not a disagreement.** The check only reports a circular recipe that *planning
can actually reach* — an active recipe whose product is still a BOM. Retiring a recipe keeps its lines
on purpose (see **Changing a product's type** below), so a retired line pointing back at a product
that now consumes it is an ordinary state after a conversion, not a fault, and the check stays quiet
about it.

**Editing a recipe after import.** The product page's component editor writes both copies too, in
one step, so editing an imported BOM keeps them in step — you do not have to re-import to keep
planning correct.

**Changing a product's type.** Converting a BOM to any non-manufactured type *retires* its
manufacturing recipe: the recipe is marked inactive and stops being that product's recipe, but its
lines are kept so past build orders still report correctly. Converting back to BOM re-adopts the same
recipe and reactivates it — you do not end up with two. Converting a Kit to a BOM gives it a
manufacturing recipe from the components it already had.

Repair in every case is the same: re-import the affected products through the products CSV.


## Creating a Product

Click **New Product** to open the product form. (On an existing product the **Save Product** button sits in the page header, next to the product name, so it stays in view however far down the form you are.) The following fields are available:

| Field | Description |
|---|---|
| **SKU** | A unique code that identifies the product. |
| **Name** | The display name shown throughout the system. |
| **Category** | Reporting category as a path with `>` as the nesting separator (e.g. `Apparel > T-Shirts`). Pick from the dropdown — it lists every known category as a full path — or type a new path and the system creates each missing segment on save. Two leaves with the same name under different parents (`Apparel > T-Shirts` vs `Promo > T-Shirts`) are distinct. Manage the full tree in **Settings > Inventory**. |
| **Type** | The product type (see below). |
| **Barcode** | An optional barcode or EAN for scanning. |
| **HS Code** | The Harmonised System / EU Combined Nomenclature code for customs declarations. For a code that reaches the warehouse it must be a declarable 8-digit 2026 EU CN code (see [HS Code Review](#hs-code-review)). |
| **Country of Origin** | Pick the country where the product is manufactured from the list. Left blank, it is **not** stored as blank downstream: customs and the warehouse are sent **China (CN)** as the default, and the field says so. Choose a country to declare the true origin. |
| **Customs Description** | A short goods description for customs paperwork. The warehouse accepts at most 50 characters, so longer text is shortened at a word boundary when it is sent. Use a plain product phrase, not a brand name or a word such as "parts". |
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

To set up a Kit, use the **Kit Components** editor on the product page: search for a product, add it, and enter the quantity of each component required per Kit. The quantity box steps in whole numbers (minimum 0); a line with a blank or zero quantity is ignored when you click **Save Kit Components**. A product can only appear once in the list. If another Kit or BOM already has exactly the same components and quantities, an amber **Duplicate component configuration** notice names it, which helps catch an accidentally copied recipe; it is a warning and does not stop you saving.

A Kit's recipe is simply its component list. There is no separate stored "Kit" record, so nothing else needs maintaining; the older Kit tables have been removed. One visible consequence: the **Inventory Aging** report filtered to Type **Kit** is now empty and shows a notice saying virtual Kit SKUs hold no cost layers of their own. Age the component SKUs instead.

**Kit components cannot be changed while sales orders are still in flight against them.** Allocation,
shipment drafts, dispatch checks and stock reporting all read the kit's *current* component list, so
changing it would retroactively change what an in-flight order is deemed to require — and an
incomplete kit could then be dispatched without any warning. The editor refuses the save and names
the orders involved; the same applies to a CSV import that carries a components column.

An order blocks the edit only while its work is genuinely unfinished:

- it holds allocations **and** is still open (draft, pending payment, on hold, processing, allocated,
  picking or packing); or
- it has a shipment sitting at **picking** or **packed**.

Orders that are **shipped, completed or delivered do not block**, and neither does a pending shipment
draft. To clear a refusal: deallocate, dispatch or cancel the named orders. A shipment already at
picking or packed has no route back to draft and there is no per-shipment cancel, so dispatching it
(or cancelling its order, which deletes it) is the way to clear that one. Alternatively, clone the
product and change the copy.

A **cancelled** order does not block on its allocations, but it does block if a picking or packed
shipment is somehow still attached to it. Do **not** dispatch that shipment — it would ship goods for
a cancelled sale, and IMS refuses the transition. Open the order and use **Discard shipments**, which
deletes its remaining non-dispatched shipments (already-dispatched ones are kept; reverse those with
a refund). The action is safe to repeat: with nothing left to discard it does nothing.

**Changing a product between Kit and BOM is refused on the same terms**, in both the editor and the
CSV import, because it changes whether fulfilment expands that product's components — including when
the product is nested inside another kit and has no sales lines of its own.

Two limits worth knowing:

- The refusal is an early warning, not a lock. IMS's allocation and picking steps do not take the
  component-graph lock, so an edit committed at the same instant as an allocation can still slip
  past. What actually stops an incomplete kit leaving the building is a **recipe version** stamped on
  every allocation: editing a kit's components — or its Kit/BOM type — moves the version on that
  product and on every kit that contains it, and picking, shipment creation and dispatch all refuse
  rows stamped with an older version. The message says so and tells you to **Re-Allocate** the order,
  which rebuilds the rows against the current recipe. A second check at the same seams still refuses
  a shipment whose components are not a complete, proportional set. The version is what catches an
  edit that merely *scales* a recipe (say 2 of A + 1 of B becoming 4 of A + 2 of B): the old rows are
  still perfectly proportional to the new recipe, so proportionality alone would let half a kit ship.
- Reports over **completed** orders read today's recipe, not the one those orders shipped under.

### BOM (Bill of Materials)

A product that is manufactured from components. Unlike a Kit, a BOM product holds its own stock. Components are consumed during a build order, and the finished product's stock increases.

Use the **Bill of Materials** editor on the product page to define the recipe (same whole-number quantity box and **Save Bill of Materials** button as for Kits), specifying the quantity of each component consumed per unit produced. To load recipes in bulk, use the products CSV's `components` column — see
**Importing manufacturing recipes (BOM)** above.

**A BOM's component list can be edited at any time**, regardless of open sales orders. Fulfilment
treats a BOM as a stocked item and never expands its components, so changing the recipe cannot alter
what any sales order requires. In-progress build orders keep the component snapshot they froze at
start and are unaffected; the editor lists them so you know the change will not apply to them.

### Non-Inventory

A product that appears in sales and purchase orders but is not tracked in stock. Use this for services, digital goods, or miscellaneous charges.


## Product Detail Page

Click any product to open its detail page. From here you can:

- **Edit details** -- Update any of the product fields, then click **Save Product** in the page header.
- **HS Code Classification** -- Approve, edit or reject the proposed customs code in place (Simple, Variant, Kit and BOM products). See [HS Code Review](#hs-code-review).
- **View stock levels** -- See on hand, allocated, available, and incoming quantities per warehouse.
- **Adjust stock** -- Use the **Stock Adjustment** card to correct a quantity; see [Stock Control](stock-control.md).
- **Stock Flow** -- The Stock Flow button beside the product name lists every stock movement for the product (date, type, warehouse, reference, note) with links back to the order, transfer or build order, and can be filtered.
- **View in Store** -- Opens the product on the connected online store, when one is connected.
- **Replenishment** -- Shows the lead time used for reorder planning, and whether it is set by hand, derived automatically from purchase order history, or the 14-day default. Set it with **Lead time (days)** in the product form; leave blank to use the automatic value.

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


## Customs Data and HS Code Review

Every product can carry three customs fields: **HS Code**, **Country of Origin** and **Customs Description**. They are sent to the warehouse so shipments leave with the right paperwork.

### Where the customs fields come from

- **Variants inherit from their parent.** When you generate variants (or Kit/BOM children) from a Variable product, each new child starts with the parent's HS code, country of origin and customs description. Change them on an individual variant afterwards if it differs. Children created earlier are not changed retroactively.
- **WooCommerce import.** When the store supplies an HS code, country of origin or customs description for a product, the store's value wins and replaces the one in IMS if it differs. When the store leaves one blank, IMS keeps what it has. A customs description longer than 50 characters is shortened.
- **Country of origin.** The field is a country picker. Blank means China is declared by default. If an old record holds an origin that is not a real country, the product form shows it as "invalid — choose a country" and will not save until you pick a real one. A bad origin that reaches the warehouse push is declared as China and raised as an open discrepancy until corrected.

### CN8 check before the warehouse push

Before a product is pushed to the warehouse (Mintsoft), its HS code is checked: it must be exactly **8 digits** and be a current 2026 EU CN code. Punctuation such as `3926.9090` is stripped before the check. If the code fails:

- the product is still pushed, but **without** the commodity code;
- an open **INVALID_HS_CODE** discrepancy is raised for the product, with a message saying the code is not a declarable 2026 CN8;
- the discrepancy clears itself the next time the product syncs with a valid code.

Fix it by correcting the code on the product (or by approving a valid proposal, below). See [Warehouse (Mintsoft)](warehouse-mintsoft.md).

### HS Code Review

**Inventory > HS Code Review** is the queue of HS codes proposed by the AI classifier, waiting for a person to approve them. The menu item appears only for roles that can edit products (Admin, Manager and Warehouse); Finance and Read-only users do not see it.

How proposals arise:

- A product with no HS code and no earlier proposal is classified in the background (Simple, Variant, Kit and BOM products that are not archived). The background sweep takes a small batch at a time, and each product is proposed at most once, so a proposal you rejected does not come back by itself. The sweep runs only when your administrator has scheduled it; it is not part of the built-in job list.
- If the AI service is not reachable, or no key is configured, a simpler keyword-based suggestion is used instead, so the product still gets a proposal. The **Source** column shows which was used.
- If a product's name, description or category changes while its proposal is still pending, the stale proposal is dropped and the product is re-classified later.
- You can ask for a fresh classification at any time with **Re-classify** (queue) or **Classify** / **Re-classify** (product page).

The queue lists pending proposals, least confident first:

| Column | Meaning |
|---|---|
| **Product** | SKU and name. |
| **Proposed code** | The suggested 8-digit CN code. A red **not declarable** badge means it is not a valid current 2026 CN8. |
| **Confidence** | A band (**high** 85 and over, **medium** 60 to 84, **low** below 60) and a 0 to 100 score. The score is IMS's own check of the code against the CN list, the product's category and its description, not just the AI's self-reported confidence. |
| **Flags** | Why the score is what it is, for example an invalid format, a code not in the 2026 list, a superseded code, a category that does not match the code's heading, or a brand-only description. |
| **Source** | Which classifier produced it (AI, escalated AI, or keyword fallback). |

Click **Review** to open a proposal. Read the reasoning, edit the code if needed, add an optional review note, then choose **Approve** or **Reject**.

- **Approve** writes the code to the product's HS Code. It is refused (with a message) unless the code you are approving, after your edit, is a declarable 8-digit 2026 CN8 with no blocking flag (invalid format, not in 2026, or superseded). Approving only sets the HS code; it does not change the customs description.
- **Reject** leaves the product untouched and closes the proposal.
- If someone else reviewed the same proposal first, you are told it was already reviewed.

The same proposal also appears in the **HS Code Classification** card on the product page, with **Approve**, **Reject** and **Re-classify** buttons. A product with no proposal shows a **Classify** button. Read-only roles can see the card but cannot act on it.


## Stock Levels

Each product displays four stock figures per warehouse:

- **On Hand** -- Total physical stock in the warehouse.
- **Allocated** -- Quantity reserved by confirmed sales orders. Click the figure to see which orders hold the allocation.
- **Available** -- On Hand minus Allocated.
- **Incoming** -- Quantity on open purchase orders or inbound transfers, net of everything that has
  already arrived by any route (a manual receipt, a WMS book-in, or a WMS stock-sync alignment).
  Click the figure to see the source POs or transfers.


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

- **EOL → Archived (auto)** — when an EOL product has zero stock across every warehouse AND no incoming supply (no open PO lines with quantity still outstanding, no in-transit transfers, no in-progress manufacturing for it, no WMS ASN evidence), a daily cron job auto-archives it. A purchase order line counts by what has not yet landed, so a fully received line no longer holds the product back. The activity log records the transition with the incoming-stock breakdown at archive time.

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

When editing a Variable product, you define **options** (e.g. Size with values S, M, L and Colour with values Red, Blue). The system can then **generate variants** for every combination automatically. Each generated child SKU inherits the parent's weight, dimensions and customs fields (HS code, country of origin, customs description) and can be customised individually.

Save the options first, then use the **Generate as** selector next to **Generate Variants** to choose what the children are:

- **Variant** (the default) -- ordinary stocked children.
- **Kit / Bundle (virtual)** -- every child is created as a Kit.
- **BOM (manufactured)** -- every child is created as a manufactured BOM product.

Kit and BOM children are created **without components**. Open each child's own page and add its components in the Kit Components or Bill of Materials editor; until you do, it has no recipe. Combinations that already exist are skipped, so running the generator again only adds the missing ones. In the products list, these children are labelled **Variant child (Kit)** or **Variant child (BOM)**, to tell them apart from a standalone Kit or BOM.

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
