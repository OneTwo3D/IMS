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
- **Only cells you edited are applied.** The downloaded file ends with a `rev` column recording what each value was. Leave it as it is. A cell you did not change is ignored even if the product has been edited in IMS since you downloaded the file, so an old file cannot put old values back. If you edit a cell whose field has changed in IMS since the download, that product's row is refused with a message asking you to download again. A file without the `rev` column (one you built yourself) applies every non-blank cell, and the preview warns that changes made in IMS in the meantime cannot be detected.
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

Apply saves the changes and records, for each product, that its shop and warehouse sync is owed. It does not contact the shop or the warehouse itself. A background job, **Product Sync After Bulk Edit** (Settings > Scheduled tasks, on by default, every 5 minutes), then hands **25 products per run** to the same follow-up the product editor performs on save: the storefront metadata push, a storefront stock sync (forced for archived products), the warehouse (Mintsoft) product and bundle sync when a warehouse connector is on and you held the sync permission when you applied, and dropping a stale HS-code suggestion. So a large edit reaches the shop and the warehouse over the next sync runs, not instantly: 25 products per run is about 300 an hour, so 1,000 products take around three and a half hours and 20,000 about two and a half days. The result dialog says so. If the job is switched off the products stay waiting until it is switched on. A product that fails five runs in a row is left in the waiting list with its last error for an administrator to look at (the `product_sync_marks` table), and saving it again in the product editor or by CSV resets it.

## Large files

A file may hold up to 50,000 rows and 25 MB. A 20,000-variant file is read and saved in bulk (one lookup per 1,000 rows, one save per 250 products), not row by row. If a download would exceed 50,000 products, narrow the filter and download in parts.

## Troubleshooting

- **"SKU not found"**: the SKU in the file does not match a product exactly. Spreadsheets sometimes strip leading zeros or turn long numbers into scientific notation; format the sku column as text.
- **"cannot be cleared (it is required)"**: you used `__CLEAR__` on a field that must always have a value. Delete the cell's contents instead to leave it unchanged.
- **A batch "was rolled back and not saved"**: something changed while the file was applying (for example a barcode was taken by another user). The message names the first and last SKU of that batch. Upload the file again; products already saved show as already matching.
- **A description beginning with `=`, `+`, `-` or `@`** is exported with a leading apostrophe so spreadsheets do not run it as a formula. An untouched cell is recognised as unchanged and skipped, so the stored text is never altered. Text you type yourself is stored exactly as typed.
- **"was changed in IMS after this file was downloaded"**: another user edited that field after you downloaded the file. Download again and redo the edit.
