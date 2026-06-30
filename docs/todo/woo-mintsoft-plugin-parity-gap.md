# woo-mintsoft plugin → IMS parity gap analysis

Goal: replace the legacy woo-mintsoft WordPress plugin + Python bridge with IMS-native
functionality. This maps every plugin/bridge feature to its IMS status.

Legend: ✅ done in IMS · ◐ partial · ✗ missing · ➕ IMS exceeds the plugin

## Where IMS already MEETS or EXCEEDS the plugin

| Category | Status | Notes |
|---|---|---|
| Order push (create/amend/cancel/dedup/courier-map/line-reconcile) | ✅ | `order-push.ts` + `order-push-sweep.ts`; adds refund-netting, hold/release, retry+dead-letter the plugin's Python sweep also has |
| Stock / inventory sync | ➕ | Plugin is **audit-only** (`inventory_compare.py`). IMS has live two-way sync, ALIGN_TO_WMS, discrepancy + cost-layer preservation |
| Product sync (incl. customs HS/COO/desc, barcode) | ✅ | `product-sync.ts` both directions + verify cron; plugin parity plus more |
| Bundle / kit sync | ➕ | Plugin: none. IMS: full create/checksum/verify |
| Inbound ASN / booked-in | ➕ | Plugin: none. IMS: ASN create, booked-in webhook, dry-run, approval, PO reconcile |
| Returns | ➕ | Plugin: none. IMS: polling + linkage + reconcile |
| Webhooks (WC + Mintsoft) | ➕ | IMS has order/product/refund/ASN webhooks, idempotent inbox, echo-suppression |
| Scheduling / idempotency / dead-letter | ✅ | IMS crons + `WmsSyncJob` observability ≥ plugin's 120s sweep |
| Auth / security | ✅ | HMAC webhooks, encrypted creds, URL-safety, cron auth, maintenance/kill switch |

## Genuine REMAINING gaps to replace the plugin

| # | Gap | Cat | Status | Scope |
|---|---|---|---|---|
| G1 | **Split order → WC partial shipments** | 4 | ✅ DONE | Companion plugin (`onetwoinventory-helper.php`) gained a WMS-neutral `oti/v1/order/{id}/partial-shipment` route that records into `wp_partial_shipment` + sets WC status + fires wphub emails (PR #449); dispatch-sync pushes each despatched part to it via the shopping facade (PR #450, `q66in.1.5`). Deep IMS-internal line-level shipment re-modelling stays deferred (woo-level for now). |
| G2 | **Merge handling** | 5 | ✅ DONE | dispatch-sync repoints the link to the survivor and parks it `MERGED` (PR #450, `vn92.2`); the order-push sweep's `SYNCED`-only passes auto-skip `MERGED` = dual-sync prevention. Merged+split survivors reconcile atomically. (A merged **chip** in IMS is cosmetic — covered by the existing status chip.) |
| G3 | **Royal Mail Click & Drop label integration** | 12 | ✗ | Plugin's `wc_royalmail_clickdrop.py` fetches the C&D label and forwards it to Mintsoft (Pass 3). IMS has no C&D integration (only courier-service mapping). Standalone feature |
| G4 | **WMS status visible in WC admin** | 2/3 | ✅ DONE | Owner: WMS status must stay visible in the storefront. IMS's order-status sweep now pushes the live WMS status to the WC order as WMS-neutral `_oti_wms_*` meta (on change), and the companion plugin (v1.2.0) renders it: an order-edit "Warehouse (WMS)" meta box + an orders-list "Warehouse" column (legacy CPT + HPOS). Tracking is already in WC via `_wc_shipment_tracking_items`. |
| G5 | **AST Pro email trigger** | 3 | ◐ | Plugin calls AST Pro's `add_tracking_item()` (fires AST's customer despatch email). IMS writes `_wc_shipment_tracking_items` meta directly — WC sees the tracking but AST Pro's own email may not fire. Confirm customer still gets a despatch email |
| G6 | Order-push fidelity nits | 1 | ◐ mostly DONE | **G6b customer VAT** ✅ (`SalesOrder.customerVatNumber`, extracted at WC import via `readWcCustomerVat`, sent as `VATNumber`). **G6c courier-pending** ✅ (push result `courierFallback` → warehouse comment on the WMS order). **G6a VAT penny-precision guard DEFERRED** — needs careful fee/discount/tax reconstruction vs WC's independent `totalForeign` to avoid false-positives, and is low value since IMS owns its line math. Store-credit-as-payment already handled. |
| G7 | Product-sync nits | 7 | ✅ already covered | **Barcode rule**: `resolveMintsoftBarcodePlan` never overwrites the WMS barcode (`conflict → omit`), backfills WMS→IMS (reverse-sync), maps to Mintsoft EAN. IMS's single-barcode/never-overwrite model is cleaner than the plugin's dual EAN/UPC cramming and surfaces a conflict rather than silently dual-populating. **Variation naming**: IMS-created (`"<parent> - <attrs>"`) and WC-synced (`"<parent> — <attrSuffix>"`) variants already include parent + attributes for picking clarity; SKU is a first-class field, so the plugin's "(SKU-Attr)" format is just a convention difference, not a functional gap. |
| G8 | Error-message PII scrubbing | 2 | ✅ DONE | `scrubWmsError` (emails/secrets via `redactActivityLogText`, plus IBAN + UK postcode, length-capped) applied to `WmsOrderPushLink.lastError` + dispatch-sync `WmsSyncLog.reason`. |

## Architecture decision (RESOLVED — option B, owner 2026-06-30)

The plugin writes WC partial shipments by inserting into the `wphub-partial-shipment`
tables from inside WordPress; IMS talks to WC over the standard REST API, which cannot.
**Resolved: extend the existing IMS companion plugin** (`onetwoinventory-helper.php`) with a
new HMAC-signed `oti/v1/order/{id}/partial-shipment` route that writes the wphub tables —
so only the **single** IMS companion plugin is needed for WooCommerce (no dependency on the
legacy woo-mintsoft plugin). The partial-shipment functionality stays at the woo level for
now (reuse wphub UI/emails); deep IMS-internal line-level shipment re-modelling is deferred.

**Cutover rule (coexistence):** while both IMS and the legacy Python bridge run, only one may
write back to WC or customers get double partial-shipment records / double emails. Deactivate
the legacy plugin/bridge when IMS owns writeback for a store. (This is why the companion
plugin uses neutral `_oti_wms_*` metas and its own lock name rather than re-coupling to the
legacy `_mintsoft_*` keys.)

## Sequencing / status
1. ✅ `q66in.1.5` split reconcile + G1 WC writeback (PRs #449, #450).
2. ✅ G2 merge repoint / dual-sync (PR #450).
3. ◐ G5/G4 — confirm customer despatch email actually fires + decide WC-admin visibility need.
4. ◻ G6/G7/G8 fidelity nits as needed. G3 Click & Drop is **out of scope** (owner).
