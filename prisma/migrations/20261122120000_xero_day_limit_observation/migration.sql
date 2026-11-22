-- o3d-hvzdx: Xero's own count of the organisation's calls left in its rolling day (the X-DayLimit-Remaining header), as last seen by ANY
-- worker, so a worker that has not called Xero yet can still see the shared allowance. One row per tenant, overwritten.
-- Additive: a new table, nothing else changes.
CREATE TABLE "xero_day_limit_observations" (
  "tenant_id"     TEXT         NOT NULL,
  "day_remaining" INTEGER      NOT NULL,
  "observed_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "xero_day_limit_observations_pkey" PRIMARY KEY ("tenant_id")
);
