-- o3d-nf9i r3: record HOW a terminal accounting_sync_logs status was reached.
--
-- The per-row settlement action lets an operator assert "this DID post, here is the document id".
-- That wrote status='SYNCED' + external_transaction_id — byte-identical to what the connector's own
-- writeback produces after a real, successful remote call. Every reader that asks "did this post?"
-- therefore read an unverified human assertion as a ledger confirmation.
--
-- It matters most on the money path. settlement-status.ts compares the amount IMS INTENDED to send
-- (from the row payload) against the document total, and calls the pair matching SETTLED. On an
-- asserted row nothing sent that amount: Xero accepts a payment smaller than the invoice as a PART
-- payment, so the operator's document id can perfectly well name a part payment while the two local
-- numbers agree. A monetary-only comparison has to fail closed there, and it can only know to do
-- that if the basis is written down.
--
-- NULL = the connector's own writeback (a confirmation). 'OPERATOR_ASSERTION' = a human's statement,
-- verified by nothing. Nullable with no default, so this is metadata-only on Postgres 11+ and every
-- existing row correctly reads as connector-written.
ALTER TABLE "accounting_sync_logs"
  ADD COLUMN "settlement_basis" TEXT;
