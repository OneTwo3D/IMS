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

/**
 * THE ONE COLUMN MAP THE PACK ACCEPTS FOR A NATIVE QOBLEX INCOMING-STOCK (open purchase order) EXPORT, for R7 and R8. The same rule as the
 * stock map above: a manifest may name a column map for its `purchaseOrders` part only if its bytes are EXACTLY this text (the digest is
 * checked on the bytes read, qoblex-source.ts); the pack parses THIS constant. It is the first-load tool's tested map
 * (tests/first-load/fixtures/qoblex-native/maps/qoblex-incoming-stock.map.json) WITH THE CURRENCY AND RATE TABLES REMOVED: a test derives
 * this text from that file (remove `derived`, `valueMaps.currency` and `valueMaps.fxRateToBase`, give `currency` the constant XXX) and
 * fails if the two ever differ in anything else, so the column renames and the status map cannot drift.
 *
 * EVERY TRANSFORM IN IT, and why none can change a compared value:
 *   columns orderKey/supplierName/status/sku/qtyOrdered/qtyReceived/unitCostForeign/supplierRef/expectedDelivery  header renames only.
 *   constants.destinationWarehouseCode MIL1   the report has no destination column; the pack never reads the warehouse of an order.
 *   constants.currency XXX                     ISO 4217 "no currency": the report has NO currency or rate column and the pack no longer
 *                                               carries a supplier-to-currency or currency-to-rate table. The currency of an order is the one
 *                                               IMS RECORDED on the purchase order, and its rate is the central fx_rates row (purchase-order-items.ts);
 *                                               the ingest only needs the column to exist, and the pack never reads this value.
 *   valueMaps.status Approved/PartiallyReceived -> OPEN   the only two statuses the incoming report lists; any other status is not mapped and
 *                                               the pack refuses a row whose status is not OPEN (BAD_VALUE), it never drops it.
 *   dateFormats.expectedDelivery              a date format for a column the pack does not read.
 * LIMITS: the foreign unit price is read as being in the currency IMS recorded on the matched purchase order; the report cannot confirm
 * that (stated limit). The report carries no line number: a line is identified by its order and SKU.
 */

export const QOBLEX_NATIVE_PO_COLUMN_MAP = `{
  "formatVersion": 1,
  "source": "qoblex",
  "datasets": {
    "purchase-order-lines": {
      "expectedHeaders": [
        "Product variant",
        "SKU",
        "Created on",
        "Received on",
        "Due On",
        "Purchase Order",
        "Status",
        "Ordered Quantity",
        "Received Quantity",
        "Price",
        "Discount (%)",
        "Supplier",
        "Supplier Reference"
      ],
      "columns": {
        "orderKey": "Purchase Order",
        "supplierName": "Supplier",
        "status": "Status",
        "sku": "SKU",
        "qtyOrdered": "Ordered Quantity",
        "qtyReceived": "Received Quantity",
        "unitCostForeign": "Price",
        "supplierRef": "Supplier Reference",
        "expectedDelivery": "Due On"
      },
      "constants": {
        "destinationWarehouseCode": "MIL1",
        "currency": "XXX"
      },
      "dateFormats": {
        "expectedDelivery": "ddd, MMM D YYYY"
      },
      "valueMaps": {
        "status": {
          "Approved": "OPEN",
          "PartiallyReceived": "OPEN"
        }
      }
    }
  }
}
`
