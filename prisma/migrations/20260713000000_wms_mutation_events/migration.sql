-- q66in.4.6: audit-grade timeline of connector mutations — one row per
-- IMS↔WMS state change with operational before/after images.
CREATE TYPE "WmsMutationDirection" AS ENUM ('OUTBOUND', 'INBOUND');
CREATE TYPE "WmsMutationOutcome" AS ENUM ('SUCCEEDED', 'FAILED');

CREATE TABLE "wms_mutation_events" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "direction" "WmsMutationDirection" NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" "WmsMutationOutcome" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "externalId" TEXT,
    "summary" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "error" TEXT,
    "jobId" TEXT,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wms_mutation_events_pkey" PRIMARY KEY ("id")
);

-- Leading createdAt index: the unfiltered timeline feed sorts on (createdAt, id)
-- and the retention purge filters on createdAt alone (Codex r1).
CREATE INDEX "wms_mutation_events_createdAt_idx" ON "wms_mutation_events"("createdAt");
CREATE INDEX "wms_mutation_events_connector_createdAt_idx" ON "wms_mutation_events"("connector", "createdAt");
CREATE INDEX "wms_mutation_events_entityType_entityId_idx" ON "wms_mutation_events"("entityType", "entityId");
-- Standalone id indexes: the timeline's entity search is `entityId = X OR
-- externalId = X` with no entityType constraint (Codex r2).
CREATE INDEX "wms_mutation_events_entityId_idx" ON "wms_mutation_events"("entityId");
CREATE INDEX "wms_mutation_events_externalId_idx" ON "wms_mutation_events"("externalId");
CREATE INDEX "wms_mutation_events_action_createdAt_idx" ON "wms_mutation_events"("action", "createdAt");
