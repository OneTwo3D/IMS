-- 6oyu.1: adjustment reason used to book ALIGN_TO_WMS downward corrections.
-- Nullable add-column; align-down stays disabled until an operator picks a reason.
ALTER TABLE "external_wms_bindings" ADD COLUMN "alignDownReasonId" TEXT;

ALTER TABLE "external_wms_bindings"
  ADD CONSTRAINT "external_wms_bindings_alignDownReasonId_fkey"
  FOREIGN KEY ("alignDownReasonId") REFERENCES "adjustment_reasons"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- New nullable column: no existing rows reference a reason, so validation is instant.
ALTER TABLE "external_wms_bindings" VALIDATE CONSTRAINT "external_wms_bindings_alignDownReasonId_fkey";
