-- #1127 R2 MED-1: the Xero calls the credit-note settlement and duplicate checks spend, per UTC day, shared by every sync run (cron and "Sync now") on every host.
-- Additive: a new table, nothing else changes. The allowance it guards is the ORGANISATION's (1,000 calls per rolling 24 hours on this plan), shared with Xeroom.
CREATE TABLE "xero_settlement_call_budget" (
  "day"  DATE    NOT NULL,
  "used" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "xero_settlement_call_budget_pkey" PRIMARY KEY ("day")
);
