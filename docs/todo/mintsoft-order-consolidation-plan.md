# Mintsoft Outbound Orders + Same-Customer Merge Candidates (Epic)

> **Superseded for bead filing (2026-09-28).** This analysis was done against `main`, which is ~1260 commits behind `development`. Several gaps below are already implemented on `development`: order push, withdrawals, merge handling and split shipments. The reconciled, authoritative version is `bd-handoff-qoblex-switchover.md`, and the owner decisions recorded there take precedence over this file.


## Purpose

Save shipping charges by detecting multiple open orders from the same customer while the warehouse has not touched them (Mintsoft status `NEW`). IMS flags them and puts them on hold (`AWAITINGCONFIRMATION`) so an **operator merges them by hand in Mintsoft**. IMS never merges automatically; the owner chose this as the safer design on 2026-09-28.

This epic has two halves because IMS cannot consolidate orders it does not send:

1. **Outbound sales orders to Mintsoft** — IMS does not push sales orders to Mintsoft today. The WMS connector covers products, bundles, stock alignment, ASNs and returns only (`lib/connectors/wms/types.ts` `WmsConnector`). Order push is scoped as **Phase 8** of `mintsoft-wms-connector-implementation-plan.md` but is unbuilt. Order push to Mintsoft is currently done by the separate Python service `OneTwo3D/woocommerce-mintsoft-sync` (WooCommerce → Mintsoft).
2. **Merge candidates**: detect, flag and hold. This mirrors the workflow being built into `woocommerce-mintsoft-sync` first (design spec: `docs/superpowers/specs/2026-09-28-merge-candidate-hold-design.md` in that repo).

Until IMS owns order push, the Python sync is the system of record for merges. IMS must at minimum *understand* merged Mintsoft orders (Stage 3) as soon as it reads Mintsoft order state.

## Business Rules (owner-confirmed 2026-09-28)

| Rule | Decision |
|---|---|
| Same customer | Same billing email **and** same shipping address (normalised: case, whitespace, punctuation, postcode spacing). |
| Hold window | Only while the Mintsoft order is still `NEW`, so picking has not started. |
| Action | **Flag both orders and hold both** in Mintsoft (`AWAITINGCONFIRMATION`). The new order is pushed first, then both are held. An operator merges in the Mintsoft UI and Confirms the surviving order. |
| No automation of the merge | IMS never adds lines, renumbers or cancels to merge orders. |
| Forgotten holds | **Remind, never release.** Once a configurable number of hours has passed (default 4), IMS shows an overdue badge, writes an activity-log warning and sends a notification. The hold stays until a person acts. |
| Excluded | Orders on backorder, orders with a pending withdrawal request. |
| EU | **Flagged and held** like any other group, with a warning to check customs paperwork and IOSS values before merging. The operator decides case by case. |
| NI / Channel Islands | Treated as **UK** orders. |
| FedEx | Held as well, with a warning that the FedEx label must be made by hand (the FedEx label plugin cannot label merged orders yet). |
| Chains | A third order that joins a held or merged pair is flagged and held too. |
| Double postage | **Flag** the absorbed order's shipping charge as possibly refundable once the merge is detected. Never refund or credit automatically. |
| Changeover | The Python WooCommerce → Mintsoft sync **retires** once WooCommerce → IMS → Mintsoft is live. From then on, IMS is the only system that flags and holds candidates. |
| Rollout | `flag` mode (notes and badges only) first, then `hold`. |
| Paperwork | The operator's merge produces Mintsoft's combined `"<a>+<b>"` number, which is used on despatch paperwork. |
| Visibility | Candidates, held pairs and merged orders are highlighted in WooCommerce and in IMS. |

## Mintsoft API Facts (verified against `https://api.mintsoft.co.uk/swagger/docs/V1`, 2026-09-28)

- **There is no merge endpoint.** Merge exists only in the Mintsoft UI. Order rules cannot merge (only split: `POST /api/Order/{id}/SplitOrderItems`).
- IMS therefore only needs:
  - `GET /api/Order/{id}` to re-check the status right before holding.
  - `GET /api/Order/{id}/MarkAwaitingConfirmation` to place the hold. The operator releases it with Confirm in the UI.
  - `POST /api/Order/{id}/Comments` for a token-scoped provenance marker (`[ims-merge-hold:<token>] …`). It proves which holds are IMS's own, and it keeps withdrawal and other hold logic from treating the merge hold as theirs.
- A manual Mintsoft merge leaves two traces on the survivor: `OrderNumber` `"<a>+<b>"` and `OrderNameValues` `MergedOrder=True`. The absorbed order is destroyed and returns 404.

## Stages

### Stage 1 — Outbound sales-order push to Mintsoft (prerequisite; = Phase 8 of the WMS plan)

Extends `WmsConnector` with optional outbound capabilities:

- `pushOrder(input: WmsOrderDto): Promise<WmsOrderRef>` — `PUT /api/Order`
- `fetchOrder(externalOrderId: string): Promise<WmsOrderRef | null>`
- `updateOrder(...)`, `cancelOrder(...)`
- `holdOrder(...)`: `MarkAwaitingConfirmation`. `releaseOrder(...)` (`MarkConfirmed`) is only for the withdrawal flow; merge holds are released by operators.
- `addOrderComment(...)`

Plus:

- `WmsOrderLink` table: IMS `SalesOrder.id` ↔ Mintsoft order id, last seen status, `mergedIntoExternalId`, `isMergedSurvivor`.
- Carrier-service mapping table: IMS `shippingService` → Mintsoft courier service.
- **Single-writer ownership switch** per sales channel: `python-sync` (default, today) or `ims`. Exactly one system may push a given channel's orders to Mintsoft; IMS refuses to push while the channel is owned by the Python sync. This avoids duplicate warehouse orders during cutover.
- Idempotency: look up by `OrderNumber` (`GET /api/Order/GetOrderId`) before create, including combined `a+b` numbers.

Acceptance: the Phase 8 acceptance list in `mintsoft-wms-connector-implementation-plan.md`, plus the ownership switch provably blocks double-push.

### Stage 2 — EU withdrawal-request handling (port from the Python sync)

IMS has **no withdrawal handling today** (checked 2026-09-28: no model, action, connector code or plan mentions it). The Python WooCommerce → Mintsoft sync currently owns the whole workflow. Retiring that sync at Stage 7 without porting it would silently drop the customer's EU right of withdrawal from fulfilment, so this stage must land before the changeover.

Source of truth: `OneTwo3D/woocommerce-mintsoft-sync` `docs/ORDER_SYNC.md` ("Withdrawal requests") and `docs/superpowers/specs/2026-07-31-withdrawal-request-to-mintsoft-design.md`. Behaviour to reproduce:

- **Intake.** Requests come from the WebToffee *EU Order Withdrawal Button* plugin in WooCommerce: request id, full vs partial, and approve/reject decisions. They reach IMS through the WooCommerce connector as a `SalesOrderWithdrawal` record (status `REQUESTED` / `APPROVED` / `REJECTED`, partial lines), logged with `logActivity`.
- **Before first push.** An order with an open withdrawal is **not pushed** to Mintsoft until the request resolves.
- **Mintsoft `NEW` / `ONBACKORDER`.** Hold with `MarkAwaitingConfirmation`, plus a token-scoped `[ims-withdrawal-hold:<token>]` marker comment for provenance.
- **Mid-pick** (`PRINTED` … `PROCESSING`). Write nothing and re-evaluate each cron tick. Mintsoft has no API to raise a query, so support acts by hand.
- **Uncertain pre-dispatch states** (`HOLDING`, `FAILED`, `QUERYRAISED`, …). Defer, with a one-time escalation.
- **Packed or despatched.** Auto-reject the request with "order already dispatched".
- **Approved, full.** `Cancel` the Mintsoft order, which returns stock. **Approved, partial.** Hold, and ask an operator to amend the lines. **Approved after dispatch.** Handle it as a return (Phase 7 returns inbox).
- **Rejected.** Leave the hold in place and ask an operator to Confirm it. Auto-release is off by default, and when it is on it may release only a hold whose marker proves it is IMS's own.
- **Guards.** Distinguish transport failures from rejections (no dead-lettering during an outage). Use compare-and-clear on queue entries. A WooCommerce cancellation always wins over a withdrawal. Foreign holds (an operator's, or a merge hold) are never released.
- **Customer-facing.** The rejection reason is shown to the customer through the WebToffee plugin.

Acceptance: every row of the Python sync's withdrawal branch table has an IMS test, and the cutover in Stage 7 carries open withdrawal state across (queue, hold token, ownership).

### Stage 3 — Read-side understanding of merged Mintsoft orders

Needed as soon as IMS reads Mintsoft order state, regardless of who performed the merge (UI operator, Python sync, or IMS):

- Detect survivors (`a+b` number or `MergedOrder=True`) and absorbed twins (404 → resolve survivor).
- Dispatch reconciliation: one Mintsoft despatch fans out to **every** linked IMS sales order via `applyExternalFulfillmentUpdate(...)`; tracking number copied to each.
- Guard: IMS never updates or cancels a merged survivor automatically (mirrors `is_merged_survivor()` in the Python sync) — operator changes it in Mintsoft.
- Returns matching (Phase 7) resolves `a+b` references to both sales orders.
- Invoices, payments and Xero posting stay **per sales order** — consolidation is a fulfilment concept only.

### Stage 4 — Merge candidates: detect and flag (`flag` mode)

After a new sales order N is pushed to Mintsoft, IMS searches its **own** sales orders (no Mintsoft list call is needed):

1. Exclude N if any line is backordered or it has a pending withdrawal. EU destinations are not excluded; they carry a customs/IOSS warning on the badge, the activity log and the Mintsoft comment.
2. Candidates F: same normalised `customerEmail` and effective `shippingAddress` (line 1, line 2, city, postcode, country; billing fallback), linked Mintsoft order, and the same exclusions as N.
3. Fresh Mintsoft GET per candidate. Keep it only if the status is `NEW`, or `AWAITINGCONFIRMATION` carrying an IMS merge-hold marker (chains). Candidates that resolve to the same Mintsoft id collapse into one.
4. Result:
   - an activity-log entry;
   - a **Mergeable** badge on every sales order in the group, with links to its partners;
   - a "Merge candidates" list on `/sync/mintsoft`.

   No Mintsoft writes are made in this mode.

### Stage 5 — Merge candidates: hold (`hold` mode)

For N and every F that is still `NEW`:

1. Place the hold with `MarkAwaitingConfirmation`.
2. Add a provenance comment: `[ims-merge-hold:<token>] Merge candidate … Merge in Mintsoft, then Confirm the surviving order.` When FedEx is involved, add the manual-label warning.
3. Record `mergeHoldSince` and `mergeHoldToken` on the `WmsOrderLink`.

Rules:

- A hold that fails is non-fatal. The order stays live and the badge says "not held".
- The reminder cron marks holds overdue after `MERGE_HOLD_REMIND_HOURS`: a red badge, an activity-log warning and a notification. **IMS never releases a merge hold.**
- Once the operator merges, Stage 3 detects the merge (the survivor's `+` number, a 404 on the twin) and clears the candidate and hold state. If the operator Confirms without merging, the status is no longer held and the hold state clears too.
- Interactions follow the Python sync:
  - Edits and cancellations of a held order are not pushed; they show an "operator must act in Mintsoft" message.
  - A withdrawal on a held order escalates to a human.

### Stage 6 — Double-postage flag

When two paid orders ship as one, the customer paid shipping twice. **Decision: flag only.** The absorbed sales order gets a "shipping possibly refundable" marker (amount + badge + filter on the sales list) that an operator clears after deciding. IMS never issues a refund or credit note automatically for this.

### Stage 7 — Changeover: retire the Python WooCommerce → Mintsoft sync

Target flow: **WooCommerce → IMS → Mintsoft**. Per sales channel:

1. Stage 1 ships with the channel still owned by `python-sync`. IMS pushes nothing and does not flag or hold candidates, because the Python sync does that for its channels.
2. Stage 3 runs in read-only mode against live Mintsoft orders created by the Python sync, and proves that fulfilment and tracking reconcile into IMS.
3. Cut over: set the Python sync's `ENABLE_ORDER_SYNC = False` and flip channel ownership to `ims` in the same maintenance window. The IMS push must find existing Mintsoft orders by `OrderNumber` (including `a+b` survivors) and link them rather than recreating them.
4. Port open withdrawal state: `_mintsoft_wdraw_*` queue, hold token and ownership, imported into the Stage 2 model.
5. Port the Python merge state. Existing `_mintsoft_merged` / `merged_into`, `_mintsoft_merge_candidate`, `_mintsoft_merge_hold_since` / `_mintsoft_merge_hold_token` and `_mintsoft_merge_shipping_refund` WC meta are imported into `WmsOrderLink`. Python-placed holds (`[wc-merge-hold:` marker) count as IMS-owned for the purpose of chaining.
6. Decommission the Python order sweep (systemd timer + webhook service). Product/stock sync retirement is tracked separately.

Acceptance: no Mintsoft order is created twice across the cutover, and every open merged order keeps both WC orders linked.

## Open Questions

None. Resolved on 2026-09-28:
- NI and the Channel Islands count as UK.
- EU orders are flagged and held with a customs/IOSS warning, not excluded.
- Withdrawal handling does not exist in IMS and is ported in full (Stage 2).
- Double postage is flagged only.
- Chains are allowed.
- The sync flags and holds, and never auto-merges.
- Both orders are held.
- Forgotten holds get a reminder and are never released.
- FedEx pairs are held with a warning.
- The Python sync retires at the changeover.

## Beads Tracking

This plan's beads are filed under the Qoblex → IMS switchover epic, following `docs/todo/bd-handoff-qoblex-switchover.md` (keys A0–A7). That handoff supersedes the `bd create` commands that used to be here. Do not run both.
