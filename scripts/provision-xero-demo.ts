/**
 * Rebuild a Xero Demo company to the state the full-chain e2e suite needs
 * (o3d-lgo.9): currencies, GL accounts, bank accounts, VAT rates — then map the
 * resulting codes into this instance's settings.
 *
 * WHY THIS EXISTS: the Xero Demo company resets roughly every 4 weeks and loses
 * every customisation, so without this the rig needs a long manual rebuild on a
 * recurring basis and drifts from stage in ways nobody notices until a test
 * asserts the wrong account.
 *
 * RUN IT LIKE THIS (from the e2e instance's workspace, as the `ims` user):
 *
 *   NODE_OPTIONS='--import tsx' node --env-file=.env scripts/provision-xero-demo.ts --dry-run
 *   NODE_OPTIONS='--import tsx' node --env-file=.env scripts/provision-xero-demo.ts
 *
 * The `--env-file` is not optional and `tsx script.ts` will NOT do: env must be
 * populated before this module's imports are evaluated, because they pull in the
 * db singleton, which reads DATABASE_URL at construction. Get it wrong and the
 * failure is the opaque `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must
 * be a string`, not a missing-env message.
 *
 * IDEMPOTENT: every step reads Xero first and creates only what is missing, so it
 * is safe to re-run after each reset (and safe to re-run when nothing changed).
 *
 * THE ~4-WEEKLY RESET CYCLE. When the Demo company resets it is re-created with a
 * NEW tenantId, and every custom account, bank account, currency and tax rate is
 * gone. Recovery:
 *
 *   1. NODE_OPTIONS='--import tsx' node --env-file=.env \
 *        scripts/provision-xero-demo.ts --clear-tenant-pin
 *      The pin is ENFORCED on connect (selectTenantConnection() matches on
 *      tenantId), so a pin left over from the previous Demo makes the reconnect
 *      find no tenant. Clearing it first is not optional.
 *   2. A human re-consents at <public_app_url>/sync?connector=xero and picks
 *      "Demo Company (UK)". OAuth is interactive; it cannot be scripted.
 *   3. Re-run this script normally. It rebuilds the org and RE-PINS the new
 *      tenantId automatically.
 *
 * SAFETY: refuses to run unless the connected tenant is literally
 * 'Demo Company (UK)', re-read live from GET /Organisation — a stale token row is
 * not enough. The tenant is resolved BY NAME, never by a stored id
 * (xero_expected_tenant_id was observed changing e7fb4378… -> 5c949ed5… within a
 * single day). The pin is still kept and refreshed: it is what stops this rig ever
 * connecting to a PRODUCTION Xero org, and it is only ever written after the live
 * name check passes. It also refuses to run against the stage database.
 *
 * TAX RATES ARE THE SUBTLE PART. The TAX001…TAXnnn values in
 * tax_rates.accounting_tax_type are ids Xero ASSIGNS to custom rates in creation
 * order. A reset wipes them; re-creating mints new ids, so any snapshot of the
 * id→rate mapping is worthless and, worse, silently points at the wrong VAT rate.
 * This script therefore creates each rate BY NAME, takes the TaxType Xero returns,
 * and writes that back to tax_rates.accounting_tax_type.
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { xeroGet, xeroPost, xeroPut } from '../lib/connectors/xero/api.ts'
import { syncChartOfAccounts } from '../lib/connectors/xero/accounts.ts'
import { xeroReportTaxType } from '../lib/connectors/xero/tax-rate-report-type.ts'

const REQUIRED_TENANT = 'Demo Company (UK)'
const TEMPLATE_PATH = new URL('./xero-demo-template.json', import.meta.url).pathname
const DRY_RUN = process.argv.includes('--dry-run')
const CLEAR_TENANT_PIN = process.argv.includes('--clear-tenant-pin')
// Remap-only: re-point tax_rates.accounting_tax_type at the ids the LIVE org
// actually uses, matching by name. Creates nothing, writes no settings, moves no
// tenant pin — so unlike a full provision it is safe against ANY instance that
// shares the Demo org, including stage (o3d-g4r).
const REMAP_ONLY = process.argv.includes('--remap-only')

type Template = {
  currencies: Array<{ code: string; name: string }>
  accounts: Array<{ code: string; name: string; type: string }>
  bankAccounts: Array<{ name: string; currencyCode: string }>
  taxRates: Array<{
    name: string
    reportingCategory: string | null
    usedFor: string | null
    rate: number
    components: Array<{ name: string; rate: number; isCompound: boolean }>
  }>
  settingAccountMap: Record<string, string>
}

type XeroAccount = { AccountID: string; Code?: string; Name: string; Type: string; Status: string }
type XeroTaxRate = { Name: string; TaxType: string; Status: string }
type XeroCurrency = { Code: string }

const created: string[] = []
const skipped: string[] = []

function log(msg: string) {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}${msg}`)
}

async function guardTenant(db: Client) {
  const url = process.env.DATABASE_URL ?? ''
  if (url.includes('onetwo3d_ims_dev') && !REMAP_ONLY) {
    throw new Error(
      'ABORT: DATABASE_URL points at the STAGE database (onetwo3d_ims_dev). A full provision ' +
        'creates accounts and rewrites settings — run it from the e2e instance only. ' +
        'If you meant to repair stale tax-type ids after a Demo reset, use --remap-only, ' +
        'which creates nothing and touches only tax_rates.accounting_tax_type.',
    )
  }

  const tok = await db.query<{ tenantName: string; tenantId: string }>(
    `select "tenantName", "tenantId" from accounting_tokens where connector = 'xero'`,
  )
  if (!tok.rows.length) throw new Error('ABORT: no Xero connection on this instance. Connect it first.')
  const { tenantName, tenantId } = tok.rows[0]
  if (tenantName !== REQUIRED_TENANT) {
    throw new Error(`ABORT: connected tenant is "${tenantName}", not "${REQUIRED_TENANT}". Refusing to provision.`)
  }

  // Confirm the token actually works AND that the live org agrees with the stored
  // name — a stale row must not be enough to unlock a write path.
  const org = await xeroGet<{ Organisations: Array<{ Name: string; BaseCurrency: string }> }>('Organisation')
  if (!org.ok || !org.data?.Organisations?.length) {
    throw new Error(`ABORT: could not read Organisation from Xero: ${org.error ?? 'unknown error'}`)
  }
  const live = org.data.Organisations[0]
  if (live.Name !== REQUIRED_TENANT) {
    throw new Error(`ABORT: live Xero org is "${live.Name}", not "${REQUIRED_TENANT}".`)
  }
  log(`tenant OK: ${live.Name} (${tenantId}), base currency ${live.BaseCurrency}`)

  // Re-pin from the LIVE connection every run. The Demo company resets ~4-weekly
  // and is re-created with a NEW tenantId, so a pin captured on a previous run goes
  // stale by design. That matters because the pin is ENFORCED on connect:
  // selectXeroTenant() (lib/connectors/xero/tenant-guard.ts) refuses a consent that
  // does not offer the pinned organisation, so a stale pin makes the next reconnect
  // fail — the safety feature locks you out of the very org it is protecting. The
  // callback now writes the pin and the token together in one transaction, so this
  // only ever re-asserts a value that already matches the stored token's tenantId; it
  // is kept because --clear-tenant-pin exists and a half-provisioned rig may have
  // neither. Re-pinning here keeps it correct without weakening it: we
  // only reach this line after asserting the LIVE org name is REQUIRED_TENANT, so
  // the pin can never be moved onto a production org.
  // Never move another instance's pin: --remap-only may target stage.
  if (!DRY_RUN && !REMAP_ONLY) {
    await db.query(
      `insert into settings (key, value, "updatedAt") values ('xero_expected_tenant_id', $1, now())
         on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
      [tenantId],
    )
    log(`tenant pin refreshed -> ${tenantId}`)
  }

  return live.BaseCurrency
}

/**
 * Re-point this instance's tax_rates.accounting_tax_type at the ids the LIVE org
 * uses, matching on NAME. Creates nothing.
 *
 * Needed because Xero mints TAX001..TAXnnn for custom rates in CREATION ORDER: a
 * ~4-weekly Demo reset destroys them, and re-creating them in a different order
 * leaves stored ids resolving to a VALID BUT WRONG rate — i.e. invoices post with
 * the wrong VAT, silently (o3d-g4r: 30/35 of stage's mappings were wrong).
 */
async function remapOnly(db: Client) {
  const live = await xeroGet<{ TaxRates: Array<{ Name: string; TaxType: string; Status: string }> }>('TaxRates')
  if (!live.ok) throw new Error(`Could not read TaxRates: ${live.error}`)
  const byName = new Map(
    (live.data?.TaxRates ?? []).filter((r) => r.Status === 'ACTIVE').map((r) => [r.Name, r.TaxType]),
  )

  // "active" is NOT the right test for "needs a Xero mapping" (o3d-6ec).
  //
  // A storefront mapping can point at an INACTIVE rate, and resolveWcTaxRateById
  // (field-mapping.ts:315) returns whatever the mapping names WITHOUT filtering on active —
  // so that rate is used to tax real orders. Scoping the remap to active rates therefore
  // left every such rate with a null accounting_tax_type, and the invoice posts to Xero with
  // no TaxType at all. Both instances map WC rate 112 to "UK Standard Rate (20%)", which is
  // inactive: on the e2e rig that left 33 of 65 WC mappings resolving to no Xero type.
  //
  // A rate needs a mapping if it is active OR if a storefront mapping points at it.
  const rows = (await db.query<{ name: string; accounting_tax_type: string | null }>(
    `select name, accounting_tax_type from tax_rates
      where active
         or id in (select "taxRateId" from shopping_tax_rate_mappings)
      order by name`,
  )).rows

  // Only CUSTOM ids rot. Xero mints TAX001..TAXnnn per-org in creation order, so a
  // reset invalidates them. Its BUILT-IN types (OUTPUT2, RRINPUT, ZERORATEDOUTPUT,
  // EXEMPTOUTPUT, NONE…) are stable across orgs and resets, so a mapping onto one is
  // correct and must be left alone — matching those by NAME would drag them onto a
  // same-named CUSTOM rate this template creates (e.g. IMS "UK VAT" is deliberately
  // mapped to the built-in OUTPUT2, whose Xero name is "20% (VAT on Income)"), which
  // would silently change posting behaviour rather than repair it.
  // Three cases, and conflating them is a real bug: an UNSET mapping needs one
  // (a freshly copied rate has none), a TAX0nn may have rotted, and a built-in is
  // already right.
  const isCustomId = (t: string | null) => !!t && /^TAX\d+$/.test(t)
  const isUnset = (t: string | null) => !t || t.trim() === ''

  let fixed = 0, already = 0, unmatched = 0, builtin = 0
  for (const r of rows) {
    if (!isUnset(r.accounting_tax_type) && !isCustomId(r.accounting_tax_type)) {
      builtin++
      continue
    }
    const liveType = byName.get(r.name)
    if (!liveType) {
      unmatched++
      console.warn(`  ! "${r.name}" has no ACTIVE rate of that name in Xero — left as ${r.accounting_tax_type ?? '(unset)'}`)
      continue
    }
    if (liveType === r.accounting_tax_type) { already++; continue }
    log(`  ${r.name}: ${r.accounting_tax_type ?? '(unset)'} -> ${liveType}`)
    if (!DRY_RUN) {
      await db.query(
        `update tax_rates set accounting_tax_type = $1, "updatedAt" = now() where name = $2`,
        [liveType, r.name],
      )
    }
    fixed++
  }
  console.log(`\n--- remap summary ---`)
  console.log(`  corrected          : ${fixed}`)
  console.log(`  already correct    : ${already}`)
  console.log(`  built-in, untouched: ${builtin}  (stable across resets — not remapped by design)`)
  console.log(`  unmatched          : ${unmatched}${unmatched ? '  <-- these cannot post until the rate exists in Xero' : ''}`)
  if (DRY_RUN) console.log('\nDRY RUN — nothing was written.')
}

/**
 * Clear the tenant pin so a human can re-consent after a Demo reset.
 * Needed because the pin is enforced on connect against a tenantId that no longer
 * exists; without clearing it the reconnect silently finds no tenant.
 */
async function clearTenantPin(db: Client) {
  const before = await db.query<{ value: string }>(
    `select value from settings where key = 'xero_expected_tenant_id'`,
  )
  if (!before.rows.length) {
    console.log('tenant pin already absent — nothing to clear.')
  } else {
    await db.query(`delete from settings where key = 'xero_expected_tenant_id'`)
    console.log(`cleared stale tenant pin (was ${before.rows[0].value}).`)
  }
  console.log(
    '\nNext: reconnect at <public_app_url>/sync?connector=xero, choose "Demo Company (UK)",\n' +
      'then re-run this script WITHOUT --clear-tenant-pin to rebuild the org and re-pin.',
  )
}

async function ensureCurrencies(t: Template, baseCurrency: string) {
  const res = await xeroGet<{ Currencies: XeroCurrency[] }>('Currencies')
  if (!res.ok) throw new Error(`Could not read Currencies: ${res.error}`)
  const have = new Set((res.data?.Currencies ?? []).map((c) => c.Code))

  for (const c of t.currencies) {
    if (have.has(c.code)) { skipped.push(`currency ${c.code}`); continue }
    if (c.code === baseCurrency) { skipped.push(`currency ${c.code} (base)`); continue }
    log(`creating currency ${c.code} (${c.name})`)
    if (DRY_RUN) { created.push(`currency ${c.code}`); continue }
    // Currencies is GET/PUT only — POST 404s (not 405, which is why that failure
    // reads as "Unknown error" rather than method-not-allowed). The body is a bare
    // object: wrapping it as {Currencies:[...]} parses but yields
    // "A validation exception occurred: A currency code must be provided."
    const r = await xeroPut('Currencies', { Code: c.code })
    if (!r.ok) throw new Error(`Failed to create currency ${c.code}: ${r.error}`)
    created.push(`currency ${c.code}`)
  }
}

async function ensureAccounts(t: Template) {
  const res = await xeroGet<{ Accounts: XeroAccount[] }>('Accounts')
  if (!res.ok) throw new Error(`Could not read Accounts: ${res.error}`)
  const live = res.data?.Accounts ?? []

  for (const a of t.accounts) {
    const existing = live.find((x) => x.Code === a.code)
    if (existing) {
      if (existing.Name !== a.name) {
        // Don't rename: a code the template wants but pointing at something else is
        // a real conflict the operator must see, not something to silently coerce.
        console.warn(
          `WARNING: account ${a.code} exists as "${existing.Name}" but the template expects ` +
            `"${a.name}". Leaving it alone — reconcile this by hand.`,
        )
      }
      skipped.push(`account ${a.code}`)
      continue
    }
    log(`creating account ${a.code} ${a.name} (${a.type})`)
    if (DRY_RUN) { created.push(`account ${a.code}`); continue }
    // PUT is Xero's create verb for Accounts (POST is update).
    const r = await xeroPut('Accounts', { Code: a.code, Name: a.name, Type: a.type })
    if (!r.ok) throw new Error(`Failed to create account ${a.code}: ${r.error}`)
    created.push(`account ${a.code}`)
  }
}

async function ensureBankAccounts(t: Template) {
  const res = await xeroGet<{ Accounts: XeroAccount[] }>('Accounts?where=Type%3D%3D%22BANK%22')
  if (!res.ok) throw new Error(`Could not read bank Accounts: ${res.error}`)
  const live = res.data?.Accounts ?? []

  for (const b of t.bankAccounts) {
    if (live.some((x) => x.Name === b.name)) { skipped.push(`bank ${b.name}`); continue }
    log(`creating bank account ${b.name} [${b.currencyCode}]`)
    if (DRY_RUN) { created.push(`bank ${b.name}`); continue }
    // Bank accounts carry no Code in this org (they are matched by name), and Xero
    // requires a BankAccountNumber — derive a stable, obviously-synthetic one.
    const r = await xeroPut('Accounts', {
      Name: b.name,
      Type: 'BANK',
      BankAccountNumber: `E2E${b.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`.slice(0, 30),
      CurrencyCode: b.currencyCode,
    })
    if (!r.ok) throw new Error(`Failed to create bank account ${b.name}: ${r.error}`)
    created.push(`bank ${b.name}`)
  }
}

/**
 * Create each rate by name and record the TaxType Xero returns.
 * Returns name -> TaxType for every template rate (existing or created).
 */
async function ensureTaxRates(t: Template): Promise<Map<string, string>> {
  const res = await xeroGet<{ TaxRates: XeroTaxRate[] }>('TaxRates')
  if (!res.ok) throw new Error(`Could not read TaxRates: ${res.error}`)
  const live = res.data?.TaxRates ?? []
  const resolved = new Map<string, string>()

  for (const r of t.taxRates) {
    const existing = live.find((x) => x.Name === r.name && x.Status === 'ACTIVE')
    if (existing) {
      resolved.set(r.name, existing.TaxType)
      skipped.push(`taxrate ${r.name}`)
      continue
    }
    log(`creating tax rate ${r.name} (${r.components.map((c) => `${c.rate * 100}%`).join('+')}) -> ${xeroReportTaxType({ reportingCategory: r.reportingCategory, usedFor: r.usedFor, name: r.name, rate: r.rate })}`)
    // Count before the dry-run bail: a dry run that under-reports what it would
    // create is worse than none — the first version said "created: 15" for a run
    // that would in fact have created 50.
    created.push(`taxrate ${r.name}`)
    if (DRY_RUN) continue
    // Xero REQUIRES ReportTaxType on a custom rate ("The report tax type is
    // required"). Derive it with the app's own operator-confirmed, unit-tested
    // mapper rather than inventing a VAT-return box here — it encodes real
    // decisions (EU/VOEC distance sales -> MOSSSALES, reverse charge wins, Xero
    // rejects NONE and rejects EXEMPT with a non-zero component).
    const reportTaxType = xeroReportTaxType({
      reportingCategory: r.reportingCategory,
      usedFor: r.usedFor,
      name: r.name,
      rate: r.rate,
    })
    const payload = {
      TaxRates: [
        {
          Name: r.name,
          ReportTaxType: reportTaxType,
          TaxComponents: r.components.map((c) => ({
            Name: c.name,
            Rate: Math.round(c.rate * 100 * 10000) / 10000,
            IsCompound: c.isCompound || undefined,
          })),
          Status: 'ACTIVE',
        },
      ],
    }
    const post = await xeroPost<{ TaxRates: Array<{ TaxType: string; Name: string }> }>('TaxRates', payload)
    if (!post.ok || !post.data?.TaxRates?.length) {
      throw new Error(`Failed to create tax rate ${r.name}: ${post.error}`)
    }
    resolved.set(r.name, post.data.TaxRates[0].TaxType)
  }
  return resolved
}

/** Point tax_rates.accounting_tax_type at the ids Xero actually assigned. */
async function remapTaxTypes(db: Client, resolved: Map<string, string>) {
  let changed = 0
  for (const [name, taxType] of resolved) {
    const r = await db.query(
      `update tax_rates set accounting_tax_type = $1, "updatedAt" = now()
        where name = $2 and coalesce(accounting_tax_type,'') <> $1`,
      [taxType, name],
    )
    if (r.rowCount) { changed += r.rowCount; log(`remapped tax rate "${name}" -> ${taxType}`) }
  }
  log(`tax type remap: ${changed} row(s) updated`)
}

async function applySettings(db: Client, t: Template) {
  for (const [key, value] of Object.entries(t.settingAccountMap)) {
    if (DRY_RUN) { log(`would set ${key}=${value}`); continue }
    await db.query(
      `insert into settings (key, value, "updatedAt") values ($1, $2, now())
         on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
      [key, value],
    )
    log(`set ${key}=${value}`)
  }
}

async function main() {
  const t: Template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'))
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    if (CLEAR_TENANT_PIN) {
      await clearTenantPin(db)
      return
    }
    const baseCurrency = await guardTenant(db)
    if (REMAP_ONLY) {
      await remapOnly(db)
      return
    }
    await ensureCurrencies(t, baseCurrency)
    await ensureAccounts(t)
    await ensureBankAccounts(t)
    // Populate the LOCAL chart-of-accounts cache (accounting_accounts) from Xero, after the accounts and
    // bank accounts exist so the cache captures them. The payment processor resolves a bankAccountId
    // against this table and the Pay Bill UI lists bank accounts from it (listStoredBankAccounts); an
    // unpopulated cache makes INVOICE_PAYMENT/BILL_PAYMENT fail "Bank account not found in synced Xero
    // chart of accounts". The Demo resets ~4-weekly, so this must run every provision, not once. (o3d-lgo.12)
    if (DRY_RUN) {
      log('DRY RUN — would sync the Xero chart of accounts into the local accounting_accounts cache')
    } else {
      const chart = await syncChartOfAccounts()
      log(`synced ${chart.synced} account(s) into the local chart-of-accounts cache${chart.errors.length ? ` (${chart.errors.length} error(s))` : ''}`)
    }
    const resolved = await ensureTaxRates(t)
    if (!DRY_RUN) {
      await remapTaxTypes(db, resolved)
      await applySettings(db, t)
    } else {
      await applySettings(db, t)
    }

    console.log(`\n--- summary ---`)
    console.log(`created: ${created.length}`)
    for (const c of created) console.log(`  + ${c}`)
    console.log(`already present: ${skipped.length}`)
    if (DRY_RUN) console.log(`\nDRY RUN — nothing was written.`)
  } finally {
    await db.end()
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
