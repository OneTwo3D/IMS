import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * CENSUS of every READER of the Bom recipe tables (`boms`, `bom_items`), sorted by what it does with
 * what it reads. Sibling of bom-graph-writer-lock-census.test.ts, which does the same for writers.
 *
 * THE RULE. `boms.productId` (unique, nullable) CLAIMS a product: the claimed Bom is the one recipe
 * planning may count. A second active Bom listing the same parent is a stray duplicate, and a reader
 * that sums "every active BomItem for a parent" double-counts it. So:
 *   - a PLANNING reader (it plans, explodes or orders against demand) must scope to the claim, and
 *     its file is listed with a pattern that proves the scope is present;
 *   - a HISTORY reader (it reports what an order actually ran) must read the recipe frozen on the
 *     order (`componentSnapshot`), never the live Bom;
 *   - a DELIBERATE-ALL reader sees every row on purpose (cycle checks, drift, export, repair) and
 *     carries the reason, which is the review point.
 * A file that reads these tables and is in none of the lists FAILS here until it is classified, and a
 * planning file whose count of reads changes fails until the new read is scoped and the count updated.
 */

const ROOT = process.cwd()

/** A read of bom / bom_items: a delegate query, a relation include/select, or raw SQL. */
const READ = /\b(?:bomItem|bom)\s*\.\s*(?:findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|aggregate|groupBy)\b|\bbomItem\s*:\s*FindManyDelegate|\b(?:bom|manufacturingBom|bomAsParent|bomAsComponent)\s*:\s*\{|\b(?:FROM|JOIN)\s+"?(?:boms|bom_items)\b/g

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts|mjs)$/.test(name)) out.push(full)
  }
  return out
}

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1')
}

/** The helper module itself names the shapes it scopes with; it reads nothing. */
const HELPER = 'lib/products/claimed-bom.ts'

const sources = new Map<string, string>()
for (const dir of ['app', 'lib', 'scripts', 'components']) {
  for (const file of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file)
    if (rel !== HELPER) sources.set(rel, code(readFileSync(file, 'utf8')))
  }
}
const readers = new Map<string, number>()
for (const [rel, text] of sources) {
  const count = [...text.matchAll(READ)].length
  if (count > 0) readers.set(rel, count)
}

type Scoped = { reads: number; present: RegExp[]; absent: RegExp[]; why: string }

/** PLANNING readers: scoped to the claimed recipe. `reads` pins how many reads the file has. */
const PLANNING: Record<string, Scoped> = {
  'lib/domain/inventory/replenishment-reports.ts': {
    reads: 7,
    present: [/CLAIMED_BOM_WHERE/, /claimedBomItems\(/, /manufacturingBom:\s*\{/, /componentSnapshot/],
    absent: [/\bbom:\s*\{\s*active:\s*true\s*\}/, /order\.bom\b/],
    why: 'component-demand expansion reads the claimed recipe (claimedBomItems over a claimed-Bom filter); the shortage report plans a started order from its snapshot and any other order from the product\'s claimed Bom (manufacturingBom)',
  },
  'lib/domain/manufacturing/reorder-mo-planning.ts': {
    reads: 2,
    present: [/productId:\s*\{\s*in:\s*productIds\s*\}/],
    absent: [/updatedAt/, /parentProductId/],
    why: 'resolves the Bom for a reorder MO by boms.productId, never by updatedAt',
  },
}

/** Callers that must resolve their Bom through the claimed-Bom helper. */
const CLAIM_RESOLVERS: Record<string, { present: RegExp[]; absent: RegExp[] }> = {
  'app/actions/forecasting.ts': {
    present: [/claimedActiveBomIdsByProduct\(/],
    absent: [/\bbom\s*\.\s*find/, /updatedAt/],
  },
}

/** HISTORY readers: must use the recipe frozen on the order. */
const HISTORY: Record<string, { present: RegExp[]; absent: RegExp[]; why: string }> = {
  'lib/domain/manufacturing/manufacturing-analytics.ts': {
    present: [/componentSnapshot:\s*true/, /parseProductionOrderComponentSnapshot\(/],
    absent: [/\bbom\s*:\s*\{/, /\bbom\.items\b/],
    why: 'variance is planned from the componentSnapshot frozen when the order started; an order with no frozen recipe is excluded and named, never planned from the live Bom',
  },
}

/** DELIBERATE-ALL readers: they see every row on purpose. Each says why that is not a planning read. */
const DELIBERATE_ALL: Record<string, string> = {
  'lib/products/bom-recipe.ts': 'recipe sync / claim / drift: reads every Bom for the parent to adopt, refuse active duplicates and report strays; the cycle walk reads every edge, retired Boms included, because history stays readable',
  'lib/products/bom-recipe-repair.ts': 'operator repair: finds the stray Bom to deactivate, so it must see unclaimed rows',
  'app/actions/import.ts': 'dry-run cycle preflight over every bom_items edge (same semantics as the in-transaction cycle check)',
  'app/api/export/bom-recipes/route.ts': 'export of every Bom with a bomClaimed column so strays are visible rather than hidden',
  'lib/first-load/apply/db/observe.ts': 'first-load verification compares the product\'s CLAIMED Bom (manufacturingBom) with its components; it reports, it does not plan',
  'lib/first-load/apply/db/attribution.ts': 'first-load attribution counts rows the load wrote; nothing is planned from them',
}

test('every file that reads boms / bom_items is classified (a new reader fails until it is)', () => {
  const classified = new Set([
    ...Object.keys(PLANNING), ...Object.keys(CLAIM_RESOLVERS), ...Object.keys(HISTORY), ...Object.keys(DELIBERATE_ALL),
  ])
  const unclassified = [...readers.keys()].filter((file) => !classified.has(file))
  assert.deepEqual(
    unclassified,
    [],
    `These files read the Bom tables but are not in the census. A planning reader must scope to the claimed `
    + `recipe (lib/products/claimed-bom.ts); a history reader must read the order's componentSnapshot; any other `
    + `reader must be listed in DELIBERATE_ALL with the reason it may see every row: ${unclassified.join(', ')}`,
  )
})

test('the census has no stale entries (every listed reader still reads, every file exists)', () => {
  for (const file of [...Object.keys(PLANNING), ...Object.keys(DELIBERATE_ALL)]) {
    assert.ok(sources.has(file), `${file} no longer exists; remove it from the census`)
    assert.ok(readers.has(file), `${file} no longer reads the Bom tables; remove it from the census`)
  }
  for (const file of [...Object.keys(CLAIM_RESOLVERS), ...Object.keys(HISTORY)]) {
    assert.ok(sources.has(file), `${file} no longer exists; remove it from the census`)
  }
})

test('every PLANNING reader scopes to the claimed recipe, and its number of reads is pinned', () => {
  for (const [file, rule] of Object.entries(PLANNING)) {
    const text = sources.get(file)!
    assert.equal(
      readers.get(file),
      rule.reads,
      `${file}: the number of Bom reads changed (${readers.get(file)} vs ${rule.reads}). Scope the new read to the claimed recipe, then update the pin.`,
    )
    for (const pattern of rule.present) assert.match(text, pattern, `${file} must contain ${pattern} (${rule.why})`)
    for (const pattern of rule.absent) assert.doesNotMatch(text, pattern, `${file} must not contain ${pattern} (${rule.why})`)
  }
})

test('callers that need a product\'s Bom resolve it through the claim, not by updatedAt', () => {
  for (const [file, rule] of Object.entries(CLAIM_RESOLVERS)) {
    const text = sources.get(file)!
    for (const pattern of rule.present) assert.match(text, pattern, `${file} must contain ${pattern}`)
    for (const pattern of rule.absent) assert.doesNotMatch(text, pattern, `${file} must not contain ${pattern}`)
  }
})

test('HISTORY readers read the order\'s frozen recipe, never the live Bom', () => {
  for (const [file, rule] of Object.entries(HISTORY)) {
    const text = sources.get(file)!
    for (const pattern of rule.present) assert.match(text, pattern, `${file} must contain ${pattern} (${rule.why})`)
    for (const pattern of rule.absent) assert.doesNotMatch(text, pattern, `${file} must not contain ${pattern} (${rule.why})`)
  }
})

test('the census detector sees a new unscoped planning read (it is not vacuous)', () => {
  const sample = code('const rows = await client.bomItem.findMany({ where: { bom: { active: true } } })')
  assert.ok([...sample.matchAll(READ)].length >= 2, 'a delegate read and a relation filter are both detected')
  assert.equal([...code('// client.bomItem.findMany() in a comment\nconst x = 1').matchAll(READ)].length, 0)
})
