-- prisma-schema-scope-ok: db-native trigram indexes | reason: Prisma schema cannot represent pg_trgm operator-class indexes or expression GIN indexes
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS products_sku_trgm_idx
  ON products USING gin (sku gin_trgm_ops);

CREATE INDEX IF NOT EXISTS products_name_trgm_idx
  ON products USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS stock_movements_reference_type_trgm_idx
  ON stock_movements USING gin ("referenceType" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS stock_movements_reference_id_trgm_idx
  ON stock_movements USING gin ("referenceId" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS stock_movements_note_trgm_idx
  ON stock_movements USING gin (note gin_trgm_ops);

CREATE INDEX IF NOT EXISTS stock_transfers_reference_trgm_idx
  ON stock_transfers USING gin (reference gin_trgm_ops);

CREATE INDEX IF NOT EXISTS stock_count_lines_sku_trgm_idx
  ON stock_count_lines USING gin (sku gin_trgm_ops);
