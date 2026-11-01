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
  assert.match(readFileSync('app/actions/company.ts', 'utf8'), /withFxTableWriteLock\(async \(tx\) => \{[\s\S]*?tx\.organisation\.updateMany/)
  // both importers hold the table still
  const imp = readFileSync('app/actions/import.ts', 'utf8')
  assert.equal((imp.match(/withFxTableHeldStill\(\(guard\) => import(Sales|Purchase)OrdersCsvLocked\(formData, guard/g) ?? []).length, 2)
  // and each checks the lock is STILL held immediately before every order write and once after the last (a dead lock connection frees the lock). [mutation: delete an assertHeld call]
  for (const kind of ['sales order', 'purchase order']) {
    assert.equal((imp.match(new RegExp(`fxGuard\\.assertHeld\\('writing a ${kind}'\\)\\n\\s+const created = await create`, 'g')) ?? []).length, 1, `${kind}: guard right before the write`)
    assert.equal((imp.match(new RegExp(`fxGuard\\.assertHeld\\('finishing the ${kind} import'\\)`, 'g')) ?? []).length, 1, `${kind}: guard after the last write`)
  }
})

test('every fx_rates row is stamped INSIDE the lock-holding transaction (fxWriteStamp), except the Aelia ingest, whose rows carry Aelia\'s own update time', () => {
  const files: string[] = []
  walk('app', files)
  walk('lib', files)
  const create = /\.fxRate\.create\(/g
  const found: string[] = []
  const bad: string[] = []
  for (const f of files) {
    if (f.endsWith('fx-table-lock.ts')) continue
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(create)) {
      const at = m.index ?? 0
      const body = text.slice(at, text.indexOf('})', at) + 2)
      if (/fetchedAt: parsed\.updatedAt/.test(body)) { found.push(`${f}: Aelia's own update time`); continue }
      found.push(f)
      if (!/fetchedAt: (fxWriteStamp\(\)|clearedAt)/.test(body)) bad.push(`${f}: ${body.slice(0, 120)}`)
    }
  }
  assert.ok(found.length >= 6, `PRECONDITION: the census found the known writers (${found.length}: ${found.join(', ')})`)
  assert.deepEqual(bad, [])
  assert.match(readFileSync('lib/currencies/aelia-ingest.ts', 'utf8'), /const clearedAt = options\.now \?\? fxWriteStamp\(\)/)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// NOTHING INSIDE A LOCK-HOLDING TRANSACTION MAY USE THE GLOBAL CLIENT. withFxTableWriteLock holds one pooled connection for the whole of its work; a call that goes through `db` (or a helper that does)
// needs a SECOND one, and with the pool full of other writers waiting for the same lock the holder never gets it, so the pool deadlocks until its acquisition timeout. The scan takes the body of every
// withFxTableWriteLock call in app/ and lib/, and of every helper it passes `tx` to (found by name, followed to a fixed point), and refuses a use of `db`, of a helper known to read through it, or of
// the settings store. It cannot see a helper reached through a variable or a re-export: a new such helper must be named in the lists below.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const CLIENT_TAKING = new Set(['isBaseCurrencyLocked', 'resolveBaseCurrencyCode', 'resolveFxRatesToBase', 'getFxRateSourceInTx'])
const FORBIDDEN_IN_LOCK = [
  /\bdb\./,
  /\bgetBaseCurrencyCode\(/,
  /\bisBaseCurrencyLocked\((?!\s*tx\b)/,
  /\bgetSettingValues?\(/,
  /\bgetFxRateSource\(\)/,
  /\breadAeliaRatesFromWc\((?!\{\s*settings)/,
  /\bgetBaseCurrencyDisplay\(/,
]

/** Source with comments and the contents of string and template literals blanked (positions kept), so braces and words inside them cannot mislead the scan. */
function blank(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    const next = src[i + 1]
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++ } continue }
    if (ch === '/' && next === '*') { while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++ } out += '  '; i += 2; continue }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out += quote; i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') { out += '  '; i += 2; continue }
        out += src[i] === '\n' ? '\n' : ' '; i++
      }
      out += quote; i++
      continue
    }
    out += ch; i++
  }
  return out
}

/** The text from the opening bracket at `open` to its match. */
function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}' }
  const stack: string[] = []
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!
    if (ch === '(' || ch === '{') stack.push(pairs[ch]!)
    else if (ch === ')' || ch === '}') { stack.pop(); if (stack.length === 0) return src.slice(open, i + 1) }
  }
  throw new Error('unbalanced')
}

test('nothing inside a lock-holding transaction uses the global client (db), or a helper that does', (t) => {
  const files: string[] = []
  walk('app', files)
  walk('lib', files)
  const sources = new Map<string, string>()
  for (const f of files) sources.set(f, blank(readFileSync(f, 'utf8')))
  // 1. the bodies of every withFxTableWriteLock call
  const bodies: Array<{ where: string; body: string }> = []
  for (const [f, src] of sources) {
    if (f.endsWith('fx-table-lock.ts')) continue
    for (const m of src.matchAll(/withFxTableWriteLock\(/g)) bodies.push({ where: f, body: balanced(src, (m.index ?? 0) + m[0].length - 1) })
  }
  assert.ok(bodies.length >= 9, `PRECONDITION: the census found the lock-holding calls (${bodies.length})`)
  // 2. every helper handed the transaction, followed to a fixed point. A function `name(...)` or `name = async (...)` defined anywhere in app/ or lib/ and called with `tx` as an argument.
  const followed = new Set<string>()
  const queue = [...bodies]
  const visitedText = new Set<string>()
  const defs = (name: string): Array<{ where: string; body: string }> => {
    const out: Array<{ where: string; body: string }> = []
    for (const [f, src] of sources) {
      for (const m of src.matchAll(new RegExp(`(?:function\\s+${name}\\s*(?:<[^>]*>)?\\s*\\()`, 'g'))) {
        const paren = (m.index ?? 0) + m[0].length - 1
        const afterParams = paren + balanced(src, paren).length
        const brace = src.indexOf('{', afterParams)
        if (brace >= 0) out.push({ where: `${f}:${name}`, body: balanced(src, brace) })
      }
    }
    return out
  }
  const bad: string[] = []
  while (queue.length) {
    const { where, body } = queue.pop()!
    if (visitedText.has(where + body.length)) continue
    visitedText.add(where + body.length)
    for (const re of FORBIDDEN_IN_LOCK) {
      const m = body.match(re)
      if (m) bad.push(`${where}: ${m[0]}`)
    }
    for (const m of body.matchAll(/\b([A-Za-z_]\w*)\(([^()]*\btx\b[^()]*)\)/g)) {
      const name = m[1]!
      if (['withFxTableWriteLock', 'if', 'for', 'while', 'switch'].includes(name) || /^(tx|findMany|findFirst|findUnique|create|update|updateMany|upsert|count|groupBy|deleteMany)$/.test(name)) continue
      if (CLIENT_TAKING.has(name) || followed.has(name)) continue // CLIENT_TAKING: reads through whatever client it is handed (and through the global one only when handed none)
      followed.add(name)
      queue.push(...defs(name))
    }
  }
  t.diagnostic(`lock-holding bodies: ${bodies.length}; helpers followed: ${[...followed].sort().join(', ')}`)
  for (const name of ['aeliaActivationRefusal', 'ingestAeliaRatesInTx', 'requireAeliaSourceInTx']) assert.ok(followed.has(name), `PRECONDITION: the helper ${name} was followed`)
  assert.deepEqual(bad, [])
})
