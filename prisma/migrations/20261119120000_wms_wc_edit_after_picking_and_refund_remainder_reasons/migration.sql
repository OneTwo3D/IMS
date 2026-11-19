-- Additive: two new operator-task reasons (a WooCommerce edit after picking started; a refund remainder the warehouse is asked to send). No table or row is touched.
ALTER TYPE "WmsOperatorTaskReason" ADD VALUE 'WC_EDIT_AFTER_PICKING';
ALTER TYPE "WmsOperatorTaskReason" ADD VALUE 'REFUND_REMAINDER_DUE';
