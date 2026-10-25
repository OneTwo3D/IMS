/**
 * FIRST-LOAD INPUT SPEC: the single definition of the canonical input datasets, the importers'
 * template headers we must reproduce, the limits we chunk to, and the CLI exit-code table.
 *
 * PURE: no database, no network, no clock. `docs/first-load-input-spec.md` documents every value
 * here, and `tests/first-load/spec-doc.test.ts` fails when the two disagree.
 *
 * WHY THE OUTPUT HEADERS ARE LITERALS HERE AND NOT IMPORTED FROM THE ROUTES. The `/api/export/*`
 * route files keep their header lists module-private and import the database and the auth layer, so
 * a unit test cannot load them. `tests/first-load/importer-headers.test.ts` therefore reads the
 * route SOURCE with the TypeScript parser, resolves the array that feeds `buildTemplateCsv(...)`,
 * and compares it with the lists below. A header renamed in a route, or here, turns that test red.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The importers (`app/actions/import.ts` MAX_IMPORT_ROWS / MAX_IMPORT_BYTES, and the same two
 * constants in `app/actions/suppliers.ts`) accept AT MOST 10,000 data rows and 10 MiB per file and
 * silently drop every row beyond the row cap (one error line, nothing else).
 *
 * We emit FEWER than 10,000 rows (so at most 9,999) and strictly under 10 MB (decimal), which is
 * stricter than both on each axis: the one-row and ~0.5 MB margins mean an off-by-one in a future
 * importer change cannot silently drop a row that this tool emitted.
 */
export const IMPORTER_MAX_ROWS = 10_000
export const IMPORTER_MAX_BYTES = 10 * 1024 * 1024
export const MAX_ROWS_PER_FILE = IMPORTER_MAX_ROWS - 1
export const MAX_BYTES_PER_FILE = 10_000_000 - 1

// ---------------------------------------------------------------------------
// Exit codes: ONE table. The doc repeats it; the CLI and `--help` read it from here.
// ---------------------------------------------------------------------------

export const EXIT_CODES = {
  OK: 0,
  BLOCKING_FINDINGS: 1,
  USAGE: 2,
  INPUT_UNUSABLE: 3,
  OUTPUT_FAILED: 4,
  INTERNAL: 5,
} as const

export type ExitCodeName = keyof typeof EXIT_CODES

export const EXIT_CODE_TABLE: ReadonlyArray<{ code: number; name: ExitCodeName; meaning: string }> = [
  {
    code: EXIT_CODES.OK,
    name: 'OK',
    meaning:
      'The run finished with no blocking finding in the datasets that were supplied. Import files were written (unless --dry-run). '
      + 'This is NOT a statement about datasets that were not supplied: the report lists them under "Not supplied".',
  },
  {
    code: EXIT_CODES.BLOCKING_FINDINGS,
    name: 'BLOCKING_FINDINGS',
    meaning:
      'The run finished and found at least one rejected row or blocking finding. The report was written (or printed with --dry-run); '
      + 'NO import file was written, so a partial load cannot be uploaded by mistake.',
  },
  {
    code: EXIT_CODES.USAGE,
    name: 'USAGE',
    meaning: 'Bad command line or an invalid run manifest. Nothing was read or written.',
  },
  {
    code: EXIT_CODES.INPUT_UNUSABLE,
    name: 'INPUT_UNUSABLE',
    meaning:
      'An input file or column map cannot be used as-is: missing, not valid UTF-8, malformed CSV, a mapped header absent or ambiguous, '
      + 'or an invalid column map. Nothing was written.',
  },
  {
    code: EXIT_CODES.OUTPUT_FAILED,
    name: 'OUTPUT_FAILED',
    meaning:
      'The output directory is unusable (it exists and is not empty, or a write failed). Files this run had created were removed again.',
  },
  {
    code: EXIT_CODES.INTERNAL,
    name: 'INTERNAL',
    meaning:
      'A self-check of this tool failed (row accounting did not reconcile, or an emitted file broke an importer limit). This is a defect in the tool, '
      + 'not in the data. No import file was written; the report is, so the failure can be read.',
  },
]

// ---------------------------------------------------------------------------
// Product types
// ---------------------------------------------------------------------------

/** `VALID_TYPES` in app/actions/import.ts. */
export const PRODUCT_TYPES = ['SIMPLE', 'VARIABLE', 'VARIANT', 'KIT', 'BOM', 'NON_INVENTORY'] as const
export type ProductType = (typeof PRODUCT_TYPES)[number]

/** Types that can carry a recipe (`COMPONENT_BEARING_TYPES`, app/actions/import.ts). */
export const RECIPE_TYPES: ReadonlySet<string> = new Set(['KIT', 'BOM'])

/**
 * Types that may receive opening stock. `importOpeningStockCsv` refuses VARIABLE, NON_INVENTORY and KIT,
 * and FIFO cost layers exist for SIMPLE, VARIANT and BOM (lib/domain/inventory/invariants.ts).
 */
export const STOCK_BEARING_TYPES: ReadonlySet<string> = new Set(['SIMPLE', 'VARIANT', 'BOM'])

export const LIFECYCLE_STATUSES = ['DRAFT', 'ACTIVE', 'EOL', 'ARCHIVED'] as const

// ---------------------------------------------------------------------------
// Importer template headers (what the output files must carry, byte for byte)
// ---------------------------------------------------------------------------

/** app/api/export/products/route.ts TEMPLATE_HEADERS, the list passed to buildTemplateCsv. */
export const PRODUCTS_IMPORT_HEADERS = [
  'productId', 'parentProductId',
  'sku', 'name', 'description', 'type', 'parentSku', 'barcode', 'mpn', 'countryOfOrigin',
  'preferredSupplierId', 'preferredSupplierName', 'preferredSupplierLocked',
  'weight', 'widthCm', 'heightCm', 'depthCm',
  'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive',
  'stockUnit', 'oversellAllowed', 'imageUrl', 'active', 'lifecycleStatus',
  'components', 'category',
] as const

/** app/api/export/suppliers/route.ts HEADERS. */
export const SUPPLIERS_IMPORT_HEADERS = [
  'supplierId', 'name', 'contactName', 'email', 'phone', 'currency', 'vatNumber', 'accountNumber', 'paymentTermsDays',
  'addressLine1', 'addressLine2', 'city', 'county', 'postcode', 'country', 'notes', 'purchaseTaxType',
] as const

/** app/api/export/stock-levels/route.ts TEMPLATE_HEADERS (= HEADERS), the opening-stock template. */
export const OPENING_STOCK_IMPORT_HEADERS = [
  'sku', 'warehouseCode', 'qty', 'unitCostBase', 'productName', 'type', 'stockUnit', 'warehouseName', 'reserved', 'available',
  'inventoryValueBase',
] as const

/** app/api/export/transfers/route.ts HEADERS. */
export const TRANSFERS_IMPORT_HEADERS = ['transferKey', 'fromWarehouseCode', 'toWarehouseCode', 'status', 'sku', 'qty', 'notes'] as const

/** app/api/export/purchase-orders/route.ts HEADERS. */
export const PURCHASE_ORDERS_IMPORT_HEADERS = [
  'orderKey', 'supplierName', 'currency', 'fxRateToBase', 'destinationWarehouseCode', 'sku', 'qty', 'unitCostForeign',
  'lineDiscountForeign', 'lineDiscountStr', 'taxRateName', 'taxRateValue', 'orderTaxRateName', 'orderTaxRateValue',
  'pricesIncludeVat', 'supplierRef', 'expectedDelivery', 'orderDiscountForeign', 'notes',
] as const

export type ImporterTarget = 'products' | 'suppliers' | 'opening-stock' | 'transfers' | 'purchase-orders'

/**
 * Per output kind: the importer file whose template defines the headers, the route that serves the
 * template, the name of the constant in that route that feeds `buildTemplateCsv`, and the load order.
 * The numeric prefix of an output file name is the load order (see docs/first-load-input-spec.md).
 */
export const IMPORT_TARGETS: Record<ImporterTarget, {
  loadOrder: number
  headers: readonly string[]
  required: readonly string[]
  templateRoute: string
  templateConstant: string
  importer: string
}> = {
  suppliers: {
    loadOrder: 1,
    headers: SUPPLIERS_IMPORT_HEADERS,
    required: ['name'],
    templateRoute: 'app/api/export/suppliers/route.ts',
    templateConstant: 'HEADERS',
    importer: 'importSuppliersCsv (app/actions/suppliers.ts)',
  },
  products: {
    loadOrder: 2,
    headers: PRODUCTS_IMPORT_HEADERS,
    required: ['sku', 'name'],
    templateRoute: 'app/api/export/products/route.ts',
    templateConstant: 'TEMPLATE_HEADERS',
    importer: 'importProductsCsv (app/actions/import.ts)',
  },
  'opening-stock': {
    loadOrder: 3,
    headers: OPENING_STOCK_IMPORT_HEADERS,
    required: ['sku', 'warehouseCode', 'qty', 'unitCostBase'],
    templateRoute: 'app/api/export/stock-levels/route.ts',
    templateConstant: 'TEMPLATE_HEADERS',
    importer: 'importOpeningStockCsv (app/actions/import.ts)',
  },
  transfers: {
    loadOrder: 4,
    headers: TRANSFERS_IMPORT_HEADERS,
    required: ['fromWarehouseCode', 'toWarehouseCode', 'status', 'sku', 'qty'],
    templateRoute: 'app/api/export/transfers/route.ts',
    templateConstant: 'HEADERS',
    importer: 'importTransfersCsv (app/actions/import.ts)',
  },
  'purchase-orders': {
    loadOrder: 5,
    headers: PURCHASE_ORDERS_IMPORT_HEADERS,
    required: ['supplierName', 'sku', 'qty', 'unitCostForeign'],
    templateRoute: 'app/api/export/purchase-orders/route.ts',
    templateConstant: 'HEADERS',
    importer: 'importPurchaseOrdersCsv (app/actions/import.ts)',
  },
}

// ---------------------------------------------------------------------------
// Canonical input datasets
// ---------------------------------------------------------------------------

/**
 * The three kinds of source system. `wms` is the 3PL's own export. The code never names a connector: the generic-layer guard
 * (check:wms-connector-boundary) keeps connector literals out of lib/, and nothing here needs one, because a column map
 * says what the columns are. See docs/first-load-input-spec.md for which 3PL that is today.
 */
export const SOURCES = ['qoblex', 'wms', 'woocommerce'] as const
export type SourceName = (typeof SOURCES)[number]

export const DATASET_NAMES = [
  'products',
  'recipe-lines',
  'stock-lots',
  'suppliers',
  'purchase-order-lines',
  'transfers',
  'wms-products',
  'wms-stock',
  'woo-products',
  'variant-parents',
  'sku-exclusions',
  'ims-skus',
  'ims-suppliers',
  'ims-tax-rates',
  'ims-fx-rates',
] as const
export type DatasetName = (typeof DATASET_NAMES)[number]

export interface DatasetSpec {
  /** Canonical column names in file order; the canonical CSV header is exactly this list. */
  columns: readonly string[]
  /** Columns that must carry a value in every row (a constant in the column map counts). */
  required: readonly string[]
  /** Sources whose native export may feed this dataset through a column map. A canonical file needs none. */
  sources: readonly SourceName[]
  /** What the dataset is for, in one line. */
  purpose: string
}

export const DATASETS: Record<DatasetName, DatasetSpec> = {
  products: {
    columns: [
      'sku', 'name', 'type', 'parentSku', 'category', 'description', 'barcode', 'mpn', 'countryOfOrigin',
      'weight', 'widthCm', 'heightCm', 'depthCm', 'salesPriceBase', 'salePriceBase', 'salesPriceTaxInclusive',
      'stockUnit', 'imageUrl', 'active', 'lifecycleStatus',
    ],
    required: ['sku', 'name', 'type'],
    sources: ['qoblex'],
    purpose: 'Product catalogue, variants and bundle/BOM parents. Qoblex is authoritative. Becomes the products import file.',
  },
  'recipe-lines': {
    columns: ['parentSku', 'componentSku', 'qty', 'sortOrder'],
    required: ['parentSku', 'componentSku', 'qty'],
    sources: ['qoblex'],
    purpose: 'One row per KIT or BOM component line. Becomes the `components` cell of the parent in the products import file.',
  },
  'stock-lots': {
    columns: ['sku', 'warehouseCode', 'qty', 'unitCost', 'currency', 'fxRateToBase', 'receivedDate', 'lotRef'],
    required: ['sku', 'warehouseCode', 'qty', 'currency'],
    sources: ['qoblex'],
    purpose:
      'FIFO lots on hand per SKU and warehouse. A row with qty 0 states "zero on hand". Collapsed to one weighted-average row per SKU and warehouse '
      + '(the opening-stock import file).',
  },
  suppliers: {
    columns: [
      'name', 'contactName', 'email', 'phone', 'currency', 'vatNumber', 'accountNumber', 'paymentTermsDays',
      'addressLine1', 'addressLine2', 'city', 'county', 'postcode', 'country', 'notes', 'purchaseTaxType',
    ],
    required: ['name'],
    sources: ['qoblex'],
    purpose: 'Suppliers. Becomes the suppliers import file. The transform also requires `currency` and `purchaseTaxType` of every row (a blank is refused, never defaulted), each with its own rejection code.',
  },
  'purchase-order-lines': {
    columns: [
      'orderKey', 'supplierName', 'status', 'createdOn', 'destinationWarehouseCode', 'sku', 'lineNo', 'qtyOrdered', 'qtyReceived',
      'unitCostForeign', 'taxRateName', 'taxRateValue', 'pricesIncludeVat', 'supplierRef', 'expectedDelivery', 'notes',
    ],
    required: ['orderKey', 'supplierName', 'sku', 'qtyOrdered', 'qtyReceived', 'unitCostForeign'],
    sources: ['qoblex'],
    purpose: 'Purchase order lines with ordered and received quantity. Reduced to the OUTSTANDING quantity (the purchase-orders import file). The file carries NO currency and NO rate: an order\'s currency is the currency of its supplier in the same run\'s suppliers dataset, and a foreign order\'s rate is read from the ims-fx-rates list at the end of the `createdOn` day.',
  },
  transfers: {
    columns: ['transferKey', 'status', 'fromWarehouseCode', 'toWarehouseCode', 'sku', 'qtyShipped', 'qtyReceived', 'dispatchDate', 'notes'],
    required: ['transferKey', 'status', 'fromWarehouseCode', 'toWarehouseCode', 'sku', 'qtyShipped', 'qtyReceived'],
    sources: ['qoblex'],
    purpose: 'Stock transfers with shipped and received quantity. Only the in-transit remainder is emitted (the transfers import file).',
  },
  'wms-products': {
    columns: ['sku', 'wmsProductId'],
    required: ['sku'],
    sources: ['wms'],
    purpose: 'The 3PL (WMS) product list. Used only for the four-way SKU coverage check (R14).',
  },
  'wms-stock': {
    columns: ['sku', 'warehouseCode', 'qty'],
    required: ['sku', 'qty'],
    sources: ['wms'],
    purpose: 'The 3PL (WMS) stock levels. Used for R14 coverage and to find a SKU that holds stock there but is missing from the Qoblex stock extract.',
  },
  'woo-products': {
    columns: ['sku', 'wooProductId', 'type'],
    required: ['sku'],
    sources: ['woocommerce'],
    purpose: 'WooCommerce product export. Used only for the four-way SKU coverage check (R14). Never a source for recipes.',
  },
  'variant-parents': {
    columns: ['variantSku', 'wooVariationId', 'parentSku', 'parentName', 'parentStatus', 'wooParentId'],
    required: ['variantSku', 'parentSku', 'parentName', 'parentStatus'],
    sources: ['woocommerce'],
    purpose:
      'One row per WooCommerce variation: the variation SKU and the VARIABLE parent it belongs to. Written by the read-only WooCommerce snapshot command '
      + '(first-load:woo-snapshot). Qoblex variants are joined to it by EXACT variation SKU; each parent reached is emitted once as a VARIABLE product.',
  },
  'sku-exclusions': {
    columns: ['sku', 'reason'],
    required: ['sku', 'reason'],
    sources: [],
    purpose: 'The explicit, owner-accepted exclusion list: a SKU listed here is deliberately NOT loaded and is exempt from R14. Always canonical.',
  },
  'ims-suppliers': {
    columns: ['name'],
    required: ['name'],
    sources: [],
    purpose: 'Supplier names that already exist in the target IMS. Lets the tool reject a new supplier whose name collides with one of them under the importers\' matching, and check purchase order supplier names. Omit for an empty database. Always canonical.',
  },
  'ims-tax-rates': {
    columns: ['name', 'accountingTaxType', 'usedFor', 'active'],
    required: ['name'],
    sources: [],
    purpose: 'The tax rates that already exist in the target IMS (name, accounting tax type, usedFor, active). Lets the tool resolve each supplier\'s purchase tax type to exactly one active purchase-capable IMS rate at prepare time. Omit it and that resolution is NOT checked here (the apply-time rail supplier-tax-rates still refuses). Always canonical.',
  },
  'ims-fx-rates': {
    columns: ['currency', 'rate', 'fetchedAt', 'baseCurrency'],
    required: ['currency', 'rate', 'fetchedAt'],
    sources: [],
    purpose: 'The rows of IMS\'s fx_rates table (base to currency: 1 base = `rate` foreign; `fetchedAt` an ISO instant with a zone, e.g. 2026-10-20T06:00:00Z). The ONLY source of a foreign purchase order\'s rate: the transform applies the central lookup rule (the latest row at or before the end of the order\'s created day, UTC) over this list. Omit it and every foreign order is rejected (a rate is never taken from a file or defaulted). Written by `npm run first-load:export-fx-rates`, which stamps every row with `baseCurrency`; a row whose `baseCurrency` differs from the run\'s base currency is rejected (BASE_CURRENCY_MISMATCH). Always canonical.',
  },
  'ims-skus': {
    columns: ['sku', 'type'],
    required: ['sku'],
    sources: [],
    purpose: 'SKUs that already exist in the target IMS (from /api/export/products). The fourth side of R14. Omit for an empty database. Always canonical.',
  },
}

/**
 * THE PURCHASE TAX TYPES A SUPPLIER'S DEFAULT TAX RATE MAY BE RESOLVED FROM: Xero's built-in tax types (Xero is the tax-rate master; scripts/copy-tax-rates.ts
 * XERO_BUILT_IN_TAX_TYPES lists INPUT2, ZERORATEDINPUT and NONE among the types that mean the same thing in every organisation, unlike the per-organisation custom
 * TAX001..TAXnnn ids, which are refused here). INPUT2 is the purchase-side counterpart of OUTPUT2 ("20% (VAT on Income)", scripts/provision-xero-demo.ts); NONE is
 * the type the Xero connector already posts when a line carries no tax (lib/connectors/xero/bills.ts DEFAULT_TAX_TYPE). A CLOSED list: any other type rejects the row.
 */
export const SUPPLIER_PURCHASE_TAX_TYPES = ['INPUT2', 'ZERORATEDINPUT', 'NONE'] as const

/**
 * THE PINNED NATIVE VALUE MAP for Qoblex's "Purchase Tax Class Name" -> Xero tax type. tests/first-load/supplier-currency-tax.test.ts pins the
 * `valueMaps.purchaseTaxType` entry of tests/first-load/fixtures/qoblex-native/maps/qoblex-contacts.map.json to this object, so the map shipped to the operator cannot
 * drift from it. The map also carries `"": ""` so that a BLANK class reaches the transform, which refuses it (MISSING_PURCHASE_TAX_TYPE) instead of the ingest.
 */
export const QOBLEX_PURCHASE_TAX_CLASS_TYPES: Readonly<Record<string, (typeof SUPPLIER_PURCHASE_TAX_TYPES)[number]>> = {
  'Purchase Tax': 'INPUT2',
  'Zero Rated Purchase': 'ZERORATEDINPUT',
  'No VAT': 'NONE',
}

/** Datasets whose rows end up in an importer file. The others only feed checks. */
export const LOADING_DATASETS: ReadonlySet<DatasetName> = new Set([
  'products', 'recipe-lines', 'stock-lots', 'suppliers', 'purchase-order-lines', 'transfers', 'variant-parents',
])

/**
 * How a WooCommerce parent's post status becomes the IMS lifecycle status of the VARIABLE parent. A CLOSED list: a status that is not
 * here (`trash`, `future`, an unknown plugin status) rejects the parent's rows, it is never guessed. `private` and `pending` are not
 * published, so they load as DRAFT; the owner confirms this mapping before the real load (see docs/first-load-input-spec.md).
 */
export const VARIANT_PARENT_STATUS_LIFECYCLE: Readonly<Record<string, 'ACTIVE' | 'DRAFT'>> = {
  publish: 'ACTIVE',
  draft: 'DRAFT',
  pending: 'DRAFT',
  private: 'DRAFT',
}

// ---------------------------------------------------------------------------
// The read-only WooCommerce snapshot command: exit codes and file names (one table; the document repeats it)
// ---------------------------------------------------------------------------

export const SNAPSHOT_EXIT_CODES = {
  OK: 0,
  INCONSISTENT: 1,
  USAGE: 2,
  REFUSED: 3,
  FETCH_FAILED: 4,
  OUTPUT_FAILED: 5,
  INTERNAL: 6,
} as const

export type SnapshotExitCodeName = keyof typeof SNAPSHOT_EXIT_CODES

export const SNAPSHOT_EXIT_CODE_TABLE: ReadonlyArray<{ code: number; name: SnapshotExitCodeName; meaning: string }> = [
  { code: SNAPSHOT_EXIT_CODES.OK, name: 'OK', meaning: 'The snapshot is complete: every count matches the store\'s own totals. The snapshot, provenance and variant-parents files were written.' },
  {
    code: SNAPSHOT_EXIT_CODES.INCONSISTENT,
    name: 'INCONSISTENT',
    meaning:
      'The store answered, but what it returned cannot be trusted as a complete, consistent catalogue (a count does not match its total header, a parent is not variable or has no SKU, a variation SKU repeats, '
      + 'the store changed during the walk, a status the key cannot enumerate) or --verify found a damaged snapshot or derived files (provenance, variant-parents.csv, inspection copy) that do not match it, or recorded from a store other than the declared --expect-origin. No final file was written.',
  },
  { code: SNAPSHOT_EXIT_CODES.USAGE, name: 'USAGE', meaning: 'Bad command line. Nothing was read, requested or written.' },
  {
    code: SNAPSHOT_EXIT_CODES.REFUSED,
    name: 'REFUSED',
    meaning:
      'A precondition refused the run before any request left the machine: the store origin is not on the allowlist (and --allow-any-origin was not given), the credentials file is missing, unreadable, '
      + 'or readable by group or others, or it does not hold the three required values.',
  },
  {
    code: SNAPSHOT_EXIT_CODES.FETCH_FAILED,
    name: 'FETCH_FAILED',
    meaning: 'A request failed after its retries (network, HTTP error, unreadable response). What was read so far is kept in the output directory; run again with --resume to continue from it.',
  },
  { code: SNAPSHOT_EXIT_CODES.OUTPUT_FAILED, name: 'OUTPUT_FAILED', meaning: 'The output directory is unusable (it exists and is not empty, or a write failed). Files this run had created were removed again.' },
  { code: SNAPSHOT_EXIT_CODES.INTERNAL, name: 'INTERNAL', meaning: 'A self-check of this command failed. This is a defect in the tool, not in the store\'s data.' },
]

export const SNAPSHOT_FILE_NAMES = {
  snapshot: 'woo-snapshot.json',
  provenance: 'woo-snapshot.provenance.json',
  variantParents: 'variant-parents.csv',
  variantParentsInspection: 'variant-parents.inspect.csv',
  partial: 'woo-snapshot.partial.json',
} as const

export const IN_TRANSIT_CONVENTIONS = ['counted-in-source', 'excluded-from-source'] as const
export type InTransitConvention = (typeof IN_TRANSIT_CONVENTIONS)[number]

/** `STRANDED_TRANSFER_DAYS` in lib/domain/inventory/invariants.ts. */
export const STRANDED_TRANSFER_DAYS = 7

// ---------------------------------------------------------------------------
// Numeric limits mirrored from the importers' target columns (prisma/schema.prisma)
// ---------------------------------------------------------------------------

export const NUMERIC_LIMITS = {
  /** StockLevel.quantity / CostLayer Decimal(14,6): 8 integer digits, 6 decimals. */
  stockQty: { maxIntDigits: 8, maxDp: 6 },
  /** PurchaseOrderLine.qty, StockTransferLine.qty, ProductComponent.qty: Decimal(12,4). */
  lineQty: { maxIntDigits: 8, maxDp: 4 },
  /**
   * Unit costs reach the importers through `Number()`, a double: more than 15 significant digits would be rounded
   * by the importer, not by us. 9 integer digits + 6 decimals is exactly 15.
   */
  unitCost: { maxIntDigits: 9, maxDp: 6 },
  /** A lot's cost may carry more decimals; only the collapsed average is rounded (to 6 dp). */
  lotUnitCost: { maxIntDigits: 9, maxDp: 10 },
  /** PurchaseOrder.fxRateToBase is Decimal(18,8): a rate with more than 8 decimals would be stored rounded while the base values were computed from the unrounded one. */
  fx: { maxIntDigits: 6, maxDp: 8 },
  /** The tax rate as a fraction is stored in PurchaseOrder.taxRatePercent Decimal(5,4). */
  taxFraction: { maxDp: 4 },
  /** StockMovement.totalValueBase Decimal(18,6), written by opening stock (quantity x average cost): 12 integer digits. */
  stockValue: { maxIntDigits: 12 },
  /** PurchaseOrder subtotal/total and line totals Decimal(18,4): 14 integer digits, foreign and base. */
  orderValue: { maxIntDigits: 14 },
  /** PurchaseOrderLine.unitCostBase Decimal(18,6): 12 integer digits after the rate is applied. */
  unitCostBaseColumn: { maxIntDigits: 12 },
  /** Product.weight Decimal(10,4). */
  weight: { maxIntDigits: 6, maxDp: 4 },
  /** Product.widthCm / heightCm / depthCm Decimal(10,2). */
  dimension: { maxIntDigits: 8, maxDp: 2 },
  /** Product.salesPriceBase / salePriceBase Decimal(12,4). */
  price: { maxIntDigits: 8, maxDp: 4 },
} as const

export const AVERAGE_COST_DP = 6

// ---------------------------------------------------------------------------
// Importer rejection rules that need IMS itself
// ---------------------------------------------------------------------------

/**
 * Every rejection branch of the importers that depends on what is IN IMS, so a DB-free tool cannot prove it. The importers' CSV
 * dry-run preview skips parts of `createPurchaseOrder` and `createTransfer`, so a clean preview does not prove the PO and
 * transfer rules below either: the apply step (WP4b) must verify each one before any real import. Printed in every report and
 * documented in docs/first-load-input-spec.md; a test keeps the two equal.
 *
 * The rules the tool CAN prove (required fields, quantity and cost signs and scales, date shapes, lifecycle of products in the
 * catalogue file, order-group consistency, value ranges against every column written) are validators in transform.ts.
 */
export const APPLY_TIME_CHECKS: ReadonlyArray<{ id: string; area: string; check: string }> = [
  { id: 'warehouse-exists', area: 'opening-stock, transfers, purchase-orders', check: 'Every warehouse code in the files exists in IMS (the importers refuse an unknown code; the report lists the codes used).' },
  { id: 'base-currency', area: 'all', check: 'The manifest baseCurrency equals the organisation base currency in IMS (the importers compare against IMS, not the manifest).' },
  { id: 'opening-stock-empty', area: 'opening-stock', check: 'The product and warehouse have no stock, cost layer or movement yet (importOpeningStockCsv refuses otherwise; it is not repeatable).' },
  { id: 'po-supplier-exists', area: 'purchase-orders', check: 'Each supplier name exists in IMS (matched case-insensitively); the suppliers file creates them only when it is loaded first.' },
  { id: 'supplier-tax-rate', area: 'suppliers', check: 'Each supplier\'s purchaseTaxType (a Xero tax type) resolves to exactly one active IMS tax rate that is usable for purchases (usedFor PURCHASE or BOTH) and carries that accountingTaxType. Several matching rates refuse the run; with none, the apply step first imports the rate from the stored Xero tax-rate list and refuses only if that import is refused (see docs/first-load-apply.md); the supplier importer sets the supplier\'s default tax rate to it and refuses the row otherwise. The tool performs this only against an ims-tax-rates list you supply; WITHOUT it the report says the resolution was NOT checked.' },
  { id: 'po-fx-rate', area: 'purchase-orders', check: 'Every non-base order\'s fxRateToBase is a rate IMS\'s fx_rates holds for its currency (it was looked up there at prepare time), and the purchase-order importer, which compares it with the latest stored rate on or before the import date, accepts it (within 2%: createPurchaseOrder, PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE). The CSV dry-run does not run this.' },
  { id: 'po-tax-rate', area: 'purchase-orders', check: 'Each line\'s taxRateName (names are matched case-insensitively, trimmed) or, when only a taxRateValue is given, its value (matched within 0.00005) resolves to an active IMS purchase tax rate, and no rate IMS applies (named, or the supplier default) is above the manifest maxPurchaseTaxRate. A line never carries both: the tool cannot show a name and a value agree.' },
  { id: 'lookup-keys-unique-in-ims', area: 'all', check: 'In IMS no two suppliers (name), warehouses (code), products (SKU) or tax rates (name) collide under the importers\' case-insensitive matching: they build a Map and the last duplicate wins silently. The tool performs the supplier and SKU parts only against an ims-suppliers / ims-skus list you supply; WITHOUT that list the collision check against IMS is NOT performed and the report says so. Warehouse codes and tax names are never checked by the tool.' },
  { id: 'po-reference-free', area: 'purchase-orders', check: 'No existing purchase order already has a prefixed orderKey as its reference (an existing one is skipped, not updated).' },
  { id: 'po-product-lifecycle', area: 'purchase-orders', check: 'Products that exist in IMS but not in the products file are ACTIVE or DRAFT (the file\'s own products are checked here).' },
  { id: 'transfer-reference-free', area: 'transfers', check: 'No existing transfer already has a prefixed transferKey as its reference.' },
  { id: 'transfer-source-stock', area: 'transfers', check: 'The opening-stock file for the source warehouse has been loaded first, nothing is reserved against it, and its cost layers cover the dispatched quantity.' },
  { id: 'barcode-free', area: 'products', check: 'No barcode in the products file is already used by a product that exists in IMS.' },
  { id: 'product-parent-exists', area: 'products', check: 'A VARIANT\'s parent is in an earlier or the same file (proved here) or already in IMS.' },
]
