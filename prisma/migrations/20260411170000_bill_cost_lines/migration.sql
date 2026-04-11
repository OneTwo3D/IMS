-- Make poLineId optional and add costLineId + description for billing additional cost lines
ALTER TABLE "purchase_invoice_lines" ALTER COLUMN "poLineId" DROP NOT NULL;
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "costLineId" TEXT;
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "description" TEXT;

ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_costLineId_fkey"
  FOREIGN KEY ("costLineId") REFERENCES "freight_cost_lines"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "purchase_invoice_lines_costLineId_idx"
  ON "purchase_invoice_lines"("costLineId");
