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

`acquire()` also has stale-lock recovery for the common case.

## Webhook delivery + redirect-URI / OAuth

- The stage store's **order.created / order.updated webhooks** must point at
  `https://ims-e2e.onetwo3d.co.uk`. The tier uses Woo's own delivery — **no hand-posted
  HMAC**; `awaitWebhookDelivery()` fails loudly rather than falling back, so a broken webhook
  is caught, not hidden. This trafficless store only delivers when WP-Cron is nudged (the
  harness does this); a single order commonly arrives as **two** `order.updated` deliveries.
- Xero's **redirect URI** for the rig's app must be registered in the Xero developer portal.
- The **Demo company resets ~every 28 days**, which drops the OAuth grant. After a reset:
  re-consent the connection (Settings → Accounting → Xero → Connect) and re-run the **Demo
  provisioner** so the accounts/currencies/bank accounts/VAT rates the specs expect exist
  again (o3d-lgo.9).

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
