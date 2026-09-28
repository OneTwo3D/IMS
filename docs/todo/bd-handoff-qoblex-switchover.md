# Handoff: merge the Qoblex → IMS switchover additions into the beads (Dolt) plan

**For:** the Claude Code session on the Proxmox VM, which can reach the `onetwo3d-ims` beads Dolt server.
**Written:** 2026-09-28, by a cloud session that could not reach Dolt and has **not** seen the existing switchover plan.
**Self-contained:** everything needed to file each issue is in this file. The repo docs on branch `wip/loving-hawking-72uquf` of `OneTwo3D/IMS` are background only.

## Your task

Merge the 20 issues below into the **existing Qoblex → IMS switchover plan** in beads:

- 1 Mintsoft epic
- 7 stages under it
- 12 gap items

Do **not** implement any feature. This is issue filing only. Finish with `bd dolt push` and a report.

## Procedure

1. **Orient.** Run `bd prime`, then list the open plan. Examples: `bd list -t epic`, `bd list --title qoblex`, `bd list --title switchover`.
2. **Find the parent.** Identify the existing switchover epic and call it `$SWITCHOVER`.
   - If there is exactly one clear match, use it.
   - If there are zero or several matches, **stop and ask the user**. Never invent a new switchover epic.
3. **Merge, don't duplicate.** For every issue below, first search for an existing bead that covers the same thing. Search by distinctive title words and by topic, e.g. "Mintsoft order push", "withdrawal", "split", "refund", "tracking", "product sync", "label".
   - **Match found:**
     - Reuse its id.
     - Add any missing labels, parent link and dependencies.
     - **Do not overwrite** its description or design. Instead, append the text below under a heading `2026-09-28 switchover handoff`, using `bd update <id> --notes "..."` or this bd version's equivalent.
     - If the existing bead contradicts a decision below, list the contradiction in your report and leave the bead unchanged.
   - **Partial overlap:** keep the existing bead, create the new one, and link them as related if this bd version supports it (see `bd dep --help`).
   - **No match:** create it:
     ```
     bd create "<title>" -t <type> -p <prio> -l <labels> --parent <parent> \
       -d "<description>" --design "<design>" --acceptance "<acceptance>"
     ```
     Use `--design-file` with a temp file for long text if quoting gets awkward.
4. **Labels.** Every issue gets exactly one of `switchover-initial` (needed for the initial switch) or `switchover-post` (future work, explicitly not part of the initial switch). A-issues also get `mintsoft-orders`; B-issues also get `woo-hub-gap`.
5. **Dependencies.** Once every issue exists, add the dependencies in the table at the end with `bd dep add <issue> <depends-on>` (check `bd dep --help` for this version's syntax).
6. **Verify and push.**
   - Run `bd show $SWITCHOVER` and `bd dep tree $SWITCHOVER` (or equivalent).
   - Run `bd dolt push`.
   - Commit and push any `.beads` export the repo workflow requires, per `bd prime`.
7. **Report back:**
   - a table of key → bead id → created, reused or updated;
   - any contradictions with existing beads;
   - anything you could not do.

## Context: what was decided (2026-09-28)

- **Target flow:** WooCommerce → IMS → Mintsoft.
  - The Python `OneTwo3D/woocommerce-mintsoft-sync` (orders and products) retires.
  - The WooCommerce label plugin retires later.
- **Merging:** Mintsoft has no merge API, so merging same-customer orders stays manual. The system flags candidates and holds them in `AWAITINGCONFIRMATION` so an operator merges them. It never merges and never releases a hold automatically.
- **Stays in WooCommerce for now:**
  - shipping labels (FedEx, Royal Mail Click & Drop)
  - duty/tax calculation (IMS mirrors the results)
  - all customer emails
  - customer tracking pages (AST/TrackShip)
- **Refunds:**
  - Started in IMS: only a "to be refunded" flag. No WooCommerce refund record, no status change, no store credit.
  - Started in WooCommerce: booked in IMS automatically, and the Mintsoft order is amended while it still can be.
- **EU withdrawals:** IMS has no withdrawal handling today. It must be ported before the Python sync retires.
- **Live bug:** shipping through IMS shipments never sets the WooCommerce order to `completed`.

---

## A. Mintsoft epic

### A0 — epic
- **Title:** Mintsoft outbound orders + same-customer merge candidates
- **Type / P / labels / parent:** epic / 1 / switchover-initial, mintsoft-orders / `$SWITCHOVER`
- **Description:** IMS pushes sales orders to Mintsoft. It also:
  - handles Mintsoft-side merges;
  - flags and holds same-customer merge candidates for an operator to merge by hand;
  - ports EU withdrawal handling;
  - takes over from the Python WooCommerce→Mintsoft order sync.
- **Design:** Mintsoft swagger V1 (verified 2026-09-28) has no merge endpoint; merging is UI-only.
  - Endpoints used:
    - `PUT /api/Order` (create)
    - `GET /api/Order/{id}`
    - `POST /api/Order/{id}` (header only, never items)
    - `PUT` / `POST` / `DELETE /api/Order/{id}/Items[/{ItemId}]`
    - `GET /api/Order/{id}/Cancel`
    - `GET /api/Order/{id}/MarkAwaitingConfirmation` and `/MarkConfirmed`
    - `POST /api/Order/{id}/Comments`
    - `GET /api/Order/GetOrderId`
  - A manual Mintsoft merge leaves the survivor with an `"<a>+<b>"` OrderNumber and `OrderNameValues MergedOrder=True`. The absorbed order is destroyed and returns 404.
- **Acceptance:** A1–A7 are done. The Python order sync is decommissioned with no duplicate or lost Mintsoft orders.

### A1 — Stage 1: outbound order push
- **Title:** Stage 1: Outbound sales-order push to Mintsoft (WMS Phase 8) with single-writer ownership switch
- **Type / P / labels / parent:** feature / 1 / switchover-initial, mintsoft-orders / A0
- **Description:** Extend `WmsConnector` with outbound order capabilities, so IMS can create, amend, cancel, hold and comment on Mintsoft orders.
- **Design:**
  - **Connector methods:**
    - `pushOrder` (`PUT /api/Order`), `fetchOrder`, `updateOrder`, `cancelOrder`
    - `holdOrder` (`MarkAwaitingConfirmation`)
    - `releaseOrder` (`MarkConfirmed`), for the withdrawal flow only
    - `addOrderComment`
  - **`WmsOrderLink` table:** links `SalesOrder.id` to the Mintsoft id. Also stores the last seen status, `mergedIntoExternalId`, `isMergedSurvivor`, `mergeHoldSince` and `mergeHoldToken`.
  - **Courier mapping:** IMS `shippingService` → Mintsoft courier service.
  - **Ownership switch:** a single-writer switch per sales channel, `python-sync` (the default) or `ims`. IMS refuses to push a channel the Python sync owns.
  - **Idempotency:** before any create, look up by OrderNumber with `GET /api/Order/GetOrderId`, including `a+b` numbers.
- **Acceptance:**
  - IMS can create, amend, hold, release, partially ship and cancel an order, and Mintsoft stays aligned.
  - The ownership switch provably blocks a double push.

### A2 — Stage 2: EU withdrawal handling
- **Title:** Stage 2: EU withdrawal-request handling in IMS (port hold/accept/reject lifecycle from the Python sync)
- **Type / P / labels / parent:** feature / 1 / switchover-initial, mintsoft-orders / A0
- **Description:** IMS has no withdrawal handling (no model, action or connector code). The Python sync owns the whole WebToffee "EU Order Withdrawal Button" workflow. It must be ported before the changeover, or the customer's EU right of withdrawal is silently dropped from fulfilment.
- **Design:**
  - **Intake:** a `SalesOrderWithdrawal` record (REQUESTED / APPROVED / REJECTED, full or partial lines) from the WooCommerce connector, logged with `logActivity`.
  - **Before first push:** an order with an open withdrawal is never pushed.
  - **By Mintsoft status:**

    | Mintsoft status | Action |
    |---|---|
    | NEW / ONBACKORDER | `MarkAwaitingConfirmation` plus a `[ims-withdrawal-hold:<token>]` comment. |
    | Mid-pick (PRINTED, AWAITINGPICKING, PICKINGSTARTED, PICKED, PROCESSING) | Write nothing; re-check each tick. There is no API to raise a query. |
    | HOLDING, FAILED, QUERYRAISED and other uncertain states | Defer, with a one-time escalation. |
    | PACKED / DESPATCHED / INVOICED | Auto-reject with "order already dispatched". |
  - **Approved:**
    - full → `Cancel`, which returns stock;
    - partial → keep the hold and ask an operator to amend;
    - after dispatch → handle as a return.
  - **Rejected:** leave the hold and ask the operator to Confirm. Auto-release is off by default; when on, it may release only a hold whose marker proves ownership.
  - **Guards:**
    - a transport failure is not a rejection;
    - queue entries use compare-and-clear;
    - a WooCommerce cancellation wins over a withdrawal;
    - foreign holds (an operator's, or a merge hold) are never released.
  - **Port from:** `OneTwo3D/woocommerce-mintsoft-sync` `docs/ORDER_SYNC.md` ("Withdrawal requests") and `wc_mintsoft_orders.py` (`WDRAW_*` buckets).
- **Acceptance:**
  - Every row of the Python withdrawal branch table has an IMS test.
  - Open withdrawal state (queue, token, ownership) carries across the cutover.

### A3 — Stage 3: merged Mintsoft orders
- **Title:** Stage 3: Read-side handling of merged Mintsoft orders (survivor/twin, dispatch fan-out, guards)
- **Type / P / labels / parent:** feature / 1 / switchover-initial, mintsoft-orders / A0
- **Description:** Understand merges done by an operator, the Python sync or IMS: detect survivors and absorbed twins, and fan one despatch out to every linked sales order.
- **Design:**
  - Detect a survivor by its `a+b` number or `MergedOrder=True`. A twin returns 404 and is resolved to its survivor.
  - Despatch goes through `applyExternalFulfillmentUpdate` for every linked order, with tracking copied to each.
  - IMS never updates or cancels a survivor automatically.
  - Returns matching resolves `a+b` references.
  - Invoices, payments and Xero postings stay per sales order.
- **Acceptance:** a merged pair despatched in Mintsoft ships both IMS orders with the same tracking, and nothing writes to the survivor.

### A4 — Stage 4: merge candidates, flag
- **Title:** Stage 4: Merge candidates - detect and flag same-customer orders
- **Type / P / labels / parent:** feature / 2 / switchover-initial, mintsoft-orders / A0
- **Description:** After a new order is pushed, find other open orders from the same billing email with the same shipping address whose Mintsoft order is still NEW, and flag them.
- **Design:**
  - **Matching:** normalised email plus effective shipping address (line1, line2, city, postcode without spaces, country), falling back to billing. Case, spacing and punctuation are ignored.
  - **Excluded:** orders with backordered lines or pending withdrawals.
  - **EU orders are included,** with the warning "check customs paperwork and IOSS values before merging". Northern Ireland, Jersey, Guernsey and the Isle of Man count as UK.
  - **Mintsoft gate:** the status is NEW, or AWAITINGCONFIRMATION carrying our merge marker (a chain). Tenancy is checked by ClientId, and duplicate Mintsoft ids collapse into one.
  - **Output:** a Mergeable badge with partner links, an activity-log entry, and a list on `/sync/mintsoft`. Flag mode makes no Mintsoft writes.
  - **Reference implementation:** `OneTwo3D/woocommerce-mintsoft-sync` `wc_mintsoft_merge.py` (branch `wip/loving-hawking-72uquf`).
- **Acceptance:** tests cover normalisation, every exclusion, the EU warning, chains and tenancy, and show that a search failure never affects the push.

### A5 — Stage 5: merge candidates, hold
- **Title:** Stage 5: Merge candidates - hold both orders in Mintsoft for operator merge, reminder, never auto-release
- **Type / P / labels / parent:** feature / 2 / switchover-initial, mintsoft-orders / A0
- **Description:** In hold mode, put every order of a candidate group into AWAITINGCONFIRMATION, so the warehouse can't pick them separately while an operator merges them by hand.
- **Design:**
  - **Hold:** `MarkAwaitingConfirmation` plus the comment `[ims-merge-hold:<token>] Merge candidate … Merge in Mintsoft, then Confirm the surviving order.` The EU customs warning and the FedEx manual-label warning are added where they apply.
  - **Modes:** off / flag / hold. Unknown values mean off.
  - **Failures:** a hold failure is non-fatal, and the badge says "not held".
  - **Reminder:** after `MERGE_HOLD_REMIND_HOURS` (default 4), a one-time red badge, activity-log warning and notification. IMS never releases a merge hold.
  - **Clearing:** hold state clears when the status leaves AWAITINGCONFIRMATION or a merge is detected.
  - **While held:** edits and cancellations are not pushed (the operator is told to act in Mintsoft), and a withdrawal escalates to a human.
- **Acceptance:** both orders are held with a marker, flag mode writes nothing, the reminder fires once, and there is no release path.

### A6 — Stage 6: double postage
- **Title:** Stage 6: Double-postage flag on absorbed orders (no automatic refund)
- **Type / P / labels / parent:** feature / 3 / switchover-initial, mintsoft-orders / A0
- **Description:** When a merge absorbs an order that paid for shipping, flag its shipping as possibly refundable. An operator decides and clears the flag. Nothing is refunded automatically.
- **Acceptance:** the flag appears only when shipping above 0 was paid. It is visible on the order and in a list, and only an operator can clear it.

### A7 — Stage 7: changeover
- **Title:** Stage 7: Changeover - retire Python WooCommerce->Mintsoft order sync in favour of WooCommerce->IMS->Mintsoft
- **Type / P / labels / parent:** feature / 1 / switchover-initial, mintsoft-orders / A0
- **Description:** Cut orders over per channel from the Python sync to IMS without duplicates, and carry the Python sync's state across.
- **Design:**
  1. Ship A1 with the channel still owned by `python-sync`.
  2. Shadow-run A3 read-only against live orders the Python sync created.
  3. In one maintenance window, set Python `ENABLE_ORDER_SYNC=False` and switch ownership to `ims`. IMS links existing Mintsoft orders by OrderNumber (including `a+b`) and never recreates them.
  4. Import the WooCommerce meta:
     - `_mintsoft_wdraw_*`
     - `_mintsoft_merged` and `merged_into`
     - `_mintsoft_merge_candidate`
     - `_mintsoft_merge_hold_since` and `_mintsoft_merge_hold_token`
     - `_mintsoft_merge_shipping_refund`

     Holds carrying the `[wc-merge-hold:` marker count as ours for chaining.
  5. Decommission the order sweep (systemd timer `wc-mintsoft-order-sweep`). Retiring the product sync is B8.
- **Acceptance:** no Mintsoft order is created twice, and every open merged, held or withdrawn order keeps its links and state.

---

## B. WooCommerce-hub gaps

### B1 — bug: status never pushed after shipping
- **Title:** Bug: shipping via shipments never pushes WooCommerce "completed"
- **Type / P / labels / parent:** bug / 1 / switchover-initial, woo-hub-gap / `$SWITCHOVER`
- **Description:**
  - `reconcileOrderAfterShipment` (`lib/domain/sales/shipment-service.ts`) sets the order to SHIPPED directly.
  - `updateShipmentStatus` (`app/actions/allocation.ts`, ~715–770) then pushes only the tracking meta (`pushOrderDeliveryMetadata`), never `pushImsStatusToWc` (`lib/connectors/woocommerce/sync/order-status.ts:89`).
  - So the WooCommerce order stays `processing`, and the completed email with tracking never goes out.
  - Today only `applySalesOrderStatusTransition` (`app/actions/sales.ts` ~1441) pushes the status.
- **Design:** after the last shipment ships, push the tracking first and then the status, through the shopping facade, respecting webhook-echo suppression.
- **Acceptance:** shipping the last shipment triggers exactly one status push; a partial shipment triggers none. Tests pass, and `npm run type-check` and `npm run lint` are clean.

### B2 — order push safeguards
- **Title:** Order push safeguards for IMS→Mintsoft (store credit, VAT/total guard, courier fallback, duplicate + tenancy protection, recipient data)
- **Type / P / labels / parent:** feature / 1 / switchover-initial, woo-hub-gap / `$SWITCHOVER`
- **Description:** Port the Python sync's push safeguards into the IMS order push.
- **Design:**
  - **Store credit:** treated as payment, not discount (Smart Coupons store-credit coupons, wallet and gift-card meta). Mintsoft keeps the full goods value for customs and IOSS.
  - **VAT/total guard:** refuse the push when the recalculated gross drifts beyond the rounding tolerance, and show the error on the order.
  - **Prices and SKUs:** unrounded per-unit prices. Lines without a SKU are refused.
  - **Courier fallback:** retry with a placeholder service when Mintsoft rejects the courier, and flag the order "courier pending" until Mintsoft shows a real courier.
  - **Duplicate protection:** a durable create-intent journal written before the request, a read-back check, a verify-pending queue, and an exact-match lookup on "Order Number already exists".
  - **Tenancy:** a mandatory `ClientId`, matched on every read-back (the 3PL tenant is shared).
  - **Edits and cancels:** only while the order is NEW. Otherwise the operator is told to change it in Mintsoft (IMS warn-and-confirm).
  - **Failures:** a transient failure is not a rejection. Dead-letter after N rejections, with a badge.
  - **Recipient data:** add first/last name, company, phone and email to IMS `shippingAddress`; `mapWcAddress` drops them today.
  - **Reference:** `OneTwo3D/woocommerce-mintsoft-sync` `wc_mintsoft_orders.py` (`push_order`, `_build_payload`) and `scripts/run_mintsoft_order_sweep.py` (`_guarded_push`, the journal).
- **Acceptance:** a test for each safeguard, and a replay or timeout never produces a second Mintsoft order.

### B3 — mirror duty/tax
- **Title:** Mirror WooCommerce duty/tax results into IMS (IOSS/VAT/EORI, duty fees, delivery term, customs values, per-destination HS codes, GTIN/MPN)
- **Type / P / labels / parent:** feature / 2 / switchover-initial, woo-hub-gap / `$SWITCHOVER`
- **Description:** WooCommerce and its plugins keep calculating duty and tax. IMS imports and stores the results so both systems agree. IMS never recomputes them.
- **Design:**
  - **Per order:**
    - the IOSS number applied
    - the customer's VAT/EORI number (from the WooCommerce VAT meta keys)
    - duty and tax fee lines, with `_wclc_duty_component` / `_wclc_tax_component`
    - the delivery term (IOSS_DDP / DDP / DDU_DAP)
    - per-line customs-value overrides (`_wc_label_customs_unit_value`)
  - **Per product:**
    - HS codes `pa_hs_code`, `pa_us_hs_code` and `_dutify_hs_codes`
    - `pa_customs_description`
    - GTIN (`global_unique_id`) and MPN (Yoast)
  - The Mintsoft push (A1/B2) sends `IOSSNumber` and `VATNumber` from this data.
- **Acceptance:** an imported order and product show the same values as WooCommerce, updates made in WooCommerce resync, and IMS never changes WooCommerce's calculation.

### B4 — split shipments
- **Title:** Split shipments from Mintsoft: per-part shipments, tracking and WooCommerce partial-shipped
- **Type / P / labels / parent:** feature / 2 / switchover-initial, woo-hub-gap / `$SWITCHOVER`
- **Description:** Mintsoft splits an order into parts (`NumberOfParts`, `Part`, with `OrderItems` per part). IMS must follow each part.
- **Design:**
  - One IMS shipment per part, with its own tracking.
  - Push per-part tracking and the partial-shipped status to WooCommerce, keeping the wphub partial-shipment plugin and its per-shipment emails working.
  - Complete the order only when every part has shipped or been cancelled. An all-cancelled split never completes, and a cancelled or refunded order is never reopened.
- **Acceptance:** tests for a two-part split shipped weeks apart, one part cancelled, and all parts cancelled.

### B5 — tracking details
- **Title:** Sync Mintsoft tracking details into IMS and push to WooCommerce with AST provider slugs (WC/TrackShip keep customer tracking)
- **Type / P / labels / parent:** feature / 2 / switchover-initial, woo-hub-gap / `$SWITCHOVER`
- **Description:** IMS captures tracking from the Mintsoft despatch. WooCommerce, AST and TrackShip keep the customer-facing tracking and carrier polling.
- **Design:**
  - Capture the tracking number, courier, service and ship date into the IMS shipment.
  - Map each carrier to its AST provider slug. Today IMS sends free text, which breaks tracking links. Brand FedEx-labelled orders as FedEx and Click & Drop orders as Royal Mail.
  - Keep reading TrackShip status back (`lib/trackship.ts` already exists).
  - Re-fire TrackShip for tracked orders that have no TrackShip shipment row.
  - Mark an order NOTFOUND after repeated 404s.
- **Acceptance:** the tracking link resolves for every mapped carrier, and TrackShip picks up every shipped order.

### B6 — refunds started in IMS
- **Title:** Flag IMS refunds in WooCommerce as "to be refunded" for manual handling (no WC refund record, no status change, no store credit)
- **Type / P / labels / parent:** feature / 2 / switchover-initial, woo-hub-gap / `$SWITCHOVER`
- **Description:** When a refund or credit note is created in IMS, IMS only flags it in WooCommerce. An operator refunds or credits the customer by hand.
- **Design:**
  - **Flag:** WooCommerce order meta `_ims_to_be_refunded` (amount, currency, reason, credit-note number) plus an order note: "To be refunded: £x — refund via <gateway> or issue store credit manually". IMS shows a badge and a list of flagged orders.
  - **What IMS never does:** create a WooCommerce refund record (a full-amount record would set the order to refunded) or change the WooCommerce status.
  - **Clearing:** the operator clears the flag, which removes the meta and adds a "handled" note.
  - **Operator's refund:** the later WooCommerce refund arrives through `refund.created` and must match the existing credit note, not create a second one.
  - **Status push:** `pushImsStatusToWc` must never map REFUNDED or PARTIALLY_REFUNDED. Today it maps only SHIPPED, CANCELLED and ON_HOLD; lock this with a test.
- **Acceptance:** IMS causes no WooCommerce money movement and no status change, the flag round-trips, and no credit note is duplicated.

### B7 — product sync parity
- **Title:** Product sync parity with the Python sync (variations, 99-char names, GTIN/EAN two-way, SKU rename, customs fields, cost price, bulk CSV tools)
- **Type / P / labels / parent:** feature / 2 / switchover-initial, woo-hub-gap / `$SWITCHOVER`
- **Description:** Bring the IMS→Mintsoft product sync up to the Python sync's level.
- **Design:**
  - **Variations:** only variations exist in Mintsoft. A parent's Mintsoft SKU is deleted only once every variation is confirmed present.
  - **Names:** `Parent (attr1, attr2)`, fitted to 99 characters. The parent is cut at a word boundary with "…"; the attribute suffix is kept whole.
  - **Weight and dimensions:** a variation inherits the parent's when its own are missing.
  - **GTIN/EAN:** filled in both directions, only where the target is empty. Mismatches are logged.
  - **SKU rename:** keep the Mintsoft product id and rename the SKU in place.
  - **Barcode collisions:** surfaced for a manual fix.
  - **Customs:** a dedicated customs description (not the product description). HS code and COO overwrite Mintsoft, and the overwrite is logged.
  - **Cost price:** taken from IMS cost.
  - **Bulk tools:** trade-data (HS code / customs description) and COO CSV pushes, dry-run by default.
  - **Reference:** `OneTwo3D/woocommerce-mintsoft-sync` `wc_mintsoft_sync.py` (`CustomsSyncManager`, `fit_mintsoft_name`, `_resolve_mintsoft_product`), `coo_push.py`, `force_mintsoft_trade_update.py`.
- **Acceptance:** a test for each behaviour, and a catalogue-wide dry run shows no unexpected differences from the Python sync.

### B8 — retire the Python product sync
- **Title:** Retire the Python WooCommerce→Mintsoft product sync
- **Type / P / labels / parent:** task / 2 / switchover-initial, woo-hub-gap / `$SWITCHOVER`
- **Description:** Once B7 is live, make IMS the owner of products and retire the product side of the Python sync.
- **Design:**
  - Delete the WooCommerce `product.updated` webhook that points at the Python Flask service.
  - Stop `wc-mintsoft-webhook.service`.
  - Disable or remove the plugin's product-sync hooks.
  - Carry `_mintsoft_product_id` over into IMS product links.
  - Keep `scripts/inventory_compare.py` for one-off checks until IMS stock alignment has run clean for a period.
- **Acceptance:** a product edit reaches Mintsoft only through IMS, and no Mintsoft product is duplicated.

### B9 — keep the label service working
- **Title:** Keep the WooCommerce label service working: IMS writes _mintsoft_* order meta back to WooCommerce
- **Type / P / labels / parent:** task / 1 / switchover-initial, woo-hub-gap / `$SWITCHOVER`
- **Description:** Labels (FedEx, Royal Mail Click & Drop) stay in the WooCommerce label service (`OneTwo3D/woocommerce-mintsoft-shipping-label-sync`). That service finds orders through meta the Python order sync writes today. After the switch, IMS must keep writing the same meta, or labels stop working on switchover day.
- **Design:**
  - IMS writes `_mintsoft_order_id`, `_mintsoft_order_number`, `_mintsoft_status`, `_mintsoft_tracking_written` and `_mintsoft_terminal` to each WooCommerce order.
  - The `_mintsoft_filter=active` REST query keeps returning the right orders.
  - FedEx finds the Mintsoft order by WooCommerce order number, so OrderNumber must stay equal to the WooCommerce number.
- **Acceptance:** after cutover, a Click & Drop label and a FedEx label both reach the Mintsoft order unchanged.

### B10 — move labels into IMS (future)
- **Title:** Move shipping-label generation (FedEx, Click & Drop) from WooCommerce into IMS
- **Type / P / labels / parent:** feature / 4 / switchover-post, woo-hub-gap / `$SWITCHOVER`
- **Description:** Future work, **not part of the initial switch**. Re-home the label service into IMS:
  - **FedEx:** drafts, live rates, customs engine, 3D packing, pickups, the ETD commercial invoice and letterhead, and multi-parcel PDF merge.
  - **Click & Drop:** order upload, the label bridge to Mintsoft, and cancel/withdraw.
  - **Customs-value overrides.**
- **Acceptance:** defined when this work is scheduled.

### B11 — customer emails from IMS (future)
- **Title:** Customer email communication from IMS (order, shipment, partial-shipment, delivery)
- **Type / P / labels / parent:** feature / 4 / switchover-post, woo-hub-gap / `$SWITCHOVER`
- **Description:** Future work, **not part of the initial switch**. All customer emails stay in WooCommerce, AST and TrackShip for now.
- **Acceptance:** defined when this work is scheduled.

### B12 — refunds started in WooCommerce
- **Title:** WooCommerce-initiated refunds: auto-book in IMS (reduce unshipped qty, cancel if fully refunded) and amend or cancel the Mintsoft order while still amendable
- **Type / P / labels / parent:** feature / 2 / switchover-initial, woo-hub-gap / `$SWITCHOVER`
- **Description:** A refund made in WooCommerce has already moved the money. IMS books it automatically, with no "to be refunded" flag, and amends Mintsoft while the order can still be changed.
  - **IMS today:** `syncWcRefund` (`lib/connectors/woocommerce/sync/refund-sync.ts`) always restocks refunded quantities into the returns warehouse. For unshipped goods, `refund-service.ts` refuses that restock ("no shipment line exists"), and the order line and allocation are never reduced. Verify this with a test, then fix it.
  - **Python sync today:** it never amends Mintsoft lines on a refund and never cancels a fully refunded order.
- **Design:**
  - **IMS side:**
    - Unshipped refunded quantity: reduce the open line quantity and release the allocation or reservation. No restock.
    - Shipped quantity: restock only when the return arrives, through the returns inbox.
    - Everything refunded and nothing shipped: cancel the IMS order.
    - Shipping-only or amount-only refund: credit note only.
  - **Mintsoft side,** decided on a fresh GET:

    | Mintsoft state | Action |
    |---|---|
    | Not pushed yet | Push the reduced order. |
    | NEW (ONBACKORDER / AWAITINGCONFIRMATION once proven on a test order) | Full refund: `Cancel`. Partial: reduce the quantity with `POST /Items/{ItemId}`, or `DELETE` the item when its quantity reaches 0. Then re-GET to verify, update the header totals, and add a comment. |
    | Merged survivor | Never amended automatically; operator flag. |
    | Mid-pick | Operator flag to raise a warehouse query. |
    | PACKED / DESPATCHED | No amendment; expect a return. |
    | Already cancelled by a withdrawal | No-op. |
  - **Rules:**
    - Journal every change per refund id, so a replayed webhook never amends twice.
    - A transport failure retries and is never read as "not amendable".
    - Log everything to the activity log and a WooCommerce order note.
- **Acceptance:** tests for full, partial and shipping-only refunds; for unshipped and shipped orders; for each Mintsoft status branch; and for webhook replay. A WooCommerce-initiated refund never raises the "to be refunded" flag.

---

## Dependencies (issue depends on …)

| Issue | Depends on | Why |
|---|---|---|
| A2, A3, A4, B2, B4, B5, B9, B12 | A1 | All need the IMS order push. |
| A5 | A4 | Hold builds on detection. |
| A6 | A3 | The refund flag comes from merge detection. |
| A7 | A1, A2, A3, A5, B2, B4, B5, B9, B12 | The changeover must not lose any of these. |
| B2 | B3 | IOSSNumber and VATNumber come from the mirrored tax data. |
| B8 | B7 | Don't retire the product sync before parity. |
| B10 | A7 | Labels move after the changeover. |
| B11 | A7 | Emails move after the changeover. |

B1 and B6 have no dependencies. B1 can be fixed now.

## Not for this database

The Python-sync work already built on branch `wip/loving-hawking-72uquf` of `OneTwo3D/woocommerce-mintsoft-sync` belongs to that repo's own tracker (`o3d-*`). Do not file it here. That work covers the merge-candidate flag/hold, the EU warning and the Python 3.11 CI fix.
