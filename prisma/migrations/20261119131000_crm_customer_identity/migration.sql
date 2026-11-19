-- CRM FOUNDATION: customer identity overlay + the storefront customer id on each order.
--
-- ADDITIVE ONLY: one nullable column and a new table. NO BACKFILL here: the column fills from the order importer going forward, and from
-- already-stored payloads through scripts/crm-backfill-order-customer-id.ts (an operator step, dry run by default, no storefront call).
-- No predecessor binary reads or writes either, so no verification-required entry.

ALTER TABLE "sales_orders" ADD COLUMN "external_customer_id" INTEGER;

CREATE TYPE "CustomerMergeEventKind" AS ENUM ('MERGE', 'UNMERGE');
CREATE TYPE "CustomerMergeEventSource" AS ENUM ('AUTO_EMAIL', 'OPERATOR');

-- NO FOREIGN KEYS, deliberately: the rows are an audit trail that must outlive any customer or user. A pair whose customer is gone can never match
-- again (cuid ids are not reused), so it is inert. The table holds ids only (no name, email or free text).
CREATE TABLE "customer_merge_events" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "kind" "CustomerMergeEventKind" NOT NULL,
    "source" "CustomerMergeEventSource" NOT NULL,
    "customerId" TEXT NOT NULL,
    "otherCustomerId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_merge_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_merge_events_seq_key" ON "customer_merge_events"("seq");
CREATE INDEX "customer_merge_events_customerId_idx" ON "customer_merge_events"("customerId");
CREATE INDEX "customer_merge_events_otherCustomerId_idx" ON "customer_merge_events"("otherCustomerId");

-- THE SHAPE A ROW MUST HAVE. The pair is stored once, smaller id first, so "the newest row of a pair" is one lookup; an OPERATOR row names the
-- person who decided; an AUTO_EMAIL row is a MERGE and names nobody (the system decided).
-- prisma-schema-scope-ok: db-native check constraints and an insert-only trigger | reason: Prisma cannot represent CHECK constraints or triggers
ALTER TABLE "customer_merge_events"
  ADD CONSTRAINT "customer_merge_events_pair_ordered" CHECK ("customerId" < "otherCustomerId"),
  ADD CONSTRAINT "customer_merge_events_actor_matches_source" CHECK (
    ("source" = 'OPERATOR' AND "decidedByUserId" IS NOT NULL AND btrim("decidedByUserId") <> '')
    OR ("source" = 'AUTO_EMAIL' AND "decidedByUserId" IS NULL AND "kind" = 'MERGE')
  );

-- INSERT-ONLY: every UPDATE, DELETE and TRUNCATE is refused. A decision is corrected by a NEWER row (an unmerge undoes a merge), never by editing history.
CREATE OR REPLACE FUNCTION customer_merge_events_insert_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'customer_merge_events is insert-only: % refused', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS customer_merge_events_insert_only ON "customer_merge_events";
CREATE TRIGGER customer_merge_events_insert_only
BEFORE UPDATE OR DELETE ON "customer_merge_events"
FOR EACH ROW
EXECUTE FUNCTION customer_merge_events_insert_only();

DROP TRIGGER IF EXISTS customer_merge_events_no_truncate ON "customer_merge_events";
CREATE TRIGGER customer_merge_events_no_truncate
BEFORE TRUNCATE ON "customer_merge_events"
FOR EACH STATEMENT
EXECUTE FUNCTION customer_merge_events_insert_only();
