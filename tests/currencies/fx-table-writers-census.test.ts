import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * Every writer of `fx_rates` takes the exclusive side of the rate table's stability lock (withFxTableWriteLock): a bare `db.fxRate.create(...)` outside it would write mid-import. [mutation: restore db.fxRate.create in any writer]
 * Scripts and tests (fixtures, rehearsal drivers) run out of process against scratch databases and are not production writers.
 */
const WRITE = /\b(\w+)\.fxRate\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'generated' || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
}

test('every fx_rates writer in app/ and lib/ writes through the exclusive lock', (t) => {
  const files: string[] = []
  walk('app', files)
  walk('lib', files)
  const sites: string[] = []
  const bad: string[] = []
  for (const f of files) {
    if (f.endsWith('fx-table-lock.ts')) continue
    // The FACTORY RESET empties every table (documents, orders, settings and the rate table) behind a fresh-admin confirmation code, with the application stopped; no import can outlive it and
    // it changes no rate for a live document. It is the one exemption, and it is listed so a second one cannot appear silently.
    if (f === path.join('app', 'actions', 'reset.ts')) { sites.push(`${f}:deleteMany (exempt: factory reset)`); continue }
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(WRITE)) {
      sites.push(`${f}:${m[2]}`)
      if (m[1] !== 'tx' || !text.includes('withFxTableWriteLock')) bad.push(`${f}: ${m[0]}`)
    }
  }
  t.diagnostic(`fx_rates writer sites: ${sites.join(', ')}`)
  assert.ok(sites.length >= 5, 'PRECONDITION: the census found the known writers')
  assert.deepEqual(bad, [])
  // the base currency the rates are measured against
  assert.match(readFileSync('app/actions/company.ts', 'utf8'), /withFxTableWriteLock\(\(tx\) => tx\.organisation\.updateMany/)
  // both importers hold the table still
  const imp = readFileSync('app/actions/import.ts', 'utf8')
  assert.equal((imp.match(/withFxTableHeldStill\(\(\) => import(Sales|Purchase)OrdersCsvLocked/g) ?? []).length, 2)
})
