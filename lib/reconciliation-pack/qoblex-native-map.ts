/**
 * THE ONE COLUMN MAP THE PACK ACCEPTS FOR A NATIVE QOBLEX EXPORT (the stock-on-hand report, which feeds the products and stock-lots datasets).
 *
 * A column map can rename headers, replace values through value maps, give a column a constant, skip row kinds and rebuild rows from a wide
 * layout. It is operator-supplied input, so it must not be able to define what the pack compares: a manifest may name a column map only if its
 * bytes are EXACTLY this text (the digest is checked on the bytes read, qoblex-source.ts); the pack then parses THIS constant. Any other map is
 * COLUMN_MAP_NOT_NATIVE. A test pins this text byte for byte to tests/first-load/fixtures/qoblex-native/maps/qoblex-stock-on-hand.map.json, the
 * map the first-load tool is tested with, so the two cannot drift.
 *
 * EVERY TRANSFORM IN IT, and why none can change a compared value:
 *   products  rowsAboveHeader 1                 the report's label row above the header: structure, no data.
 *             columns sku/name/type/barcode/active  header renames only.
 *             valueMaps.type simple->SIMPLE, variable->VARIANT  the product type is used only to set a variation aside from the storefront
 *                                               walk (R14); the map is fixed, so the set-aside is fixed. Any other type is refused by the ingest.
 *             valueMaps.active Active->TRUE      not read by the pack.
 *   stock-lots rowsAboveHeader 1                the same label row.
 *             columns sku, unitCost             header renames only (unit cost is the report's Moving Average Cost).
 *             constants.currency GBP            the report has no currency column; the manifest declares GBP and R5 refuses anything else. It cannot
 *                                               change a quantity, SKU or location. LIMIT: the currency is a declaration, not read from the file.
 *             rowSelect keep simple/variable    NO skip list: a row of any other kind is refused by the ingest (UNLISTED_ROW_KIND), never dropped.
 *             wide (blocks, label -> warehouse code, totals, uniqueBy sku)  the warehouse labels map to the fixed codes MIL1, CAMBRIDGE, RESTOCK,
 *                                               QUARANTINE-CAMBRIDGE, RXT2; the quantity of each block must add up to the report's all-warehouses
 *                                               total or the row is refused, and a repeated SKU refuses every row carrying it.
 * LIMIT: the location labels are fixed here; a Qoblex installation whose labels differ needs this map changed in the repository, not in an export.
 */

export const QOBLEX_NATIVE_COLUMN_MAP = `{
  "formatVersion": 1,
  "source": "qoblex",
  "datasets": {
    "products": {
      "rowsAboveHeader": 1,
      "expectedHeaders": [
        "Product",
        "Barcode",
        "Sku",
        "Brand",
        "Product Type",
        "State",
        "Supplier",
        "Updated At",
        "Moving Average Cost",
        "Total Cost",
        "Purchase Price",
        "Wholesale Price",
        "Retail Price",
        "Retail Compare Price",
        "Wholesale Compare Price",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "On Back Order Quantity",
        "Location Is Deleted",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "Alert Level",
        "Location Is Deleted",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "Alert Level",
        "Location Is Deleted",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "Alert Level",
        "Location Is Deleted",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "Alert Level",
        "Location Is Deleted",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "Alert Level"
      ],
      "columns": {
        "sku": "Sku",
        "name": "Product",
        "type": "Product Type",
        "barcode": "Barcode",
        "active": "State"
      },
      "valueMaps": {
        "type": {
          "simple": "SIMPLE",
          "variable": "VARIANT"
        },
        "active": {
          "Active": "TRUE"
        }
      }
    },
    "stock-lots": {
      "rowsAboveHeader": 1,
      "expectedHeaders": [
        "Product",
        "Barcode",
        "Sku",
        "Brand",
        "Product Type",
        "State",
        "Supplier",
        "Updated At",
        "Moving Average Cost",
        "Total Cost",
        "Purchase Price",
        "Wholesale Price",
        "Retail Price",
        "Retail Compare Price",
        "Wholesale Compare Price",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "On Back Order Quantity",
        "Location Is Deleted",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "Alert Level",
        "Location Is Deleted",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "Alert Level",
        "Location Is Deleted",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "Alert Level",
        "Location Is Deleted",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "Alert Level",
        "Location Is Deleted",
        "Quantity",
        "Allocated Quantity",
        "Available Quantity",
        "Incoming Quantity",
        "Buffer Quantity",
        "Alert Level"
      ],
      "columns": {
        "sku": "Sku",
        "unitCost": "Moving Average Cost"
      },
      "constants": {
        "currency": "GBP"
      },
      "rowSelect": {
        "column": "Product Type",
        "keep": [
          "simple",
          "variable"
        ]
      },
      "wide": {
        "blockStart": "after-label",
        "warehouses": {
          "1 MIL1": "MIL1",
          "2 Cambridge Warehouse": "CAMBRIDGE",
          "3 Restock": "RESTOCK",
          "4 Quarantaine Cambridge": "QUARANTINE-CAMBRIDGE",
          "5 RXT2": "RXT2"
        },
        "blockColumns": {
          "qty": "Quantity"
        },
        "totals": {
          "qty": "Quantity"
        },
        "uniqueBy": "sku"
      }
    }
  }
}
`
