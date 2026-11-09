-- Drop the retired Kit and KitItem tables, forward-only.
--
-- A KIT product is consumed at sale and never manufactured; its recipe is its ProductComponent list, which
-- every allocation, reservation and availability reader uses. Kit/KitItem were a second, unwritten copy whose
-- only reader was the KIT-filtered inventory aging report, now removed. Bundles and BOMs cover every case.
--
-- The guard refuses to drop a table that holds rows: dropping data is a decision for an operator, not a side
-- effect of a deploy. Production is schema-only, and stage is checked by this guard rather than assumed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "kit_items") OR EXISTS (SELECT 1 FROM "kits") THEN
    RAISE EXCEPTION 'kits / kit_items hold rows; export or clear them deliberately before this migration drops the tables';
  END IF;
END
$$;

DROP TABLE "kit_items";
DROP TABLE "kits";
