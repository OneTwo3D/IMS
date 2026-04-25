# OneTwo3D/IMS — Codex Implementation Plan

This document is a staged implementation brief for Codex and/or Claude Code to improve the `OneTwo3D/IMS` repository based on the code review findings.

It is designed to be used directly as a task plan. Do not ask a coding agent to implement the whole document in one run. Use one branch and one pull request per stage or sub-stage.

---

## Repository and scope

- Repository: `OneTwo3D/IMS`
- Repository default branch: `main`
- Project integration branch: `development`
- **All Codex/Claude implementation branches must be created from `development`, and all PRs for this project must target `development`, not `main`.**
- Application type: Next.js / TypeScript / Prisma / PostgreSQL inventory and accounting platform
- Core risk domains:
  - inventory correctness
  - FIFO cost layers and COGS
  - sales allocation, shipment, refunds
  - purchase orders and landed costs
  - Xero accounting batches
  - WooCommerce sync
  - authorization and route exposure
  - cron, backups, imports, uploads, and operational safety

---

## How to use this plan

1. Create a dedicated branch for each PR from `development`.
2. Give the agent only one PR task at a time.
3. Require tests for changed behavior.
4. Require a summary of changed files, risk areas, and follow-up work.
5. Use a separate fresh agent session to review every PR.
6. Do not merge high-risk workflow changes until relevant E2E and domain tests pass.

Recommended branch workflow:

```bash
git fetch origin
git checkout development
git pull --ff-only origin development
git checkout -b codex/stage-01-api-route-auth-inventory
```

Every PR produced from this plan should use `development` as the base branch. Do not open project PRs directly against `main`.

Recommended PR title format:

```text
[Stage 1.1] Add API route authorization inventory
```

---

# Part 1 — Codex self-setup for this job

## Human preflight before starting Codex

Before handing the repository to Codex, confirm the following:

- The GitHub connector or Codex environment has access to `OneTwo3D/IMS`.
- The target branch for this project is `development`; do not use `main` as the base branch for implementation PRs.
- There are no uncommitted local changes.
- Production secrets are not available to the agent.
- The agent can run local validation commands.
- A test database is available if DB-backed tests are expected.

### Branch safety requirement

Codex/Claude must use `development` as the project base branch. `main` is not the working branch for this project. Before making changes, the agent must verify the current branch and switch to `development` if needed:

```bash
git fetch origin
git checkout development
git pull --ff-only origin development
current_branch="$(git branch --show-current)"
test "$current_branch" = "development"
```

For every implementation task, create a feature branch from the updated `development` branch:

```bash
git checkout -b codex/<stage-name>
```

The PR base must be `development`. If `development` is missing, the agent must stop and report that the branch is unavailable instead of falling back to `main`.

Do not provide production `.env` values. Provide development-only equivalents.

---

## Codex environment setup script

Use this as the first setup attempt in Codex cloud, Codex CLI, or a local worktree. Codex should adjust after inspecting the repository scripts.

```bash
set -euxo pipefail

# Project work must start from development, not main.
git fetch origin
git checkout development
git pull --ff-only origin development
test "$(git branch --show-current)" = "development"

node --version
npm --version

npm ci

# Prisma generation is usually safe and required before type-checking.
npx prisma generate

# Fast baseline checks. These may reveal missing environment variables.
npm run lint
npm run type-check
```

If database-backed checks are required and `DATABASE_URL` is missing, Codex must not invent production credentials. It should stop and report the missing local/test configuration, or add documented setup instructions in Stage 0.

If the repository already has a setup script, Codex should prefer the repository script after reading `package.json`, `README.md`, `docs/`, and existing CI files.

---

## Codex first-run prompt

Use this prompt at the start of a fresh Codex session:

```text
Repository: OneTwo3D/IMS
Base branch: development

Important branch rule: use `development` as the base branch for all work in this project. Do not branch from `main` and do not target `main` with PRs. If `development` is unavailable, stop and report the problem.

You are preparing to implement a staged reliability and architecture improvement plan for a Next.js / TypeScript / Prisma inventory and accounting system.

First, set yourself up safely:
1. Fetch and check out `development`, pull it with `--ff-only`, and verify `git branch --show-current` is exactly `development`.
2. Create the task branch from `development`, not from `main`.
3. Inspect README.md, package.json, prisma/schema.prisma, docs/, app/actions/, app/api/, lib/, tests/, and existing CI files.
4. Identify the correct package manager and validation commands.
5. Run dependency install if needed.
6. Run the fastest baseline validation available: lint, type-check, Prisma generate, and any schema checks already defined.
7. If validation fails because of missing local environment variables or services, document the exact missing setup and continue with static changes only when safe.
8. Do not modify .env or production credentials.
9. Do not change business behavior during setup.

Then implement only the single task I assign in this session.

General constraints:
- Preserve existing behavior unless the task explicitly says otherwise.
- Add or update tests for every changed behavior.
- Keep PRs small and reviewable.
- For accounting, inventory, FIFO, COGS, landed cost, refunds, or Xero work, prioritize correctness, idempotency, transactions, and auditability over convenience.
- Keep server actions thin when adding new code; put reusable business logic in lib/domain.
- Use Decimal-safe helpers for financial and quantity calculations where they exist.
- Run the smallest relevant tests plus lint and type-check before finishing.

Final response required:
1. Summary of changes
2. Files changed
3. Tests run and results
4. Risk areas
5. Follow-up tasks
```

---

## Agent operating rules

Codex must follow these rules for every stage:

- Use `development` as the base branch and PR target for this project; never branch from or open project PRs directly to `main`.
- Do not edit real secrets.
- Do not remove existing tests to make a task pass.
- Do not broaden authorization.
- Do not change accounting semantics without explicit tests.
- Do not silently mutate historical accounting or inventory records.
- Do not add external dependencies unless justified in the PR summary.
- Prefer narrow refactors over broad rewrites.
- Prefer typed domain services over business logic inside UI/server-action adapters.
- Prefer deterministic idempotency keys for integrations, cron jobs, and accounting events.
- Prefer report-only diagnostics before any auto-repair behavior.

---

## Baseline validation commands

Codex should discover the exact available commands from `package.json`. The target validation set is:

```bash
npm run lint
npm run type-check
npm run db:schema:drift
npm run db:schema:scope
```

For DB-backed work, also run the smallest relevant tests. Examples:

```bash
npm run test -- --runInBand
npm run e2e:select
npx playwright test tests/e2e/<relevant-test>.spec.ts
```

If the repository uses a different test runner, Codex should adjust and document the actual commands.

---

## Required PR summary format

Each agent PR must end with:

```text
Summary
- ...

Files changed
- ...

Branch
- Base branch: development
- Feature branch: <branch name>

Validation
- npm run lint: pass/fail/not run, with reason
- npm run type-check: pass/fail/not run, with reason
- relevant tests: pass/fail/not run, with reason

Risk areas
- ...

Follow-up tasks
- ...
```

---

## Fresh reviewer prompt for every PR

Use a separate agent session for review:

```text
Review this PR as a senior engineer for OneTwo3D/IMS.

Focus on:
- business workflow correctness
- inventory/accounting invariants
- authorization and data exposure
- transaction boundaries
- idempotency
- Decimal/money/quantity precision
- test coverage
- migration safety
- operational rollback risk

Do not rewrite the PR.
Return:
1. blocking issues
2. non-blocking issues
3. missing tests
4. production rollout risks
5. recommended follow-up tasks
```

---

# Part 2 — Implementation stages

## Stage 0 — Agent readiness and repository guardrails

### Goal

Prepare the repo so Codex and other agents can work consistently and safely.

---

## PR 0.1 — Add or refresh agent instructions

### Target files

```text
AGENTS.md
CLAUDE.md
docs/agent-workflow.md
```

### Requirements

Create or update agent instructions covering:

- project overview
- stack overview
- critical business domains
- validation commands
- test expectations
- secret-handling rules
- branch/PR workflow
- code style expectations
- domain-service preference
- rules for accounting and inventory changes

### Acceptance criteria

- `AGENTS.md` exists at repo root.
- `CLAUDE.md` is updated if present.
- `docs/agent-workflow.md` explains the staged PR process.
- No application behavior changes.

### Codex prompt

```text
Create or refresh agent instructions for OneTwo3D/IMS.

Add AGENTS.md, update CLAUDE.md if present, and add docs/agent-workflow.md.
Document the stack, safety constraints, validation commands, testing expectations, and PR workflow.
Emphasize that accounting, inventory, FIFO, COGS, landed cost, refunds, Xero, WooCommerce, cron, and auth changes require tests.
Do not change app behavior.
Run lint/type-check if applicable.
```

---

## PR 0.2 — Add a baseline validation script

### Target files

```text
scripts/validate-local.sh
package.json
```

### Suggested script

```bash
#!/usr/bin/env bash
set -euo pipefail

npm run lint
npm run type-check
npm run db:schema:drift
npm run db:schema:scope
```

Add package script:

```json
{
  "scripts": {
    "validate": "bash scripts/validate-local.sh"
  }
}
```

### Acceptance criteria

- `npm run validate` exists.
- The script runs the current standard validation commands.
- No production behavior changes.

### Codex prompt

```text
Add a local validation script.

Create scripts/validate-local.sh that runs lint, type-check, db:schema:drift, and db:schema:scope.
Add npm script "validate".
Do not change app behavior.
Run npm run validate if the environment supports it; otherwise document blockers exactly.
```

---

# Stage 1 — Safety net before refactors

## PR 1.1 — API route authorization inventory

### Goal

Ensure every API route has an explicit access classification.

### Target files

```text
lib/security/route-auth-policy.ts
scripts/list-api-routes.ts
tests/security/api-route-auth-inventory.test.ts
```

### Route classifications

```ts
type ApiRouteAccess =
  | "public-webhook"
  | "cron-secret"
  | "authenticated"
  | "admin"
  | "supplier"
  | "xero-oauth"
  | "internal-dev-only";
```

### Requirements

- Discover every `app/api/**/route.ts`.
- Require every route to exist in the policy map.
- Public routes must have comments explaining why they are public.
- Do not change endpoint behavior in this PR.

### Acceptance criteria

- Test fails if a route is missing from the policy map.
- All current API routes are classified.
- No runtime behavior changes.

### Codex prompt

```text
Add an API route authorization inventory for all app/api/**/route.ts files.

Create a route policy map that classifies each API route as one of:
public-webhook, cron-secret, authenticated, admin, supplier, xero-oauth, internal-dev-only.

Add a test that discovers route.ts files and fails if any route is missing from the policy map.
Do not change endpoint behavior in this PR.
Add clear comments for public-webhook and internal-dev-only routes explaining why they are allowed.
Run lint, type-check, and the new test.
```

---

## PR 1.2 — Secret scanning

### Goal

Prevent accidental credential commits.

### Target files

```text
.gitleaks.toml
.github/workflows/secret-scan.yml
```

### Requirements

- Run secret scanning on pull requests and pushes to `development`.
- Allow placeholders in `.env.example` and docs.
- Block real `.env`, private keys, service-account JSON, tokens, and credential files.

### Acceptance criteria

- Secret scan CI workflow exists.
- False-positive allowlist is narrow and documented.
- No application code changes.

### Codex prompt

```text
Add secret scanning to CI.

Use gitleaks unless the repo already has another scanner.
Add .gitleaks.toml with sensible allowlists for .env.example and documentation placeholders only.
Add a GitHub Actions workflow that runs on pull_request and push to development.
Do not modify application code.
Run the scanner locally if available and document any allowlist decisions.
```

---

## PR 1.3 — Cron authentication hardening

### Goal

Make localhost cron bypass impossible in production unless explicitly enabled.

### Suggested configuration

```env
ALLOW_LOCALHOST_CRON_BYPASS=false
```

### Intended behavior

```ts
const allowLocalhostBypass =
  process.env.NODE_ENV !== "production" ||
  process.env.ALLOW_LOCALHOST_CRON_BYPASS === "true";
```

In production, require `CRON_SECRET` unless the explicit override is set.

### Acceptance criteria

Tests cover:

- valid cron secret accepted
- invalid cron secret rejected
- localhost accepted in dev/test where intended
- localhost rejected in production by default
- localhost accepted in production only with explicit override

### Codex prompt

```text
Harden cron endpoint authentication.

Find the shared cron auth logic used by app/api/cron/**.
Add ALLOW_LOCALHOST_CRON_BYPASS with default false.
In production, localhost/origin bypass must be disabled unless ALLOW_LOCALHOST_CRON_BYPASS=true.
Add or update tests for valid secret, invalid secret, localhost dev/test behavior, and production behavior.
Update .env.example and docs.
Run lint, type-check, and relevant cron/security tests.
```

---

# Stage 2 — Centralize workflow state machines

## Stage goal

Stop scattering workflow status rules across server actions, UI, route handlers, and docs.

---

## PR 2.1 — Define canonical state machines

### Target files

```text
lib/domain/workflows/status-types.ts
lib/domain/workflows/sales-order-state.ts
lib/domain/workflows/shipment-state.ts
lib/domain/workflows/purchase-order-state.ts
lib/domain/workflows/refund-state.ts
lib/domain/workflows/stock-transfer-state.ts
tests/domain/workflows/*.test.ts
docs/workflows.md
```

### Required API shape

```ts
export function canTransitionSalesOrder(
  from: SalesOrderStatus,
  to: SalesOrderStatus
): boolean;

export function assertSalesOrderTransition(
  from: SalesOrderStatus,
  to: SalesOrderStatus
): void;
```

Repeat equivalent APIs for shipments, purchase orders, refunds, and stock transfers.

### Acceptance criteria

- Status values match Prisma enums or current string values.
- Transition tests cover allowed and forbidden transitions.
- Docs explain difference between order status and shipment status.
- No existing behavior changed unless a mismatch is explicitly documented.

### Codex prompt

```text
Create canonical workflow state-machine helpers for sales orders, shipments, purchase orders, refunds, and stock transfers.

Do not refactor existing callers yet.
Infer current valid statuses from Prisma schema, app/actions, and docs.
Add tests for allowed and forbidden transitions.
Add docs/workflows.md explaining each workflow and the distinction between sales order status and shipment status.
If you find ambiguous or conflicting status rules, preserve current behavior and document the ambiguity as TODO comments.
Run lint, type-check, and workflow tests.
```

---

## PR 2.2 — Use state machines in write paths

### Goal

Start enforcing transitions in mutation code.

### High-priority mutation areas

```text
app/actions/sales*
app/actions/allocations*
app/actions/shipments*
app/actions/refunds*
app/actions/purchase-orders*
```

### Acceptance criteria

- Invalid direct status jumps fail with clear errors.
- Existing E2E workflows still pass.
- New tests cover at least one invalid transition per workflow.

### Codex prompt

```text
Wire the workflow state-machine helpers into mutation paths that change sales order, shipment, purchase order, refund, and stock transfer statuses.

Preserve existing valid workflows.
Add tests for invalid direct transitions.
Make error messages user-safe and actionable.
Avoid broad refactors in this PR.
Run lint, type-check, and relevant sales/purchase/shipment/refund tests.
```

---

# Stage 3 — Extract domain services from server actions

## Stage goal

Make server actions thin adapters and move business logic into testable modules.

Recommended extraction order:

1. Allocation
2. Shipment
3. Refund
4. Purchase receipt
5. Landed cost
6. Accounting batch

---

## PR 3.1 — Extract allocation service

### Target files

```text
lib/domain/sales/allocation-service.ts
tests/domain/sales/allocation-service.test.ts
```

### Target server-action shape

```ts
"use server";

export async function allocateSalesOrderAction(input) {
  const session = await requireUser();
  return allocateSalesOrder({
    input,
    actorId: session.user.id,
    prisma,
  });
}
```

### Acceptance criteria

- Existing allocation behavior unchanged.
- Allocation service accepts a Prisma client or transaction client.
- Tests cover:
  - normal allocation
  - insufficient stock
  - kit/BOM expansion
  - already allocated order
  - concurrent stock locking if practical

### Codex prompt

```text
Extract sales order allocation business logic from server actions into lib/domain/sales/allocation-service.ts.

Keep the server action as a thin adapter for auth, input parsing, and revalidation only.
The service should accept prisma or transaction client, actor context, and typed input.
Preserve behavior.
Add tests for normal allocation, insufficient stock, kit/BOM expansion, and already allocated order.
Run lint, type-check, and allocation-related tests.
```

---

## PR 3.2 — Extract shipment service

### Target files

```text
lib/domain/sales/shipment-service.ts
tests/domain/sales/shipment-service.test.ts
```

### Acceptance criteria

- Shipment service owns shipment creation and shipment status changes.
- Existing FIFO and COGS behavior preserved.
- Tests cover:
  - full shipment
  - partial shipment
  - COGS snapshot creation
  - insufficient allocation/stock
  - shipment status transitions

### Codex prompt

```text
Extract shipment creation and shipment status business logic into lib/domain/sales/shipment-service.ts.

Keep server actions thin.
Do not change FIFO, COGS, or accounting behavior.
Add tests for full shipment, partial shipment, COGS snapshot creation, insufficient allocation or stock, and invalid shipment status transitions.
Run lint, type-check, and shipment/COGS tests.
```

---

## PR 3.3 — Extract refund service

### Target files

```text
lib/domain/sales/refund-service.ts
tests/domain/sales/refund-service.test.ts
```

### Acceptance criteria

- Refund creation, stock return, and COGS reversal logic is centralized.
- Tests cover:
  - refund before shipment rejected
  - refund after shipment
  - partial refund
  - kit/component refund
  - accounting staging impact

### Codex prompt

```text
Extract refund business logic into lib/domain/sales/refund-service.ts.

Preserve existing behavior for stock returns, COGS reversal, and accounting staging.
Add tests for refund before shipment rejected, refund after shipment, partial refund, kit/component refund, and accounting staging effects.
Keep UI/server actions as thin adapters.
Run lint, type-check, and refund tests.
```

---

## PR 3.4 — Extract landed-cost service

### Target files

```text
lib/domain/purchasing/landed-cost-service.ts
tests/domain/purchasing/landed-cost-service.test.ts
```

### Acceptance criteria

- Distribution methods are centralized:
  - by value
  - by quantity
  - by weight
  - equal split
- Revaluation behavior is unchanged.
- Tests cover retrospective landed-cost update cases.

### Codex prompt

```text
Extract landed-cost allocation and revaluation logic into lib/domain/purchasing/landed-cost-service.ts.

Centralize distribution methods: value, quantity, weight, equal split.
Preserve existing revaluation behavior.
Add focused tests for each distribution method and retrospective revaluation.
Do not change UI behavior.
Run lint, type-check, and landed-cost tests.
```

---

# Stage 4 — Inventory and accounting invariant checks

## Stage goal

Add system-level checks that detect data drift before users do. These checks report problems; they do not repair them.

---

## PR 4.1 — Inventory invariant engine

### Target files

```text
lib/domain/inventory/invariants.ts
app/api/admin/inventory/invariants/route.ts
tests/domain/inventory/invariants.test.ts
```

### Finding shape

```ts
type InventoryInvariantFinding = {
  severity: "info" | "warning" | "critical";
  code: string;
  productId?: string;
  warehouseId?: string;
  message: string;
  details: unknown;
};
```

### Required checks

- `stockLevel.quantity >= 0`
- `stockLevel.reservedQty >= 0`
- `reservedQty <= quantity` unless an explicit oversell/backorder rule allows otherwise
- `costLayer.remainingQty >= 0`
- `costLayer.remainingQty <= costLayer.receivedQty`
- stock quantity reconciles to remaining cost-layer quantity for stockable products, within documented exceptions
- shipped stockable items have COGS snapshots

### Acceptance criteria

- Admin-only endpoint returns invariant report.
- Tests seed clean and broken states.
- No auto-repair behavior.

### Codex prompt

```text
Add an inventory invariant reporting engine.

Create lib/domain/inventory/invariants.ts that returns structured findings without modifying data.
Add checks for negative stock, negative reserved quantity, reserved > quantity, invalid cost layer quantities, stock-vs-cost-layer mismatch, and missing COGS snapshots for shipped stockable items.
Expose an admin-only API route to run the report.
Add tests with clean data and deliberately broken data.
Do not implement auto-repair.
Run lint, type-check, and invariant tests.
```

---

## PR 4.2 — Accounting invariant engine

### Target files

```text
lib/domain/accounting/invariants.ts
app/api/admin/accounting/invariants/route.ts
tests/domain/accounting/invariants.test.ts
```

### Required checks

- shipments marked posted have sync log or external reference
- accounting sync logs have idempotency/reference keys
- sales order A1/A2/B state combinations are valid
- refunds linked to posted shipments have expected credit/reversal state
- failed syncs are visible and retryable

### Acceptance criteria

- Admin-only endpoint returns structured findings.
- Tests cover clean, failed, and inconsistent states.
- No posting behavior changed.

### Codex prompt

```text
Add an accounting invariant reporting engine.

Create lib/domain/accounting/invariants.ts.
Report inconsistent A1/A2/B staging states, shipments marked posted without sync evidence, missing idempotency/reference keys, refund reversal inconsistencies, and failed syncs that are not retryable or visible.
Expose an admin-only API route.
Add tests for clean and inconsistent scenarios.
Do not change posting behavior.
Run lint, type-check, and accounting invariant tests.
```

---

## PR 4.3 — Scheduled invariant report

### Target files

```text
app/api/cron/invariant-check/route.ts
```

### Requirements

- Use hardened cron authentication from Stage 1.
- Run inventory and accounting checks.
- Write a structured summary log.
- Include a run ID.
- Optionally notify admins for critical findings if the existing notification system supports it.
- Do not auto-repair.

### Acceptance criteria

- Cron-protected endpoint exists.
- Logs run ID, counts, and critical findings.
- Tests cover auth and report generation.

### Codex prompt

```text
Add a cron-protected invariant-check endpoint.

It should run inventory and accounting invariant engines, write a structured activity/sync log with a run ID, and notify admins only for critical findings if the existing notification system supports it.
Do not auto-repair data.
Add tests for cron auth and report generation.
Run lint, type-check, and cron/invariant tests.
```

---

# Stage 5 — Decimal and rounding safety

## Stage goal

Reduce money and quantity rounding risk without a broad rewrite.

---

## PR 5.1 — Add Decimal helpers

### Target files

```text
lib/domain/math/decimal.ts
tests/domain/math/decimal.test.ts
```

### Required helpers

```ts
toDecimal(value)
addMoney(a, b)
subtractMoney(a, b)
multiplyMoney(a, b)
roundMoney(value, currency)
roundQuantity(value, precision)
compareDecimal(a, b)
isZero(value)
```

### Acceptance criteria

- Helpers support Prisma Decimal, string, number, and null-safe conversions where appropriate.
- Tests cover:
  - money
  - quantities
  - tax
  - discounts
  - FX
  - edge rounding cases

### Codex prompt

```text
Add Decimal-safe helper utilities for money and quantity calculations.

Create lib/domain/math/decimal.ts with helpers for conversion, addition, subtraction, multiplication, comparison, zero checks, money rounding, and quantity rounding.
Use decimal.js or the Decimal implementation already used by Prisma if available.
Add tests covering money, quantity, tax, discount, FX, and edge rounding cases.
Do not refactor business logic yet.
Run lint, type-check, and decimal tests.
```

---

## PR 5.2 — Replace high-risk `Number(...)` conversions in domain logic

### Target areas

```text
lib/cost-layers.ts
lib/domain/inventory/*
lib/domain/purchasing/landed-cost-service.ts
lib/domain/sales/shipment-service.ts
lib/domain/accounting/*
```

Do not touch UI display formatting unless required.

### Acceptance criteria

- Financial and quantity calculations use Decimal helpers.
- UI boundaries may still convert values for display.
- Existing tests pass.
- At least one regression test covers a rounding-sensitive scenario.

### Codex prompt

```text
Replace high-risk Number(...) conversions in inventory, FIFO, landed cost, shipment COGS, refund, and accounting calculation paths with Decimal-safe helpers.

Do not change UI display formatting unless required.
Do not perform broad mechanical edits across the whole repo.
Add at least one regression test showing a rounding-sensitive case that now remains precise.
Run lint, type-check, COGS, landed-cost, refund, and accounting tests.
```

---

# Stage 6 — Append-only accounting events

## Stage goal

Move toward an auditable append-only accounting event model without breaking current posting behavior.

This stage is high risk. Do it only after Stage 4 invariants are in place.

---

## PR 6.1 — Add accounting event model

### Suggested Prisma model

```prisma
model AccountingEvent {
  id               String   @id @default(cuid())
  type             String
  sourceEntityType String
  sourceEntityId   String
  businessDate     DateTime
  status           String
  idempotencyKey   String   @unique
  linesJson        Json
  externalSystem   String?
  externalId       String?
  reversalOfId     String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
}
```

Optional event log model:

```prisma
model AccountingEventLog {
  id                String   @id @default(cuid())
  accountingEventId String
  action            String
  message           String?
  metadata          Json?
  createdAt         DateTime @default(now())
}
```

### Target files

```text
prisma/schema.prisma
prisma/migrations/*
lib/domain/accounting/accounting-event-types.ts
lib/domain/accounting/accounting-event-builder.ts
tests/domain/accounting/accounting-event.test.ts
```

### Acceptance criteria

- Migration added.
- Event builder functions added.
- Tests validate idempotency key uniqueness and event-line shape.
- Existing accounting behavior unchanged.

### Codex prompt

```text
Introduce an append-only AccountingEvent model without changing posting behavior.

Add Prisma model and migration.
Add lib/domain/accounting/accounting-event-types.ts and event builder helpers.
Add tests for event shape and idempotency-key uniqueness.
Do not modify existing Xero posting or daily batch behavior yet.
Run prisma generate/migrate checks, lint, type-check, and new accounting event tests.
```

---

## PR 6.2 — Mirror current daily batch actions into accounting events

### Goal

When current Xero staging/posting runs, also create accounting events with the same business meaning.

### Acceptance criteria

- Existing sync logs remain source of truth for now.
- New accounting events are created idempotently.
- Re-running a batch does not duplicate events.
- Tests compare old log output to new event output.

### Codex prompt

```text
Mirror existing daily accounting batch actions into AccountingEvent rows.

Do not replace current Xero posting behavior.
For each existing A1/A2/B/refund event currently staged or posted, create a corresponding AccountingEvent with deterministic idempotencyKey.
Ensure reruns do not duplicate events.
Add tests comparing expected existing sync log behavior with new mirrored events.
Run lint, type-check, and accounting/Xero daily batch tests.
```

---

## PR 6.3 — Accounting reconciliation report

### Target files

```text
lib/domain/accounting/reconciliation.ts
app/api/admin/accounting/reconciliation/route.ts
tests/domain/accounting/reconciliation.test.ts
```

### Report mismatches

- source order/shipment/refund without event
- event without source
- posted event without external ID
- duplicate external reference
- old sync log without mirrored event

### Acceptance criteria

- Admin-only endpoint exists.
- Tests cover mismatch scenarios.
- No posting behavior changed.

### Codex prompt

```text
Add an accounting reconciliation report comparing source orders/shipments/refunds, existing sync logs, and AccountingEvent rows.

Expose an admin-only API route.
Report missing events, orphan events, posted events without external ID, duplicate external references, and old sync logs without mirrored events.
Add tests for mismatch scenarios.
Do not change posting behavior.
Run lint, type-check, and reconciliation tests.
```

---

# Stage 7 — Connector outbox and retry system

## Stage goal

Standardize Xero, WooCommerce, email, PDF, and other external side effects.

---

## PR 7.1 — Add generic integration outbox model

### Suggested Prisma model

```prisma
model IntegrationOutbox {
  id             String   @id @default(cuid())
  connector      String
  operation      String
  idempotencyKey String   @unique
  payloadJson    Json
  status         String
  attempts       Int      @default(0)
  nextAttemptAt  DateTime?
  lastError      String?
  lockedAt       DateTime?
  lockedBy       String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}
```

### Target files

```text
lib/domain/integrations/outbox.ts
tests/domain/integrations/outbox.test.ts
```

### Acceptance criteria

- Helpers exist to:
  - enqueue idempotently
  - claim pending work
  - mark success
  - mark retryable failure
  - mark permanent failure
- Idempotency key prevents duplicates.
- No connector migrated yet.

### Codex prompt

```text
Add a generic IntegrationOutbox model and helper library.

The outbox should support connector, operation, idempotencyKey, payloadJson, status, attempts, nextAttemptAt, lastError, lockedAt, and lockedBy.
Add helpers to enqueue idempotently, claim pending work, mark success, and mark retryable/permanent failure.
Do not migrate existing Xero or WooCommerce flows yet.
Add tests for idempotency and retry scheduling.
Run prisma checks, lint, type-check, and outbox tests.
```

---

## PR 7.2 — Migrate WooCommerce stock sync to outbox

### Acceptance criteria

- Stock sync can enqueue jobs.
- Worker or cron processes pending WooCommerce jobs.
- Existing immediate sync behavior preserved where required.
- Tests cover stale product ID and drift cases.

### Codex prompt

```text
Migrate WooCommerce stock sync operations to use IntegrationOutbox.

Preserve existing stock sync behavior and existing drift-protection tests.
Add a worker/cron path that claims pending WooCommerce stock-sync jobs and processes them with retry handling.
Ensure deterministic idempotency keys prevent duplicate stock pushes.
Run lint, type-check, and WooCommerce stock sync/drift tests.
```

---

## PR 7.3 — Migrate Xero posting to outbox

Only start after accounting-event mirroring and reconciliation are stable.

### Acceptance criteria

- Posting jobs are idempotent.
- Failed posts are retryable and visible.
- Existing Xero tests pass.
- Retrying cannot create duplicate Xero documents.

### Codex prompt

```text
Migrate Xero posting operations to IntegrationOutbox.

Use AccountingEvent idempotency keys or existing deterministic references.
Ensure retrying a failed job cannot create duplicate Xero documents.
Preserve current daily batch behavior and logs.
Add tests for success, retryable failure, permanent failure, and rerun/idempotency.
Run lint, type-check, and Xero accounting tests.
```

---

# Stage 8 — Auth, throttling, and upload hardening

## PR 8.1 — Redis-backed login and TOTP throttling

### Target files

```text
lib/security/rate-limit.ts
lib/security/rate-limit-memory.ts
lib/security/rate-limit-redis.ts
```

### Suggested configuration

```env
RATE_LIMIT_BACKEND=memory
REDIS_URL=
```

### Acceptance criteria

- Memory backend remains default for local/dev.
- Redis backend works when enabled.
- Login/TOTP throttling uses the shared interface.
- Tests cover lockout, reset, and backend selection.

### Codex prompt

```text
Introduce a pluggable rate-limit backend for login and TOTP throttling.

Keep memory backend as default for local/dev.
Add Redis backend enabled by RATE_LIMIT_BACKEND=redis and REDIS_URL.
Refactor existing login/TOTP throttling to use the shared interface.
Add tests for lockout, reset, and backend selection.
Update .env.example and docs.
Run lint, type-check, and auth tests.
```

---

## PR 8.2 — File upload adversarial tests

### Required test cases

- path traversal filename
- double extension
- wrong MIME type
- oversized file
- empty file
- SVG/script payload if SVG upload is supported

### Acceptance criteria

- Tests document current behavior.
- Small unsafe gaps may be fixed in this PR.
- Larger unsafe gaps must be documented as follow-up work.
- No broad upload rewrite.

### Codex prompt

```text
Add adversarial tests for file upload endpoints.

Cover path traversal filenames, double extensions, wrong MIME types, oversized files, empty files, and SVG/script payloads if SVG upload is supported.
First document current behavior. If small unsafe gaps are found, fix them in this PR; otherwise leave explicit TODO tests or skipped tests with issue references.
Run lint, type-check, and upload/security tests.
```

---

# Stage 9 — Admin diagnostics and operations

## PR 9.1 — Health and diagnostics endpoints

### Target files

```text
app/api/health/route.ts
app/api/admin/health/route.ts
lib/ops/health.ts
```

### Required checks

Public `/api/health` should expose only minimal status.

Admin diagnostics may include:

- app version / commit SHA if available
- database connectivity
- migration/schema compatibility if available
- writable upload/temp/backup directories
- latest backup timestamp
- latest accounting batch
- latest WooCommerce sync
- latest FX sync

### Acceptance criteria

- Public endpoint returns minimal status.
- Admin endpoint returns detailed diagnostics.
- No secrets or raw env vars exposed.
- Tests cover unauthenticated and admin access.

### Codex prompt

```text
Add health and diagnostics endpoints.

Create a minimal public /api/health route that does not expose sensitive details.
Create an admin-only diagnostics route with DB connectivity, writable directory checks, app version/commit if available, latest backup, latest accounting batch, latest WooCommerce sync, and latest FX sync.
Do not expose secrets or raw environment variables.
Add tests for public, unauthenticated detailed, and admin detailed access.
Run lint, type-check, and ops/security tests.
```

---

## PR 9.2 — Cron run IDs and structured logs

### Target files

```text
lib/ops/cron-run.ts
```

### Fields

```text
runId
jobName
startedAt
finishedAt
status
counts
errorSummary
```

### Cron jobs to wire first

- accounting daily batch
- WooCommerce sync
- FX sync
- backup
- invariant check

### Acceptance criteria

- Logs include run ID.
- Failures are logged with summaries.
- Tests verify run IDs are persisted.

### Codex prompt

```text
Add a shared cron run logging helper.

Every cron execution should get a runId, jobName, startedAt, finishedAt, status, counts, and errorSummary.
Wire it into accounting daily batch, WooCommerce sync, FX sync, backup, and invariant check cron jobs.
Preserve current cron behavior.
Add tests that verify run IDs are persisted and failures are logged.
Run lint, type-check, and cron tests.
```

---

# Stage 10 — Import/export safety and performance

## PR 10.1 — Import dry-run standardization

### Shared result type

```ts
type ImportDryRunResult = {
  validRows: number;
  invalidRows: number;
  warnings: ImportWarning[];
  errors: ImportError[];
  proposedChanges: ImportChangeSummary;
};
```

### Acceptance criteria

- Existing import flows still work.
- Product, customer, and supplier imports support dry-run consistently.
- Dry-run performs no DB mutation.
- Tests verify no mutation in dry-run mode.

### Codex prompt

```text
Standardize CSV import dry-run behavior.

Create a shared ImportDryRunResult type and helper utilities.
Apply it to product, customer, and supplier imports first.
Dry-run must validate and return proposed changes without mutating the database.
Add tests proving dry-run causes no DB writes and reports row-level errors.
Run lint, type-check, and CSV import tests.
```

---

## PR 10.2 — Optimize stock availability map

### Goal

Avoid loading all stock levels when only scoped data is needed.

### Add scoped lookup support

- by product IDs
- by warehouse IDs
- by updated-since
- paginated result where useful

### Acceptance criteria

- Existing callers still work.
- New scoped helper is available.
- At least one high-volume caller uses the scoped helper.
- Tests compare old and scoped output for the same data.

### Codex prompt

```text
Optimize stock availability lookup.

Find getStockLevelMap or equivalent full-table stock map helpers.
Add scoped alternatives that can query by product IDs, warehouse IDs, updated-since, and pagination where useful.
Preserve the existing function for compatibility.
Refactor one high-volume caller to use the scoped helper.
Add tests comparing scoped output to the old full-map output for the same data.
Run lint, type-check, and stock/availability tests.
```

---

# Stage 11 — Documentation cleanup

## PR 11.1 — Canonical workflow docs generated from code where possible

### Target files

```text
docs/workflows.md
README.md
help-docs/*
```

### Requirements

- README remains high-level.
- `docs/workflows.md` becomes the canonical workflow reference.
- Contradictory model counts, deployment paths, and workflow descriptions are resolved.
- Production/deployment notes are clearly current or marked historical.
- If practical, workflow status tables are generated from state-machine definitions.

### Acceptance criteria

- Docs no longer contradict code on workflow statuses.
- Model counts are removed or generated.
- No application behavior changes.

### Codex prompt

```text
Clean up documentation drift.

Make docs/workflows.md the canonical workflow reference.
Update README to stay high-level and link to detailed docs.
Resolve contradictory model counts, deployment paths, and workflow status descriptions.
If possible, generate workflow status tables from the state-machine definitions.
Do not change application behavior.
Run docs-related checks if any, plus lint/type-check if touched files require it.
```

---

# Part 3 — Recommended sequencing

## Wave 1 — Low-risk safety and structure

Run these first. Some can be parallel if they touch separate areas.

```text
PR 0.1  Agent instructions
PR 0.2  Baseline validation script
PR 1.1  API route authorization inventory
PR 1.2  Secret scanning
PR 1.3  Cron auth hardening
PR 2.1  State-machine definitions only
```

## Wave 2 — Business logic extraction

Run mostly sequentially.

```text
PR 3.1  Allocation service
PR 3.2  Shipment service
PR 3.3  Refund service
PR 3.4  Landed-cost service
PR 2.2  Wire state machines into write paths
```

Allocation should come before shipment and refund because shipment/refund behavior depends on allocation behavior.

## Wave 3 — Invariants and precision

```text
PR 4.1  Inventory invariant engine
PR 4.2  Accounting invariant engine
PR 4.3  Scheduled invariant report
PR 5.1  Decimal helpers
PR 5.2  Replace high-risk Number conversions
```

Invariants should be in place before large accounting and integration changes.

## Wave 4 — Accounting and integration reliability

Run mostly sequentially.

```text
PR 6.1  AccountingEvent model
PR 6.2  Mirror current accounting actions
PR 6.3  Accounting reconciliation report
PR 7.1  IntegrationOutbox model
PR 7.2  WooCommerce outbox migration
PR 7.3  Xero outbox migration
```

Do not start Xero outbox migration until accounting-event mirroring and reconciliation are stable.

## Wave 5 — Ops, security, and scale

```text
PR 8.1   Redis-backed throttling
PR 8.2   Upload adversarial tests
PR 9.1   Health/diagnostics endpoints
PR 9.2   Cron run IDs
PR 10.1  CSV dry-run standardization
PR 10.2  Stock availability optimization
PR 11.1  Documentation cleanup
```

---

# Part 4 — First five tasks to assign

Start with these tasks in this order:

```text
1. PR 0.1 / 0.2 — Agent instructions and validation script
2. PR 1.1 — API route authorization inventory
3. PR 1.3 — Cron auth hardening
4. PR 2.1 — Canonical workflow state-machine definitions
5. PR 4.1 — Inventory invariant reporting engine
```

This sequence gives the biggest safety gain before touching core accounting and inventory workflows.

---

# Part 5 — Rollout risk notes

## Highest-risk stages

- Stage 3 shipment/refund extraction
- Stage 5 Decimal conversion in domain paths
- Stage 6 accounting events
- Stage 7 Xero outbox migration

## Rollout recommendations

- Deploy low-risk safety stages first.
- Run invariant reports in read-only/report-only mode before any auto-repair exists.
- Mirror accounting events before switching any posting behavior.
- Keep old sync logs as source of truth until reconciliation has run cleanly for multiple cycles.
- Add feature flags for integration outbox migrations if practical.
- Preserve rollback paths for migrations that add tables before code starts depending on them.

---

# Part 6 — Definition of done for the whole initiative

The initiative is complete when:

- All API routes are classified and covered by an auth inventory test.
- Cron auth is production-safe.
- Workflow state transitions are centralized and enforced.
- Core business logic is testable in `lib/domain` rather than embedded in server actions.
- Inventory and accounting invariants can be run manually and by cron.
- High-risk money and quantity calculations use Decimal-safe helpers.
- Accounting events are mirrored, reconciled, and ready to become the long-term source of truth.
- Integration side effects use an idempotent outbox for at least WooCommerce stock sync and Xero posting.
- Login/TOTP throttling supports Redis for multi-process safety.
- Uploads have adversarial tests.
- Admin diagnostics expose operational health without leaking secrets.
- Import dry-run behavior is standardized for key CSV imports.
- Documentation reflects the code and no longer contradicts workflow definitions.

