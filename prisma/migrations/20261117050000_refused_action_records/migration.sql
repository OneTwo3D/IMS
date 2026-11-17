-- Additive: one table recording actions a gate refused or stalled (entity, action, gate, permanence, severity, intent, first and last seen, resolved).
-- Nothing existing is touched. The unique key (entity_type, entity_id, action, gate) is what makes a repeat refusal one row.
CREATE TYPE "RefusedActionPermanence" AS ENUM ('PERMANENT', 'RETRYABLE');
CREATE TYPE "RefusedActionSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TABLE "refused_actions" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "permanence" "RefusedActionPermanence" NOT NULL,
    "severity" "RefusedActionSeverity" NOT NULL,
    "intent" JSONB,
    "detail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,
    "alerted_at" TIMESTAMP(3),

    CONSTRAINT "refused_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refused_actions_key" ON "refused_actions"("entity_type", "entity_id", "action", "gate");
CREATE INDEX "refused_actions_open_idx" ON "refused_actions"("resolved_at", "severity", "first_seen_at");
