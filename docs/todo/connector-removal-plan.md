# Connector removals: Shopify and QuickBooks

The owner's decision (2026-09) is that QuickBooks, Shopify and ShipHero are not
in focus. **ShipHero is done** — see
[`../archive/shiphero-connector-removal.md`](../archive/shiphero-connector-removal.md).
This plans the other two. Production is not in use and will be reinstalled from
scratch, so no retrospective data fixes are needed; all deployment is to the
development system.

## The pattern ShipHero established

1. **Delete, don't flag.** Dead code behind a feature flag is not archived, it
   is unmaintained. Everything connector-specific goes.
2. **Archive by annotated tag + a `docs/archive/` note.** The tag
   (`archive/<connector>-connector`) pins the last commit that contains the
   code and is immutable and fetched by default; the note is what a grep for the
   connector's name in the working tree still finds afterwards. Not a retained
   branch (a moving ref that looks like live work).
3. **Keep the registry multi-entry, and prove it with a fictitious connector.**
   The abstraction is what makes a future connector cheap, and with one
   implementation left nothing else stops someone inlining it.
4. **Say what the removed connector was the SOLE user of.** Either it becomes
   dead (delete it) or it reveals the abstraction was shaped around one
   implementation (record that — it is worth knowing).
5. **Watch for tests that pass for an adjacent reason.** ShipHero's removal made
   every test that reached a "this connector's create is unsafe" path do so via
   an *unregistered* id, which fails closed for a different reason and produces
   the identical refusal. Those tests would have passed against a build with the
   policy deleted. Only a registered fictitious connector separates the two.

---

## Do Shopify FIRST, then QuickBooks

**Shopify is the easier removal and the safer one to do now.** QuickBooks is
entangled with accounting work that is currently in flight.

### Shopify — moderate, self-contained, and it closes two gaps for free

**Footprint:** 8 files named `shopify` (a 1,291-line connector lib, one job
adapter, one dashboard client, one banner PNG, one test, one doc); ~99 files
mention it. **No API/cron/webhook route is named `shopify`** — every route is
already generic (`app/api/shopping/**`,
`app/api/webhooks/shopping/[connector]/[resource]`,
`app/api/cron/shopping-webhook-inbox`). **No Prisma model, enum value, column or
index is Shopify-specific** — `prisma/schema.prisma` contains exactly one
occurrence, a comment on line 530. **No migration is needed.**

**It is a half-connector.** Real Shopify Admin GraphQL for `fetchOrders`,
`fetchProducts`, `syncStock`, product links, delivery status and HMAC webhook
verification — but `processShopifyWebhookPayload` writes every drained event
back as `FAILED` with "Shopify webhook processing is not implemented yet", and
manual order/product sync returns "not wired yet". **No order or product has
ever entered IMS via Shopify.** That makes the removal low-risk and also means
the inbox has been filling with permanently-failing rows.

**Shopify is the sole user of:**
- `lib/connectors/not-implemented.ts` — its only importer;
  `notImplementedError` has zero callers anywhere. Delete the module. (ShipHero
  had its own local copy, so this survived the first removal.)
- `WEBHOOK_ORIGIN_NOT_APPLICABLE` — the only production writer that omits an
  origin attestation. Keep the constant, record that it has no live producer.
- The `drainers: Record<ShoppingConnector, InboxDrainer>` map's second entry,
  `persistShopifyWebhookEvent`, and the second member of
  `ShoppingWebhookEventConnector`.
- **The whole `lib/jobs/shopping/` ↔ `lib/jobs/{woocommerce,shopify}/` split.**
  With one connector left, `lib/jobs/shopping/process-shopping-webhook-events.ts`
  has exactly one caller. This is the ShipHero `stock-sync-helpers.ts` lesson
  repeating: a "shared" layer that was never actually shared. Decide
  deliberately — collapse it or keep it and say why.

**Two gaps close for free, and both are real changes in reach:**
- `tests/security/setting-secret-read-authorization.test.ts` carries an explicit
  `'app/actions/shopping-sync.ts': 'OUT OF SCOPE (Shopify)'` exemption. Removing
  Shopify closes it; the exemption entry must be deleted or the exhaustiveness
  check flags it.
- `app/api/backup/restore/route.ts` names "a `shopify` delivery to the shopping
  webhook route" as the one shopping ingress **not fenced** by maintenance mode.
  With Shopify gone, `app/api/webhooks/shopping/**` is fully fenced. Update the
  inventory the same way the ShipHero row was updated — and note that
  `tests/api/backup-restore.test.ts:2561` asserts by *reading `lib/shopping.ts`
  source* (`/case 'shopify':[\s\S]{0,200}handleWebhook/`), so it hard-fails.

**The hard part is `lib/shopping.ts`.** It has **13 hand-written
`switch (connector)` statements**, each with a `case 'woocommerce'` and a
`case 'shopify'` arm. Seven of the Shopify arms are already deliberate no-ops.
Collapsing the union to `'woocommerce'` makes every one of them a compile error
— which is good (they are found for you), but it is also where the abstraction
will quietly die. **The registry (`SHOPPING_CONNECTORS`) is genuinely
multi-entry and drives the ingress validation and the Numbering tab; the
dispatch below it is not.** So the seam to protect is not the registry, it is
those thirteen switches: they are the thing a second storefront would have to
be threaded through, and with one arm each they read as pointless.

**Also collapses:** four *duplicate* connector-id unions that are not imported
from one another (`lib/jobs/shopping/drain-inbox.ts`,
`app/api/shopping/manual-sync/route.ts`,
`components/onboarding/wms-onboarding-connection.tsx`, plus the canonical one in
`shopping-registry.ts`), and the hardcoded `isShoppingConnectorId` predicate in
`lib/fulfillment/shopping-order-lookup.ts`. Narrow them in lockstep.

**Dead branches that must be deleted, not re-fixtured:** the
WooCommerce/Shopify mutual-exclusivity guards in `app/actions/settings.ts:1209`
and `app/actions/onboarding.ts:286` become unreachable, along with the tests in
`tests/accounting/plugin-selection-lock.test.ts` that assert their refusal text.

**Watch:** `tests/connectors/shopping-contract.test.ts:123` asserts
`SHOPPING_CONNECTORS.length >= 2` — the headline breakage. That file already
proves genericity with a hypothetical `'newshop'` connector, so it is most of a
second-connector seam test already; finish that job rather than weakening the
assertion. `tests/connectors/shopping-webhook-empty-body.test.ts` loses its only
non-WooCommerce subject (the czuf4 default-deny behaviour). And
`scripts/documented-env-var-allowlist.json` **errors on stale entries**, so the
`SHOPIFY_STORE_DOMAIN` waiver, `.env.example:289-305` and
`docs/installation.md:3614` must move in one commit.

**Data left behind (dev only, no migration):** `shopping_webhook_events` rows
with `connector='shopify'` become unprocessable; `Setting` rows
`shopify_*`/`plugin_shopify_enabled` become orphans. State the decision (leave,
dead-letter, or delete) rather than leaving it implicit.

### QuickBooks — the largest of the three, and it should WAIT

**Footprint:** 17 connector files (5,373 LOC), 2 server-action files, 19
test files named `quickbooks`/`qbo`, ~296 files mentioning it. Like Shopify,
**no schema migration is required**: there is no `AccountingConnector` enum and
no QuickBooks-specific model or column — the connector is a plain
`String @default("xero")` on four tables (`AccountingAccount`,
`AccountingAccountBalanceSnapshot`, `AccountingSyncLog`, `AccountingToken`).
What *is* required is a decision about rows with `connector='quickbooks'` and
provenance strings beginning `quickbooks:`.

#### Should it wait for the accounting branches in review? YES.

There are **no open PRs** (the last merged is #674, which is
`origin/development` HEAD), but there are **108 unmerged `o3d-*` branches and 48
live worktrees**, and the accounting layer is where the current work is:

- **Three branches are pure QuickBooks feature work** that a removal would
  obsolete outright: `o3d-0g2n-qbo-backref` (6 QBO commits),
  `o3d-b3gw-qbo-payment-idempotency` (2), `o3d-iaqy-tenant-guard`.
- **Two large in-review branches carry heavy QBO churn:**
  `o3d-batch-payreg` (46 ahead, 16 QBO commits, live worktree) and
  `o3d-0m56-manual-retry-guard` (24 ahead, 18 QBO commits, live worktree).
- **The riskiest for the *shared* layer** are `o3d-q-ledger` (44 ahead, 17
  accounting commits, updated 2026-09-09) and the `o3d-11rf-*` pair (updated
  2026-09-10), which touch `accounting-settlement-probe.ts` — exactly where the
  ~350-line QBO probe arm lives.

Removing QuickBooks now means rebasing all of that through a 5,000-line
deletion. Land the accounting branches first; the removal gets easier every
time one merges, and nothing depends on doing it early.

#### Keeping the accounting abstraction honest with only Xero left

The important finding from the survey: **the accounting abstraction is in worse
shape than the WMS one was, and in a specific direction — it is shaped around
the *weaker* connector.**

- `getAccountingConnector(id)` is **`if (id === 'quickbooks') {...}` then fall
  through to Xero** — not a map, not even a switch. That is one edit away from
  being deleted as an `if` with one arm.
- `AccountingConnectorDef` carries only `{ id, label, available }`. There is **no
  capability metadata at all** — which is why the registry has to fake four
  QuickBooks methods with hardcoded "not available yet" stubs
  (`getConnectionTestState`, `testConnection`, `syncAccountBalanceSnapshots`,
  and `retryFailedSync` silently ignoring `expectedAttemptRevision`).
- `AccountingSyncLogRow` **omits `attemptRevision`** — a field Xero actually
  produces — because the QuickBooks processor never stamped one. The
  connector-agnostic type was narrowed to the weaker implementation.
- There are **four separate, unlinked definitions** of the
  `'xero' | 'quickbooks'` union (`accounting-registry.ts`,
  `app/actions/accounting-sync.ts`, `app/(dashboard)/sync/accounting-settings-fields.ts`,
  `lib/domain/accounting/connector-orphans.ts`), plus a fifth UI variant.

So the honest plan is **not** "preserve the abstraction as it stands" — it is:

1. **Fix the narrowing on the way out.** Restore `attemptRevision` to
   `AccountingSyncLogRow` and make `expectedAttemptRevision` required again;
   both were weakened for QuickBooks alone. Removing the connector is the moment
   to take that back, and it is a strictly safer contract.
2. **Give `AccountingConnectorDef` capability flags** (connection-test gate,
   balance-snapshot ingestion, attempt-revision stamping, settlement probe,
   payment reconcile). Today those differences are expressed as `if
   (id === 'quickbooks')` stubs scattered across the registry and four cron
   routes; as definition fields they become data a second connector declares.
3. **Turn `getAccountingConnector` into a factory map** keyed by the registry,
   and collapse the four duplicate unions into the one in
   `accounting-registry.ts`.
4. **Then add the fictitious-connector seam test**, modelled on
   `tests/wms-second-connector-seam.test.ts`: register a fictitious accounting
   connector with a different capability profile and drive
   `accounting-id-provenance`, `accounting-connection-provenance`,
   `accounting-posting-intent`, `accounting-egress-authorization` and
   `connector-orphans` through it.

**What must survive regardless of any of that:**
`accounting-id-provenance.ts` **is not a two-connector artefact**. Its
provenance string is `"<connector>:<tenantId>"`, and the *tenant* half stays
load-bearing with Xero alone — a re-authorisation to a different Xero org is
exactly the case it exists for. The `<connector>:` prefix is embedded in stored
data (`Product.accountingItemProvenance`,
`Customer`/`Supplier.accountingContactProvenance`,
`AccountingSyncLog.connectionProvenance`), so it cannot be dropped without a
migration — and there is no reason to. The same is true of
`accounting-connection-provenance.ts` (motivated by a pure-Xero incident,
o3d-t74p), `accounting-egress-authorization.ts` and
`accounting-binding-lock-order.ts`.

**Genuinely QuickBooks-only, and therefore dead on removal:** ~350 lines of
`accounting-settlement-probe.ts` (`probeQuickBooksSettlement` and its types),
125 QBO mentions in `lib/domain/accounting/unrecorded-posted-document.ts`
(`QBO_DIRECTIONS`, `UnpersistedQboPost`, `describeQboNoEffectIncident`, …),
`QUICKBOOKS_RECOVERY` in the follow-up obligation registry, two of five
`LocalTarget` members in `local-operator-direction.ts`,
`QUICKBOOKS_SYNC_TYPE_SETTING` (15 keys), `QBO_DAILY_BATCH_LOCK_KEY`, and the
whole `connector-orphans.ts` cross-connector-switch surface.

**Behaviours that exist only because QuickBooks differs from Xero** — decide
per item whether they are general robustness worth keeping or QBO scar tissue:
string-typed money (`TotalAmt`/`Balance` as `number | string`, with a dedicated
test), missing currency on payment lines, `allowCache` being a no-op, the
`OPERATOR_ASSERTION` settlement-by-human surface (which exists largely because
QBO has no reconcile sweep), and the `activity-log-cleanup.ts` retention
exemption for `quickbooks_posted_document_unrecorded`.

**Traps:** four tests **read `lib/connectors/quickbooks/sync-processor.ts` off
disk** and throw ENOENT the moment the directory goes
(`tests/db/advisory-lock-keys.test.ts`,
`tests/accounting/ledger-settlement-evidence.test.ts`,
`tests/accounting/unrecorded-outcome-decides-the-remedy.test.ts`,
`tests/accounting/followup-enqueue-resolver-door.test.ts`), and
`scripts/check-fulfillment-requirement-seam.mjs:82` and
`scripts/decimal-boundary-targets.json:6` both declare QuickBooks paths and will
fail. `ACCOUNTING_FOLLOW_UP_RECOVERY` and `ACCOUNTING_SYNC_ENABLED_SETTING_KEYS`
are typed `Record<string, …>`, so a stale `quickbooks` key is a **silent**
breakage, not a compile error.

---

## Suggested order

| # | Connector | When | Why |
|---|---|---|---|
| 1 | ShipHero | **done** | No live deployment, self-contained, established the pattern. |
| 2 | Shopify | next | Self-contained, no schema change, no in-flight work, and it closes a security exemption and a maintenance-fence gap. |
| 3 | QuickBooks | after the accounting branches merge | 5,000 LOC across a layer that five live branches are actively changing; nothing gains by doing it early. |
