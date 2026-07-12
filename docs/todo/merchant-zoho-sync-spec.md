# Merchant -> Zoho Books Transaction Sync - IMS-Native Implementation Spec

**Owner:** Jan Schwarz (OneTwo3D / One Two Enterprises Ltd)  
**Target implementer:** Codex / Claude Code  
**Status:** Engineering-ready plan, with Zoho selected as a first-class IMS accounting backend  
**Stack:** IMS-native Next.js / TypeScript / Prisma / PostgreSQL  
**Base branch:** `development`  
**Last updated:** 2026-06-23  

## 1. Decision and objective

Zoho Books is being adopted as a full IMS accounting backend. The merchant transaction sync must therefore be implemented inside IMS, not as a standalone Python service.

The objective is to mirror every merchant transaction from Revolut Merchant, Stripe, PayPal, and eBay into Zoho Books at transaction granularity, using a per-provider/per-currency clearing-account model. Completed order payments are applied to existing Zoho sales invoices already known to IMS. The integration never creates sales invoices and never computes sales VAT.

This replaces the earlier open Option A / Option B decision:

- **Selected approach:** IMS-native TypeScript implementation.
- **Zoho scope:** first-class accounting connector alongside Xero and QuickBooks.
- **Merchant sync scope:** provider transaction ingestion, normalization, posting, reconciliation, retry, and dead-letter handling inside IMS.

## 2. Current IMS implications

Latest development currently has accounting connector paths hardcoded around Xero and QuickBooks in several places: connector discovery, settings UI, sync dashboard, queueing, cron, sync type maps, token handling, and connection tests. Zoho cannot be added safely as a narrow merchant-only client without creating a second accounting abstraction.

The plan must therefore start with the Zoho accounting connector foundation, then layer merchant settlement sync on top of that connector.

Existing IMS order and accounting data should be used for invoice matching:

- `SalesOrder` remains the IMS source of truth for order state.
- Existing accounting invoice IDs on orders are used to apply payments in Zoho.
- `ShoppingOrderLink` and external order numbers are used to resolve WooCommerce-backed provider references.
- eBay requires an explicit eBay order link path before eBay payment posting is enabled.

## 3. Accounting model

Use one Zoho clearing account per provider and currency.

| Logical role | Zoho account type | Ownership |
| --- | --- | --- |
| `{Provider} Clearing {CCY}` | Bank account, no feed | IMS writes merchant payments, refunds, fees, disputes |
| Payout destination bank | Feed-owned bank account | Bank feed imports provider payouts |
| Processing / marketplace fees | Expense | IMS posts provider fees |
| FX gain/loss | Income or expense | IMS posts PayPal FX and gateway FX edge cases |
| `{Provider} Dispute Suspense {CCY}` | Other current asset | IMS tracks unsettled chargebacks |

Ownership boundaries:

- IMS never posts same-currency payouts into feed-owned bank accounts.
- Payout destination bank feeds own the actual payout deposits.
- Bank rules transfer payout deposits from the relevant clearing account.
- Clearing accounts have no bank feed.
- Stripe and PayPal built-in Zoho feeds for merchant income must be disabled to avoid double posting.
- eBay replaces the current Link My Books path for eBay income once cut over.

VAT policy:

- IMS never computes or splits sales VAT for this sync.
- Zoho invoices already contain the correct VAT.
- eBay is UK-only and GBP-only for v1, with seller-accounted VAT. eBay `taxes[]` data is informational for this workflow.
- Marketplace/platform fee VAT treatment must be handled through configured Zoho fee accounts and tax codes.

## 4. Workable epics

Implement this plan as focused epics. Each epic can be one or more PRs, but avoid mixing provider-specific posting logic with connector foundation, migrations, or UI surfaces in the same PR.

### Epic 1 - Zoho connector registration and configuration

**Goal:** make `zoho` a recognized accounting connector in IMS without posting merchant transactions yet.

Deliverables:

- Add `zoho` to accounting connector discovery, settings UI, sync dashboard, token storage, connection testing, route-auth policy, and cron policy.
- Add Zoho organization ID and EU data center configuration.
- Implement OAuth/token refresh storage using existing IMS accounting-token patterns.
- Keep Xero and QuickBooks behavior unchanged.

Exit criteria:

- Admin can configure and connection-test Zoho.
- Existing Xero/QuickBooks tests and settings flows still pass.
- Zoho remains disabled for accounting sync until explicitly configured.

### Epic 2 - Zoho accounting API surface

**Goal:** add the Zoho operations IMS needs before merchant sync depends on them.

Deliverables:

- Add Zoho client methods for invoice read/lookup, customer payment creation, credit note or refund creation, bank transaction creation, chart-of-accounts lookup, and clearing-account balance reads where supported.
- Extend the shared accounting connector interface only where cross-connector semantics are clear.
- Keep Zoho-specific banking or clearing behavior behind Zoho-specific capability methods when Xero/QuickBooks do not share the same abstraction.
- Verify sandbox behavior for `bank_charges`; if unsupported or insufficient, implement the explicit clearing-account fee expense fallback.

Exit criteria:

- Zoho sandbox tests prove invoice read and customer-payment posting.
- Fee-posting strategy is decided and documented.
- No provider-specific merchant ingestion exists yet.

### Epic 3 - Merchant sync persistence and outbox core

**Goal:** create the durable IMS substrate for merchant events, normalized transactions, posting attempts, retries, and dead letters.

Deliverables:

- Add Prisma models for merchant transactions, payouts, disputes, raw webhook events, provider sync cursors, and posting attempts.
- Store all merchant money as integer minor units plus currency.
- Store gross, fee, FX fee, net, settled amount, and fee breakdowns explicitly.
- Add deterministic idempotency keys per provider.
- Persist raw payloads with secret redaction.
- Add async processing state: pending, posted, retryable failure, dead-lettered, reviewed.

Exit criteria:

- Migrations apply cleanly.
- Unit tests cover idempotency, status transitions, redaction, and retry/dead-letter rules.
- No provider can post to Zoho until the core outbox marks the transaction eligible.

### Epic 4 - Invoice matching and order-reference resolution

**Goal:** implement one fail-closed IMS contract for resolving provider payment references to existing Zoho invoices.

Deliverables:

- Resolve Revolut, Stripe, and PayPal order references to IMS orders using configured fields.
- Resolve WooCommerce-backed references through `SalesOrder`, external order numbers, and `ShoppingOrderLink`.
- Fail closed on no match, duplicate match, missing Zoho invoice ID, currency mismatch, or material amount mismatch.
- Add the eBay order-link source or backfill path, but keep eBay posting disabled until this is proven.

Exit criteria:

- Tests cover exact match, no match, duplicate match, missing invoice ID, currency mismatch, and amount mismatch.
- Matching never creates invoices and never guesses by customer/date/approximate amount.

### Epic 5 - Revolut Merchant MVP

**Goal:** ship the first low-complexity merchant rail end to end.

Deliverables:

- Implement Revolut webhook verification, transaction fetch, normalization, and GBP payment posting.
- Apply payments to existing Zoho invoices through the Zoho connector.
- Post or fallback-post fees according to the decision from Epic 2.
- Add replay-safe idempotency and dead-letter handling.

Exit criteria:

- Sandbox/live-small-value Revolut GBP payment can be ingested, posted, and reconciled through clearing.
- Duplicate webhook/replay does not duplicate Zoho postings.

### Epic 6 - Stripe provider and exact payout reconciliation

**Goal:** add Stripe payments with exact payout composition.

Deliverables:

- Implement Stripe webhook verification and balance-transaction normalization.
- Use balance transactions as the source of gross, fee, net, currency, and payout composition.
- Reconcile Stripe payouts by payout ID.
- Document cutover requirement to disable overlapping Zoho Stripe merchant-income integration.

Exit criteria:

- Stripe payment/refund/payout sandbox tests pass.
- Payout composition sums exactly to provider payout amount in minor units.

### Epic 7 - PayPal provider, reporting lag, and FX

**Goal:** add PayPal using poll-first ingestion and explicit FX handling.

Deliverables:

- Implement Transaction Search ingestion with rolling backfill.
- Finalize and test PayPal composite idempotency keys.
- Filter to balance-affecting transaction rows.
- Implement non-GBP to GBP conversion at PayPal's rate through the clearing model.
- Add PayPal dispute/refund mapping where API payloads support it.

Exit criteria:

- Tests cover reporting lag overlap, duplicate rows, sale, refund, FX conversion, and GBP withdrawal reconciliation.
- Built-in Zoho PayPal merchant-income feed is documented as disabled before cutover.

### Epic 8 - eBay Finances provider

**Goal:** add the eBay marketplace rail after order-linking and signed Finances calls are ready.

Deliverables:

- Implement eBay OAuth and mandatory EU/UK digital-signature request layer.
- Poll Finances API for `SALE`, `REFUND`, `DISPUTE`, and `NON_SALE_CHARGE`.
- Use Finances `transactionId` as the idempotency anchor.
- Resolve eBay `orderId` through the implemented eBay -> Woo/IMS order-link path.
- Post `NON_SALE_CHARGE` as clearing-account fee expenses.
- Reconcile payouts by `payoutId`.

Exit criteria:

- eBay sandbox tests cover signed calls, sale, refund, standalone fee, dispute, and payout reconciliation.
- eBay remains GBP-only for v1.
- Link My Books cutover is documented and not performed until reconciliation is proven.

### Epic 9 - Refunds, chargebacks, and dispute state machine

**Goal:** make negative and disputed money movements consistent across all providers.

Deliverables:

- Normalize refunds and fee credits.
- Implement the dispute state machine: created, won, lost.
- Post dispute suspense movements, reversals, losses, and dispute fees.
- Keep provider-specific status mapping isolated from the accounting posting logic.

Exit criteria:

- Tests cover refund, partial refund, chargeback created, won, lost, fee credit, and duplicate state-transition replay.

### Epic 10 - Operations UI, reporting, and replay

**Goal:** give operators a safe way to monitor and repair merchant sync.

Deliverables:

- Add admin views for merchant transactions, provider payouts, posting failures, dead letters, provider lag, clearing expectations, and payout mismatches.
- Add retry/replay actions only for failed or dead-lettered records.
- Add daily summary output for unmatched invoices, oldest unposted transaction age, dead-letter counts, expected clearing balances, payout mismatches, and Zoho posting failures.
- Add audit logs for retries, manual review, and dead-letter resolution.

Exit criteria:

- Accounting/admin users can identify and retry failures without database access.
- Non-admin users cannot see or trigger merchant sync repair actions.

### Epic 11 - Security, cutover controls, and production readiness

**Goal:** make the integration safe to enable provider by provider.

Deliverables:

- Add provider enable flags and dry-run mode per provider.
- Verify webhook signatures for every webhook-capable provider.
- Redact secrets, tokens, signatures, and sensitive payment identifiers in logs and payload views.
- Add fixed validated provider base URLs.
- Add cutover checklist for disabling overlapping provider feeds.

Exit criteria:

- Providers can be enabled independently.
- Dry-run can be compared against expected Zoho postings before live posting.
- Production cutover can proceed one provider at a time.

### Epic 12 - End-to-end cutover and reconciliation hardening

**Goal:** prove that clearing accounts drain correctly in production-like conditions.

Deliverables:

- Run small live-value cutovers provider by provider.
- Verify bank-feed payout deposits and bank rules drain clearing accounts.
- Compare IMS expected clearing balances to Zoho balances if Zoho APIs support it; otherwise produce manual reconciliation reports.
- Document residual operational procedures for mismatches and stuck dead letters.

Exit criteria:

- Each enabled provider has a proven sale, refund, payout, and reconciliation path.
- Clearing accounts return to expected balances after payouts.
- eBay is migrated off Link My Books only after eBay payout reconciliation is proven.

## 5. Posting flows

### Payment completed

1. Insert or load merchant transaction by provider idempotency key.
2. Fetch/normalize provider transaction.
3. Validate gross, fees, FX fees, net, settled currency, and state.
4. Resolve IMS order and Zoho invoice.
5. Post Zoho customer payment against the existing invoice.
6. Book processing fees using Zoho `bank_charges` if confirmed supported for the required scenario; otherwise post an explicit clearing-account expense/bank transaction.
7. Mark transaction posted with Zoho object IDs.

### Payout completed

No same-currency payout is posted directly to the feed-owned destination bank.

- Stripe and eBay: hard-reconcile exact payout composition against provider transaction totals.
- Revolut and PayPal GBP: reconcile using balance trend and provider payout data.
- PayPal non-GBP: post provider FX conversion through IMS/Zoho, then let the GBP bank feed drain the GBP payout.

### Refunds

Resolve the original order/invoice. Post the refund or credit-note path supported by Zoho and the connector contract. Preserve provider fee credits separately where exposed by the provider.

### Chargebacks and disputes

Use a state machine:

- Created: move from clearing to dispute suspense.
- Won: reverse the suspense movement.
- Lost: write off to chargeback loss and post dispute fees.

Persist every transition idempotently.

### eBay standalone fees

Post `NON_SALE_CHARGE` transactions as clearing-account expenses using the configured eBay fee account map. These transactions are part of payout reconciliation and must not be duplicated by order-level fee stitching.

## 6. External API verification requirements

Before implementation of each provider or Zoho posting path, verify the live API documentation and sandbox behavior.

Zoho must be verified for:

- customer payment creation against existing invoices,
- whether `bank_charges` works for the required fee-booking model,
- fallback posting model for fees if `bank_charges` is insufficient,
- credit note/refund APIs,
- bank transaction APIs from clearing accounts,
- account balance/reconciliation read capabilities,
- rate limits and EU data center behavior.

eBay must be verified for:

- Finances API pagination and filters,
- digital-signature headers,
- `SALE`, `REFUND`, `NON_SALE_CHARGE`, and dispute payloads,
- fee breakdown signs,
- payout composition,
- UK sandbox coverage.

PayPal must be verified for:

- Transaction Search permission activation,
- transaction ID uniqueness assumptions,
- event-code mapping,
- balance-affecting filters,
- reporting lag and overlap-window behavior.

## 7. Configuration

Required IMS configuration:

- Zoho OAuth client ID/secret.
- Zoho organization ID.
- Zoho data center/region.
- Per-provider/per-currency clearing account IDs.
- Destination bank account IDs for documentation and reconciliation.
- Fee account IDs and eBay fee-type mapping.
- Dispute suspense accounts.
- FX gain/loss accounts.
- Provider API credentials and webhook secrets.
- Provider enable flags.
- Dry-run mode per provider.
- Cutover flags to prevent duplicate built-in provider feeds.

Secrets must remain in the existing IMS secret/config mechanism and must not be committed.

## 8. Security and authorization

- All merchant sync admin UI and retry actions require appropriate IMS admin/accounting permissions.
- Webhook endpoints must verify provider signatures before accepting events.
- Webhook endpoints should persist and return quickly; heavy work must be asynchronous.
- Provider API clients must use fixed, validated base URLs.
- Logs and stored raw payload views must redact secrets, tokens, signatures, and sensitive payment identifiers.
- Replays must be idempotent and auditable.
- Retry actions must only be available for failed or dead-lettered items.

## 9. Reconciliation and operations

Add IMS operational views for:

- merchant transactions,
- provider payouts,
- posting failures,
- dead letters,
- provider sync lag,
- clearing-account expected balances,
- payout reconciliation mismatches.

Daily reporting should include:

- dead-letter count by provider,
- unmatched invoice count,
- oldest unposted transaction age,
- expected clearing balance by provider/currency,
- payout mismatches,
- failed Zoho posting attempts.

If Zoho account balance APIs are sufficient, compare IMS expected clearing balances to Zoho balances. If not, expose IMS expected balances and provide a manual Zoho reconciliation report.

## 10. Tests

Unit tests:

- Provider normalization for Revolut, Stripe, PayPal, and eBay.
- Integer minor-unit amount math.
- Fee breakdown handling.
- FX conversion handling.
- Idempotency-key generation.
- Invoice matching success/failure cases.
- Refund and dispute state transitions.

Integration tests:

- Zoho OAuth/token refresh.
- Zoho customer payment posting.
- Zoho fee posting fallback.
- Merchant ingest -> normalize -> post -> reconcile lifecycle.
- Retry and dead-letter behavior.
- Existing Xero and QuickBooks paths remain unchanged.

Security tests:

- Webhook signature verification.
- Replay/idempotency protection.
- Admin-only retry and visibility.
- Secret redaction.

Migration tests:

- Prisma migrations apply cleanly.
- Existing accounting sync logs and connector settings remain valid.
- Zoho starts disabled until configured.

Provider sandbox tests:

- Revolut GBP happy path.
- Stripe payment/refund/payout reconciliation.
- PayPal sale/refund/FX/payout lag behavior.
- eBay signed request, sale, refund, `NON_SALE_CHARGE`, dispute, and payout reconciliation.

## 11. Cutover plan

1. Deploy Zoho connector disabled.
2. Configure Zoho OAuth and chart-of-accounts mappings.
3. Enable dry-run merchant ingestion for one provider.
4. Compare dry-run expected postings to Zoho manually.
5. Enable posting for small live amounts.
6. Verify clearing behavior and payout bank rules.
7. Repeat provider by provider.
8. Disable overlapping built-in provider feeds before full cutover.
9. Migrate eBay off Link My Books only after eBay payout reconciliation is proven.

## 12. Non-goals for v1

- Creating sales invoices in Zoho.
- Computing sales VAT.
- Posting same-currency provider payouts into feed-owned bank accounts.
- Pushing data back to WooCommerce, eBay, PayPal, Stripe, or Revolut.
- Multi-entity support.
- SaaS multi-tenant isolation beyond the existing IMS deployment model.

## 13. Open decisions before implementation

These must be closed before coding their respective stages:

- Exact Zoho fee-posting model after sandbox verification of `bank_charges`.
- Zoho refund/credit-note model for each provider's refund shape.
- Stripe metadata key used for IMS order references.
- PayPal field used for IMS order references and final composite idempotency key.
- eBay order-link source and backfill strategy.
- eBay fee-type to Zoho account/tax-code mapping.
- Whether Zoho balance APIs are reliable enough for automated clearing-balance comparison.
