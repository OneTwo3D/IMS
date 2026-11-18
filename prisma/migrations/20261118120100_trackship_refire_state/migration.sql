-- Additive: the per-order state of the TrackShip re-fire sweep (a new table) and the consecutive-404 counter of the warehouse status snapshot
-- (two new columns with constant defaults, which PostgreSQL adds without rewriting the table). No existing row or column is changed.
CREATE TYPE "TrackshipRefireStatus" AS ENUM ('ACTIVE', 'COVERED', 'EXPIRED');

CREATE TABLE "trackship_refire_states" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" "TrackshipRefireStatus" NOT NULL DEFAULT 'ACTIVE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL,
    "last_attempt_at" TIMESTAMP(3),
    "last_result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trackship_refire_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trackship_refire_states_order_id_key" ON "trackship_refire_states"("order_id");
CREATE INDEX "trackship_refire_states_due_idx" ON "trackship_refire_states"("status", "next_attempt_at");

ALTER TABLE "trackship_refire_states" ADD CONSTRAINT "trackship_refire_states_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wms_order_status_snapshots" ADD COLUMN "notFoundStrikes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "wms_order_status_snapshots" ADD COLUMN "notFoundAt" TIMESTAMP(3);
