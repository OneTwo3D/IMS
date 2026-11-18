import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ERASURE_CLASSIFICATION } from '../../lib/domain/erasure/erasure-classification.ts'
import { UNGUARDED_FREE_TEXT } from '../../lib/domain/erasure/free-text-guard.ts'

/**
 * WRITER CENSUS. The two custom-field tables have exactly the writers named here. A new writer must be added on purpose, because every
 * value write has to go through the one validator (typed parse, choices, required, erased-order refusal) and every definition write through
 * the one rule set (type fixed once values exist).
 */
const root = process.cwd()

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name === '.next') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const files = ['app', 'lib', 'components'].flatMap((d) => walk(path.join(root, d)))

function census(delegate: string): Record<string, number> {
  const found: Record<string, number> = {}
  const pattern = new RegExp(`\\b${delegate}\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(`, 'g')
  for (const file of files) {
    const hits = readFileSync(file, 'utf8').match(pattern)
    if (hits) found[path.relative(root, file)] = hits.length
  }
  return found
}

test('customFieldValue is written only by the value service (two upserts, one deleteMany) and by the erasure (deleteMany)', () => {
  assert.deepEqual(census('customFieldValue'), {
    'lib/custom-fields/values-service.ts': 3,
    'lib/domain/erasure/erase-personal-data.ts': 1,
  })
})

test('customFieldDefinition is written only by the definitions service (create, update, delete)', () => {
  assert.deepEqual(census('customFieldDefinition'), { 'lib/custom-fields/definitions-service.ts': 3 })
})

test('no raw SQL writes either table (the only raw statements are row locks)', () => {
  const offenders: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+"?custom_field_(values|definitions)"?/gi)) offenders.push(`${path.relative(root, file)}: ${m[0]}`)
  }
  assert.deepEqual(offenders, [])
})

test('every exported action of app/actions/custom-fields.ts asks for a permission first', () => {
  const source = readFileSync(path.join(root, 'app/actions/custom-fields.ts'), 'utf8')
  const bodies = source.split(/^export async function /m).slice(1)
  assert.ok(bodies.length >= 6, 'the actions were found')
  for (const body of bodies) {
    const name = body.slice(0, body.indexOf('('))
    const open = body.indexOf('{\n', body.indexOf(')'))
    const firstStatement = body.slice(open + 2).trimStart().split('\n')[0]!
    assert.match(firstStatement, /requirePermission\(/, `${name} must start with requirePermission`)
  }
})

test('no custom-field code reaches a storefront, warehouse or ledger connector (values are never pushed)', () => {
  for (const file of ['lib/custom-fields/values.ts', 'lib/custom-fields/values-service.ts', 'lib/custom-fields/definitions-service.ts', 'lib/custom-fields/filter.ts', 'app/actions/custom-fields.ts']) {
    const text = readFileSync(path.join(root, file), 'utf8')
    assert.ok(!/@\/lib\/(connectors|shopping|accounting)|fetch\(/.test(text), `${file} imports a connector or calls fetch`)
  }
})

test('ERASURE: the sales-order values are classified erased, the free-text column is accounted for, and the erasure deletes the rows', () => {
  const entry = ERASURE_CLASSIFICATION.CustomFieldValue
  assert.ok(entry, 'CustomFieldValue is classified')
  assert.deepEqual([...entry!.erased].sort(), ['valueJson', 'valueText'])
  assert.ok('CustomFieldValue.valueText' in UNGUARDED_FREE_TEXT)
  const erase = readFileSync(path.join(root, 'lib/domain/erasure/erase-personal-data.ts'), 'utf8')
  assert.match(erase, /tx\.customFieldValue\.deleteMany\(\{ where: \{ salesOrderId: \{ in: ids \} \} \}\)/)
})
