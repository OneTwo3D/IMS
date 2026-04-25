-- Phase 4 of the unified-FX initiative (docs/todo/unified-fx-rates-plan.md).
-- Adds:
--   1. `source` and `manualOverride` columns on `fx_rates` so we can tell
--      a frankfurter-fetched rate apart from an admin-pinned override and
--      skip override currencies in the daily fetch.
--   2. New `fx_rate_push_log` table tracking outbound pushes to shopping
--      connectors so the Currencies settings page can show a real history
--      rather than just the most recent timestamp.

ALTER TABLE "fx_rates" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'frankfurter';
ALTER TABLE "fx_rates" ADD COLUMN "manualOverride" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "fx_rate_push_log" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "pushedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ratesCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,

    CONSTRAINT "fx_rate_push_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fx_rate_push_log_connector_pushedAt_idx" ON "fx_rate_push_log"("connector", "pushedAt" DESC);
