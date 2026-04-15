# Xero Follow-Up Plan

Date: 2026-04-15
Branch baseline: `main`

## Goal

Close the remaining Xero follow-up work and finish the accounting connector boundary so Xero can be disabled or replaced by another accounting connector, such as QuickBooks, without changing non-connector code.

## Outcome Target

The main program should depend only on connector-agnostic accounting interfaces.

That means:
- core business flows queue and inspect accounting work through generic accounting APIs
- shared UI renders generic accounting integration state, external-document links, and readiness/errors
- cron and OAuth/webhook ingress go through generic accounting connector entrypoints
- connector-specific settings keys, token models, route details, payload shaping, and API semantics stay inside the connector implementation

Replacing Xero with QuickBooks should require:
- adding a QuickBooks connector implementation
- selecting/configuring the active accounting connector
- optionally migrating connector-owned persisted data

It should not require editing sales, purchasing, stock, settings, dashboard, or other core app code.

## Current status

Already in the right direction:
- [lib/accounting.ts](../lib/accounting.ts) exists as a generic facade for queuing accounting sync and reading some accounting settings.
- Core sync queue writes already go through generic `AccountingSyncLog` rows rather than Xero-only sync-log types.
- Core document/PDF storage has some connector-neutral shaping already, for example [lib/invoice-pdf.ts](../lib/invoice-pdf.ts).
- The architecture docs already describe the intended future shape: accounting connectors under `lib/connectors/`.

Not replaceable enough yet:
- `lib/accounting.ts` still delegates directly to Xero internals and returns Xero-shaped defaults, account fields, and account-list storage.
- app actions are Xero-specific (`app/actions/xero-sync.ts`, `app/actions/xero-daily-batch.ts`) rather than generic accounting-integration actions.
- the integrations dashboard and client components are wired to Xero concepts, Xero settings, Xero account lists, and Xero tax rates.
- cron endpoints are named and implemented as Xero-specific routes (`/api/cron/xero-sync`, `/api/cron/xero-daily-batch`, `/api/cron/xero-payment-poll`).
- the OAuth callback is Xero-specific (`/api/xero/callback`) and redirects with Xero-specific query params.
- tax-rate linking in settings calls Xero APIs directly.
- page-level invoice/bill link defaults still assume Xero URL formats.
- generic account/bank-account listing still reads from `db.xeroAccount` directly.

## Current boundary leaks

### 1. Generic accounting facade still has Xero-specific internals

Examples:
- `queueAccountingSync()` imports `queueXeroSync`
- `getAccountingSettings()` imports `getXeroSettings()` and maps `xero_*` fields
- `listAccountCodes()` and `listAccountingBankAccounts()` read `db.xeroAccount` directly
- default invoice/bill URL templates still point to `go.xero.com`

Impact:
- any new connector would require changes in `lib/accounting.ts`, which should instead be the stable app-facing contract.

### 2. App-facing integration actions are Xero-specific

Examples:
- `app/actions/xero-sync.ts`
- `app/actions/xero-daily-batch.ts`
- `app/actions/settings.ts` direct `autoLinkXeroTaxRates()`

Impact:
- the app layer currently knows about Xero credentials, Xero readiness rules, Xero tax types, Xero account sync, Xero manual sync, and Xero retry behavior.
- replacing the connector would require touching non-connector action files and the dashboard page/client that consume them.

### 3. Integration UI is Xero-shaped rather than connector-shaped

Examples:
- `app/(dashboard)/sync/page.tsx`
- `app/(dashboard)/sync/sync-dashboard.tsx`
- `app/(dashboard)/sync/xero-client.tsx`

Impact:
- the UI knows about Xero tabs, Xero client ID/secret, Xero tenant name, Xero account IDs, Xero tax codes, and Xero-specific toggle labels.
- QuickBooks support would currently require editing shared dashboard code instead of plugging in a connector-owned UI surface or metadata contract.

### 4. Cron and OAuth ingress are Xero-specific app routes

Examples:
- `/api/cron/xero-sync`
- `/api/cron/xero-daily-batch`
- `/api/cron/xero-payment-poll`
- `/api/xero/callback`

Impact:
- route naming and enablement logic are coupled to Xero.
- a new accounting connector would currently require new app-level route handlers rather than plugging into a generic accounting ingress layer.

### 5. Generic settings and page flows still expose Xero-specific concepts

Examples:
- tax-rate auto-linking is Xero-specific
- sales and purchase pages rely on accounting URL templates whose defaults are Xero deep links
- purchase order payment UI still describes Xero-specific behavior

Impact:
- user-facing app code still assumes the active accounting connector is Xero.

### 6. Persistence model remains connector-specific in places

Examples:
- `db.xeroAccount`
- `db.xeroToken`
- `xeroTransactionId` fields and Xero-specific naming in action return types/UI models

Impact:
- some schema-level connector specificity is acceptable during migration, but non-connector code should not be reading those tables/fields directly.
- generic selectors/view models are needed so the app can remain connector-neutral even if the database is not fully normalized yet.

## Work items

### 1. Freeze the generic accounting connector contract

Status: open

Required changes:
- expand `lib/accounting.ts` into the stable app-facing boundary for all accounting connectors
- centralize active accounting connector resolution there
- expose connector-agnostic capabilities for:
  - queueing accounting sync work
  - reading connector status/readiness
  - reading integration settings summary
  - listing accounts and bank accounts
  - listing tax codes
  - external invoice/bill link generation
  - retry/manual sync operations
  - any batch-preview/history surfaces that must remain app-facing

Definition of done:
- non-connector business logic imports only from `lib/accounting.ts` or another explicitly generic accounting boundary.
- `lib/accounting.ts` no longer imports Xero-specific functions directly as its public behavior contract.

### 2. Replace Xero-specific integration actions with generic accounting actions

Status: open

Required changes:
- replace `app/actions/xero-sync.ts` with generic accounting integration actions
- move Xero-specific credential handling, readiness checks, account sync, tax-code fetch, manual sync, and retry logic behind connector-owned adapters
- replace `app/actions/xero-daily-batch.ts` with either:
  - generic accounting batch actions, if daily batch is meant to remain a core accounting concept, or
  - connector-owned admin actions, if daily batch is a Xero-specific implementation detail
- move `autoLinkXeroTaxRates()` behind a generic accounting tax-code linking action or connector capability

Definition of done:
- shared app actions no longer expose Xero-specific types, names, or settings keys.
- adding QuickBooks does not require cloning and renaming app actions.

### 3. Generalize the accounting integrations dashboard

Status: open

Required changes:
- refactor `/sync` accounting surfaces so shared dashboard code consumes generic connector descriptors and generic accounting integration data
- either:
  - move Xero-specific UI into a connector-owned rendered section, or
  - define a generic UI schema/metadata contract that connectors provide
- remove Xero-specific prop shapes such as Xero account rows, tenant names, tax rates, and sync-log naming from shared dashboard code
- keep connector branding/logo selection data-driven rather than hard-wired through shared logic

Definition of done:
- shared dashboard/page code does not import Xero-specific action types or components.
- the Xero UI is mounted as connector-specific content behind a generic accounting dashboard surface.

### 4. Generalize accounting cron and callback ingress

Status: open

Required changes:
- replace `/api/cron/xero-sync`, `/api/cron/xero-daily-batch`, and `/api/cron/xero-payment-poll` app routes with generic accounting cron entrypoints or connector registration-driven cron handlers
- move enablement checks and connector-specific execution logic behind the accounting connector boundary
- replace `/api/xero/callback` with a generic accounting OAuth callback entrypoint or connector-scoped registration model
- avoid Xero-specific redirect query params in shared UI routing

Definition of done:
- adding a new accounting connector does not require adding new Xero-style top-level app routes.
- cron/auth callback behavior is selected by the active accounting connector rather than hard-coded route names.

### 5. Remove Xero-specific reads from generic settings and page flows

Status: open

Required changes:
- replace direct Xero tax-rate linking in `app/actions/settings.ts` with generic accounting tax-code linking
- stop relying on Xero deep-link defaults in sales/purchase page code
- replace Xero-specific wording in generic operational flows with connector-neutral wording
- ensure PO payment/account selectors consume generic accounting bank-account interfaces only

Definition of done:
- core settings, sales, purchasing, and stock pages do not mention or depend on Xero-specific concepts unless they are inside a connector-owned UI section.

### 6. Hide connector-specific persistence behind generic selectors/view models

Status: open

Required changes:
- stop reading `db.xeroAccount`, `db.xeroToken`, and `xeroTransactionId` directly from non-connector code
- add generic repository/helpers/view models for:
  - external account lists
  - connector connection state
  - connector sync logs
  - external transaction IDs
- where schema renames are too invasive for now, treat existing Xero tables/columns as adapter-owned persistence behind generic APIs

Definition of done:
- non-connector code can stay unchanged even if the backing accounting connector storage changes from Xero tables to QuickBooks tables.

### 7. Preserve and extend accounting correctness work under the new boundary

Status: open

The remaining functional/accounting items still matter, but they should now be implemented through the generic accounting boundary:
- VAT liability posting
- request idempotency support
- failed-sync completeness hardening
- preview/daily-batch behavior cleanup

Guidance:
- do not add more Xero-specific app-layer coupling while implementing those fixes
- if daily-batch remains a Xero-only concept, keep its operational UI and logic connector-owned
- if daily-batch is intended to become a generic accounting sub-ledger concept, rename and model it generically before adding more features

## Recommended order

1. Freeze the generic accounting contract in `lib/accounting.ts`
2. Replace Xero-specific account/bank-account/tax-code access with generic accounting selectors
3. Move Xero-specific app actions behind generic accounting integration actions
4. Refactor the `/sync` accounting dashboard to mount connector-owned content through a generic shell
5. Generalize cron and OAuth callback ingress
6. Sweep remaining page/settings wording and link-generation leaks
7. Continue VAT/idempotency/completeness/daily-batch fixes only through the generic boundary

## Acceptance criteria

- no non-connector code imports from `lib/connectors/xero/**`, except a single generic bootstrap/registration layer if one remains necessary
- no non-connector code reads `xero_*` settings directly
- no non-connector code reads `db.xeroAccount` or `db.xeroToken` directly
- shared UI does not use Xero-specific component names or types for generic accounting surfaces
- cron and OAuth entrypoints are connector-agnostic
- sales, purchasing, stock, and settings flows continue to work without assuming Xero-specific URLs, tax concepts, or route names
- QuickBooks support can be added by implementing the connector contract rather than rewriting app code

## Suggested next-session starting checklist

1. Re-read `docs/xero-followup-plan.md`.
2. Start with `lib/accounting.ts`, because it is the intended stable contract and still leaks Xero heavily.
3. Decide whether daily batch is a generic accounting capability or a Xero-specific implementation detail.
4. After the accounting contract is frozen, move account/tax-code access and dashboard actions onto that generic surface before adding more accounting features.
