# 24rl design — point-in-time COGS/cost-basis reconstruction for as-of valuation

## Goal
Today `getOnHandAsOf` (lib/domain/inventory/get-on-hand-as-of.ts) FLAGS historical
valuations as `valueReplayReliable=false` when an in-scope cost layer was revalued
*after* the asOf date (the value reflects a later landed-cost/manufacturing basis,
not the point-in-time basis). 24rl wants to RECONSTRUCT the point-in-time value
instead of just flagging, using the `cost_layer_revaluations` event log
(oldUnitCostBase, newUnitCostBase, effectiveAt per layer; blq0).

## Current mechanics (verified)
- Value at asOf = `state` (snapshot rows OR current cost-layer aggregate) + movement
  reverse/forward `replayMovements`. Movements carry VALUE deltas, NOT cost-layer
  revaluations — so a revaluation effective after asOf is NOT unwound by replay.
- 3 paths: current_reverse_replay, snapshot_forward_replay, future_snapshot_reverse_replay.
- `countPostAsOfRevaluations()` counts in-scope revaluations in the post-asOf window;
  `buildResult` sets `valueReplayReliable=false` when count>0 (plus stale-snapshot count).
- Value is aggregated at (product,warehouse) level, NOT per cost layer.

## Reconstruction arithmetic
For a layer L: `unitCost_at_asOf(L) = current_unitCostBase(L) − Σ(newUnitCostBase −
oldUnitCostBase) over L's revaluations with effectiveAt in post-asOf window`
(telescoping = oldUnitCostBase of the earliest post-asOf revaluation of L).

Point-in-time value correction (amount to SUBTRACT from the reported value) =
`Σ over in-scope post-asOf revaluations of  reval_delta(L) × qty_of_L_reflected_in_reported_value`.

## THE OBSTACLE
The reported value is a (product,warehouse) aggregate from movement replay; it does
not isolate per-layer qty. `qty_of_L_reflected_in_reported_value` is only cleanly
knowable when L's remainingQty did not change between asOf and the basis date
(no consumption movement touched L in the window) — then it equals L's
current remainingQty and correction = `current_remainingQty(L) × reval_delta(L)`.

Determining "L had no qty change in (asOf, now]" requires a per-layer movement
linkage. Movements consume layers FIFO; the linkage is via cost-layer snapshots on
movements (needs confirmation it is queryable per layer).

## PROPOSED SAFE DESIGN (reconstruct-or-flag)
1. For each path, load in-scope post-asOf revaluations (layer id, reval_delta, the
   layer's current remainingQty).
2. For each revalued layer L, determine if L's qty was STABLE across the post-asOf
   window (no movement consumed/added L after asOf). 
3. If ALL in-scope post-asOf revaluations are on qty-stable layers: subtract
   `Σ current_remainingQty(L) × reval_delta(L)` from the reported value, set
   `valueReplayReliable=true`, and surface a `reconstructedRevaluationCount`.
4. If ANY revalued layer had window qty movement (not safely correctable): KEEP
   `valueReplayReliable=false` (today's behaviour) — never present a partial/wrong
   correction as reliable.

This strictly improves accuracy (more values become reliably reconstructed) and
never presents wrong-as-reliable; flagging stays the fallback (scjz.43 accepts it).

## Open questions for adversarial review
- Is the per-layer "qty stable in window" determination sound and cheaply queryable
  given how movements reference cost layers? Is there a cleaner signal?
- For snapshot_forward / future_reverse paths, the basis date differs (snapshot date
  vs now). Does `current_remainingQty(L)` need to be the remainingQty as of the
  ANCHOR/basis date rather than now? (current path basis = now; snapshot paths
  basis = snapshot date). Risk of using the wrong qty.
- Could a layer be revalued multiple times across the window with interleaved
  movements — does telescoping still hold?
- Is there a fundamentally simpler correct approach (e.g. a dedicated per-layer
  qty-at-asOf replay) that avoids the stability gymnastics, and is it worth it vs.
  the safe subset?
- Decimal/rounding: corrections at 6dp then round once (match scjz.65 sum-then-round).
