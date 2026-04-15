# Xero Follow-Up Plan

Date: 2026-04-14
Branch baseline: `main` at commit `e207543`

## Goal

Close the remaining review items after the Xero batch-accounting and refund FIFO fixes already merged in `e207543`.

## Current status

Already fixed:
- Revenue deferral and recognition now use net revenue instead of gross-with-VAT.
- Foreign-currency invoice and credit-note line amounts now use order currency amounts.
- Refund COGS and allocation reversals now use persisted historical FIFO snapshots.
- A2 and B now persist allocation/shipment FIFO history.
- Returned stock can recreate cost layers from refund snapshots.
- Xero sync logs now use a `PROCESSING` claim step to reduce double-post risk.
- Failed daily-batch logs are automatically reset for reprocessing.
- Seeded E2E coverage exists for mixed shipped/unshipped refund reversal and return-stock layer recreation.

Still open / partial:
- VAT liability posting is not implemented yet.
- Xero idempotency header is not implemented yet.
- Failed-log recovery still relies on requeue logic rather than a stricter `SYNCED`-driven completeness model.
- Preview COGS still mutates/consumes the preview snapshot in a way that can surprise operators.

## Work items

### 1. Add explicit VAT liability posting

Problem:
- Revenue is now net, but VAT still is not posted to a dedicated liability account in the daily-batch/sub-ledger flow.

Required changes:
- Add a new Xero/accounting setting for output VAT liability account.
- Extend settings UI and validation so the account is required when Xero sync is enabled.
- Decide exact posting model:
  - Preferred: keep A1/B on net revenue only, and post VAT separately when the invoice event crystallises the tax.
  - Alternative: add paired deferral/release VAT journals if that better matches the intended sub-ledger architecture.
- Update journal builders so VAT never lands in sales or unearned revenue accounts.
- Add targeted test coverage for VAT-bearing orders and zero-tax orders.

Questions to resolve:
- Should VAT post at invoice creation, at payment, or as part of A1?
- Should shipping VAT be treated identically to product VAT in the same liability posting?

Definition of done:
- A VAT-bearing order creates a tax liability posting to the configured tax account.
- Sales/unearned revenue balances remain net of tax.
- Automated coverage asserts the expected account codes and amounts.

### 2. Add Xero idempotency key support

Problem:
- The `PROCESSING` claim step fixes the main race, but Xero still has no request-level idempotency safeguard.

Required changes:
- Extend the Xero API client to send `Idempotency-Key` where supported.
- Derive the key from `accountingSyncLog.id` or another immutable sync-log identifier.
- Confirm which Xero endpoints in use support the header and apply it consistently.
- Add logging so duplicate retries are diagnosable.

Definition of done:
- Replaying the same sync-log post uses the same idempotency key.
- Client code documents which endpoints are covered and which are not.

### 3. Tighten failed-sync completeness model

Problem:
- Daily-batch rows now requeue automatically, but source-row completeness is still inferred from date flags plus reset logic.

Required changes:
- Review whether source-row eligibility should instead derive from successful sync-log state.
- Evaluate one of these approaches:
  - Option A: keep current date flags but add a reconciliation job that recreates or resets orphaned logs more explicitly.
  - Option B: gate A1/A2/B eligibility on matching `SYNCED` logs rather than only source-row dates.
- Document the intended operational model so Finance can understand retry/recovery behavior.

Recommendation:
- Start with Option A unless Option B can be introduced without destabilizing the current flow.

Definition of done:
- There is a deterministic recovery path for every failed daily-batch row.
- We can explain exactly why an eligible source row will not be silently skipped forever.

### 4. Fix preview-batch FIFO behavior

Problem:
- Preview mode still behaves differently enough from posting mode that operators can be surprised.

Required changes:
- Review preview snapshot handling in `app/actions/xero-daily-batch.ts`.
- Either:
  - make preview mirror posting logic more closely, or
  - clearly label preview as non-binding / approximate in the UI.
- Add a small regression test if practical.

Definition of done:
- Preview results are either operationally trustworthy or explicitly marked as indicative only.

## Suggested order

1. VAT liability posting
2. Xero idempotency key
3. Failed-sync completeness hardening
4. Preview-batch behavior cleanup

## Suggested next-session starting checklist

1. Re-read `docs/xero-followup-plan.md`.
2. Inspect current Xero settings model and decide where the VAT liability account should live.
3. Confirm the intended tax crystallisation point with the business/accounting owner.
4. Implement VAT posting first, because it is the largest remaining accounting gap.

## Additional follow-up

### 5. Move WooCommerce sync to webhook/on-demand first, cron as backup

Problem:
- The current WooCommerce sync cron still handles primary order import and product polling on a 5-minute schedule.
- Desired architecture is webhook/on-demand first, with cron acting only as reconciliation/backup.

Required changes:
- Move WooCommerce order import to webhook-first processing instead of relying on the polling cron as the primary path.
- Review whether any remaining IMS -> WC actions still depend on polling instead of immediate push.
- Keep a scheduled reconciliation path, but reduce it to backup behavior, ideally daily.
- Audit the current `wc-sync` cron responsibilities and split them into:
  - primary real-time webhook/on-demand flows
  - backup reconciliation flows
- Confirm how missed webhooks, retries, and duplicate event handling will be managed once order import becomes webhook-first.

Questions to resolve:
- Should WC order webhook processing import immediately on `order.created` / `order.updated`, or queue durable jobs first?
- Which parts of WC product sync still need polling when webhooks are configured and reliable?
- Should stock retry draining stay frequent, or move to its own lightweight retry worker/cron?

Definition of done:
- WooCommerce order import is webhook-first.
- The existing frequent `wc-sync` cron is no longer needed for normal operations.
- A backup reconciliation cron remains in place, likely daily, to catch missed events and drift.
