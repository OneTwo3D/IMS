-- The owed-despatch retry (retryOwedOutsideImsDespatches, every 15 minutes) scans the OPEN completion-refusal rows of woocommerce/SalesOrder.
-- The only other index on this table that could serve it is (connector, entityType, entityId), whose prefix matches nearly every order sync row.
-- A PARTIAL index keeps this one to the open rows, which are few. Additive only: it changes no row and no query result. The predicate is the text
-- openWcCompletionRefusalIndexPredicateSql() (lib/domain/sales/wc-sync-row-families.ts) renders, held character for character by
-- tests/prisma/wc-completion-refusal-open-index-migration.test.ts.
CREATE INDEX IF NOT EXISTS "shopping_sync_logs_open_wc_completion_refusal_idx"
  ON "shopping_sync_logs" ("entityId")
  WHERE connector = 'woocommerce'
  AND direction = 'FROM_CONNECTOR'
  AND "entityType" = 'SalesOrder'
  AND "recordKind" = 'WC_COMPLETION_REFUSAL'
  AND status = 'QUARANTINED';
