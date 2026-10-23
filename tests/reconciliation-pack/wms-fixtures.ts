import type { ImsRead, ImsReadOptions, ProductRow, StockPair, WmsBindingRow, WmsProductLinkRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import type { WmsPortResult, WmsProductRow, WmsReadPort, WmsStockRow } from '../../lib/reconciliation-pack/wms-source.ts'

/**
 * ROWS COPIED VERBATIM from the live GET-only probe of Mintsoft `GET /api/Product/StockLevels` (2026-10-23, ClientId 89): warehouse 5
 * (EAR2) and warehouse 6 (MIL1), 2386 rows each, of which this file keeps a handful. `Level` is AVAILABLE and `TotalStockLevel` is
 * physical ON HAND (owner decision U1). Rows 129552751 (Level 28, Total 36) and 41352158742 (199 / 200) differ on purpose; the two
 * `6878843248-2x` rows are bundles whose derived stock is non-zero at MIL1 (5) and zero at EAR2.
 */
export type RawStockRow = { ProductId: number; WarehouseId: number; ClientId: number; SKU: string; Level: number; TotalStockLevel: number; PreOrderable: boolean; Bundle: boolean; LowStockLevel: number; LastUpdated: null; Breakdown: null }

export const PROBE_WH5: RawStockRow[] = [
  {ProductId: 264511, WarehouseId: 5, ClientId: 89, SKU: '129552751', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 500944, WarehouseId: 5, ClientId: 89, SKU: '41352158742', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 502742, WarehouseId: 5, ClientId: 89, SKU: '54524161462-01', Level: 0, TotalStockLevel: 0, PreOrderable: false, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 263881, WarehouseId: 5, ClientId: 89, SKU: '22771122402-02', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 282395, WarehouseId: 5, ClientId: 89, SKU: '75641124454', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 263888, WarehouseId: 5, ClientId: 89, SKU: '47696122460', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 263891, WarehouseId: 5, ClientId: 89, SKU: '61889122383', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 263894, WarehouseId: 5, ClientId: 89, SKU: '74928122361-04', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 263882, WarehouseId: 5, ClientId: 89, SKU: '22771122402-01', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 264947, WarehouseId: 5, ClientId: 89, SKU: '613785393-06', Level: 0, TotalStockLevel: 1, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 264466, WarehouseId: 5, ClientId: 89, SKU: '6878843248-24', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: true, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 264467, WarehouseId: 5, ClientId: 89, SKU: '6878843248-23', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: true, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
]

export const PROBE_WH6: RawStockRow[] = [
  {ProductId: 264511, WarehouseId: 6, ClientId: 89, SKU: '129552751', Level: 28, TotalStockLevel: 36, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 500944, WarehouseId: 6, ClientId: 89, SKU: '41352158742', Level: 199, TotalStockLevel: 200, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 502742, WarehouseId: 6, ClientId: 89, SKU: '54524161462-01', Level: 1, TotalStockLevel: 3, PreOrderable: false, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 263881, WarehouseId: 6, ClientId: 89, SKU: '22771122402-02', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 282395, WarehouseId: 6, ClientId: 89, SKU: '75641124454', Level: 8, TotalStockLevel: 16, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 263888, WarehouseId: 6, ClientId: 89, SKU: '47696122460', Level: 3, TotalStockLevel: 3, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 263891, WarehouseId: 6, ClientId: 89, SKU: '61889122383', Level: 7, TotalStockLevel: 7, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 263894, WarehouseId: 6, ClientId: 89, SKU: '74928122361-04', Level: 3, TotalStockLevel: 3, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 263882, WarehouseId: 6, ClientId: 89, SKU: '22771122402-01', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 264947, WarehouseId: 6, ClientId: 89, SKU: '613785393-06', Level: 0, TotalStockLevel: 0, PreOrderable: true, Bundle: false, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 264466, WarehouseId: 6, ClientId: 89, SKU: '6878843248-24', Level: 5, TotalStockLevel: 5, PreOrderable: true, Bundle: true, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
  {ProductId: 264467, WarehouseId: 6, ClientId: 89, SKU: '6878843248-23', Level: 5, TotalStockLevel: 5, PreOrderable: true, Bundle: true, LowStockLevel: 1, LastUpdated: null, Breakdown: null},
]


export const noSleep = async (): Promise<void> => undefined
export const toStockRow = (r: RawStockRow): WmsStockRow => ({ sku: r.SKU, productId: String(r.ProductId), onHand: r.TotalStockLevel, bundle: r.Bundle })

export type WmsCall = { kind: 'stock'; warehouse: string } | { kind: 'page'; pageNo: number; limit: number }
/** Lets a test alter one response (call number counts from 1). Return undefined to keep it. */
export type WmsTweak = (call: WmsCall, n: number) => WmsPortResult<WmsStockRow[]> | WmsPortResult<WmsProductRow[]> | undefined
export type FakeWmsData = { stock: Record<string, WmsStockRow[]>; census?: WmsProductRow[] }

/** A faithful warehouse system: the whole stock list per warehouse, and the product list in pages of the limit asked for. */
export function fakeWms(data: FakeWmsData, tweak?: WmsTweak): WmsReadPort & { calls: WmsCall[] } {
  const calls: WmsCall[] = []
  const census = data.census ?? [...new Map(Object.values(data.stock).flat().map((r) => [r.productId, { id: r.productId, sku: r.sku, bundle: r.bundle }] as const)).values()]
  const sorted = [...census].sort((a, b) => Number(a.id) - Number(b.id))
  return {
    calls,
    async stockLevels(warehouse) {
      calls.push({ kind: 'stock', warehouse })
      const rows = (data.stock[warehouse] ?? []).map((r) => ({ ...r }))
      return (tweak?.(calls.at(-1)!, calls.length) as WmsPortResult<WmsStockRow[]> | undefined) ?? { ok: true, value: rows }
    },
    async productPage(pageNo, limit) {
      calls.push({ kind: 'page', pageNo, limit })
      const rows = sorted.slice((pageNo - 1) * limit, pageNo * limit).map((r) => ({ ...r }))
      return (tweak?.(calls.at(-1)!, calls.length) as WmsPortResult<WmsProductRow[]> | undefined) ?? { ok: true, value: rows }
    },
  }
}

export const cuid = (n: number) => `c${String(n).padStart(24, '0')}`
export const binding = (over: Partial<WmsBindingRow> = {}): WmsBindingRow => ({ connector: 'mintsoft', warehouseId: cuid(5), warehouseCode: 'EAR2', externalWarehouseId: '5', active: true, stockSyncMode: 'NOTIFICATION_ONLY', alignmentConfirmed: false, ...over })
export const binding6 = (over: Partial<WmsBindingRow> = {}): WmsBindingRow => binding({ warehouseId: cuid(6), warehouseCode: 'MIL1', externalWarehouseId: '6', ...over })

export type Estate = {
  bindings: WmsBindingRow[]
  /** What the second read of the bindings answers (default: the same). */
  bindingsAfter?: WmsBindingRow[]
  products: ProductRow[]
  links: WmsProductLinkRow[]
  stock: StockPair[]
  fail?: 'throws' | 'read' | Partial<Record<'wmsBindings' | 'wmsProductLinks' | 'products' | 'stock', 'READ_INCOMPLETE' | 'CAP_EXCEEDED' | 'SOURCE_UNREADABLE'>>
}

export const product = (n: number, sku: string, type = 'SIMPLE'): ProductRow => ({ id: cuid(1000 + n), sku, type, active: true, lifecycleStatus: 'ACTIVE' })
export const link = (p: ProductRow, externalProductId: string, connector = 'mintsoft'): WmsProductLinkRow => ({ connector, productId: p.id, externalProductId })
export const pair = (p: ProductRow, b: WmsBindingRow, quantity: string): StockPair => ({ stockLevelId: cuid(5000 + Number(p.id.slice(-4)) + Number(b.externalWarehouseId)), productId: p.id, sku: p.sku, productType: p.type, warehouseId: b.warehouseId, warehouseCode: b.warehouseCode, quantity, reservedQty: '0' })

/** The standard estate: the probe's non-bundle rows as IMS products, each linked to the id Mintsoft gave it, with IMS holding exactly Mintsoft's on-hand figure in each bound warehouse. */
export function equalEstate(bindings: WmsBindingRow[] = [binding(), binding6()]): { estate: Estate; wms: FakeWmsData } {
  const rows: Record<string, RawStockRow[]> = { '5': PROBE_WH5, '6': PROBE_WH6 }
  const plain = PROBE_WH6.filter((r) => !r.Bundle)
  const products = plain.map((r, index) => product(index + 1, r.SKU))
  const links = products.map((p, index) => link(p, String(plain[index]!.ProductId)))
  const stock: StockPair[] = []
  for (const b of bindings) {
    for (const [index, p] of products.entries()) {
      const row = rows[b.externalWarehouseId]!.find((r) => r.SKU === plain[index]!.SKU)!
      stock.push(pair(p, b, String(row.TotalStockLevel)))
    }
  }
  return {
    estate: { bindings, products, links, stock },
    wms: { stock: Object.fromEntries(Object.entries(rows).map(([id, list]) => [id, list.map(toStockRow)])) },
  }
}

export function imsFor(estate: Estate): { calls: ImsReadOptions[]; ims: (options: ImsReadOptions) => Promise<ImsRead> } {
  const calls: ImsReadOptions[] = []
  return {
    calls,
    ims: async (options) => {
      calls.push(options)
      if (estate.fail === 'throws') throw new Error('boom')
      if (estate.fail === 'read') return { ok: false, reason: 'READ_INCOMPLETE' }
      const second = calls.length > 1
      const values: Record<string, unknown> = {
        wmsBindings: second ? (estate.bindingsAfter ?? estate.bindings) : estate.bindings,
        wmsProductLinks: estate.links,
        products: estate.products,
        stock: { tracked: estate.stock, untracked: [] },
      }
      const sections: Record<string, unknown> = {}
      for (const name of options.sections) {
        const failure = typeof estate.fail === 'object' ? estate.fail[name as keyof typeof estate.fail] : undefined
        sections[name] = failure ? { ok: false, reason: failure } : { ok: true, value: values[name] }
      }
      return { ok: true, snapshotId: '1:2:', sections } as ImsRead
    },
  }
}

/**
 * ROWS COPIED VERBATIM from the live GET-only probe of `GET /api/Product/List` (2026-10-23, ClientId 89, 2386 rows, one per product, each also a
 * StockLevels row; 98 are bundles and 509 are DisCont). 22771122402-02 is discontinued; 6878843248-24 is a bundle.
 */
export const PROBE_PRODUCT_LIST_ROWS: Array<Record<string, unknown>> = [
 {
  "SKU": "22771122402-02",
  "Name": "LDO Micron Plus Partial Kit (Space Grey)",
  "PalletSizes": null,
  "PackingInstructions": null,
  "Description": null,
  "CustomsDescription": "mechanical 3D-printer component set",
  "MIDCode": null,
  "ManufacturerProductId": null,
  "CountryOfManufactureId": 468,
  "CountryOfManufacture": {
   "Name": "CHINA",
   "Code": "CN",
   "Code3": null,
   "ID": 468,
   "LastUpdated": "2022-08-06T18:42:03.763",
   "LastUpdatedByUser": "ben@fulfillable.co.uk"
  },
  "EAN": "6975415151149",
  "UPC": null,
  "LowStockAlertLevel": 1,
  "Weight": 4.0,
  "Height": null,
  "Width": null,
  "Depth": null,
  "Volume": null,
  "BackOrder": true,
  "Bundle": false,
  "DisCont": true,
  "Price": 395.83,
  "CostPrice": 0.0,
  "VatExempt": false,
  "AdditionalParcelsRequired": 0,
  "UnitsPerParcel": 0.0,
  "HasBatchNumber": false,
  "LogBatchInbound": null,
  "LogBatchOutbound": null,
  "HasSerialNumber": false,
  "LogSerialInbound": null,
  "LogSerialOutbound": null,
  "HasExpiryDate": false,
  "LogExpiryDateInbound": null,
  "LogExpiryDateOutbound": null,
  "BestBeforeDateWarningPeriodDays": 28,
  "CommodityCode": {
   "Code": "84859090",
   "ID": 1078,
   "LastUpdated": "2026-05-19T15:19:10.0210394",
   "LastUpdatedByUser": "SYSTEM"
  },
  "HandlingTime": 1,
  "ToteCapacity": null,
  "UnNumber": null,
  "ImageURL": "https://www.onetwo3d.co.uk/wp-content/uploads/2023/09/MicronFrontRight-2_1100x.webp",
  "SyncStockFrom": null,
  "ProductHazardousGoods": null,
  "ProductPurchasingSettings": null,
  "ProductGrowthRates": null,
  "OrderItems": null,
  "Subscription": false,
  "SubscriptionLength": 1,
  "SubscriptionFrequency": null,
  "ProductInCategories": [],
  "ProductPrices": [],
  "ProductSuppliers": [],
  "ProductCustomFields": [],
  "ClientId": 89,
  "ID": 263881,
  "LastUpdated": "2026-08-29T15:28:59.233",
  "LastUpdatedByUser": "jan.schwarz@onetwo3d.co.uk"
 },
 {
  "SKU": "129552751",
  "Name": "GDStime GDB5015 24VDC blower (dual ball bearing)",
  "PalletSizes": null,
  "PackingInstructions": null,
  "Description": "GDStime 5015 24VDC fan (dual ball bearing) for VzBot, Voron Afterburner, Stealthburner, etc.",
  "CustomsDescription": "centrifugal blower fan, 24 V DC, 5015",
  "MIDCode": null,
  "ManufacturerProductId": null,
  "CountryOfManufactureId": 468,
  "CountryOfManufacture": {
   "Name": "CHINA",
   "Code": "CN",
   "Code3": null,
   "ID": 468,
   "LastUpdated": "2022-08-06T18:42:03.763",
   "LastUpdatedByUser": "ben@fulfillable.co.uk"
  },
  "EAN": null,
  "UPC": null,
  "LowStockAlertLevel": 1,
  "Weight": 0.02,
  "Height": 2.0,
  "Width": 5.0,
  "Depth": 5.0,
  "Volume": null,
  "BackOrder": true,
  "Bundle": false,
  "DisCont": false,
  "Price": 5.79,
  "CostPrice": 0.0,
  "VatExempt": false,
  "AdditionalParcelsRequired": 0,
  "UnitsPerParcel": 0.0,
  "HasBatchNumber": false,
  "LogBatchInbound": null,
  "LogBatchOutbound": null,
  "HasSerialNumber": false,
  "LogSerialInbound": null,
  "LogSerialOutbound": null,
  "HasExpiryDate": false,
  "LogExpiryDateInbound": null,
  "LogExpiryDateOutbound": null,
  "BestBeforeDateWarningPeriodDays": 28,
  "CommodityCode": {
   "Code": "84145935",
   "ID": 1083,
   "LastUpdated": "2026-05-19T15:19:17.9149109",
   "LastUpdatedByUser": "SYSTEM"
  },
  "HandlingTime": 1,
  "ToteCapacity": null,
  "UnNumber": null,
  "ImageURL": "https://www.onetwo3d.co.uk/wp-content/uploads/2022/04/5-Pcs-Gdstime-DC-5V-12V-24V-5015-50mm-5cm-50mm-x-15mm-Two-Ball-Bearing.jpg_Q90.jpg_.webp",
  "SyncStockFrom": null,
  "ProductHazardousGoods": null,
  "ProductPurchasingSettings": null,
  "ProductGrowthRates": null,
  "OrderItems": null,
  "Subscription": false,
  "SubscriptionLength": 1,
  "SubscriptionFrequency": null,
  "ProductInCategories": [],
  "ProductPrices": [],
  "ProductSuppliers": [],
  "ProductCustomFields": [],
  "ClientId": 89,
  "ID": 264511,
  "LastUpdated": "2026-10-22T23:20:15.177",
  "LastUpdatedByUser": "info@onetwo3d.co.uk-API"
 },
 {
  "SKU": "6878843248-24",
  "Name": "LDO Voron Trident Kit (Rev. D) (300x300mm, Space Grey, Raspberry Pi Not Included)",
  "PalletSizes": null,
  "PackingInstructions": "Ship in existing packaging",
  "Description": null,
  "CustomsDescription": "parts for 3D printer",
  "MIDCode": null,
  "ManufacturerProductId": null,
  "CountryOfManufactureId": 468,
  "CountryOfManufacture": {
   "Name": "CHINA",
   "Code": "CN",
   "Code3": null,
   "ID": 468,
   "LastUpdated": "2022-08-06T18:42:03.763",
   "LastUpdatedByUser": "ben@fulfillable.co.uk"
  },
  "EAN": null,
  "UPC": null,
  "LowStockAlertLevel": 1,
  "Weight": 28.1,
  "Height": 30.0,
  "Width": 61.0,
  "Depth": 57.0,
  "Volume": null,
  "BackOrder": true,
  "Bundle": true,
  "DisCont": false,
  "Price": 1125.0,
  "CostPrice": 0.0,
  "VatExempt": false,
  "AdditionalParcelsRequired": 0,
  "UnitsPerParcel": 0.0,
  "HasBatchNumber": false,
  "LogBatchInbound": null,
  "LogBatchOutbound": null,
  "HasSerialNumber": false,
  "LogSerialInbound": null,
  "LogSerialOutbound": null,
  "HasExpiryDate": false,
  "LogExpiryDateInbound": null,
  "LogExpiryDateOutbound": null,
  "BestBeforeDateWarningPeriodDays": 28,
  "CommodityCode": {
   "Code": "84852000",
   "ID": 857,
   "LastUpdated": "2025-08-29T11:37:29.8776261",
   "LastUpdatedByUser": "SYSTEM"
  },
  "HandlingTime": 1,
  "ToteCapacity": null,
  "UnNumber": null,
  "ImageURL": "https://www.onetwo3d.co.uk/wp-content/uploads/2022/07/Mlkm5M5q.jpeg",
  "SyncStockFrom": null,
  "ProductHazardousGoods": null,
  "ProductPurchasingSettings": null,
  "ProductGrowthRates": null,
  "OrderItems": null,
  "Subscription": false,
  "SubscriptionLength": 1,
  "SubscriptionFrequency": null,
  "ProductInCategories": [
   {
    "ProductId": 264466,
    "ProductCategoryId": 8,
    "ProductCategory": {
     "Name": "3D Printer Kit",
     "ClientId": 89,
     "ID": 8,
     "LastUpdated": "2023-09-26T23:32:44.7412683",
     "LastUpdatedByUser": "jan.schwarz@onetwo3d.co.uk"
    },
    "ID": 352,
    "LastUpdated": "2023-09-29T08:30:03.1637256",
    "LastUpdatedByUser": "jan.schwarz@onetwo3d.co.uk"
   }
  ],
  "ProductPrices": [],
  "ProductSuppliers": [
   {
    "ProductId": 264466,
    "ProductSupplierId": 157,
    "ProductSupplier": {
     "Name": "LDO",
     "ContactName": "Lyron Gu",
     "ContactNumber": null,
     "AddressLine1": null,
     "AddressLine2": null,
     "AddressLine3": null,
     "Town": null,
     "County": null,
     "Postcode": null,
     "CountryId": 468,
     "Country": {
      "Name": "CHINA",
      "Code": "CN",
      "Code3": null,
      "ID": 468,
      "LastUpdated": "2022-08-06T18:42:03.763",
      "LastUpdatedByUser": "ben@fulfillable.co.uk"
     },
     "ContactEmail": null,
     "Active": true,
     "Code": "LDO",
     "CurrencyId": 2,
     "Currency": {
      "Name": "United States Dollar",
      "Code": "USD",
      "Symbol": "$",
      "ID": 2,
      "LastUpdated": "2016-05-11T22:18:39.113",
      "LastUpdatedByUser": "SYSTEM"
     },
     "ClientId": 89,
     "ID": 157,
     "LastUpdated": "2023-09-13T22:45:04.9952316",
     "LastUpdatedByUser": "jan.schwarz@onetwo3d.co.uk"
    },
    "ID": 1266,
    "LastUpdated": "2023-09-29T08:30:03.1793739",
    "LastUpdatedByUser": "jan.schwarz@onetwo3d.co.uk"
   }
  ],
  "ProductCustomFields": [],
  "ClientId": 89,
  "ID": 264466,
  "LastUpdated": "2026-10-14T12:01:07.173",
  "LastUpdatedByUser": "info@onetwo3d.co.uk-API"
 },
 {
  "SKU": "75641124454",
  "Name": "GDSTIME GDB4010 24V Blower",
  "PalletSizes": null,
  "PackingInstructions": null,
  "Description": "Centrifugal Blower Fan GDB4010 with Dual Ball Bearing and 9500rpm",
  "CustomsDescription": "centrifugal blower fan, 24V 40mm",
  "MIDCode": null,
  "ManufacturerProductId": null,
  "CountryOfManufactureId": 468,
  "CountryOfManufacture": {
   "Name": "CHINA",
   "Code": "CN",
   "Code3": null,
   "ID": 468,
   "LastUpdated": "2022-08-06T18:42:03.763",
   "LastUpdatedByUser": "ben@fulfillable.co.uk"
  },
  "EAN": null,
  "UPC": null,
  "LowStockAlertLevel": 1,
  "Weight": 0.01,
  "Height": 2.0,
  "Width": 5.0,
  "Depth": 5.0,
  "Volume": null,
  "BackOrder": true,
  "Bundle": false,
  "DisCont": false,
  "Price": 3.29,
  "CostPrice": 0.0,
  "VatExempt": false,
  "AdditionalParcelsRequired": 0,
  "UnitsPerParcel": 0.0,
  "HasBatchNumber": false,
  "LogBatchInbound": null,
  "LogBatchOutbound": null,
  "HasSerialNumber": false,
  "LogSerialInbound": null,
  "LogSerialOutbound": null,
  "HasExpiryDate": false,
  "LogExpiryDateInbound": null,
  "LogExpiryDateOutbound": null,
  "BestBeforeDateWarningPeriodDays": 28,
  "CommodityCode": {
   "Code": "84145935",
   "ID": 1083,
   "LastUpdated": "2026-05-19T15:19:17.9149109",
   "LastUpdatedByUser": "SYSTEM"
  },
  "HandlingTime": 1,
  "ToteCapacity": null,
  "UnNumber": null,
  "ImageURL": "https://www.onetwo3d.co.uk/wp-content/uploads/2023/11/s-l1600.jpg",
  "SyncStockFrom": null,
  "ProductHazardousGoods": null,
  "ProductPurchasingSettings": null,
  "ProductGrowthRates": null,
  "OrderItems": null,
  "Subscription": false,
  "SubscriptionLength": 1,
  "SubscriptionFrequency": null,
  "ProductInCategories": [],
  "ProductPrices": [],
  "ProductSuppliers": [],
  "ProductCustomFields": [],
  "ClientId": 89,
  "ID": 282395,
  "LastUpdated": "2026-10-22T23:20:09.97",
  "LastUpdatedByUser": "info@onetwo3d.co.uk-API"
 }
]
