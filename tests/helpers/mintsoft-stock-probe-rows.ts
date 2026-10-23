/**
 * Rows copied VERBATIM from a live GET-only probe of Mintsoft `GET /api/Product/StockLevels?WarehouseId=6`
 * (MIL1, 2026-10-23, 2386 rows). `Level` = AVAILABLE, `TotalStockLevel` = physical ON HAND
 * (owner-confirmed in the Mintsoft UI). Four of these five differ, which is the point.
 */
export const PROBE_ROWS = [
  { ProductId: 264511, WarehouseId: 6, ClientId: 89, SKU: '129552751', Level: 28, TotalStockLevel: 36, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null },
  { ProductId: 500944, WarehouseId: 6, ClientId: 89, SKU: '41352158742', Level: 199, TotalStockLevel: 200, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null },
  { ProductId: 502742, WarehouseId: 6, ClientId: 89, SKU: '54524161462-01', Level: 1, TotalStockLevel: 3, PreOrderable: false, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null },
  { ProductId: 263881, WarehouseId: 6, ClientId: 89, SKU: '22771122402-02', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null },
  { ProductId: 282395, WarehouseId: 6, ClientId: 89, SKU: '75641124454', Level: 8, TotalStockLevel: 16, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null },
] as const
