import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildGuardedCsv } from '../../lib/csv-escape.ts'
import { toCsv } from '../../lib/csv.ts'

test('buildGuardedCsv neutralises formula cells, keeps numbers, quotes commas', () => {
  const csv = buildGuardedCsv(['Name', 'Qty'], [['=HYPERLINK("http://x")', -5], ['@SUM(1)', 3], ['a,b', 1.5], ['+cmd', '-2.5']])
  assert.equal(csv.split('\n')[1], `"'=HYPERLINK(""http://x"")",-5`)
  assert.equal(csv.split('\n')[2], "'@SUM(1),3")
  assert.equal(csv.split('\n')[3], '"a,b",1.5')
  assert.equal(csv.split('\n')[4], "'+cmd,-2.5")
})

test('the shared guard is the one toCsv uses', () => {
  assert.equal(toCsv([{ a: '=1+1' }], ['a']), 'a\r\n\'=1+1')
})

for (const file of [
  'app/(dashboard)/manufacturing/manufacturing-client.tsx',
  'app/(dashboard)/analytics/product-profitability/product-profitability-client.tsx',
]) {
  test(`${file} builds its CSV through the guarded helper`, () => {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    assert.match(src, /buildGuardedCsv\(/)
    assert.doesNotMatch(src, /\]\.join\(','\)/, 'no hand-joined CSV rows')
    assert.doesNotMatch(src, /`"\$\{r\.(name|productName)/, 'no hand-quoted free-text cells')
  })
}
