-- Mixed-warehouse WMS push scope. ADDITIVE ONLY: a new enum, nullable columns (and one NOT NULL column with a constant default, which PostgreSQL
-- adds without rewriting the table) on wms_order_push_links, and two new tables. No existing row, column or constraint is changed; no backfill.
CREATE TYPE "WmsPushScopeMode" AS ENUM ('FULL', 'MIXED');

ALTER TABLE "wms_order_push_links" ADD COLUMN "scope_mode" "WmsPushScopeMode";
ALTER TABLE "wms_order_push_links" ADD COLUMN "scope_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "wms_order_push_links" ADD COLUMN "scope_hash" TEXT;
ALTER TABLE "wms_order_push_links" ADD COLUMN "scope_dirty_at" TIMESTAMP(3);
ALTER TABLE "wms_order_push_links" ADD COLUMN "scope_checked_at" TIMESTAMP(3);
ALTER TABLE "wms_order_push_links" ADD COLUMN "scope_frozen_at" TIMESTAMP(3);
ALTER TABLE "wms_order_push_links" ADD COLUMN "scope_frozen_reason" TEXT;
ALTER TABLE "wms_order_push_links" ADD COLUMN "scope_discount_minor" INTEGER;
ALTER TABLE "wms_order_push_links" ADD COLUMN "scope_shipping_minor" INTEGER;
ALTER TABLE "wms_order_push_links" ADD COLUMN "scope_vat_minor" INTEGER;
ALTER TABLE "wms_order_push_links" ADD COLUMN "despatch_settled_at" TIMESTAMP(3);

CREATE TABLE "wms_order_push_scope_lines" (
    "id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "scope_version" INTEGER NOT NULL,
    "order_line_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wms_order_push_scope_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wms_despatch_applications" (
    "id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "scope_version" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "shipment_ids" JSONB NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wms_despatch_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wms_order_push_scope_lines_link_id_scope_version_order_line_id_key" ON "wms_order_push_scope_lines"("link_id", "scope_version", "order_line_id");
CREATE INDEX "wms_order_push_scope_lines_link_id_idx" ON "wms_order_push_scope_lines"("link_id");
CREATE UNIQUE INDEX "wms_despatch_applications_idempotency_key_key" ON "wms_despatch_applications"("idempotency_key");
CREATE INDEX "wms_despatch_applications_link_id_idx" ON "wms_despatch_applications"("link_id");

ALTER TABLE "wms_order_push_scope_lines" ADD CONSTRAINT "wms_order_push_scope_lines_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "wms_order_push_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wms_despatch_applications" ADD CONSTRAINT "wms_despatch_applications_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "wms_order_push_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
