-- expand-only
-- Per-event FX rates for purchasing, step 3 (behind the system switch `purchase_event_fx_rates_enabled`, default off).
-- PURCHASE_FX_VARIANCE: the GBP manual journal between Stock in Transit and Realised FX gains/losses that clears the difference a foreign supplier
-- bill leaves in transit when it is valued at another rate than the goods it covers. Nothing queues it while the switch is off.
--
-- ALTER TYPE ... ADD VALUE must run in its own migration because Postgres forbids it in the same transaction as any later DDL that uses the value.
ALTER TYPE "AccountingSyncType" ADD VALUE 'PURCHASE_FX_VARIANCE';
