-- Producer-side hold: a durable history of whether a queued unit of outbound work was ever attempted.
--
-- Additive only: four nullable / defaulted columns, no data change and NO BACKFILL. Every row that exists when this
-- migration runs has "*_history_tracked" = false, which means "unknown": the held-backlog retirement never calls such
-- a row "never sent", it parks it. Only rows created by a binary that writes the marker (tracked = true) can ever be
-- retired as unsent, and then only while the first-attempt column is still empty.
--
-- "first_attempted_at" / "first_claimed_at" are written when a worker claims the unit (before any request can leave)
-- and are never cleared by a replay, a re-arm, a retry or a release; the single exception is an outbox claim that was
-- refused by the outbound-write hold before anything left AND created the stamp itself (compare-and-set on the claim's
-- own timestamp), so an earlier real attempt can never be erased.
ALTER TABLE "integration_outbox"
  ADD COLUMN "attempt_history_tracked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "first_attempted_at" TIMESTAMP(3);

ALTER TABLE "wms_order_push_links"
  ADD COLUMN "claim_history_tracked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "first_claimed_at" TIMESTAMP(3);
