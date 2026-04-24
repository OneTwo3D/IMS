# Manufacturing

Manufacturing orders let you assemble finished products from their components or disassemble products back into components. Only products configured as BOM (Bill of Materials) items with defined components can be used.

BOM products can be either standalone SKUs or BOM child variants under a Variable parent. Manufacturing always runs against the BOM SKU itself, not the Variable parent.

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

On completion, OTI queues a journal entry to your accounting connector (Xero or QuickBooks):

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

The setting keys are `xero_manufacturing_overhead_account` / `quickbooks_manufacturing_overhead_account` and the per-type toggle is `xero_sync_manufacturing_journal` / `quickbooks_sync_manufacturing_journal`.
