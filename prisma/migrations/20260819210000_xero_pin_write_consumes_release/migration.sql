-- A PIN RELEASE IS CONSUMED BY THE PIN, NOT BY THE CODE PATH THAT HAPPENS TO WRITE ONE (o3d-9tbz r9).
--
-- WHAT WAS WRONG. 20260819150000 made an absent Xero tenant pin a HALT unless the token row carries a
-- release receipt; 20260819180000 qualified that receipt with the connection and the pin it released,
-- and gave it no expiry on the explicit ground that "the receipt is consumed by the next binding". The
-- witness row added beside it in `settings` rests on the same claim. It held for `bindXeroTenant`,
-- which clears the receipt and deletes the witness inside the transaction that writes the pin. It did
-- not hold for the SYSTEM, because the pin has more than one writer:
--
--   scripts/provision-xero-demo.ts re-pins from the live connection on every ordinary run, writing the
--   `xero_expected_tenant_id` row directly rather than going through the binding. After the documented
--   Demo-reset recovery (release the pin -> re-consent -> re-provision) that is fine, because the
--   re-consent already consumed the release. Run in any other order -- and the script is run by hand,
--   on a rig, by whoever is fixing it -- a completed provision left the instance PINNED and still
--   carrying an outstanding release.
--
-- WHY THAT MATTERS, given the receipt is only read when the pin is missing. It is exactly the state the
-- halt exists to make impossible: one `DELETE FROM settings WHERE key = 'xero_expected_tenant_id'` --
-- or one settings-only restore, which is the scenario the halt was written for -- and the verdict is
-- `released` rather than `lost`. The receipt is qualified (it names this connection and this token's
-- organisation, and re-pinning changes neither) and the witness is still beside it, so both r7 and r8
-- pass and the sync proceeds unpinned. The bypass is reachable by running the documented provisioner.
--
-- WHY THE RULE IS IN THE DATABASE. Three writers have now been found maintaining this evidence by
-- hand, and r8's own finding was that per-writer evidence is fragile. A trigger on the pin row is a
-- statement about the STATE rather than about a call site: it covers `bindXeroTenant`, the provisioner,
-- a migration, a seed, `setSettings()` called with the wrong key, and `psql`. A future writer cannot
-- forget it, because there is nothing for it to remember.
--
-- IT ONLY EVER NARROWS. The trigger clears evidence that grants an EXEMPTION from the halt; it can
-- never create one. The worst it can do to an instance is halt a sync that a stale receipt would have
-- let through, which is the outcome being asked for.
--
-- IT CANNOT FIRE DURING A LEGITIMATE RELEASE. A release deletes the pin row, and DELETE does not fire
-- this trigger; while a release is outstanding there is no pin row to UPDATE. The only write it can
-- see on a released instance is the INSERT that re-establishes a pin -- which is the consumption.
CREATE OR REPLACE FUNCTION xero_pin_write_consumes_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The receipt on the token row: all three columns together, because a half-cleared receipt is
  -- `stale-release`, a refusal whose message sends the operator looking for a restore that never
  -- happened.
  UPDATE "accounting_tokens"
     SET "pinReleasedAt" = NULL,
         "pinReleasedGeneration" = NULL,
         "pinReleasedTenantId" = NULL,
         "updatedAt" = NOW()
   WHERE "connector" = 'xero'
     AND ("pinReleasedAt" IS NOT NULL
       OR "pinReleasedGeneration" IS NOT NULL
       OR "pinReleasedTenantId" IS NOT NULL);

  -- ...and the half that stayed behind in this table. Both halves of a release are written together
  -- and cleared together; one left on its own is a record about a state that has ended.
  DELETE FROM "settings" WHERE "key" = 'xero_pin_release_witness';

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS xero_pin_write_consumes_release ON "settings";

-- AFTER, so the pin is committed to the row before its release is consumed, and a failure in the
-- consumption rolls the pin write back with it rather than leaving the two disagreeing.
-- FOR EACH ROW with a WHEN clause, so every other settings write -- and there are many, on a hot table
-- -- pays nothing but the key comparison.
CREATE TRIGGER xero_pin_write_consumes_release
AFTER INSERT OR UPDATE ON "settings"
FOR EACH ROW
WHEN (NEW."key" = 'xero_expected_tenant_id')
EXECUTE FUNCTION xero_pin_write_consumes_release();

-- THE INSTANCES ALREADY IN THAT STATE. Every rig that has been re-provisioned since 20260819150000 is
-- pinned with an outstanding release sitting under the pin, waiting for someone to delete it.
--
-- This is not the backfill r8 refused, and the difference is the direction. That one would have
-- QUALIFIED receipts -- granting an exemption to rows that could not be told apart from laundered ones.
-- This one CLEARS them, and only where a pin is present: a row it touches is a row whose receipt is
-- currently being read by nothing at all, so no instance changes behaviour today, and the only thing
-- removed is a future exemption. An instance genuinely mid-recovery has no pin row, so the EXISTS is
-- false and its receipt is left exactly where it is.
UPDATE "accounting_tokens"
   SET "pinReleasedAt" = NULL,
       "pinReleasedGeneration" = NULL,
       "pinReleasedTenantId" = NULL
 WHERE "connector" = 'xero'
   AND ("pinReleasedAt" IS NOT NULL
     OR "pinReleasedGeneration" IS NOT NULL
     OR "pinReleasedTenantId" IS NOT NULL)
   AND EXISTS (SELECT 1 FROM "settings" WHERE "key" = 'xero_expected_tenant_id');

DELETE FROM "settings"
 WHERE "key" = 'xero_pin_release_witness'
   AND EXISTS (SELECT 1 FROM "settings" pin WHERE pin."key" = 'xero_expected_tenant_id');
