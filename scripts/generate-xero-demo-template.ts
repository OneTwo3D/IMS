/**
 * Regenerate scripts/xero-demo-template.json from a configured IMS instance.
 *
 * The Xero Demo company resets roughly every 4 weeks and loses all custom setup,
 * so provision-xero-demo.ts rebuilds it from a committed template. This script
 * produces that template by snapshotting a known-good instance (stage) — a
 * snapshot rather than a live read, so provisioning stays deterministic and
 * reviewable in git, and does not depend on stage being up or correctly configured
 * at the moment you need to rebuild.
 *
 *   Refresh the template:
 *     ./node_modules/.bin/tsx scripts/generate-xero-demo-template.ts \
 *       --source-db postgresql://…/onetwo3d_ims_dev > scripts/xero-demo-template.json
 *
 * Reads only. Writes JSON to stdout; diagnostics go to stderr so the output pipes
 * cleanly.
 */
import { Client } from 'pg'

type Template = {
  $comment: string[]
  generatedFrom: string
  currencies: Array<{ code: string; name: string }>
  accounts: Array<{ code: string; name: string; type: string }>
  bankAccounts: Array<{ name: string; currencyCode: string }>
  taxRates: Array<{
    name: string
    // Inputs to xeroReportTaxType() — Xero REQUIRES a ReportTaxType when creating a
    // custom rate ("A validation exception occurred: The report tax type is
    // required"). We snapshot the inputs rather than the computed value so the
    // provisioner runs the same operator-confirmed mapper the app uses, and any
    // later correction to that mapper flows through without regenerating.
    reportingCategory: string | null
    usedFor: string | null
    rate: number
    components: Array<{ name: string; rate: number; isCompound: boolean }>
  }>
  settingAccountMap: Record<string, string>
}

// GL accounts the IMS actually posts to — the value of every xero_*_account
// setting. Anything else in the Demo chart is Xero's own default and does not
// need provisioning, so the template stays small and reviewable rather than
// carrying all 102 accounts.
const MAPPED_ACCOUNT_SETTINGS = [
  'xero_sales_account',
  'xero_shipping_account',
  'xero_discount_account',
  'xero_cogs_account',
  'xero_inventory_account',
  'xero_inventory_revaluation_account',
  'xero_allocated_inventory_account',
  'xero_unearned_revenue_account',
  'xero_transit_account',
  'xero_accounts_receivable_account',
  'xero_accounts_payable_account',
  'xero_realised_fx_gain_loss_account',
  'xero_unrealised_fx_gain_loss_account',
  'xero_rounding_difference_account',
  'xero_manufacturing_overhead_account',
]

// Stage has accumulated e2e residue in its tax rates (names carrying a
// uniqueSuffix()-style random token, e.g. "UK Incl 2j6uvy"). Those must never
// reach the template or every rebuilt Demo inherits the pollution.
const TEST_RESIDUE_NAME = /\s[a-z0-9]{6}$/

/**
 * Known-bad mappings on the source instance that must NOT propagate into the
 * template. The template describes the configuration we WANT, and stage is only
 * its best available approximation — copying a misconfiguration into every
 * rebuilt Demo would bake the bug in permanently.
 *
 * Applied at generation time (rather than hand-edited into the JSON) so that
 * regenerating from a still-broken stage cannot silently reintroduce them.
 * Delete an entry once the source is fixed; the assertion below fails loudly if
 * a correction becomes a no-op, so this list cannot rot unnoticed.
 */
const SETTING_CORRECTIONS: Array<{
  key: string
  wrong: string
  right: string
  why: string
  issue: string
}> = [
  {
    key: 'xero_allocated_inventory_account',
    wrong: '632',
    right: '633',
    why:
      'Stage maps allocated inventory onto 632 "Stock in Transit", the same account as ' +
      'xero_transit_account. transit-gl-reconciliation.ts assumes the transit account is moved by ' +
      'exactly 8 enumerated purchasing streams; the daily batch also codes allocated inventory ' +
      '(daily-sync.ts:462/485), so sharing the account makes the transit reconciliation flag a ' +
      'material gap on any window with sales — i.e. gate 6oyu.4.1 could never pass. 633 ' +
      '"Allocated Stock" already exists and is unused.',
    issue: 'o3d-f82',
  },
]

// Accounts the template must contain even though no setting on the SOURCE points
// at them — because a correction above now points at them.
const CORRECTION_ACCOUNTS: Array<{ code: string; name: string; type: string }> = [
  { code: '633', name: 'Allocated Stock', type: 'CURRENT' },
]

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const sourceDb = arg('--source-db') ?? process.env.SOURCE_DATABASE_URL
  if (!sourceDb) throw new Error('Pass --source-db <postgres-url> (or set SOURCE_DATABASE_URL)')

  const db = new Client({ connectionString: sourceDb })
  await db.connect()

  const settings = new Map<string, string>(
    (await db.query<{ key: string; value: string }>(
      `select key, value from settings where key = any($1)`,
      [MAPPED_ACCOUNT_SETTINGS],
    )).rows.map((r) => [r.key, r.value]),
  )

  for (const c of SETTING_CORRECTIONS) {
    const actual = settings.get(c.key)
    if (actual !== c.wrong) {
      throw new Error(
        `Correction for ${c.key} is stale: expected the source to still hold the known-bad ` +
          `"${c.wrong}" but found "${actual ?? '(unset)'}". If ${c.issue} has been fixed at the ` +
          `source, delete this entry from SETTING_CORRECTIONS. Refusing to guess.`,
      )
    }
    console.error(`correcting ${c.key}: ${c.wrong} -> ${c.right} (${c.issue})`)
    settings.set(c.key, c.right)
  }

  const wantedCodes = [...settings.values()].filter((v) => v && v.trim() !== '')

  const accounts = (await db.query<{ code: string; name: string; type: string }>(
    `select code, name, type from accounting_accounts
      where code = any($1) and type <> 'BANK' order by code`,
    [wantedCodes],
  )).rows

  // A corrected mapping may point at an account the source never used, so it has
  // no accounting_accounts row to snapshot — supply it from the correction spec.
  for (const extra of CORRECTION_ACCOUNTS) {
    if (wantedCodes.includes(extra.code) && !accounts.some((a) => a.code === extra.code)) {
      accounts.push(extra)
      console.error(`adding correction account ${extra.code} ${extra.name} (absent from source)`)
    }
  }
  accounts.sort((a, b) => a.code.localeCompare(b.code))

  const missing = wantedCodes.filter((c) => !accounts.some((a) => a.code === c))
  if (missing.length) {
    console.error(`WARNING: mapped codes with no account row: ${missing.join(', ')}`)
  }

  // Bank accounts carry NO code in Xero, so they can only be matched by name.
  const bankRows = (await db.query<{ name: string }>(
    `select name from accounting_accounts where type = 'BANK' and coalesce(code,'') = '' order by name`,
  )).rows
  const bankAccounts = bankRows.map((r) => {
    const m = r.name.match(/\(([A-Z]{3})\)\s*$/)
    return { name: r.name, currencyCode: m ? m[1] : 'GBP' }
  })

  const currencies = (await db.query<{ code: string; name: string }>(
    `select code, name from currencies where active order by code`,
  )).rows

  // Only ACTIVE, non-residue rates. accounting_tax_type is deliberately NOT
  // captured: Xero mints those ids itself on creation, so a snapshot of them is
  // meaningless after a reset — the provisioner records what Xero returns.
  const rateRows = (await db.query<{
    id: string
    name: string
    rate: string
    reporting_category: string | null
    usedFor: string | null
  }>(
    `select id, name, rate, reporting_category, "usedFor" from tax_rates where active order by name`,
  )).rows
  const taxRates: Template['taxRates'] = []
  for (const r of rateRows) {
    if (TEST_RESIDUE_NAME.test(r.name)) {
      console.error(`skipping e2e residue tax rate: ${r.name}`)
      continue
    }
    const comps = (await db.query<{ name: string; rate: string; compound_on_previous: boolean }>(
      `select name, rate, compound_on_previous from tax_rate_components
        where tax_rate_id = $1 and active order by sort_order, name`,
      [r.id],
    )).rows
    taxRates.push({
      name: r.name,
      reportingCategory: r.reporting_category,
      usedFor: r.usedFor,
      rate: Number(r.rate),
      // Fall back to a single component from the header rate: some rates carry no
      // component rows, and Xero requires at least one TaxComponent per TaxRate.
      components: comps.length
        ? comps.map((c) => ({ name: c.name, rate: Number(c.rate), isCompound: c.compound_on_previous }))
        : [{ name: r.name, rate: Number(r.rate), isCompound: false }],
    })
  }

  const settingAccountMap = Object.fromEntries(
    MAPPED_ACCOUNT_SETTINGS.map((k) => [k, settings.get(k) ?? '']).filter(([, v]) => v !== ''),
  )

  const template: Template = {
    $comment: [
      'Declarative spec of what the Xero Demo company must contain for the full-chain e2e suite.',
      'Applied idempotently by scripts/provision-xero-demo.ts after each ~4-weekly Demo reset.',
      'Regenerate with scripts/generate-xero-demo-template.ts --source-db <url>.',
      'Tax-rate TaxType ids are intentionally absent: Xero assigns them on creation, so any',
      'snapshot of them is stale the moment the Demo resets. The provisioner writes back whatever',
      'Xero returns.',
    ],
    generatedFrom: sourceDb.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@'),
    currencies,
    accounts,
    bankAccounts,
    taxRates,
    settingAccountMap,
  }

  await db.end()
  process.stdout.write(JSON.stringify(template, null, 2) + '\n')
  console.error(
    `\ntemplate: ${currencies.length} currencies, ${accounts.length} accounts, ` +
      `${bankAccounts.length} bank accounts, ${taxRates.length} tax rates`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
