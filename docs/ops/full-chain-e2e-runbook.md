# Full-chain E2E runbook (Woo stage → IMS → Xero Demo)

The `@full-chain` tier (`e2e/full-chain/`) originates a real order in the stage
WooCommerce store, lets **Woo's own webhook** deliver it to a dedicated IMS instance,
drives the real IMS UI, lets the real sync post to the **Xero Demo company**, and asserts
against documents **read back from the Xero API** — then voids them. It is the only tier
that proves the whole chain end to end; every other "Xero" test stops at IMS's own
`accountingSyncLog`/UI row and cannot see a wrong account code, tax type, or amount.

This runbook is the operational companion to the specs. It supersedes the
`how-to-run-a-live-xero-e2e-test` beads memory.

## The rig

A **dedicated, isolated** IMS instance — never stage — runs the suite:

| | Full-chain rig | Stage (do not run the suite here) |
|---|---|---|
| Worktree | `/opt/ims/onetwo3d-ims-e2e` (git worktree) | `/opt/ims/onetwo3d-ims` |
| systemd service | `ims-e2e-dev.service` | `ims-stage-dev.service` |
| Port | 3002 | 3000 |
| Server | `next start` (production build) | `next dev` (hot reload) |
| Database | `onetwo3d_ims_e2e` | `onetwo3d_ims_dev` |
| Public URL | `https://ims-e2e.onetwo3d.co.uk` | `https://ims-stage.onetwo3d.co.uk` |

The rig **shares the one Woo store and the one Xero Demo org** with stage — isolation is by
DB + port + a quiesce lock, not by a second store/org. Both trees are owned `ims:ims`; the
services run as `User=ims`.

**Never run `git`/`npm`/`npx`/`prisma`/`playwright` in these trees as root** — it litters
root-owned files the service then cannot write. Claude Code's Write/Edit tools run as root,
so `chown ims:ims <file>` after editing and check with
`find /opt/ims/onetwo3d-ims-e2e -user root -not -path '*/node_modules/*' -not -path '*/.git/*'`.

### Why a production build, not `next dev`

`ims-e2e-dev.service` runs `npm run start` off `.next`. That is deliberate: `next dev`
compiles routes on first request (auth.setup then flakes past Playwright timeouts) and
ballooned to multi-GB caches. **Cost:** a code/schema/prisma change is NOT hot-reloaded — you
must rebuild and restart (below). A test-only change needs neither.

## Running the suite

```bash
runuser -u ims -- bash -c 'export HOME=/opt/ims/onetwo3d-ims-e2e; \
  cd "$HOME" && npm run e2e:full-chain -- --grep "OC-01"'
```

Traps, each failing in a way that looks like something else:

- **`HOME` must be the WORKTREE, not `/tmp`.** Playwright's browsers live in
  `$HOME/.cache/ms-playwright`; with the wrong HOME it errors *"browserType.launch: Executable
  doesn't exist … run npx playwright install"*. `/home/ims` is root-owned and unwritable, so
  do not rely on the passwd home either.
- **`NODE_OPTIONS='--import tsx'`** is set by the npm script. Calling `npx playwright test`
  directly drops it and fails with `exports is not defined in ES module scope`.
- **Login rate limiter.** `lib/auth/config.ts` throttles login to 10/15 min, fail-closed,
  memory-backed. Repeated debug logins trip it; `auth.setup.ts` then hangs 60s as if the
  credentials were wrong. A **service restart** clears the in-memory buckets.

### After a code/schema/prisma change

```bash
runuser -u ims -- bash -c 'export HOME=/opt/ims/onetwo3d-ims-e2e; cd "$HOME" && npm run build'
# prisma migrate deploy + prisma generate too if the schema changed
systemctl restart ims-e2e-dev.service   # as root
```

The preflight's **build-freshness guard** fails the run if any served source file is newer
than the last build (it excludes `e2e/`, `tests/`, `docs/`, `scripts/`). After a restart,
**poll for health — never sleep a fixed interval**; the rig takes 10–45s and answers `/login`
with 500 mid-swap:

```bash
for i in $(seq 1 24); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3002/login)" = "200" ] && break
  sleep 5
done
```

### The `.env`

The worktree has no committed `.env` (it is gitignored). It must carry the **e2e**
`DATABASE_URL` (`onetwo3d_ims_e2e`), `AUTH_SECRET`, `SETTINGS_ENCRYPTION_KEY`, etc. Do **not**
copy stage's `.env` — the preflight aborts (*"DATABASE_URL points at STAGE"*). Reconstruct
from the running service's environ if lost:

```bash
E2EPID=$(systemctl show ims-e2e-dev.service -p MainPID --value)
tr '\0' '\n' < /proc/$E2EPID/environ | grep -vE '^(PATH|HOME|PWD|...)' \
  > /opt/ims/onetwo3d-ims-e2e/.env && chown ims:ims /opt/ims/onetwo3d-ims-e2e/.env
```

WooCommerce creds are **not** in `.env` — `wcCreds()` reads `wc_url`/`wc_consumer_*` from the
e2e DB `settings` table (values are encrypted; the harness decrypts with
`SETTINGS_ENCRYPTION_KEY`).

### Batch-cron rate limit — required for running >1 batch test per invocation (o3d-lgo.13)

`accounting-daily-batch` is rate-limited to **1/hour/IP** (`lib/cron-rate-limit.ts`, defence-in-
depth over `CRON_SECRET`). A single suite run that drives the daily batch more than once —
**OC-08 and X-01 both do** — otherwise 429s on the second trigger (the spec detects it and
**skips loudly**, never a false pass). To let one invocation cover both, the rig's `.env.local`
sets **both** of:

```
E2E_TEST_MODE=1          # the repo's e2e flag; also gates lib/testing/e2e-route-guard etc.
E2E_CRON_RATE_LIMIT_MAX=10000
```

`applyE2eMaxOverride` only honours `E2E_CRON_RATE_LIMIT_MAX` when `E2E_TEST_MODE=1` **and** the
job is the allowlisted `accounting-daily-batch`, and it can only **raise** the limit — so it
cannot widen any other cron or tighten production (production leaves both unset). These are
**server-side** env vars: after adding them, **rebuild + restart** `ims-e2e-dev.service` (Next
reads them at server start). Without them the rig keeps the 1/hour limit and batch tests must run
in **separate invocations** (or restart the service — memory-backed limiter — between them).

## The quiesce lock (single point of failure)

`global-setup.ts` takes a **quiesce lock** that disables the stage store's connectors
(`wc_sync_enabled`, `plugin_xero_enabled`, `xero_sync_enabled`, …) for the run window, so
stage cannot race the rig on the shared store/org. `global-teardown.ts` releases it — **even
after failures**, and on a **90s budget** so a Xero rate-limit stall cannot hold stage down.

If a run is `SIGKILL`ed before teardown, the lock can strand and **stage stays disabled**.
Recover manually:

```bash
runuser -u ims -- bash -c 'export HOME=/opt/ims/onetwo3d-ims-e2e; cd "$HOME" && \
  NODE_OPTIONS="--import tsx" node --env-file=.env scripts/restore-stage-connectors.ts'
```

Add `--status` to inspect without changing anything. It prints the lock's **owner** (host +
pid), its **lease** (last renewal) and a **verdict** — `HELD`, `RECOVER` or `WAIT` — and warns
before releasing one that still looks live.

### One run at a time, enforced (o3d-lgo.14)

The operating model has always been one invocation at a time. It is now enforced rather than
assumed, by three things that only work together:

- **Ownership.** `acquire()` returns a token; `release()` verifies it and is a **no-op for a
  process that never acquired**. Playwright runs `globalTeardown` even when `globalSetup`
  throws, so a *refused* second invocation reaches teardown — without the token it would
  restore stage, cancel the running suite's queue and delete its lock. `runTeardown` skips
  everything when it does not hold the lock, and `global-setup` touches nothing shared (the
  fx_rates sweep, the run-id file) until the lock is really ours.
- **Atomic claim.** The claim is one conditional `INSERT … ON CONFLICT DO NOTHING`, and
  recovery deletes **compare-and-set** on the exact row it judged. Read-then-write let two
  near-simultaneous runs both see no row and both write one.
- **A renewed lease.** The holder heartbeats every 30s; a lock is abandoned only after
  `LEASE_TTL_MS` (5 min) without renewal. A *fixed* staleness window cannot tell "still
  running" from "died an hour ago" for a holder on another host — and a one-worker suite with
  30-minute test timeouts can outlive any window short enough to be useful.

So a second invocation **aborts with a clear message** instead of trampling the first.
Same-host pid liveness is kept as a fast path on top of the lease: a crash on this box is
recovered immediately rather than after the TTL, which is the case this recovery was
originally written for. A live pid whose lease has lapsed is **refused, not recovered** —
hung is not dead, and killing it is the operator's call. Locks written before leases existed
are still recovered, on age alone, after `LOCK_STALE_AFTER_MS` (45 min).

If a holder's lock is recovered from under it (an operator forcing the escape hatch, say), its
next heartbeat logs `*** LOST THE QUIESCE LOCK ***` and that run stops touching shared state —
it will **not** restore stage on the new owner's behalf.

## Webhook delivery + redirect-URI / OAuth

- The stage store's **order.created / order.updated webhooks** must point at
  `https://ims-e2e.onetwo3d.co.uk`. The tier uses Woo's own delivery — **no hand-posted
  HMAC**; `awaitWebhookDelivery()` fails loudly rather than falling back, so a broken webhook
  is caught, not hidden. This trafficless store only delivers when WP-Cron is nudged (the
  harness does this); a single order commonly arrives as **two** `order.updated` deliveries.
- Xero's **redirect URI** for the rig's app must be registered in the Xero developer portal.
- **The rig's `.env` must constrain it to a Xero DEMO organisation** (o3d-9tbz):

  ```
  XERO_REQUIRE_DEMO_ORG=true                      # the rig's primary tenant control
  XERO_BLOCKED_TENANT_IDS=<the LIVE organisation's tenantId>   # belt and braces
  XERO_ALLOWED_TENANT_NAMES=Demo Company (UK)     # optional, and NOT sufficient on its own
  ```

  The database pin (`xero_expected_tenant_id`) does not survive a rebuilt or restored database, and it
  was its absence that let this rig connect to the LIVE organisation and post 150 invoices into it
  (o3d-t74p). Env is the only tenant control a database reset cannot erase: with it set, a consent that
  offers a non-demo org is refused with nothing stored, and a restored production database is refused at
  every sync instead of at no point at all.

  **`XERO_REQUIRE_DEMO_ORG` is the control that actually fits this rig, and it replaced the deny-list as
  the primary one.** It is proven from Xero's own `IsDemoCompany` on `GET /Organisation` — a call the
  connection callback already makes — so it costs nothing, and it is a fact about how the organisation
  was created rather than a label anyone can adopt. That means it survives the Demo company's ~28-day
  re-creation with **no edit at all**, which `XERO_ALLOWED_TENANT_IDS=<demo tenantId>` does not (a
  control that needs re-editing every cycle gets switched off, which protects nothing).

  **Keep `XERO_BLOCKED_TENANT_IDS=<live org>`, but stop treating it as the answer.** A deny-list refuses
  the organisations somebody remembered to list. A **third** organisation — a bookkeeper's sandbox, a
  second company, anything else the person consenting can reach — is neither blocked nor allow-listed
  and would connect. Blocking the live id constrains the rig *away from one ledger*; it never
  constrained it *to* Demo.

  `XERO_ALLOWED_TENANT_NAMES` is a convenience that **narrows** the consent to Demo; it is **not** an
  identity and must not be the rig's only tenant control. A Xero organisation name is neither unique nor
  fixed — anyone administering an organisation can rename it — so a name-only guard is defeated by a
  rename, and IMS logs `xero_tenant_guard_name_only` in the activity log while it stays that way.
  `XERO_REQUIRE_DEMO_ORG=true` counts as an anchor and clears that warning.

  **After restoring a production dump onto the rig, the Xero connection is refused as UNVERIFIED** until
  it is re-consented: the restored token carries no proof that its organisation is a demo one, and under
  this key unproven is refused. That is the intended behaviour — it is precisely the state the incident
  ran in for days. Disconnect on `/sync` and reconnect to Demo.
- The **Demo company resets ~every 28 days**, which drops the OAuth grant. After a reset:
  1. **Disconnect Xero on `/sync`.** The database pin still names the *retired* Demo tenantId, so
     reconnecting without this is refused with `pinned to Xero tenantId …, which this consent did not
     include`. Disconnecting clears the pin; neither `XERO_REQUIRE_DEMO_ORG` nor
     `XERO_BLOCKED_TENANT_IDS` needs an edit. Re-consent from **one** tab: two callbacks in flight at
     once bind one organisation and the other is refused, telling you to disconnect and retry.

     If you clear the pin from the database instead, use
     `provision-xero-demo.ts --clear-tenant-pin` — it deletes the pin **and** records the release on
     the token row in one transaction. Deleting the `xero_expected_tenant_id` row by hand does not,
     and IMS halts the sync on a token that has outlived its pin (o3d-9tbz r6): an absent pin used to
     be an exemption from the split-binding refusal, i.e. a way to switch it off.

     Run the flag **before** the pin goes. The release is recorded only when that statement is the one
     deleting the pin, and the receipt names the connection and the pin it released, so it stops
     applying the moment either changes (o3d-9tbz r7). On a rig whose pin has already vanished the flag
     records nothing and does not lift the halt — press **Disconnect** on `/sync`, which clears both
     halves. `full-chain-preflight` names both states explicitly rather than letting the run discover
     them on the first posting spec.
  2. Re-consent the connection (Settings → Accounting → Xero → Connect).
  3. Re-run the **Demo provisioner** so the accounts/currencies/bank accounts/VAT rates the specs
     expect exist again (o3d-lgo.9).

## Rate budget

Xero's cap is ~1,000 calls/org/rolling-24h (free/Starter). A full read-back-plus-void test is
~15–20 calls; the rig now fits comfortably (~900 calls of daily headroom) since the payment
poller's drain was cut. Still, a heavy dev day CAN contend because the rig and stage share the
one Demo org. Prefer `--grep` to run one case at a time.

## Teardown & dirty-ledger recovery

`global-teardown.ts`, in order: **cancel** any queued sync rows this run left (so the next
run's preflight is not wedged), **void** every tracked Xero document (invoices/credit
notes/manual journals — via the `trackDocument` registry), **release** the lock, then **fail
the run** if the ledger was not left clean.

- Documents are voided only if `trackDocument`-ed. A test that posts something must register
  it failure-safe (poll for the posted id in a `finally`) or it strands.
- **Never** fuzzy-scan the shared Demo ledger to find strays for teardown — a substring/
  reference match can void an unrelated stage document. Assert absence via the IMS **queue
  log** instead; a document cannot reach Xero without first being written as a sync row.
- After a killed run, the next run's read-only **straggler scan** names anything left behind;
  void those by hand in Xero, or re-run so teardown catches them.

## Notes / gotchas verified in practice

- **The rig has no accounting cron.** The shared `ims` crontab points every entry at
  `ims-stage` (:3000); nothing drives the rig's `/api/cron/*`. The rig drains the Xero queue
  **only** via the test's explicit "Process pending now" (the specs call
  `processPendingXeroSyncViaUi`). Do not use the rig's Scheduler UI — `syncCrontab()` writes
  the single shared `ims` crontab and would fight stage's.
- **Posting is a branch.** `isDailyBatchPostingEnabled()` = `xero_sync_enabled &&
  xero_daily_batch_enabled`. In **sync** mode the SALES_INVOICE/CREDIT_NOTE post but a
  shipment's COGS journal (and a refund's COGS reversal) do **not** — those are daily-batch
  (Group B) only. `runDailyBatchSync()` drains **globally**, so a targeted batch-mode test on
  the shared rig would journal every accumulated unjournaled shipment; batch-mode coverage
  needs a clean-state fixture (X-01's job).
- **Some cases need config the rig may lack.** FX-import cases need `fx_rates` seeded;
  INVOICE_PAYMENT needs a Payment Account Mapping + a valid Demo bank account. Provision via
  the Demo provisioner rather than by hand.
