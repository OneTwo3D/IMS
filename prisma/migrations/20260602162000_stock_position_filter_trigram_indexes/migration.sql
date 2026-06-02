-- prisma-schema-scope-ok: db-native trigram indexes | reason: Prisma schema cannot represent pg_trgm operator-class indexes or expression GIN indexes
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS warehouses_code_trgm_idx
  ON warehouses USING gin (code gin_trgm_ops);

CREATE INDEX IF NOT EXISTS warehouses_name_trgm_idx
  ON warehouses USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS warehouses_code_name_trgm_idx
  ON warehouses USING gin ((code || ' ' || name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS product_categories_name_trgm_idx
  ON product_categories USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS suppliers_name_trgm_idx
  ON suppliers USING gin (name gin_trgm_ops);
