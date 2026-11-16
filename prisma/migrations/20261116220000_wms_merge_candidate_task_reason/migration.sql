-- Additive: one new operator-task reason, for same-customer orders that are all still NEW in the warehouse (merge-candidate flagging, off by default). No table or row is touched.
ALTER TYPE "WmsOperatorTaskReason" ADD VALUE 'MERGE_CANDIDATE';
