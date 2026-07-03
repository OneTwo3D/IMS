import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as validateNs from '../lib/trade/hs-validate.ts'

const hs = 'default' in validateNs
  ? validateNs.default as typeof import('../lib/trade/hs-validate.ts')
  : validateNs

// ── Cross-language contract parity ──────────────────────────────────────────
// Reuse the hs-code-woo shared fixture (tests/fixtures/cn-vectors.json) and its sample CN
// reference (sample-cn2026.csv) so this TS port stays behaviourally identical to the PHP/Python
// validators. Edit those fixtures upstream, not here.
const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

function loadSampleStatus(): (code: string) => validateNs.HsCodeStatus {
  const lines = readFileSync(fixturePath('sample-cn2026.csv'), 'utf8').split(/\r?\n/)
  lines.shift() // header: code,description,status,superseded_by
  const byCode = new Map<string, validateNs.HsCodeStatus>()
  for (const line of lines) {
    if (!line.trim()) continue
    const fields = line.split(',')
    const code = (fields[0] ?? '').trim()
    // description (field 1) may contain commas; status is second-from-last.
    const status = (fields[fields.length - 2] ?? 'current').trim()
    byCode.set(code, status === 'superseded' ? 'superseded' : status === 'current' ? 'current' : 'absent')
  }
  return (code: string) => byCode.get(code) ?? 'absent'
}

test('validateHsCode matches every cross-language contract vector', () => {
  const fixture = JSON.parse(readFileSync(fixturePath('cn-vectors.json'), 'utf8')) as {
    config: {
      category_map: Record<string, string[]>
      parts_basket_prefixes: string[]
      own_heading_keywords: Record<string, string>
      brand_words: string[]
    }
    vectors: Array<{
      name: string
      row: { cn_code?: string; customs_description?: string; name?: string; category_path?: string; text?: string }
      expected: { confidence: number; band: string; flags: string[] }
    }>
  }

  const config: validateNs.HsValidationConfig = {
    categoryMap: fixture.config.category_map,
    partsBasketPrefixes: fixture.config.parts_basket_prefixes,
    ownHeadingKeywords: fixture.config.own_heading_keywords,
    brandWords: fixture.config.brand_words,
    codeStatus: loadSampleStatus(),
  }

  for (const vector of fixture.vectors) {
    const result = hs.validateHsCode(
      {
        cnCode: vector.row.cn_code,
        customsDescription: vector.row.customs_description,
        name: vector.row.name,
        categoryPath: vector.row.category_path,
        text: vector.row.text,
      },
      config,
    )
    assert.deepEqual(
      { confidence: result.confidence, band: result.band, flags: result.flags },
      vector.expected,
      `vector: ${vector.name}`,
    )
  }
})

// ── Unit checks against the production 2026 reference ───────────────────────
test('a clean current code with a good description scores high with no blocking flags', () => {
  const r = hs.validateHsCode({
    cnCode: '85011099',
    customsDescription: 'electric stepper motor',
    name: 'NEMA 17',
    categoryPath: 'Stepper motors', // matches DEFAULT_CATEGORY_MAP -> heading 8501 (+20 -> 100)
  })
  assert.equal(r.band, 'high')
  assert.deepEqual(r.writeBlockingFlags, [])
})

test('an absent code is flagged not_in_2026 and blocks a write', () => {
  const r = hs.validateHsCode({ cnCode: '99999999', customsDescription: 'aluminium heatsink block' })
  assert.ok(r.flags.includes('not_in_2026'))
  assert.deepEqual(r.writeBlockingFlags, ['not_in_2026'])
  assert.equal(r.band, 'low')
})

test('writeBlockingFlags selects only the write-blocking subset', () => {
  assert.deepEqual(hs.writeBlockingFlags(['category_mismatch', 'not_in_2026', 'description_problem']), ['not_in_2026'])
  assert.deepEqual(hs.writeBlockingFlags(['category_mismatch']), [])
})

test('a short malformed code is both invalid_format and not_in_2026, and blocks a write', () => {
  const r = hs.validateHsCode({ cnCode: '850110', customsDescription: 'electric stepper motor' })
  assert.ok(r.flags.includes('invalid_format'))
  assert.ok(r.flags.includes('not_in_2026'))
  assert.equal(r.declarable, false)
  assert.deepEqual(r.writeBlockingFlags, ['invalid_format', 'not_in_2026'])
  assert.equal(r.normalizedCode, '850110')
})

test('an overlong code scores clean (lenient) but declarable:false must still block it (F1 contract)', () => {
  const r = hs.validateHsCode({ cnCode: '8501109900', customsDescription: 'electric stepper motor', categoryPath: 'Stepper motors' })
  // Lenient first-8 truncation means no invalid_format / no write-blocking flag...
  assert.deepEqual(r.writeBlockingFlags, [])
  assert.equal(r.normalizedCode, '85011099')
  // ...but the strict gate rejects the raw 10-digit code, which is what an approval must honour.
  assert.equal(r.declarable, false)
})

test('brand-only and stop-word descriptions are flagged; a real article passes', () => {
  assert.equal(hs.descriptionIsBrandOnly('Voron LDO'), true)
  assert.equal(hs.descriptionIsBrandOnly('brass nozzle'), false)
  assert.equal(hs.descriptionPasses('parts for printers'), false) // stop word "parts"
  assert.equal(hs.descriptionPasses('brass nozzle'), true)
})
