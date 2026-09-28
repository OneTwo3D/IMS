# Handoff: merge the 2026-09-28 WooCommerce-hub / Mintsoft decisions into the beads plan

**Audience:** the Claude Code session on the Proxmox VM, which can reach the beads Dolt server.
**Written:** 2026-09-28 by a cloud session. It was reconciled against:
- a full `bd export` taken the same day (2157 issues);
- the IMS `development` branch at `6c0b5c64`.

> `main` is ~1260 commits behind `development`. Anything that cites code refers to `development`.

**Nothing here has been filed yet.** Do not implement features; this is bead filing only.

## What this does

It merges the owner's 2026-09-28 decisions into the **existing** programme:

| Bead | Role |
|---|---|
| `o3d-sxu1k` | readiness register |
| `o3d-ofasq` | master plan |
| `o3d-zjsb5` [firstload] | first load |
| `o3d-hcx4c` [masterswitch] | master switch |
| **`o3d-zvec` [msparity]** | parity with the woo-mintsoft plugin; the parent for almost everything below |

It works in three ways:
- **14 new IMS beads (N1–N14).** Only where nothing existing covers the item.
- **1 new label-repo bead (N15)** and **1 bead for the Python sync repo (N16)**, for the merge-candidate work already built there.
- **Notes appended to 12 existing beads.** Decisions and remaining scope, where an existing bead already owns the work.

## Rules

1. **`bd prime` first.** Then confirm that each existing id below exists and is in the stated status. If one is missing, or was closed since 2026-09-28 in a way that changes the picture, stop and report it rather than guessing.
2. **Conventions** (from the existing plan):
   - IMS beads: title prefix `[msparity]`, labels `proj:ims,epic:msparity`.
   - Add one of `switchover-initial` / `switchover-post` to every new bead.
   - These two labels are new. `switchover-initial` means needed for the PHASE P2 master switch. `switchover-post` means explicitly after it.
   - Priorities follow bd (0 = highest). Do not confuse them with programme PHASE P0–P3.
3. **Idempotent.** Before each create, search titles and descriptions (e.g. `bd search`, or `bd list --title`) for an existing match created after this export. Reuse any match.
4. **Appending notes.**
   - Do not overwrite existing descriptions.
   - Use `bd update <id> --notes "..."` (or `bd comments add`, whichever this version supports).
   - Start every note with `2026-09-28 owner decisions (switchover handoff):`.
5. **Links.** Add dependencies with `bd dep add <issue> <depends-on>`. Where this plan says "related", use the `related` dep type if supported (`bd dep --help`); otherwise mention the id in the notes.
6. **Finish.**
   - Run `bd dolt push`.
   - Then reply with three things:
     - (a) a table: new key → new id;
     - (b) the list of ids you annotated;
     - (c) anything skipped, and why.

## Owner decisions (2026-09-28) to record

These are the source for every note below.

- **D1 — Merging.** Mintsoft has no merge API. Merging same-customer orders stays manual in the Mintsoft UI. IMS flags candidates (same billing email + same normalised shipping address, Mintsoft order still NEW) and **holds both** orders so an operator merges. It **never merges and never releases a merge hold**.
  - **EU orders** are flagged too, with a customs/IOSS warning. NI, JE, GG and IM count as UK.
  - **Excluded:** backordered lines and pending withdrawals.
  - **FedEx groups** are held with a "label by hand" warning.
  - **Chains** (a third order) are allowed.
  - **Unresolved holds** get a reminder after 4 h.
- **D2 — Merge-hold mechanism.** Add a **real Mintsoft hold** capability (`MarkAwaitingConfirmation`, plus a token-scoped marker comment) used **only for merge holds**. Withdrawal keeps today's cancel-based hold (o3d-e1yb as shipped).
- **D3 — Double postage.** When a merge absorbs an order that paid shipping, flag it as possibly refundable. Never refund automatically.
- **D4 — Labels.** FedEx and Royal Mail Click & Drop label generation **stays in WooCommerce** (label-sync plugin/service) through the switch. Moving it into IMS is post-switch.
  - The label service must be changed to read IMS's `_oti_wms_*` meta rather than the legacy `_mintsoft_*` keys. This confirms o3d-ofasq's decision to abandon `_mintsoft_*`.
  - The Mintsoft OrderNumber must equal what FedEx looks up (check `wc_order_prefix`).
- **D5 — Duty/tax.** WooCommerce (wclc/Dutify/o3d-ioss-xero) keeps **calculating**. IMS **mirrors** the results and never recomputes them.
- **D6 — VAT/total guard.** Keep o3d-zvec.5's **measure-first** approach (advisory, no blocking yet). This is confirmed.
- **D7 — IMS-initiated refunds.** IMS only raises a **"to be refunded"** flag in WooCommerce: meta plus an order note, and an IMS badge. There is **no WooCommerce refund record, no WooCommerce status change, and no store credit**. An operator refunds by hand and clears the flag. The operator's later WooCommerce refund must match the existing IMS credit note, not create a second one.
- **D8 — WooCommerce-initiated refunds.** These are booked in IMS automatically. Keep **onetwo3d-ims-5fcb's** orthogonal refund status: a fully refunded order keeps its lifecycle status, with `refundStatus=FULL`. The Mintsoft order is cancelled or amended automatically **only while amendable**:

  | Mintsoft state | Action |
  |---|---|
  | NEW | Cancel or amend automatically. |
  | ONBACKORDER / AWAITINGCONFIRMATION | Only once proven on a test order. |
  | Merged survivor | Operator flag. |
  | Mid-pick | Operator flag. |
  | Packed or later | Expect a return. |

  Journal the change per refund id.
- **D9 — Split shipments.** Follow Mintsoft parts. A split whose parts are all cancelled never completes. A cancelled or refunded order is never reopened. IMS-internal one-shipment-per-part stays **deferred** (the parity doc's woo-level decision stands).
- **D10 — Tracking.** IMS stores the tracking details. WooCommerce, AST and TrackShip keep customer-facing tracking. Map carriers to AST provider slugs, with FedEx and Click & Drop branded as such.
- **D11 — Customer emails.** These stay in WooCommerce (wphub-partial-shipment, AST, TrackShip). IMS-sent customer emails are post-switch.
- **D12 — Python product sync.** Retiring it is part of the switchover (o3d-hcx4c.3 / o3d-ofasq §4 STEP 1).

---

## 1. New IMS beads (parent `o3d-zvec` unless stated)

For each: title / type / priority / extra label / description, then acceptance criteria.

**N1 — `[msparity] Merge candidates: detect and flag same-customer orders still NEW in Mintsoft`**
- **Type / priority / label:** feature, P2, `switchover-initial`
- **When it runs:** after IMS pushes an order.
- **Matching:** find the customer's other open orders with the same normalised billing email and effective shipping address:
  - Address fields: line1, line2, city, postcode without spaces, country.
  - Fall back to billing when there is no shipping address.
  - Ignore case, spacing and punctuation.
- **Mintsoft gate:** the linked order is NEW, or held under our merge marker (chain). Check tenancy (ClientId). Collapse duplicate Mintsoft ids.
- **Exclusions:** see D1.
- **Output:**
  - a Mergeable badge with partner links;
  - an activity log entry;
  - a list on `/sync/mintsoft`.
- **Modes:** `off` / `flag` / `hold`. Unknown values mean `off`.
- **Reference implementation:** `OneTwo3D/woocommerce-mintsoft-sync` `wc_mintsoft_merge.py` (branch `wip/loving-hawking-72uquf`). See D1.
- **Acceptance:** tests for normalisation, every exclusion, the EU warning, chains and tenancy, and that a detection failure never affects the push.

**N2 — `[msparity] Mintsoft connector: real hold/release (MarkAwaitingConfirmation / MarkConfirmed) with token-scoped marker, for merge holds only`**
- **Type / priority / label:** feature, P2, `switchover-initial`
- **Why:** today an IMS hold cancels the Mintsoft order and re-pushes it on release (`lib/domain/wms/order-push-sweep.ts`). An operator cannot merge a cancelled order.
- **Add to `WmsConnector` / the Mintsoft connector:**
  - `holdOrder`, via `GET /api/Order/{id}/MarkAwaitingConfirmation`;
  - a marker comment `[ims-merge-hold:<token>]`;
  - `hasHoldMarker`.
- **Release:** `releaseOrder` (`MarkConfirmed`) exists for completeness only. It is not used by merge holds (D1).
- **Transport failures:** raise; they are not treated as a refusal.
- **Out of scope:** withdrawal's cancel-based hold is unchanged (D2).
- **Read first:** o3d-3a0t (the stale-marker hazard).
- **Acceptance:** a unit test per verb; a transport failure is distinguished from a refusal; the marker round-trips.

**N3 — `[msparity] Merge candidates: hold every order of the group in Mintsoft, overdue reminder, never auto-release`**
- **Type / priority / label:** feature, P2, `switchover-initial`
- **Depends on:** N1, N2.
- **Hold mode:** hold every order of the group with N2. Add the EU and FedEx warnings to the marker comment where they apply.
- **Failures:** a hold failure is non-fatal. The badge then says "not held".
- **Reminder:** after `MERGE_HOLD_REMIND_HOURS` (default 4), a one-time red badge, an activity-log warning and a notification.
- **Clearing:** the hold state clears once the order's status leaves AWAITINGCONFIRMATION, or when a merge is detected (existing detection: onetwo3d-ims-vn92.2, o3d-bjc.2.1).
- **While held:**
  - edits and cancels are not pushed; show "act in Mintsoft";
  - a withdrawal on a held order escalates to a human.
- **Acceptance:** both orders are held with a marker; flag mode writes nothing; the reminder fires once; there is no release code path.

**N4 — `[msparity] Double-postage flag on orders absorbed by a Mintsoft merge (no automatic refund)`**
- **Type / priority / label:** feature, P3, `switchover-initial`
- **Trigger:** merge detection repoints an absorbed order to its survivor (`dispatch-sweep.ts`), and that order paid shipping above zero.
- **Result:** flag the shipping as possibly refundable, with a badge, a list and an operator clear. See D3.
- **Acceptance:** raised only when shipping above zero was paid, and only an operator can clear it.

**N5 — `[msparity] BUG: IMS-authority shipments never push WooCommerce "completed" for storefront orders`**
- **Type / priority / label:** bug, P1, `switchover-initial`
- **Related:** o3d-zvec.4, o3d-ymgc.
- **Where it breaks:** on `development`, `app/actions/allocation.ts` (~1576–1655) calls `reconcileOrderAfterShipment`, then only `pushOrderDeliveryMetadata` (tracking).
- **Why other paths work:** only `sales.ts:1888` and `external-fulfillment.ts:774` call `pushSalesOrderStatus`. So WMS despatch completes the WooCommerce order, but a shipment shipped in IMS does not. The WooCommerce order stays `processing` and no completed email is sent.
- **Fix:** push tracking first, then the status, respecting zvec.4's only-if-still-processing guard and webhook-echo suppression.
- **Acceptance:** the last shipment SHIPPED pushes exactly once; a partial shipment pushes nothing; type-check and lint are clean.

**N6 — `[msparity] Mintsoft push: recipient name/company/phone/email from the WooCommerce shipping address, plus a store-credit push test`**
- **Type / priority / label:** feature, P2, `switchover-initial`
- **Recipient data:**
  - `mapWcAddress` (`lib/connectors/woocommerce/sync/field-mapping.ts`) drops the recipient name, company and phone.
  - `readAddress` in `order-push-sweep.ts` (~400–508) uses the billing `customerName` and `phone: null`.
  - Add shipping recipient fields to the IMS sales order and send them to Mintsoft.
- **Store credit:** add a test proving that store credit (Smart Coupons store-credit coupons, wallet and gift-card meta) is treated as payment, not discount. Mintsoft must keep the full goods value for customs and IOSS. Coordinate with o3d-iklv (the Xero side).
- **Acceptance:** a gift order ships to the recipient's name and phone; the store-credit test passes.

**N7 — `[msparity] Mirror WooCommerce duty/tax results into IMS: IOSS number, delivery term, wclc duty/tax components, per-line customs value, per-destination HS codes`**
- **Type / priority / label:** feature, P2, `switchover-initial`
- **Related:** o3d-mu0a, onetwo3d-ims-bhdm.
- **Already present:** `customerVatNumber` → `VATNumber` (`order-push.ts:97`) and generic fee lines.
- **Missing, to be imported and stored:**
  - the IOSS number applied;
  - the delivery term (IOSS_DDP / DDP / DDU_DAP);
  - `_wclc_duty_component` / `_wclc_tax_component`;
  - the per-line customs-value override `_wc_label_customs_unit_value`;
  - product `pa_us_hs_code` and `_dutify_hs_codes`.
- **Rules:** send `IOSSNumber` on the Mintsoft push. Never recompute (D5).
- **Acceptance:** imported values equal WooCommerce's, and WooCommerce edits resync.

**N8 — `[msparity] Port TrackShip re-fire for tracked orders without a TrackShip row, and NOTFOUND handling after repeated Mintsoft 404s`**
- **Type / priority / label:** feature, P3, `switchover-initial`
- **Related:** o3d-b6v (in_progress, plugin side).
- **What to port from the Python sweep:**
  - the `/trackship/reconcile` re-fire, with backoff;
  - an order that 404s N consecutive times is marked NOTFOUND and stops polling, with a note.
- **Rule:** customer-facing tracking stays with WooCommerce and TrackShip (D10).
- **Acceptance:** tests for re-fire, backoff and the NOTFOUND threshold.

**N9 — `[msparity] IMS-initiated refunds: raise a "to be refunded" flag in WooCommerce only (no WC refund record, no status change, no store credit)`**
- **Type / priority / label:** feature, P2, `switchover-initial`
- **Related:** o3d-7w9v, o3d-etbf.
- **Current state:** IMS writes nothing to WooCommerce for a refund. `IMS_TO_WC` (`order-status.ts:138`) maps only SHIPPED, CANCELLED and ON_HOLD.
- **Add:**
  - WooCommerce order meta `_ims_to_be_refunded` (amount, currency, reason, credit-note number), plus an order note;
  - an IMS badge and list, with an operator clear that removes the meta and adds a note.
- **Fix:** WC refund dedup keys only on `externalRefundId`, so the operator's later WooCommerce refund would create a **second credit note**. Match it to the flagged credit note instead.
- **Lock:** add a test that REFUNDED and PARTIALLY_REFUNDED are never mapped to a WooCommerce status. See D7.
- **Acceptance:** no WooCommerce money movement or status change from IMS; the flag round-trips; no duplicate credit note.

**N10 — `[msparity] Product sync parity remainder: 99-char Mintsoft names, CostPrice, variable-parent SKU deletion, variation dimension/weight inheritance, bulk trade/COO CSV tools`**
- **Type / priority / label:** feature, P2, `switchover-initial`
- **Related:** o3d-mu0a, o3d-zvec.6, onetwo3d-ims-bhdm, o3d-s2yh.
- **Current state:** `buildMintsoftProductPayload` (`lib/connectors/mintsoft/api/client.ts:218`) sends Name unclipped, no CostPrice, and a single EAN.
- **Port from the Python sync:**
  - **Names:** `fit_mintsoft_name`, which cuts the parent at a word boundary with "..." and keeps the variant suffix whole, within 99 characters.
  - **Cost price:** from IMS cost.
  - **Variable parents:** delete the parent's Mintsoft SKU only after every variation is confirmed present.
  - **Inheritance:** a variation inherits the parent's weight and dimensions when its own are missing.
  - **Bulk tools:** trade-data (HS / customs description) and COO CSV pushes, dry-run by default.
- **Acceptance:** a test per behaviour, and a catalogue dry run shows no unexpected diffs.

**N11 — `[msparity] BUG: WooCommerce refund of unshipped quantity tries to restock and fails ("no shipment line exists")`**
- **Type / priority / label:** bug, P2, `switchover-initial`
- **Related:** o3d-zvec.8.
- **Where it breaks:** `lib/connectors/woocommerce/sync/refund-sync.ts` (~950) passes the default returns warehouse for any quantity refund. `lib/domain/sales/refund-service.ts` (~775) then throws for unshipped lines.
- **Fix:** unshipped quantity must release demand and reservation only, which `post-refund-release.ts` already does, with no restock. Shipped quantity is restocked only when the return arrives. Keep the 5fcb design (D8).
- **Acceptance:** tests cover:
  - a refund of unshipped quantity;
  - a partial shipment followed by a refund;
  - a full refund of an unshipped order (`refundStatus=FULL`, Mintsoft cancelled as today).

**N12 — `[msparity] Cutover: import legacy _mintsoft_* order state into IMS and verify Mintsoft OrderNumber equality`**
- **Type / priority / label:** task, P1, `switchover-initial`
- **Blocks:** o3d-hcx4c.3.
- **Import, at the cutover:**
  - `_mintsoft_wdraw_*` (queue, token, ownership) into the withdrawal model;
  - `_mintsoft_merged` / `merged_into` into `WmsOrderPushLink` MERGED;
  - `_mintsoft_merge_candidate`, `_mintsoft_merge_hold_since` / `_token` into N1/N3 state. Holds placed by the Python sync with the `[wc-merge-hold:` marker count as ours for chaining;
  - `_mintsoft_merge_shipping_refund` into the N4 flag.
- **OrderNumber check:** IMS pushes `orderNumber = wc_order_prefix + number` (`order-import.ts:2149`, `order-push-sweep.ts:494`). With a non-empty prefix, IMS will not match orders the Python sync created, nor what the FedEx label service looks up. Decide the prefix, and prove existing Mintsoft orders adopt rather than duplicate (o3d-6sfe).
- **Acceptance:** a dry run over live WooCommerce meta imports every open order's state; zero OrderNumber mismatches.

**N13 — `[msparity] Post-switch: move shipping-label generation (FedEx, Click & Drop) from WooCommerce into IMS`**
- **Type / priority / label:** feature, P4, `switchover-post`
- **Related:** o3d-kaqb2, o3d-ofasq §4 STEP 3, o3d-5hel.
- **Scope:**
  - **FedEx:** drafts, rates, customs engine, packing, pickups, ETD commercial invoice and letterhead (LHS), multi-parcel (MPS) PDF merge.
  - **Click & Drop:** upload, label bridge to Mintsoft, cancel/withdraw.
  - **Customs-value overrides.**
- **Not part of the initial switch (D4).**

**N14 — `[msparity] Post-switch: customer email communication from IMS (order, shipment, partial-shipment, delivery)`**
- **Type / priority / label:** feature, P4, `switchover-post`
- **Related:** onetwo3d-ims-q66in.1.6.
- **Scope:** all customer emails stay in WooCommerce, wphub-partial-shipment, AST and TrackShip until then (D11).

## 2. New bead outside the IMS tree

**N15 — `[labels] Label service: read IMS _oti_wms_* order meta instead of legacy _mintsoft_* (so labels survive the IMS switch)`**
- **Type / priority / labels:** task, P1, `proj:woocommerce-mintsoft-shipping-label-sync`, `switchover-initial`. No `[msparity]` prefix; it is label-repo work.
- **Blocks:** o3d-hcx4c.3.
- **Current reads:** `OneTwo3D/woocommerce-mintsoft-shipping-label-sync` discovers orders via `_mintsoft_order_id`, `_mintsoft_order_number`, `_mintsoft_tracking_written`, `_mintsoft_terminal`, and the `_mintsoft_filter=active` REST query. The WC→Mintsoft Python sync writes these meta keys.
- **Why:** IMS writes `_oti_wms_*` (`lib/connectors/woocommerce/sync/wms-status.ts`), and o3d-ofasq abandons `_mintsoft_*`.
- **Change:**
  - read the IMS keys, falling back to the legacy keys during the transition;
  - move the REST query to an IMS-meta filter;
  - FedEx: find the Mintsoft order by the IMS-pushed OrderNumber (see N12).
- **Acceptance:** on stage after the switch, a Click & Drop label and a FedEx label both reach the Mintsoft order.

## 3. Python-sync work already built (same database, different project)

**N16 — `[merge] woo-mintsoft sync: flag and hold same-customer merge candidates (off/flag/hold), EU warning, refund-check flag`**
- **Type / priority / labels:** feature, P2, `proj:woocommerce-mintsoft-sync`
- **Status:** in_progress.
- **Where the code is:** built on branch `wip/loving-hawking-72uquf` of `OneTwo3D/woocommerce-mintsoft-sync`. Spec: `docs/superpowers/specs/2026-09-28-merge-candidate-hold-design.md`. Tests: 1238 Python on 3.11, plus PHP.
- **What it adds:**
  - `wc_mintsoft_merge.py`;
  - WordPress chips and views (Mergeable / Merge hold / Merge overdue / £ Refund check);
  - `MINTSOFT_MERGE_CANDIDATES`, which defaults to `off`.
- **Also on the branch:** a fix for the Python 3.11 CI break (`run_mintsoft_order_sweep.py`, withdrawal note f-string).
- **Awaiting:** the repo's Codex adversarial pass before merge.
- **Interim:** it retires with the Python sync (N12 imports its state).

## 4. Notes to append to existing beads

| Id | Append (prefix each with `2026-09-28 owner decisions (switchover handoff):`) |
|---|---|
| `o3d-zvec` | Summary of D1–D12, and the list of new children N1–N14. D4: the label service moves to IMS meta (N15) rather than IMS writing `_mintsoft_*`. |
| `o3d-zvec.1` | D10 carrier → AST slug map. Brand FedEx-labelled orders (`_fedex_tracking_number`) as FedEx and Click & Drop orders as Royal Mail, as the Python sync does. D11: emails stay in WooCommerce, so confirming the WooCommerce completed/despatch email still fires is the whole requirement. Related: N5. |
| `o3d-zvec.3` | The single-writer switch must also cover per-channel coexistence with the Python sync (`python-sync` / `ims` / `none`) for order push, and for merge-candidate flag/hold (only the owner flags/holds). Related: N12. |
| `o3d-zvec.4` | Related bug N5: IMS-authority shipments never push the status at all. Apply the same only-if-still-processing guard there. |
| `o3d-zvec.5` | D6: owner confirmed measure-first. Keep the guard advisory until the measurement justifies blocking. |
| `o3d-zvec.8` | D8 rules for WooCommerce-initiated refunds. NEW: cancel or amend automatically. ONBACKORDER / AWAITINGCONFIRMATION: only after a test order proves it. Merged survivor or mid-pick: operator flag with an order note. Packed or later: expect a return. Journal per refund id so a replayed webhook never amends twice. Keep the 5fcb orthogonal refund status. Related: N11. |
| `o3d-zvec.9` | D9: a split whose parts are all cancelled never completes; a cancelled or refunded order is never reopened. IMS-internal one-shipment-per-part stays deferred. |
| `o3d-hcx4c.3` | Disabling woo-mintsoft must also retire the Python **product** sync (D12). Steps: delete the WooCommerce `product.updated` webhook that points at the Flask service; stop `wc-mintsoft-webhook.service`; disable the plugin's product hooks; keep `scripts/inventory_compare.py` for one-off checks. Blocked by N10, N12 and N15. Labels stay in WooCommerce through this step. |
| `o3d-zjsb5.12` | Carry `_mintsoft_product_id` (WooCommerce product meta written by the Python sync) into the IMS Mintsoft product links. |
| `o3d-ofasq` | Record D1–D12. D4 confirms §4's abandonment of `_mintsoft_*`: the label plugin adapts (N15) before STEP 1, and moves into IMS at STEP 3 or later (N13). D5: duty/tax stays computed in WooCommerce and is mirrored (N7). D7/D8: refund policy. |
| `o3d-sxu1k` | New P1s for the switch gate: N5, N12, N15. Merge-candidate work (N1–N4) is `switchover-initial` P2. |
| `o3d-e1yb` | D2: withdrawal keeps the cancel-based hold. The new real Mintsoft hold (N2) is for merge holds only. A withdrawal on a merge-held order escalates to a human. |

## 5. Dependencies to add (issue → depends on)

| Issue | Depends on |
|---|---|
| N3 | N1, N2 |
| N4 | (none; merge detection already exists) |
| N12 | N1, N3, N4 (their state must exist to import into) |
| `o3d-hcx4c.3` | N10, N12, N15 |
| N13 | `o3d-hcx4c.4` |
| N14 | `o3d-hcx4c.4` |
| N9 | (none) |
| N5 | (none; fix now) |
| N11 | (none; fix now) |

## Done when

- N1–N16 each exist exactly once, with the stated parent, labels and priority.
- The 12 notes are appended.
- The dependencies are in place.
- `bd dolt push` has succeeded, and the report has been sent.
