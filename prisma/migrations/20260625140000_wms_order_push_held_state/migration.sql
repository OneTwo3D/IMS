-- Add HELD to the WMS order-push state machine (Phase 8 slice B). Additive enum
-- value: orders put ON_HOLD after being pushed are cancelled in the WMS and
-- parked as HELD so a later release can re-push them.
ALTER TYPE "WmsOrderPushState" ADD VALUE IF NOT EXISTS 'HELD';
