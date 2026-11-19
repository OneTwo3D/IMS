-- Additive: records that a customs field (hsCode / countryOfOrigin / customsDescription) of a product was EMPTIED, i.e. went from a value to nothing. Only that transition is evidence that the warehouse copy should be cleared; a field that was never set is not (an unset origin was historically declared as the CN default). No existing table or column is touched.
CREATE TABLE "product_customs_clears" (
    "productId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_customs_clears_pkey" PRIMARY KEY ("productId", "field")
);

ALTER TABLE "product_customs_clears" ADD CONSTRAINT "product_customs_clears_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The marker is kept by the database so EVERY write path (product editor, bulk CSV edit, the WooCommerce import, anything else) records the transition identically, and no application write can forget it. A populated -> empty change inserts the marker; the field being populated again removes it. Blank text counts as empty.
CREATE FUNCTION product_customs_clear_marker() RETURNS trigger AS $$
BEGIN
  IF NULLIF(btrim(OLD."hsCode"), '') IS NOT NULL AND NULLIF(btrim(NEW."hsCode"), '') IS NULL THEN
    INSERT INTO "product_customs_clears" ("productId", "field") VALUES (NEW."id", 'hsCode') ON CONFLICT DO NOTHING;
  ELSIF NULLIF(btrim(NEW."hsCode"), '') IS NOT NULL THEN
    DELETE FROM "product_customs_clears" WHERE "productId" = NEW."id" AND "field" = 'hsCode';
  END IF;
  IF NULLIF(btrim(OLD."countryOfOrigin"), '') IS NOT NULL AND NULLIF(btrim(NEW."countryOfOrigin"), '') IS NULL THEN
    INSERT INTO "product_customs_clears" ("productId", "field") VALUES (NEW."id", 'countryOfOrigin') ON CONFLICT DO NOTHING;
  ELSIF NULLIF(btrim(NEW."countryOfOrigin"), '') IS NOT NULL THEN
    DELETE FROM "product_customs_clears" WHERE "productId" = NEW."id" AND "field" = 'countryOfOrigin';
  END IF;
  IF NULLIF(btrim(OLD."customsDescription"), '') IS NOT NULL AND NULLIF(btrim(NEW."customsDescription"), '') IS NULL THEN
    INSERT INTO "product_customs_clears" ("productId", "field") VALUES (NEW."id", 'customsDescription') ON CONFLICT DO NOTHING;
  ELSIF NULLIF(btrim(NEW."customsDescription"), '') IS NOT NULL THEN
    DELETE FROM "product_customs_clears" WHERE "productId" = NEW."id" AND "field" = 'customsDescription';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "products_customs_clear_marker"
AFTER UPDATE OF "hsCode", "countryOfOrigin", "customsDescription" ON "products"
FOR EACH ROW EXECUTE FUNCTION product_customs_clear_marker();
