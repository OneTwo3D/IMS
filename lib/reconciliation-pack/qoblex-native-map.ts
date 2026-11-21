/**
 * THE ONE COLUMN MAP THE PACK ACCEPTS FOR A NATIVE QOBLEX EXPORT (the stock-on-hand report, which feeds the products and stock-lots datasets).
 *
 * A column map can rename headers, replace values through value maps, give a column a constant, skip row kinds and rebuild rows from a wide
 * layout. It is operator-supplied input, so it must not be able to define what the pack compares: a manifest may name a column map only if its
 * bytes are EXACTLY this text (the digest is checked on the bytes read, qoblex-source.ts); the pack then parses THIS constant. Any other map is
 * COLUMN_MAP_NOT_NATIVE. A test pins this text byte for byte to tests/first-load/fixtures/qoblex-native/maps/qoblex-stock-on-hand.map.json, the
 * map the first-load tool is tested with, so the two cannot drift.
 *
 * EVERY TRANSFORM IN IT, and what each does to a compared value. THREE of them DO change what is compared, and each is REPORTED in the pack's evidence
 * (qoblex-evidence.ts), never silent: ghostRows (a dropped row; a ghost with a NON-ZERO quantity makes its part inconclusive, QOBLEX_GHOST_STOCK, and a
 * zero one is listed), blankStockIsZero (a SKU read as 0 on hand; listed per run with its SKU) and the rowSelect skips (counted per part and per kind).
 * The rest are renames, constants and fixed lists that cannot alter a quantity, SKU or location:
 *   products  rowsAboveHeader 1                 the report's label row above the header: structure, no data.
 *             columns sku/name/type/barcode/lifecycleStatus  header renames only.
 *             valueMaps.type simple->SIMPLE, variable->VARIANT, kit->KIT, bom->BOM, non-inventory->NON_INVENTORY
 *                                               the product type is used only to set a variation aside from the storefront walk (R14); the map is
 *                                               fixed, so the set-aside is fixed, and every other type is PRESENCE-compared like a simple product.
 *                                               A type not listed here (the export's own "Unknown", or a label nobody has seen) is a closed list
 *                                               miss: the ingest rejects the row and the source is refused, never guessed at.
 *             valueMaps.lifecycleStatus Active->ACTIVE, Inactive->EOL, Archived->DRAFT  not read by the pack; a non-active product is still a product R14
 *                                               compares. (Qoblex archives a product while it is a WooCommerce draft, so Archived is DRAFT, not end of
 *                                               life.) Any other state is a closed list miss, refused the same way.
 *             rowSelect State keep Active/Inactive/Archived, skip Deleted  a Deleted product is not part of the load (owner ruling): counted by the
 *                                               ingest (rowsSkipped), never read as a product.
 *             nameColumn Product, nonStock Product Type=non-inventory  decisions hooks: the pack is never given a decisions list, so they do nothing here.
 *             ghostRows Product Type=Unknown  of several rows of one SKU exactly one of which is typed, the Unknown ones are dropped (a ghost left behind in Qoblex); any other duplicate is still refused.
 *                                               CHANGES WHAT IS COMPARED: the dropped row's quantity vanishes from the pack's stock. Reported (R2 qoblex-ghost-row, R14 qoblex-ghost-row and
 *                                               qoblex-rows-skipped, from the ingest's notes and rowsSkipped); a ghost with a non-zero quantity makes the part inconclusive.
 *   stock-lots rowsAboveHeader 1                the same label row.
 *             blankStockIsZero true             a row whose all-warehouses total is blank and every warehouse cell is blank or exactly zero is read as 0 on hand (owner ruling), reported per row
 *                                               by the ingest (BLANK_STOCK_AS_ZERO). A blank total next to any non-zero warehouse cell is still refused (WIDE_TOTAL_MISMATCH).
 *                                               CHANGES A COMPARED VALUE (blank -> 0): first load and pack now share this reading (one ingest), so an export fault that
 *                                               leaves real stock blank reads 0 on BOTH legs and only the warehouse-system leg can catch it. The pack therefore lists, per
 *                                               run, every SKU so read (R2 qoblex-blank-as-zero, value 0), from the ingest's notes.
 *             columns sku, unitCost             header renames only (unit cost is the report's Moving Average Cost).
 *             constants.currency GBP            the report has no currency column; the manifest declares GBP and R5 refuses anything else. It cannot
 *                                               change a quantity, SKU or location. LIMIT: the currency is a declaration, not read from the file.
 *             rowSelect (a list, every selector must pass): Product Type keep simple/variable/bom  the kinds that hold stock of their own (IMS stock-bearing types: SIMPLE, VARIANT, BOM).
 *                                               skip kit/non-inventory  the two kinds that never hold stock in IMS (a kit's stock is its components', a
 *                                               non-inventory item has none; the first-load tool refuses opening stock for both). Those rows are counted
 *                                               by the ingest (rowsSkipped), not read as lots, and the counts are listed (R14 qoblex-rows-skipped). A row of ANY other kind is refused by the ingest
 *                                               (UNLISTED_ROW_KIND), never dropped. State: the same keep/skip lists as the products (Deleted skipped).
 *             wide (blocks, label -> warehouse code, totals, uniqueBy sku)  the warehouse labels map to the fixed codes MIL1, CAMBRIDGE, RESTOCK,
 *                                               QUARANTINE-CAMBRIDGE, RXT2; the quantity of each block must add up to the report's all-warehouses
 *                                               total or the row is refused, and a repeated SKU refuses every row carrying it.
 * LIMIT: the labels kit, bom and non-inventory are the ones R14 needs but NO real export read so far carries them (the real stock-on-hand report
 * has only simple, variable and Unknown types and only the Active state): they are mapped so that the day an export carries them R14 classifies them, and
 * any spelling not listed here stays refused until the map is changed in the repository.
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
        "Sku",
        "Barcode",
        "State",
        "Brand",
        "Product Type",
        "Supplier",
        "Updated At",
        "Moving Average Cost",
        "Purchase Price",
        "Wholesale Price",
        "Retail Price",
        "Retail Compare Price",
        "Wholesale Compare Price",
        "Total Cost",
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
        "lifecycleStatus": "State"
      },
      "valueMaps": {
        "type": {
          "simple": "SIMPLE",
          "variable": "VARIANT",
          "kit": "KIT",
          "bom": "BOM",
          "non-inventory": "NON_INVENTORY"
        },
        "lifecycleStatus": {
          "Active": "ACTIVE",
          "Inactive": "EOL",
          "Archived": "DRAFT"
        }
      },
      "rowSelect": {
        "column": "State",
        "keep": [
          "Active",
          "Inactive",
          "Archived"
        ],
        "skip": [
          "Deleted"
        ]
      },
      "nameColumn": "Product",
      "nonStock": {
        "column": "Product Type",
        "value": "non-inventory"
      },
      "ghostRows": {
        "column": "Product Type",
        "ghost": "Unknown",
        "quantityColumn": "Quantity"
      }
    },
    "stock-lots": {
      "rowsAboveHeader": 1,
      "expectedHeaders": [
        "Product",
        "Sku",
        "Barcode",
        "State",
        "Brand",
        "Product Type",
        "Supplier",
        "Updated At",
        "Moving Average Cost",
        "Purchase Price",
        "Wholesale Price",
        "Retail Price",
        "Retail Compare Price",
        "Wholesale Compare Price",
        "Total Cost",
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
      "rowSelect": [
        {
          "column": "Product Type",
          "keep": [
            "simple",
            "variable",
            "bom"
          ],
          "skip": [
            "kit",
            "non-inventory"
          ]
        },
        {
          "column": "State",
          "keep": [
            "Active",
            "Inactive",
            "Archived"
          ],
          "skip": [
            "Deleted"
          ]
        }
      ],
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
      },
      "nameColumn": "Product",
      "nonStock": {
        "column": "Product Type",
        "value": "non-inventory"
      },
      "ghostRows": {
        "column": "Product Type",
        "ghost": "Unknown",
        "quantityColumn": "Quantity"
      },
      "blankStockIsZero": true
    }
  }
}
`

/**
 * THE ONE COLUMN MAP THE PACK ACCEPTS FOR A NATIVE QOBLEX INCOMING-STOCK (open purchase order) EXPORT, for R7 and R8. The same rule as the
 * stock map above: a manifest may name a column map for its `purchaseOrders` part only if its bytes are EXACTLY this text (the digest is
 * checked on the bytes read, qoblex-source.ts); the pack parses THIS constant. It is the first-load tool's tested map
 * (tests/first-load/fixtures/qoblex-native/maps/qoblex-incoming-stock.map.json) (which has NO currency or rate table either: the first-load
 * tool takes an order's currency from its supplier and its rate from fx_rates). A test pins this text byte for byte to that file.
 *
 * EVERY TRANSFORM IN IT, and why none can change a compared value:
 *   columns orderKey/supplierName/status/sku/qtyOrdered/qtyReceived/unitCostForeign/lineDiscountPercent/supplierRef/createdOn/expectedDelivery  header renames only.
 *                                              (lineDiscountPercent, the per-line Discount (%), is READ but never applied: the first-load tool refuses an open line that has a
 *                                              non-zero one, and R7 is inconclusive on such a line, so a gross price is never compared with a gross price.)
 *   constants.destinationWarehouseCode MIL1   the report has no destination column; the pack never reads the warehouse of an order.
 *   (no currency column: the report has NO currency or rate, and neither the pack nor the pinned map carries a supplier-to-currency or currency-to-rate table.
 *   The currency of an order is the one IMS RECORDED on the purchase order, and its rate is the central fx_rates row (purchase-order-items.ts).)
 *   valueMaps.status Approved/PartiallyReceived -> OPEN, Closed -> CLOSED   the only statuses the incoming report lists (a closed line is a finished one:
 *                                               the first-load tool excludes it as NOT_OPEN, the pack reads only open orders and DROPS it before its
 *                                               duplicate check, qoblex-source.ts); any other status is not mapped and
 *                                               the pack refuses a row whose status is not OPEN (BAD_VALUE), it never drops it.
 *   dateFormats.createdOn/expectedDelivery    a date format for columns the pack does not read.
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
        "lineDiscountPercent": "Discount (%)",
        "supplierRef": "Supplier Reference",
        "createdOn": "Created on",
        "expectedDelivery": "Due On"
      },
      "constants": {
        "destinationWarehouseCode": "MIL1"
      },
      "dateFormats": {
        "createdOn": "ddd, MMM D YYYY",
        "expectedDelivery": "ddd, MMM D YYYY"
      },
      "valueMaps": {
        "status": {
          "Approved": "OPEN",
          "PartiallyReceived": "OPEN",
          "Closed": "CLOSED"
        }
      }
    }
  }
}
`
