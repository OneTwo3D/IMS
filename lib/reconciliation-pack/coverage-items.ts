/**
 * ITEM R14: FOUR-WAY SKU COVERAGE (Qoblex, WooCommerce, the 3PL's warehouse system, IMS), by presence, exact except written exclusions.
 *
 * Every SKU that any read system holds must be held by EVERY read system. The comparison is over (SKU, system) PAIRS: the one side is
 * the EXPECTATION (every SKU of the union in every system that was read) and the other is what each system actually holds, so a pair
 * the expectation names and the system lacks is `onlyIms` in the evidence (read it as "expected, absent") and the evidence key names the
 * SKU and the system (`SKU|woocommerce`). No total stands in for identity: equal counts with one SKU swapped is two findings.
 *
 * THE LEGS. Qoblex: the products of the export (qoblex-source.ts). WooCommerce: the full proven double walk of the storefront's top-level
 * products (woo-source.ts readWooProducts, GET only, behind --vendor-reads-only). IMS: every product, read with the rest in one read-only
 * snapshot. The 3PL's warehouse system: an injected SKU-list port; there is none on a build without that source, and then that leg is
 * LEG_UNAVAILABLE: the other three are still compared and a finding among them still fails the item, but the item never passes.
 * A leg that cannot be read for any other reason makes the whole item inconclusive with that reason.
 *
 * EXCLUSIONS (owner decision D8): a written exclusion for one SKU in one system, in force (accepted, not expired) under a trusted file
 * (sku-exclusions.ts), moves exactly that pair to the `excluded` bucket, listed and not judged. An exclusion for one system never covers
 * another system or another SKU; an untrusted, absent or expired exclusion covers nothing.
 *
 * SET ASIDE, LISTED, NEVER A FINDING (outOfPopulation): a SKU that is a product VARIATION (VARIANT in IMS or in the export) is not looked
 * for in the storefront walk, which lists top-level products only (STATED LIMIT: variations are separate collections that the transport
 * does not walk, so a variation missing from the storefront is not detected here); a storefront product with an empty SKU has no SKU
 * identity and is listed under its storefront id.
 *
 * A SKU is compared as the exact string each system holds (no case folding, no trimming): two spellings are two SKUs, and the one system
 * that has only one of them is the finding.
 */

import { compareItem, outcomeOfComparison, type CompareEntry, type CompareResult, type SideRow } from '@/lib/reconciliation-pack/compare'
import { R14_SYSTEMS, R14_SYSTEM_SOURCES, R14_WMS_SYSTEM, type PackReasonCode, type PackSourceCode, type R14System } from '@/lib/reconciliation-pack/constants'
import { canonicalKey, keyToken, type KeyPart } from '@/lib/reconciliation-pack/identity'
import type { ImsRead, ImsReadOptions, ProductRow } from '@/lib/reconciliation-pack/ims-readers'
import type { QoblexSource } from '@/lib/reconciliation-pack/qoblex-source'
import type { ItemInput } from '@/lib/reconciliation-pack/report'
import { exclusionsInForce, type SkuExclusionFile } from '@/lib/reconciliation-pack/sku-exclusions'
import { readWooProducts, type WooGetPort, type WooSourceOptions } from '@/lib/reconciliation-pack/woo-source'

/** The SKUs the 3PL's warehouse system holds, complete and proven, or the closed reason it could not be had. */
export type SkuListPort = () => Promise<{ ok: true; skus: readonly string[] } | { ok: false; reason: PackReasonCode }>

export type CoverageContext = {
  asOf: string
  now: () => Date
  /** The explicit opt-in. Anything but the boolean true is "off". */
  vendorReads?: boolean
  woo?: WooGetPort
  wooOptions?: WooSourceOptions
  ims?: (options: ImsReadOptions) => Promise<ImsRead>
  qoblex?: QoblexSource
  wms?: SkuListPort
  exclusions?: SkuExclusionFile
}

const IMS: PackSourceCode = 'ims-database'
const QOBLEX: PackSourceCode = 'qoblex-file'
const WOO: PackSourceCode = 'woocommerce-api'
const WMS: PackSourceCode = R14_SYSTEM_SOURCES[R14_WMS_SYSTEM]

const inconclusive = (sources: readonly PackSourceCode[], ...reasons: PackReasonCode[]): ItemInput => ({ id: 'R14', outcome: 'inconclusive', reasons: [...new Set(reasons)], sources: [...sources] })

const pairKey = (sku: string, system: R14System): KeyPart[] => [{ kind: 'sku', raw: sku }, { kind: 'sku', raw: system }]
const SKU_PLAIN = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)

function unique(list: readonly string[]): boolean {
  return new Set(list).size === list.length
}

async function runR14(context: CoverageContext): Promise<ItemInput> {
  const woo = context.woo
  const readIms = context.ims
  if (woo === undefined || readIms === undefined || context.qoblex === undefined) return inconclusive([], 'SOURCE_UNREADABLE')

  const qoblex = await context.qoblex.read()
  if (!qoblex.ok) return inconclusive([QOBLEX], qoblex.reason)
  if (!qoblex.value.products.ok) return inconclusive([QOBLEX], qoblex.value.products.reason)
  const qoblexProducts = qoblex.value.products.value

  const read = await readIms({ sections: ['products'] })
  if (!read.ok) return inconclusive([IMS, QOBLEX], read.reason)
  const section = read.sections.products
  if (section === undefined || !section.ok) return inconclusive([IMS, QOBLEX], section === undefined ? 'SOURCE_UNREADABLE' : section.reason)
  const imsProducts: ProductRow[] = section.value

  const walked = await readWooProducts(woo, context.wooOptions)
  if (!walked.ok) return inconclusive([IMS, QOBLEX, WOO], walked.reason)

  // The 3PL warehouse-system leg: absent or unreadable is a leg that is not compared (LEG_UNAVAILABLE), never an empty list.
  let wmsSkus: string[] | null = null
  const legReasons: PackReasonCode[] = []
  if (context.wms === undefined) legReasons.push('LEG_UNAVAILABLE')
  else {
    let answer: Awaited<ReturnType<SkuListPort>>
    try { answer = await context.wms() } catch { answer = { ok: false, reason: 'SOURCE_UNREADABLE' } }
    if (typeof answer !== 'object' || answer === null || answer.ok !== true) legReasons.push('LEG_UNAVAILABLE', typeof answer === 'object' && answer !== null && answer.ok === false && typeof answer.reason === 'string' ? answer.reason : 'SOURCE_UNREADABLE')
    else if (!Array.isArray(answer.skus) || !answer.skus.every(SKU_PLAIN) || !unique(answer.skus)) return inconclusive([IMS, QOBLEX, WOO, WMS], answer.skus && Array.isArray(answer.skus) && !unique(answer.skus as string[]) ? 'DUPLICATE_KEY' : 'BAD_KEY')
    else wmsSkus = [...answer.skus]
  }

  // Each system's SKUs, exactly as it holds them. A repeated SKU inside one system is never merged.
  const held: Partial<Record<R14System, string[]>> = {
    qoblex: qoblexProducts.map((p) => p.sku),
    ims: imsProducts.map((p) => p.sku),
    woocommerce: walked.value.products.filter((p) => p.sku !== '').map((p) => p.sku),
  }
  if (wmsSkus !== null) held[R14_WMS_SYSTEM] = wmsSkus
  for (const skus of Object.values(held)) if (!skus.every(SKU_PLAIN)) return inconclusive([IMS, QOBLEX, WOO], 'BAD_KEY')
  for (const skus of Object.values(held)) if (!unique(skus)) return inconclusive([IMS, QOBLEX, WOO], 'DUPLICATE_KEY')
  const read_: R14System[] = R14_SYSTEMS.filter((system) => held[system] !== undefined)

  const heldSets = new Map(read_.map((system) => [system, new Set(held[system]!)] as const))
  const union = [...new Set(Object.values(held).flat())].sort()
  const expected: SideRow[] = []
  const actual: SideRow[] = []
  for (const sku of union) {
    for (const system of read_) {
      expected.push({ key: pairKey(sku, system) })
      if (heldSets.get(system)!.has(sku)) actual.push({ key: pairKey(sku, system) })
    }
  }

  // Set aside: a variation is not looked for in the storefront walk (top-level products only).
  const variations = new Set<string>([...imsProducts.filter((p) => p.type === 'VARIANT').map((p) => p.sku), ...qoblexProducts.filter((p) => p.type === 'VARIANT').map((p) => p.sku)])
  const population = new Set<string>()
  for (const row of expected) {
    const [skuPart, systemPart] = row.key as [KeyPart, KeyPart]
    if (systemPart.raw === 'woocommerce' && variations.has(skuPart.raw as string)) continue
    population.add(canonicalKey(row.key))
  }

  // Written exclusions in force, one SKU in one system. Only a pair of a system that was read can be excluded from anything.
  const excluded = new Set<string>()
  for (const entry of context.exclusions === undefined ? [] : exclusionsInForce(context.exclusions, context.now())) excluded.add(canonicalKey(pairKey(entry.sku, entry.system)))

  const result = compareItem('R14', { ims: expected, vendor: actual, imsComplete: true, vendorComplete: true, population, excluded })
  const sources: PackSourceCode[] = [IMS, QOBLEX, WOO, ...(wmsSkus !== null ? [WMS] : [])]
  if (result.status !== 'compared') return inconclusive(sources, result.reason, ...legReasons)

  // A storefront product with no SKU: listed under its storefront id, never a finding.
  const used = new Set<string>(Object.values(result.buckets).flatMap((entries) => entries.map((entry) => entry.key as string)))
  const unkeyed: CompareEntry[] = []
  for (const product of walked.value.products) {
    if (product.sku !== '') continue
    const token = keyToken([{ kind: 'vendor-id', raw: product.id }, { kind: 'sku', raw: 'woocommerce' }])
    if (used.has(token)) return inconclusive(sources, 'DUPLICATE_KEY')
    used.add(token)
    unkeyed.push({ key: token, ims: null, vendor: null, delta: null, imsCurrency: null, vendorCurrency: null, imsPresent: false, vendorPresent: true })
  }
  const withUnkeyed: CompareResult = { ...result, buckets: { ...result.buckets, outOfPopulation: [...result.buckets.outOfPopulation, ...unkeyed] } }

  const verdict = outcomeOfComparison(withUnkeyed)
  const entries = withUnkeyed.buckets
  if (legReasons.length === 0) return { id: 'R14', outcome: verdict.outcome, reasons: verdict.reasons, proof: verdict.outcome === 'pass' ? result.proof : null, sources, entries }
  // A leg is missing: a finding among the legs that were read still fails; nothing else can be better than inconclusive.
  if (verdict.outcome === 'fail') return { id: 'R14', outcome: 'fail', reasons: [...new Set([...verdict.reasons, ...legReasons])], sources, entries }
  return { id: 'R14', outcome: 'inconclusive', reasons: [...new Set([...verdict.outcome === 'inconclusive' ? verdict.reasons : [], ...legReasons])], sources, entries }
}

/** Run R14. With the opt-in absent NOTHING is read. Never throws. */
export async function runCoverageItem(context: CoverageContext): Promise<ItemInput> {
  if (context.vendorReads !== true) return { id: 'R14', outcome: 'inconclusive', reasons: ['VENDOR_READS_OFF'] }
  if (context.qoblex === undefined) return { id: 'R14', outcome: 'inconclusive', reasons: ['QOBLEX_EXPORT_OFF'] }
  try {
    return await runR14(context)
  } catch {
    return inconclusive([], 'INTERNAL_ERROR')
  }
}
