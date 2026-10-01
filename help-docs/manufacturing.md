# Manufacturing

Manufacturing orders let you assemble finished products from their components or disassemble products back into components. Only products configured as BOM (Bill of Materials) items with defined components can be used.

BOM products can be either standalone SKUs or BOM child variants under a Variable parent. Manufacturing always runs against the BOM SKU itself, not the Variable parent.

## Where a recipe comes from
**If the product changes while you are raising a build order**, the order is refused rather than
raised against stale information: IMS re-reads the product's type and components at the moment it
takes its lock, so a recipe edited in that instant is used in its *new* form, and a product converted
away from BOM in that instant is refused with a message saying so. Nothing is part-created.


A recipe can be entered on the product page or loaded in bulk through the products CSV's
`components` column — see [Importing manufacturing recipes](inventory.md#importing-manufacturing-recipes-bom).

IMS holds each recipe in two places. One copy is what a build order consumes; the other is what
**planning** reads — the replenishment report's component-demand explosion, automatic reorder build
orders, and manufacturing analytics. Both are written together by the product form, by the product-type change, and by the CSV import, so
they normally agree.

They can still fall out of step for recipes created before this was true, or edited directly in the
database. The symptom is quiet: the product builds fine one order at a time, but the reorder report
never suggests building it and its components are never reordered on its behalf. To check, open
`/api/export/bom-recipes?drift=1` or run `npm run check:bom-recipes`; to repair, re-import the
product through the products CSV.

## When a build order is refused

Raising a build order re-reads the recipe at the moment it is raised, not when you opened the form. If
somebody changes the product while you are filling it in, the build order is refused and **nothing is
written** — you are told which of these happened:

- the product is no longer a BOM, so it has no recipe to build;
- its components were cleared;
- its recipe is circular (some product in the recipe eventually consumes the product being built);
- another user claimed the recipe at the same moment — retry.

In every case no build order is created and the recipe is left exactly as it was. A refusal never
leaves a half-applied change behind.

**Starting an order re-checks it too.** A build order can sit in draft for days, so the recipe is
checked again at the moment you start it — before any stock is reserved. Starting is refused if the
product is no longer a manufactured (BOM) product, or if its components have been removed. Nothing is
reserved and the order stays in draft, so you can fix the recipe and start it again.

## Lifecycle status and manufacturing

The BOM product's [lifecycle status](glossary.md#lifecycle-status) controls which manufacturing operations are allowed:

| Status | New assembly orders? | New disassembly orders? | Complete in-flight orders? |
|---|---|---|---|
| **Draft** | Yes | Yes | Yes |
| **Active** | Yes | Yes | Yes |
| **EOL** | No | Yes | Yes |
| **Archived** | No | No | Yes (existing orders can be completed) |

Component products follow the same rule: an Archived component blocks new assemblies that need it, but existing in-flight orders can still complete. EOL components are flagged with a warning on the create form so you know stock is finite.

## Manufacturing Order List

The list view shows all manufacturing orders with search and filtering options:

- **Search** by reference, product name, or other fields
- **Filter by status**: Draft, In Progress, Completed, or Cancelled
- **Filter by type**: Assembly or Disassembly
- **Export to CSV** for external reporting

## Creating a Manufacturing Order

1. Click **New Manufacturing Order**
2. **Search for a product** — only BOM-type products with components are shown, including BOM variants
3. **Select a warehouse** where stock will be consumed from and produced into
4. Choose the order type:

### Assembly

Combines components into finished products. The form shows the **maximum units you can assemble** based on current component stock availability in the selected warehouse.

### Disassembly

Breaks finished products back into their components. The form shows how many assembled units are available and the **components generated per unit** when disassembled.

### Additional Fields

- **Manufacturer** — select from your suppliers list; the system auto-preselects the last used manufacturer for convenience
- **Quantity** — enter the number of units to produce or disassemble; a warning is shown if stock is insufficient
- **Reference** — auto-generated in the format `MO-YYYYMMDD-XXXX`
- **Scheduled date** — optionally set a target date for the order

## Status Flow

Manufacturing orders follow a defined workflow:

```
Draft ──> In Progress ──> Completed
  │            │
  └──> Cancelled <──┘
```

### Draft to In Progress

A stock check is performed. If sufficient stock is available, components are **allocated** — their reserved quantity is increased to prevent other orders from claiming the same stock.

### In Progress to Completed

Stock movements are created automatically:

- **PRODUCTION_OUT** for each component consumed
- **PRODUCTION_IN** for each finished product produced (assembly) or component recovered (disassembly)

All reservations are released.

### In Progress to Cancelled

No stock is moved. All reservations are **released**, making the components available again.

### Draft to Cancelled

No stock changes occur as nothing was allocated.

## Manufacturing Order Detail Page

The detail page shows:

- Full order details including product, components, quantities, and warehouse
- **Product image** — a larger product thumbnail displayed alongside the order details for quick visual identification
- **Component thumbnails** — each component row in the table includes a small product image
- Current progress status
- Options to generate a **PDF** or **email the manufacturer**

## 3rd Party Manufacturing

For orders fulfilled by an external manufacturer:

- **Generate a PDF** — a branded document listing all components with barcode/EAN, per-unit quantities, and total quantities
- **Email the manufacturer** — sends the PDF with a pre-filled subject line and body, ready to review and send

## Manufacturing Order PDF

The PDF document includes:

- Your company branding (logo, colours, footer)
- Order reference and dates
- Component table with barcode/EAN for each item
- Per-unit and total quantities for all components
- **Manufacturing-cost lines** (when configured) with per-line account override and total
- Manufacturer details

## Manufacturing Costs (Per-Run Overhead)

Each manufacturing order can carry a list of **per-run overhead lines** — labour, machine time, utilities, packaging, or any other indirect cost incurred to produce the run. Cost lines are managed from the order detail page in the **Manufacturing costs** card.

Each line records:

- **Description** (e.g. "Labour", "Machine time")
- **Amount** in the order's currency
- **Account override** (optional) — leave blank to credit the default Manufacturing Overhead account from Settings; enter an account code to route this specific line to a different GL account (e.g. "Wages" for labour, "Utilities" for power)

### How costs are capitalised

When the order completes:

- **Assembly** — the total of all cost lines is added to the consumed-component cost and divided across the produced quantity. The output cost layer's unit cost reflects components + overhead, so margin reporting and FIFO consumption use the fully-loaded cost.
- **Disassembly** — the overhead is distributed proportionally across the recovered component layers by their original value share.

### Accounting journal

On completion, OTI queues a journal entry to your accounting connector (Xero):

```
DR  Inventory Account              [total overhead]
  CR  Manufacturing Overhead        [per-line accounts]
```

The component movement (output ↔ components) nets to zero on the Inventory account, so the journal only captures the **overhead leg**. Each cost line lands on its own credit row, so labour, machine, and other categories can post to separate GL accounts.

If a cost line lacks both a per-line override AND the default account is unset in Settings, the journal is **skipped** and a warning is logged in the Activity Log; the cost layer still reflects the overhead, but the GL won't be posted until you configure the account.

### Editing costs after completion (retro-recalc)

Cost lines can be added, edited, or removed **after the order is completed**. When that happens:

1. The output cost layer's unit cost is recomputed from the new total.
2. The full overhead delta is split into a **consumed portion** (units already shipped) and a **remaining-inventory portion** (units still in stock), and a balanced 3-leg `MANUFACTURING_RECLASS` journal is queued:
   - `DR COGS` (or CR if delta is negative) for the consumed-units delta
   - `DR Inventory` for the remaining-inventory delta
   - `CR Manufacturing Overhead` for the **total** delta (matches the original journal direction)
3. Downstream snapshots on sales-order-line `cogsBase` and shipment-line `costLayerSnapshot` are refreshed.

This means you can record actuals against estimates retroactively (e.g. final labour timesheet, monthly utility bill apportionment) without re-running the order or breaking accounting integrity. The journal is **idempotent** — keyed on `MFG_RECLASS:<orderId>:<oldTotal>:<newTotal>`, so saving the same edit twice posts only once.

Negative amounts are not allowed on cost lines — the journal model assumes overhead is a non-negative debit to inventory. If you need to credit inventory (e.g. correcting an over-stated cost), reduce the cost line's amount instead, or use a separate stock adjustment.

### Settings prerequisites

To use this feature, configure under **Settings → Accounting**:

- **Manufacturing Overhead account** — the default credit account for cost lines without a per-line override
- **Inventory account** — already required for general operations; reused as the debit side
- **COGS account** — reused for retro reclass journals

The setting keys are `<connector>_manufacturing_overhead_account` (today `xero_manufacturing_overhead_account`) and the per-type toggle is `<connector>_sync_manufacturing_journal` (today `xero_sync_manufacturing_journal`).
