-- Additive: one new operator-task reason, for a warehouse order the status sweep found absent on several consecutive polls. No table or row is touched.
ALTER TYPE "WmsOperatorTaskReason" ADD VALUE 'ORDER_NOT_FOUND';
