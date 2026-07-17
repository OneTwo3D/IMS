/**
 * Preflight for the full-chain suite (o3d-lgo.4).
 *
 * Promotes the guardrails from scripts/tmp-6oyu19-xero-post.ts, which was marked "NOT
 * FOR COMMIT" precisely because those checks were too important to leave in a one-off.
 *
 * Every check here exists because its absence has already caused, or nearly caused, a
 * real problem:
 *   - wrong instance: the runbook's correction #4 records that Playwright's webServer
 *     loads .env and, absent an override, targets the STAGE database;
 *   - wrong tenant: the pin is what stops this rig posting test journals into a
 *     PRODUCTION Xero org;
 *   - dirty queue: processPendingXeroSync drains the WHOLE queue, so a stray PENDING
 *     row would post an unrelated document to the shared Demo ledger and be blamed on
 *     the suite;
 *   - unmapped tax rates: Xero mints TAX0nn per-org in creation order, so after a Demo
 *     reset a stale mapping resolves to a VALID BUT WRONG rate — invoices post with the
 *     wrong VAT, silently (this really happened: o3d-g4r, 30/35 of stage's mappings).
 *
 * Fail here, loudly, rather than let a run produce plausible-but-wrong results.
 */
import { Client } from 'pg'
import { xeroGet } from '../../../lib/connectors/xero/api.ts'
import { checkBuildFreshness } from './build-freshness.ts'

const REQUIRED_TENANT = 'Demo Company (UK)'

/**
 * How long the live-org probe may take before preflight stops waiting and fails.
 *
 * Generous for a healthy call (usually well under a second) and far short of what a rate-limited
 * Xero can make us wait: the client sleeps for Retry-After, and the rolling 24h cap returns one
 * measured in hours. The teardown got the same treatment in #492 for the same reason; preflight
 * is where the wait actually bites now, since it makes the first Xero call of any run.
 *
 * NB the daily cap is 1,000 calls per org per rolling 24h (Xero cut it from 5,000 in March 2026),
 * which is why this is a routine occurrence rather than an edge case.
 */
const XERO_PROBE_BUDGET_MS = 30_000

/** Sentinel: compared by reference, so it can never collide with a real response. */
const PROBE_TIMED_OUT = Symbol('xero-probe-timed-out')

/** Resolve to `onTimeout` rather than waiting forever. The work is abandoned, not cancelled. */
async function withBudget<T, S>(work: Promise<T>, ms: number, onTimeout: S): Promise<T | S> {
  let timer: NodeJS.Timeout | undefined
  const budget = new Promise<S>((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms) })
  try {
    return await Promise.race([work, budget])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export type PreflightReport = { ok: boolean; problems: string[]; warnings: string[] }

export async function preflight(): Promise<PreflightReport> {
  const problems: string[] = []
  const warnings: string[] = []
  const url = process.env.DATABASE_URL ?? ''

  if (!url) return { ok: false, problems: ['DATABASE_URL is not set.'], warnings }
  if (url.includes('onetwo3d_ims_dev')) {
    return {
      ok: false,
      problems: [
        'DATABASE_URL points at the STAGE database (onetwo3d_ims_dev). The full-chain suite ' +
          'creates orders, posts journals and rewrites settings — it must only ever run against ' +
          'the e2e instance.',
      ],
      warnings,
    }
  }

  // --- is the server even running this tree? (o3d-0qk)
  // First, because everything below it is wasted if the answer is no: a suite that passes
  // against a stale build has proved nothing, and does it convincingly.
  const freshness = checkBuildFreshness()
  problems.push(...freshness.problems)
  warnings.push(...freshness.warnings)

  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    // --- Xero connection + tenant identity
    const tok = await db.query<{ tenantName: string; tenantId: string }>(
      `select "tenantName", "tenantId" from accounting_tokens where connector = 'xero'`,
    )
    if (!tok.rows.length) {
      problems.push('No Xero connection on this instance. A human must consent at /sync?connector=xero.')
    } else {
      const { tenantName, tenantId } = tok.rows[0]
      if (tenantName !== REQUIRED_TENANT) {
        problems.push(`Connected tenant is "${tenantName}", not "${REQUIRED_TENANT}". Refusing to run.`)
      }
      // Re-read the LIVE org: a stale token row must not be enough to unlock posting.
      //
      // ON A BUDGET, because this is the FIRST Xero call of any run and the one that discovers
      // a rate limit. xeroFetch sleeps for Retry-After on a 429 (lib/connectors/xero/api.ts),
      // and the cap is a ROLLING 24-HOUR window whose Retry-After is measured in hours.
      // Unbudgeted, a rate-limited run prints two lines and then hangs silently —
      // indistinguishable from a broken rig, and it cost most of a day twice (o3d-98q).
      // Fail in seconds with the real reason instead.
      const org = await withBudget(
        xeroGet<{ Organisations: Array<{ Name: string; BaseCurrency: string }> }>('Organisation'),
        XERO_PROBE_BUDGET_MS,
        PROBE_TIMED_OUT,
      )
      if (org === PROBE_TIMED_OUT) {
        problems.push(
          `Xero did not answer within ${XERO_PROBE_BUDGET_MS / 1000}s. The usual cause is the rolling 24h ` +
            `1,000-call limit on the shared Demo tenant (Xero cut it from 5,000 in March 2026): the client ` +
            `sleeps for Retry-After, which the cap returns in HOURS, so the run would hang rather than fail. ` +
            `Note stage's own crons spend this same org's budget continuously. Wait for the window to roll ` +
            `off (~24h after the calls that spent it) or use a different tenant. See bd o3d-98q.`,
        )
      } else if (!org.ok || !org.data?.Organisations?.length) {
        problems.push(`Could not read the Xero organisation (token expired or revoked?): ${org.error ?? 'unknown error'}`)
      } else if (org.data.Organisations[0].Name !== REQUIRED_TENANT) {
        problems.push(`LIVE Xero org is "${org.data.Organisations[0].Name}", not "${REQUIRED_TENANT}".`)
      }

      const pin = await db.query<{ value: string }>(`select value from settings where key = 'xero_expected_tenant_id'`)
      if (pin.rows.length && pin.rows[0].value !== tenantId) {
        problems.push(
          `xero_expected_tenant_id (${pin.rows[0].value}) does not match the connected tenant (${tenantId}). ` +
            `The Demo probably reset — run: provision-xero-demo.ts --clear-tenant-pin, reconnect, then re-provision.`,
        )
      }
    }

    // --- queue hygiene
    const pending = await db.query<{ count: string }>(
      `select count(*)::text as count from accounting_sync_logs
        where connector = 'xero' and status in ('PENDING','PROCESSING')`,
    )
    if (pending.rows[0].count !== '0') {
      problems.push(
        `${pending.rows[0].count} PENDING/PROCESSING Xero sync log(s) already queued. ` +
          `processPendingXeroSync posts the WHOLE queue, so these would be posted to the shared Demo ` +
          `ledger and attributed to this run. Drain or cancel them first.`,
      )
    }

    // --- account mappings the suite asserts on
    const required = [
      'xero_sales_account', 'xero_cogs_account', 'xero_inventory_account',
      'xero_allocated_inventory_account', 'xero_transit_account', 'xero_unearned_revenue_account',
      'xero_accounts_receivable_account', 'xero_accounts_payable_account',
    ]
    const rows = await db.query<{ key: string; value: string }>(
      `select key, value from settings where key = any($1)`, [required],
    )
    const have = new Map(rows.rows.map((r) => [r.key, r.value]))
    const missing = required.filter((k) => !have.get(k)?.trim())
    if (missing.length) problems.push(`Unmapped account settings: ${missing.join(', ')}. Run provision-xero-demo.ts.`)

    // transit MUST differ from allocated inventory, or the transit reconciliation's
    // premise breaks: it assumes the transit account moves only via 8 purchasing
    // streams, but the daily batch also codes allocated inventory (o3d-f82).
    const transit = have.get('xero_transit_account')
    const allocated = have.get('xero_allocated_inventory_account')
    if (transit && allocated && transit === allocated) {
      problems.push(
        `xero_transit_account and xero_allocated_inventory_account are BOTH ${transit}. The transit ` +
          `GL reconciliation would flag a material gap on any window with sales (o3d-f82).`,
      )
    }

    // --- per-type posting settings
    // queueAccountingSync is a NO-OP unless the per-TYPE setting (xero_sync_sales_invoice
    // etc.) is set and not 'off' — getAccountingPostingContext (accounting.ts:173-175)
    // returns null otherwise. Nothing is queued, nothing errors, and the test later fails
    // hunting for a document that was never even requested.
    const perType = await db.query<{ key: string }>(
      `select key from settings where key like 'xero_sync_%'
        and key not in ('xero_sync_enabled','xero_sync_attach_pdf') and value <> 'off' and value <> ''`,
    )
    const needTypes = ['xero_sync_sales_invoice', 'xero_sync_credit_note', 'xero_sync_cogs_journal']
    const haveTypes = new Set(perType.rows.map((r) => r.key))
    const missingTypes = needTypes.filter((k) => !haveTypes.has(k))
    if (missingTypes.length) {
      problems.push(
        `Per-type posting settings missing/off: ${missingTypes.join(', ')}. queueAccountingSync ` +
          `silently no-ops for those types, so nothing is ever queued to Xero.`,
      )
    }

    // --- tax rates resolvable
    // Scoped to active OR storefront-mapped, NOT just active (o3d-6ec). A WC mapping can
    // point at an INACTIVE rate and resolveWcTaxRateById does not filter on active, so that
    // rate taxes real orders. Checking only active rates let 33 of 65 mapped rates sit with
    // no accounting_tax_type while preflight reported everything fine — the invoice then
    // posts to Xero with no TaxType.
    const unmapped = await db.query<{ name: string }>(
      `select name from tax_rates
        where (active or id in (select "taxRateId" from shopping_tax_rate_mappings))
          and (accounting_tax_type is null or accounting_tax_type = '')
        order by name`,
    )
    if (unmapped.rows.length) {
      // Name the rates rather than counting them. --remap-only fixes only those whose NAME
      // matches a rate in the live Xero org; anything else needs a human to choose a tax
      // type, and telling them to re-run a script that cannot help would waste their time.
      problems.push(
        `${unmapped.rows.length} tax rate(s) that are active or storefront-mapped have no ` +
          `accounting_tax_type, so their invoice lines post to Xero with NO TaxType: ` +
          `${unmapped.rows.map((r) => `"${r.name}"`).join(', ')}. ` +
          `Try provision-xero-demo.ts --remap-only first; it resolves by NAME against the live ` +
          `org, so any rate whose name Xero does not know needs a tax type chosen by hand.`,
      )
    }

    // --- a usable default tax rate exists (o3d-6ec)
    // fallbackDefaultTaxRate (field-mapping.ts:293) queries { isDefault: true, active: true }
    // and, finding nothing, silently returns 0% VAT with a null tax type — indistinguishable
    // from a line that genuinely has no tax. Both instances shipped in exactly that state:
    // the isDefault flag sat on an INACTIVE rate.
    const usableDefault = await db.query<{ count: string }>(
      `select count(*)::text as count from tax_rates where "isDefault" and active`,
    )
    if (usableDefault.rows[0].count === '0') {
      problems.push(
        'No tax rate is both isDefault AND active, so fallbackDefaultTaxRate silently resolves ' +
          'every unmapped WC rate to 0% VAT with no tax type. Set the default onto a live rate.',
      )
    }

    // --- Woo credentials
    const wc = await db.query<{ count: string }>(
      `select count(*)::text as count from settings where key in ('wc_url','wc_consumer_key','wc_consumer_secret')`,
    )
    if (wc.rows[0].count !== '3') problems.push('WooCommerce credentials are not fully configured on this instance.')

    // --- the guard that silently ate every order webhook
    // handleOrderWebhook (webhooks.ts:125) returns {ok:true, skipped:'initial_import_pending'}
    // unless wc_initial_import_completed === 'true'. It ACKs, so the event is marked
    // PROCESSED and never retried, and nothing is imported — the test then fails 5
    // minutes later with "the order never arrived", pointing at webhooks that are in
    // fact working perfectly. Cost hours; hence this check.
    const initial = await db.query<{ value: string }>(
      `select value from settings where key = 'wc_initial_import_completed'`,
    )
    if (initial.rows[0]?.value !== 'true') {
      problems.push(
        `wc_initial_import_completed is not 'true' on this instance, so handleOrderWebhook SILENTLY ` +
          `SKIPS every order webhook (skipped: initial_import_pending) while still ACKing it. ` +
          `Either run the real initial import, or set the flag: the rig only cares about orders it ` +
          `creates itself, so the "baseline import exists" precondition is satisfied by declaring it.`,
      )
    }

    // --- storefront-synced warehouse
    // Without one, importWcOrder creates the order but auto-allocation fails with
    // "No storefront-synced warehouses available for sale", which surfaces as an import
    // error rather than anything about warehouses.
    const wh = await db.query<{ count: string }>(
      `select count(*)::text as count from warehouses where "syncToStore" = true and "availableForSale" = true and active = true`,
    )
    if (wh.rows[0].count === '0') {
      problems.push(
        'No warehouse has syncToStore=true + availableForSale=true, so auto-allocation fails with ' +
          '"No storefront-synced warehouses available for sale" on every imported order.',
      )
    }

    // --- order status filter
    // wc_sync_order_statuses gates which WC statuses import at all; absent means the
    // harness's `processing` orders match nothing and vanish without explanation.
    const statuses = await db.query<{ value: string }>(
      `select value from settings where key = 'wc_sync_order_statuses'`,
    )
    if (!statuses.rows.length) {
      problems.push(`wc_sync_order_statuses is not set — imports have no status filter to match.`)
    } else if (!statuses.rows[0].value.includes('processing')) {
      problems.push(
        `wc_sync_order_statuses is ${statuses.rows[0].value} and does not include "processing", which ` +
          `is what the harness creates — orders would be silently skipped.`,
      )
    }

    if (!process.env.STAGE_DATABASE_URL) {
      problems.push('STAGE_DATABASE_URL is not set — the quiesce lock cannot disable stage, so stage would race this run.')
    }
  } finally {
    await db.end()
  }

  return { ok: problems.length === 0, problems, warnings }
}

/** Throw a single, readable error listing everything wrong. */
export async function assertPreflight(): Promise<void> {
  const r = await preflight()
  // Warnings are checks that could not RUN (no systemd, no git), not checks that passed.
  // Say so out loud: silently degrading to "fine" is how a guard stops guarding.
  for (const w of r.warnings) console.warn(`[preflight] WARNING: ${w}`)
  if (!r.ok) {
    throw new Error(`Full-chain preflight FAILED:\n  - ${r.problems.join('\n  - ')}`)
  }
}
