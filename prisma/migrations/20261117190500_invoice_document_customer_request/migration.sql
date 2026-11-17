-- A customer's first click on an order whose invoice IMS does not hold yet is QUEUED on the document's fetch state instead of being
-- fetched inline: the time of that request. NULL for every existing row and for every document the sweep fetches by itself.
-- Additive: one nullable column and one index; nothing is rewritten.
ALTER TABLE "invoice_document_fetch_states" ADD COLUMN "customer_requested_at" TIMESTAMP(3);

CREATE INDEX "invoice_document_fetch_states_customer_requested_at_idx" ON "invoice_document_fetch_states"("customer_requested_at");
