-- Additive: one new operator-task reason, for a refund whose credit note Xero has voided while IMS could not unwind the refund (the refund
-- delete's phase 2 refused after the void). No table or row is touched.
ALTER TYPE "WmsOperatorTaskReason" ADD VALUE 'REFUND_DELETE_VOIDED_NOT_UNWOUND';
