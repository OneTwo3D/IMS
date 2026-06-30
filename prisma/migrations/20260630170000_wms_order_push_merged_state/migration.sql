-- G2 (vn92.2): a push link repointed to a merged survivor is parked MERGED so the
-- order-push sweep's SYNCED-filtered update/cancel/hold passes skip it (no dual-sync
-- corrupting the survivor), while dispatch-sync still polls it for despatch.
ALTER TYPE "WmsOrderPushState" ADD VALUE IF NOT EXISTS 'MERGED';
