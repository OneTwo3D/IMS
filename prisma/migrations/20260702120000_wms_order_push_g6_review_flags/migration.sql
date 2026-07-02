-- G6 (vn92.5): non-blocking order-push review flags on wms_order_push_links.
-- courierPending: shipping service didn't map to a WMS courier (fell back to a default id);
--   operator should confirm the courier in the WMS. Auto-cleared when the order-status sweep
--   reports a resolved courier name.
-- totalMismatchPence: the order's own totals didn't reconcile to within a penny at push time.
-- migration-convention-ok: ADD COLUMN NOT NULL because it has a safe DEFAULT (false) valid for every historical row
ALTER TABLE "wms_order_push_links" ADD COLUMN "courierPending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "wms_order_push_links" ADD COLUMN "totalMismatchPence" INTEGER;
