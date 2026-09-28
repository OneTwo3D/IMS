# Qoblex → IMS switchover: WooCommerce-hub gaps

> **Superseded for bead filing (2026-09-28).** This analysis was done against `main`, which is ~1260 commits behind `development`. Several gaps below are already implemented on `development`: order push, withdrawals, merge handling and split shipments. The reconciled, authoritative version is `bd-handoff-qoblex-switchover.md`, and the owner decisions recorded there take precedence over this file.


## Purpose

Today, WooCommerce is the hub for fulfilment. Two Python services hang off it:

- `OneTwo3D/woocommerce-mintsoft-sync` — WooCommerce ↔ Mintsoft products and orders
- `OneTwo3D/woocommerce-mintsoft-shipping-label-sync` — FedEx and Royal Mail Click & Drop labels

The Qoblex → IMS switchover moves orders onto **WooCommerce → IMS → Mintsoft**. This plan lists everything those services do today that IMS neither implements nor plans, with the owner's decision (2026-09-28) for each item. It also includes the beads to file under the existing Qoblex → IMS switchover epic.

Order push, merges, withdrawals and the Python order-sync changeover are covered by `mintsoft-order-consolidation-plan.md`. That epic is also filed under the switchover epic by the script at the end of this plan.

Each item is scoped as either:

- **Initial**: required for the initial switchover (label `switchover-initial`).
- **Post**: future work, explicitly **not** part of the initial switch (label `switchover-post`).

## Decisions and items

### 1. Shipping labels — stay in WooCommerce (Post, plus one Initial dependency)

FedEx and Click & Drop labels stay in the WooCommerce label service for now. This covers drafts, rates, packing, pickups, the ETD commercial invoice, multi-parcel (MPS) PDFs, and the Click & Drop upload, label bridge and cancellation. Moving labels into IMS is future work.

**Initial dependency.** The label service finds orders through WooCommerce meta that the Python order sync writes today:

- `_mintsoft_order_id`
- `_mintsoft_order_number`
- `_mintsoft_tracking_written`
- `_mintsoft_terminal`
- the `_mintsoft_filter=active` REST query

It also finds FedEx orders in Mintsoft by WooCommerce order number. When IMS takes over order push, IMS must keep writing that meta back to WooCommerce, in the same shape, or the label service stops working on switchover day.

### 2. Duty / tax — WooCommerce calculates, IMS mirrors (Initial)

WooCommerce and its plugins stay the calculator: wclc duty fees, `_wclc_duty_component` / `_wclc_tax_component`, Dutify HS maps, and IOSS/VOEC/DDP/DDU regime selection. IMS **imports and stores the calculated results** so both systems agree. IMS never recomputes them.

- **Per order:**
  - IOSS number applied
  - customer VAT / EORI number (from `WC_VAT_META_KEYS`)
  - duty and tax fee lines, and their components
  - delivery term (IOSS_DDP / DDP / DDU_DAP)
  - per-line customs-value overrides (`_wc_label_customs_unit_value`)
- **Per product:**
  - destination-specific HS codes (`pa_hs_code`, `pa_us_hs_code`, `_dutify_hs_codes`)
  - customs description (`pa_customs_description`)
  - GTIN/EAN (`global_unique_id`) and MPN (Yoast)

  These are kept in sync on product import and update.
- The Mintsoft order push (consolidation plan, Stage 1) sends `IOSSNumber` and `VATNumber` from this data.

### 3. Order push safeguards (Initial)

These are ported from the Python sync into the IMS → Mintsoft order push:

- **Store credit is payment, not discount.** Smart Coupons store-credit coupons, wallet and gift-card meta. Mintsoft still receives the full goods value for customs/IOSS.
- **VAT / total guard.** Refuse to push if the recalculated gross drifts from the order total beyond the rounding tolerance. Show the error on the order.
- **Unrounded per-unit prices**, so Mintsoft totals match to the penny. Lines without a SKU are refused.
- **Courier fallback.** If Mintsoft rejects the courier, retry with a configured placeholder service. Flag the order "courier pending" until Mintsoft reports a real courier.
- **Duplicate-create protection.**
  - Durable create-intent journal, written *before* the request.
  - Read-back verification.
  - Verify-pending queue.
  - Exact-match lookup on "Order Number already exists".
- **Tenancy.** A Mintsoft `ClientId` is required, and every read-back is matched on ClientId (the tenant is a shared 3PL).
- **Edits and cancels only while Mintsoft is `NEW`.** Past `NEW`, show "change it in Mintsoft", with the IMS equivalent of the WooCommerce warn-and-confirm popup.
- **Transient vs permanent errors.** Outages don't burn attempts. Dead-letter after N business rejections, with an order note and badge.
- **Recipient data.** The IMS `shippingAddress` gains recipient first/last name, company, phone and email (currently dropped by `mapWcAddress`), all needed by the Mintsoft order.

### 4. Split shipments (Initial)

Mintsoft splits an order into parts (`NumberOfParts` / `Part`, `OrderItems` per part). IMS needs to:

- record each part as its own shipment, with its own tracking;
- push per-part tracking and the partial-shipped state to WooCommerce, keeping the wphub partial-shipment plugin and its per-shipment emails working in WooCommerce;
- complete the order only when every part has shipped or been cancelled; an all-cancelled split never completes;
- never reopen a cancelled or refunded order.

### 5. Tracking details — IMS stores, WooCommerce/TrackShip does the ground work (Initial)

- Capture tracking number, carrier/courier name, service and ship date from Mintsoft despatch into the IMS shipment.
- Push to WooCommerce through AST with a **carrier → AST provider slug** map. Today IMS sends free text, which breaks tracking links. FedEx-labelled and Click & Drop-labelled orders are branded as FedEx and Royal Mail respectively, as the Python sync does.
- Customer-facing tracking pages, carrier polling and delivery emails stay with WooCommerce and TrackShip. IMS keeps reading the TrackShip status back (already implemented: `lib/trackship.ts`, delivery-status cron).
- Port the TrackShip re-fire for tracked orders that have no TrackShip shipment row.
- Handle orders that no longer exist in Mintsoft (NOTFOUND after repeated misses).

### 6. Refunds IMS → WooCommerce — flag only, an operator refunds by hand (Initial)

When a refund or credit note is created in IMS, IMS does **not** create a WooCommerce refund record, does **not** change the WooCommerce order status, and does **not** issue store credit. A full-amount WooCommerce refund record would move the order to `refunded` by itself, so no refund record is created at all.

Instead IMS pushes only:

- **WooCommerce order meta** `_ims_to_be_refunded` holding the amount, currency, reason and IMS credit-note number, plus an order note: **"To be refunded: £x — refund via <gateway> or issue store credit manually."**
- **An IMS badge** "To be refunded" on the sales order, and a list of flagged orders.

The operator performs the refund in WooCommerce (gateway refund or store credit), then clears the flag in IMS. IMS removes the WooCommerce meta and adds a "refund handled" note.

When the operator's manual WooCommerce refund comes back through the existing `refund.created` webhook, it must be matched to the IMS credit note that raised the flag, not imported as a second credit note.

`pushImsStatusToWc` must never map `REFUNDED` or `PARTIALLY_REFUNDED` to a WooCommerce status. Today it maps only SHIPPED, CANCELLED and ON_HOLD; keep it that way, and add a test that locks it.

### 6b. Refunds started in WooCommerce → IMS and Mintsoft (Initial)

When an operator refunds in WooCommerce (gateway refund or store credit), the money has already moved. So:

- IMS books it automatically: the credit note, plus changes to the order. It never raises the item 6 "to be refunded" flag for these.
- Mintsoft is amended automatically **only while the order can still be changed**.

**Today:**

- **IMS.** `syncWcRefund` (`lib/connectors/woocommerce/sync/refund-sync.ts`) already turns every WooCommerce refund into an IMS credit note. When the refund has quantities, it always restocks them into the default returns warehouse. For goods that **have not shipped**, `refund-service.ts` refuses that restock ("no shipment line exists … process as cash-only"). The IMS order line and its allocation are never reduced. Verify this in a test and fix it.
- **Python sync.** A WooCommerce refund only re-sends the Mintsoft order header (`update_order` never touches items), and a fully refunded order is not cancelled. Refunded goods can still ship.

**IMS side:**

- **Refunded quantity that has not shipped:** reduce the open quantity on the order line and release its allocation or reservation. Do not restock, because the goods never left.
- **Refunded quantity that has shipped:** restock into the returns warehouse as today, only once the return actually arrives. This follows the returns inbox, not the refund.
- **Every unit refunded and nothing shipped:** cancel the IMS order.
- **Shipping-only or amount-only refunds:** credit note only. No quantity change.

**Mintsoft side,** decided on a fresh `GET` of the Mintsoft order:

| Mintsoft state | Action |
|---|---|
| Not pushed yet (still queued in IMS) | Push the reduced order. Nothing to amend. |
| Amendable: `NEW`, and `ONBACKORDER` / `AWAITINGCONFIRMATION` once proven on a test order | **Full refund:** `GET /api/Order/{id}/Cancel`, which returns stock to available. **Partial refund:** reduce the quantity with `POST /api/Order/{id}/Items/{ItemId}`, or remove the line with `DELETE /api/Order/{id}/Items/{ItemId}` when it reaches 0. Re-`GET` the items and verify they match. Then update the header totals (`POST /api/Order/{id}`, a full `NewOrder` rebuilt from the fresh GET). Add a Mintsoft comment. |
| Merged survivor (`a+b`) | **Never amend automatically.** The order carries another order's goods. Flag "remove X from merged order in Mintsoft" for an operator. |
| Mid-pick (`PRINTED`, `AWAITINGPICKING`, `PICKINGSTARTED`, `PICKED`, `PROCESSING`) | No API can stop the pick. Flag the operator to raise a warehouse query by hand. |
| `PACKED` / `DESPATCHED` / `INVOICED` | No amendment. A return is expected; link it to the Mintsoft returns inbox. |
| Withdrawal already cancelled it | Nothing to do (idempotent). |

**Rules:**

- Transport failures retry and never count as "not amendable".
- Each Mintsoft change is journalled per refund id, so a replayed `refund.created` webhook cannot amend twice.
- Every automatic amendment and every operator flag is written to the activity log and as a WooCommerce order note.

### 7. Product sync parity with the Python sync (Initial)

The IMS → Mintsoft product sync must reach the same level as the Python sync:

- **Variable parents.** Only variations exist in Mintsoft. Delete the parent's Mintsoft SKU only once every variation is confirmed present.
- **Variation names.** Use `Parent (attr1, attr2)`, fitted to Mintsoft's 99-character limit: cut the parent at a word boundary with "...", keep the suffix whole.
- **Variation fallback.** A variation inherits the parent's weight and dimensions when its own are missing.
- **GTIN / EAN.** Fill in both directions, only where the target field is empty. Log mismatches.
- **SKU renames.** Keep the Mintsoft product id and rename the SKU in place, so a renamed SKU never creates a duplicate.
- **Barcode collisions.** Surface the conflicting SKU for a manual fix.
- **Customs fields.** Dedicated customs description (not the product description), HS code and COO always overwrite Mintsoft, with the overwrite logged.
- **Cost price.** Sent to Mintsoft from IMS FIFO or standard cost.
- **Bulk tools.** Trade-data (HS / customs description) and COO pushes from CSV, with dry-run by default.

### 8. Customer email communication — stays in WooCommerce (Post)

Order, shipment, partial-shipment and delivery emails stay in WooCommerce, AST and TrackShip. IMS-sent customer emails are a future feature, **not part of the initial switch**.

### 9. Retire the Python product sync (Initial)

The consolidation plan's Stage 7 retires the Python *order* sweep. Retiring the *product* side is part of this switchover:

- Once item 7 is live, switch product ownership to IMS.
- Delete the WooCommerce `product.updated` webhook that points at the Python Flask service.
- Stop `wc-mintsoft-webhook.service`.
- Remove the plugin's product-sync hooks, or disable them with a setting.
- Carry `_mintsoft_product_id` into IMS product links.
- Keep `scripts/inventory_compare.py` available as a one-off check until IMS stock alignment has run clean for a period.

### 10. Bug: shipping via shipments never completes the WooCommerce order (Initial, P1)

`reconcileOrderAfterShipment` (`lib/domain/sales/shipment-service.ts`) sets the order to `SHIPPED` directly. `updateShipmentStatus` (`app/actions/allocation.ts`) then pushes only tracking meta, never `pushImsStatusToWc`. So the WooCommerce order stays `processing`, and the completed email with tracking never goes out.

Fix: after the last shipment ships, push tracking first and then the status.

## Beads

The beads for this plan, the Mintsoft epic and the dependencies between them are filed from the VM. Follow `docs/todo/bd-handoff-qoblex-switchover.md`, a plan written for the Claude Code instance on the Proxmox VM, which can reach the beads Dolt server.
