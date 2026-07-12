-- q66in.4.4: scheduled order-level reconciliation runs get their own job type.
ALTER TYPE "WmsSyncJobType" ADD VALUE IF NOT EXISTS 'ORDER_RECONCILE';
