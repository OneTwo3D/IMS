-- Delivery stamps for the warehouse-visible note that goes with a hold / cancel notice.
--
-- The notice is recorded first and the note posted second, and a failed note used to be forgotten. Each stamp is NULL until the note
-- has actually been posted; the push sweep retries undelivered notes. NULLABLE, no default, no backfill: an existing notice reads as
-- undelivered and its note is posted once.
ALTER TABLE "wms_order_push_links" ADD COLUMN "hold_notice_comment_at" TIMESTAMP(3);
ALTER TABLE "wms_order_push_links" ADD COLUMN "cancel_notice_comment_at" TIMESTAMP(3);
