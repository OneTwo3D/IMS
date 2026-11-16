-- Additive: the stable EPISODE of a courier-fallback operator task that is due. Written together with the due-marker (courier_task_service),
-- BEFORE the warehouse call, and used by every retry of that task, so one fallback is one task whichever pass records it. Nullable: a marker
-- written before this column has no episode and keeps the service-only task key.
ALTER TABLE "wms_order_push_links" ADD COLUMN "courier_task_episode" TIMESTAMP(3);
