-- o3d-4kfh r6 (Codex finding 1): a graph-version CAS across the allocation and
-- commitment write protocols.
--
-- The dispatch-time proportionality backstop (findUncoveredCommittedShipment) is
-- NOT the correctness boundary it was claimed to be. It compares the committed
-- component set against the CURRENT graph, so a UNIFORM rescale of a kit escapes it
-- entirely: allocation reads 2xA+1xB, the editor rewrites the recipe to 4xA+2xB
-- before the allocation transaction commits, and the resulting A=2/B=1 commitment is
-- exactly proportional to the new recipe at coverage 0.5. Every flat check passes and
-- half a kit ships.
--
-- A version moves even when the proportions scale uniformly, which is precisely why
-- it catches this and proportionality cannot. Products carry the version; allocation
-- rows stamp the value they were computed against; commitment and dispatch refuse on
-- a mismatch and tell the operator to re-allocate.
--
-- Both columns default to 0 with a NOT NULL default, so every pre-existing product
-- and every pre-existing allocation row starts matched — no backfill, no false
-- refusals on the first deploy. Adding a NOT NULL column WITH a constant default is
-- metadata-only on Postgres 11+ (no table rewrite).
ALTER TABLE "products"
  ADD COLUMN "fulfillment_graph_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "order_allocations"
  ADD COLUMN "fulfillment_graph_version" INTEGER NOT NULL DEFAULT 0;
