-- Producer-side hold: make the attempt history fail CLOSED in the database.
--
-- The history columns of 20261017120000 are written by the application at claim time. A binary that does not write them (a rollback,
-- a mixed-version deploy, a psql session) could claim a "tracked" row without a stamp, and the retirement would later take a previously
-- attempted job for an unsent one. So the database enforces the rule for every writer:
--   * a claim (a transition into PROCESSING, a new claim time, or an attempts increment on the outbox; a new claim time on a queued create,
--     an attempts increment or a warehouse id on a link) whose resulting row has NO first-claim stamp FORFEITS the tracked flag, so the row
--     reads "unknown" and is parked, never shadowed;
--   * the tracked flag can never go from false to true by an UPDATE: only an INSERT sets it.
-- It only ever narrows (tracked -> untracked), the safe direction, and a statement that stamps itself is unaffected.
--
-- prisma-schema-scope-ok: db-native trigger | reason: Prisma cannot represent triggers, and the rule has to bind writers outside this repository
CREATE OR REPLACE FUNCTION integration_outbox_attempt_history_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."attempt_history_tracked" = false THEN
    NEW."attempt_history_tracked" := false;
  END IF;
  IF NEW."first_attempted_at" IS NULL AND (
       (NEW."status" = 'PROCESSING' AND (OLD."status" IS DISTINCT FROM 'PROCESSING' OR NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt"))
       OR NEW."attempts" > OLD."attempts"
     ) THEN
    NEW."attempt_history_tracked" := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS integration_outbox_attempt_history_guard ON "integration_outbox";
CREATE TRIGGER integration_outbox_attempt_history_guard
BEFORE UPDATE ON "integration_outbox"
FOR EACH ROW
EXECUTE FUNCTION integration_outbox_attempt_history_guard();

CREATE OR REPLACE FUNCTION wms_order_push_links_claim_history_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."claim_history_tracked" = false THEN
    NEW."claim_history_tracked" := false;
  END IF;
  IF NEW."first_claimed_at" IS NULL AND (
       (NEW."state" = 'PENDING_CREATE' AND NEW."lastAttemptAt" IS NOT NULL AND NEW."lastAttemptAt" IS DISTINCT FROM OLD."lastAttemptAt")
       OR NEW."attempts" > OLD."attempts"
       OR (NEW."externalOrderId" IS NOT NULL AND OLD."externalOrderId" IS NULL)
       OR (NEW."pushedAt" IS NOT NULL AND OLD."pushedAt" IS NULL)
     ) THEN
    NEW."claim_history_tracked" := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wms_order_push_links_claim_history_guard ON "wms_order_push_links";
CREATE TRIGGER wms_order_push_links_claim_history_guard
BEFORE UPDATE ON "wms_order_push_links"
FOR EACH ROW
EXECUTE FUNCTION wms_order_push_links_claim_history_guard();
