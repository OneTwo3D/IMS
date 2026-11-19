-- CRM cluster erasure: who cancelled a request and when, and the members an operator EXCLUDED from it (a record wrongly included in the merged person; kept so a later
-- re-resolve of the cluster does not add it back). Ids only, like the rest of the table: the reason an operator gives is kept in the activity log, not here.
-- ADDITIVE ONLY: new nullable / defaulted columns on a table nothing reads them from until the application that writes them is running.
-- prisma-schema-scope-ok: CHECK constraint | reason: Prisma cannot represent CHECK constraints
ALTER TABLE "customer_cluster_erasures"
  ADD COLUMN "excludedMemberIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledByUserId" TEXT,
  ADD CONSTRAINT "customer_cluster_erasures_cancelled_stamped" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));
