import assert from 'node:assert/strict'
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { afterEach } from 'node:test'

import { SKU_EXCLUSION_DEFAULT_FILE, SKU_EXCLUSION_MAX_ENTRIES } from '../../lib/reconciliation-pack/constants.ts'
import { exclusionsInForce, loadSkuExclusions, parseSkuExclusionFile } from '../../lib/reconciliation-pack/sku-exclusions.ts'
import { NOW, cleanup, scratchDir } from './helpers.ts'

/** THE SKU EXCLUSION FILE: format, expiry and trust (D8). Mutations are listed in the PR. */

const bases: string[] = []
afterEach(() => cleanup(bases))
const entry = (over: Record<string, unknown> = {}) => ({ sku: 'SKU-1', system: 'woocommerce', acceptedBy: 'owner', acceptedAt: '2026-10-01T00:00:00Z', reason: 'discontinued on the shop', expiresAt: '2026-12-01T00:00:00Z', ...over })
const file = (rows: unknown[]) => JSON.stringify({ schemaVersion: 1, exclusions: rows })

// [mutation: the 90-day cap, the expiry test, the acceptedAt test, or the reason length removed]
test('an entry is in force from acceptedAt until expiresAt (exclusive), expires within 90 days, and says who and why', () => {
  const parsed = parseSkuExclusionFile(file([entry()]))
  assert.equal(parsed.status, 'ok')
  assert.equal(exclusionsInForce(parsed, NOW).length, 1)
  assert.equal(exclusionsInForce(parsed, new Date('2026-12-01T00:00:00.000Z')).length, 0, 'expired at the instant')
  assert.equal(exclusionsInForce(parsed, new Date('2026-11-30T23:59:59.999Z')).length, 1)
  assert.equal(exclusionsInForce(parsed, new Date('2026-10-01T00:00:00.000Z')).length, 1, 'in force from the instant accepted')
  assert.equal(exclusionsInForce(parsed, new Date('2026-09-30T23:59:59.999Z')).length, 0, 'not before it was accepted')
  assert.equal(exclusionsInForce(parsed, new Date(NaN)).length, 0)
  const ninety = (days: number) => parseSkuExclusionFile(file([entry({ expiresAt: new Date(Date.parse('2026-10-01T00:00:00Z') + days * 86_400_000).toISOString() })]))
  assert.equal((ninety(90) as { entries: unknown[] }).entries.length, 1, 'exactly 90 days')
  assert.equal((ninety(90.0001) as { entries: unknown[] }).entries.length, 0, 'a moment past 90 days accepts nothing')
  for (const over of [{ acceptedBy: '' }, { acceptedBy: 3 }, { reason: 'short' }, { reason: 7 }, { acceptedAt: 'yesterday' }, { acceptedAt: '2026-10-01' }, { expiresAt: '2026-10-01T00:00:00Z' }, { expiresAt: '2026-09-01T00:00:00Z' }, { expiresAt: null }, { system: 'xero' }, { system: 'WooCommerce' }, { sku: '' }, { sku: ' SKU-1' }, { sku: 'SKU​-1' }, { sku: 12 }]) {
    const p = parseSkuExclusionFile(file([entry(over)]))
    assert.equal(p.status, 'ok', JSON.stringify(over))
    assert.equal(p.entries.length, 0, `accepts nothing: ${JSON.stringify(over)}`)
  }
})

// [mutation: a rejection reduced to a per-entry skip]
test('the whole file is rejected, and accepts nothing, for an unknown field, another version, a repeated (SKU, system), too many entries or invalid JSON; one SKU in two systems is fine', () => {
  for (const text of ['', '{', 'null', '[]', '"x"', JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 0, exclusions: [] }), JSON.stringify({ schemaVersion: 1, exclusions: [], note: 'x' }), file([entry({ note: 'x' })]), file([entry(), entry({ reason: 'another long enough reason' })]), file([entry(), 'x']), file([null])]) {
    const p = parseSkuExclusionFile(text)
    assert.equal(p.status, 'rejected', text.slice(0, 40))
    assert.equal(p.entries.length, 0)
    assert.equal(exclusionsInForce(p, NOW).length, 0)
  }
  const many = parseSkuExclusionFile(JSON.stringify({ schemaVersion: 1, exclusions: Array.from({ length: SKU_EXCLUSION_MAX_ENTRIES + 1 }, (_, i) => entry({ sku: `S${i}` })) }))
  assert.equal(many.status, 'rejected')
  const twoSystems = parseSkuExclusionFile(file([entry(), entry({ system: 'mintsoft' })]))
  assert.equal(twoSystems.status === 'ok' && twoSystems.entries.length, 2)
  assert.equal(parseSkuExclusionFile(null).status, 'absent')
  assert.equal(exclusionsInForce(parseSkuExclusionFile(null), NOW).length, 0)
})

// [mutation: readTrustedRegularFile replaced by a plain read]
test('trust: a named file that is group- or other-writable is read as nothing; a named symlink or missing file is a refusal; the default path missing is none', () => {
  const dir = scratchDir(bases)
  const good = path.join(dir, 'e.json')
  writeFileSync(good, file([entry()]), { mode: 0o644 })
  const loaded = loadSkuExclusions(good, '/var/tmp')
  assert.ok('file' in loaded && loaded.file.status === 'ok' && loaded.file.entries.length === 1)
  chmodSync(good, 0o666)
  const writable = loadSkuExclusions(good, '/var/tmp')
  assert.ok('file' in writable && writable.file.status === 'rejected' && writable.file.entries.length === 0)
  chmodSync(good, 0o644)
  const link = path.join(dir, 'link.json')
  symlinkSync(good, link)
  const viaLink = loadSkuExclusions(link, '/var/tmp')
  assert.deepEqual(viaLink, { refused: true }, 'a symlink is never followed: a named one cannot be opened')
  assert.deepEqual(loadSkuExclusions(path.join(dir, 'missing.json'), '/var/tmp'), { refused: true })
  // a directory in place of the file is not a regular file: read as nothing, never as a list
  const asDirectory = loadSkuExclusions(dir, '/var/tmp')
  assert.ok('file' in asDirectory && asDirectory.file.status === 'rejected')
  // the default path under a repo root that has none is "none"
  const none = loadSkuExclusions(null, dir)
  assert.ok('file' in none && none.file.status === 'absent')
  assert.ok(SKU_EXCLUSION_DEFAULT_FILE.startsWith('ops/'))
})

test('an oversized named file is a refusal and a default one is rejected (read as nothing)', () => {
  const dir = scratchDir(bases)
  const big = path.join(dir, 'big.json')
  writeFileSync(big, ' '.repeat(9 * 1024 * 1024), { mode: 0o644 })
  assert.deepEqual(loadSkuExclusions(big, '/var/tmp'), { refused: true })
})
