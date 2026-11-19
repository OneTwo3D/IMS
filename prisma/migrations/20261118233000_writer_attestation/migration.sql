-- Additive: owner and host confirmations that an incumbent writer has stopped (switchover o3d-zvec.3).
CREATE TABLE "writer_attestations" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "attested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "writer_attestations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "writer_attestations_kind_attested_idx" ON "writer_attestations"("kind", "attested_at");
