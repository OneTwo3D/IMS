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

/**
 * EVERY FORM A READ OF THE BOM TABLES CAN TAKE. Each is a named pattern so that a negative test below can
 * prove the form is detected when it appears in an unlisted file.
 *   delegate   any access to the `bom` / `bomItem` delegate or relation that is not a plain write
 *              (`.findMany`, `.count`, a destructured alias, `order.bom.items`, `product.manufacturingBom`)
 *   key        a relation or delegate named as a property: `{ bom: { ... } }`, `{ bom: true }`,
 *              `{ manufacturingBom: SELECT }`, `bomItem: FindManyDelegate`
 *   sql        raw SQL on the tables: FROM / JOIN / comma-join
 */
const WRITE = /^\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/
const NAMES = '(?:bomItem|bomItems|bom|manufacturingBom|bomAsParent|bomAsComponent)'
const READ_FORMS: Array<{ name: string; regex: RegExp; skip?: (after: string) => boolean }> = [
  { name: 'delegate', regex: new RegExp(`\\.\\s*${NAMES}\\b(?!\\s*:)`, 'g'), skip: (after) => WRITE.test(after) },
  { name: 'key', regex: new RegExp(`\\b(?:bomItem|bomItems|manufacturingBom|bomAsParent|bomAsComponent)\\s*:\\s*[{A-Za-z_]|\\bbom\\s*:\\s*(?:\\{|true\\b)`, 'g') },
  { name: 'sql', regex: /\b(?:FROM|JOIN)\s+(?:\w+\.)?"?(?:boms|bom_items)"?\b|,\s*(?:\w+\.)?"?(?:boms|bom_items)"?\s+(?:AS\s+)?\w+\b/gi },
]

/** Number of reads of the Bom tables in `text` (comments already stripped). */
function countReads(text: string): number {
  let count = 0
  for (const form of READ_FORMS) {
    for (const match of text.matchAll(form.regex)) {
      if (form.skip?.(text.slice(match.index! + match[0].length))) continue
      count += 1
    }
  }
  return count
}

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
  const count = countReads(text)
  if (count > 0) readers.set(rel, count)
}

type Scoped = { reads: number; present: RegExp[]; absent: RegExp[]; why: string }

/** PLANNING readers: scoped to the claimed recipe. `reads` pins how many reads the file has. */
const PLANNING: Record<string, Scoped> = {
  'lib/domain/inventory/replenishment-reports.ts': {
    reads: 8,
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

/** Files that read the tables and are in none of the lists. */
function unclassifiedIn(files: Map<string, string>, classified: Set<string>): string[] {
  return [...files].filter(([rel, text]) => !classified.has(rel) && countReads(text) > 0).map(([rel]) => rel)
}

test('NEGATIVE: every read form fails the census when it appears in an unlisted file', () => {
  const forms: Record<string, string> = {
    'delegate findMany': 'await client.bomItem.findMany({ where: {} })',
    'delegate findFirst on bom': 'await tx.bom.findFirst({})',
    'delegate count': 'await db.bomItem.count()',
    'delegate aggregate': 'await db.bomItem.aggregate({ _sum: { qty: true } })',
    'delegate alias': 'const items = db.bomItem; await items.findMany()',
    'delegate via property chain': 'for (const item of order.bom.items) use(item)',
    'relation property access': 'const r = product.manufacturingBom?.items',
    'include boolean': 'await db.product.findMany({ include: { bom: true } })',
    'select boolean': 'await db.productionOrder.findMany({ select: { bom: true } })',
    'relation boolean': 'await db.product.findMany({ select: { manufacturingBom: true } })',
    'relation object': 'await db.product.findMany({ select: { manufacturingBom: { select: { id: true } } } })',
    'relation as variable': 'await db.product.findMany({ select: { manufacturingBom: BOM_SELECT } })',
    'bomAsParent boolean': 'await db.product.findMany({ include: { bomAsParent: true } })',
    'where on relation': 'await db.productionOrder.count({ where: { bom: { active: true } } })',
    'client type': 'type C = { bomItem: FindManyDelegate }',
    'sql from': 'await db.$queryRaw`SELECT * FROM bom_items`',
    'sql from quoted': 'await db.$queryRaw`SELECT id FROM "boms" WHERE active`',
    'sql join': 'await db.$queryRaw`SELECT 1 FROM products p JOIN bom_items i ON i."parentProductId" = p.id`',
    'sql comma join': 'await db.$queryRaw`SELECT 1 FROM products p, boms b WHERE b."productId" = p.id`',
    'sql lowercase': 'await db.$queryRawUnsafe("select * from boms")',
  }
  for (const [name, sample] of Object.entries(forms)) {
    const files = new Map([['lib/new-unlisted-reader.ts', code(sample)]])
    assert.deepEqual(unclassifiedIn(files, new Set()), ['lib/new-unlisted-reader.ts'], `form "${name}" must be detected`)
    assert.deepEqual(unclassifiedIn(files, new Set(['lib/new-unlisted-reader.ts'])), [], `and accepted once classified: "${name}"`)
  }
})

test('NEGATIVE: writes, comments and unrelated words are not reads (the detector is not trigger-happy)', () => {
  const quiet = [
    'await db.bomItem.deleteMany({})',
    'await tx.bom.create({ data: {} })',
    'await tx.bomItem.createMany({ data: [] })',
    '// client.bomItem.findMany() in a comment\nconst x = 1',
    '/* FROM bom_items */ const y = 2',
    'const tableClass = { bom_items: { kind: 1 } }',
    'const bomIds = splitIds(rows)',
  ]
  for (const sample of quiet) assert.equal(countReads(code(sample)), 0, sample)
})
