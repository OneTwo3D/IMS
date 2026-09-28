# Mintsoft Outbound Orders + Same-Customer Order Consolidation (Epic)

## Purpose

Save shipping charges by combining multiple open orders from the same customer into one Mintsoft despatch, while the orders are still untouched by the warehouse (Mintsoft status `NEW`).

This epic has two halves because IMS cannot consolidate orders it does not send:

1. **Outbound sales orders to Mintsoft** — IMS does not push sales orders to Mintsoft today. The WMS connector covers products, bundles, stock alignment, ASNs and returns only (`lib/connectors/wms/types.ts` `WmsConnector`). Order push is scoped as **Phase 8** of `mintsoft-wms-connector-implementation-plan.md` but is unbuilt. Order push to Mintsoft is currently done by the separate Python service `OneTwo3D/woocommerce-mintsoft-sync` (WooCommerce → Mintsoft).
2. **Order consolidation** — the merge feature itself, mirroring the behaviour being built into `woocommerce-mintsoft-sync` first (design spec: `docs/superpowers/specs/2026-09-28-auto-merge-same-customer-orders-design.md` in that repo).

Until IMS owns order push, the Python sync is the system of record for merges. IMS must at minimum *understand* merged Mintsoft orders (Stage 3) as soon as it reads Mintsoft order state.

## Business Rules (owner-confirmed 2026-09-28)

| Rule | Decision |
|---|---|
| Same customer | Same billing email **and** same shipping address (normalised: case, whitespace, punctuation, postcode spacing). |
| Merge window | Only while the surviving (first) Mintsoft order is in status `NEW`. Picking must not have started. |
| Direction | Absorb the later order into the **first** order (the survivor). |
| Shipping method conflict | Survivor takes the **more expensive / faster** of the two services, via an explicit configured rank — never inferred at runtime. |
| Excluded | EU destinations (customs/IOSS), orders on backorder, orders with a pending withdrawal request. |
| NI / Channel Islands | Treated as **UK** orders — they may merge. |
| Chains | Allowed: a later order can join an existing merge (`a+b` → `a+b+c`), subject to Mintsoft's 250-char `OrderNumber` limit. |
| Double postage | **Flag** the absorbed order's shipping charge as possibly refundable. Never refund or credit automatically. |
| Changeover | The Python WooCommerce → Mintsoft sync **retires** once WooCommerce → IMS → Mintsoft is live. Its merge feature is interim; IMS becomes the only system that merges. |
| Rollout | **Flag-only mode first**: detect and annotate candidates, change nothing in Mintsoft. Automatic merge is a separate, explicit switch. |
| Paperwork | Survivor uses the combined order number `"<a>+<b>"` on despatch paperwork (matches Mintsoft's own manual merge). |
| Visibility | Merged orders are highlighted in WooCommerce and in IMS. |

## Mintsoft API Facts (verified against `https://api.mintsoft.co.uk/swagger/docs/V1`, 2026-09-28)

- **There is no merge endpoint.** Merge exists only in the Mintsoft UI. Order rules cannot merge (only split: `POST /api/Order/{id}/SplitOrderItems`).
- A merge must therefore be composed from primitives:
  - `GET /api/Order/List`, `GET /api/Order/{id}`, `GET /api/Order/{id}/Items`
  - `GET /api/Order/{id}/MarkAwaitingConfirmation` → freeze the survivor against picking while it is mutated; `GET /api/Order/{id}/MarkConfirmed` to release.
  - `PUT /api/Order/{id}/Items` → add the absorbed order's lines.
  - `POST /api/Order/{id}` → update header (OrderNumber `a+b`, courier service, `OrderNameValues` `MergedOrder=True`). Does **not** touch items.
  - `GET /api/Order/{id}/Cancel` → cancel the absorbed order if it was already created (returns stock to available).
  - `POST /api/Order/{id}/Comments` → audit comment on both orders.
- A manual Mintsoft merge leaves two traces on the survivor: `OrderNumber` `"<a>+<b>"` and `OrderNameValues` `MergedOrder=True`; the absorbed order is destroyed (404). A composed merge must reproduce both traces so every downstream consumer treats it identically.

## Stages

### Stage 1 — Outbound sales-order push to Mintsoft (prerequisite; = Phase 8 of the WMS plan)

Extends `WmsConnector` with optional outbound capabilities:

- `pushOrder(input: WmsOrderDto): Promise<WmsOrderRef>` — `PUT /api/Order`
- `fetchOrder(externalOrderId: string): Promise<WmsOrderRef | null>`
- `updateOrderHeader(...)`, `addOrderItems(...)`, `cancelOrder(...)`
- `holdOrder(...)` / `releaseOrder(...)` — `MarkAwaitingConfirmation` / `MarkConfirmed`
- `listOrders(filter)` — for candidate search

Plus:

- `WmsOrderLink` table: IMS `SalesOrder.id` ↔ Mintsoft order id, last seen status, `mergedIntoExternalId`, `isMergedSurvivor`.
- Carrier-service mapping table: IMS `shippingService` → Mintsoft courier service **with a rank column** (used by Stage 4).
- **Single-writer ownership switch** per sales channel: `python-sync` (default, today) or `ims`. Exactly one system may push a given channel's orders to Mintsoft; IMS refuses to push while the channel is owned by the Python sync. This avoids duplicate warehouse orders during cutover.
- Idempotency: look up by `OrderNumber` (`GET /api/Order/GetOrderId`) before create, including combined `a+b` numbers.

Acceptance: the Phase 8 acceptance list in `mintsoft-wms-connector-implementation-plan.md`, plus the ownership switch provably blocks double-push.

### Stage 2 — Withdrawal-request awareness in IMS

IMS has no concept of an EU withdrawal request today; the Python sync reads it from WooCommerce (WebToffee plugin meta). IMS needs a `withdrawalPendingAt` (or equivalent) on `SalesOrder`, populated from the WooCommerce connector, so the consolidation exclusion can be evaluated IMS-side.

### Stage 3 — Read-side understanding of merged Mintsoft orders

Needed as soon as IMS reads Mintsoft order state, regardless of who performed the merge (UI operator, Python sync, or IMS):

- Detect survivors (`a+b` number or `MergedOrder=True`) and absorbed twins (404 → resolve survivor).
- Dispatch reconciliation: one Mintsoft despatch fans out to **every** linked IMS sales order via `applyExternalFulfillmentUpdate(...)`; tracking number copied to each.
- Guard: IMS never updates or cancels a merged survivor automatically (mirrors `is_merged_survivor()` in the Python sync) — operator changes it in Mintsoft.
- Returns matching (Phase 7) resolves `a+b` references to both sales orders.
- Invoices, payments and Xero posting stay **per sales order** — consolidation is a fulfilment concept only.

### Stage 4 — Consolidation: flag-only mode

On push of a new sales order, search for a candidate survivor:

1. Same normalised email + shipping address, linked Mintsoft order in `NEW`, not an absorbed twin (a survivor may take further orders — chains), not the same order.
2. Neither order excluded (EU destination, backorder, pending withdrawal).
3. Result: an activity-log entry, a badge on both sales orders ("Can be combined with SO-…"), and a list on `/sync/mintsoft`. **No Mintsoft writes.**

### Stage 5 — Consolidation: automatic mode (separate switch, default OFF)

1. Hold survivor (`MarkAwaitingConfirmation`); re-fetch and require status == held and number unchanged.
2. Add the new order's lines (`PUT /api/Order/{id}/Items`).
3. Update header from the fresh Mintsoft GET (so chains keep earlier merges): `OrderNumber` `<current>+<new>`, higher-ranked courier service, accumulated shipping/discount/VAT totals. (`NewOrder` has no `OrderNameValues`, so `MergedOrder=True` cannot be set via API; the `+` number plus an `AUTOMERGED` tag are the markers.)
4. Release (`MarkConfirmed`), comment both orders, record `WmsOrderLink` merge.
5. The new order is **not** created in Mintsoft (or cancelled if it already was).
6. Any failure before step 3 → remove added lines, release hold, push the new order separately. Partial failure after step 3 → leave held, alert operator. Never lose an order; worst case is two parcels.

### Stage 6 — Double-postage flag

When two paid orders ship as one, the customer paid shipping twice. **Decision: flag only.** The absorbed sales order gets a "shipping possibly refundable" marker (amount + badge + filter on the sales list) that an operator clears after deciding. IMS never issues a refund or credit note automatically for this.

### Stage 7 — Changeover: retire the Python WooCommerce → Mintsoft sync

Target flow: **WooCommerce → IMS → Mintsoft**. Per sales channel:

1. Stage 1 ships with the channel still owned by `python-sync`. IMS pushes nothing.
2. Stage 3 runs in read-only mode against live Mintsoft orders created by the Python sync, and proves that fulfilment and tracking reconcile into IMS.
3. Cut over: set the Python sync's `ENABLE_ORDER_SYNC = False` and flip channel ownership to `ims` in the same maintenance window. The IMS push must find existing Mintsoft orders by `OrderNumber` (including `a+b` survivors) and link them rather than recreating them.
4. Port the Python merge state. Existing `_mintsoft_merged` / `merged_into` WC meta and the `_mintsoft_merge_shipping_refund` flags are imported into `WmsOrderLink`.
5. Decommission the Python order sweep (systemd timer + webhook service). Product/stock sync retirement is tracked separately.

Acceptance: no Mintsoft order is created twice across the cutover, and every open merged order keeps both WC orders linked.

## Open Questions

1. Shipping-method rank table (shared with the Python sync's `MINTSOFT_COURIER_RANK`) — owner to supply.

Resolved 2026-09-28: NI/CI = UK; double postage = flag only; chains allowed; Python sync retires at changeover.

## Beads Tracking

The beads Dolt server is only reachable from the Proxmox network, so these issues were not created from the cloud session. Run on the VM:

```bash
EPIC=$(bd create "Mintsoft outbound orders + same-customer order consolidation" -t epic -p 2 \
  -d "See docs/todo/mintsoft-order-consolidation-plan.md" --json | jq -r .id)
bd create "Stage 1: Outbound sales-order push to Mintsoft (WMS Phase 8) with single-writer ownership switch" -t feature -p 2 --parent "$EPIC"
bd create "Stage 2: Withdrawal-request awareness on SalesOrder (from WooCommerce)" -t feature -p 3 --parent "$EPIC"
bd create "Stage 3: Read-side handling of merged Mintsoft orders (survivor/twin, dispatch fan-out, guards)" -t feature -p 2 --parent "$EPIC"
bd create "Stage 4: Order consolidation flag-only mode" -t feature -p 2 --parent "$EPIC"
bd create "Stage 5: Order consolidation automatic mode (switch, default off)" -t feature -p 3 --parent "$EPIC"
bd create "Stage 6: Double-postage flag on absorbed orders (no automatic refund)" -t feature -p 3 --parent "$EPIC"
bd create "Stage 7: Changeover - retire Python WooCommerce->Mintsoft order sync in favour of WooCommerce->IMS->Mintsoft" -t feature -p 2 --parent "$EPIC"
```
