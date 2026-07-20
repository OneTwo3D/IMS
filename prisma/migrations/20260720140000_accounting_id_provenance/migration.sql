-- o3d-6nd: record which accounting connection issued each cached accounting id.
--
-- Product.accountingItemId and Customer/Supplier.accountingContactId cache an id owned by whichever
-- accounting connector is connected, with no record of WHICH connector or WHICH tenant/realm issued it.
-- The per-invoice lookups short-circuit on the stored id precisely so they never re-verify it. Clearing
-- the columns on disconnect is not enough: onboarding can flip the enabled connector WITHOUT a
-- disconnect, and re-authorising to a different Xero org has the same shape, so a stale id survives to be
-- read by a connection that never issued it.
--
-- Store the provenance ("<connector>:<tenantId>") beside each id. A reader ignores an id whose provenance
-- does not match the active connection and resolves it fresh, so correctness no longer depends on every
-- exit path remembering to clear.
--
-- Nullable + additive: existing cached ids get NULL provenance, which never matches an active
-- connection, so they re-resolve once on next use and stamp their own provenance — the same self-backfill
-- the id columns themselves used.
ALTER TABLE "products" ADD COLUMN "accountingItemProvenance" TEXT;
ALTER TABLE "customers" ADD COLUMN "accountingContactProvenance" TEXT;
ALTER TABLE "suppliers" ADD COLUMN "accountingContactProvenance" TEXT;

-- Backfill rather than force a mass re-resolution. At migration time there is at most one active
-- accounting connection (onboarding refuses to enable two at once), and every id already cached was
-- resolved against it — so its provenance IS that connection. Stamping it keeps those ids trusted and
-- avoids re-verifying the whole catalogue against Xero's 1,000-call/24h budget the moment this ships.
-- Only when EXACTLY one token row exists: zero or many is ambiguous, so those stay NULL and re-resolve
-- individually (correct, just not free).
UPDATE "products" p
  SET "accountingItemProvenance" = t."connector" || ':' || t."tenantId"
  FROM (SELECT "connector", "tenantId" FROM "accounting_tokens") t
  WHERE p."accountingItemId" IS NOT NULL
    AND (SELECT count(*) FROM "accounting_tokens") = 1;
UPDATE "customers" c
  SET "accountingContactProvenance" = t."connector" || ':' || t."tenantId"
  FROM (SELECT "connector", "tenantId" FROM "accounting_tokens") t
  WHERE c."accountingContactId" IS NOT NULL
    AND (SELECT count(*) FROM "accounting_tokens") = 1;
UPDATE "suppliers" s
  SET "accountingContactProvenance" = t."connector" || ':' || t."tenantId"
  FROM (SELECT "connector", "tenantId" FROM "accounting_tokens") t
  WHERE s."accountingContactId" IS NOT NULL
    AND (SELECT count(*) FROM "accounting_tokens") = 1;

-- Scope the id uniqueness by provenance (o3d-6nd). A single-column unique on the id would collide during
-- a realm switch: legacy customer A (id '2', old provenance) and re-resolved customer B (id '2', new
-- provenance) are DIFFERENT mappings, but the old index treats the bare '2' as one — throwing on the
-- contact update and failing invoice resolution, or (for products) looping re-lookups forever. Composite
-- uniqueness lets one id exist once PER connection, which is the real invariant.
-- Create the composite indexes BEFORE dropping the single-column ones, so a failure between the two
-- leaves the table with a superset of constraints rather than none. The names are exactly what Prisma
-- 7.8 derives for @@unique([id, provenance]) ("<table>_<field1>_<field2>_key"), so the post-deploy
-- drift check sees no difference between schema and database.
CREATE UNIQUE INDEX "products_accountingItemId_accountingItemProvenance_key" ON "products"("accountingItemId", "accountingItemProvenance");
CREATE UNIQUE INDEX "suppliers_accountingContactId_accountingContactProvenance_key" ON "suppliers"("accountingContactId", "accountingContactProvenance");
CREATE UNIQUE INDEX "customers_accountingContactId_accountingContactProvenance_key" ON "customers"("accountingContactId", "accountingContactProvenance");
DROP INDEX "products_accountingItemId_key";
DROP INDEX "suppliers_accountingContactId_key";
DROP INDEX "customers_accountingContactId_key";
