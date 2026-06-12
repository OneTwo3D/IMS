-- Extend tax_rates into connector/reporting tax profiles while preserving the
-- existing single taxRateId/taxRatePercent document snapshot model.
ALTER TABLE "tax_rates"
  ADD COLUMN "is_compound" boolean NOT NULL DEFAULT false,
  ADD COLUMN "reverse_charge" boolean NOT NULL DEFAULT false,
  ADD COLUMN "reporting_category" text;

CREATE TABLE "tax_rate_components" (
  "id" text PRIMARY KEY,
  "tax_rate_id" text NOT NULL,
  "name" text NOT NULL,
  "rate" numeric(5,4) NOT NULL,
  "compound_on_previous" boolean NOT NULL DEFAULT false,
  "accounting_tax_type" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL,
  CONSTRAINT "tax_rate_components_tax_rate_id_fkey"
    FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rates"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "tax_rate_components_tax_rate_id_sort_order_idx"
  ON "tax_rate_components"("tax_rate_id", "sort_order");
