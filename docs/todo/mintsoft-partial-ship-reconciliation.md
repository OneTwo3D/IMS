# Mintsoft partial-ship / split-order reconciliation (q66in.1.5)

Line-level reconciliation of split/partial Mintsoft despatches back into IMS, and
onward display in WooCommerce. Part of Phase 8 and a concrete step toward replacing
the woo-mintsoft WordPress plugin with IMS-native functionality.

> **STATUS — IMPLEMENTED (PRs #449, #450).** Final shape differs from the exploratory
> design below: line-level partial fulfilment lives **at the storefront** (each despatched
> part = a WooCommerce partial shipment via the `oti/v1/order/{id}/partial-shipment` route
> in the companion plugin), while the **IMS order is reconciled atomically** (marked SHIPPED
> once all parts despatch). Deep IMS-internal per-line shipment splitting (the `createExternalLineShipment`
> sketch in §"IMS-side building blocks") was **deferred** — "stay at woo level for now" (owner).
> Merged survivors reconcile atomically without per-part pushes. See `docs/mintsoft.md`
> → "Dispatch Ingestion & Reconciliation" for the shipped behaviour.

## Problem

- A Mintsoft order can split into N parts; each part despatches independently with its
  own line items, tracking number, and despatch date. `/api/Order/Search?OrderNumber=`
  returns one row per part (shared `OrderNumber`, distinct `Part`).
- Today `pickOrderRow` collapses to Part 1 and `q66in.1.1` defers all split orders, so a
  partially-despatched order never progresses in IMS.
- IMS pushes one order from one bound warehouse → normally one IMS shipment, and shipment
  status is shipment-level (PENDING→PICKING→PACKED→SHIPPED), not line-level.

## Chosen model (user decision, 2026-06-30): line-level partial fulfilment

When a Mintsoft part despatches, create an IMS shipment containing exactly the despatched
lines/qty, ship it with that part's tracking, and leave the remaining lines outstanding
for a later shipment — mirroring IMS's existing manual partial-fulfilment feature.

```
Mintsoft order #1001, 5 lines
  Part 1 despatched: A,B,C (TN-A) → IMS shipment S1 {A,B,C} → SHIPPED (TN-A)
  Lines D,E still at 3PL          → remain outstanding (allocation panel shows remainder)
  Part 2 despatched: D,E (TN-B)   → IMS shipment S2 {D,E} → SHIPPED (TN-B)
                                  → all lines shipped → order SHIPPED
```

Idempotency is by **quantity delta**, not part-id tracking: for each line,
`despatchedQty(Mintsoft, cumulative over despatched parts) − shippedQty(IMS, committed)`.
Only the positive delta is shipped; a re-poll with delta 0 is a no-op. This survives
overlapping polls and re-runs without storing Mintsoft part ids.

## IMS-side building blocks

1. **Mintsoft multi-part fetch** (`q66in.1.5.1`): stop discarding non-primary rows; return
   all parts with per-part `{part, status, tracking, despatchedAt, items:[{sku, qty}]}`.
   Per-part items come from `/api/Order/{partId}/Items`. Despatch detection reuses
   `isMintsoftDispatched` per part.

2. **Line-level external partial shipment** (`q66in.1.5.2`): a new capability —
   `createExternalLineShipment(orderId, lines:[{sku|lineId, qty}], tracking)` that builds a
   Shipment containing exactly those line quantities (from existing allocations, warehouse
   aware), marks it SHIPPED with tracking, and leaves the rest outstanding. Current
   `confirmSalesOrderShipments` ships ALL net allocations; this needs a subset variant.
   Must net already-shipped qty (the delta) so re-runs don't double-ship.

3. **Drive partial reconciliation from the poll** (`q66in.1.5.3`): replace the blanket
   split-skip in `dispatch-sync` — compute per-line despatched-minus-shipped deltas across
   despatched parts and call the line-level shipment for each new delta; when all lines are
   shipped the order reconciles to SHIPPED. Single-part orders keep the 1.1 fast path.

## WooCommerce display

The woo-mintsoft plugin already models this (PRs #31/#32). Its WC-side contract — which IMS
must reproduce to replace the plugin:

- Writeback routes (HMAC-signed, namespace `WC_MINTSOFT_REST_NAMESPACE`):
  - `POST /order/{id}/status` — body includes `partial_shipment {part, total_parts,
    tracking_number, items:[{sku, qty}]}`, plus `wc_status`, `wc_status_note`,
    `merged_into`, `merged`.
  - `POST /order/{id}/tracking` — AST `_wc_shipment_tracking_items`.
- The plugin maps SKU→WC line item, inserts into `wp_partial_shipment` +
  `wp_partial_shipment_items` (per-order `shipment_id` counter; GET_LOCK + tx for
  concurrency), sets WC order status (partial-shipped vs completed by `parts_done`), stamps
  split metas (`_mintsoft_total_parts`, `_mintsoft_split_part`, `_mintsoft_split_parts_done`,
  `_mintsoft_split_part_statuses`), and fires wphub partial-shipment emails.

**Open architecture decision (blocks `q66in.1.5.4`):** during plugin→IMS transition, does
IMS (a) call the plugin's existing HMAC writeback routes (reuse the plugin's wphub-table +
email machinery), or (b) write WC natively (own endpoint / direct meta) as the eventual
replacement? And how do IMS + the plugin's Python bridge avoid double-writeback (double
partial-shipment rows / double customer emails) while both are live? Settle before 1.5.4.

## Out of scope here
- Merge handling (Mintsoft merging several WC orders) — related, tracked separately.
- Turning the plugin off / full cutover — the plugin-replacement programme.
