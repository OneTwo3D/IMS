/**
 * Copy tax rates (+ their components) from a source IMS instance into this one.
 *
 * The full-chain e2e rig needs the SAME tax rates as stage or its tax scenarios are
 * meaningless: the base seed (prisma/seed.ts) creates only 4 rates, while stage runs
 * 35 active (EU OSS set + UK). Without them OC-10 (foreign currency) and OC-14
 * (mixed rates per line) cannot be written honestly.
 *
 *   NODE_OPTIONS='--import tsx' node --env-file=.env scripts/copy-tax-rates.ts \
 *     --source-db postgresql://…/onetwo3d_ims_dev [--dry-run]
 *
 * accounting_tax_type is deliberately NOT copied: those TAX001..TAXnnn ids are
 * per-org and per-creation-order, so copying them would import a mapping that is
 * wrong for this instance's view of the org. Run
 * `provision-xero-demo.ts --remap-only` afterwards to resolve them by NAME from the
 * live org — that is the only trustworthy source.
 *
 * Idempotent: matches on name, updates in place, inserts what is missing.
 */
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

const DRY_RUN = process.argv.includes('--dry-run')

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

type Rate = {
  id: string
  name: string
  rate: string
  type: string
  countryCode: string | null
  active: boolean
  isDefault: boolean
  usedFor: string | null
  taxCategory: string | null
  is_compound: boolean
  reverse_charge: boolean
  reporting_category: string | null
}
type Component = {
  name: string
  rate: string
  compound_on_previous: boolean
  sort_order: number | null
  active: boolean
}

async function main() {
  const sourceDb = arg('--source-db') ?? process.env.SOURCE_DATABASE_URL
  if (!sourceDb) throw new Error('Pass --source-db <postgres-url>')
  const targetUrl = process.env.DATABASE_URL
  if (!targetUrl) throw new Error('DATABASE_URL not set — run with node --env-file=.env')
  if (targetUrl === sourceDb) throw new Error('ABORT: source and target are the same database.')
  if (targetUrl.includes('onetwo3d_ims_dev')) {
    throw new Error('ABORT: target is the STAGE database. This copies INTO an instance; stage is the source.')
  }

  const src = new Client({ connectionString: sourceDb })
  const dst = new Client({ connectionString: targetUrl })
  await src.connect(); await dst.connect()
  try {
    const rates = (await src.query<Rate>(
      `select id, name, rate, type::text as type, "countryCode", active, "isDefault", "usedFor",
              "taxCategory"::text as "taxCategory", is_compound, reverse_charge, reporting_category
         from tax_rates order by name`,
    )).rows

    let inserted = 0, updated = 0, comps = 0
    for (const r of rates) {
      const existing = await dst.query<{ id: string }>(`select id from tax_rates where name = $1`, [r.name])
      const id = existing.rows[0]?.id ?? randomUUID()
      const isNew = existing.rows.length === 0

      if (!DRY_RUN) {
        await dst.query(
          `insert into tax_rates (id, name, rate, type, "countryCode", active, "isDefault", "usedFor",
                                  "taxCategory", is_compound, reverse_charge, reporting_category,
                                  "createdAt", "updatedAt")
             values ($1,$2,$3,$4::"TaxType",$5,$6,$7,$8,$9::"TaxCategory",$10,$11,$12, now(), now())
           on conflict (id) do update set
             rate = excluded.rate, type = excluded.type, "countryCode" = excluded."countryCode",
             active = excluded.active, "isDefault" = excluded."isDefault", "usedFor" = excluded."usedFor",
             "taxCategory" = excluded."taxCategory", is_compound = excluded.is_compound,
             reverse_charge = excluded.reverse_charge, reporting_category = excluded.reporting_category,
             "updatedAt" = now()`,
          [id, r.name, r.rate, r.type, r.countryCode, r.active, r.isDefault, r.usedFor,
           r.taxCategory, r.is_compound, r.reverse_charge, r.reporting_category],
        )
      }
      isNew ? inserted++ : updated++

      const srcComps = (await src.query<Component>(
        `select name, rate, compound_on_previous, sort_order, active
           from tax_rate_components where tax_rate_id = $1 order by sort_order, name`,
        [r.id],
      )).rows
      if (!DRY_RUN) {
        // Replace wholesale: components are a small owned collection, and matching
        // them individually would strand any the source has since removed.
        await dst.query(`delete from tax_rate_components where tax_rate_id = $1`, [id])
        for (const c of srcComps) {
          await dst.query(
            `insert into tax_rate_components (id, tax_rate_id, name, rate, compound_on_previous,
                                              sort_order, active, created_at, updated_at)
               values ($1,$2,$3,$4,$5,$6,$7, now(), now())`,
            [randomUUID(), id, c.name, c.rate, c.compound_on_previous, c.sort_order ?? 0, c.active],
          )
        }
      }
      comps += srcComps.length
    }

    console.log(`${DRY_RUN ? '[dry-run] ' : ''}tax rates: ${inserted} inserted, ${updated} updated; ${comps} components`)
    console.log('\naccounting_tax_type was intentionally NOT copied (per-org, creation-order ids).')
    console.log('Next: NODE_OPTIONS=\'--import tsx\' node --env-file=.env scripts/provision-xero-demo.ts --remap-only')
    if (DRY_RUN) console.log('\nDRY RUN — nothing was written.')
  } finally {
    await src.end(); await dst.end()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : e}`); process.exit(1) })
