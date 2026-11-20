-- prisma-schema-scope-ok: db-native intentional no-op migration | reason: this folder name was committed on the unmerged, never-deployed branch before the migration moved to 20261121140000_inventory_in_transit_snapshot, and a committed migration may never be removed; it creates nothing, so there is no schema change for Prisma to represent
-- Intentionally a no-op. The DDL lives in 20261121140000_inventory_in_transit_snapshot. It runs before that migration on a fresh database, so it must not reference anything that migration creates.
SELECT 1;
