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

Implement the feature as four cooperating submodules.

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

### 3. Tax and Valuation Engine

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

## Core Principles

1. Vouchers are not inventory and must not be represented as stock items.
2. Loyalty points are mirrored in IMS, not earned or recalculated in IMS.
3. Stored-value voucher balance is authoritative only in issue currency.
4. Refunds restore the original issue-currency amount previously consumed.
5. All value movement is immutable and represented by ledger entries plus reversals.
6. Connector ingestion and accounting posting must be idempotent.
7. Tax classification and FX context must be snapshotted at event time.
8. The system must remain usable even when a source platform only exposes balances, not full transaction history.

## Domain Model

Implement the following core entities.

### Voucher side

- `voucher`
- `voucher_transaction`
- `voucher_application`
- `voucher_tax_profile`
- `voucher_accounting_profile`

### Loyalty side

- `loyalty_points_account`
- `loyalty_points_transaction`
- `loyalty_points_expiry_tranche`
- `loyalty_points_conversion`
- `loyalty_accounting_profile`

### Shared finance side

- `accounting_event`

These entities should preserve correlation to:

- orders
- refunds
- source-platform event ids
- voucher codes and references
- customers
- external accounting records

## Voucher Rules

### Voucher identification

IMS must identify vouchers using submitted code or source reference through:

- connector-specific normalization rules
- hashed lookup
- masked display in UI
- encrypted full-code storage only when operationally necessary

### Voucher validation

Before applying a voucher, IMS must validate:

- status
- expiry
- customer restriction
- channel restriction
- redemption mode
- sufficient balance

### Voucher application model

`voucher_application` is required in phase 1 because refund correctness depends on it.

It must capture:

- voucher id
- order id
- optional order line id
- checkout currency amount applied
- issue-currency amount consumed
- functional-currency amount
- FX source, rate, and timestamp
- application status

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

Exit criteria:

- all platforms can emit into one IMS event shape
- no connector-specific business rules leak into the core ledger

### Workstream 2. Voucher and credit ledger

Build:

- voucher master
- secure code lookup and normalization
- issue / activate / redeem / reverse / refund-restore flows
- voucher transaction ledger
- voucher application ledger
- reservation model hooks for future concurrency support

Exit criteria:

- stored-value vouchers can be partially redeemed multiple times until exhausted
- refunds restore original consumed value exactly

### Workstream 3. Tax and valuation engine

Build:

- SPV / MPV / discount classification
- tax rationale snapshots
- issue-currency anchored balance rules
- FX snapshot storage on redemption and refund restoration

Exit criteria:

- vouchers can be classified and reported independent of order recalculation

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

Exit criteria:

- IMS can mirror loyalty balances and events without calculating earning rules

### Workstream 7. Accounting adapter

Build:

- normalized accounting event persistence
- account routing profiles
- Xero event mapper
- QuickBooks event mapper
- retry and dead-letter flows
- external sync status tracking

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
2. WooCommerce connector foundation for voucher, refund-credit, and loyalty ingestion
3. Shopify native gift card and store credit ingestion
4. WooCommerce extension adapters for Smart Coupons, gift card, and points plugins
5. loyalty mirror and points-to-voucher bridge across both channels
6. Xero and QuickBooks accounting adapters
7. finance UI, reconciliation screens, admin controls, and backfill tooling

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

### Finance > Loyalty Points

Must show:

- points accounts by customer
- available and pending balances where available
- expiry visibility
- converted, expired, reversed, and adjusted totals
- sync failures
- linked voucher conversions

### Reconciliation

Must show:

- source-platform voucher totals vs IMS totals
- source-platform loyalty totals vs IMS totals
- unlinked conversions
- refund mismatches
- unsynced accounting events
- orphaned source events
- WooCommerce extension-source mismatches explicitly

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
- support reserve / commit / release for high-concurrency channels when required

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

## Immediate Implementation Decisions

Before engineering starts, confirm:

1. which WooCommerce plugins are in scope first
2. which Shopify loyalty apps or integration surfaces need adapter support first
3. whether refund credits always create new vouchers or may top up existing customer credit instruments
4. whether marketing stored-value vouchers are always contra-revenue or allow profile overrides
5. whether checkout channels will support reserve / commit / release
6. whether encrypted full voucher-code storage is operationally required
7. which jurisdictions require SPV / MPV support in the first release

## Status

This document is the saved baseline for future implementation of stored value, vouchers, refund credit, and loyalty sync in IMS.
