# Products: Edit by CSV

**Edit by CSV** changes many products at once through a spreadsheet. You choose the products and the columns, download a file pre-filled with the current values, edit it offline, upload it, check the preview, and apply. For adding new products, or changing a product's type, parent or components, use **Import CSV** on the Inventory screen instead (see [Inventory](inventory.md)).

## Step by step

1. Open **Inventory**. Tick the products you want, or tick none to work on every product matching the current filter, then click **Edit by CSV**.
2. Choose the **products**: the ticked rows, or all products matching the current filter. The variants of a variable product are always included, so a file for a variable product has one row per variant.
3. Choose the **columns**. The picker only offers fields that can be edited this way (listed below). `sku` is always in the file and is how each row is matched to a product.
4. Click **Download CSV**, edit it in a spreadsheet, and save it as CSV.
5. Click **Choose CSV file**. Nothing is saved yet: IMS shows a preview with, per product, each field that would change (what it is now and what it becomes), the rows that cannot be applied and why, and the count of products that already match.
6. Click **Apply**. Products are saved in batches; each batch is all-or-nothing.

## The rules

- **A blank cell leaves the field as it is.** It never empties it. A file with a blank description will not wipe an existing description.
- **To empty a field, type `__CLEAR__` in the cell.** Only fields that can be empty accept it: description, category, image URL, barcode, MPN, country of origin, weight, width, height, depth, regular price, sale price and preferred supplier. Name, stock unit, lifecycle status and the yes/no fields cannot be cleared; a row that tries is not applied.
- **A column you delete from the file is not touched.** Only the columns present are read.
- **Only existing products are updated.** A SKU that is not in IMS is rejected; nothing is created. A SKU may appear only once in a file.
- **A row with any problem changes nothing for that product.** The other rows still apply. The preview lists every problem before you apply.
- **Values are checked, not guessed.** Yes/no fields take TRUE or FALSE (also yes/no, 1/0). Numbers must be plain digits with an optional decimal point (no currency symbols, no negatives, at most 4 decimal places for weight and prices and 2 for dimensions). A country must be a recognised country name or ISO code. A category must already exist, written as its path (for example `Apparel > T-Shirts`); Edit by CSV does not create categories. A supplier must already exist, matched by name. A barcode already used by another product, or given to two rows, is refused.
- Columns in the file that are not editable here (type, parentSku, components, productId and so on) are ignored, and the preview says so.

## Editable columns

| Group | Columns |
| --- | --- |
| Basics | `name`, `description`, `category`, `imageUrl` |
| Identifiers | `barcode`, `mpn`, `countryOfOrigin` |
| Logistics | `weight`, `widthCm`, `heightCm`, `depthCm`, `stockUnit`, `oversellAllowed` |
| Prices | `salesPriceBase` (regular price), `salePriceBase` (sale price), `salesPriceTaxInclusive` |
| Supplier | `preferredSupplierName`, `preferredSupplierLocked` |
| Status | `lifecycleStatus` (DRAFT, ACTIVE, EOL, ARCHIVED) |

These are the columns the ordinary product import already updates, under the same headings, so a file edited here is also a valid import file. Commodity code (HS code) is not editable this way.

## Permissions

Edit by CSV needs the same permission as editing a product (inventory edit). The three **Prices** columns also need the price permission (inventory prices): without it they are greyed out in the picker, and a file that contains them is refused as a whole.

## What happens after Apply

Each product that changed goes through the same follow-up as when you save it in the product editor: its details are pushed to the storefront, a stock sync is queued (forced for archived products), the warehouse (Mintsoft) product sync is scheduled if you hold the sync permission and a warehouse connector is on, and a pending HS-code suggestion is dropped if the name, description or category changed. These run in the background after the upload finishes, so a large edit returns quickly while the pushes catch up. IMS never writes to the storefront or warehouse directly from the upload.

## Large files

A file may hold up to 50,000 rows and 25 MB. A 20,000-variant file is read and saved in bulk (one lookup per 1,000 rows, one save per 250 products), not row by row. If a download would exceed 50,000 products, narrow the filter and download in parts.

## Troubleshooting

- **"SKU not found"**: the SKU in the file does not match a product exactly. Spreadsheets sometimes strip leading zeros or turn long numbers into scientific notation; format the sku column as text.
- **"cannot be cleared (it is required)"**: you used `__CLEAR__` on a field that must always have a value. Delete the cell's contents instead to leave it unchanged.
- **A batch "was rolled back and not saved"**: something changed while the file was applying (for example a barcode was taken by another user). The message names the first and last SKU of that batch. Upload the file again; products already saved show as already matching.
- **A description beginning with `=`, `+`, `-` or `@`** is exported with a leading apostrophe so spreadsheets do not run it as a formula. Edit by CSV removes that apostrophe on upload, so an untouched cell is not read as a change.
