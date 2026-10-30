import type test from 'node:test'

import { FakeWooStore, STORE, woo } from './woo-tax-fakes.ts'

/**
 * The shared world of the WooCommerce tax-rate writer's database and concurrency tests (IMS rows in the scratch database, an in-memory store that counts every send). The caller loads the
 * modules (its own way of reading the environment) and hands them in; the environment the hold reads is injected per call, never taken from the process.
 */
type Mods = { db: typeof import('../../lib/db/index.ts').db; writer: typeof import('../../lib/connectors/woocommerce/tax-rate-writer.ts') }
const ctx = (env: Record<string, string>) => ({ env, now: new Date('2026-06-01T00:00:00Z') })

export type World = {
  m: Mods
  store: FakeWooStore
  ids: { gb: string; de: string; pt30: string; old: string; fr: string }
  woo: { w1: string; w2: string; w3: string; w4: string; w5: string }
  deps: (env: Record<string, string>) => Parameters<Mods['writer']['applyWooTaxPlan']>[0]
  counts: () => Promise<{ writes: number; mappings: number; shadows: number }>
  mappingRows: () => Promise<unknown[]>
}

/**
 * IMS: GB 20 (right in the store), DE 19 (store says 18), PT-30 22 (store has no state), an INACTIVE rate (its store rate is owned by its mapping: DELETE), FR 20 (not in the store: CREATE).
 * Store: the four mapped rates, plus one rate nobody mapped (wrong in every way, owned by nobody).
 */
export async function buildWorld(t: test.TestContext, modules: () => Promise<Mods>, body: (w: World) => Promise<void>): Promise<void> {
  const m = await modules()
  const { db } = m
  const base = 7_000_000 + Math.floor(Math.random() * 800_000) * 10
  const mk = (data: { name: string; rate: string; countryCode: string; active?: boolean; taxCategory?: 'STANDARD' | 'ZERO' }) =>
    db.taxRate.create({ data: { name: data.name, rate: data.rate, countryCode: data.countryCode, usedFor: 'SALES', taxCategory: data.taxCategory ?? 'STANDARD', active: data.active ?? true } })
  const others = (await db.taxRate.findMany({ where: { active: true }, select: { id: true } })).map((r) => r.id)
  await db.taxRate.updateMany({ where: { id: { in: others } }, data: { active: false } })
  const gb = await mk({ name: 'GB VAT', rate: '0.2000', countryCode: 'GB' })
  const de = await mk({ name: 'DE VAT', rate: '0.1900', countryCode: 'DE' })
  const pt30 = await mk({ name: 'PT-30 VAT', rate: '0.2200', countryCode: 'PT' })
  const old = await mk({ name: 'XX Old VAT', rate: '0.1000', countryCode: 'XX', active: false })
  const fr = await mk({ name: 'FR VAT', rate: '0.2000', countryCode: 'FR' })
  const id = (n: number) => String(base + n)
  const w1 = woo(id(1), { name: 'GB VAT' })
  const w2 = woo(id(2), { name: 'DE VAT', country: 'DE', rate: '18.0000' })
  const w3 = woo(id(3), { name: 'PT-30 VAT', country: 'PT', rate: '22.0000', state: '' })
  const w4 = woo(id(4), { name: 'XX Old VAT', country: 'XX', rate: '10.0000' })
  const w5 = woo(id(5), { name: 'Hand made', country: 'IE', rate: '99.0000', class: 'weird', shipping: false, compound: true })
  const store = new FakeWooStore([w1, w2, w3, w4, w5], base + 100)
  for (const [w, r] of [[w1, gb], [w2, de], [w3, pt30], [w4, old]] as const) await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: w.id, taxRateId: r.id, externalName: w.name, externalCountry: w.country, externalRatePct: w.rate, externalClass: w.class, storeIdentity: STORE } })
  const mine = [gb.id, de.id, pt30.id, old.id, fr.id]
  t.after(async () => {
    await db.wooTaxRateWrite.deleteMany({ where: { imsTaxRateId: { in: mine } } })
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: { in: mine } } })
    await db.outboundShadowWrite.deleteMany({ where: { destination: 'woocommerce', operation: 'tax-rate' } })
    await db.taxRate.deleteMany({ where: { id: { in: mine } } })
    await db.taxRate.updateMany({ where: { id: { in: others } }, data: { active: true } })
  })
  await db.outboundShadowWrite.deleteMany({ where: { destination: 'woocommerce', operation: 'tax-rate' } })
  const counts = async () => ({
    writes: await db.wooTaxRateWrite.count({ where: { imsTaxRateId: { in: mine } } }),
    mappings: await db.shoppingTaxRateMapping.count({ where: { taxRateId: { in: mine } } }),
    shadows: await db.outboundShadowWrite.count({ where: { destination: 'woocommerce', operation: 'tax-rate' } }),
  })
  await body({
    m, store, ids: { gb: gb.id, de: de.id, pt30: pt30.id, old: old.id, fr: fr.id },
    woo: { w1: w1.id, w2: w2.id, w3: w3.id, w4: w4.id, w5: w5.id },
    deps: (env) => ({ readWoo: store.readWoo, storeIdentity: async () => STORE, port: store, context: ctx(env) }),
    counts,
    mappingRows: () => db.shoppingTaxRateMapping.findMany({ where: { taxRateId: { in: mine } }, orderBy: { externalTaxRateId: 'asc' } }),
  })
}

