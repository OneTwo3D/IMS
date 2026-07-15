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

const REQUIRED_TENANT = 'Demo Company (UK)'

export type PreflightReport = { ok: true } | { ok: false; problems: string[] }

export async function preflight(): Promise<PreflightReport> {
  const problems: string[] = []
  const url = process.env.DATABASE_URL ?? ''

  if (!url) return { ok: false, problems: ['DATABASE_URL is not set.'] }
  if (url.includes('onetwo3d_ims_dev')) {
    return {
      ok: false,
      problems: [
        'DATABASE_URL points at the STAGE database (onetwo3d_ims_dev). The full-chain suite ' +
          'creates orders, posts journals and rewrites settings — it must only ever run against ' +
          'the e2e instance.',
      ],
    }
  }

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
      const org = await xeroGet<{ Organisations: Array<{ Name: string; BaseCurrency: string }> }>('Organisation')
      if (!org.ok || !org.data?.Organisations?.length) {
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
    const unmapped = await db.query<{ count: string }>(
      `select count(*)::text as count from tax_rates
        where active and (accounting_tax_type is null or accounting_tax_type = '')`,
    )
    if (unmapped.rows[0].count !== '0') {
      problems.push(
        `${unmapped.rows[0].count} active tax rate(s) have no accounting_tax_type. ` +
          `Run: provision-xero-demo.ts --remap-only.`,
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

  return problems.length ? { ok: false, problems } : { ok: true }
}

/** Throw a single, readable error listing everything wrong. */
export async function assertPreflight(): Promise<void> {
  const r = await preflight()
  if (!r.ok) {
    throw new Error(`Full-chain preflight FAILED:\n  - ${r.problems.join('\n  - ')}`)
  }
}
