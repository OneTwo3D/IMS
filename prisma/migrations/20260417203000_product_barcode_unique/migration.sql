-- Build unique index CONCURRENTLY to avoid write-blocking on the hot
-- products table. See 20260413200001 for the established pattern and
-- operator remediation steps if this fails partway.

CREATE UNIQUE INDEX CONCURRENTLY "products_barcode_key" ON "products"("barcode");
