# Unified Voucher, Credit, and Loyalty Sync Implementation Plan

## Purpose

This document replaces the earlier gift card and voucher-only plan.

It is now the implementation baseline for a unified IMS module covering:

- gift cards
- refund-issued store credit
- marketing vouchers
- loyalty points mirrored from shopping platforms
- points converted into vouchers

The plan is intentionally aligned to the current connector architecture in this repository so future implementation can land through existing shopping and accounting seams rather than creating a parallel integration model.

## Existing Connector Baseline

The current codebase already has the right top-level connector structure:

- shopping facade: `lib/shopping.ts`
- accounting facade: `lib/accounting.ts`
- shared connector contracts: `lib/connectors/types.ts`
- WooCommerce connector: `lib/connectors/woocommerce/index.ts`
- Shopify connector: `lib/connectors/shopify/index.ts`
- Xero connector: `lib/connectors/xero/index.ts`
- QuickBooks connector: `lib/connectors/quickbooks/index.ts`

This module should extend those abstractions, not bypass them.

## Connector References

These official references should be treated as the starting point for connector implementation and payload validation:

- WooCommerce REST API: <https://developer.woocommerce.com/docs/apis/rest-api/>
- Shopify Admin GraphQL API: <https://shopify.dev/docs/api/admin-graphql/latest>
- Shopify Gift Card API surface: <https://shopify.dev/docs/api/admin-graphql/latest/objects/GiftCard>
- Shopify Store Credit Account API surface: <https://shopify.dev/docs/api/admin-graphql/2025-07/objects/storecreditaccount>
- Xero Accounting API overview: <https://developer.xero.com/documentation/api/accounting/overview>
- QuickBooks Online Accounting API overview: <https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api>

Useful WooCommerce extension references for likely first adapters:

- WooCommerce Smart Coupons: <https://woocommerce.com/document/smart-coupons/>
- WooCommerce Points and Rewards: <https://woocommerce.com/document/woocommerce-points-and-rewards/>

## Business Goal

Build an IMS-native Stored Value and Loyalty module that acts as the internal operational and financial control layer for:

- gift cards
- refund credits
- marketing vouchers
- mirrored loyalty balances
- points-to-voucher conversions

The module must:

- remain shopping-platform agnostic
- remain accounting-system agnostic
- identify vouchers by code
- support partial redemption and repeated redemption until exhausted
- restore consumed value accurately on refund
- support SPV and MPV classification
- support multi-currency and tax-jurisdiction snapshots
- provide complete audit history
- tolerate partial or low-fidelity upstream data

## Source of Truth

### Shopping platforms own

- customer-facing voucher issuance and redemption UX
- loyalty earning rules
- checkout FX used at redemption
- storefront-side voucher and loyalty presentation
- raw source events where available

### IMS owns

- voucher and credit ledger state
- mirrored loyalty balances and event history
- code-based voucher identification
- issue-currency anchored stored value balance
- accounting classification and event generation
- reconciliation, audit, and operational reporting

### Accounting systems own

- final booked journals and commercial documents
- external accounting identifiers
- posting status in the external ledger

## Architecture

Implement the feature as two peer ledgers, one shared service layer, and one downstream adapter layer.

### 1. Voucher and Credit Ledger

Owns:

- voucher master data
- stored-value balances
- voucher code lookup
- redemption and refund restoration history
- voucher application allocation
- voucher lifecycle state

### 2. Loyalty Sync Ledger

Owns:

- mirrored points balances
- mirrored points transactions
- expiry tranches where available
- conversion bridge between points and vouchers
- mismatch and sync-state tracking

### 3. Tax and Valuation Service

Owns:

- SPV / MPV / discount classification
- issue-currency anchoring
- checkout FX snapshot handling
- refund restoration valuation rules
- jurisdictional tax snapshots

### 4. Accounting Event Adapter

Owns:

- normalized accounting events
- account routing via profiles
- connector-specific posting logic
- retries, reversal handling, dead-letter queues, and reconciliation

The call graph should be:

- connectors normalize platform-specific events into canonical IMS events
- voucher ledger and loyalty ledger consume only canonical IMS events
- tax and valuation service is called synchronously by the ledgers
- accounting adapter consumes normalized accounting events emitted by the ledgers

This keeps platform-specific rules inside `lib/connectors/*` and preserves the platform-agnostic claim for the ledger layer.

## Core Principles

1. Vouchers are not inventory and must not be represented as stock items.
2. Loyalty points are mirrored in IMS, not earned or recalculated in IMS.
3. Stored-value voucher balance is authoritative only in issue currency.
4. Refunds restore the original issue-currency amount previously consumed.
5. All value movement is immutable and represented by ledger entries plus reversals.
6. Connector ingestion and accounting posting must be idempotent.
7. Tax classification and FX context must be snapshotted at event time.
8. The system must remain usable even when a source platform only exposes balances, not full transaction history.
9. Source-platform-specific logic must stay in connector packages; the ledger layer only accepts canonical events.
10. For multi-jurisdiction tenants like onetwo3d, MPV is the default stored-value tax classification unless SPV can be positively evidenced.

## Domain Model

Implement the following core entities.

### Voucher side

- `voucher`
- `voucher_transaction`
- `voucher_application`
- `voucher_tax_profile`
- `voucher_expiry_policy`
- `voucher_reservation`

### Shared finance side

- `accounting_event`
- `accounting_profile`

### Shared identity side

- `customer_identity`

### Loyalty side

- `loyalty_points_account`
- `loyalty_points_transaction`
- `loyalty_points_expiry_tranche`
- `loyalty_points_conversion`

These entities should preserve correlation to:

- orders
- refunds
- source-platform event ids
- voucher codes and references
- customers
- external accounting records

`customer_identity` should be keyed by source platform and source customer id, with optional merge relationships. Loyalty balances must not auto-merge across platforms. A customer may be represented in one IMS profile view, but Woo loyalty, Shopify loyalty, Woo gift cards, and Shopify store credit remain separate source instruments unless an explicit finance operation links them.

`accounting_profile` should use a discriminator-based shape rather than separate duplicated voucher and loyalty routing tables. Voucher and loyalty routing can still expose type-specific views in application code, but the underlying persistence model should avoid duplicated connector account fields.

## Voucher Rules

### Voucher identification

IMS must identify vouchers using submitted code or source reference through:

- connector-specific normalization rules
- hashed lookup
- masked display in UI
- encrypted full-code storage only when operationally necessary

Hashed lookup must use HMAC-SHA256 with a server-held secret separate from the database, not a bare unsalted hash.

Default UI masking should show first 4 and last 4 characters only.

Voucher lifecycle statuses should be explicit and shared across voucher types:

- `DRAFT`
- `ACTIVE`
- `HELD`
- `PARTIALLY_REDEEMED`
- `REDEEMED`
- `EXPIRED`
- `VOIDED`

`HELD` is used for fraud review, chargeback review, and other finance locks. Validation must reject redemption for held vouchers unless an explicit finance override path exists.

The override path is a permission-gated manual finance action only. There is no automatic or public programmatic override path in phase 1.

### Voucher validation

Before applying a voucher, IMS must validate:

- status
- expiry
- customer restriction
- channel restriction
- redemption mode
- sufficient balance

Transferability defaults:

- gift cards: transferable by default
- refund credits: non-transferable by default and customer-bound where customer identity exists
- marketing vouchers: configurable

Customerless issuance must be supported for gift cards and some marketing vouchers.

Refund credits issued for guest checkouts should bind to the guest order and billing email or equivalent source identity token when no durable customer record exists.

### Voucher application model

`voucher_application` is required in phase 1 because refund correctness depends on it.

It must capture:

- voucher id
- optional reservation id
- order id
- optional order line id
- checkout currency amount applied
- issue-currency amount consumed
- functional-currency amount
- FX source, rate, and timestamp
- application status

Canonical idempotency keys are mandatory in phase 1.

Default composition:

- redemption idempotency key = hash(source_platform, source_order_id, source_order_line_id_or_order_scope, voucher_code_hmac, sequence_number)
- reversal idempotency key = hash(original_redemption_idempotency_key, "reversal", reversal_sequence)

All canonical voucher lifecycle events require deterministic idempotency keys using the same composition pattern, including issuance, activation, redemption, reversal, refund restoration, expiry, and hold-state transitions where they are event-driven from a source platform.

`sequence_number` must be explicit in connector normalization so retries can be deduplicated while genuinely distinct partial applications still post.

`sequence_number` is scoped per source order plus voucher combination, not globally per voucher.

Reserve / commit / release is phase 1 for gift cards and refund credits. It is not deferred.

All timestamps used for FX snapshots, reservations, and idempotency correlation must be stored in UTC.

### Chargeback and fraud policy

Default operational policy:

- gift-card-funded orders under chargeback or fraud review do not auto-restore voucher value
- affected vouchers move into a hold or suspended state pending finance review
- gift card purchases that later charge back should suspend remaining unspent balance
- if a charged-back gift card has already been partially spent, the spent portion becomes finance exposure for recovery or write-off workflow
- refund credits created from orders later under chargeback review should be suspended pending review

These defaults should be overridable only by explicit finance policy, not connector-specific behavior.

## Loyalty Rules

IMS must:

- mirror balances from the source platform
- mirror transactions where available
- mirror expiry tranches where available
- link points conversions to vouchers
- track sync confidence and mismatches

IMS must not:

- calculate earning rules
- recalculate expected points refunds
- become the customer-facing loyalty authority

When only balance snapshots exist, IMS may infer deltas, but those rows must be marked as IMS-derived.

Source platform balance is authoritative for loyalty.

IMS transaction history is a best-effort mirrored audit trail.

When mirrored transactions do not equal the source-platform balance, IMS must create an immutable reconciliation entry tagged `IMS_RECONCILIATION_ADJUSTMENT`. Finance may reconcile and annotate the mismatch in IMS, but IMS must not attempt to change the source platform's loyalty balance.

If later high-fidelity event data contradicts an earlier IMS-derived row, the IMS-derived row remains immutable and IMS emits a reconciliation correction entry rather than mutating history.

## Multi-Currency Rules

### Authoritative balance

Voucher remaining balance must be stored in issue currency only.

### Redemption across currencies

At redemption time, store:

- issue currency
- issue amount consumed
- checkout currency
- checkout amount applied
- checkout FX rate
- FX source
- FX timestamp
- functional-currency amount

### Refund restoration

Refund restoration must use the original consumed issue-currency amount recorded on `voucher_application`, not a fresh conversion using current FX.

Accounting policy for functional currency must also be explicit:

- voucher balance restoration always uses the original issue-currency amount
- the functional-currency base amount for accounting posts defaults to current posting FX
- any delta between original redemption functional amount and refund restoration functional amount must be posted to an explicit FX variance account

This policy is the default for both Xero and QuickBooks mappers and avoids silent connector divergence.

Connector mappers should post in IMS functional currency by default and only rely on native Xero or QuickBooks multi-currency posting behavior when that is explicitly configured and tested for the tenant.

### Display values

Any other-currency display in UI is informational only and must not affect the authoritative balance.

## Tax Rules

Support:

- `SPV`
- `MPV`
- `NON_VOUCHER_DISCOUNT`
- `UNCLASSIFIED`

Classification must happen at issuance or conversion and must be snapshotted with supporting facts.

Rule inputs should include:

- place of supply certainty
- whether tax liability is fully known at issue
- jurisdiction restriction
- product restriction
- discount vs stored-value behavior

For onetwo3d's expected operating shape, default stored-value classification should be `MPV`.

`SPV` should be treated as an exception that requires positive evidence that both the place of supply and the VAT treatment are knowable at issue. Generic gift cards redeemable across multiple countries, tax outcomes, or broad catalogues should not be treated as `SPV`.

Any stored-value instrument that is not provably `SPV` should default to `MPV`, consistent with HMRC voucher guidance.

Expiry policy must be explicit:

- support fixed time-based expiry in phase 1
- support partial balance expiry through ledger entries rather than destructive updates
- support breakage recognition policy by jurisdiction and accounting profile
- do not automate SPV tax reversal on expiry unless a jurisdiction-specific rule is explicitly configured and accountant-approved
- escheatment / dormant-balance handling remains policy-driven and disabled by default unless a jurisdiction profile enables it
- expiry notifications and grace periods are policy-driven features and are out of phase 1 unless explicitly required by tenant configuration

For MPV instruments, expiry is the default operational trigger for breakage recognition where tenant policy enables it.

Loyalty expiry tranches are best-effort. Some sources will only support coarse expiry visibility, for example an aggregate amount expiring within a future time window rather than FIFO tranches.

## Accounting Rules

Business logic must emit connector-agnostic accounting events first.

Connector logic then maps those normalized events into Xero and QuickBooks calls.

Typical event coverage:

- gift card issued
- gift card redeemed
- gift card redemption reversed
- refund credit issued
- refund credit restored
- marketing voucher redeemed
- voucher expired or written off
- loyalty points converted to voucher
- loyalty reversals and reinstatements where accounting mode requires posting

Default routing:

- gift cards: liability
- refund credits: liability
- marketing vouchers: contra-revenue by default
- loyalty: reporting-only by default unless finance enables liability treatment

Points-to-voucher conversion requires an explicit accounting policy.

Default treatment:

- reporting-only loyalty mode: no accounting post on points accrual or mirror sync, but voucher creation still posts according to the configured voucher treatment
- marketing mode: debit marketing expense and credit voucher liability for stored-value vouchers; only pure discount instruments may route to contra-revenue
- contract-liability mode: debit loyalty contract liability and credit voucher liability at conversion

Connector mappers must not infer this policy ad hoc.

## Connector Strategy

### WooCommerce

WooCommerce must remain first-class in the implementation plan.

Its implementation should start immediately alongside the core IMS ledger, not later as an afterthought.

However, WooCommerce voucher and loyalty support must be designed as:

- WooCommerce core order and refund ingestion
- plus plugin and extension adapters for gift cards, store credit, vouchers, and points

Reason:

- WooCommerce does not provide one canonical native API surface for all gift card, store credit, and loyalty behaviors
- these capabilities are usually implemented by plugins

Required WooCommerce workstream:

- extend the existing WooCommerce webhook and import flow
- normalize voucher and loyalty events into shared IMS event shapes
- add an extension adapter interface for common plugins
- support low-fidelity ingestion when a plugin only exposes balances or coupon application data
- expose plugin-source mismatch states in reconciliation UI

Smart Coupons should be treated as the likely first WooCommerce adapter.

Normalization must distinguish Smart Coupons stored-value instruments from generic WooCommerce coupons using plugin metadata and discount-type classification, not code-pattern matching. Exact meta keys should be confirmed during adapter build, but the design baseline is metadata-driven identification.

Current public Smart Coupons documentation confirms that store credit and gift certificates are represented as discount-type coupons. It does not expose a stable public metadata contract, so exact meta keys should be confirmed from the installed plugin code before the adapter schema is finalized rather than guessed in the plan.

### Shopify

Shopify should be treated as the first native platform implementation for:

- gift cards
- store credit accounts

Shopify loyalty points should still use an app-adapter model because points are not a single native Shopify loyalty surface in the same way gift cards and store credit are.

Required Shopify workstream:

- add gift card ingestion and reconciliation
- add store credit account sync and transaction mirror
- normalize redemption and refund flows into shared IMS voucher and loyalty events
- add app-level adapter hooks for non-native loyalty providers

### Xero

Xero should consume normalized IMS accounting events and map them into:

- manual journals
- invoices where relevant
- credit notes where relevant
- reversals and sync-state updates

Xero-specific behavior must stay behind the existing accounting connector boundary.

### QuickBooks

QuickBooks should implement the same normalized accounting event contract used by Xero, mapped into:

- journal entries
- invoices where relevant
- credit memos where relevant
- reversals and sync-state updates

QuickBooks-specific behavior must also stay behind the accounting connector boundary.

## Implementation Workstreams

### Workstream 1. Core schema and canonical events

Build first:

- Prisma enums and tables
- canonical voucher events
- canonical loyalty events
- deterministic idempotency key rules
- correlation keys for orders, refunds, vouchers, customers, and source events
- customer identity model
- precision rules for stored amounts and FX rates

Exit criteria:

- all platforms can emit into one IMS event shape
- no connector-specific business rules leak into the core ledger

Schema precision should be explicit rather than left to ORM defaults. Baseline target:

- amounts: equivalent of `Decimal(19,4)` minimum
- FX rates: equivalent of `Decimal(18,8)` minimum

### Workstream 2. Voucher and credit ledger

Build:

- voucher master
- secure code lookup and normalization
- issue / activate / redeem / reverse / refund-restore flows
- voucher transaction ledger
- voucher application ledger
- voucher reservation with reserve / commit / release
- transferability and customer-binding rules
- chargeback and fraud state handling

Reservation model requirements:

- reservations must be persisted durably in the primary database
- Redis may be used as a performance optimization, but not as the sole source of truth
- reservations must have explicit expiry and release rules for abandoned carts
- default reservation expiry is 60 minutes unless tenant configuration overrides it
- reserve operations must fail atomically if the requested amount exceeds currently available balance after considering committed use and active reservations
- reservation recovery after process restart must be possible from durable state alone

Exit criteria:

- stored-value vouchers can be partially redeemed multiple times until exhausted
- refunds restore original consumed value exactly
- concurrent checkout attempts cannot double-spend a stored-value voucher
- concurrency protection must be validated with deterministic concurrent-transaction tests, not only single-threaded happy-path tests

### Workstream 3. Tax and valuation engine

Build:

- SPV / MPV / discount classification
- tax rationale snapshots
- issue-currency anchored balance rules
- FX snapshot storage on redemption and refund restoration
- expiry rules and breakage policy hooks
- explicit refund-posting FX variance policy

Exit criteria:

- vouchers can be classified and reported independent of order recalculation
- MPV is the safe default and SPV requires affirmative evidence

### Workstream 4. WooCommerce integration

Build:

- WooCommerce canonical voucher event ingestion
- WooCommerce refund-credit issuance handling
- WooCommerce extension adapter contract
- adapters for first supported plugins
- reconciliation visibility for extension-specific mismatches

Exit criteria:

- WooCommerce is fully represented in the baseline plan and can flow voucher and loyalty data into IMS through the shared event model

### Workstream 5. Shopify integration

Build:

- Shopify gift card sync
- Shopify store credit sync
- Shopify native redemption and refund normalization
- loyalty app adapter entry points

Exit criteria:

- Shopify native stored-value instruments can be mirrored and reconciled end-to-end

### Workstream 6. Loyalty sync ledger

Build:

- mirrored points account
- mirrored points transaction store
- expiry tranche support
- snapshot polling fallback
- conversion bridge between points and vouchers
- reconciliation adjustment entries
- immutable correction flow for IMS-derived rows

Exit criteria:

- IMS can mirror loyalty balances and events without calculating earning rules
- source-platform balance wins when mirrored history and source balance diverge

### Workstream 7. Accounting adapter

Build:

- normalized accounting event persistence
- account routing profiles
- Xero event mapper
- QuickBooks event mapper
- retry and dead-letter flows
- external sync status tracking
- explicit FX variance posting
- points-to-voucher accounting policy support

Points-to-voucher accounting policy should live on the unified `accounting_profile` model with discriminator-specific fields rather than a separate loyalty-only routing table.

Exit criteria:

- accounting sync is idempotent and connector-agnostic from the domain perspective

### Workstream 8. UI and reconciliation

Build:

- Finance > Vouchers & Credits
- Finance > Loyalty Points
- voucher detail screens
- loyalty detail screens
- reconciliation dashboards
- admin actions with permission gates

Exit criteria:

- finance users can view balances, history, conversions, sync state, and mismatches without inspecting raw logs

## Delivery Order

Recommended milestone order:

1. core schema, event model, and voucher ledger
2. reservation, concurrency, and customer identity foundations for stored value
3. WooCommerce connector foundation for voucher, refund-credit, and loyalty ingestion
4. Shopify native gift card and store credit ingestion
5. WooCommerce extension adapters for Smart Coupons, gift card, and points plugins
6. loyalty mirror and points-to-voucher bridge across both channels
7. Xero and QuickBooks accounting adapters
8. finance UI, reconciliation screens, admin controls, and backfill tooling

## UI Plan

### Finance > Vouchers & Credits

Must show:

- masked code
- voucher type
- status
- customer
- source channel
- issue date and expiry
- issue currency
- face value
- remaining issue-currency value
- estimated display values in selected currencies
- tax class
- accounting sync state

### Voucher detail

Must show:

- masked code
- issue and remaining value
- transaction history
- application history
- linked orders and refunds
- linked accounting events
- tax classification snapshot
- loyalty origin if points-funded
- reservation state
- fraud or chargeback hold state

### Finance > Loyalty Points

Must show:

- points accounts by customer
- available and pending balances where available
- expiry visibility
- converted, expired, reversed, and adjusted totals
- sync failures
- linked voucher conversions
- reconciliation adjustments

### Reconciliation

Must show:

- source-platform voucher totals vs IMS totals
- source-platform loyalty totals vs IMS totals
- unlinked conversions
- refund mismatches
- unsynced accounting events
- orphaned source events
- WooCommerce extension-source mismatches explicitly
- loyalty balance adjustments where source totals overrule mirrored history

Dual-platform behavior is intentionally not a balance-unification feature in phase 1. WooCommerce and Shopify stored-value instruments can be shown in one customer-facing IMS view, but they remain separate source balances and separate redemption domains unless a later project explicitly introduces cross-platform value unification.

## Security and Controls

Required controls:

- hash voucher codes
- restrict full-code reveal
- redact sensitive values from logs
- permission-gate manual adjustments
- permission-gate tax overrides
- permission-gate accounting resync
- throttle invalid redemption attempts
- detect duplicate and replayed redemptions
- support reserve / commit / release for gift cards and refund credits in phase 1
- freeze or suspend vouchers during chargeback and fraud review flows

Default abuse threshold:

- 5 or more invalid attempts against the same code within 1 hour triggers temporary code lock and finance alert

Performance target for phase 1:

- voucher validate / reserve endpoints should target sub-200ms p99 excluding upstream connector latency

## Data Protection and Retention

Voucher and customer identity data must be handled under a documented UK GDPR retention policy.

Baseline policy:

- preserve financial ledger history and audit records where retention is necessary for legal, accounting, or claim-defense purposes
- on erasure requests, anonymize or restrict customer-linked personal data where possible without destroying financial records
- active vouchers, refund credits, and loyalty balances should not have their financial records deleted solely because a linked customer requests erasure
- customer links may be pseudonymized while preserving voucher and ledger continuity
- the final retention and erasure policy should be confirmed with legal or privacy review before go-live

## Acceptance Criteria

The implementation is complete when IMS can:

- identify vouchers by code or source reference
- support partial and repeated redemptions until exhausted
- preserve authoritative balance in issue currency
- redeem across currencies using source checkout FX snapshots
- restore original consumed value on refund
- support gift cards, refund credits, and marketing vouchers
- mirror loyalty balances and expiry data where provided
- mirror loyalty reversals, reinstatements, and adjustments
- detect and link points-to-voucher conversions
- classify vouchers as SPV, MPV, or discount
- generate connector-agnostic accounting events
- sync those accounting events to Xero and QuickBooks through the existing accounting seam
- expose voucher, loyalty, and reconciliation views in the IMS UI
- prevent double-spend through reservation on stored-value instruments
- keep per-platform loyalty balances separate unless explicitly linked by finance action
- enforce documented UK GDPR retention and erasure policy for customer-linked voucher and loyalty data

Chargeback policy defaults:

- gift-card-funded orders under chargeback or fraud review do not auto-restore value; related vouchers enter hold state pending finance decision
- gift card purchases that later charge back should suspend remaining unspent balance; spent portions become exposure for finance recovery and write-off workflow
- refund credits created from orders later under chargeback review should be suspended pending review

## Immediate Implementation Decisions

Before engineering starts, confirm:

1. which WooCommerce plugins are in scope first
2. which Shopify loyalty apps or integration surfaces need adapter support first
3. whether refund credits always create new vouchers or may top up existing customer credit instruments
4. whether marketing stored-value vouchers are always contra-revenue or allow profile overrides
5. whether any channels cannot support reserve / commit / release semantics for stored value
6. whether encrypted full voucher-code storage is operationally required
7. which jurisdictions require SPV / MPV support in the first release
8. confirm the default MPV treatment for multi-jurisdiction tenants with external accountant review
9. confirm refund-posting FX policy as current rate plus explicit variance account
10. confirm loyalty mismatch resolution as source-wins plus reconciliation adjustment entries
11. confirm customer identity model and whether any manual cross-platform merges are permitted
12. confirm chargeback policy for gift-card-funded orders, gift-card purchases, and refund credits

## Status

This document is the saved baseline for future implementation of stored value, vouchers, refund credit, and loyalty sync in IMS.
