-- Operator notices on the WMS order push link.
--
-- A hold or cancel the warehouse cannot honour (the order is already past NEW, was not found, or is a
-- merged survivor holding other orders' goods) used to dead-letter the link, which took it out of dispatch
-- polling so a later despatch was never recorded. The link now stays live and carries a notice instead:
-- one timestamp per intent. Both are NULLABLE with no default, nothing backfills them, and a build that
-- does not know them neither reads nor writes them (NULL = no notice).
ALTER TABLE "wms_order_push_links" ADD COLUMN "hold_notice_at" TIMESTAMP(3);
ALTER TABLE "wms_order_push_links" ADD COLUMN "cancel_notice_at" TIMESTAMP(3);
