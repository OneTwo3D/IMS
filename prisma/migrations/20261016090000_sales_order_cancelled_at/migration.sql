-- WHEN WAS THIS ORDER CANCELLED? A fact measured by the DATABASE clock, not by whichever writer moved the status.
--
-- A payment made after an order was cancelled and one made while it was still active are booked differently
-- (the first is money the customer owed nothing for; the second is a cancelled-but-paid order that takes the
-- ordinary credit-note path). Telling them apart needs the instant of cancellation, and `SalesOrder` had none:
-- the only `cancelledAt` in the schema belongs to a warehouse push link and records a different event.
--
-- The instant is stamped by a trigger, for the reason the paid-episode marker is (20260901090000): a fence
-- that compares two instants needs ONE clock, and `status` is written by the importer's status mapping, by
-- the order state machine and by repair scripts alike. `clock_timestamp()` rather than `now()` (statement time,
-- not transaction start), AT TIME ZONE 'UTC' because the column is TIMESTAMP WITHOUT TIME ZONE holding UTC.
--
--   status becomes CANCELLED   (INSERT, or UPDATE from anything else)     -> stamped now
--   status stays CANCELLED                                                -> the stored value stands, whatever the
--                                                                            statement says (a writer cannot move it)
--   status is anything else                                               -> NULL (a bypass that reopens an order
--                                                                            ends the episode; a later cancellation
--                                                                            is a new one)
--
-- NO BACKFILL. NULL means "not known", and every reader treats it as such (a tie or an unknown instant takes
-- the ordinary credit-note path). Production is unused, so there is no history to reconstruct, and inventing
-- an instant for an order already cancelled would be a guess dressed as a measurement.
ALTER TABLE "sales_orders" ADD COLUMN "cancelled_at" TIMESTAMP(3);

-- prisma-schema-scope-ok: db-native trigger | reason: Prisma cannot represent triggers, and the instant must be minted by the database for writers outside this repository, including a previous release serving across a deploy
CREATE OR REPLACE FUNCTION sales_order_stamp_cancelled_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM 'CANCELLED' THEN
    NEW."cancelled_at" := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'CANCELLED' THEN
    NEW."cancelled_at" := OLD."cancelled_at";
    RETURN NEW;
  END IF;
  NEW."cancelled_at" := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_order_stamp_cancelled_at_trigger ON "sales_orders";

CREATE TRIGGER sales_order_stamp_cancelled_at_trigger
BEFORE INSERT OR UPDATE ON "sales_orders"
FOR EACH ROW
EXECUTE FUNCTION sales_order_stamp_cancelled_at();
