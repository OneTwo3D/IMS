-- Additive: a creation sequence on cost_layers, so "the latest layer" has a total order that does not depend on the cuid (which is not
-- monotonic) when two layers share a receivedAt. Used by the default addition cost of a stock adjustment (o3d-jwa8m). Nothing is dropped or
-- renamed; no existing reader selects the column.
CREATE SEQUENCE "cost_layers_created_seq_seq";

-- migration-convention-ok: ADD COLUMN NOT NULL because the default is a sequence, so existing rows are filled in the same statement and a predecessor build that inserts a layer without the column still gets a value
ALTER TABLE "cost_layers" ADD COLUMN "created_seq" INTEGER NOT NULL DEFAULT nextval('cost_layers_created_seq_seq');

ALTER SEQUENCE "cost_layers_created_seq_seq" OWNED BY "cost_layers"."created_seq";

-- The statement above numbered the existing rows 1..N in physical order. Renumber them (same values, permuted) by receivedAt then id, so
-- history is ordered the way it was received; rows created from now on continue after N.
UPDATE "cost_layers" AS c
SET "created_seq" = r.rn
FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "receivedAt", "id")::INTEGER AS rn FROM "cost_layers") AS r
WHERE r."id" = c."id";
