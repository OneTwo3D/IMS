# IMS Follow-up Implementation Plan for Codex

Repository: `OneTwo3D/IMS`  
Base branch: `development`  
Target PR branch pattern: `codex/<short-task-name>`  
Runtime: Node `>=22.0.0`, Next.js `16.2.3`, TypeScript, Prisma `7.7.0`

This plan is the next implementation round after the first architecture/safety plan was completed. It focuses on making the new safety infrastructure enforce behavior at runtime, hardening inventory/accounting/WMS flows, and reducing operational risk.

---

## Non-negotiable branch rule

All work must use **`development`** as the base branch.

Do **not** target `main`.  
Do **not** fall back to `main` if `development` is unavailable.  
If `development` cannot be checked out, stop and report the issue.

Codex setup for every task:

```bash
git fetch origin
git checkout development
git pull --ff-only origin development
test "$(git branch --show-current)" = "development"

npm ci
npm run validate
```

Then create a feature branch:

```bash
git checkout -b codex/<short-task-name>
```

Every PR must target `development`.

---

## Global rules for every Codex task

Each PR must preserve existing behavior unless the task explicitly says otherwise.

Every PR summary must include:

```text
Base branch: development
Feature branch: codex/<short-task-name>

Validation run:
- npm run lint
- npm run type-check
- npm run validate
- npm run validate:db, only if schema/migrations changed
- npm run e2e:select, if workflow/UI behavior changed

Risk areas:
- inventory
- accounting
- WMS/Mintsoft
- authentication/authorization
- migrations
```

For all business workflows:

```text
- Add tests before or alongside behavior changes.
- Keep server actions thin.
- Put reusable business rules in lib/domain/** or lib/jobs/**.
- Avoid new business logic in React components.
- Avoid Number/decimalToNumber in financial or inventory calculations.
- Do not log secrets, tokens, API keys, passwords, raw OAuth tokens, webhook secrets, or credential payloads.
- Prefer idempotent jobs and deterministic idempotency keys for external side effects.
```

---

# Stage 0 — Validation and agent guardrails

## Goal

Make the repo safe for continued agent work. Complete this stage before deeper inventory, WMS, or accounting changes.

---

## PR 0.1 — Add unit test script and include tests in validation

### Problem

The repo has tests, but `npm run validate` does not yet run the new unit/security tests.

### Implementation

Add scripts to `package.json`:

```json
{
  "scripts": {
    "test:unit": "NODE_OPTIONS='--import tsx' node --test \"tests/**/*.test.ts\"",
    "validate": "bash scripts/validate-local.sh"
  }
}
```

Update `scripts/validate-local.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

schema_scope_base_ref="${SCHEMA_SCOPE_BASE_REF:-origin/development}"
schema_scope_head_ref="${SCHEMA_SCOPE_HEAD_REF:-HEAD}"

npm run lint
npm run type-check
npx prisma generate --schema prisma/schema.prisma
npm run test:unit
npm run docs:workflows:check
npm run db:schema:scope -- "${schema_scope_base_ref}" "${schema_scope_head_ref}"
```

Do not make Playwright mandatory in local `validate` unless CI time is acceptable.

### Acceptance criteria

```text
- npm run test:unit exists.
- npm run validate runs unit/security tests.
- npm run docs:workflows:check runs during validate.
- Existing validation commands still pass.
- No app behavior changed.
```

### Codex prompt

```text
Implement PR 0.1.

Base branch: development.

Add a unit test script that runs tests/**/*.test.ts through node --test with tsx.
Update scripts/validate-local.sh so npm run validate runs lint, type-check, prisma generate, unit tests, workflow docs check, and schema scope check.
Do not change app behavior.
Run npm run validate.
Summarize changed files and any existing failing tests.
```

---

## PR 0.2 — Fix AGENTS.local.md branch and testing drift

### Problem

Agent instructions and docs need to reflect the current workflow: use `development`, run tests, and do not target `main`.

### Implementation

Update:

```text
AGENTS.local.md
docs/development.md
```

Required content:

```text
- Base branch for all work: development.
- PRs target development unless a human explicitly says otherwise.
- main is not the implementation branch.
- npm run validate is mandatory before PR.
- npm run validate:db is mandatory for schema/migration changes.
- npm run e2e:select is mandatory for workflow/UI changes.
- Do not change inventory/accounting behavior without tests.
- Keep server actions thin.
- Put domain logic in lib/domain/**.
- Do not commit secrets.
```

### Acceptance criteria

```text
- No docs tell agents to develop directly from main.
- Docs mention tests now exist.
- Docs mention development as the project integration branch.
- No app behavior changed.
```

### Codex prompt

```text
Implement PR 0.2.

Base branch: development.

Update AGENTS.local.md, and docs/development.md so they accurately describe the current workflow:
development is the implementation branch, PRs target development, npm run validate is required, npm run validate:db is required for schema changes, and workflow/UI changes require relevant Playwright tests.

Remove or clearly mark stale statements saying there are no tests or that agents should work from main.
Do not change application code.
Run npm run validate.
```

---

# Stage 1 — Executable authorization safety

## Goal

The route policy map is useful, but it must become an enforcement test rather than just documentation.

---

## PR 1.1 — Add executable API authorization tests

### Problem

The policy map classifies routes, but current tests mainly verify that every route is listed. The next step is verifying actual behavior.

### Implementation

Add:

```text
tests/security/api-route-auth-behavior.test.ts
lib/testing/api-route-test-harness.ts
```

Test behavior by classification:

```text
cron-secret:
  - request without Authorization => 401
  - request with invalid Bearer token => 401
  - request with valid Bearer CRON_SECRET => not 401

admin:
  - unauthenticated => 401/403
  - non-admin => 403 where practical
  - admin => allowed where practical

authenticated:
  - unauthenticated => 401/403

supplier:
  - unauthenticated => 401/403
  - supplier can access own resources only, where fixture data supports this

internal-dev-only:
  - NODE_ENV !== development or E2E_TEST_MODE !== 1 => 404

public-webhook:
  - must have explicit signature/token/signed-url tests where applicable
```

Do not try to fully hit every dynamic route in one PR. Start with representative routes and a framework that makes adding coverage easy.

### Acceptance criteria

```text
- Test harness exists.
- At least one route per major classification is behavior-tested.
- Missing/unsafe public-webhook behavior is reported with TODO tests or skipped tests carrying explicit issue comments.
- Existing route inventory test still passes.
```

### Codex prompt

```text
Implement PR 1.1.

Base branch: development.

Create an executable API route authorization behavior test harness.
Use the existing route auth policy as input, but do not rely on policy comments alone.
Add behavior tests for representative cron-secret, admin, authenticated, internal-dev-only, and public-webhook routes.

Do not rewrite auth. Only add tests and small testability helpers.
If a route cannot be safely invoked due to missing fixtures, add a skipped TODO test explaining what fixture is needed.
Run npm run test:unit and npm run validate.
```

---

## PR 1.2 — Enforce public-webhook security checklist

### Problem

Public routes need stronger documented and tested security properties.

### Implementation

For every policy entry classified as:

```text
public-webhook
xero-oauth
internal-dev-only
```

add a structured checklist:

```ts
type PublicRouteSecurityProperty =
  | "hmac-signature"
  | "signed-url-token"
  | "oauth-state"
  | "body-size-limit"
  | "timestamp-replay-protection"
  | "development-only"
  | "no-sensitive-output";
```

Create:

```text
lib/security/public-route-security-policy.ts
tests/security/public-route-security-policy.test.ts
```

### Acceptance criteria

```text
- Every public-like route has listed security properties.
- Tests fail if a public-like route lacks a security policy entry.
- No app behavior changed.
```

### Codex prompt

```text
Implement PR 1.2.

Base branch: development.

Add a public-route security policy map for routes classified as public-webhook, xero-oauth, or internal-dev-only.
Each route must list security properties such as hmac-signature, signed-url-token, oauth-state, timestamp-replay-protection, body-size-limit, development-only, and no-sensitive-output.
Add tests that fail if any public-like route lacks a security policy.
Do not change route behavior in this PR.
Run npm run validate.
```

---

# Stage 2 — Shipment and inventory transaction hardening

## Goal

Make stock dispatch, FIFO consumption, and shipment status transitions robust under concurrency and operational mistakes.

---

## PR 2.1 — Reload and lock shipment lines inside dispatch transaction

### Problem

Shipment dispatch currently loads shipment and lines before opening the transaction, then uses that preloaded data inside the transaction. This risks stale line data during concurrent edits or repairs.

### Implementation

In shipment dispatch:

```text
- Open transaction.
- Lock shipment row FOR UPDATE.
- Reload shipment, order, warehouse, and shipment lines inside the transaction.
- Validate shipment is still at the expected status.
- Validate shipment lines are non-empty.
- Lock stock levels for the reloaded product/warehouse set.
- Proceed with stock decrement/FIFO consumption using reloaded rows only.
```

Add tests for:

```text
- dispatch uses reloaded shipment lines
- dispatch fails cleanly if shipment status changed concurrently
- dispatch fails if lines are empty
```

### Acceptance criteria

```text
- No pre-transaction shipment-line data is used for stock mutations.
- Dispatch remains idempotent if already shipped.
- Existing shipment and COGS tests pass.
```

### Codex prompt

```text
Implement PR 2.1.

Base branch: development.

Harden shipment dispatch so all shipment rows and shipment lines used for stock mutations are locked and reloaded inside the dispatch transaction.
Do not use shipment line data loaded before the transaction for stock, FIFO, movement, COGS, or snapshot writes.

Add tests for stale/concurrent status change and empty shipment lines.
Run npm run test:unit, npm run validate, and relevant shipment/COGS Playwright tests if available.
```

---

## PR 2.2 — Conditional stock updates for dispatch

### Problem

Stock decrements should fail if physical quantity or reserved quantity is insufficient.

### Implementation

Replace unconditional stock decrement writes with conditional updates:

```ts
const updated = await tx.stockLevel.updateMany({
  where: {
    productId,
    warehouseId,
    quantity: { gte: qty },
    reservedQty: { gte: qty },
  },
  data: {
    quantity: { decrement: qty },
    reservedQty: { decrement: qty },
  },
})

if (updated.count !== 1) {
  throw new Error("Insufficient physical or reserved stock to dispatch")
}
```

Use Decimal-safe comparison where possible.

### Acceptance criteria

```text
- Dispatch cannot make quantity negative.
- Dispatch cannot make reservedQty negative.
- Failure leaves shipment unshipped and stock unchanged.
- Tests cover insufficient quantity and insufficient reservedQty.
```

### Codex prompt

```text
Implement PR 2.2.

Base branch: development.

Change shipment dispatch stock updates to conditional updates that require quantity >= dispatched quantity and reservedQty >= dispatched quantity.
If the conditional update fails, throw a clear user-safe error and roll back the transaction.
Add tests for insufficient physical quantity and insufficient reserved quantity.
Run npm run validate and relevant shipment tests.
```

---

## PR 2.3 — Database check constraints for stock and cost layers

### Problem

The app has invariant checks, but the database should also prevent impossible quantities.

### Implementation

Add a migration with PostgreSQL check constraints:

```sql
ALTER TABLE stock_levels
  ADD CONSTRAINT stock_levels_quantity_nonnegative CHECK (quantity >= 0),
  ADD CONSTRAINT stock_levels_reserved_nonnegative CHECK ("reservedQty" >= 0);

ALTER TABLE cost_layers
  ADD CONSTRAINT cost_layers_received_nonnegative CHECK ("receivedQty" >= 0),
  ADD CONSTRAINT cost_layers_remaining_nonnegative CHECK ("remainingQty" >= 0),
  ADD CONSTRAINT cost_layers_remaining_lte_received CHECK ("remainingQty" <= "receivedQty");

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_qty_nonnegative CHECK (qty >= 0);
```

Before adding constraints, include preflight SQL that raises a clear exception if invalid data already exists.

### Acceptance criteria

```text
- Migration fails with clear message if invalid existing data exists.
- validate:db passes on a clean DB.
- Invariant tests still pass.
```

### Codex prompt

```text
Implement PR 2.3.

Base branch: development.

Add PostgreSQL check constraints to prevent negative stock_levels.quantity, negative stock_levels.reservedQty, negative cost layer received/remaining quantities, cost layer remainingQty greater than receivedQty, and negative stock movement qty.
Include migration preflight checks that raise clear errors if existing bad data would violate the constraints.
Update schema comments if useful.
Run npm run validate and npm run validate:db.
```

---

# Stage 3 — Reservation versus backorder model

## Goal

Separate physical stock reservation from accepted demand that has no stock yet.

---

## PR 3.1 — Add derived backorder reporting without schema changes

### Problem

`oversellAllowed` currently risks being conflated with reserving non-existent stock. First add reporting before changing writes.

### Implementation

Create:

```text
lib/domain/inventory/backorder-report.ts
tests/domain/inventory/backorder-report.test.ts
```

Report by order line:

```text
orderedQty
shippedQty
allocatedQty
unallocatedQty
backorderEligible
```

No schema changes yet.

### Acceptance criteria

```text
- Report identifies unallocated demand.
- Report distinguishes unallocated because of stock shortage vs non-stockable/non-inventory.
- No mutation behavior changed.
```

### Codex prompt

```text
Implement PR 3.1.

Base branch: development.

Add a backorder/unallocated demand reporting module without changing schema or allocation behavior.
It should calculate ordered, shipped, allocated, unallocated, and backorder-eligible quantities by sales order line.
Add unit tests for fully allocated, partially allocated, shipped, non-inventory, and oversell-allowed products.
Run npm run validate.
```

---

## PR 3.2 — Enforce reservedQty as physical-only

### Problem

`reservedQty` should represent physical stock reserved, not unmet demand.

### Implementation

After PR 3.1, update allocation rules:

```text
- Never increment reservedQty beyond quantity.
- Leave unfulfilled demand as unallocated/backordered.
- Make allocation result include unallocated lines.
- Update UI to show backordered/unallocated quantities.
```

### Acceptance criteria

```text
- reservedQty <= quantity after allocation.
- Oversell-allowed products can still accept sales orders.
- Oversell-allowed demand remains unallocated until stock arrives.
- Tests cover oversell allowed with no stock.
```

### Codex prompt

```text
Implement PR 3.2.

Base branch: development.

Change allocation semantics so reservedQty only represents physical stock.
Do not reserve more than available physical stock.
For oversell-allowed products, leave unavailable demand as unallocated/backordered rather than increasing reservedQty beyond quantity.
Update allocation result types and UI messages to surface unallocated/backordered quantities.
Add tests for oversell allowed with no stock and partial stock.
Run npm run validate and relevant sales/allocation tests.
```

---

# Stage 4 — Decimal safety completion

## Goal

Keep Decimal-safe math in all inventory and accounting domain paths.

---

## PR 4.1 — Add lint guard against `decimalToNumber` in domain calculations

### Problem

The new Decimal helpers exist, but the old `decimalToNumber` helper remains available and is still used in domain paths.

### Implementation

Add ESLint restriction or custom script:

```text
scripts/check-domain-decimal-boundaries.mjs
```

Fail when `@/lib/decimal` is imported from:

```text
lib/domain/**
lib/cost-layers.ts
lib/connectors/xero/**
lib/connectors/quickbooks/**
app/actions/xero*
app/actions/accounting*
```

Allow exceptions with explicit comments:

```ts
// decimal-boundary-ok: display-only conversion
```

### Acceptance criteria

```text
- Check runs in npm run validate.
- Existing violations are either fixed or explicitly whitelisted with reason.
- No business behavior changed.
```

### Codex prompt

```text
Implement PR 4.1.

Base branch: development.

Add a validation check that prevents accidental use of '@/lib/decimal' decimalToNumber in domain/accounting/inventory calculation paths.
Allow explicit exceptions only with a comment explaining that the conversion is display-only or external API boundary-only.
Wire the check into npm run validate.
Do not do large math refactors in this PR.
Run npm run validate.
```

---

## PR 4.2 — Convert landed-cost deltas to Decimal

### Problem

Landed-cost revaluation still calculates several financial deltas with plain numbers.

### Implementation

Refactor landed-cost calculations to use Decimal helpers for:

```text
costDelta
consumedQty
netConsumedQty
cogsDelta
inventoryDelta
totalCogsDelta
totalInventoryDelta
```

Only convert to number at:

```text
- Prisma write boundary
- accounting payload boundary
- UI boundary
```

### Acceptance criteria

```text
- Existing landed-cost tests pass.
- Add rounding-sensitive landed-cost regression test.
- No user-visible calculation regression except improved precision.
```

### Codex prompt

```text
Implement PR 4.2.

Base branch: development.

Refactor landed-cost revaluation calculations to use Decimal-safe helpers instead of plain number arithmetic for cost and quantity deltas.
Only convert to number at Prisma write or external payload boundaries.
Add a rounding-sensitive regression test.
Run npm run validate and landed-cost tests.
```

---

## PR 4.3 — Convert allocation availability maps to Decimal

### Problem

Allocation availability maps currently do much of their internal quantity math as numbers.

### Implementation

Refactor allocation internals:

```text
Map<string, Map<string, Decimal>>
```

Use Decimal for:

```text
available quantity
component requirements
reserved/released quantity
coverage calculation inputs where practical
```

This may require updating fulfillment helpers gradually. Keep scope limited to allocation service first.

### Acceptance criteria

```text
- Allocation behavior preserved.
- Partial/kit/BOM allocation tests pass.
- Add fractional quantity regression test.
```

### Codex prompt

```text
Implement PR 4.3.

Base branch: development.

Refactor allocation service availability and reservation math to use Decimal-safe helpers internally.
Avoid broad refactors outside allocation unless required.
Add a fractional quantity regression test, especially for bundles/components.
Run npm run validate and allocation tests.
```

---

## PR 4.4 — Remove remaining landed-cost Decimal boundary contracts

### Problem

PR 4.2 keeps landed-cost delta math Decimal-safe internally, but three dependency contracts still cross a `number` boundary:

```text
getReturnedQtyForCostLayer
getSupplierReturnedQtyForCostLayer
updateSnapshotsForCostLayerChange
```

Returned quantities can be fractional, and cost-layer snapshots are auditable inventory records. Passing these values through `number` can still reintroduce binary floating-point drift at the edge of landed-cost revaluation.

### Implementation

Widen the landed-cost and cost-layer dependency contracts:

```text
- getReturnedQtyForCostLayer returns Prisma.Decimal
- getSupplierReturnedQtyForCostLayer returns Prisma.Decimal
- updateSnapshotsForCostLayerChange accepts Prisma.Decimal or a Decimal-safe input and serializes explicitly at the JSON boundary
```

Keep existing external JSON shape stable unless a migration plan is added.

### Acceptance criteria

```text
- Landed-cost recalculation has no internal number boundary before accounting payload or JSON serialization.
- Fractional return quantities keep Decimal precision through retrospective COGS calculations.
- Snapshot JSON updates remain backward-compatible.
- Existing landed-cost, FIFO, refund, and shipment COGS tests pass.
```

### Codex prompt

```text
Implement PR 4.4.

Base branch: development.

Remove the remaining number boundaries in landed-cost dependency contracts by widening returned-quantity helpers and cost-layer snapshot update inputs to Decimal-safe values.
Keep JSON serialization explicit and backward-compatible.
Add focused fractional-return and snapshot-boundary regression tests.
Run npm run validate and landed-cost/FIFO/refund tests.
```

---

## PR 4.5 — Decimalize manufacturing cost revaluation

Status: implemented in the PR 4.4 follow-up branch.

### Problem

PR 4.4 removes the landed-cost dependency number boundaries, but `recalculateManufacturingCostLayers` still mirrors the old revaluation pattern:

```text
unitDelta
returnedQty conversion
consumedQty
netCogsDeltaBase
netInventoryDeltaBase
```

Those values are still calculated as `number`, and `recomputeManufacturingUnitCosts` returns number-shaped unit costs. This is a separate manufacturing-costing path, so it should be fixed in its own reviewable PR rather than hidden inside the landed-cost contract cleanup.

The other rolling Stage-4 follow-ups from PRs 4.2-4.4 have been handled in PR 4.4 follow-up work:

```text
- docs/development.md documents ROUND_HALF_UP as the system rounding standard.
- lib/domain/sales/refund-service.ts no longer carries a legacy-pre-stage-4 decimalToNumber import boundary.
- lib/domain/sales/shipment-service.ts no longer carries a legacy-pre-stage-4 decimalToNumber import boundary.
```

### Implementation

Refactor manufacturing cost-layer revaluation to use Decimal-safe helpers internally:

```text
- recomputeManufacturingUnitCosts input and output contracts
- recalculateManufacturingCostLayers unit deltas and returned quantities
- consumed quantity, COGS delta, inventory delta, and net totals
- snapshot refresh inputs
```

Only convert to number at Prisma writes, journal payload boundaries, JSON snapshot serialization, or UI display boundaries.

### Acceptance criteria

```text
- Manufacturing cost-layer revaluation has no internal number boundary for unitDelta, consumedQty, returnedQty, COGS delta, or inventory delta.
- Fractional manufacturing-cost recalculation has parity coverage against the landed-cost Decimal behavior.
- Existing manufacturing, landed-cost, refund, shipment, FIFO, and accounting tests pass.
```

### Codex prompt

```text
Implement PR 4.5.

Base branch: development.

Decimalize manufacturing cost-layer revaluation and the pure manufacturing unit-cost helper so fractional manufacturing-cost recalculations do not cross number boundaries internally.
Run npm run validate and manufacturing/landed-cost/refund/shipment tests.
```

---

# Stage 5 — WMS / Mintsoft webhook reliability

## Goal

Make Mintsoft webhook receipt durable, replay-safe, and asynchronous.

---

## PR 5.1 — Bind webhook timestamp to the HMAC signature

Status: implemented in PR #55.

### Problem

Webhook replay protection must ensure the timestamp cannot be swapped independently of the signed body.

### Implementation

Choose one supported signing format and document it:

```text
signedPayload = `${timestamp}.${rawBody}`
signature = HMAC_SHA256(webhookSecret, signedPayload)
```

Reject legacy body-only signatures. The system was not live when this stage
landed, so no compatibility flag or fallback path is required.

### Acceptance criteria

```text
- Fresh signed timestamp + body succeeds.
- Stale signed timestamp fails.
- Valid body signature with tampered timestamp fails.
- Legacy body-only signatures are rejected.
- Docs updated.
```

### Codex prompt

```text
Implement PR 5.1.

Base branch: development.

Update Mintsoft webhook signature validation so the timestamp is bound into the signed payload.
Preferred signed payload format: `${timestamp}.${rawBody}`.
Require the timestamp header used for freshness validation to be the same value included in signature verification.
Add tests for valid signature, stale timestamp, tampered timestamp, missing timestamp, and body-only rejection.
Run npm run validate and Mintsoft webhook tests.
```

---

## PR 5.2 — Change Mintsoft webhook route to persist-and-202

Status: implemented in PR #55.

### Problem

The webhook currently validates, persists, then processes stock/PO effects synchronously. Webhook response time should not depend on internal stock reconciliation.

### Implementation

Change route flow:

```text
validate body/signature/timestamp
persist event idempotently
mark event pending for worker
return 202 Accepted
```

Do not process stock mutations inside the webhook request.

Use worker:

```text
lib/jobs/wms/process-mintsoft-booked-in-events.ts
app/api/cron/mintsoft-webhook-sweeper/route.ts
```

The job delegates to the existing booked-in event sweeper.

### Acceptance criteria

```text
- Webhook returns 202 after successful persistence.
- Duplicate already-processed event returns 200/202 with duplicate marker.
- Processing failures do not cause webhook 500.
- Cron/worker processes pending events.
```

### Codex prompt

```text
Implement PR 5.2.

Base branch: development.

Change Mintsoft ASN booked-in webhook handling to persist the event and return 202 without performing stock/PO mutations in the request path.
Move processing to the existing sweeper/cron path or a new lib/jobs/wms processor.
Preserve idempotency and duplicate behavior.
Add tests showing webhook persistence succeeds even when downstream processing would fail.
Run npm run validate and Mintsoft workflow tests.
```

---

## PR 5.3 — Add direct ASN lookup to WMS connector

Status: implemented in PR #56.

### Problem

Booked-in processing currently fetches all ASNs and searches for one. That will not scale.

### Implementation

Extend WMS connector interface:

```ts
fetchAsnById?(externalAsnId: string): Promise<WmsAsnRef | null>
```

Implement in Mintsoft connector.

Use direct lookup in booked-in processing.

Keep fetch-all for reconciliation/backfill jobs.

The implementation uses the optional WMS connector method for the direct path and keeps `MINTSOFT_USE_BULK_ASN_LOOKUP=true` as a temporary rollback flag if Mintsoft endpoint discovery proves `/api/ASN/:id` incompatible in staging.

### Acceptance criteria

```text
- Booked-in processing uses direct ASN lookup.
- Existing tests updated.
- Fetch-all behavior remains available for bulk reconciliation.
```

### Codex prompt

```text
Implement PR 5.3.

Base branch: development.

Add optional fetchAsnById(externalAsnId) to the WMS connector interface and implement it for Mintsoft.
Refactor booked-in event processing to use direct ASN lookup instead of fetching all ASNs and searching client-side.
Keep fetch-all methods for reconciliation/backfill.
Add tests verifying direct lookup is used.
Run npm run validate and Mintsoft tests.
```

---

## PR 5.4 — Replace encoded webhook retry state with typed fields

### Problem

Retry state should not be encoded inside an error string.

### Implementation

Add migration fields to WMS inbound receipt events:

```text
processingStatus      String/Enum
processingAttempts    Int
nextRetryAt           DateTime?
deadLetteredAt        DateTime?
lastError             String?
```

Backfill existing `processingError` values where possible.

### Acceptance criteria

```text
- Retry state is queryable without parsing strings.
- Sweeper uses nextRetryAt and processingStatus.
- Dead events are visible in admin/sync UI or at least queryable.
- Existing behavior preserved.
```

### Codex prompt

```text
Implement PR 5.4.

Base branch: development.

Replace encoded Mintsoft webhook retry state stored in processingError with typed columns.
Add migration fields: processingStatus, processingAttempts, nextRetryAt, deadLetteredAt, lastError.
Backfill existing retry-state strings where possible.
Update processing and sweeper logic to use typed fields.
Add tests for pending retry, failed retry, dead-letter, and successful processing.
Run npm run validate and npm run validate:db.
```

---

# Stage 6 — Connector URL and secret safety

## Goal

Prevent SSRF and reduce blast radius of stored connector credentials.

---

## PR 6.1 — Add server-side connector URL safety

### Implementation

Create:

```text
lib/security/external-url-safety.ts
tests/security/external-url-safety.test.ts
```

Rules:

```text
production:
  - require https
  - block localhost
  - block 127.0.0.0/8
  - block ::1
  - block RFC1918 private ranges
  - block link-local
  - block cloud metadata IPs
  - optionally allowlist known connector domains

development/e2e:
  - allow local URLs only when E2E_TEST_MODE=1
```

Apply to:

```text
Mintsoft base URL
WooCommerce store URL
Shopify URL if present
QuickBooks/Xero custom URLs if any
SFTP host validation where applicable
```

### Acceptance criteria

```text
- Production private/internal URLs are rejected.
- E2E local URLs still work only in E2E mode.
- Tests cover IPv4, IPv6, hostnames, protocol tricks, and missing protocols.
```

### Codex prompt

```text
Implement PR 6.1.

Base branch: development.

Add a reusable external URL safety validator and apply it to connector base URLs, starting with Mintsoft and WooCommerce.
In production, require HTTPS and block localhost, private IPs, link-local, ::1, and metadata IPs.
Allow local test URLs only when E2E_TEST_MODE=1.
Add comprehensive tests for URL parsing edge cases.
Run npm run validate.
```

---

## PR 6.2 — Add encrypted settings for connector secrets

### Implementation

Add helper:

```text
lib/security/encrypted-settings.ts
```

Environment:

```env
SETTINGS_ENCRYPTION_KEY=
```

Support:

```text
encryptSettingValue(key, plaintext)
decryptSettingValue(key, ciphertext)
rotateSettingEncryptionKey plan/docs
```

Start with new writes only:

```text
Mintsoft password
Mintsoft API key
Mintsoft webhook secret
WooCommerce consumer secret
OAuth refresh tokens if stored in settings
```

Do not break old plaintext values; migrate lazily on next save or add a migration command.

### Acceptance criteria

```text
- New secret writes are encrypted.
- Existing plaintext settings can still be read.
- Save operation rewrites plaintext to encrypted format.
- Secrets are never logged.
```

### Codex prompt

```text
Implement PR 6.2.

Base branch: development.

Add encrypted settings support for connector secrets using SETTINGS_ENCRYPTION_KEY.
New secret writes should be encrypted.
Existing plaintext values should remain readable and be migrated lazily on save.
Start with Mintsoft secrets and WooCommerce secrets.
Add tests for encryption, decryption, missing key behavior, legacy plaintext compatibility, and log safety.
Update .env.example and docs.
Run npm run validate.
```

---

# Stage 7 — Accounting reconciliation and landed-cost audit

## Goal

Make accounting anomalies durable, reviewable, and broader than recent active sales orders.

---

## PR 7.1 — Include terminal orders in accounting reconciliation

### Implementation

Update reconciliation so it includes:

```text
REFUNDED
PARTIALLY_REFUNDED
CANCELLED
COMPLETED
DELIVERED
```

Classify terminal-order findings differently rather than excluding them.

Add checks for:

```text
cancelled order with posted accounting but no reversal
refunded order missing credit-note evidence
refunded order missing reversal evidence
posted event without external ID
event without source
duplicate external references
```

### Acceptance criteria

```text
- Terminal orders are reconciled.
- Existing active-order reconciliation still works.
- Tests cover cancelled-after-posting and refunded-after-shipment cases.
```

### Codex prompt

```text
Implement PR 7.1.

Base branch: development.

Expand accounting reconciliation so terminal sales order statuses are included rather than excluded.
Add checks for cancelled orders with posted accounting but no reversal, refunded orders missing credit-note evidence, and refunded orders missing reversal evidence.
Preserve existing reconciliation behavior for active orders.
Add tests for cancelled and refunded terminal-order scenarios.
Run npm run validate and accounting reconciliation tests.
```

---

## PR 7.2 — Persist reconciliation runs and findings

### Implementation

Add models:

```prisma
model AccountingReconciliationRun {
  id            String   @id @default(cuid())
  fromDate      DateTime?
  toDate        DateTime?
  status        String
  totalCount    Int
  warningCount  Int
  criticalCount Int
  createdAt     DateTime @default(now())
}

model AccountingReconciliationFinding {
  id         String   @id @default(cuid())
  runId      String
  severity   String
  code       String
  entityType String?
  entityId   String?
  message    String
  details    Json
  status     String   @default("OPEN")
  createdAt  DateTime @default(now())
}
```

Admin endpoint should support:

```text
dry-run report
persist report
list previous runs
mark finding resolved/accepted
```

### Acceptance criteria

```text
- Reports can be persisted.
- Findings can be reviewed later.
- Existing report API still supports non-persistent mode.
```

### Codex prompt

```text
Implement PR 7.2.

Base branch: development.

Add persistent AccountingReconciliationRun and AccountingReconciliationFinding models.
Update reconciliation admin APIs to support dry-run and persisted runs.
Add APIs or server actions to list runs and mark findings resolved or accepted.
Do not change accounting posting behavior.
Add tests for persisted run creation and finding status updates.
Run npm run validate and npm run validate:db.
```

---

## PR 7.3 — Add landed-cost revaluation audit runs

### Implementation

Add:

```prisma
model LandedCostRevaluationRun {
  id             String   @id @default(cuid())
  freightPoId    String?
  primaryPoId    String?
  triggeredById  String?
  status         String
  reason         String?
  beforeJson     Json
  afterJson      Json
  accountingJson Json?
  warningsJson   Json?
  createdAt      DateTime @default(now())
}
```

Record:

```text
old cost-layer costs
new cost-layer costs
affected shipments
affected sales order lines
affected refund snapshots
generated accounting sync/event ids
warnings such as weight fallback
```

### Acceptance criteria

```text
- Every landed-cost recalculation writes an audit run.
- Dry-run option exists if practical.
- Audit run links to affected PO(s).
- Tests cover normal revaluation and warning capture.
```

### Codex prompt

```text
Implement PR 7.3.

Base branch: development.

Add LandedCostRevaluationRun audit records for landed-cost recalculations.
Capture before/after cost-layer data, affected shipments/order lines/refunds where available, generated accounting sync/event references, and warnings.
Refactor landed-cost warning logging so warnings can be returned and recorded instead of only logged as side effects.
Add tests for audit run creation and weight-fallback warning capture.
Run npm run validate and npm run validate:db.
```

---

# Stage 8 — Outbox as a typed job system

## Goal

Make outbox payloads typed, observable, and easier to replay safely.

---

## PR 8.1 — Add outbox operation registry and payload validation

### Implementation

Create:

```text
lib/domain/integrations/outbox-registry.ts
```

Registry example:

```ts
export const OUTBOX_OPERATIONS = {
  woocommerce: {
    stockSync: StockSyncPayloadSchema,
    invoiceNote: InvoiceNotePayloadSchema,
  },
  xero: {
    postAccountingEvent: AccountingEventPayloadSchema,
  },
  mintsoft: {
    processBookedInEvent: MintsoftBookedInPayloadSchema,
    syncStock: MintsoftStockSyncPayloadSchema,
  },
} as const
```

Validate on:

```text
enqueue
claim/process
manual replay
```

### Acceptance criteria

```text
- Invalid payloads cannot be enqueued.
- Existing outbox tests pass.
- At least WooCommerce stock sync and Mintsoft booked-in event payloads are typed.
```

### Codex prompt

```text
Implement PR 8.1.

Base branch: development.

Add an IntegrationOutbox operation registry with Zod payload schemas.
Validate payloadJson during enqueue and before processing.
Start with WooCommerce stock sync and Mintsoft booked-in event processing.
Do not migrate every connector in this PR.
Add tests for valid payloads, invalid payloads, and backwards-compatible existing rows where needed.
Run npm run validate.
```

---

## PR 8.2 — Add exponential backoff with jitter to outbox retries

### Implementation

Replace fixed retry delay with:

```text
baseDelay * 2^(attempt - 1) + jitter
cap at maxDelay
```

Configurable defaults:

```text
OUTBOX_RETRY_BASE_MS=300000
OUTBOX_RETRY_MAX_MS=3600000
OUTBOX_RETRY_JITTER_MS=30000
```

### Acceptance criteria

```text
- Retry delay increases by attempt count.
- Jitter is deterministic in tests.
- Max delay cap works.
- Existing outbox APIs still work.
```

### Codex prompt

```text
Implement PR 8.2.

Base branch: development.

Change IntegrationOutbox retry scheduling from fixed delay to exponential backoff with jitter and a max delay cap.
Add deterministic test hooks for jitter.
Update tests for retryable failure scheduling.
Document environment variables if added.
Run npm run validate.
```

---

## PR 8.3 — Add outbox dead-letter/replay admin endpoints

### Implementation

Add admin APIs:

```text
GET  /api/admin/outbox
POST /api/admin/outbox/[id]/replay
POST /api/admin/outbox/[id]/permanent-fail
```

Filters:

```text
connector
operation
status
created date
oldest pending
permanent failed
```

### Acceptance criteria

```text
- Admin-only.
- Replay creates a safe retry from failed/permanent failed rows.
- All operations logged.
- No secrets exposed in payload output; redact sensitive fields.
```

### Codex prompt

```text
Implement PR 8.3.

Base branch: development.

Add admin-only outbox inspection and replay endpoints.
Support filtering by connector, operation, status, and age.
Redact sensitive payload fields.
Add replay for failed/permanent-failed jobs by resetting status to PENDING with a new nextAttemptAt.
Log admin actions.
Add tests for authorization, redaction, and replay behavior.
Run npm run validate.
```

---

# Stage 9 — Health, cron, and invariants at scale

## Goal

Make operations visible and make invariant checks production-safe.

---

## PR 9.1 — Add dedicated CronRun table

### Implementation

Add model:

```prisma
model CronRun {
  id           String   @id @default(cuid())
  runId        String   @unique
  jobName      String
  startedAt    DateTime
  finishedAt   DateTime?
  durationMs   Int?
  status       String
  countsJson   Json?
  errorSummary String?
  createdAt    DateTime @default(now())

  @@index([jobName, startedAt])
  @@index([status, startedAt])
}
```

Update cron helper to write both `CronRun` and existing activity log during transition period.

### Acceptance criteria

```text
- Every cron using helper writes CronRun.
- ActivityLog behavior preserved.
- Health can query CronRun.
```

### Codex prompt

```text
Implement PR 9.1.

Base branch: development.

Add a dedicated CronRun model and update the shared cron-run helper to persist structured cron runs there while preserving existing ActivityLog writes.
Add tests for success, failure, skipped runs, duration, and counts.
Run npm run validate and npm run validate:db.
```

---

## PR 9.2 — Expand admin health diagnostics

### Implementation

Add health checks for:

```text
IntegrationOutbox pending/retry/permanent failed counts
oldest pending outbox job
latest invariant check run
latest critical invariant count
latest Mintsoft/WMS stock sync
oldest unprocessed Mintsoft webhook
dead-letter Mintsoft webhook count
cron freshness by job name
pending/failed AccountingEvent count
```

### Acceptance criteria

```text
- Admin health reports new operational surfaces.
- Public health remains minimal.
- No secrets exposed.
- Tests cover degraded status when critical counts exist.
```

### Codex prompt

```text
Implement PR 9.2.

Base branch: development.

Expand admin health diagnostics with outbox counts, oldest pending outbox job, latest invariant check, WMS/Mintsoft webhook state, cron freshness from CronRun, and pending/failed AccountingEvent counts.
Do not expose secrets or raw payloads.
Keep public /api/health minimal.
Add tests for ok, degraded, and down statuses.
Run npm run validate.
```

---

## PR 9.3 — SQL-backed inventory invariant collectors

### Problem

Current invariant collectors load broad row sets into memory. Keep pure evaluators for tests, but add production SQL collectors.

### Implementation

Add SQL collectors for:

```text
negative stock
reserved > quantity
negative cost layers
remaining > received
stock-vs-cost-layer aggregate mismatch
missing COGS snapshots
```

Support:

```text
limit
cursor/page
warehouseId
productId
severity
```

### Acceptance criteria

```text
- Existing evaluator tests still pass.
- Production report can run with bounded limit.
- Cron invariant check uses paginated collectors.
```

### Codex prompt

```text
Implement PR 9.3.

Base branch: development.

Add SQL-backed inventory invariant collectors so production checks do not need to load all stock, cost layers, and shipment lines into memory.
Keep existing in-memory evaluators for unit tests.
Support limit and optional filters.
Update cron invariant check to use bounded/paginated collectors.
Add tests comparing SQL collector output to evaluator output on seeded fixtures.
Run npm run validate.
```

---

# Stage 10 — Upload and file-storage hardening

## Goal

Reduce upload malware and persistence risks.

---

## PR 10.1 — Move upload directories to explicit env-configured paths

### Implementation

Add env vars:

```env
UPLOAD_STORAGE_DIR=/var/lib/onetwoinventory/uploads
PUBLIC_UPLOAD_STORAGE_DIR=/var/lib/onetwoinventory/public-uploads
```

Refactor upload/serve paths so production does not rely on `process.cwd()`.

### Acceptance criteria

```text
- Defaults preserve local dev behavior.
- Production can configure persistent paths.
- Health checks validate configured directories.
- Existing upload routes still work.
```

### Codex prompt

```text
Implement PR 10.1.

Base branch: development.

Refactor upload storage paths to use explicit environment-configured directories with safe local defaults.
Update avatar, branding, invoice upload, and file-serving routes as needed.
Update health directory checks.
Update .env.example and docs.
Add tests for path resolution and traversal safety.
Run npm run validate.
```

---

## PR 10.2 — Add PDF quarantine/scanning hook

### Implementation

Add abstraction:

```text
lib/security/file-scan.ts
```

Modes:

```env
FILE_SCAN_MODE=disabled
FILE_SCAN_COMMAND=
```

For uploaded invoice PDFs:

```text
upload
validate metadata/magic bytes
store in quarantine
scan
move to final storage only if clean
```

Start with command hook disabled by default.

### Acceptance criteria

```text
- Disabled mode preserves existing behavior.
- Command mode rejects infected/nonzero scan result.
- Scan errors fail closed for invoice PDFs.
- Audit logs record scan status without leaking file paths unnecessarily.
```

### Codex prompt

```text
Implement PR 10.2.

Base branch: development.

Add a file scanning abstraction for uploaded invoice PDFs.
Support disabled mode and command mode through environment variables.
In command mode, store upload in quarantine, scan it, and move to final storage only when clean.
Fail closed on scan errors.
Add tests for disabled mode, clean scan, infected scan, and scan command failure.
Run npm run validate.
```

---

# Stage 11 — Domain extraction cleanup

## Goal

Prevent newly added large files from becoming the next architecture bottleneck.

---

## PR 11.1 — Extract WMS booked-in service

### Implementation

Move business logic out of connector/webhook files into:

```text
lib/domain/wms/booked-in-service.ts
lib/domain/wms/asn-reconciliation.ts
lib/jobs/wms/process-booked-in-event.ts
```

Keep connector files responsible only for external API operations.

### Acceptance criteria

```text
- Webhook route is thin.
- Connector is external API only.
- Domain service is testable without Next route objects.
- Existing Mintsoft E2E tests pass.
```

### Codex prompt

```text
Implement PR 11.1.

Base branch: development.

Refactor Mintsoft booked-in processing into domain and job modules:
lib/domain/wms/booked-in-service.ts
lib/domain/wms/asn-reconciliation.ts
lib/jobs/wms/process-booked-in-event.ts

Keep route handlers thin and connector files focused on external API calls.
Do not change business behavior.
Add/adjust tests around the extracted service.
Run npm run validate and Mintsoft workflow tests.
```

---

## PR 11.2 — Extract manufacturing costing and state logic

### Implementation

Create:

```text
lib/domain/manufacturing/production-costing.ts
lib/domain/manufacturing/component-consumption.ts
lib/domain/manufacturing/manufacturing-state.ts
```

Focus only on pure/domain pieces first.

### Acceptance criteria

```text
- Manufacturing server actions shrink.
- Costing logic is unit-testable.
- Production order status transitions are centralized.
- No behavior changed.
```

### Codex prompt

```text
Implement PR 11.2.

Base branch: development.

Extract manufacturing costing, component consumption, and production status logic into lib/domain/manufacturing modules.
Keep server actions as adapters.
Do not change behavior.
Add unit tests for production costing and component consumption.
Run npm run validate and manufacturing tests.
```

---

# Recommended sequencing

## Wave 1 — Must do first

```text
PR 0.1  Add unit tests to validation
PR 0.2  Fix agent/docs branch and testing drift
PR 1.1  Executable API authorization tests
PR 2.1  Reload and lock shipment lines inside dispatch transaction
PR 2.2  Conditional stock updates for dispatch
```

These reduce the chance that later changes silently break critical flows.

## Wave 2 — Data correctness

```text
PR 2.3  DB check constraints
PR 3.1  Backorder reporting
PR 3.2  reservedQty physical-only
PR 4.1  Decimal boundary guard
PR 4.2  Decimal landed-cost deltas
PR 4.3  Decimal allocation maps
PR 4.4  Decimal landed-cost boundary contracts
PR 4.5  Decimal manufacturing revaluation
        Implemented in PR 4.4 follow-up branch.
```

## Wave 3 — WMS reliability and security

```text
PR 5.1  Signed timestamp for Mintsoft webhooks
PR 5.2  Persist-and-202 webhook flow
PR 5.3  Direct ASN lookup
PR 5.4  Typed webhook retry fields
PR 6.1  Connector URL SSRF protection
PR 6.2  Encrypted connector settings
```

## Wave 4 — Accounting and operations

```text
PR 7.1  Terminal-order accounting reconciliation
PR 7.2  Persist reconciliation runs/findings
PR 7.3  Landed-cost revaluation audit runs
PR 8.1  Typed outbox operation registry
PR 8.2  Outbox exponential backoff
PR 8.3  Outbox admin replay/dead-letter endpoints
```

## Wave 5 — Scale and cleanup

```text
PR 9.1   CronRun table
PR 9.2   Expanded admin health
PR 9.3   SQL-backed invariant collectors
PR 10.1  Env-configured upload paths
PR 10.2  PDF scan/quarantine hook
PR 11.1  WMS domain extraction
PR 11.2  Manufacturing domain extraction
```

---

# First Codex task to run

Use this exact task first:

```text
Repository: OneTwo3D/IMS
Base branch: development
Task: PR 0.1 — Add unit tests to validation

Set yourself up:
1. git fetch origin
2. git checkout development
3. git pull --ff-only origin development
4. test "$(git branch --show-current)" = "development"
5. npm ci
6. npm run validate

Implementation:
- Add npm script test:unit using NODE_OPTIONS='--import tsx' node --test "tests/**/*.test.ts".
- Update scripts/validate-local.sh so npm run validate runs:
  npm run lint
  npm run type-check
  npx prisma generate --schema prisma/schema.prisma
  npm run test:unit
  npm run docs:workflows:check
  npm run db:schema:scope -- "${schema_scope_base_ref}" "${schema_scope_head_ref}"

Constraints:
- Do not change app behavior.
- Do not target main.
- Do not remove existing validation steps.
- Keep schema-scope base as origin/development.

Validation:
- npm run test:unit
- npm run validate

PR summary:
- Base branch: development
- Feature branch
- Changed files
- Validation output
- Follow-up issues discovered
```

---

# Reviewer prompt for each Codex PR

Use a fresh Codex/Claude review session:

```text
Review this PR as a senior engineer for OneTwo3D/IMS.

Base branch must be development.

Focus on:
- business workflow correctness
- inventory/accounting invariants
- authorization and data exposure
- transaction boundaries
- idempotency
- Decimal/money/quantity precision
- test coverage
- migration safety
- WMS/Mintsoft side effects
- operational observability

Do not rewrite the PR.
Return:
1. blocking issues
2. non-blocking issues
3. missing tests
4. production rollout risks
5. recommended follow-up tasks
```
