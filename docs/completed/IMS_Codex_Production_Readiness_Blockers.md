# IMS Production Readiness Blockers — Historical Codex Implementation Plan

Repository: `OneTwo3D/IMS`  
Branch to use for all work: `development`  
Do **not** target `main` unless a human explicitly instructs it.

This plan was based on a static review of the `development` branch after the earlier implementation waves. It focused only on issues that could reasonably block or materially de-risk production rollout: security controls, public ingress, destructive admin functions, operational gates, database invariants, and recoverability.

Implementation status as of 2026-06-03: the staged plan through PR 11.16 has been implemented and merged through GitHub PR #117. Treat this document as a historical implementation record and source of acceptance criteria. Do not use the PR sequence below as the active backlog unless a human explicitly asks to reopen one of the listed follow-ups.

## Final positive baseline

Several earlier recommendations appear implemented:

- `package.json` now includes `test:unit` and `check:decimal-boundaries`.
- `scripts/validate-local.sh` now runs lint, type-check, decimal-boundary checks, Prisma generate, unit tests, workflow-doc checks, and schema-scope checks.
- Shipment dispatch now reloads/locks shipment state inside a transaction and uses conditional stock updates.
- Mintsoft webhook handling now verifies an HMAC over a timestamp-bound payload and returns `202` after persisting.
- Connector URL validation and DNS-validated connector fetch helpers exist.
- Upload storage and invoice PDF scanning hooks exist.
- CronRun persistence and richer health checks exist.
- Route authorization and public-route policy maps exist.

The original blocker sequence has been completed. Any new production-readiness work should start from current repository state, open PRs/issues, or newly identified rollout gaps.

---

# Global Codex setup

Every Codex task must start with:

```bash
git fetch origin
git checkout development
git pull --ff-only origin development
test "$(git branch --show-current)" = "development"

npm ci
npm run validate
```

Create one feature branch per PR:

```bash
git checkout -b codex/<short-task-name>
```

Every PR targets `development`.

Do not continue if `development` is unavailable.

## Required validation per PR

Always run:

```bash
npm run validate
```

Run this when schema or migrations change:

```bash
npm run validate:db
```

Run this when public routes, user workflows, inventory, accounting, WMS, or integrations change:

```bash
npm run e2e:select
```

For connector-specific changes, also run the focused suite if present:

```bash
npm run e2e:wc
npm run e2e:xero
npm run e2e:external
```

## PR summary template

```text
Base branch: development
Feature branch: codex/<task>

What changed:
-

Production risk reduced:
-

Validation:
- npm run validate
- npm run validate:db, if applicable
- npm run e2e:select, if applicable

Rollout notes:
-

Follow-up issues:
-
```

---

# Original production blocker summary

The table below records the risks this plan was created to address. It is retained for historical context; it is not the current open-task list.

| Priority | Blocker | Why it can stop rollout |
|---|---|---|
| P0 | No full CI production gate | Existing workflows appear targeted at secret scan/docs/decimal guard, but there is no single workflow that enforces validate/build/e2e on PRs to `development`. |
| P0 | Database restore endpoint is available in-app | A compromised admin session plus email code can run arbitrary SQL restore against the production DB. This must be explicitly gated. |
| P0 | Public shopping webhooks are unbounded and synchronous | WooCommerce/Shopify webhook route reads entire body with `request.text()` and performs sync processing in request path. |
| P0 | Connector HTTP client buffers full responses without default timeout/body cap | A connector or malicious endpoint can hold sockets or return huge payloads. |
| P0 | Public invoice PDF tokens do not expire | Signed invoice URLs are deterministic HMACs over order ID only and remain valid until `AUTH_SECRET` changes. |
| P0 | Missing database-level inventory constraints | Application invariants exist, but DB should enforce non-negative stock/cost quantities and key idempotency constraints. |
| P0 | JWT sessions do not appear to refresh user active/role/TOTP state | Role changes, deactivation, or forced logout may not take effect until JWT expiry. |
| P1 | Production config is warning-based, not fail-fast | Missing upload storage dirs, file scanner, encryption key, cron secret, or trusted proxy config should block production readiness. |
| P1 | Public webhook behavior tests still have TODO coverage | Shopping, Mintsoft, and supplier ownership fixtures need executable behavior tests. |
| P1 | WMS/Mintsoft processing still mixes connector/job/domain paths and uses number conversion in critical paths | Less urgent than ingress/security, but still a rollout risk for warehouse operations. |

---

# Stage 0 — Add a real production readiness CI gate

## PR 0.1 — Add `production-readiness.yml`

### Goal

Make it impossible to merge or deploy `development` without the same checks humans expect Codex to run.

### Current evidence

`package.json` has validation and test scripts, including `validate`, `validate:db`, `test:unit`, `e2e:select`, `e2e:wc`, and `e2e:xero`. `scripts/validate-local.sh` runs a strong local validation sequence. Current workflows seen in the repo include focused workflows such as decimal-boundary guard, secret scan, and workflow docs, but no single production-readiness workflow covering validate/build/e2e.

### Implementation

Create:

```text
.github/workflows/production-readiness.yml
```

It should run on:

```yaml
on:
  pull_request:
    branches: [development]
  push:
    branches: [development]
```

Jobs:

```text
1. validate
   - checkout
   - setup Node 22
   - npm ci
   - npm run validate

2. build
   - npm ci
   - npm run build

3. e2e-select
   - npm ci
   - install Playwright browsers
   - npm run e2e:select
```

If Playwright requires DB setup, use the project’s existing E2E prepare/seed scripts and env conventions. Do not invent production credentials.

### Acceptance criteria

```text
- PRs to development run npm run validate.
- PRs to development run npm run build.
- PRs to development run selected E2E coverage.
- Workflow fails on test failure.
- No app behavior changed.
```

### Codex prompt

```text
Implement PR 0.1.

Base branch: development.

Add .github/workflows/production-readiness.yml. It must run on pull_request to development and push to development.
It must run npm ci, npm run validate, npm run build, and npm run e2e:select in appropriate jobs.
Use Node 22.
Use existing project scripts and E2E setup conventions.
Do not add secrets or production credentials.
Run npm run validate locally before committing.
```

---

## PR 0.2 — Add `npm run preflight:production`

### Goal

Create a single command that checks whether production can safely start.

### Implementation

Add:

```text
scripts/preflight-production.ts
```

Add package script:

```json
"preflight:production": "tsx scripts/preflight-production.ts"
```

Checks should fail in `NODE_ENV=production` if any are missing or unsafe:

```text
AUTH_SECRET or NEXTAUTH_SECRET
DATABASE_URL
NEXT_PUBLIC_APP_URL / AUTH_URL
CRON_SECRET
SETTINGS_ENCRYPTION_KEY
UPLOAD_STORAGE_DIR
PUBLIC_UPLOAD_STORAGE_DIR
BACKUP_DIR or equivalent backup storage setting
TRUSTED_PROXY_IPS/TRUSTED_PROXY_CIDRS when app is behind proxy
FILE_SCAN_MODE and scanner configuration policy
ALLOW_DATABASE_RESTORE is not true by default
```

Also check:

```text
- upload dirs exist and are writable
- backup dir exists and is writable
- if FILE_SCAN_MODE=command, scanner health passes
- if production restore is disabled, restore route returns 404/403
```

### Acceptance criteria

```text
- `npm run preflight:production` passes in a properly configured production-like env.
- It fails with clear messages for missing production secrets/storage paths.
- It does not print secret values.
- It is included in production-readiness CI where safe, using non-secret placeholder env.
```

### Codex prompt

```text
Implement PR 0.2.

Base branch: development.

Add a production preflight script and package.json script preflight:production.
The script must fail fast in NODE_ENV=production when required production settings are missing or unsafe.
Do not print secrets.
Check auth secrets, database URL, public/auth URLs, cron secret, settings encryption key, upload storage dirs, backup storage, file scanner policy, trusted proxy config, and database restore gating.
Add unit tests for the preflight checks.
Run npm run validate.
```

---

# Stage 1 — Gate destructive database restore

## PR 1.1 — Disable restore in production unless explicitly enabled

### Goal

Prevent accidental or compromised production database restore.

### Current evidence

`app/api/backup/restore/route.ts` exposes both `GET` for email code issuance and `POST` for restoring a SQL file. It uses `requireApiAdmin`, same-origin checks, an email code, maintenance mode, and `psql --single-transaction`, but the route is still available in production by default.

### Implementation

Add env flags:

```env
ALLOW_DATABASE_RESTORE=false
ALLOW_DATABASE_RESTORE_UPLOAD=false
```

Behavior:

```text
- In production, GET and POST return 404 or 403 unless ALLOW_DATABASE_RESTORE=true.
- Upload restore requires ALLOW_DATABASE_RESTORE_UPLOAD=true as a second flag.
- Existing backup-file restore and uploaded restore are separate capabilities.
- Log denied restore attempts as WARNING without leaking filenames or SQL content.
```

Update docs and `.env.example`.

### Acceptance criteria

```text
- Production restore disabled by default.
- Email code issuance disabled when restore disabled.
- Upload restore requires second explicit flag.
- Tests cover production-disabled, enabled-without-upload, and enabled-with-upload cases.
```

### Codex prompt

```text
Implement PR 1.1.

Base branch: development.

Add production kill switches for database restore:
ALLOW_DATABASE_RESTORE=false by default
ALLOW_DATABASE_RESTORE_UPLOAD=false by default

In NODE_ENV=production, the restore GET and POST handlers must deny requests unless ALLOW_DATABASE_RESTORE=true.
Uploaded restore files require ALLOW_DATABASE_RESTORE_UPLOAD=true.
Add tests for disabled production restore, enabled restore from existing backup, and upload restore requiring the second flag.
Update .env.example and docs.
Run npm run validate.
```

---

## PR 1.2 — Replace forwarded-header same-origin check with configured origin check

### Goal

Avoid trusting spoofable forwarded headers for destructive operations.

### Current evidence

Restore route builds the expected origin from request URL and `x-forwarded-proto` / `x-forwarded-host`. That is fragile unless proxy header trust is perfectly configured.

### Implementation

For destructive admin POSTs such as restore:

```text
- Compare Origin/Referer against configured AUTH_URL or NEXT_PUBLIC_APP_URL.
- Do not derive expected origin from x-forwarded-* headers.
- If configured app URL is missing in production, fail preflight.
```

### Acceptance criteria

```text
- Restore POST same-origin check uses configured app origin.
- Spoofed forwarded host/proto cannot change expected origin.
- Tests cover valid origin, missing origin, spoofed forwarded host, and invalid referer.
```

### Codex prompt

```text
Implement PR 1.2.

Base branch: development.

Refactor destructive admin same-origin checks to use configured AUTH_URL or NEXT_PUBLIC_APP_URL, not x-forwarded-host or x-forwarded-proto.
Apply first to the database restore POST route.
Add tests for valid configured origin, missing origin/referer, invalid origin, and spoofed forwarded host/proto.
Run npm run validate.
```

---

# Stage 2 — Harden connector HTTP transport

## PR 2.1 — Add default connector request timeout and response size cap

### Goal

Prevent connector calls from hanging indefinitely or buffering unbounded responses.

### Current evidence

`lib/security/connector-fetch.ts` validates URLs and DNS results, follows redirects, and buffers the full response into a `Response`. It accepts an `AbortSignal`, but does not set a default timeout, and `collectResponse()` has no byte cap.

### Implementation

Add env defaults:

```env
CONNECTOR_FETCH_TIMEOUT_MS=30000
CONNECTOR_FETCH_MAX_RESPONSE_BYTES=10485760
```

Update `connectorFetch`:

```text
- Create an internal AbortController when caller did not provide signal.
- Enforce timeout.
- Enforce max response body bytes while streaming chunks.
- Return a clear connector error if exceeded.
- Keep redirect validation.
```

### Acceptance criteria

```text
- Connector fetch times out by default.
- Oversized response aborts and returns a clear error.
- Existing connector tests pass.
- Tests cover timeout, max body, redirect, and caller-supplied signal.
```

### Codex prompt

```text
Implement PR 2.1.

Base branch: development.

Add default timeout and max response body limits to lib/security/connector-fetch.ts.
Use CONNECTOR_FETCH_TIMEOUT_MS and CONNECTOR_FETCH_MAX_RESPONSE_BYTES with safe defaults.
Abort requests on timeout.
Abort/throw when response exceeds max bytes.
Preserve URL/DNS/redirect safety behavior.
Add unit tests for timeout, response cap, redirect safety, and caller-supplied AbortSignal.
Run npm run validate.
```

---

## PR 2.2 — Audit and migrate raw connector `fetch` usage

### Goal

Ensure all server-side external connector calls use the validated transport.

### Implementation

Add script:

```text
scripts/check-connector-fetch-boundaries.mjs
```

It should fail when raw `fetch()` is used in connector/server integration paths:

```text
lib/connectors/**
lib/shopping.ts
app/actions/*sync*
app/api/cron/**
```

Allowed cases require a comment:

```ts
// connector-fetch-boundary-ok: <reason>
```

Then migrate remaining raw connector fetch calls to `connectorFetch`.

### Acceptance criteria

```text
- Check runs in npm run validate.
- Raw fetch in connector paths is blocked unless explicitly waived.
- Existing external/e2e tests pass.
```

### Codex prompt

```text
Implement PR 2.2.

Base branch: development.

Add a validation script that blocks raw fetch() in connector/integration server paths unless explicitly waived with a connector-fetch-boundary-ok comment.
Wire it into npm run validate.
Migrate obvious connector fetch calls to connectorFetch.
Do not change browser/client fetch calls.
Run npm run validate and relevant connector tests.
```

---

# Stage 3 — Harden public shopping webhooks

## PR 3.1 — Add body-size limit and safe JSON parsing to shopping webhooks

### Goal

Prevent public WooCommerce/Shopify webhooks from consuming unbounded memory or returning uncontrolled 500s on bad JSON.

### Current evidence

`lib/connectors/woocommerce/webhooks.ts` calls `await request.text()` directly, then parses JSON in handler functions. There is no body-size cap in the generic shopping webhook route.

### Implementation

Add reusable helper:

```text
lib/security/read-limited-request-body.ts
```

Use it for:

```text
WooCommerce webhooks
Shopify webhooks
any generic shopping webhook route
```

Recommended default:

```env
SHOPPING_WEBHOOK_MAX_BODY_BYTES=262144
```

Behavior:

```text
- Reject too-large body with 413.
- Reject empty body with 400 when not a ping.
- Catch JSON parse errors and return 400.
- Do not log raw payloads.
```

### Acceptance criteria

```text
- WooCommerce webhook rejects > limit.
- Invalid JSON returns 400, not 500.
- Valid signed webhook still works.
- Tests cover unsigned, oversized, malformed JSON, and valid signed fixtures.
```

### Codex prompt

```text
Implement PR 3.1.

Base branch: development.

Add a limited body reader for public shopping webhooks.
Apply it to WooCommerce and Shopify webhook handling.
Reject oversized bodies with 413, malformed JSON with 400, and avoid logging raw payloads.
Add executable tests for unsigned, oversized, invalid JSON, and valid signed webhook requests.
Run npm run validate and relevant WC/Shopify tests.
```

---

## PR 3.2 — Persist shopping webhooks before processing

### Goal

Avoid coupling public webhook response time to order/product/refund import logic.

### Implementation

Create a shopping webhook inbox:

```prisma
model ShoppingWebhookEvent {
  id              String   @id @default(cuid())
  connector       String
  resource        String
  externalEventId String?
  topic           String?
  payloadHash     String
  payloadJson     Json
  status          String
  attempts        Int      @default(0)
  nextAttemptAt   DateTime?
  processedAt     DateTime?
  lastError       String?
  receivedAt      DateTime @default(now())

  @@unique([connector, payloadHash])
  @@index([connector, resource, status, receivedAt])
}
```

Flow:

```text
public webhook validates signature
persist event idempotently
return 202 quickly
cron/outbox worker processes events
```

Start with WooCommerce orders/products/refunds. Shopify can follow if larger.

### Acceptance criteria

```text
- Public WooCommerce webhook route returns 202 after persistence.
- Duplicate webhook returns accepted duplicate response.
- Worker processes persisted events.
- Failures retry without losing payload.
- Existing import behavior preserved.
```

### Codex prompt

```text
Implement PR 3.2.

Base branch: development.

Introduce a ShoppingWebhookEvent inbox for WooCommerce webhooks.
The public webhook route should validate signature, persist payload idempotently, and return 202 without doing order/product/refund mutations in the request path.
Add a cron or outbox worker to process pending events.
Preserve existing WooCommerce import/status/refund behavior inside the worker.
Add tests for accepted webhook, duplicate webhook, failed processing retry, and successful processing.
Run npm run validate, npm run validate:db, and relevant WooCommerce tests.
```

---

## PR 3.3 — Move Shopify webhooks to the shopping webhook inbox

### Goal

Give Shopify the same public-ingress behavior as WooCommerce: validate the
request, persist the event idempotently, return `202 Accepted`, and process the
payload outside the public request path.

### Dependency

Depends on PR 3.2's `ShoppingWebhookEvent` inbox table, status model, and worker
pattern. Reuse the shared table rather than creating a Shopify-specific inbox.

### Current evidence

PR 3.1 covers Shopify body-size limits and safe JSON parsing. PR 3.2 starts the
async inbox with WooCommerce only. Shopify signed webhooks still need an explicit
follow-up so they do not remain a synchronous public mutation path.

### Implementation

Extend the shopping webhook inbox to Shopify:

```text
connector = shopify
resource = orders/products/refunds, matching the existing route contract
externalEventId = x-shopify-webhook-id or x-shopify-event-id when present
topic = x-shopify-topic
payloadHash = hash of the raw signed body
```

Flow:

```text
public Shopify webhook validates HMAC and shop domain
persist event idempotently using connector/resource/body hash
return 202 quickly
cron/outbox worker processes pending Shopify events
worker preserves existing Shopify import/status/refund behavior
failed processing retries without losing the payload
```

Reuse the WooCommerce inbox processor abstractions where practical, but keep the
connector-specific signature validation and payload dispatch separate.

### Acceptance criteria

```text
- Public Shopify webhook route returns 202 after persistence.
- Duplicate Shopify webhook returns accepted duplicate response.
- Worker processes persisted Shopify events.
- Failed Shopify processing retries without losing payload.
- Existing Shopify signature, topic, shop-domain, and malformed-JSON behavior remains covered.
- WooCommerce inbox behavior is unchanged.
```

### Codex prompt

```text
Implement PR 3.3.

Base branch: development.

Move Shopify webhooks onto the ShoppingWebhookEvent inbox introduced in PR 3.2.
The public Shopify webhook route should validate HMAC/shop-domain, persist payload idempotently, and return 202 without doing order/product/refund mutations in the request path.
Add a cron or shared shopping webhook worker path to process pending Shopify events.
Preserve existing Shopify import/status/refund behavior inside the worker.
Add tests for accepted Shopify webhook, duplicate webhook, failed processing retry, and successful processing.
Run npm run validate, npm run validate:db if schema changes, and relevant Shopify/shopping webhook tests.
```

---

# Stage 4 — Replace non-expiring invoice PDF URLs

## PR 4.1 — Add expiring signed invoice PDF tokens

### Goal

Prevent leaked invoice PDF links from remaining valid indefinitely.

### Current evidence

`lib/invoice-pdf.ts` signs only the order ID with `AUTH_SECRET`/`NEXTAUTH_SECRET`. `verifyPdfToken()` checks a deterministic HMAC; there is no expiry, purpose binding beyond the route, revocation, or nonce.

### Implementation

Add token format:

```text
base64url(json).hmac
```

Payload:

```json
{
  "sub": "<orderId>",
  "purpose": "invoice-pdf",
  "iat": 1234567890,
  "exp": 1234567890,
  "nonce": "<random>"
}
```

Config:

```env
INVOICE_PDF_TOKEN_TTL_SECONDS=604800
```

Behavior:

```text
- Old deterministic tokens disabled by default.
- Optional temporary compatibility flag: ALLOW_LEGACY_INVOICE_PDF_TOKENS=false.
- Public endpoint returns no-store or short private cache.
- Audit successful and failed token verification attempts without logging tokens.
```

### Acceptance criteria

```text
- New tokens expire.
- Wrong purpose fails.
- Wrong order ID fails.
- Expired token fails.
- Legacy mode disabled by default.
```

### Codex prompt

```text
Implement PR 4.1.

Base branch: development.

Replace deterministic invoice PDF HMAC tokens with expiring signed tokens containing sub, purpose, iat, exp, and nonce.
Default TTL should come from INVOICE_PDF_TOKEN_TTL_SECONDS.
Legacy deterministic tokens must be disabled by default, with an optional temporary ALLOW_LEGACY_INVOICE_PDF_TOKENS flag if needed.
Do not log token values.
Add tests for valid, expired, wrong-purpose, wrong-order, tampered, and legacy-disabled tokens.
Run npm run validate.
```

---

## PR 4.2 — Move invoice PDF storage to configured persistent path

### Goal

Avoid storing invoice PDFs under `process.cwd()/data/invoices` in production.

### Current evidence

`lib/invoice-pdf.ts` uses:

```ts
const PDF_DIR = join(process.cwd(), 'data', 'invoices')
```

### Implementation

Add:

```env
INVOICE_PDF_STORAGE_DIR=/var/lib/onetwoinventory/invoice-pdfs
```

Update health/preflight to check it.

### Acceptance criteria

```text
- Local fallback preserved.
- Production preflight fails if INVOICE_PDF_STORAGE_DIR is missing.
- Path traversal remains impossible.
```

### Codex prompt

```text
Implement PR 4.2.

Base branch: development.

Move invoice PDF storage to an env-configured persistent path using INVOICE_PDF_STORAGE_DIR, with a safe local fallback.
Update lib/invoice-pdf.ts, health checks, preflight checks, .env.example, and docs.
Add tests for path resolution and production preflight.
Run npm run validate.
```

---

# Stage 5 — Add database-level invariants and idempotency

## PR 5.1 — Add inventory quantity check constraints

### Goal

Let PostgreSQL reject impossible inventory states.

### Current evidence

The app has invariant checks and conditional stock updates, but a code search did not find the expected stock/cost-layer check-constraint names. Treat this as not yet done unless Codex finds an existing equivalent.

### Implementation

Add migration with preflight checks and constraints:

```sql
-- Preflight: raise exception with counts if invalid rows exist.
-- Constraints:
stock_levels.quantity >= 0
stock_levels.reservedQty >= 0
stock_levels.reservedQty <= stock_levels.quantity
cost_layers.receivedQty >= 0
cost_layers.remainingQty >= 0
cost_layers.remainingQty <= cost_layers.receivedQty
stock_movements.qty >= 0
cogs_entries.qty >= 0
purchase_order_lines.qty >= 0
sales_order_lines.qty >= 0
shipment_lines.qty >= 0
order_allocations.qty >= 0
```

If `reservedQty <= quantity` is too strict for current production data, do not weaken silently. Add a preflight remediation report and keep rollout blocked until data is cleaned or backorder semantics are corrected.

### Acceptance criteria

```text
- Migration fails with clear invalid-row counts.
- Clean DB passes migration.
- Tests cover constraint violations.
- Invariant report still works.
```

### Codex prompt

```text
Implement PR 5.1.

Base branch: development.

Add PostgreSQL check constraints for non-negative quantities and cost-layer consistency.
Include preflight SQL that raises clear errors with invalid-row counts before adding constraints.
Do not silently allow reservedQty > quantity unless there is a documented schema-level backorder model.
Add tests or migration checks for violations.
Run npm run validate and npm run validate:db.
```

---

## PR 5.2 — Add idempotency uniqueness for irreversible stock movements

### Goal

Prevent duplicated dispatch/receipt/return movements from retries or concurrent workers.

### Implementation

Add an explicit idempotency key model or columns for stock movements:

Option A:

```prisma
model StockMovementIdempotencyKey {
  key             String @id
  stockMovementId String @unique
}
```

Option B:

```prisma
model StockMovement {
  ...
  idempotencyKey String? @unique
}
```

Use deterministic keys for:

```text
SALE_DISPATCH:shipmentLine:<id>
PURCHASE_RECEIPT:wmsAsnLine:<id>:receipt:<eventId>
TRANSFER_IN:wmsAsnLine:<id>:receipt:<eventId>
RETURN_INBOUND:refund:<id>:line:<id>
```

### Acceptance criteria

```text
- Retrying dispatch/receipt does not create duplicate stock movement rows.
- Existing movement creation flows updated incrementally.
- Tests cover duplicate retry.
```

### Codex prompt

```text
Implement PR 5.2.

Base branch: development.

Add stock movement idempotency support for irreversible movements.
Use deterministic keys for sale dispatch, WMS purchase receipt, WMS transfer receipt, and refund return inbound movements.
Prevent duplicate movement creation on retry.
Add tests for duplicate retry scenarios.
Run npm run validate and npm run validate:db.
```

---

# Stage 6 — Session revocation and auth freshness

## PR 6.1 — Add session version and active-user revalidation

### Goal

Ensure role changes, user deactivation, TOTP changes, and forced logout take effect promptly.

### Current evidence

NextAuth uses JWT sessions with `maxAge` of 30 days. JWT/session callbacks store user ID, role, supplier ID, TOTP flags, and picture URL. Auth gates use session values to authorize, without visible DB revalidation on every request.

### Implementation

Add to `User`:

```prisma
sessionVersion Int @default(1)
forceLogoutAt  DateTime?
```

JWT contains:

```text
sessionVersion
issuedAt/sessionAuthTime
```

Auth helper behavior:

```text
- Revalidate user active/role/sessionVersion periodically.
- For admin/destructive routes, always re-read active user and role from DB.
- Increment sessionVersion on password reset, TOTP disable/enable, role change, deactivation, passkey removal, and explicit force logout.
```

### Acceptance criteria

```text
- Deactivated user loses API access.
- Role downgrade takes effect before JWT maxAge.
- TOTP enable/disable updates session requirements.
- Admin route checks fresh role.
```

### Codex prompt

```text
Implement PR 6.1.

Base branch: development.

Add user sessionVersion/forceLogout support and fresh user revalidation.
JWT sessions must become invalid when sessionVersion changes or user is inactive.
Admin/destructive routes must re-read active user/role from DB instead of trusting a stale JWT role only.
Increment sessionVersion on role change, user deactivation, password reset, TOTP changes, and security-sensitive account changes.
Add tests for deactivation, role downgrade, TOTP change, and forced logout.
Run npm run validate and npm run validate:db.
```

---

## PR 6.2 — Reduce high-risk session lifetime for admin/destructive actions

### Goal

Require fresh auth for destructive actions.

### Implementation

Add fresh-auth helper:

```text
lib/auth/fresh-auth.ts
```

Track:

```text
authTime
lastTotpVerifiedAt
lastPasskeyVerifiedAt
```

Require fresh auth for:

```text
backup restore
database reset
user role changes
connector secret changes
accounting backfill/posting admin actions
outbox replay/permanent-fail
```

Policy:

```env
FRESH_AUTH_MAX_AGE_SECONDS=900
```

### Acceptance criteria

```text
- Destructive routes reject stale sessions.
- User can re-authenticate or re-TOTP to continue.
- Tests cover stale and fresh sessions.
```

### Codex prompt

```text
Implement PR 6.2.

Base branch: development.

Add fresh-auth enforcement for destructive admin actions.
Track authTime or recent strong-auth verification and require freshness for backup restore, database reset, user role changes, connector secret changes, accounting backfill/admin posting, and outbox replay/permanent-fail.
Default freshness window: 15 minutes.
Add tests for stale session rejection and fresh session acceptance.
Run npm run validate.
```

---

# Stage 7 — Production config must fail closed

## PR 7.1 — Make production startup/preflight fail if encryption key is missing

### Goal

Sensitive settings should not be stored plaintext in production.

### Current evidence

`lib/settings-store.ts` encrypts sensitive setting values when `SETTINGS_ENCRYPTION_KEY` is present and lazily migrates old plaintext values. If the key is missing, sensitive values may remain readable from environment or plaintext legacy rows, depending on path.

### Implementation

Production preflight should fail if:

```text
SETTINGS_ENCRYPTION_KEY missing
sensitive Setting rows are plaintext and migration cannot run
```

Add optional admin command:

```bash
npm run cli -- migrate-encrypted-settings
```

### Acceptance criteria

```text
- Production preflight fails without SETTINGS_ENCRYPTION_KEY.
- Bulk migration command exists.
- Migration summary does not reveal secret values.
```

### Codex prompt

```text
Implement PR 7.1.

Base branch: development.

Update production preflight to require SETTINGS_ENCRYPTION_KEY.
Add a CLI command to bulk-migrate sensitive settings to encrypted storage.
Ensure logs and summaries never contain secret values.
Add tests for missing key, encrypted rows, plaintext rows, and migration summary.
Run npm run validate.
```

---

## PR 7.2 — Require explicit persistent storage configuration in production

### Goal

Avoid losing uploaded files, invoice PDFs, logos, avatars, and backups on container restart.

### Implementation

Production preflight should fail if any are missing:

```text
UPLOAD_STORAGE_DIR
PUBLIC_UPLOAD_STORAGE_DIR
INVOICE_PDF_STORAGE_DIR
BACKUP_DIR or configured backup path
```

No “warn only” for production.

### Acceptance criteria

```text
- Production preflight fails when persistent paths are unset.
- Health check marks missing/wrong paths as down, not only warning, for critical dirs.
- Local dev fallback still works.
```

### Codex prompt

```text
Implement PR 7.2.

Base branch: development.

Make production preflight fail if persistent storage paths are not explicitly configured for uploads, public uploads, invoice PDFs, and backups.
Update health severity so critical production storage dirs are errors, not warnings.
Preserve local development fallback.
Add tests.
Run npm run validate.
```

---

# Stage 8 — WMS and warehouse operational safety

## PR 8.1 — Add WMS receipt reconciliation dry-run and review screen/API

### Goal

Prevent a Mintsoft ASN callback from directly mutating stock when reconciliation is ambiguous.

### Implementation

Before processing actionable ASN lines, produce a dry-run:

```text
expectedQty
currentRemoteReceivedQty
localReceivedQty
qtyAccountedViaSnapshot
qtyAccountedViaReceipt
stockQtyToAdd
wouldCreateReceipt
wouldCreateCostLayer
warnings
```

If warnings exist:

```text
- remote regression
- missing local PO/transfer line
- unsupported source type
- cost-layer snapshot missing
- received over expected
```

then stop automatic processing and mark event as `REQUIRES_REVIEW`.

### Acceptance criteria

```text
- Safe ASNs auto-process.
- Ambiguous ASNs require review and do not mutate stock.
- Admin can inspect dry-run details.
- Tests cover safe, ambiguous, and review-approved flows.
```

### Codex prompt

```text
Implement PR 8.1.

Base branch: development.

Add a WMS ASN booked-in dry-run/review layer.
Before mutating stock, calculate reconciliation details and warnings.
If warnings are present, mark the webhook/event as REQUIRES_REVIEW and do not mutate stock.
Add an admin API to inspect review details and approve processing.
Add tests for safe auto-processing, ambiguous review-required state, and approved processing.
Run npm run validate and relevant Mintsoft tests.
```

---

## PR 8.2 — Convert WMS booked-in quantity/cost arithmetic to Decimal

### Goal

Avoid fractional quantity/cost drift in purchase receipts and stock transfers.

### Current evidence

Booked-in service still uses `Number(...)` conversions for expected, received, local, snapshot, and cost quantities in critical stock mutation paths.

### Implementation

Use Decimal helpers for:

```text
expectedQty
currentReceivedQty
localReceivedQty
qtyAccountedViaSnapshot
qtyAccountedViaReceipt
stockQtyToAdd
unitCostBase
received cost-layer quantities
transfer snapshot slicing
```

Only convert to number at final Prisma write boundary if required.

### Acceptance criteria

```text
- Fractional receipt quantities remain precise.
- Tests cover fractional PO receipt and fractional transfer receipt.
- No behavior change except precision improvement.
```

### Codex prompt

```text
Implement PR 8.2.

Base branch: development.

Refactor WMS booked-in reconciliation arithmetic to use Decimal-safe helpers.
Focus on purchase receipt, transfer receipt, cost layer creation, and snapshot slicing.
Add fractional quantity regression tests.
Run npm run validate and Mintsoft workflow tests.
```

---

# Stage 9 — Public route fixture coverage

## PR 9.1 — Replace TODO public webhook auth tests with executable fixtures

### Goal

Ensure public webhook and supplier routes are actually secure.

### Current evidence

`tests/security/api-route-auth-behavior.test.ts` contains TODO tests for shopping webhooks, Mintsoft webhook fixtures, and supplier RFQ ownership behavior.

### Implementation

Replace TODO tests with executable tests:

```text
- WooCommerce unsigned webhook rejected before processing.
- WooCommerce signed webhook accepted into inbox or processed test path.
- Mintsoft missing signature rejected.
- Mintsoft stale signed timestamp rejected.
- Mintsoft valid signed request accepted into queue.
- Supplier can fetch own RFQ only.
- Supplier cannot fetch foreign RFQ.
```

### Acceptance criteria

```text
- No TODO tests remain for public webhook auth behavior.
- Tests do not need real external credentials.
- Tests fail if signature checks are bypassed.
```

### Codex prompt

```text
Implement PR 9.1.

Base branch: development.

Replace TODO public webhook and supplier ownership auth tests with executable fixtures.
Use test doubles or seeded fixtures, not real external credentials.
Cover unsigned/signed WooCommerce webhook, missing/stale/valid Mintsoft webhook, and supplier-owned vs foreign RFQ access.
Run npm run validate.
```

---

# Stage 10 — Rollout readiness dashboard and deploy block

## PR 10.1 — Add rollout readiness API and UI

### Goal

Expose a single admin view showing whether production rollout is safe.

### Implementation

Create admin-only endpoint:

```text
/api/admin/rollout-readiness
```

It should aggregate:

```text
production preflight status
admin health status
latest invariant check
latest accounting reconciliation run
outbox permanent failures
dead WMS webhooks
failed accounting events
stale cron jobs
missing backup
file scanner status
storage path status
```

Return:

```ts
{
  status: "ready" | "blocked" | "warning",
  blockers: RolloutBlocker[],
  warnings: RolloutWarning[]
}
```

Optional UI:

```text
settings/system or admin health page
```

### Acceptance criteria

```text
- Admin-only.
- No secrets exposed.
- `blocked` if any P0 condition is active.
- Tests cover ready, warning, blocked.
```

### Codex prompt

```text
Implement PR 10.1.

Base branch: development.

Add an admin-only rollout readiness endpoint that aggregates preflight, admin health, invariant checks, accounting reconciliation, outbox state, WMS webhook queue, accounting events, cron freshness, backups, scanner, and storage.
Return ready/warning/blocked with explicit blockers.
Do not expose secrets.
Add tests for ready, warning, and blocked states.
Run npm run validate.
```

---

# Stage 11 — Inventory reporting foundations

These PRs add the schema, snapshot, and indexing changes required to power the inventory turnover, aging, stock movement, stock on hand, stock allocations, and reorder reports. PRs 11.1–11.7 are foundation work (schema + snapshots + policy); PRs 11.8–11.10 build the three new operational reports requested (stock on hand, stock allocations, reorder). Existing turnover / aging / stock movement reports can be layered on once the foundation lands.

## PR 11.1 — Add product category field for reporting slices

### Goal

Allow turnover, aging, and stock-on-hand reports to be sliced by category. Today `Product` has no category/group field, so all category-level analytics are impossible.

### Current evidence

`prisma/schema.prisma` `Product` model has no `category`, `productGroup`, or tagging column. `grep -n "category" prisma/schema.prisma` only surfaces `TaxCategory` and `WmsDiscrepancyCategory`.

### Implementation

Two options — pick one with stakeholder input:

Option A (lightweight string):

```prisma
model Product {
  ...
  category String?
  @@index([category])
}
```

Option B (normalised, recommended):

```prisma
model ProductCategory {
  id        String   @id @default(cuid())
  name      String   @unique
  parentId  String?
  parent    ProductCategory?  @relation("CategoryTree", fields: [parentId], references: [id])
  children  ProductCategory[] @relation("CategoryTree")
  products  Product[]
}

model Product {
  ...
  categoryId String?
  category   ProductCategory? @relation(fields: [categoryId], references: [id])
  @@index([categoryId])
}
```

### Acceptance criteria

```text
- Migration adds category column/table without backfill failures.
- Product create/edit form exposes category.
- CSV import/export round-trips category.
- Reports can group by category.
- No regression on existing product queries.
```

### Codex prompt

```text
Implement PR 11.1.

Base branch: development.

Add a ProductCategory model and a categoryId FK on Product (or a flat category string — confirm with product owner before choosing).
Update product create/edit server actions, forms, and CSV import/export to handle category.
Add index on (categoryId).
Run npm run validate and npm run validate:db.
```

---

## PR 11.2 — Denormalise unit cost and value onto StockMovement + add time indexes

### Goal

Make the stock movement report a single-table scan with consistent value semantics for every movement type, and make time-bounded movement queries fast.

### Current evidence

`prisma/schema.prisma` `StockMovement` stores `qty` only. Costed value must currently be reconstructed from `CogsEntry` (outbound) or `CostLayer` (inbound), and is undefined for ADJUSTMENT / TRANSFER. Indexes exist on `productId` and `(referenceType, referenceId)` but not on `createdAt`.

### Implementation

```prisma
model StockMovement {
  ...
  unitCostBase   Decimal? @db.Decimal(18, 6)
  totalValueBase Decimal? @db.Decimal(18, 6)

  @@index([createdAt])
  @@index([productId, createdAt])
  @@index([type, createdAt])
}
```

Populate `unitCostBase` and `totalValueBase` at write time in every movement creation path (PURCHASE_RECEIPT, SALE_DISPATCH, RETURN_INBOUND, TRANSFER_IN/OUT, ADJUSTMENT, PRODUCTION_IN/OUT, KIT_ASSEMBLY_IN/OUT, OPENING_STOCK, WMS_RECEIPT_RECONCILIATION). Source of cost per type:

```text
PURCHASE_RECEIPT             cost layer unit cost on receipt
SALE_DISPATCH                weighted unit cost from CogsEntries for the movement
RETURN_INBOUND               cost layer unit cost of new inbound layer
TRANSFER_OUT / TRANSFER_IN   weighted FIFO consumption cost
ADJUSTMENT                   cost layer unit cost (or zero for write-off-only)
PRODUCTION_IN / OUT          BOM/manufactured cost from ManufacturingCostLine
KIT_ASSEMBLY_IN / OUT        component cost rollup
OPENING_STOCK                seeded unit cost
```

Backfill via migration for historical rows where derivable; leave null otherwise.

### Acceptance criteria

```text
- Every new movement row has unitCostBase and totalValueBase populated.
- Backfill report shows count of historical rows left null with reason.
- Movement report SQL is a single table scan filtered by createdAt.
- No double-counting between StockMovement.totalValueBase and CogsEntry.
```

### Codex prompt

```text
Implement PR 11.2.

Base branch: development.

Add nullable unitCostBase and totalValueBase columns on StockMovement plus indexes on createdAt and (productId, createdAt) and (type, createdAt).
Update all movement creation paths to populate value at write time.
Add a backfill migration that fills historical rows where source data is available, and emits a report of rows left null.
Add tests that every movement type sets the value column.
Run npm run validate and npm run validate:db.
```

---

## PR 11.3 — Add InventorySnapshot table and daily snapshot cron

### Goal

Make average-inventory, as-of on-hand, and historical turnover queries cheap and accurate without replaying the full StockMovement ledger.

### Current evidence

`StockLevel` is current-state only; no historical record of on-hand qty or value exists. Replaying movements works but does not scale for reports across years.

### Implementation

```prisma
model InventorySnapshot {
  id            String   @id @default(cuid())
  snapshotDate  DateTime @db.Date
  productId     String
  warehouseId   String
  qty           Decimal  @db.Decimal(12, 4)
  valueBase     Decimal  @db.Decimal(18, 6)
  unitCostBase  Decimal? @db.Decimal(18, 6)
  createdAt     DateTime @default(now())

  product   Product   @relation(fields: [productId], references: [id])
  warehouse Warehouse @relation(fields: [warehouseId], references: [id])

  @@unique([snapshotDate, productId, warehouseId])
  @@index([snapshotDate])
  @@index([productId, snapshotDate])
  @@map("inventory_snapshots")
}
```

Add `/api/cron/inventory-snapshot` that runs once daily, writes one row per (product, warehouse) with on-hand qty and value derived from `CostLayer.remainingQty * unitCostBase`. Idempotent on `(snapshotDate, productId, warehouseId)`.

### Acceptance criteria

```text
- Cron runs daily and is idempotent.
- Snapshot value reconciles with sum of CostLayer remaining on snapshot date (tolerance documented).
- Query "average inventory value between dates" is single index range scan.
- Backfill script can seed historical snapshots from current state plus reverse movement replay.
```

### Codex prompt

```text
Implement PR 11.3.

Base branch: development.

Add an InventorySnapshot model with daily-grain (productId, warehouseId, snapshotDate, qty, valueBase).
Add /api/cron/inventory-snapshot guarded by CRON_SECRET that writes one row per (product, warehouse) per day.
Add a backfill script that seeds prior snapshots from current state and reverse movement replay.
Reconcile snapshot value with sum of CostLayer.remainingQty * unitCostBase and report drift.
Run npm run validate and npm run validate:db.
```

---

## PR 11.4 — Aging policy for KIT and BOM products (component-based)

### Goal

Define and implement the inventory aging treatment for KIT and BOM products. Decision: **aging is based on components, not on the kit/BOM SKU itself.** Kits are virtual bundles with no independent receipt event; BOMs report on their underlying material layers.

### Implementation

- Inventory aging report excludes rows where `Product.type IN (KIT)` from the parent listing and instead rolls up component layer ages weighted by the kit's component qty.
- For `Product.type = BOM` (manufactured), the manufactured product itself does have a `CostLayer` created via PRODUCTION_IN (its own receipt date is the production date). Report this layer directly; do not also age its source components, which were already consumed via PRODUCTION_OUT.
- Document the rule in `docs/architecture.md` (Inventory reporting section).
- Add an explicit setting `inventoryReports.kitAgingMode = "component"` so the policy is configurable later without code change.

### Acceptance criteria

```text
- Aging report does not list virtual KIT SKUs as aged stock.
- Aging report shows BOM/manufactured SKUs aged from their own PRODUCTION_IN date.
- Component aging rollup behind a KIT is correct vs. a manual spreadsheet on the seed data.
- docs/architecture.md documents the rule.
```

### Codex prompt

```text
Implement PR 11.4.

Base branch: development.

Document and enforce the kit/BOM aging policy: KIT products are aged from component layers (excluded from the top-level aging list and rolled up via BomItem/KitItem composition); BOM/manufactured products are aged from their own PRODUCTION_IN cost layer and not double-counted via components.
Add setting inventoryReports.kitAgingMode defaulting to "component".
Update docs/architecture.md with the rule.
Add tests that cover both KIT and BOM SKUs.
Run npm run validate.
```

---

## PR 11.5 — As-of historical on-hand support

### Goal

Allow any inventory report to take an `asOf` date and return on-hand qty + value at that point in time, without replaying the full movement ledger for every query.

### Implementation

- Primary source: `InventorySnapshot` from PR 11.3.
- For `asOf` between two snapshot dates, apply forward movement replay from the nearest prior snapshot using `StockMovement` rows where `createdAt <= asOf`.
- Expose a single helper `getOnHandAsOf({ asOf, productId?, warehouseId?, categoryId? })` in `lib/domain/inventory/`.
- Use this helper for the stock-on-hand report (PR 11.8) and as the basis for turnover's beginning/ending inventory.

### Acceptance criteria

```text
- getOnHandAsOf returns matching values to live StockLevel for asOf = now.
- For historical dates, value matches snapshot + delta from movements.
- Performance: P95 < 1s on a 10M-movement dataset for a single warehouse asOf query.
- Tests cover: snapshot day, mid-period, pre-first-snapshot fallback.
```

### Codex prompt

```text
Implement PR 11.5.

Base branch: development.

Add lib/domain/inventory/get-on-hand-as-of.ts that combines InventorySnapshot lookup with forward StockMovement replay for asOf dates between snapshots.
Add tests covering snapshot day, mid-period, and pre-first-snapshot ranges.
Reconcile result against live StockLevel when asOf = now.
Run npm run validate.
```

---

## PR 11.6 — Reservation breakdown reporting

### Goal

Report not just the aggregate `StockLevel.reservedQty` but which sales orders / allocations / transfers are holding each reservation, so the stock allocations report (PR 11.9) can show why available is lower than on-hand.

### Current evidence

`OrderAllocation` model exists (line ~2373) and links SO lines to warehouses with qty. Today no report aggregates per-product reserved-by-source.

### Implementation

- Add `lib/domain/inventory/reservation-breakdown.ts` that, given a product/warehouse, returns rows of:
  ```text
  source: 'sales_order' | 'stock_transfer' | 'production_order' | 'other'
  referenceId, referenceLabel, qty, expectedDate
  ```
- Sum of rows must equal `StockLevel.reservedQty` for that (product, warehouse). Add an invariant check that flags drift.
- Add an index on `OrderAllocation(productId, warehouseId)` if not already present.

### Acceptance criteria

```text
- Sum of reservation-breakdown rows equals StockLevel.reservedQty for every (product, warehouse).
- Invariant collector reports drift if mismatch.
- Stock allocations report consumes this helper.
```

### Codex prompt

```text
Implement PR 11.6.

Base branch: development.

Add lib/domain/inventory/reservation-breakdown.ts that returns per-source reservation rows for a (productId, warehouseId) and confirms the sum equals StockLevel.reservedQty.
Add an invariant collector that surfaces drift in the rollout readiness endpoint.
Run npm run validate and npm run validate:db.
```

---

## PR 11.7 — Movement-side guarantees for reporting correctness

### Goal

Lock in invariants that the new reports depend on so reports stay correct as movement code evolves.

### Implementation

- DB constraint: `StockMovement.totalValueBase = unitCostBase * qty` (allow NULL on both, enforce when set).
- DB check: every PURCHASE_RECEIPT and PRODUCTION_IN row has a matching `CostLayer`.
- DB check: every SALE_DISPATCH and PRODUCTION_OUT row has at least one matching `CogsEntry` (deferred constraint if movement is created before cogs entries).
- Add nightly invariant: sum of `CostLayer.remainingQty` per (product, warehouse) equals `StockLevel.quantity`.
- Surface failures in the rollout readiness endpoint from PR 10.1.

### Acceptance criteria

```text
- DB rejects rows that violate value-consistency check.
- Nightly invariant flags any (product, warehouse) where layers and StockLevel diverge.
- Rollout readiness blocks on invariant failure.
```

### Codex prompt

```text
Implement PR 11.7.

Base branch: development.

Add DB-level checks for StockMovement value consistency and cost-layer / cogs-entry existence per movement type, plus a nightly invariant comparing sum(CostLayer.remainingQty) against StockLevel.quantity.
Wire failures into the rollout readiness endpoint.
Run npm run validate and npm run validate:db.
```

---

## PR 11.8 — Stock position bundle (on-hand, allocations, negative stock)

### Goal

Ship the three current-state inventory views together. They share data sources (`StockLevel`, `OrderAllocation`, `CostLayer`), filters, and table chrome, so building them as one bundle keeps UI patterns consistent and avoids duplicate query helpers.

### Reports in scope

- **Stock on hand** — `/analytics/stock-on-hand` — current or as-of on-hand qty, reserved, available, unit cost, total value. Backed by `getOnHandAsOf` (PR 11.5). Filters: asOf, warehouse, category, supplier, product type, include-zero. Grouping by category/warehouse with subtotals.
- **Stock allocations** — `/analytics/stock-allocations` — per (SKU, warehouse) breakdown of `reservedQty` by source (sales order, transfer, production), with reference, expected clear date, and age bucket. Backed by `reservation-breakdown` (PR 11.6). Drill-through to source documents.
- **Negative stock** — `/analytics/negative-stock` — any (product, warehouse) where qty went negative within the selected range, or current rows where `quantity < 0`. Surfaces broken movement code and process gaps. Backed by `StockMovement` history + `StockLevel`.

### Acceptance criteria

```text
- Each report has filters, CSV export matching on-screen totals, and pagination/cursor for large datasets.
- Stock-on-hand asOf reconciles with InventorySnapshot.
- Stock allocations sums equal StockLevel.reservedQty per (product, warehouse).
- Negative stock flags every (product, warehouse) in the period; empty result for healthy DB.
- Shared table component and filter component reused across the three pages.
- RBAC: MANAGER, WAREHOUSE, FINANCE, ADMIN.
```

### Codex prompt

```text
Implement PR 11.8.

Base branch: development.

Build three reports under /analytics: stock-on-hand, stock-allocations, negative-stock. Share a single filter/table component set.
Wire stock-on-hand to getOnHandAsOf (PR 11.5), stock-allocations to reservation-breakdown (PR 11.6), and negative-stock to StockMovement + StockLevel.
Include CSV export and RBAC on each.
Run npm run validate.
```

---

## PR 11.8.1 — Historical reservation snapshots for true as-of availability

### Goal

Make stock-on-hand `asOf` reporting represent true historical availability, not just historical on-hand quantity/value enriched with current reservation state.

### Problem

PR 11.8 stock-position reports can show historical on-hand quantity and value through `getOnHandAsOf`, but reserved and available quantities are still enriched from current `StockLevel.reservedQty`. That is correct for the current data model, but it means an as-of stock-on-hand report is not a true historical availability report.

### Implementation

Add a reservation snapshot model or extend the daily inventory snapshot pipeline with reservation evidence per product/warehouse.

Capture enough data to reconstruct:

```text
reservedQty
availableQty
reservation source counts or reconciliation evidence
snapshotDate
productId
warehouseId
```

Update stock-position reports so:

```text
- current reports still use live StockLevel data.
- as-of reports use reservation snapshots when available.
- missing reservation snapshots are surfaced explicitly, not silently mixed with historical on-hand values.
- CSV exports indicate whether reservation values came from current state or a reservation snapshot.
```

### Acceptance criteria

```text
- Historical stock-on-hand can represent true as-of reserved and available quantities when reservation snapshots exist.
- Reports do not silently mix historical on-hand quantity with current reserved quantity without a notice.
- Snapshot writes are idempotent for a given UTC day.
- Tests cover current mode, as-of-with-snapshot mode, and as-of-without-reservation-snapshot mode.
```

### Codex prompt

```text
Implement PR 11.8.1.

Base branch: development.

Add historical reservation snapshots for product/warehouse reserved quantities so stock-on-hand as-of reports can show true as-of reserved and available values.
Keep current-state reporting unchanged for current dates.
Surface missing reservation snapshot evidence explicitly in the report and CSV export.
Add idempotency and report-mode tests.
Run npm run validate and npm run validate:db.
```

---

## PR 11.8.1.1 — Historical reservation snapshot backfill

### Goal

Backfill `inventory_reservation_snapshots` and
`inventory_reservation_snapshot_runs` for historical inventory snapshot dates
captured before PR 11.8.1, so older stock-on-hand as-of reports can show true
historical reserved/available values instead of explicit current-state fallback.

### Implementation

Add an opt-in reservation backfill mode to the inventory snapshot tooling.

```text
- For each historical UTC day, reconstruct reservation balances where possible
  from order allocations, non-pending shipment lines, and in-progress
  production orders.
- Write sparse reservation snapshot rows plus the daily run marker
  idempotently by snapshotDate.
- When reconstruction is incomplete, write an explicit run-level/result warning
  rather than silently marking the day complete.
- Keep the existing on-hand/value backfill behavior unchanged.
```

### Acceptance criteria

```text
- Backfilled days with reliable reservation evidence no longer fall back to
  current StockLevel reservations in stock-on-hand as-of reports.
- Unreliable or unsupported historical reservation reconstruction is surfaced
  in the command output and report metadata.
- Re-running the backfill for the same date range is idempotent.
- Tests cover reliable reconstruction, unsupported reconstruction, and rerun
  idempotency.
```

---

## PR 11.8.2 — Scalable stock-position report filters

### Goal

Keep stock-position reports usable for tenants with large warehouse, category, and supplier option sets.

### Problem

PR 11.8 uses native `<select>` controls for warehouse, category, supplier, and product type filters. This is acceptable for small tenants, but warehouses/categories/suppliers can grow large enough that native selects become hard to scan and inflate page payloads.

### Implementation

Replace the warehouse/category/supplier stock-position filter controls with searchable combobox/autocomplete controls backed by bounded server-side option queries.

Keep:

```text
productType
pageSize
date controls
includeZero
```

as simple controls unless scale requires otherwise.

Support:

```text
query text
selected id hydration
active-only filtering where applicable
bounded result count
request-scoped or short-lived caching
keyboard navigation
empty/loading/error states
```

### Acceptance criteria

```text
- Stock-position filter option payloads are bounded.
- Existing selected warehouse/category/supplier values render even when not in the first option page.
- Keyboard and screen-reader behavior are covered by component tests or focused Playwright coverage.
- The CSV/report URL contract remains unchanged.
- No report business logic changes.
```

### Codex prompt

```text
Implement PR 11.8.2.

Base branch: development.

Replace stock-position warehouse/category/supplier native selects with scalable searchable combobox filters backed by bounded server-side option queries.
Preserve the existing query-string contract and report behavior.
Add tests for selected-value hydration, empty results, and keyboard navigation.
Run npm run validate and relevant Playwright coverage.
```

---

## PR 11.9 — Inventory ledger, adjustments & stocktake bundle

### Goal

All movement-based audit/reconciliation reports. Share `StockMovement` with denormalised value columns (PR 11.2) as the data source.

### Reports in scope

- **Stock movement** — `/analytics/stock-movements` — full ledger with filters (date range, product, warehouse, type, reference, user, min value), opening/closing qty + value reconciliation, drill-through on `referenceId`, cursor pagination, streamed CSV export.
- **Stock adjustments** — `/analytics/stock-adjustments` — filtered view of `type = ADJUSTMENT` movements joined to `AdjustmentReason`, grouped/aggregated by reason, user, SKU. Surfaces write-off value per reason for finance.
- **Transfer history & in-transit** — `/analytics/transfers` — every `StockTransfer` with status, qty, value, dispatch date, expected/actual receipt date, days-in-transit, drift (qty sent vs received). In-transit subset highlights overdue transfers.
- **Stocktake / count variance** — `/analytics/stock-counts` — per `StockCount`: book vs counted, variance qty/value per SKU and total, repeat-offender SKUs across counts, link to resulting adjustment movements.

### Acceptance criteria

```text
- All four reports share the date-range/warehouse/product filter component.
- Stock movement opening + Σ movements = closing on every filtered slice.
- Adjustments report value totals match SUM(StockMovement.totalValueBase) where type=ADJUSTMENT.
- Transfer in-transit list reconciles with StockTransfer.status in (DRAFT,IN_TRANSIT).
- Stocktake variance qty * unit cost matches the linked adjustment movement value.
- Streamed CSV exports return full result set (no pagination cap).
- Drill-through links work to source documents.
- RBAC: WAREHOUSE, MANAGER, FINANCE, ADMIN.
```

### Codex prompt

```text
Implement PR 11.9.

Base branch: development.

Build four ledger reports under /analytics: stock-movements, stock-adjustments, transfers, stock-counts. Share filter and table components.
Stock-movements: full ledger backed by StockMovement (PR 11.2 indexes + value columns) with opening/closing reconciliation.
Stock-adjustments: ADJUSTMENT-type filtered view grouped by AdjustmentReason and user.
Transfers: StockTransfer history with in-transit + drift columns.
Stock-counts: StockCount-driven variance with links to adjustment movements.
Streamed CSV export and RBAC on each.
Run npm run validate.
```

---

## PR 11.10 — Inventory valuation & costing bundle

### Goal

Finance-facing reports that tie inventory value, COGS, and landed cost to the GL. Source of truth for reconciliation with Xero stock and COGS accounts.

### Reports in scope

- **Inventory valuation** — `/analytics/inventory-valuation` — total on-hand value by warehouse / category / SKU at a date, reconciled to Xero stock account balance. Columns: qty, average unit cost, total value (base + currency-of-record), variance vs GL. Backed by `InventorySnapshot` + `CostLayer`.
- **COGS report** — `/analytics/cogs` — period COGS broken down by SKU / category / channel / customer / warehouse, with revenue and gross margin where SO lines link cleanly. Backed by `CogsEntry` joined to `StockMovement` → `SalesOrderLine` → `Customer`.
- **Landed cost analysis** — `/analytics/landed-cost` — per PO and per SKU: goods cost + freight + duties + other allocations, broken out by allocation method (`BY_VALUE`/`BY_WEIGHT`/`BY_QUANTITY`/`EQUAL_SPLIT`), effective unit cost vs base goods unit cost, % uplift. Includes retrospective revaluation runs (`LandedCostRevaluationRun`).

### Acceptance criteria

```text
- Inventory valuation total matches sum(CostLayer.remainingQty * unitCostBase) at asOf.
- Valuation variance vs Xero balance shown explicitly with link to reconciliation finding.
- COGS report total equals sum(CogsEntry.totalCostBase) for the period and reconciles to Xero COGS account.
- Landed cost report sums goods + freight + duties to total landed and matches PurchaseOrder.totalCost.
- RBAC: FINANCE, ADMIN (MANAGER read-only on valuation).
```

### Codex prompt

```text
Implement PR 11.10.

Base branch: development.

Build three financial reports under /analytics: inventory-valuation, cogs, landed-cost.
Inventory-valuation backed by InventorySnapshot + CostLayer with asOf and Xero-balance reconciliation.
COGS backed by CogsEntry joined through StockMovement → SalesOrderLine → Customer with SKU/category/channel/customer/warehouse groupings.
Landed-cost reads PurchaseOrder + FreightCostLine + LandedCostLink + LandedCostRevaluationRun.
Run npm run validate.
```

---

## PR 11.10.1 — GL account-balance ingestion for valuation variance

### Goal

Store accounting-system account balances inside IMS so the inventory valuation and COGS reports can show real GL variance instead of blank variance columns.

In plain terms: IMS already knows what stock is worth from inventory records. This follow-up lets IMS also remember what the accounting system says the stock and COGS accounts are worth, then compare the two.

### Scope

- Ingest stock asset and COGS account balances from connected accounting systems, starting with Xero and using the existing accounting connector boundaries.
- Persist account balance snapshots with accounting system, account code/id, account name, balance date, currency, functional/base amount, source payload reference, and sync run metadata.
- Make ingestion idempotent by `(externalSystem, accountExternalId, balanceDate, currency)` or a stricter connector-provided key.
- Surface variance in `/analytics/inventory-valuation` and `/analytics/cogs` only when a matching account-balance snapshot exists.
- Leave variance blank with an explicit notice when no balance snapshot exists.
- Link material variances to accounting reconciliation findings where possible.

### Acceptance criteria

```text
- Accounting account-balance snapshots are persisted idempotently.
- Inventory valuation can compare IMS stock value against the configured stock asset account balance.
- COGS can compare period COGS against the configured accounting COGS account balance when the accounting system exposes a comparable balance.
- Reports show explicit "no accounting balance snapshot available" notices instead of inferring balances from sync payloads.
- Tests cover idempotent ingestion, multi-currency/base-currency handling, missing-balance behavior, and variance calculation.
```

### Codex prompt

```text
Implement PR 11.10.1.

Base branch: development.

Add accounting account-balance snapshot ingestion for stock asset and COGS accounts.
Persist snapshots idempotently with connector/source metadata.
Wire inventory valuation and COGS reports to show GL variance only when matching snapshots exist; otherwise show an explicit unavailable notice.
Add focused tests for idempotency, currency/base amount handling, missing snapshots, and variance math.
Run npm run validate and npm run validate:db if schema changes are needed.
```

---

## PR 11.11 — Inventory health & velocity bundle (aging, turnover, dead stock, slow/fast mover, ABC)

### Goal

All analytical "how is stock moving" reports. They share the same demand-velocity helper, period selector, and grouping logic, so they belong in one PR.

### Reports in scope

- **Inventory aging** — `/analytics/inventory-aging` — `CostLayer.remainingQty` bucketed by age (`asOf − receivedAt`) with configurable bands (`inventoryReports.agingBuckets`). Honour kit/BOM policy from PR 11.4. AsOf reconstruction via `CostLayer` + later `CogsEntry` consumption.
- **Inventory turnover** — `/analytics/inventory-turnover` — `SUM(CogsEntry.totalCostBase)` ÷ average inventory value from `InventorySnapshot` (simple or time-weighted toggle). Grouping by category/warehouse/supplier/SKU. Columns include ratio and days-inventory-outstanding.
- **Dead stock / non-moving** — `/analytics/dead-stock` — SKUs with no `SALE_DISPATCH` movement in N days (configurable 90/180/365) and qty > 0. Shows value tied up. Distinct from aging (layer age) — this is demand absence.
- **Slow / fast mover** — `/analytics/velocity-rankings` — bottom and top quartiles by sales velocity over a configurable window. Operational complement to ABC.
- **ABC analysis** — `/analytics/abc-analysis` — Pareto classification on COGS (or revenue) over a period: A = top 80%, B = next 15%, C = last 5%. Drives cycle count frequency and reorder policy. Output writeable back to `Product.abcClass` (add optional column).

### Acceptance criteria

```text
- Shared lib/domain/inventory/velocity.ts computes per-SKU daily velocity used by dead-stock, velocity-rankings, ABC, and reorder (PR 11.12).
- Aging bucket sums equal total on-hand qty/value per SKU; KIT policy from PR 11.4 enforced.
- Turnover ratio matches hand-calculated example on seed data.
- Dead-stock threshold (days) is configurable; report excludes never-sold new SKUs younger than threshold (separate flag).
- ABC classes sum to 100% of COGS; A/B/C cutoffs configurable.
- Optional Product.abcClass column updated via batch job or manual save action.
- CSV export and RBAC: MANAGER, FINANCE, ADMIN on all.
```

### Codex prompt

```text
Implement PR 11.11.

Base branch: development.

Build five velocity/health reports under /analytics: inventory-aging, inventory-turnover, dead-stock, velocity-rankings, abc-analysis.
Add lib/domain/inventory/velocity.ts shared helper for daily-sales velocity over a window (excluding returns and adjustments).
Aging backed by CostLayer with PR 11.4 kit policy and configurable buckets.
Turnover backed by CogsEntry + InventorySnapshot (simple or time-weighted).
Dead-stock from velocity helper with configurable window.
Velocity-rankings: quartile classification.
ABC: Pareto classification with configurable cutoffs and optional Product.abcClass writeback.
Run npm run validate and npm run validate:db.
```

---

## PR 11.12 — Replenishment & demand planning bundle (reorder, backorder, BOM shortage)

### Goal

"What should we buy or make next" — the demand-side and supply-shortfall reports. Share the velocity helper from PR 11.11.

### Reports in scope

- **Reorder inventory** — `/analytics/reorder` — uses `Product.reorderPoint` / `reorderQty` / `safetyStockQty` (added in this PR), supplier lead time (`SupplierProduct.leadTimeDays`, add if missing), and demand velocity. Suggested reorder qty: `max(reorderQty, velocity × leadTime + safetyStockQty − available − inboundOnOpenPo)`. "Create RFQ" / "Add to PO" action buttons.
- **Backorder / unfulfillable demand** — `/analytics/backorder` — SO lines where `qty > allocated` aggregated per SKU, with expected inbound from open POs and projected fill date. Surfaces customer-impact urgency.
- **Component shortage / BOM availability** — `/analytics/component-shortage` — given draft/in-progress `ProductionOrder` rows, list `BomItem` components whose required qty exceeds current available stock + inbound. Feeds procurement.

```prisma
model Product {
  ...
  reorderPoint   Decimal? @db.Decimal(12, 4)
  reorderQty     Decimal? @db.Decimal(12, 4)
  safetyStockQty Decimal? @db.Decimal(12, 4)
  abcClass       String?  // populated by PR 11.11 if enabled
}

model SupplierProduct {
  ...
  leadTimeDays Int?
}
```

### Acceptance criteria

```text
- Reorder suggested qty never negative; inbound on open PO subtracts only RECEIVED-pending qty.
- Backorder report sum equals SUM(SalesOrderLine.qty - allocatedQty) for non-cancelled SOs.
- Component shortage takes draft + in-progress production orders into account, not just confirmed.
- "Create RFQ" / "Add to PO" actions create draft documents with supplier and SKU prefilled.
- CSV export on each.
- RBAC: MANAGER, ADMIN (FINANCE read-only).
```

### Codex prompt

```text
Implement PR 11.12.

Base branch: development.

Add Product.reorderPoint/reorderQty/safetyStockQty and SupplierProduct.leadTimeDays (if missing).
Build three replenishment reports under /analytics: reorder, backorder, component-shortage.
Reorder uses lib/domain/inventory/velocity.ts from PR 11.11 and inbound-open-PO helper.
Backorder aggregates SalesOrderLine where qty > allocatedQty with projected fill date.
Component shortage rolls up BomItem requirements across draft+in-progress ProductionOrders against available + inbound stock.
Add "Create RFQ" and "Add to PO" actions on reorder.
Run npm run validate and npm run validate:db.
```

---

## PR 11.13 — Sales & fulfillment analytics bundle

### Goal

Universal sales analytics that every IMS ships — revenue, margin, customer mix, returns, fulfillment KPI.

### Reports in scope

- **Sales by product / category / customer / channel** — `/analytics/sales` — pivotable table with grouping switch and trend chart over the period.
- **Top customers / customer concentration** — `/analytics/customers` — revenue, gross profit, AR exposure, % of total, share-of-business by customer. Highlights concentration risk.
- **Gross margin by product** — `/analytics/margin` — per SKU revenue, COGS (from `CogsEntry`), margin %, margin contribution. Drills into margin-erosion SKUs.
- **Returns analysis** — `/analytics/returns` — `RETURN_INBOUND` movements + `SalesOrderRefund` aggregated by SKU/customer/reason, with refund value and return rate (returns ÷ shipments).
- **Order fulfillment metrics** — `/analytics/fulfillment` — on-time-ship rate, fill rate, average days from order → ship, partial-ship rate, late-ship reasons.
- **Pick/pack/ship throughput** — `/analytics/throughput` — lines/orders processed per day per user, average pack time, queue depth over time. Operational dashboard.

### Acceptance criteria

```text
- Sales totals reconcile with sum of SalesOrder.totalAmount for the period in scope.
- Gross margin uses CogsEntry (no recalculation) and matches the COGS report (PR 11.10).
- Returns and refunds reconcile with SalesOrderRefund totals.
- Fulfillment metrics use Shipment timestamps, not SalesOrder.
- Throughput uses ActivityLog and/or Shipment events as source.
- Multi-currency: amounts shown in base currency with toggle to original currency.
- CSV export on each; RBAC: MANAGER, FINANCE, ADMIN.
```

### Codex prompt

```text
Implement PR 11.13.

Base branch: development.

Build six sales/fulfillment reports under /analytics: sales, customers, margin, returns, fulfillment, throughput.
Share a period-selector, grouping, and currency-toggle component.
Margin uses CogsEntry (no recalc) and must match PR 11.10's COGS totals.
Throughput sources from Shipment events and ActivityLog.
Run npm run validate.
```

---

## PR 11.14 — Purchasing & supplier analytics bundle

### Goal

Procurement-side analytics — what's open, who delivers well, where prices drift.

### Reports in scope

- **Open purchase orders** — `/analytics/open-pos` — every PO not fully received, with expected dates, overdue flag, qty/value outstanding, supplier, days-since-PO-sent.
- **Supplier performance** — `/analytics/supplier-performance` — per supplier: on-time delivery rate, qty variance (received vs ordered), defect/return rate (via `PurchaseReturn`), average actual lead time vs configured, response time on RFQs.
- **Purchase price variance (PPV)** — `/analytics/ppv` — actual landed cost vs prior-PO / standard cost per SKU per supplier, trended over time. Highlights cost creep.
- **Spend by supplier / category** — `/analytics/spend` — total spend per supplier per category per period, with YoY comparison.
- **Lead-time analysis** — `/analytics/lead-times` — distribution of actual receipt date − PO send date per supplier × SKU, percentiles (P50/P95), trend. Feeds reorder calc accuracy.

### Acceptance criteria

```text
- Open PO list matches PurchaseOrder.status in (PO_SENT, PARTIALLY_RECEIVED, SHIPPED).
- Supplier on-time rate uses expected vs actual receipt timestamps from PurchaseReceipt.
- PPV reference price source documented (prior PO, weighted average, or supplier-configured standard).
- Spend totals match SUM(PurchaseOrder.totalBase) for received POs.
- Lead-time P95 used by Reorder report (PR 11.12) when SupplierProduct.leadTimeDays is null.
- CSV export; RBAC: MANAGER, FINANCE, ADMIN.
```

### Codex prompt

```text
Implement PR 11.14.

Base branch: development.

Build five purchasing reports under /analytics: open-pos, supplier-performance, ppv, spend, lead-times.
Supplier-performance and lead-times use PurchaseReceipt timestamps vs PurchaseOrder.expectedDate.
PPV needs a documented reference-price source — make it configurable.
Lead-time P95 should be exposed as a helper that reorder (PR 11.12) can fall back to.
Run npm run validate.
```

---

## PR 11.15 — Tax, receivables, payables & FX bundle

### Goal

Finance period-end reports. These tie into Xero output and are typically required before any sub-ledger close.

### Reports in scope

- **VAT / sales tax** — `/analytics/vat` — output VAT by rate, by jurisdiction, period totals for VAT return. Backed by `SalesOrderLine.taxAmount`, `TaxRate`, and (for sales) shipping address country.
- **AR aging** — `/analytics/ar-aging` — outstanding `SalesOrder`/invoice balances by customer in buckets (current / 1-30 / 31-60 / 61-90 / 90+), with last payment date and contact.
- **AP aging** — `/analytics/ap-aging` — outstanding `PurchaseInvoice` balances by supplier in matching buckets.
- **FX gain/loss** — `/analytics/fx-gain-loss` — booked vs settled FX delta per multi-currency PO/SO/payment, sourced from `FxRate` history. Reconciles to Xero FX gain/loss account.

### Acceptance criteria

```text
- VAT report total per rate matches sum of invoice line tax for the period.
- AR/AP bucket totals reconcile with sum of outstanding balances.
- FX gain/loss per transaction = (settlement_rate − booking_rate) × foreign_amount and ties to Xero FX account.
- Bucket boundaries configurable.
- CSV export; RBAC: FINANCE, ADMIN only.
```

### Codex prompt

```text
Implement PR 11.15.

Base branch: development.

Build four finance reports under /analytics: vat, ar-aging, ap-aging, fx-gain-loss.
VAT report aggregates SalesOrderLine.taxAmount by TaxRate and jurisdiction.
AR/AP aging buckets configurable; reconcile to Xero balances.
FX gain/loss computed from FxRate at booking vs FxRate at settlement, per transaction.
Restrict RBAC to FINANCE and ADMIN.
Run npm run validate.
```

---

## PR 11.16 — Manufacturing analytics bundle

### Goal

Production reporting — variance and WIP value.

### Reports in scope

- **Production variance** — `/analytics/production-variance` — per assembly `ProductionOrder`: planned vs actual component consumption per BOM line, over-consumed qty/value, and order yield. Flags BOM accuracy issues and excessive component consumption without labelling the cause as scrap.
- **WIP report** — `/analytics/wip` — current `IN_PROGRESS` production orders with consumed component value, manufacturing cost-line totals, combined WIP value, expected output value, and decimal days-since-start.

### Acceptance criteria

```text
- Variance: planned qty from BomItem × ProductionOrder.qty; actual from PRODUCTION_OUT consumption movements per order, scoped to assembly orders that can consume components.
- Variance date filters apply to completedAt; in-progress rows without completedAt appear only when no date window is selected.
- WIP is a current-state report and does not apply date filters.
- WIP value equals posted consumed component value plus ManufacturingCostLine totals for IN_PROGRESS orders.
- Drill-through from WIP and variance rows to source ProductionOrder.
- CSV export; RBAC: MANAGER, FINANCE, ADMIN.
```

### Codex prompt

```text
Implement PR 11.16.

Base branch: development.

Build two manufacturing reports under /analytics: production-variance, wip.
Variance compares BomItem × ProductionOrder.qty (planned) against PRODUCTION_OUT consumption movements (actual).
WIP combines posted consumed component value with ManufacturingCostLine totals for IN_PROGRESS ProductionOrders.
Run npm run validate.
```

---

# Completed implementation order

The original implementation order below has been completed through PR #117. It
is retained as an audit trail of the rollout sequence, not as an active queue.

## Wave 1 — completed before production readiness sign-off

```text
PR 0.1  production-readiness CI
PR 0.2  production preflight command
PR 1.1  database restore production kill switch
PR 1.2  configured-origin destructive POST checks
PR 2.1  connector timeout and response cap
PR 3.1  shopping webhook body cap and JSON safety
PR 4.1  expiring invoice PDF tokens
PR 5.1  database quantity constraints
PR 6.1  session revocation and active-user revalidation
PR 7.1  encryption-key production preflight
PR 7.2  persistent storage production preflight
```

## Wave 2 — completed before wider operational rollout

```text
PR 2.2  raw connector fetch audit
PR 3.2  shopping webhook inbox and async processing
PR 3.3  Shopify webhook inbox and async processing
PR 4.2  invoice PDF persistent storage path
PR 5.2  stock movement idempotency
PR 6.2  fresh auth for destructive actions
PR 8.1  WMS receipt review layer
PR 9.1  replace TODO public route behavior tests
PR 10.1 rollout readiness endpoint
```

## Wave 3 — completed hardening and reporting build-out

```text
PR 8.2  WMS Decimal arithmetic
PR 11.1 product category for reporting slices
PR 11.2 denormalised cost/value on StockMovement + time indexes
PR 11.3 InventorySnapshot table + daily cron
PR 11.4 kit/BOM aging policy (component-based)
PR 11.5 as-of historical on-hand helper
PR 11.6 reservation breakdown helper
PR 11.7 reporting-side movement invariants
PR 11.8 stock position bundle (on-hand, allocations, negative stock)
PR 11.8.1 historical reservation snapshots for true as-of availability
PR 11.8.2 scalable stock-position report filters
PR 11.9 inventory ledger bundle (movements, adjustments, transfers, stocktake)
PR 11.10 inventory valuation & costing bundle (valuation, COGS, landed cost)
PR 11.10.1 GL account-balance ingestion for valuation variance
PR 11.11 inventory health & velocity bundle (aging, turnover, dead stock, slow/fast mover, ABC)
PR 11.12 replenishment & demand planning bundle (reorder, backorder, BOM shortage)
PR 11.13 sales & fulfillment analytics bundle
PR 11.14 purchasing & supplier analytics bundle
PR 11.15 tax, AR/AP & FX bundle
PR 11.16 manufacturing analytics bundle
```

## Future hardening candidates

These items were left as non-blocking future candidates after the planned PR
sequence completed:

```text
Further decomposition of app/actions/mintsoft-sync.ts and app/actions/manufacturing.ts
More SQL-backed invariant collectors
Automated backup restore test in staging
```

---

# Current Codex usage

Do not start from PR 0.1; it has already shipped. For new work, branch from
`development`, inspect the current code and relevant historical section, and
create a focused PR for the user's current request or newly identified gap.
