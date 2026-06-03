# Agent Workflow

This repository previously used staged reliability and production-readiness plans for AI-assisted work. `docs/IMS_Codex_Implementation_Plan.md`, `docs/IMS_Codex_Followup_Implementation_Plan.md`, and `docs/IMS_Codex_Production_Readiness_Blockers.md` are now historical implementation records unless a human explicitly asks to reopen a listed follow-up. New work should start from the user's current request, open PRs/issues, or a newly identified production-readiness gap.

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
2. Read the user's assigned task and any directly relevant historical plan section if the task references one.
3. Inspect the relevant parts of `README.md`, `package.json`, `prisma/schema.prisma`, `docs/`, `app/actions/`, `app/api/`, `lib/`, `tests/`, and CI files.
4. Read relevant Next.js docs from `node_modules/next/dist/docs/` before editing routing, server actions, route handlers, caching, or config.
5. Confirm validation commands from `package.json`.

## Scope Control

- Implement one assigned task, stage, or sub-stage per branch.
- Preserve existing behavior unless the task explicitly says otherwise.
- Keep PRs small and reviewable.
- Add or update tests for every changed behavior.
- Add or update documentation in the same PR when behavior, operator workflow, validation, configuration, public/help text, integrations, or runbooks change.
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

The usual baseline before opening a PR is:

```bash
npm run validate
```

`npm run validate` runs linting, TypeScript type-checking, Prisma client generation, unit/security tests, workflow documentation checks, and the Prisma schema scope check against `origin/development`.

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
npm run e2e:select
npx playwright test e2e/<relevant-spec>.spec.ts
```

For GitHub Actions trigger or gating changes, validate both the static workflow checks and the event-specific behavior being changed. `npm run docs:workflows:check` does not simulate GitHub event payloads; push-trigger changes need either a real CI push run or focused tests that assert push and pull request event paths use the intended refs.

Run `npm run validate:db` when a local `DATABASE_URL` is configured and the database is reachable.

## Documentation Updates

Documentation is part of the change, not a later cleanup. For every PR, check whether the change affects:

- `README.md` for high-level user or setup entry points
- `docs/development.md` for agent/developer workflow, validation, and guardrails
- `docs/architecture.md` for domain model, invariant, accounting, inventory, or integration design
- `docs/installation.md` and `.env.example` for configuration, deployment, secrets, storage, or connector setup
- connector and runbook docs such as `docs/woocommerce.md`, `docs/xero-sync.md`, `docs/woocommerce-live-runbook.md`, and WMS/Mintsoft docs when integration behavior changes
- `docs/workflows.md` and the workflow generator when status transitions change
- `help-docs/` when user-facing screens, labels, available actions, or support workflows change

If a behavior change intentionally has no documentation impact, say that explicitly in the PR summary or review response.

## PR Process

Do not continue the old staged plans by default; their queued sequences have been implemented through the production-readiness analytics/reporting work. Use them as historical context for why a feature exists, not as the current backlog. For new tasks, keep branches focused and reviewable, preserve behavior unless the task explicitly changes it, and update docs/tests with the code.

Highest-risk work still includes inventory/accounting invariants, Decimal conversion in domain paths, WMS/Mintsoft side effects, connector URL/secret safety, reconciliation persistence, migrations, and any mutation path that affects stock, COGS, GL postings, refunds, or shipments. Deploy low-risk safety changes first and use report-only diagnostics before auto-repair behavior.

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
