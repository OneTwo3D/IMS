-- Additive: one new operator-task reason, for an amendment the warehouse order could not take because it was already past NEW. No table or row is touched.
ALTER TYPE "WmsOperatorTaskReason" ADD VALUE 'AMENDMENT_NOT_APPLIED';
