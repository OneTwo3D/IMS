-- o3d-bjc.8: a created-but-unverified WMS order push link.
--
-- The create has already happened, so a verification failure must not leave the
-- sweep choosing between binding an unproven id and re-creating a real
-- warehouse order. PENDING_VERIFY is the third option: keep the minted id, and
-- retry only the ClientId-scoped verification.
ALTER TYPE "WmsOrderPushState" ADD VALUE IF NOT EXISTS 'PENDING_VERIFY' BEFORE 'SYNCED';
