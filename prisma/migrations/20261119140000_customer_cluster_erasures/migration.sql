-- CRM CLUSTER ERASURE REQUESTS: the resolved member list of one whole-person erasure, saved BEFORE the first member is erased, so an erasure that fails
-- part way can be finished from the saved list (re-resolving would find fewer members: an anonymised customer leaves every cluster, and a member that was
-- reachable only through an anonymised one is lost). ADDITIVE ONLY: a new table; nothing reads it until the application that writes it is running.
--
-- Ids only: no name, email or free text, so the row is not personal data and survives the erasure as the proof of what was covered. NO FOREIGN KEYS, like
-- customer_merge_events: it is reached by id and must outlive any customer.
--   "memberIds"            the members in the order they are erased (the requested customer last)
--   "requestedCustomerId"  the customer the operator asked about
--   "status"               PENDING until every member is anonymised, then COMPLETE. While PENDING, merge and unmerge refuse the members.
-- prisma-schema-scope-ok: CHECK constraint | reason: Prisma cannot represent CHECK constraints

CREATE TYPE "CustomerClusterErasureStatus" AS ENUM ('PENDING', 'COMPLETE');

CREATE TABLE "customer_cluster_erasures" (
    "id" TEXT NOT NULL,
    "requestedCustomerId" TEXT NOT NULL,
    "memberIds" TEXT[] NOT NULL,
    "status" "CustomerClusterErasureStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "customer_cluster_erasures_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_cluster_erasures_members_nonempty" CHECK (cardinality("memberIds") >= 1),
    CONSTRAINT "customer_cluster_erasures_complete_stamped" CHECK (("status" = 'COMPLETE') = ("completedAt" IS NOT NULL))
);

CREATE INDEX "customer_cluster_erasures_status_idx" ON "customer_cluster_erasures"("status");
CREATE INDEX "customer_cluster_erasures_memberIds_idx" ON "customer_cluster_erasures" USING GIN ("memberIds");
