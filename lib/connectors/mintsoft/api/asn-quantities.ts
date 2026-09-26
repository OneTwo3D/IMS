import type { WmsAsnLineReceipt } from '@/lib/connectors/wms/types'

/**
 * WHAT A MINTSOFT ASN ITEM'S QUANTITIES MEAN FOR IMS — stated ONCE, here, and the only place that
 * answers it. o3d-btiw.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The shared ASN line normalizer read a single `quantity` through
 * `RETURN_QTY_KEYS` — `qty`, `Qty`, `quantity`, `Quantity`, `returnedQty`, `receivedQty`, … — and a
 * live Mintsoft `ASNItem` carries NONE of them. Its quantities are `QuantityExpected`,
 * `QuantityReceieved` (Mintsoft's own misspelling), `QuantityBooked` and `OnOrder`. Confirmed on
 * 3098 of 3098 items across 223 ASNs, on both `GET /api/ASN/{id}` and
 * `GET /api/ASN/List?IncludeASNItems=true` (read-only GETs, ClientId 89, 2026-09-18 and 2026-09-24;
 * recorded on bd o3d-vcw8 and o3d-btiw). So every live line normalized to `quantity: null`, the
 * booked-in processor read `Math.max(0, Number(null ?? 0))` = 0 received for every line, applied
 * nothing, and reported itself PROCESSED. With the o3d-bhvu round-8 recovery enqueueing a booked-in
 * recheck for an ASN Mintsoft had already booked in, that pair produced a confident reconciliation
 * success with no stock movement at all.
 *
 * ── THE DECISION: IMS'S BOOKED-IN QUANTITY IS `QuantityBooked`, NOT `QuantityReceieved` ──────────
 *
 * They are DIFFERENT FACTS about a delivery:
 *   · `QuantityReceieved` — units the warehouse says physically ARRIVED and were counted at goods-in.
 *   · `QuantityBooked`    — units the warehouse has BOOKED INTO ITS OWN STOCK RECORD. Mintsoft's ASN
 *     statuses separate the two explicitly: 9 DELIVERED is at the dock, 4 BOOKEDIN / 7
 *     PARTIALLYBOOKED / 8 BOOKEDIN-PARTIAL are booked, 12 AWAITINGPUTAWAY and 13 ROBOTPUTAWAY follow
 *     booking in. Those are the ids and names `GET /api/ASN/Statuses` served live on 2026-09-24
 *     (13 statuses, recorded on bd o3d-vcw8); o3d-bhvu round 8 puts the same table in code, in
 *     `lib/connectors/mintsoft/api/asn-status.ts`, which is not on this branch yet.
 *
 * IMS's booked-in path is not a note that goods arrived. It increments `stock_levels.quantity`, lays
 * FIFO `cost_layers`, moves `purchase_order_lines.qtyReceived`, and hands the product to the
 * storefront stock sync. That is a STOCK figure, and IMS's stock at a WMS warehouse is also
 * reconciled, independently and continuously, by the WMS stock-sync alignment against the quantity
 * MINTSOFT HOLDS IN STOCK. Mintsoft's stock only moves when an ASN is booked in.
 *
 * So the decisive argument is agreement between the two paths that write the same stock row:
 *   · Read `QuantityBooked`, and IMS's stock rises exactly when Mintsoft's does. The alignment finds
 *     no divergence and has nothing to correct.
 *   · Read `QuantityReceieved`, and IMS credits stock at the dock while Mintsoft still holds less. An
 *     `ALIGN_TO_WMS` binding then sees IMS higher than the warehouse and aligns DOWN — removing the
 *     units the receipt just booked, after the cost layers for them are already down. Two writers of
 *     one stock row, disagreeing about which event moves it, is a fight IMS loses quietly.
 *
 * WHAT IT COSTS, AND WHY THAT COST IS THE SAFE ONE. If a Mintsoft flow ever populates
 * `QuantityReceieved` and leaves `QuantityBooked` at zero, IMS under-books rather than over-books.
 * That failure is VISIBLE: the ASN stays OPEN/PARTIALLY_BOOKED_IN, the overdue-ASN watchdog alerts on
 * it, and `arrivedAtWarehouseQty` below carries the arrived count into the dry run, the receipt-review
 * details and the processed-event activity log, so the gap is a number an operator can read rather
 * than a quantity this module threw away. Reading the larger of the two — or falling back from one to
 * the other — would invent stock from a dock count, which is the opposite trade.
 *
 * AND IT MUST NOT BE "WHICHEVER IS BIGGER". There is no `Math.max` here and no fallback between the
 * two keys on purpose: if `QuantityBooked` is missing while `QuantityReceieved` is present, that is
 * SHAPE DRIFT, and the answer is `unreadable` (which refuses), never the other field's number.
 *
 * ── ABSENT IS NOT ZERO ─────────────────────────────────────────────────────────────────────────────
 *
 * Zero is a measurement: the warehouse booked nothing in. Absent, non-numeric, NaN, Infinity or
 * negative is UNKNOWN, and every one of them returns `{ kind: 'unreadable' }`, which the booked-in
 * service turns into an approval-blocked review warning. It does not become 0, because 0 is a
 * quantity the delta arithmetic acts on — it applies nothing and, against earlier state, reads as a
 * REGRESSION ("Mintsoft's quantity decreased"), which is a false statement about the warehouse.
 *
 * `OnOrder` IS DELIBERATELY NOT READ. It tracked `QuantityExpected` on an awaiting-delivery ASN
 * (6114: expected 20, OnOrder 20) and was 0 on a brand-new one (6117: expected 1, OnOrder 0), so it
 * answers no question this module is asked. Nor is the ASN HEADER's `Quantity`: it is the count of
 * goods-in PACKAGES (`GoodsInType` Carton/Pallet/Container) and equalled the sum of the items'
 * expected quantities on only 3 of the tenant's 223 ASNs.
 */

/** `ASNItem.QuantityExpected` — what the ASN says should arrive. */
export const MINTSOFT_ASN_ITEM_EXPECTED_QTY_KEY = 'QuantityExpected'
/** `ASNItem.QuantityReceieved` — Mintsoft's spelling, and the only spelling it serves. */
export const MINTSOFT_ASN_ITEM_ARRIVED_QTY_KEY = 'QuantityReceieved'
/** `ASNItem.QuantityBooked` — the quantity IMS's booked-in path acts on (see the header). */
export const MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY = 'QuantityBooked'

/** The basis string recorded on a reading, so an audit row says which remote field it came from. */
export const MINTSOFT_ASN_RECEIPT_BASIS = `Mintsoft ASNItem.${MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY}`

/**
 * ONE numeric reader for every ASN-item quantity. A finite, non-negative number, or a string that
 * parses to one, is the quantity. EVERYTHING else — absent, null, boolean, object, blank, `NaN`,
 * `Infinity`, negative — is `null`, i.e. UNKNOWN.
 *
 * `NaN` and `Infinity` are `typeof 'number'`, so a naive `typeof value === 'number'` admitted them and
 * they propagated into delta arithmetic as quantities that compare false against everything (the same
 * hole o3d-bhvu round 4 closed on the expected quantity). A NEGATIVE booked quantity is not a
 * measurement Mintsoft's int32 field is capable of meaning here, so it is unknown rather than clamped
 * to 0 — clamping an unreadable value to zero is the defect this module exists to remove.
 */
export function readMintsoftAsnItemQuantity(record: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!record) return null
  if (!Object.prototype.hasOwnProperty.call(record, key)) return null
  const value = record[key]
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  return null
}

/** `QuantityExpected` for one item, or `null` when it cannot be read. */
export function readMintsoftAsnItemExpectedQty(record: Record<string, unknown> | null | undefined): number | null {
  return readMintsoftAsnItemQuantity(record, MINTSOFT_ASN_ITEM_EXPECTED_QTY_KEY)
}

/**
 * THE RECEIPT FACTS for one live `ASNItem`: the quantity IMS books into stock (`QuantityBooked`) and,
 * alongside it and never instead of it, the quantity the warehouse says arrived (`QuantityReceieved`).
 *
 * An unreadable `QuantityBooked` makes the whole reading `unreadable` even when `QuantityReceieved` is
 * perfectly readable — see the header: no fallback, no maximum.
 */
export function readMintsoftAsnItemReceipt(record: Record<string, unknown> | null | undefined): WmsAsnLineReceipt {
  const bookedIntoStockQty = readMintsoftAsnItemQuantity(record, MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY)
  if (bookedIntoStockQty == null) {
    const present = record && Object.prototype.hasOwnProperty.call(record, MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY)
    return {
      kind: 'unreadable',
      // STILL CARRIED: if `QuantityReceieved` is readable it is the only quantity Mintsoft served, and
      // the reviewer needs it. It is NOT a substitute for the booked quantity — this arm still refuses.
      arrivedAtWarehouseQty: readMintsoftAsnItemQuantity(record, MINTSOFT_ASN_ITEM_ARRIVED_QTY_KEY),
      detail: present
        ? `Mintsoft served ASNItem.${MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY} as ${JSON.stringify(record?.[MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY])}, `
          + 'which is not a quantity of goods booked into stock'
        : `Mintsoft served an ASN item with no ${MINTSOFT_ASN_ITEM_BOOKED_QTY_KEY} field, so how much of it `
          + 'has been booked into the warehouse\'s stock is unknown',
    }
  }

  return {
    kind: 'reported',
    bookedIntoStockQty,
    // Informational, and never a substitute: null here means Mintsoft did not serve a readable
    // arrived count, not that nothing arrived.
    arrivedAtWarehouseQty: readMintsoftAsnItemQuantity(record, MINTSOFT_ASN_ITEM_ARRIVED_QTY_KEY),
    basis: MINTSOFT_ASN_RECEIPT_BASIS,
  }
}
