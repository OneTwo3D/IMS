# Refund in transit (slice 1 of 3)

A refund of goods that were shipped does not mean the goods are back. Today IMS restocks them the moment the refund
is recorded, and a second restock follows when the Mintsoft returns inbox sees the parcel arrive. This work holds the
returned units **in transit** until they arrive.

This page describes slice 1 (the document, the refund routing, the transit journal and the transit sub-ledger). It
ships **switched off**, and slices 2 and 3 are not built. Read "What is not built yet" before switching it on.

## The switch

Setting `refund_returns_in_transit_enabled`. It reads exactly `true`; any other value, including an empty or absent
row, is off. There is no screen for it (the settings page refuses keys it does not list): it is set in the database
by whoever runs the cut-over. With it off, a refund behaves exactly as before: the units are restocked at refund time
and the COGS reversal debits Inventory.

The decision is taken **once per refund**, inside the refund transaction under the order lock, and stored on the
refund (`return_in_transit`). An accounting retry reads the refund, never the switch, so a switch flipped between a
refund and its retry cannot make one refund's journal debit Inventory on one attempt and Stock in Transit on the next.
A refund is in transit only if it returns stock (it has a return warehouse) and is not a chargeback.

## What a refund does when it is in transit

| Step | Legacy (switch off) | In transit (switch on) |
|---|---|---|
| Stock | `RETURN_INBOUND` movement, stock level up, a cost layer per snapshot row | nothing: no movement, no stock level, no cost layer |
| Available to sell, allocate, push to the storefront | yes, at refund time | no: the post-commit allocator and storefront stock push receive an empty list |
| COGS reversal journal | DR Inventory / CR COGS | DR **Stock in Transit** / CR COGS, same amount, date and idempotency key |
| Transit sub-ledger | no row | `+` the 6dp reversal base, source `CUSTOMER_RETURN_IN_TRANSIT`, same key as the journal |
| Document | none | one `return_expectations` row per refund, one `return_expectation_lines` row per (refund line, product) carrying the dispatch-cost snapshot; written in the refund's own transaction (see "Nothing committed without its companion") |
| Account missing | n/a | no Stock in Transit account configured: staging fails closed, the refund stays on the accounting retry list, **no Inventory fallback** |

The value on the document is the refund's own dispatch-cost snapshot (the originally posted COGS), summed unrounded and
rounded to 6dp once: the same arithmetic as the reversal's 6dp base, so the two compare exactly with no tolerance. A
difference is recorded as the activity `return_expectation_value_mismatch` (counts only).

The transit sub-ledger row is written in the same transaction that queues the journal, on the queue's own answer, and
**not** when the producer seam recorded the journal as a shadow: a shadow posts nothing, so a sub-ledger row for it
would be a movement the general ledger never makes and the daily transit reconciliation would flag it for ever.

## Nothing committed without its companion

A refund that routes its goods in transit must never commit without the records that make the goods traceable. Every
step of the refund flow that writes a companion record was audited for a committed-but-companion-missing state:

| Step | Companion record | Same commit as | If the step fails or the process dies between steps |
|---|---|---|---|
| Refund created | mode flag `return_in_transit` | the refund INSERT (one statement) | cannot be missing: it is a column of the row |
| Refund created | the return expectation document (unvalued, from the refund's quantities) | the refund transaction, under the order lock | a failed document write rolls the WHOLE refund back (tested); a replayed webhook finds the committed refund and its document |
| Accounting staging | the document's cost snapshot, `valued_at` and ledger link (journal key and amount) | the staging transaction that persists the staged syncs and the refund's staging witness | a failure while valuing rolls the staging back with it; the refund stays owing its accounting (`accounting_retry_required` is armed at the refund INSERT, whenever staging will follow) and the retry values the document |
| Accounting retry (initial, persisted-sync replay, re-stage) | same as staging | the retry's staging transaction | a retry that finds persisted syncs FIRST verifies the document: valued and linked to the persisted journal, or rebuilt from the refund's own stored cost snapshot and valued against the journal's amount (an earlier build may never have written it); if it cannot be rebuilt (snapshot or layer missing, or the snapshot does not add up to the journal) the replay refuses, with a closed code, and hands no journal back; a retry that re-stages values it |
| Journal queued | transit sub-ledger row | the transaction that queues the COGS reversal, on the queue's own answer | a crash after the staging commit and before the queue leaves the obligation armed; the queue and the row are one commit, so the row exists exactly when a non-shadow journal is queued |
| No staging to follow (accounting off) | none to wait for | the document is valued in the refund transaction | n/a |

An unvalued document is not usable: nothing may receive against or write off a document with `valued_at` null (slice 2
must enforce it, and the settle step refuses a document that already carries an accounted quantity). Replacing the
document's lines is allowed only while unvalued, and a valued document is never rewritten (first write wins).

### Known limit: successive partial kit refunds

Later partial refunds of a kit estimate the components already returned from `RETURN_INBOUND` movements. An in-transit
refund writes none until its goods arrive (slice 2), so a second partial kit refund on the same order can over-estimate
the components still returnable. Not fixed in slice 1; it only matters once the switch is on.

## Accounting accepted by the owner

* Refund: DR Stock in Transit / CR COGS (slice 1).
* Arrival: DR Inventory / CR Stock in Transit at the snapshot cost (slice 2).
* Never returned: after the alert (30 days, configurable) an operator writes the units off to COGS, DR COGS / CR Stock
  in Transit. There is no separate write-off account (slice 2).
* The existing Stock in Transit account is used, so the existing daily transit reconciliation covers the new source.

## What is not built yet

**Do not switch it on until slice 2 exists.** With the switch on and only slice 1 deployed:

* The refund no longer restocks, but the Mintsoft returns inbox **still** restocks on arrival (and, as today, creates no
  cost layer for it). The document never closes and the value stays in Stock in Transit.
* Nothing clears or writes off a document.

| Slice | Content |
|---|---|
| 2 | Returns inbox receives against the document (matched by order and product, oldest refund first, partial and over-return handling), the arrival journal and sub-ledger row, early returns auto-clearing when unambiguous, the operator write-off and the 30-day alert, the "Returns in transit" panel, and the receipts table |
| 3 | A forced storefront stock push for the refunded products on the refund webhook, behind `wc_stock_sync_enabled` |
| later | Treating refunded units of a partly shipped line as the **unshipped** ones first (owner-accepted, not built: it changes the shipped/unshipped split that stock, the per-line cap and COGS share, so it needs its own change); the WooCommerce-side restock filter |

## Outbound writers

Slice 1 adds **no new outbound writer**. The only journal involved is the existing `COGS_REVERSAL`, whose debit account
changes for an in-transit refund; it goes through the same enqueue, the same producer seam (legacy, live, shadow;
`PRODUCER_HOLD_ENFORCED_DESTINATIONS` unset is byte-identical to legacy) and the same ownership-map row
(`xero.inventory.journals`) as before. `npm run writers:check` and `npm run check:shadow-readers` need no new row.
Slice 2 adds two journals of existing types (`STOCK_RECEIPT`, `INVENTORY_ADJUSTMENT`) and must register them.

## Readers of the COGS reversal that were audited

Anything that assumes a refund's COGS reversal debits Inventory had to be found. None reads the debit account:

| Reader | What it reads | Affected? |
|---|---|---|
| `cogs-gl-reconciliation` | the COGS account's period movement against the COGS sub-ledger | no: the credit to COGS and the COGS sub-ledger row are unchanged |
| inventory GL reconciliation | GL Inventory against the sum of cost-layer value | improves: no layer exists for in-transit units, and no longer a debit to Inventory for them |
| transit GL reconciliation | GL Stock in Transit movement against the transit sub-ledger | covered: the new source adds the row that matches the new debit |
| accounting invariants, reconciliation | the existence and type of the refund's sync rows | no: type and reference are unchanged |
| `prior-posting-evidence`, `unrecorded-posted-document`, `compacted-followup-loss`, `mirrored-sync-types` | type-keyed tables | no |
| `landed-cost-service`, `cost-layers` (shipment COGS revaluation, also type `COGS_REVERSAL`) | shipment-scoped reversals, not the refund's | no |

## Review themes audited up front

| Theme | Where it applies | What was done |
|---|---|---|
| Decision and write apart (TOCTOU) | the switch is read once under the order lock and persisted on the refund; the retry reads the refund | the document is created under a per-refund transaction lock; a recorded ledger link is never changed and a different one is refused |
| Starved oldest-first queue | none added | n/a |
| False findings for items from before the cut-off | refunds made before the switch have `return_in_transit = false` and no document | no backfill; they read as legacy and are never judged by the new rules |
| Unreadable treated as fine | the switch read throws instead of answering off; a missing Stock in Transit account fails closed; the plan refuses a row it cannot attribute | tests for each |
| Count or aggregate standing in for identity | lines are per (refund line, product), not per product; every line must belong to the refund (the foreign key alone would accept another refund's line) | database test |
| Ordering from timestamps | none: order is by the document's own keys | n/a |
| Looks empty so skipped | an empty return creates no document, by an explicit `none` outcome, not by a quiet skip | test |
| Outcome stays OK after a recorded failure | a staging failure leaves the refund flagged for retry and creates no document; the value mismatch is recorded as a WARNING | tests |
| Secrets or untrusted values in text | closed codes and counts only (`return_expectation:<code>`, the mismatch activity) | test asserts no SKU in the text |
| Double posting | the journal key and the sub-ledger key are the existing COGS reversal key (first write wins); one document per refund (unique); the retry and the first attempt cannot both create it | unit, database and concurrency tests |
| Rounding and tolerance | money and quantities are `Decimal`; one rounding of the unrounded sum at 6dp; the comparison with the journal base is exact | plan tests |
| Shadow | the transit row is not written for a shadowed journal | unit and source-pin tests |

## Migration

Additive. One column with a constant default (`sales_order_refunds.return_in_transit`, false), one enum and two new
tables nothing else reads. Safe on a populated database while the previous build serves: it omits the column on INSERT
and gets the legacy default. CHECK constraints hold the invariants in the database: a line's received plus written-off
quantity never exceeds its quantity, and a document's ledger key and amount are both present or both absent. The
factory reset clears the new tables first.
