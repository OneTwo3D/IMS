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
| G1 | **Split order → WC partial shipments** | 4 | ✗ | The big one. Plugin records each despatched part into `wp_partial_shipment` tables, sets WC partial-shipped/completed, per-part status chip, fires wphub emails. IMS has detection only. = `q66in.1.5` + a new WC-writeback piece |
| G2 | **Merge handling** | 5 | ◐ | IMS detects merges read-only (`mergedParts`/`isMerged`). Plugin repoints the order id, prevents dual-sync (drops the second push), shows a merged chip. Missing: repoint + dual-sync prevention |
| G3 | **Royal Mail Click & Drop label integration** | 12 | ✗ | Plugin's `wc_royalmail_clickdrop.py` fetches the C&D label and forwards it to Mintsoft (Pass 3). IMS has no C&D integration (only courier-service mapping). Standalone feature |
| G4 | **Mintsoft status/tracking visible in WC admin** | 2/3 | ◐ | Plugin writes raw Mintsoft status + AST tracking into WC so it shows on the WC order screen (chips, meta box). IMS surfaces all this in **IMS's** UI. Only a gap if staff still work in WC admin — process decision |
| G5 | **AST Pro email trigger** | 3 | ◐ | Plugin calls AST Pro's `add_tracking_item()` (fires AST's customer despatch email). IMS writes `_wc_shipment_tracking_items` meta directly — WC sees the tracking but AST Pro's own email may not fire. Confirm customer still gets a despatch email |
| G6 | Order-push fidelity nits | 1 | ◐ | Plugin extras to confirm in IMS: VAT penny-precision refuse (>1p drift), customer VAT-number extraction, courier-pending flag (warn + auto-clear on poll-back). Store-credit-as-payment is already handled in IMS |
| G7 | Product-sync nits | 7 | ◐ | GTIN→EAN-vs-UPC fill rule (never overwrite) + reverse EAN→GTIN; "Parent (SKU-Attr)" variation naming for picking |
| G8 | Error-message PII scrubbing | 2 | ✗ | Plugin scrubs emails/postcodes/VAT/IBAN from stored error text. IMS stores raw errors in `WmsSyncLog`/`lastError` — minor, but relevant if surfaced |

## Key architecture decision (blocks G1 WC-writeback)

The plugin writes WC partial shipments by **inserting into the `wphub-partial-shipment`
tables from inside WordPress** (PHP) and via HMAC-signed custom REST routes. IMS talks to
WC over the **standard WC REST API** (consumer key/secret) — which cannot write those
wphub tables. So IMS's partial-shipment writeback needs one of:

- **A. Call the plugin's existing `/order/{id}/status` HMAC route** (reuse its wphub-table +
  email machinery during transition). Fastest; keeps a plugin dependency.
- **B. Build a thin IMS-owned WC endpoint / companion** that writes the wphub tables (or a
  replacement representation). Full independence; more work.
- **C. Represent partial shipments in WC without wphub** — e.g. multiple AST tracking
  entries + order notes + status. No wphub emails / partial-shipment records.

Plus a coexistence rule: while both IMS and the plugin's Python bridge run, only one may
write back to WC or customers get double partial-shipment records / double emails.

## Recommended sequencing
1. `q66in.1.5` IMS-side line-level partial fulfilment (no WC dependency) — see
   `mintsoft-partial-ship-reconciliation.md`.
2. Decide the WC-writeback architecture (A/B/C) → G1 WC side.
3. G2 merge repoint/dual-sync (small, high value).
4. G5/G4 confirm customer despatch email + WC-admin visibility need.
5. G3 Click & Drop, G6/G7/G8 fidelity nits as needed.
