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
 * SAFETY: refuses to run unless the connected tenant is literally
 * 'Demo Company (UK)'. The tenant is resolved BY NAME, never by a stored id —
 * xero_expected_tenant_id was observed changing (e7fb4378… -> 5c949ed5…) when the
 * Demo was reconnected, so a hardcoded id silently targets nothing after a reset.
 * It also refuses to run against the stage database: this writes settings.
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
import { xeroGet, xeroPost } from '../lib/connectors/xero/api.ts'

const REQUIRED_TENANT = 'Demo Company (UK)'
const TEMPLATE_PATH = new URL('./xero-demo-template.json', import.meta.url).pathname
const DRY_RUN = process.argv.includes('--dry-run')

type Template = {
  currencies: Array<{ code: string; name: string }>
  accounts: Array<{ code: string; name: string; type: string }>
  bankAccounts: Array<{ name: string; currencyCode: string }>
  taxRates: Array<{ name: string; components: Array<{ name: string; rate: number; isCompound: boolean }> }>
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
  if (url.includes('onetwo3d_ims_dev')) {
    throw new Error(
      'ABORT: DATABASE_URL points at the STAGE database (onetwo3d_ims_dev). This script writes ' +
        'settings and remaps tax types — run it from the e2e instance only.',
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
  return live.BaseCurrency
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
    const r = await xeroPost('Currencies', { Currencies: [{ Code: c.code }] })
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
    const r = await xeroPost('Accounts', { Code: a.code, Name: a.name, Type: a.type })
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
    const r = await xeroPost('Accounts', {
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
    log(`creating tax rate ${r.name} (${r.components.map((c) => `${c.rate * 100}%`).join('+')})`)
    if (DRY_RUN) continue
    const payload = {
      TaxRates: [
        {
          Name: r.name,
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
    created.push(`taxrate ${r.name}`)
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
      `insert into settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value`,
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
    const baseCurrency = await guardTenant(db)
    await ensureCurrencies(t, baseCurrency)
    await ensureAccounts(t)
    await ensureBankAccounts(t)
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
