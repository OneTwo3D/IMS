# Handoff: file the Qoblex → IMS switchover beads in Dolt

**Audience:** a Claude Code session on the Proxmox VM that can reach the beads Dolt server.
**Written:** 2026-09-28, by a cloud session that could not reach Dolt.
**Your job:** create the beads below in the `onetwo3d-ims` beads database, attach them to the existing **Qoblex → IMS switchover** epic, push the Dolt database, and report back the ids you created.

Do not implement any of the features. This is issue filing only.

## Background (read first)

- `docs/todo/qoblex-switchover-woo-hub-gaps.md` lists features that WooCommerce and its Python services do today and that IMS does not cover. It includes the owner's decisions (items 1–10).
- `docs/todo/mintsoft-order-consolidation-plan.md` is the Mintsoft outbound orders + merge-candidates epic (Stages 1–7). Its own "Beads Tracking" block is **superseded by this handoff**. Do not run those commands separately, or you will create duplicates.

## Rules

1. **Find the parent.** Look for the existing switchover epic, e.g. `bd list -t epic --title qoblex` (try `--title switchover` too).
   - If there is exactly one match, use it as `$SWITCHOVER`.
   - If there are zero or several matches, **stop and ask the user** which epic to use. Never create a new switchover epic yourself.
2. **Idempotent.** Before each `bd create`, check for an existing issue with the same title: `bd list --title "<distinctive part of title>" --all` or equivalent. If one exists, reuse its id and do not create a duplicate. Report reused ids separately.
3. **Labels.** Every issue gets exactly one of:
   - `switchover-initial`: required for the initial switchover.
   - `switchover-post`: future work, explicitly not part of the initial switch.

   Also add `woo-hub-gap` to the gap items (B1–B12) and `mintsoft-orders` to the Mintsoft epic and its stages (A0–A7).
4. **Descriptions.** Use the one-line description given, then add `See docs/todo/<file>.md, item N.`
5. **Dependencies.** After everything exists, add them with `bd dep add <issue> <depends-on>` (check `bd dep --help` for the exact syntax in this version).
6. **Finish.** Run `bd dolt push`, then `bd show $SWITCHOVER` to verify. Reply with a table: key → bead id, created or reused.

## Issues to create

Priorities: 0 is highest. Types as given.

### A. Mintsoft epic (from `mintsoft-order-consolidation-plan.md`)

| Key | Parent | Type | P | Label | Title | Description |
|---|---|---|---|---|---|---|
| A0 | `$SWITCHOVER` | epic | 1 | switchover-initial | Mintsoft outbound orders + same-customer merge candidates | IMS pushes sales orders to Mintsoft, handles merges, flags and holds merge candidates, and takes over from the Python WooCommerce→Mintsoft order sync. |
| A1 | A0 | feature | 1 | switchover-initial | Stage 1: Outbound sales-order push to Mintsoft (WMS Phase 8) with single-writer ownership switch | pushOrder/update/cancel/hold via WmsConnector, WmsOrderLink table, per-channel python-sync vs ims ownership, GetOrderId idempotency. Item: Stage 1. |
| A2 | A0 | feature | 1 | switchover-initial | Stage 2: EU withdrawal-request handling in IMS (port hold/accept/reject lifecycle from the Python sync) | IMS has no withdrawal handling; port the full WebToffee withdrawal lifecycle before the changeover. Item: Stage 2. |
| A3 | A0 | feature | 1 | switchover-initial | Stage 3: Read-side handling of merged Mintsoft orders (survivor/twin, dispatch fan-out, guards) | Detect a+b survivors and 404 twins, fan one despatch out to every linked sales order, never update or cancel a survivor. Item: Stage 3. |
| A4 | A0 | feature | 2 | switchover-initial | Stage 4: Merge candidates - detect and flag same-customer orders | Same email + shipping address, still NEW; flag with badge and activity log; EU flagged with customs/IOSS warning. Item: Stage 4. |
| A5 | A0 | feature | 2 | switchover-initial | Stage 5: Merge candidates - hold both orders in Mintsoft for operator merge, reminder, never auto-release | MarkAwaitingConfirmation both orders with an ims-merge-hold marker; overdue reminder; operator merges and confirms. Item: Stage 5. |
| A6 | A0 | feature | 3 | switchover-initial | Stage 6: Double-postage flag on absorbed orders (no automatic refund) | Flag shipping paid on an absorbed order as possibly refundable; operator clears it. Item: Stage 6. |
| A7 | A0 | feature | 1 | switchover-initial | Stage 7: Changeover - retire Python WooCommerce->Mintsoft order sync in favour of WooCommerce->IMS->Mintsoft | Read-only shadow run, cut over per channel, import _mintsoft_* merge/withdrawal state, decommission the order sweep. Item: Stage 7. |

### B. WooCommerce-hub gaps (from `qoblex-switchover-woo-hub-gaps.md`)

| Key | Parent | Type | P | Label | Title | Description |
|---|---|---|---|---|---|---|
| B1 | `$SWITCHOVER` | bug | 1 | switchover-initial | Bug: shipping via shipments never pushes WooCommerce "completed" | reconcileOrderAfterShipment sets SHIPPED directly and updateShipmentStatus only pushes tracking meta, never pushImsStatusToWc; the WC order stays processing and no completed email is sent. Item 10. |
| B2 | `$SWITCHOVER` | feature | 1 | switchover-initial | Order push safeguards for IMS→Mintsoft (store credit, VAT/total guard, courier fallback, duplicate + tenancy protection, recipient data) | Port the Python sync's push safeguards into the IMS order push. Item 3. |
| B3 | `$SWITCHOVER` | feature | 2 | switchover-initial | Mirror WooCommerce duty/tax results into IMS (IOSS/VAT/EORI, duty fees, delivery term, customs values, per-destination HS codes, GTIN/MPN) | WooCommerce stays the calculator; IMS imports and stores the results so both stay in sync, and the Mintsoft push uses them. Item 2. |
| B4 | `$SWITCHOVER` | feature | 2 | switchover-initial | Split shipments from Mintsoft: per-part shipments, tracking and WooCommerce partial-shipped | One IMS shipment per Mintsoft part; per-part tracking and partial-shipped pushed to WC; complete only when all parts are resolved. Item 4. |
| B5 | `$SWITCHOVER` | feature | 2 | switchover-initial | Sync Mintsoft tracking details into IMS and push to WooCommerce with AST provider slugs (WC/TrackShip keep customer tracking) | Capture tracking/courier/ship date; carrier→AST slug map with FedEx and Click & Drop branding; TrackShip re-fire; NOTFOUND handling. Item 5. |
| B6 | `$SWITCHOVER` | feature | 2 | switchover-initial | Flag IMS refunds in WooCommerce as "to be refunded" for manual handling (no WC refund record, no status change, no store credit) | IMS writes _ims_to_be_refunded meta and an order note; an operator refunds or credits manually and clears the flag; the returning refund.created webhook is matched to the existing credit note; REFUNDED is never pushed as a WC status. Item 6. |
| B7 | `$SWITCHOVER` | feature | 2 | switchover-initial | Product sync parity with the Python sync (variations, 99-char names, GTIN/EAN two-way, SKU rename, customs fields, cost price, bulk CSV tools) | Bring IMS→Mintsoft product sync to the Python sync's level. Item 7. |
| B8 | `$SWITCHOVER` | task | 2 | switchover-initial | Retire the Python WooCommerce→Mintsoft product sync | Switch product ownership to IMS, remove the WC product webhook and the Flask service, disable the plugin's product hooks, carry over _mintsoft_product_id. Item 9. |
| B9 | `$SWITCHOVER` | task | 1 | switchover-initial | Keep the WooCommerce label service working: IMS writes _mintsoft_* order meta back to WooCommerce | The FedEx and Click & Drop label service depends on _mintsoft_order_id/_order_number/_tracking_written/_terminal and the _mintsoft_filter=active REST query; IMS must keep writing them after the switch. Item 1 (initial dependency). |
| B10 | `$SWITCHOVER` | feature | 4 | switchover-post | Move shipping-label generation (FedEx, Click & Drop) from WooCommerce into IMS | Future: re-home drafts, rates, customs engine, packing, pickups, ETD, MPS PDFs, and the C&D upload/bridge. Not part of the initial switch. Item 1. |
| B11 | `$SWITCHOVER` | feature | 4 | switchover-post | Customer email communication from IMS (order, shipment, partial-shipment, delivery) | Future: emails stay in WooCommerce/AST/TrackShip for now. Not part of the initial switch. Item 8. |
| B12 | `$SWITCHOVER` | feature | 2 | switchover-initial | WooCommerce-initiated refunds: auto-book in IMS (reduce unshipped qty, cancel if fully refunded) and amend or cancel the Mintsoft order while still amendable | WC refund → IMS credit note plus open-qty/allocation release (no restock of unshipped goods); Mintsoft cancel or line amend only in NEW (other states once proven); merged/mid-pick/packed states get an operator flag; journalled per refund id. Item 6b. |

## Dependencies to add (X depends on Y)

| Issue | Depends on | Why |
|---|---|---|
| A2, A3, A4, B2, B4, B5, B9, B12 | A1 | All need the IMS order push. |
| A5 | A4 | Hold builds on detection. |
| A6 | A3 | Refund flag comes from merge detection. |
| A7 | A1, A2, A3, A5, B2, B4, B5, B9, B12 | The changeover must not lose any of these. |
| B2 | B3 | IOSSNumber and VATNumber come from the mirrored tax data. |
| B8 | B7 | Don't retire the product sync before parity. |
| B10 | A7 | Label re-homing comes after the changeover. |
| B11 | A7 | Emails come after the changeover. |

## Done when

- Every key above maps to exactly one bead, and nothing is duplicated.
- All issues are children of `$SWITCHOVER` directly, or through A0.
- `bd dolt push` succeeded.
- You have replied with the key → id table and anything you could not do.
