-- Additive: a read-only cache of Mintsoft's supplier list and the IMS supplier -> Mintsoft supplier decision table.
CREATE TABLE "mintsoft_suppliers" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "email" TEXT,
    "vat_number" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB,
    "last_seen_run_id" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missing_since" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mintsoft_suppliers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mintsoft_suppliers_external_id_key" ON "mintsoft_suppliers"("external_id");

CREATE TABLE "mintsoft_supplier_links" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "external_supplier_id" TEXT,
    "decision_source" TEXT NOT NULL,
    "suggestion_score" INTEGER,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mintsoft_supplier_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mintsoft_supplier_links_state_check" CHECK ("state" IN ('MAPPED', 'CREATE_PENDING', 'CREATING')),
    CONSTRAINT "mintsoft_supplier_links_mapped_has_id_check" CHECK ("state" <> 'MAPPED' OR "external_supplier_id" IS NOT NULL)
);

CREATE UNIQUE INDEX "mintsoft_supplier_links_supplier_id_key" ON "mintsoft_supplier_links"("supplier_id");
CREATE INDEX "mintsoft_supplier_links_external_idx" ON "mintsoft_supplier_links"("external_supplier_id");

ALTER TABLE "mintsoft_supplier_links" ADD CONSTRAINT "mintsoft_supplier_links_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
