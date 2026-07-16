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
 * CUSTOM accounting_tax_type ids (TAX001..TAXnnn) are deliberately NOT copied: they are
 * per-org and per-creation-order, so copying them would import a mapping that is wrong for
 * this instance's view of the org. Run `provision-xero-demo.ts --remap-only` afterwards to
 * resolve those by NAME from the live org — the only trustworthy source.
 *
 * BUILT-IN types (OUTPUT2, ZERORATEDOUTPUT, NONE…) ARE copied, because they mean the same
 * thing in every org and --remap-only cannot resolve them by name (a built-in's Xero name
 * does not match the IMS rate's). Skipping them left rates mapped to built-ins with a NULL
 * tax type, posting to Xero with no TaxType — see XERO_BUILT_IN_TAX_TYPES below (o3d-6ec).
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

/**
 * Xero's BUILT-IN tax types, which are stable across orgs and survive a Demo reset — unlike
 * the CUSTOM TAX001..TAXnnn ids, which are minted per-org in creation order and rot.
 *
 * That distinction is why accounting_tax_type can be copied for these and only these: a
 * built-in means the same thing in every org, so carrying it across is correct rather than a
 * guess. --remap-only cannot resolve them, because it matches on the Xero rate's NAME and a
 * built-in's name does not match the IMS rate's (IMS "UK Standard Rate (20%)" maps to
 * OUTPUT2, whose Xero name is "20% (VAT on Income)"). So without this, any rate mapped to a
 * built-in arrives with a NULL tax type and posts to Xero with no TaxType at all (o3d-6ec).
 */
const XERO_BUILT_IN_TAX_TYPES = new Set([
  'OUTPUT', 'OUTPUT2', 'INPUT', 'INPUT2', 'RRINPUT', 'RROUTPUT',
  'ZERORATEDOUTPUT', 'ZERORATEDINPUT', 'EXEMPTOUTPUT', 'EXEMPTINPUT',
  'NONE', 'GSTONIMPORTS', 'REVERSECHARGES',
  'ECZROUTPUT', 'ECZRINPUT', 'ECOUTPUT', 'ECINPUT', 'ECACQUISITIONS',
])

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
  accounting_tax_type: string | null
}
type Component = {
  name: string
  rate: string
  compound_on_previous: boolean
  sort_order: number | null
  active: boolean
}

/** Copy a tax type only when it is a built-in; custom per-org ids must be re-resolved here. */
function builtInTaxType(value: string | null): string | null {
  return value && XERO_BUILT_IN_TAX_TYPES.has(value) ? value : null
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
              "taxCategory"::text as "taxCategory", is_compound, reverse_charge, reporting_category,
              accounting_tax_type
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
                                  accounting_tax_type, "createdAt", "updatedAt")
             values ($1,$2,$3,$4::"TaxType",$5,$6,$7,$8,$9::"TaxCategory",$10,$11,$12,$13, now(), now())
           on conflict (id) do update set
             rate = excluded.rate, type = excluded.type, "countryCode" = excluded."countryCode",
             active = excluded.active, "isDefault" = excluded."isDefault", "usedFor" = excluded."usedFor",
             "taxCategory" = excluded."taxCategory", is_compound = excluded.is_compound,
             reverse_charge = excluded.reverse_charge, reporting_category = excluded.reporting_category,
             -- coalesce, never clobber: a CUSTOM id already resolved here by --remap-only is
             -- correct for THIS org, and must not be overwritten with the source's (or null).
             accounting_tax_type = coalesce(excluded.accounting_tax_type, tax_rates.accounting_tax_type),
             "updatedAt" = now()`,
          [id, r.name, r.rate, r.type, r.countryCode, r.active, r.isDefault, r.usedFor,
           r.taxCategory, r.is_compound, r.reverse_charge, r.reporting_category,
           builtInTaxType(r.accounting_tax_type)],
        )
      }
      if (isNew) inserted++
      else updated++

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

    // --- the WooCommerce half of the mapping (o3d-6ec)
    //
    // Copying the rates alone left this script half-finished, and the half it skipped is the
    // one that fails SILENTLY. A tax rate has two mappings: accounting_tax_type points at
    // Xero, and shopping_tax_rate_mappings points at the WooCommerce rate id. This script
    // copied neither — but Xero's is resolved afterwards by --remap-only, while nothing
    // resolved Woo's, so the e2e rig ran with 0 of 65 WC rates mapped.
    //
    // What that costs: resolveWcTaxRateById falls back to fallbackDefaultTaxRate for an
    // unmapped rate, which returns 0% VAT with a null tax type and no error at all.
    // WooCommerce charges 20%, the IMS records 0%, nothing complains. The existing
    // full-chain tests cannot see it because their orders carry no tax lines — so the rig
    // was unable to catch a VAT bug, which is exactly what OC-14 above claims this script
    // makes possible.
    //
    // Joined by NAME, not id: rate ids are per-instance cuids, so the source's taxRateId is
    // meaningless here. Names are already what --remap-only trusts to resolve the Xero side.
    // Carry the whole row: externalName and externalRatePct are NOT NULL with no default,
    // so a partial insert fails outright — and --dry-run cannot tell you that, because it
    // never reaches the insert. (It cheerfully reported "65 of 65 copied" for an INSERT that
    // could not have run.)
    type SrcMapping = {
      connector: string
      externalTaxRateId: string
      externalName: string
      externalCountry: string | null
      externalRatePct: string
      externalClass: string | null
      name: string
    }
    const srcMappings = (await src.query<SrcMapping>(
      `select m.connector, m."externalTaxRateId", m."externalName", m."externalCountry",
              m."externalRatePct", m."externalClass", t.name
         from shopping_tax_rate_mappings m
         join tax_rates t on t.id = m."taxRateId"`,
    )).rows

    const dstRateIdByName = new Map(
      (await dst.query<{ id: string; name: string }>(`select id, name from tax_rates`)).rows.map((r) => [r.name, r.id]),
    )

    let mapped = 0
    const unresolvable: string[] = []
    for (const m of srcMappings) {
      const taxRateId = dstRateIdByName.get(m.name)
      if (!taxRateId) {
        // A mapping we cannot place IS the silent-0%-VAT case this copy exists to prevent,
        // so name it rather than skipping quietly.
        unresolvable.push(`${m.connector}:${m.externalTaxRateId} -> "${m.name}" (no rate of that name here)`)
        continue
      }
      if (!DRY_RUN) {
        await dst.query(
          `insert into shopping_tax_rate_mappings
             (id, connector, "externalTaxRateId", "externalName", "externalCountry",
              "externalRatePct", "externalClass", "taxRateId", "createdAt", "updatedAt")
             values ($1,$2,$3,$4,$5,$6,$7,$8, now(), now())
           on conflict (connector, "externalTaxRateId")
             do update set "taxRateId"       = excluded."taxRateId",
                           "externalName"    = excluded."externalName",
                           "externalCountry" = excluded."externalCountry",
                           "externalRatePct" = excluded."externalRatePct",
                           "externalClass"   = excluded."externalClass",
                           "updatedAt"       = now()`,
          [randomUUID(), m.connector, m.externalTaxRateId, m.externalName, m.externalCountry,
           m.externalRatePct, m.externalClass, taxRateId],
        )
      }
      mapped++
    }
    console.log(`${DRY_RUN ? '[dry-run] ' : ''}shopping tax rate mappings: ${mapped} of ${srcMappings.length} copied`)
    if (unresolvable.length) {
      console.warn(`\nWARNING — ${unresolvable.length} mapping(s) could NOT be placed. Those WC rates will resolve to 0% VAT SILENTLY:`)
      for (const u of unresolvable) console.warn(`  ${u}`)
    }

    console.log('\naccounting_tax_type was intentionally NOT copied (per-org, creation-order ids).')
    console.log('Next: NODE_OPTIONS=\'--import tsx\' node --env-file=.env scripts/provision-xero-demo.ts --remap-only')
    if (DRY_RUN) console.log('\nDRY RUN — nothing was written.')
  } finally {
    await src.end(); await dst.end()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : e}`); process.exit(1) })
