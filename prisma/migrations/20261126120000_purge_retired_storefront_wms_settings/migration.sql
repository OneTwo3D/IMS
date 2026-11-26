-- Delete the settings rows left behind by the retired Shopify and ShipHero connectors, forward-only.
--
-- Both connectors were archived and their code is gone; nothing in this build reads or writes any of
-- these keys. They were kept only because lib/settings-store.ts had to keep the retired CREDENTIAL keys in
-- its sensitive set (admin-only reads, encryption at rest) for as long as a row for them may exist.
-- Deleting the rows here is what lets that list drop the keys.
--
-- Only `settings` rows are touched. Historical rows in other tables whose `connector` names a retired
-- connector are left alone: they are read through the generic unregistered-connector paths.
--
-- No trigger fires on these keys (the only settings trigger is keyed on xero_expected_tenant_id), the
-- statement is idempotent, and on an install that never ran either connector it deletes nothing.
-- The LIKE patterns escape the underscore so each matches its prefix literally.
--
-- prisma-schema-scope-ok: db-native data-only DELETE of settings rows; it changes no schema, so Prisma has nothing to model
DELETE FROM "settings"
WHERE "key" IN ('plugin_shopify_enabled', 'plugin_shiphero_enabled')
   OR "key" LIKE 'shopify\_%' ESCAPE '\'
   OR "key" LIKE 'shiphero\_%' ESCAPE '\';
