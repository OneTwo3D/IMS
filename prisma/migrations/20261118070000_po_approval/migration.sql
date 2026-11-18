-- Purchase order approval (setting po_approval_threshold_base). Additive only: six nullable columns, no default, no backfill.
-- A row with "approvedAt" NULL is "not approved", which is what every existing order is; nothing changes while the threshold setting is unset.
ALTER TABLE "purchase_orders"
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvedTotalBase" DECIMAL(18,4),
  ADD COLUMN "approvedSupplierId" TEXT,
  ADD COLUMN "approvedCurrency" TEXT;
