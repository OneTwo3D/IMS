-- Delete the settings rows left behind by the retired QuickBooks connector, forward-only.
--
-- The connector was archived and its code is gone; nothing in this build reads or writes any of these
-- keys. They were kept only because lib/settings-store.ts must keep a retired CREDENTIAL key in its
-- sensitive set (admin-only reads, encryption at rest) for as long as a row for it may exist, and
-- lib/connectors/accounting-binding-lock-order.ts excluded the realm pin from wholesale settings deletes.
-- Deleting the rows here is what lets both lists drop the keys.
--
-- Only `settings` rows are touched. Historical rows in other tables whose `connector` names the retired
-- connector are left alone: they are read through the generic unregistered-connector paths.
--
-- No trigger fires on these keys (the only settings trigger is keyed on xero_expected_tenant_id), the
-- statement is idempotent, and on an install that never ran the connector it deletes nothing.
DELETE FROM "settings"
WHERE "key" = 'plugin_quickbooks_enabled'
   OR "key" LIKE 'quickbooks\_%' ESCAPE '\';
