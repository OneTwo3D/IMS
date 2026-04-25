# Agent Workflow

This repository uses a staged reliability plan for AI-assisted work. The plan is tracked in `docs/IMS_Codex_Implementation_Plan.md`; implement it one PR or sub-stage at a time.

## Branching

All project work uses `development` as the base branch and PR target.

```bash
git fetch origin
git checkout development
git pull --ff-only origin development
test "$(git branch --show-current)" = "development"
git checkout -b codex/<stage-or-task-name>
```

Do not branch from `main` and do not target `main`. If `development` is unavailable, stop and report the issue.

## Session Startup

At the start of a Codex session:

1. Load local instructions from `AGENTS.local.md` when present; otherwise follow this document and the tracked `AGENTS.md`. `AGENTS.local.md` is intentionally ignored by git for clone-specific agent preferences.
2. Read the assigned stage or sub-stage in `docs/IMS_Codex_Implementation_Plan.md`.
3. Inspect the relevant parts of `README.md`, `package.json`, `prisma/schema.prisma`, `docs/`, `app/actions/`, `app/api/`, `lib/`, `tests/`, and CI files.
4. Read relevant Next.js docs from `node_modules/next/dist/docs/` before editing routing, server actions, route handlers, caching, or config.
5. Confirm validation commands from `package.json`.

## Scope Control

- Implement one assigned task, stage, or sub-stage per branch.
- Preserve existing behavior unless the task explicitly says otherwise.
- Keep PRs small and reviewable.
- Add or update tests for every changed behavior.
- Do not remove tests to make validation pass.
- Do not add dependencies unless the PR explains why existing tools are insufficient.

## Domain Rules

High-risk domains need extra care:

- inventory
- stock allocation
- FIFO cost layers
- COGS
- landed cost
- refunds
- purchase orders
- Xero and QuickBooks accounting
- WooCommerce sync
- auth and authorization
- cron jobs
- backups
- imports and exports
- uploads

For these areas, prioritize correctness, idempotency, transactions, auditability, and rollback safety over convenience. Use Decimal-safe helpers for financial, FX, tax, discount, COGS, landed-cost, FIFO, and quantity calculations where available.

Keep server actions thin. Use them for authentication, input parsing, adapter work, cache revalidation, and redirects. Move reusable business logic into `lib/domain`.

Prefer deterministic idempotency keys for integrations, cron jobs, accounting events, and outbox jobs. Prefer report-only diagnostics before any auto-repair behavior.

## Secrets and Environment

- Do not edit `.env`, `.env.local`, production credentials, private keys, OAuth secrets, or service tokens.
- Do not print secrets in logs, summaries, tests, or docs.
- If local validation fails because `DATABASE_URL`, PostgreSQL, Redis, external services, or credentials are unavailable, document the exact blocker.
- Do not switch validation or tests to production services.

## Validation

The usual baseline is:

```bash
npm run lint
npm run type-check
npx prisma generate --schema prisma/schema.prisma
npm run db:schema:scope -- origin/development HEAD
```

For schema, migration, Prisma, or database behavior changes, also run:

```bash
npm run validate:db
```

For focused TypeScript tests:

```bash
npx tsx --test tests/<relevant-file>.test.ts
```

For focused E2E tests:

```bash
npx playwright test e2e/<relevant-spec>.spec.ts
```

Run `npm run validate` for the environment-light local baseline. Run `npm run validate:db` when a local `DATABASE_URL` is configured and the database is reachable.

## Staged PR Process

Recommended order:

1. Agent instructions, validation script, API route auth inventory, secret scanning, cron auth hardening, and state-machine definitions.
2. Business logic extraction: allocation, shipment, refund, landed cost, then status enforcement.
3. Inventory and accounting invariants, scheduled invariant reports, Decimal helpers, and high-risk conversion cleanup.
4. Accounting events, mirroring, reconciliation, integration outbox, WooCommerce outbox, and Xero outbox.
5. Rate limiting, upload tests, health diagnostics, cron run IDs, import dry-runs, stock availability optimization, and docs cleanup.

Highest-risk work includes shipment/refund extraction, Decimal conversion in domain paths, accounting event migration, and Xero outbox migration. Deploy low-risk safety changes first, run invariant checks in read-only mode before repair behavior, and keep old sync logs as source of truth until reconciliation is stable.

## Review Expectations

Use a fresh review session for high-risk PRs. Review for:

- business workflow correctness
- inventory and accounting invariants
- authorization and data exposure
- transaction boundaries
- idempotency
- Decimal, money, and quantity precision
- test coverage
- migration safety
- operational rollback risk

## Required Handoff

Every agent task should end with:

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
