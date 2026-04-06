# Manufacturing

Manufacturing orders let you assemble finished products from their components or disassemble products back into components. Only products configured as BOM (Bill of Materials) items with defined components can be used.

## Manufacturing Order List

The list view shows all manufacturing orders with search and filtering options:

- **Search** by reference, product name, or other fields
- **Filter by status**: Draft, In Progress, Completed, or Cancelled
- **Filter by type**: Assembly or Disassembly
- **Export to CSV** for external reporting

## Creating a Manufacturing Order

1. Click **New Manufacturing Order**
2. **Search for a product** — only BOM-type products with components are shown
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
- Manufacturer details
