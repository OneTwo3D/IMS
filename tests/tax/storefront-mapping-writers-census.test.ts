import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import test from 'node:test'

/**
 * CENSUS OF EVERY WRITER OF shopping_tax_rate_mappings, AND PROOF THAT IT CAN FAIL.
 *
 * A mapping row's ownership stamp (`storeIdentity`) must not outlive what it was stamped for: every writer that can change a stamped row's IMS rate or identity snapshot clears the stamp in the same
 * write (lib/tax/storefront-mapping-write.ts, or inline where the writer is a bulk statement). This test scans the tree for every write to the table (a Prisma delegate call or raw SQL) and
 * requires each file to be declared with the rule that holds for it, and the rule to be visible in the file. A new writer is red until it is declared; a declared one that loses its rule is red.
 *
 *   helper         changes rows only through upsertStorefrontTaxMapping / repointStorefrontTaxMapping (which keeps the stamp only if the row still means the same); may also delete rows
 *   clears-inline  changes rows itself and clears the stamp in the same statement (the declared token must be in the file)
 *   creates-only   only creates rows (born unstamped); no update, upsert or ON CONFLICT DO UPDATE
 *   removes-only   only deletes rows (a deleted row owns nothing)
 *   stamps         the tax-rate writer and its adoption step: they set the stamp on purpose
 *   impl           the helper itself
 *
 * AND EVERY WRITER TAKES THE APPLY LOCK. The WooCommerce tax-rate apply holds WOO_TAX_RATE_WRITE_LOCK_KEY exclusively for its whole run and re-reads the ownership it rests on just before each
 * send; a mapping writer that does not take the same key SHARED (lockStorefrontMappingWrites, pg_advisory_xact_lock_shared) can change a row between that re-read and the send. So: a file that
 * writes the table directly must call lockStorefrontMappingWrites( (or take the shared lock in SQL, as the copy script does) at least once per place it writes; a file that writes only through the helper gets it from the helper,
 * and the helper's two entry points must call it; the stamping writer must take the lock exclusively. Reset (the factory reset deletes every row) takes it too: a row that vanishes under a
 * running apply is exactly the ownership change the re-read is there to catch, and only a coordinated delete leaves no gap between the re-read and the send.
 */

type Rule = 'helper' | 'clears-inline' | 'creates-only' | 'removes-only' | 'stamps' | 'impl'
type Declaration = { rule: Rule; token?: string; why: string }

export const WRITERS: Readonly<Record<string, Declaration>> = {
  'lib/connectors/woocommerce/sync/taxes.ts': { rule: 'helper', why: 'the tax-rate import (upsert of the rate behind each WooCommerce id)' },
  'app/actions/wc-sync.ts': { rule: 'helper', why: 'the mapper\'s re-map (taxRateId) through the helper; the unlink deletes the row' },
  'lib/tax/tax-rekey.ts': { rule: 'clears-inline', token: 'storeIdentity: null', why: 'the re-key re-points every mapping of a retired IMS rate to its replacement' },
  'lib/tax/purchase-tax-import.ts': { rule: 'clears-inline', token: 'storeIdentity: null', why: 'a replaced rate\'s mappings move to its replacement in the same write' },
  'scripts/lib/woo-import-driver.ts': { rule: 'helper', why: 'the rehearsal fixture seeds two mappings' },
  'scripts/copy-tax-rates.ts': { rule: 'clears-inline', token: 'store_identity', why: 'copies mappings between databases with ON CONFLICT DO UPDATE' },
  'scripts/commerce-accounting-e2e-fixture.ts': { rule: 'creates-only', why: 'e2e fixtures create mappings' },
  'app/actions/reset.ts': { rule: 'removes-only', why: 'the factory reset empties the table' },
  'lib/connectors/woocommerce/tax-rate-writer.ts': { rule: 'stamps', why: 'the IMS tax-rate writer and its adoption step set the stamp by design' },
  'lib/tax/storefront-mapping-write.ts': { rule: 'impl', why: 'the helper that decides whether a stamp survives a write' },
}

const SKIPPED = new Set(['node_modules', '.next', 'generated', 'archive', '.git'])
export const ROOTS = ['app', 'lib', 'scripts', 'components', 'e2e'] as const

function walk(dir: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { if (!SKIPPED.has(entry.name)) walk(path, out) }
    else if (['.ts', '.tsx', '.mts', '.mjs', '.js', '.sh'].includes(extname(entry.name))) out.push(path)
  }
  return out
}

const DELEGATE = /shoppingTaxRateMapping\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g
const SQL = /\b(insert\s+into|update|delete\s+from)\s+"?shopping_tax_rate_mappings"?/gi
const ON_CONFLICT_UPDATE = /on\s+conflict[\s\S]{0,400}?do\s+update/i

/** The write operations a file performs on the table: Prisma delegate calls and raw statements, as one of create | update | delete. */
export function writesOf(text: string): Set<'create' | 'update' | 'delete'> {
  const ops = new Set<'create' | 'update' | 'delete'>()
  for (const m of text.matchAll(DELEGATE)) ops.add(m[1] === 'delete' || m[1] === 'deleteMany' ? 'delete' : m[1] === 'create' || m[1] === 'createMany' ? 'create' : 'update')
  for (const m of text.matchAll(SQL)) {
    const kind = m[1]!.toLowerCase().replace(/\s+/g, ' ')
    ops.add(kind === 'insert into' ? 'create' : kind === 'update' ? 'update' : 'delete')
  }
  if (ops.has('create') && ON_CONFLICT_UPDATE.test(text)) ops.add('update')
  return ops
}

/** How many places in the text write the table: Prisma delegate calls and raw statements. */
export function writeSites(text: string): number {
  return [...text.matchAll(DELEGATE)].length + [...text.matchAll(SQL)].length
}

/** How many times the text takes the shared apply lock. */
export function lockSites(text: string): number {
  return [...text.matchAll(/\blockStorefrontMappingWrites\s*\(|pg_advisory_xact_lock_shared/g)].length
}

export function censusFindings(files: ReadonlyMap<string, string>, declared: Readonly<Record<string, Declaration>> = WRITERS): string[] {
  const failures: string[] = []
  const seen = new Set<string>()
  for (const [file, text] of files) {
    const ops = writesOf(text)
    const usesHelper = /\b(upsert|repoint)StorefrontTaxMapping\s*\(/.test(text)
    if (ops.size === 0 && !usesHelper) continue
    seen.add(file)
    const decl = declared[file]
    if (decl === undefined) { failures.push(`UNDECLARED ${file} writes shopping_tax_rate_mappings (${[...ops].join(', ') || 'through the helper'}): declare it in WRITERS with its rule, and clear the ownership stamp when it changes a row's IMS rate or identity snapshot`); continue }
    const changes = ops.has('update')
    if (decl.rule !== 'stamps' && decl.rule !== 'impl' && ops.size > 0 && lockSites(text) < writeSites(text)) failures.push(`LOCK ${file} writes the table directly in ${writeSites(text)} place(s) but takes the shared apply lock (lockStorefrontMappingWrites) ${lockSites(text)} time(s): every writing transaction takes it`)
    if (decl.rule === 'stamps' && !/acquirePinnedAdvisoryLockWaiting\(\s*WOO_TAX_RATE_WRITE_LOCK_KEY/.test(text)) failures.push(`LOCK ${file} stamps rows but does not take the apply lock exclusively`)
    switch (decl.rule) {
      case 'helper':
        if (!usesHelper) failures.push(`HELPER ${file} is declared a helper user but never calls the helper (upsertStorefrontTaxMapping / repointStorefrontTaxMapping)`)
        if (changes) failures.push(`HELPER ${file} changes rows directly (update/upsert) next to the helper: that write keeps a stale stamp`)
        if (ops.has('create')) failures.push(`HELPER ${file} creates rows directly: go through the helper`)
        break
      case 'clears-inline':
        if (decl.token === undefined || !text.includes(decl.token)) failures.push(`CLEARS ${file} changes rows but the text no longer contains ${decl.token ?? '(a token)'}: the stamp must be cleared in the same write`)
        break
      case 'creates-only':
        if (changes || ops.has('delete')) failures.push(`CREATES-ONLY ${file} also updates or deletes rows`)
        break
      case 'removes-only':
        if (changes || ops.has('create')) failures.push(`REMOVES-ONLY ${file} also creates or updates rows`)
        break
      case 'stamps': case 'impl': break
    }
  }
  const impl = files.get('lib/tax/storefront-mapping-write.ts')
  if (impl !== undefined) {
    if (!/pg_advisory_xact_lock_shared\(\$\{WOO_TAX_RATE_WRITE_LOCK_KEY\}/.test(impl)) failures.push('LOCK the helper\'s lockStorefrontMappingWrites no longer takes pg_advisory_xact_lock_shared on WOO_TAX_RATE_WRITE_LOCK_KEY')
    for (const fn of ['upsertStorefrontTaxMapping', 'repointStorefrontTaxMapping']) {
      const body = impl.slice(impl.indexOf(`export async function ${fn}(`))
      const upToNextExport = body.slice(0, body.indexOf('\nexport ', 10) === -1 ? undefined : body.indexOf('\nexport ', 10))
      if (!/await lockStorefrontMappingWrites\(tx\)/.test(upToNextExport)) failures.push(`LOCK the helper's ${fn} does not take the shared apply lock`)
    }
  }
  for (const file of Object.keys(declared)) if (!seen.has(file)) failures.push(`STALE ${file} is declared but no longer writes the table`)
  return failures
}

const ROOT = process.cwd()
const real = new Map<string, string>()
for (const root of ROOTS) for (const path of walk(join(ROOT, root))) real.set(relative(ROOT, path), readFileSync(path, 'utf8'))

test('PRECONDITION: the census reached the tree, found every declared writer, and the real tree is green', () => {
  const found = [...real].filter(([, text]) => writesOf(text).size > 0 || /\b(upsert|repoint)StorefrontTaxMapping\s*\(/.test(text)).map(([file]) => file).sort()
  console.log(`# mapping-writer census: ${real.size} files scanned, ${found.length} writers: ${found.join(', ')}`)
  assert.ok(real.size > 800)
  assert.deepEqual(found, Object.keys(WRITERS).sort())
  assert.deepEqual(censusFindings(real), [])
})

test('MUTATION: a new writer in a new file, in Prisma and in raw SQL, is red until declared', () => {
  const files = new Map(real)
  files.set('lib/new-writer.ts', 'export const f = (tx: any) => tx.shoppingTaxRateMapping.updateMany({ data: { taxRateId: "x" } })')
  assert.equal(censusFindings(files).filter((f) => f.startsWith('UNDECLARED lib/new-writer.ts')).length, 1)
  files.set('lib/new-writer.ts', 'await db.$executeRaw`UPDATE shopping_tax_rate_mappings SET "taxRateId" = ${x}`')
  assert.equal(censusFindings(files).filter((f) => f.startsWith('UNDECLARED lib/new-writer.ts')).length, 1)
  files.set('lib/new-writer.ts', 'insert into "shopping_tax_rate_mappings" (a) values (1)')
  assert.equal(censusFindings(files).filter((f) => f.startsWith('UNDECLARED lib/new-writer.ts')).length, 1)
})

test('MUTATION: each writer that loses its rule is red', () => {
  const mutate = (file: string, edit: (text: string) => string) => { const files = new Map(real); files.set(file, edit(real.get(file)!)); return censusFindings(files) }
  // the import stops using the helper and goes back to a plain upsert
  assert.ok(mutate('lib/connectors/woocommerce/sync/taxes.ts', (t) => t.replace('await upsertStorefrontTaxMapping(', 'await tx.shoppingTaxRateMapping.upsert({ where: {} as never, create: {} as never, update: {} as never }) || (')).some((f) => /^(HELPER|STALE) lib\/connectors\/woocommerce\/sync\/taxes\.ts/.test(f)))
  assert.ok(mutate('lib/connectors/woocommerce/sync/taxes.ts', (t) => t.replaceAll('upsertStorefrontTaxMapping', 'somethingElse')).some((f) => /^(HELPER|STALE) lib\/connectors\/woocommerce\/sync\/taxes\.ts/.test(f)))
  assert.ok(mutate('app/actions/wc-sync.ts', (t) => t.replace('await repointStorefrontTaxMapping(tx,', 'await tx.shoppingTaxRateMapping.update({ where: {} as never, data: {} }) || (tx,')).some((f) => f.startsWith('HELPER app/actions/wc-sync.ts')))
  assert.ok(mutate('scripts/lib/woo-import-driver.ts', (t) => t.replace('upsertStorefrontTaxMapping(tx,', 'tx.shoppingTaxRateMapping.update(')).some((f) => f.startsWith('HELPER scripts/lib/woo-import-driver.ts')))
  // the re-key stops clearing; the copy script's ON CONFLICT DO UPDATE stops clearing
  assert.ok(mutate('lib/tax/tax-rekey.ts', (t) => t.replace('data: { taxRateId: fresh.id, storeIdentity: null }', 'data: { taxRateId: fresh.id }')).some((f) => f.startsWith('CLEARS lib/tax/tax-rekey.ts')))
  assert.ok(mutate('lib/tax/purchase-tax-import.ts', (t) => t.replace('data: { taxRateId: id, storeIdentity: null }', 'data: { taxRateId: id }')).some((f) => f.startsWith('CLEARS lib/tax/purchase-tax-import.ts')))
  assert.ok(mutate('scripts/copy-tax-rates.ts', (t) => t.replaceAll('store_identity', 'something_else')).some((f) => f.startsWith('CLEARS scripts/copy-tax-rates.ts')))
  // a creates-only writer starts updating; a removes-only writer starts creating
  assert.ok(mutate('scripts/commerce-accounting-e2e-fixture.ts', (t) => `${t}\nawait db.shoppingTaxRateMapping.update({ where: {} as never, data: {} })`).some((f) => f.startsWith('CREATES-ONLY')))
  assert.ok(mutate('app/actions/reset.ts', (t) => `${t}\nawait db.shoppingTaxRateMapping.create({ data: {} as never })`).some((f) => f.startsWith('REMOVES-ONLY')))
  // a declared writer that stops writing is stale
  assert.ok(mutate('app/actions/reset.ts', (t) => t.replace('await tx.shoppingTaxRateMapping.deleteMany({})', '')).some((f) => f.startsWith('STALE app/actions/reset.ts')))
})

test('MUTATION: a writer that stops taking the apply lock is red, each one, and so is a helper that stops taking it', () => {
  const mutate = (file: string, edit: (text: string) => string) => { const files = new Map(real); files.set(file, edit(real.get(file)!)); return censusFindings(files) }
  const strip = (t: string) => t.replaceAll('lockStorefrontMappingWrites(', 'somethingElse(').replaceAll('pg_advisory_xact_lock_shared', 'pg_something_else')
  for (const file of ['app/actions/wc-sync.ts', 'lib/tax/tax-rekey.ts', 'lib/tax/purchase-tax-import.ts', 'scripts/copy-tax-rates.ts', 'scripts/commerce-accounting-e2e-fixture.ts', 'app/actions/reset.ts']) {
    assert.ok(mutate(file, strip).some((f) => f.startsWith(`LOCK ${file}`)), file)
  }
  // one of a file's two writes loses its lock while the other keeps it
  assert.ok(mutate('scripts/commerce-accounting-e2e-fixture.ts', (t) => t.replace('    await lockStorefrontMappingWrites(tx)\n    await tx.shoppingTaxRateMapping.createMany(', '    await tx.shoppingTaxRateMapping.createMany(')).some((f) => f.startsWith('LOCK scripts/commerce-accounting-e2e-fixture.ts')))
  assert.ok(mutate('lib/tax/storefront-mapping-write.ts', (t) => t.replace('await lockStorefrontMappingWrites(tx)\n  const rows = await tx.$queryRaw<Array<{ created', 'const rows = await tx.$queryRaw<Array<{ created')).some((f) => f.includes('upsertStorefrontTaxMapping does not take')))
  assert.ok(mutate('lib/tax/storefront-mapping-write.ts', (t) => t.replace('await lockStorefrontMappingWrites(tx)\n  const rows = await tx.$queryRaw<Array<{ id', 'const rows = await tx.$queryRaw<Array<{ id')).some((f) => f.includes('repointStorefrontTaxMapping does not take')))
  assert.ok(mutate('lib/tax/storefront-mapping-write.ts', (t) => t.replace('pg_advisory_xact_lock_shared', 'pg_something_else')).some((f) => f.startsWith('LOCK the helper')))
  assert.ok(mutate('lib/connectors/woocommerce/tax-rate-writer.ts', (t) => t.replaceAll('acquirePinnedAdvisoryLockWaiting(WOO_TAX_RATE_WRITE_LOCK_KEY', 'acquirePinnedAdvisoryLockWaiting(1')).some((f) => f.startsWith('LOCK lib/connectors/woocommerce/tax-rate-writer.ts')))
  // a brand-new writer that is declared but takes no lock is red
  const files = new Map(real)
  files.set('lib/new-writer.ts', 'export const f = (tx: any) => tx.shoppingTaxRateMapping.updateMany({ data: { storeIdentity: null } })')
  assert.equal(censusFindings(files, { ...WRITERS, 'lib/new-writer.ts': { rule: 'clears-inline', token: 'storeIdentity: null', why: 'x' } }).filter((f) => f.startsWith('LOCK lib/new-writer.ts')).length, 1)
})

test('the scanner sees what it claims to: Prisma delegates, raw SQL in each form, and ON CONFLICT DO UPDATE as an update; reads and prose are not writes', () => {
  assert.deepEqual([...writesOf('db.shoppingTaxRateMapping.createMany({})')], ['create'])
  assert.deepEqual([...writesOf('db.shoppingTaxRateMapping.deleteMany({})')], ['delete'])
  assert.deepEqual([...writesOf('insert into shopping_tax_rate_mappings (a) values (1) on conflict (a) do update set b = 1')].sort(), ['create', 'update'])
  assert.deepEqual([...writesOf('DELETE   FROM "shopping_tax_rate_mappings" WHERE 1=1')], ['delete'])
  assert.deepEqual([...writesOf('db.shoppingTaxRateMapping.findMany({}); db.shoppingTaxRateMapping.count({}) // shopping_tax_rate_mappings')], [])
})
