import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * CENSUS of every writer of the BOM recipe graph. The cycle check in the recipe sync is authoritative only if no other graph
 * writer can commit between that check and its own commit, so every caller has to hold the component-graph advisory lock, taken
 * FIRST in its transaction (before any per-SKU lock, which is the order that keeps the two lock families deadlock-free).
 *
 * A "call" is a use of the recipe sync/reconcile/retire functions or a direct write to the bom / bom_items tables. For each call
 * site the nearest enclosing `$transaction(` must take the graph lock before the call, and before any per-SKU lock. Files that
 * only DELETE (they cannot create a cycle) or deactivate under their own lock are listed explicitly with the reason; a new file
 * with a call fails this test until it is added to one list or the other, which is the review point.
 */

const ROOT = process.cwd()
const LOCK = 'pg_advisory_xact_lock(${COMPONENT_GRAPH_WRITE_LOCK_KEY})'
const CALL = /\b(syncBomRecipeFromProductComponents|reconcileBomRecipeForProductType|retireBomRecipeForProduct)\(|\.(bomItem|bom)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g

/** Files that define or exempt the writes, each with why. */
const EXEMPT: Record<string, string> = {
  'lib/products/bom-recipe.ts': 'defines the functions; its callers are the census subjects below',
  'app/actions/reset.ts': 'factory reset: deletes every row, cannot create an edge',
  'lib/products/bom-recipe-repair.ts': 'deactivates a duplicate Bom only (removes edges from planning) and takes the graph lock itself',
}
/** Files that call the writers and must lock in every transaction that does. */
const LOCKED_CALLERS = [
  'app/actions/import.ts',
  'app/actions/manufacturing.ts',
  'app/actions/products.ts',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full)
  }
  return out
}

const sources = ['app', 'lib', 'scripts'].flatMap((dir) => walk(path.join(ROOT, dir)))
const callers = new Map<string, { text: string; hits: number[] }>()
for (const file of sources) {
  const rel = path.relative(ROOT, file)
  const text = readFileSync(file, 'utf8')
  const hits = [...text.matchAll(CALL)].map((m) => m.index!).filter((at) => {
    const lineStart = text.lastIndexOf('\n', at) + 1
    return !/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, at + 1)) && !/^\s*(import|export)\b/.test(text.slice(lineStart, at + 1))
  })
  if (hits.length > 0) callers.set(rel, { text, hits })
}

test('every file that writes the BOM recipe graph is either exempt with a reason or a checked, locked caller', () => {
  const known = new Set([...Object.keys(EXEMPT), ...LOCKED_CALLERS])
  const unknown = [...callers.keys()].filter((file) => !known.has(file))
  assert.deepEqual(unknown, [], `new BOM graph writer(s) must take COMPONENT_GRAPH_WRITE_LOCK_KEY first and be added to the census: ${unknown.join(', ')}`)
  for (const file of LOCKED_CALLERS) assert.ok(callers.has(file), `${file} no longer calls the writers: remove it from the census`)
})

for (const file of LOCKED_CALLERS) {
  test(`${file}: every transaction that writes the BOM recipe graph takes the graph lock first`, () => {
    const { text, hits } = callers.get(file)!
    for (const at of hits) {
      const txStart = text.lastIndexOf('.$transaction(', at)
      assert.ok(txStart !== -1, `${file}: a BOM graph write at offset ${at} is outside any $transaction`)
      const lockAt = text.indexOf(LOCK, txStart)
      assert.ok(lockAt !== -1 && lockAt < at, `${file}: a BOM graph write at offset ${at} is not preceded by the graph lock in its transaction`)
      const skuLockAt = text.indexOf('lockProductSkusForWrite(', txStart)
      assert.ok(skuLockAt === -1 || skuLockAt > lockAt || skuLockAt > at, `${file}: the per-SKU lock is taken before the graph lock (inverts the lock order)`)
      const firstTxLine = text.slice(txStart, at).split('\n').slice(1).find((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /\btx\./.test(line))
      assert.ok(firstTxLine !== undefined && firstTxLine.includes(LOCK), `${file}: the transaction touches data before it takes the graph lock: ${firstTxLine?.trim()}`)
    }
  })
}
