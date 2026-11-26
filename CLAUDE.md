# One Two Inventory (OTI)

Inventory management for product companies: sales, purchasing, stock control, manufacturing, FIFO costing, multi-currency, sync with WooCommerce and Xero. Repo: `git@github.com:OneTwo3D/IMS.git`. Owner: One Two Enterprises Ltd.

Reference detail lives in `docs/agent/` (read only when the task touches that area):
- `docs/agent/overview.md` — project tree, core modules, data flow, DB model list, module-to-file map (snapshot, partly stale).
- `docs/agent/code-patterns.md` — worked code examples for the rules below, full naming/import/error-handling text.
- `docs/agent/env-vars.md` — every environment variable table plus the WooCommerce status-filter, Xero tenant and install-time-seed notes. Read before adding or changing an env var or a setting that has an env fallback.
- `docs/agent/debugging-and-skills.md` — debugging recipes, support contacts, skill list.
- `docs/agent/history.md` — stale "recent features" list.
Also: `docs/agent-workflow.md` (branching and session startup), `docs/architecture.md`, `docs/development.md`, `docs/migration-conventions.md`, `deploy/README.md`, `README.md`, `docs/getting-started.md`. The "plan", "configuration" and "deployment" docs this file used to cite do not exist.

## Stack

Node 26+, Next.js 16 (App Router, Server Components, Server Actions, Turbopack), React 19, TypeScript 5 strict, PostgreSQL 14+ with Prisma 7 (`prisma/schema.prisma`), NextAuth.js 5 beta (TOTP 2FA, Passkey/WebAuthn), Tailwind 4, Shadcn/UI + Base-UI, PDFKit, ESLint 9, npm. `AGENTS.md` warns that this Next.js has breaking changes: read the relevant guide in `node_modules/next/dist/docs/` before writing Next code.

## Commands

```bash
npm install && cp .env.example .env     # then edit DATABASE_URL and secrets
npx prisma migrate deploy && npx prisma generate
npm run cli -- create-user              # interactive admin/staff/supplier user
npm run dev                             # localhost:3000, hot reload
npm run build && npm start              # production bundle, port 3000
npm run lint | type-check | db:seed | db:studio
```

## Rules for every change

### Documentation (mandatory, CI-enforced)
- Update the docs in the SAME PR as the code: `docs/**` for developer, operator and architecture behaviour, and `help-docs/**` for user-facing screens, labels, actions and support workflows. A flagged feature that is switched off is documented as built and switched off, not as live.
- Code is the source of truth. Where a doc and the code disagree, fix the doc. If the code looks wrong, file a bead rather than documenting the bug as intended.
- `npm run check:docs-required` (ungated job `docs-required` in `.github/workflows/static-guards.yml`) fails a PR that changes behaviour-bearing code without a docs change. If nothing needs documenting, add `Docs: none — <reason>` to the PR's `changelog.d` fragment.
- The single list of behaviour-bearing paths, exclusions, documentation paths, surfaces to check and opt-out rules is docs/development.md, "Documentation Updates".

### Naming and imports
- Files: `kebab-case` (components, actions, routes, utilities, config); UI primitives lowercase; hooks `useX.ts`.
- Identifiers: PascalCase components/classes/types; camelCase functions (verb prefix) and variables; `SCREAMING_SNAKE_CASE` constants; hooks `useX`; booleans `is`/`has`/`should`; state hooks `[x, setX]`.
- Import order: React/Next, external packages, internal `@/` imports, component imports, `import type`.

### Code
- TypeScript strict: no ambiguous `any`; `import type` for type-only imports; explicit return types on public functions.
- Server Actions: start with `'use server'`; `await requireAuth()` (or a permission guard) first; validate input with an explicit Zod schema; call `logActivity()` on every state mutation (create, update, delete) with a descriptive message, tag (inventory/sales/sync/...) and entity id; `revalidatePath()`/`revalidateTag()` to refresh UI cache. `requireAuth`/`requirePermission` live in `@/lib/auth/server`; `hasPermission`/`getPermissions` in `@/lib/permissions`; `logActivity` in `@/lib/activity-log`.
- Client components: `'use client'` only where interactivity is needed; pages stay server components and hand data to extracted client components.
- Permissions: enforce server-side with `requirePermission('x.y')` (throws 403) or `hasPermission(session.user.role, 'x.y')`; validate role on the server to prevent privilege escalation.
- Forms: modal/dialog style (never separate pages), Zod in the server action, React server-action submission, loading and error states.
- Errors, API routes: JSON with status code and message; log errors to the activity log; never expose stack traces; 401 auth, 403 permission, 400 validation, 500 server.
- Errors, Server Actions: throw (`new Error('User message')` for user-facing); always catch database errors and log to the activity log; include context.
- Errors, client: wrap server-action calls in try-catch, show friendly messages, log technical detail, show loading skeletons.

### Security checklist (every change)
- Authentication: endpoints require a session (`requireAuth()`). Authorization: role checks (`requirePermission()`/`hasPermission()`). Input: Zod validates all server-action input.
- SQL: Prisma parameterised queries only. XSS: avoid `dangerouslySetInnerHTML`. CSRF: NextAuth tokens. Data exposure: no passwords/secrets in responses.
- Cron endpoints are protected by the `CRON_SECRET` header. File uploads: validate MIME type, enforce size limits, sanitise filenames. Consider rate limiting public endpoints (webhooks).
- Never commit secrets; `.env.example` is the template; `NEXT_PUBLIC_*` variables must not contain secrets.

### Server Action authorization guards
`npm run check:server-action-guards` runs `check:server-action-auth-bypass` (no Server Action may take a serializable option that suppresses its permission check), `check:server-action-guard-coverage` (every exported async function in a `'use server'` module enforces a guard, delegates to a verified one, or is allowlisted with a reason that must still suppress something) and `check:server-action-authorization` (executable proofs that each gate refuses the principal it claims to: which role, which named permission, and, provably, that no read ran on the refused path). They run in `scripts/validate-local.sh` (as the composite) and in their own ungated workflow, `.github/workflows/server-action-auth-guard.yml`, one independent job per half so a failing half cannot hide the others. Rules the guards encode:
- A `'use server'` export is a public HTTP endpoint. Not being imported by any UI, and being on an allowlist, are both irrelevant to who can call it.
- Authentication is not an authorization answer. `requireAuth` says someone is signed in; use `requirePermission` / `requireInternalUser` to say who. Endpoints left on `requireAuth` are pinned, with the Prisma models they reach, in `tests/security/server-action-guard-coverage.test.ts`; adding one means arguing in the diff that it is self-scoped to the caller.
- SUPPLIER is an EXTERNAL principal with no `internal` permission: internal reads gate on `requireInternalUser` (or a real permission), never `requireAuth`. On the supplier's own surface scope the query to `session.user.supplierId` and re-check ownership of anything fetched by id.
- The guards resolve identifiers (`tests/security/module-graph.ts`), so a local helper shadowing a guard's name, or an aliased import, is judged by what it is.

### Testing
- New business logic should ship with a test in `npm run test:unit` (node:test + tsx over `tests/**/*.test.ts`). Export pure builders/helpers so they can be tested directly (see `tests/wms-order-push-payload.test.ts`).
- `npm run test:concurrency` needs a DB and `RUN_DB_CONCURRENCY_TESTS=1`. `npm run e2e` is Playwright (tags `@wc` / `@xero` / `@external`).
- Static gates: `npm run type-check`, `npm run lint`, `npm run check:all` (decimal, connector-fetch, WMS-connector, migration-convention, documented-env-vars and other boundary guards, plus `check:server-action-guards`).

### Environment variables and settings
- When you add a new env var, add it to `.env.example` and `docs/agent/env-vars.md`; `check:documented-env-vars` fails a documented variable that nothing reads. Tables and notes: `docs/agent/env-vars.md`.
- Install-time seeds only (insert-only into the `settings` table by `scripts/provision-instance.mjs`, editing `.env` afterwards changes nothing): `WC_STORE_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET` and the `SMTP_*` variables. `WC_CONSUMER_KEY`/`WC_CONSUMER_SECRET`/`WC_WEBHOOK_SECRET`/`WC_INVOICE_PDF_SECRET` are runtime overrides. `WC_STORE_URL` must NOT be added to `SETTING_ENV_FALLBACKS`.
- Not env vars: Xero OAuth client id/secret (Settings -> Integrations -> Xero, encrypted in `settings`), Xero tokens (encrypted in Postgres, no token file), base currency (`Organisation.baseCurrency`), WC order statuses (`wc_sync_order_statuses`), WC poll cadence (`wc-reconcile` cron schedule). Do not document or add variables for these.
- Keep the Sync page copy, `docs/installation.md` and `lib/connectors/woocommerce/webhooks.ts` in step with the `wc_sync_order_statuses` behaviour described in `docs/agent/env-vars.md`.
- Set an id-based Xero tenant control (`XERO_ALLOWED_TENANT_IDS`, `XERO_BLOCKED_TENANT_IDS` or `XERO_REQUIRE_DEMO_ORG`) on every non-production instance.

## Deployment

Three paths exist; the code that implements each is the reference (`deploy/README.md` has the detail).
- **Stage** (this host): runs as the non-root `ims` user from `/opt/ims/onetwo3d-ims` (`/root/ims/onetwo3d-ims` symlinks to it) under systemd on port 3000. The installed unit is `ims-stage-dev.service` (`next dev`, hot reload, `development` branch). The unit file in `deploy/systemd/ims-stage-dev.service` is the older root/`0.0.0.0` variant marked DEPRECATED and does NOT match the installed one; `deploy/systemd/ims-stage.service` (`next start`, `User=ims`, loopback-only, sandboxed) is the hardened production-build unit the stage host has not moved to. `deploy/systemd/ims-e2e-dev.service` is the full-chain rig (port 3002, `next start`).
- **Bare-metal install** (`scripts/install.sh`, then `scripts/update.sh`): a systemd service `one-two-inventory.service` that runs `next start -p <APP_PORT>` as `imsapp` from `/opt/one-two-inventory`. See `docs/installation.md`.
- **Production host** (`deploy/bin/deploy.sh <full-commit-sha>`): CI-built container images in blue/green slots behind nginx. See `deploy/README.md`, "Production host: blue/green deploy".

After code changes on stage:
1. Merge to `development` (IMS PRs target `development`, not `main`).
2. On the host, as `ims`: `git -C /opt/ims/onetwo3d-ims pull`. Never run git in this tree as root. `next dev` hot-reloads source changes, so usually nothing else is needed.
3. If dependencies or the schema changed, do not run a bare `prisma migrate deploy` under the running server. Run `scripts/deploy.sh` as root (header usage: `--dry-run`, `--skip-build`, `--skip-migrate`, `--restart-only`): build, validate, stop and drain every writer, migrate, verify, start. A migration needs `DEPLOY_ADMIN_DATABASE_URL` and a systemd unit serving the tree (`IMS_SERVICE_UNIT` if it cannot be detected). It does not pull code.
4. Restart only when needed: `systemctl restart ims-stage-dev.service`.
5. Verify on `http://127.0.0.1:3000` (nginx fronts the stage hostname).

Deploy order on stage and bare-metal hosts: the old process must be fully stopped before the new one starts or the schema moves (`scripts/deploy.sh`, `scripts/update.sh`). Never run two versions against the same database there: no rolling restart, no second instance on another port. The production blue/green deploy is the one deliberate exception: the previous release keeps serving while the new one migrates and starts in the idle slot, which is why its migrations must be expand-only (below).

Money posts stamp `accounting_sync_logs.remoteAttemptedAt` before the remote call, and an unstamped row is proof nothing was sent from it. Whether that proof holds is recorded on the row in `attemptStampingCustodyAt`: a version that does not write the column leaves it NULL when it creates a row, and a database trigger nulls it when such a version claims one. Rows outside custody are never recycled, and the first sync run of a version that stamps marks them as attempted. So an overlap, or a rollback (which no deploy order can prevent, since rolling back is a sequential deploy), is self-declaring and heals at the next sync run: no operator step, no setting to clear. See `lib/domain/accounting/money-attempt-provenance.ts`.

Database migrations:
- `npm run build` is plain `next build` and applies no migration (`package.json` has no postinstall or prebuild hook). Migrations are applied by `prisma migrate deploy` inside `scripts/install.sh`, `scripts/update.sh` and `scripts/deploy.sh` (after the writers are stopped), and by the migrate image in `deploy/bin/deploy.sh`. Review `schema.prisma` changes before deploying; test migrations on staging first.
- Follow `docs/migration-conventions.md` (NOT NULL add-columns, NOT VALID constraints, column renames, large-table indexes, column drops).
- Expand-only rule for the production blue/green deploy: a migration in a normal deploy must work with the previous release, which keeps serving while it runs. Make `-- expand-only` the FIRST line of its `migration.sql` (additive changes only). `deploy/bin/deploy.sh` refuses any pending migration without the marker and `rollback.sh` refuses to roll back across one. A contract (destructive) migration ships alone as a maintenance deploy (`--allow-contract-migration --maintenance`). See `deploy/README.md`, "Production host: blue/green deploy".

## Git workflow
- IMS PRs target `development` (`gh pr create --base development`); branch details in `docs/agent-workflow.md` and `docs/development.md`.
- Commit messages clear and descriptive (e.g. "Add COGS recalculation on landed cost edit"). Commit and push after completing features.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
