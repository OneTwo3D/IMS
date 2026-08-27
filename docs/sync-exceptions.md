# Sync Exception Inbox

`/sync/exceptions` aggregates every terminal sync failure state across connectors into one operator surface, with safe manual replay. A summary banner on the Integrations page (`/sync`) shows the live total. (bd `onetwo3d-ims-q66in.4.2`.)

Replays always re-attempt the **original** work: payloads and idempotency keys are preserved, and every transition is a compare-and-set (a concurrent sweep or second click matches zero rows instead of double-applying). All replay actions require the `sync` permission; the high-risk ones (outbox, receipt events, refunds) additionally require fresh (step-up) authentication.

**Preserving the key is not the same as being protected by it.** The compare-and-set stops *IMS* double-applying; whether the *remote system* deduplicates the re-post is the remote system's rule, and for Xero the key survives only 6 minutes — far less than any row spends in this inbox. Before replaying an accounting outbox row, check the ledger for the document: see [Retrying is not protected by idempotency](xero-sync.md#retrying-is-not-protected-by-idempotency--check-xero-first).

## Sections

| Section | Source of truth | What it means | Replay |
|---|---|---|---|
| WMS order pushes — blocked | `wms_order_push_links` `state=DEAD_LETTER` | The order never reached the warehouse (5 attempts exhausted, or a hold/cancel conflict) and will not fulfil | Reset to `PENDING_CREATE` for the next push sweep (`replayWmsOrderPush`; sweep eligibility still applies). **Two guards before it writes** (o3d-2k5r r3): the WMS is asked whether it already holds an order under this order's reference — five throws are not five proofs that nothing arrived, since the first may have been a timeout on a create the WMS honoured — and the reset is a compare-and-set on the exact dead letter that was inspected, so a replay made stale by another replay or a sweep is reported as stale rather than reverting a settled link. `FOUND`, an ambiguous match, an unreachable WMS or a connector that cannot probe all refuse. **The Replay control is the action's own answer** (o3d-2k5r r5): the row's replay affordance and every refusal the action raises from the link's own columns — payload-invalid, not-a-blocked-push, already-linked-to-a-warehouse-order, create-not-repeatable — come from one shared decision (`decideWmsPushReplay`), so a button cannot render where the action refuses. Where there is no button the row shows the manual reconciliation instead, and the *Why* column is derived from the same evidence rather than from the state name |
| WMS order pushes — blocked (payload invalid) | `wms_order_push_links` `state=VALIDATION_FAILED` (o3d-92fu) | The order's own data could not be turned into a WMS payload at all — typically a line with no SKU. **No push was attempted**, so nothing exists in the warehouse and the order stays hard-deletable while its attempt count is 0 | Fix the order data. There is no Replay: the push sweep re-checks these links every run (no API cost) and re-queues the order the moment the payload builds. The row's Last error names the reason. **One exception** (o3d-2k5r r3): a disposition CONVERTED from an expired create claim carries `attempts >= 1`, which means a create may have been dispatched and its outcome never recorded. Those are not re-queued on IMS's own word — the sweep asks the WMS whether an order exists under the reference and re-queues only on a verifiable absence, re-probing on each rotation. If the WMS says the order is already there (or cannot say), the Last error says so and it needs a human: link that order to this one, or cancel it in the WMS |
| WMS order pushes — blocked (create outcome unknown) | `wms_order_push_links` `state=AMBIGUOUS_CREATE` (o3d-2k5r r4) — **release gate: the enum migration `20260827090000_wms_push_ambiguous_create` has been applied to no database (bd `o3d-1izw`, P0). Until it is, the first lapsed create claim fails at the DB rather than parking. `scripts/deploy.sh` applies it and `check-prisma-drift` proves it; `--skip-migrate` and any `next dev` tree do not.** | A create request **left IMS and nothing recorded what became of it** — the shape a worker killed mid-push leaves behind, since the claim is written immediately before the remote call. The warehouse may be holding an order under a reference IMS never learned, so the order is taken out of the create queue and is **not** hard-deletable | Two things have to be true before IMS re-dispatches, and a presence probe can only supply one of them. (1) The warehouse says it holds no order under the reference. (2) The connector's **own create refuses a duplicate** — Mintsoft's `PUT /api/Order` does, and reconciles to the order it already holds, so a replay cannot mint a second one however the race falls; ShipHero's does not, because `order_create` never enforced `partner_order_id` uniqueness and its preflight lookup cannot see a request still on the wire. On Mintsoft the sweep re-queues by itself once the warehouse confirms absence, and the Replay button does the same on demand. **On ShipHero there is no automatic retry and no button**: open the WMS, search for the order reference, cancel any duplicate and leave the survivor for the dispatch sweep, or — if nothing is there — cancel and re-create the sales order in IMS |
| Integration outbox — failed rows | `integration_outbox` `RETRYABLE_FAILED` / `PERMANENT_FAILED` | An accounting post, WooCommerce stock push, booked-in event or landed-cost journal exhausted its retries | Reset to `PENDING` with the original payload + idempotency key; or acknowledge as permanently failed. Note: a PERMANENT_FAILED WC stock row's *stock value* still self-heals via the daily force-all reconcile — the row records that the queued push failed |
| WMS inbound events — dead-lettered | `wms_inbound_receipt_events` + `wms_webhook_events`, `processingStatus=DEAD` | A booked-in or order/inventory webhook exhausted its retries; its effect was **never applied** | Reset to `PENDING` (retry ladder restarted) for the relevant webhook sweeper. Distinct from `REQUIRES_REVIEW`, which is approved from the Mintsoft panel. **Retention never touches these rows** (q66in.7.4): only `PROCESSED` rows are compacted, so a dead letter keeps the payload a replay re-attempts, however old it gets |
| WooCommerce refunds — parked | `shopping_sync_logs` `PENDING`/`FAILED`, `FROM_CONNECTOR`, `SalesOrder` | A WC refund could not be applied (usually a >1p amount mismatch); no restock/credit note was posted — a park whose refund carried quantities says so, since those units are not back on hand | Re-runs `syncRefundsForOrder` — a **fresh fetch** from WooCommerce (dedup by `externalRefundId`), so a since-corrected refund now lands. The row is marked SYNCED only when the specific refund verifiably applied |
| Dispatch reconciliation — dead-lettered | `wms_order_push_links.dispatchDeadLetteredAt` (6oyu.2) | The WMS despatched the order but IMS could not reconcile it (typically no IMS stock to consume); after 5 consecutive sweep failures the link is dead-lettered, leaves the sweep's candidate set, and admins are notified | Fix the order's stock position, then Replay — clears the dead-letter marker and failure streak so the next sweep retries |
| WMS pushes — order-total mismatches | `wms_order_push_links.totalMismatchPence` | Advisory: the order pushed, but IMS and WMS totals drifted by >1p | Review the order, then clear the flag |
| WooCommerce products — structure conflicts | `shopping_sync_logs` `QUARANTINED`, `FROM_CONNECTOR`, `Product` (o3d-y89x) | The product import refused to overwrite IMS-owned structure, so WooCommerce data went unapplied. One rule, four shapes: (a) a **variable** WC product paired with an IMS row that cannot be a parent — a KIT/BOM/VARIANT/NON_INVENTORY row, a row already somebody else's variation, a row that already has child rows its type does not allow, or a row carrying stock or open documents — so none of its variations were imported; (b) a **simple** WC product paired with an IMS **VARIABLE** row — its type and price went unwritten and its IMS variants remain; (c) a **simple** WC product paired with an IMS row that has child rows while its type says it cannot (a legacy half-flattened parent) — its type and price went unwritten too; (d) a variation SKU that resolved to a row belonging to a different IMS parent / that is itself a parent / whose type cannot be a variation / that carries stock or open documents. Orders for unimported SKUs import with no product and no allocation. An IMS KIT paired with a **simple** WC product is the ordinary bundle pairing and does **not** appear here. See [What the connector will NOT change](woocommerce.md#what-the-connector-will-not-change) | **None — and deliberately so.** The product is not marked SYNCED and the reconcile cursor does not advance past it, so the retry is automatic every run. Exactly one open row per pairing, and the next clean sync deletes it. Fix the mismatch in IMS or in WooCommerce; there is nothing to acknowledge (an acknowledge button could only hide a live conflict) |
| Order reconciliation — drift | `wms_order_discrepancies` OPEN rows (q66in.4.4, cron `wms-order-reconcile`; runs also ledger onto `ORDER_RECONCILE` sync jobs) | Scheduled IMS-intent-vs-WMS-truth check: `NOT_PUSHED` (eligible order never reached the WMS), `MISSING_IN_WMS` (WMS lost a live order), `ACTIVE_AFTER_CANCEL` (cancelled order still live in the WMS — admins are belled on first detection; it may ship). Findings are durable: the capped sweep rotates least-recently-verified links and resolves a row only when that specific order re-verifies clean | `MISSING_IN_WMS`: Re-push (link reset to `PENDING_CREATE`; resolves the finding) — but **only on a connector whose own create refuses a duplicate**, and only after the warehouse confirms absence under *both* the reference a re-create would use and the reference IMS recorded (o3d-2k5r r5). A lookup that came back empty is not proof the order is gone: it is the same lookup whose answer is in doubt, so a renumbering, a client-scope change or an eventually-consistent index would turn the re-push into a second warehouse order. On ShipHero there is therefore **no Re-push button** — the row carries the manual reconciliation instead, and the finding stays open. The reset is a compare-and-set on every column the decision was read from and it **clears the dispatch stamp**: leaving it set made the next sweep park the supposedly re-queued order as `AMBIGUOUS_CREATE` while the finding had already been resolved and the operator told it worked. Others: fix at the linked order / in the WMS |

## Recording a quarantined WooCommerce refund by hand (o3d-w00)

A parked refund row is `PENDING`/`FAILED` (retryable) or `QUARANTINED`. A QUARANTINED row was refused
deliberately — an undeterminable gross→net basis, an order that is not uniformly taxed, or a credit
note that would not come to what the storefront refunded (see *The posted-VAT fence* below) — so Retry
only re-runs the same refusal. Those rows get a **Record manually** dialog: the operator says which
parts of the order the money came off and how much of each, in **GROSS (tax-inclusive)** amounts.

- Every order line **and the shipping charge** is an allocation target, each offered at what it has left
  to refund after earlier credits.
- The allocation must add up to the WooCommerce refund the park carries, to the penny. A park written
  before the payload was retained cannot be recorded — use Retry first, which re-reads the refund from
  WooCommerce and re-parks it with the payload.
- The credit note is raised **line-linked**, stamped with the WooCommerce refund id (so a redelivery
  dedups), and the park is resolved.
- **Returned units come back with the money — and independently of it.** A quarantine stops the
  automatic restock, so if the parked refund states refunded quantities, recording it by hand returns
  those units to the default return warehouse and records them on the refund (the park's message names
  them too). Every quantity the payload states on a line IMS can identify is carried, **whether or not
  the operator allocated money to that line**: WooCommerce reports returned quantities on lines that
  carry no refundable value (a fully discounted item, a free gift, a line credited on an earlier
  refund), the automatic route restocks those units regardless, and a returned unit is a physical fact
  rather than an opinion about value. Such a line is added to the refund at **zero value**, so nothing
  is credited for it. If no active default return warehouse is configured, the recording is **refused**
  rather than crediting the money and dropping the units — set one in Settings → Warehouses and record
  the row again. A monetary-only park states no quantities and still records as money alone. Quantities
  on lines IMS cannot match to a product are recorded in the activity-log metadata
  (`unmatchedRefundedQty`) rather than refused — nobody, including the automatic route, can restock
  those.

### Why a target can be refused, and what fixes it

Each gross amount is divided by the rate the credit note will actually be re-grossed at — the rate of
the **accounting tax code** the refund line will carry, which is not always the rate the order line
appears to show. The rate the part of the order was **charged** at is read from the order's own money,
never from the current tax table, because a `TaxRate` row is mutable and editing one would otherwise
rewrite what past orders appear to have been billed:

- a sale line: `SalesOrderLine.totalForeign` / `taxForeign`;
- **shipping**: IMS stores no shipping-VAT column, so it is the VAT the order records over and above
  all of its lines (`SalesOrder.taxForeign` − Σ `SalesOrderLine.taxForeign`). `SalesOrder.taxRatePercent`
  is deliberately NOT used — it is the order's *header* default, which is shipping's rate only on a
  uniformly taxed order.

Where the two cannot be shown to agree, the target is refused rather than converted at a rate that will
not be used:

| Refusal | Fix |
|---|---|
| The line's tax rate has no accounting tax code (so it falls back to the order default) | Map it in Settings → Tax Rates |
| The code no IMS tax rate is mapped to, or that two rates price differently | Map one — and only one — sales rate to that code |
| The code prices at a different rate from the one the line was charged at | Map the line's tax rate to a code that matches the rate it was sold at |
| The order's default rate (`taxRateName`) is missing, renamed or deactivated — shipping has no identity | Restore/map that tax rate |
| The line is reverse-charged but no reverse-charge sales tax code is set | Set it in Settings → Accounting |
| The reverse-charge code has no IMS tax rate mapped to it | Map a 0% rate to it — an unmapped code is not a 0% one |
| The line records no usable money (no stored net, or figures too small to fix a rate) | Allocate the refund to the parts of the order that carry the money |
| "The VAT identity … changed while this refund was being recorded" | The tax configuration moved between the conversion and the posting. Nothing was credited — record the row again |

## The posted-VAT fence (every refund, not just hand-recorded ones)

Every refund line is stored **net** and its credit note is re-grossed by whatever the accounting tax
code it posts under is worth. So `createSalesOrderRefund` — the single writer every route goes through
(the refund dialog, the WooCommerce refund webhook and sweep, the payment poller's chargeback, and the
Record-manually path) — checks, inside the refund transaction that holds the order lock, that the
credit note would come to what the refund actually settles:

- the identity is resolved and priced exactly as the posting resolves it. An identity that cannot be
  established, that no tax rate is mapped to, or that two rates price differently is **refused** — an
  unmapped code is not a 0% one;
- what the money **bore** comes from the storefront when it states it (WooCommerce reports `total_tax`
  on every refunded line and shipping line — restating a stated figure needs no tax-code mapping), and
  otherwise from the order's own snapshot for that target;
- the two are compared **in money** — `net + tax` against `net × (1 + posted rate)`, to within the
  currency's minor unit — not as rates. A £2.00 line bearing £0.40 is an ordinary 20% line whose
  *derived rate* is too uncertain to pin down, and refusing it would name no remedy anyone could carry
  out; in money it is 2.40 against 2.40. The same line zero-rated against a 20% code is 2.00 against
  2.40 and is still caught, at any size;
- and then the refund is checked **as a whole**. A one-minor-unit tolerance is the right bound for one
  leg and the wrong bound for a refund made of many: £1.00 charged at 19% posting under a 20% code is
  out by exactly a penny every time, so a hundred such lines pass one by one while the credit note they
  add up to is £1.00 over the storefront refund. The aggregate check sums each leg's rate divergence in
  money and allows each leg only the rounding its own figures can actually carry — so legs that merely
  round awkwardly never accumulate past the slack, while a systematic rate error crosses the bound by
  the third leg;
- a **chargeback's** shipping and order-discount legs are checked as **one figure**. Neither can be
  checked alone on an order whose totals `createSalesOrder` wrote (the residue is `shipping VAT −
  discount VAT`), but the automatic chargeback emits both legs, both under the order default, so their
  combined net is exactly the amount that residue is the VAT of.

A refusal creates nothing. A WooCommerce refund is parked `QUARANTINED` (with the payload, so it can be
recorded by hand); the refund dialog shows the message. A **chargeback** refused this way is not a
retry cursor: the payment really is gone in the ledger and the refusal stands until an admin changes
the tax configuration, so the payment poller clears `paidAt`, alerts administrators and writes the
audit entry on the **first** failure, carrying the reason — rather than holding `paidAt` and showing
the order paid indefinitely. (A *transient* chargeback failure — an unjournaled shipment, a connector
outage — still holds `paidAt` and is re-attempted.) The revenue unwind is then outstanding and visible;
raise the credit note by hand, or restore the mapping and re-run the poller.

The **accounting retry** (`retryRefundAccounting`, and the sweep behind it) is a route into a credit
note in its own right — it re-queues or re-stages one for a refund that already exists — so it re-runs
the same fence against the tax table as it stands at retry time. The identity snapshotted on each
refund line fixes *which* code posts and nothing about what that code is *worth*; a rate edited,
remapped or unmapped between the failure and the retry is caught there. A refusal leaves
`accountingRetryRequired` set and records the reason on the refund, so the row stays visible until the
mapping is restored.

Two deliberate limits, so they are not mistaken for oversights:

- the check runs only when a **credit note will actually be posted** — the connector is active, its
  sync is enabled, and its `CREDIT_NOTE` type is not `off` (`isAccountingSyncTypeEnabled`). With no
  ledger entry going to be written, nothing re-grosses the stored net lines, so there is no
  credit-note total to be wrong about — and refusing would strand refunds on stores that map no
  accounting tax codes at all. Gating on plugin *activation* alone would quarantine refunds on a store
  that has deliberately switched credit-note posting off;
- a **shipping** leg whose VAT is inseparable (an order-level discount whose VAT `createSalesOrder`
  netted off the same total, on a non-WooCommerce order) is left unchecked rather than refused **on a
  non-chargeback refund**: IMS holds no record of what shipping bore there, so there is nothing to
  check against and no remedy to name. An order-level **discount** refund line is out of the per-leg
  fence for the same reason — on a chargeback the two are checked together, as above.

## Relationship to other surfaces

- The **FailedSyncBanner** (accounting sync-log rows) and **ConnectorOrphanBanner** keep their own retry paths on `/sync`; the inbox does not duplicate them.
- The Mintsoft panel's **Receipt Reviews** section still owns `REQUIRES_REVIEW` approvals (fresh-admin + review dialog); the inbox owns the `DEAD` tail that panel never showed.
- The admin API routes (`/api/admin/outbox/[id]/replay`, `.../permanent-fail`) remain available for tooling; the inbox's server actions call the same domain transitions (`lib/domain/integrations/outbox-admin.ts`).
- The unified "Needs attention" notification surface (bd `onetwo3d-ims-6oyu.11`) will build on this inbox's summary counts.
