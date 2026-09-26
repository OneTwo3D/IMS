/**
 * THE LIVE MINTSOFT ASN / ASNItem WIRE SHAPE, AS RECORDED — the fixture every ASN quantity test
 * in this repo drives the real normalizer over (o3d-btiw).
 *
 * PROVENANCE, and what is fact versus what is constructed:
 *   · RECORDED FACT (read-only GETs on LIVE Mintsoft, ClientId 89, api.mintsoft.co.uk, 2026-09-18
 *     and 2026-09-24; written down on bd o3d-vcw8 and o3d-btiw): every KEY NAME below, the header
 *     shape (`POReference`, `GoodsInType`, a header `Quantity` that is a PACKAGE COUNT, `ASNStatus`
 *     as an OBJECT with `Name` and NO `ExternalName`, `ASNStatusId`, `Items`), and the ASNItem key
 *     set `{ ASNId, ProductId, QuantityExpected, QuantityReceieved (sic), QuantityBooked, OnOrder,
 *     SSCCNumber, Complete, Comments, SourceLineId, SKU, EAN, UPC, NAME, ID, … }`. Confirmed on
 *     3098 of 3098 items over 223 ASNs, on BOTH `GET /api/ASN/{id}` and
 *     `GET /api/ASN/List?IncludeASNItems=true`.
 *   · RECORDED FACT: on every ASN that could be read, `QuantityReceieved` and `QuantityBooked` were
 *     BOTH 0 — the tenant had no ASN in a booked-in state that IMS created, and a live book-in MOVES
 *     STOCK, so it was never authorised.
 *   · CONSTRUCTED, and labelled as such at each use: the NON-ZERO values of `QuantityReceieved` and
 *     `QuantityBooked`. Nothing in this repo has ever observed a live Mintsoft ASN item with a
 *     non-zero receipt quantity. The shape they arrive in is recorded; the numbers are ours.
 *
 * NO TEST IN THIS FILE'S ORBIT MAY CALL MINTSOFT. The whole point of recording the contract on bd is
 * that the wire shape is now a fixture, not a probe.
 */

/** The cuid-shaped `SourceLineId` that ASN 6117 accepted and returned VERBATIM (o3d-vcw8, 2026-09-24). */
export const LIVE_ASN_SOURCE_LINE_ID = 'cm1vcw8probel1ne0000zzt01'

export type LiveAsnItemOverrides = {
  id?: number
  sourceLineId?: string | null
  sku?: string
  productId?: number
  expected?: number
  /** `QuantityReceieved` — arrived at the warehouse. CONSTRUCTED when non-zero. */
  received?: number
  /** `QuantityBooked` — booked into the warehouse's stock. CONSTRUCTED when non-zero. */
  booked?: number
  onOrder?: number
  complete?: boolean
  /** Keys to DELETE from the item after it is built, for the shape-drift cases. */
  omit?: readonly string[]
  /** Keys to overwrite with an arbitrary value, for the unreadable-quantity cases. */
  poison?: Readonly<Record<string, unknown>>
}

/**
 * One live `ASNItem`. Verbatim key set from ASN 6114 item 0 and ASN 6117 item 0, which agree:
 * `{"ID":57449,"ASNId":6114,"ProductId":504073,"SKU":"93736554251","QuantityExpected":20,
 *   "QuantityReceieved":0,"QuantityBooked":0,"OnOrder":20,"SourceLineId":null,"Complete":false}`
 */
export function liveAsnItem(overrides: LiveAsnItemOverrides = {}): Record<string, unknown> {
  const item: Record<string, unknown> = {
    ID: overrides.id ?? 57449,
    ASNId: 6117,
    ProductId: overrides.productId ?? 263881,
    SKU: overrides.sku ?? '22771122402-02',
    QuantityExpected: overrides.expected ?? 12,
    QuantityReceieved: overrides.received ?? 0,
    QuantityBooked: overrides.booked ?? 0,
    OnOrder: overrides.onOrder ?? 0,
    SSCCNumber: null,
    Complete: overrides.complete ?? false,
    Comments: null,
    SourceLineId: overrides.sourceLineId === undefined ? LIVE_ASN_SOURCE_LINE_ID : overrides.sourceLineId,
    ASNItemNameValues: null,
    EAN: null,
    UPC: null,
    NAME: 'A discontinued product nobody would action',
    HasSerialNumber: false,
    HasExpiryDate: false,
    HasBatchNumber: false,
    ProductImageURL: null,
    ASNItemAllocations: null,
    LastUpdated: '2026-09-24T09:40:00',
    LastUpdatedByUser: 'api@onetwo3d.co.uk',
  }
  for (const key of overrides.omit ?? []) delete item[key]
  for (const [key, value] of Object.entries(overrides.poison ?? {})) item[key] = value
  return item
}

/**
 * The keys a live ASN item carries that hold a quantity. Exported so a test can assert it actually
 * examined them rather than asserting on a number that could have come from anywhere.
 */
export const LIVE_ASN_ITEM_QUANTITY_KEYS = ['QuantityExpected', 'QuantityReceieved', 'QuantityBooked', 'OnOrder'] as const

/**
 * The key names the OLD shared normalizer looked for (`RETURN_QTY_KEYS`). None of them appears on a
 * live ASN item — that is the whole of o3d-btiw — so a test can assert their ABSENCE universally.
 */
export const IMAGINED_ASN_ITEM_QUANTITY_KEYS = [
  'qty', 'Qty', 'quantity', 'Quantity', 'returnedQty', 'ReturnedQty', 'returnQty', 'ReturnQty', 'receivedQty', 'ReceivedQty',
] as const

export type LiveAsnBodyOverrides = {
  id?: number
  poReference?: string
  warehouseId?: number
  statusName?: string
  statusId?: number
  /** The header `Quantity`: a count of goods-in PACKAGES, never units. */
  packageCount?: number
  items?: readonly Record<string, unknown>[]
}

/**
 * A live `GET /api/ASN/{id}` body. Header fields verbatim from ASN 6114 and 6117; `ASNStatus` is an
 * OBJECT and there is NO `CallbackUrl`, `AutoCallback`, `Reference`, `Status` or `Lines` anywhere in
 * Mintsoft's ASN model.
 */
export function liveAsnBody(overrides: LiveAsnBodyOverrides = {}): Record<string, unknown> {
  return {
    CLIENTSHORTNAME: 'ONETWO3D',
    POReference: overrides.poReference ?? 'PO-LIVE-1',
    Supplier: null,
    ProductSupplierId: null,
    ProductSupplier: null,
    EstimatedDelivery: '2026-10-01T00:00:00',
    EstimatedTimeToDock: null,
    WarehouseBookedDate: null,
    BookedInDate: null,
    Comments: null,
    SupplierNotes: null,
    GoodsInType: 'Carton',
    // NOT a unit total: equal to sum(Items.QuantityExpected) on only 3 of the tenant's 223 ASNs.
    Quantity: overrides.packageCount ?? 1,
    ASNStatus: {
      Name: overrides.statusName ?? 'BOOKEDIN',
      Colour: 'green',
      TextColour: null,
      ID: overrides.statusId ?? 4,
      LastUpdated: '2022-10-08T12:13:13.7061351',
      LastUpdatedByUser: 'ben@fulfillable.co.uk',
    },
    ASNStatusId: overrides.statusId ?? 4,
    Shipped: false,
    HoursLogged: null,
    Items: overrides.items ?? [liveAsnItem()],
    WarehouseId: overrides.warehouseId ?? 6,
    ClientId: 89,
    ID: overrides.id ?? 6117,
    LastUpdated: '2026-09-24T09:40:00',
    LastUpdatedByUser: 'api@onetwo3d.co.uk',
  }
}
