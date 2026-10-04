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
  'addressLine1', 'addressLine2', 'city', 'county', 'postcode', 'country', 'notes',
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

export const SOURCES = ['qoblex', 'mintsoft', 'woocommerce'] as const
export type SourceName = (typeof SOURCES)[number]

export const DATASET_NAMES = [
  'products',
  'recipe-lines',
  'stock-lots',
  'suppliers',
  'purchase-order-lines',
  'transfers',
  'mintsoft-products',
  'mintsoft-stock',
  'woo-products',
  'sku-exclusions',
  'ims-skus',
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
      'addressLine1', 'addressLine2', 'city', 'county', 'postcode', 'country', 'notes',
    ],
    required: ['name'],
    sources: ['qoblex'],
    purpose: 'Suppliers. Becomes the suppliers import file.',
  },
  'purchase-order-lines': {
    columns: [
      'orderKey', 'supplierName', 'status', 'currency', 'fxRateToBase', 'destinationWarehouseCode', 'sku', 'qtyOrdered', 'qtyReceived',
      'unitCostForeign', 'taxRateName', 'taxRateValue', 'pricesIncludeVat', 'supplierRef', 'expectedDelivery', 'notes',
    ],
    required: ['orderKey', 'supplierName', 'sku', 'qtyOrdered', 'qtyReceived', 'unitCostForeign', 'currency'],
    sources: ['qoblex'],
    purpose: 'Purchase order lines with ordered and received quantity. Reduced to the OUTSTANDING quantity (the purchase-orders import file).',
  },
  transfers: {
    columns: ['transferKey', 'status', 'fromWarehouseCode', 'toWarehouseCode', 'sku', 'qtyShipped', 'qtyReceived', 'dispatchDate', 'notes'],
    required: ['transferKey', 'status', 'fromWarehouseCode', 'toWarehouseCode', 'sku', 'qtyShipped', 'qtyReceived'],
    sources: ['qoblex'],
    purpose: 'Stock transfers with shipped and received quantity. Only the in-transit remainder is emitted (the transfers import file).',
  },
  'mintsoft-products': {
    columns: ['sku', 'mintsoftProductId'],
    required: ['sku'],
    sources: ['mintsoft'],
    purpose: 'Mintsoft product list. Used only for the four-way SKU coverage check (R14).',
  },
  'mintsoft-stock': {
    columns: ['sku', 'warehouseCode', 'qty'],
    required: ['sku', 'qty'],
    sources: ['mintsoft'],
    purpose: 'Mintsoft stock levels. Used for R14 coverage and to find a SKU that holds stock in Mintsoft but is missing from the Qoblex stock extract.',
  },
  'woo-products': {
    columns: ['sku', 'wooProductId', 'type'],
    required: ['sku'],
    sources: ['woocommerce'],
    purpose: 'WooCommerce product export. Used only for the four-way SKU coverage check (R14). Never a source for recipes.',
  },
  'sku-exclusions': {
    columns: ['sku', 'reason'],
    required: ['sku', 'reason'],
    sources: [],
    purpose: 'The explicit, owner-accepted exclusion list: a SKU listed here is deliberately NOT loaded and is exempt from R14. Always canonical.',
  },
  'ims-skus': {
    columns: ['sku', 'type'],
    required: ['sku'],
    sources: [],
    purpose: 'SKUs that already exist in the target IMS (from /api/export/products). The fourth side of R14. Omit for an empty database. Always canonical.',
  },
}

/** Datasets whose rows end up in an importer file. The others only feed checks. */
export const LOADING_DATASETS: ReadonlySet<DatasetName> = new Set([
  'products', 'recipe-lines', 'stock-lots', 'suppliers', 'purchase-order-lines', 'transfers',
])

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
  fx: { maxIntDigits: 6, maxDp: 10 },
  dimension: { maxIntDigits: 9, maxDp: 6 },
} as const

export const AVERAGE_COST_DP = 6
