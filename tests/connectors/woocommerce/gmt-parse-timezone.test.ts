/**
 * WooCommerce's GMT fields have no zone suffix. `new Date("2026-10-02T02:00:00")` reads such a string in the SERVER's zone, so under a non-UTC TZ the persisted order dates shift and
 * the same-day test of the settlement rate misfires near UTC midnight. Every WooCommerce date field is read through parseWcGmtInstant (as UTC).
 * [mutation: restore `new Date(<wc field>)` at any site: the source guard fails]
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parseWcGmtInstant, utcCalendarDate } from '../../../lib/connectors/woocommerce/sync/receipt-settlement-rate.ts'

test('under America/Los_Angeles a suffix-less GMT string read with new Date() SHIFTS; parseWcGmtInstant does not (printed)', (t) => {
  const before = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const raw = '2026-10-02T02:00:00' // 2026-10-02 02:00 GMT = 2026-10-01 19:00 in Los Angeles
    const naive = new Date(raw)
    const parsed = parseWcGmtInstant(raw)
    t.diagnostic(`TZ=${process.env.TZ}: new Date(raw) = ${naive.toISOString()}, parseWcGmtInstant(raw) = ${parsed.toISOString()}`)
    assert.notEqual(naive.toISOString(), parsed.toISOString(), 'PRECONDITION: the zone really changes the naive parse')
    assert.equal(parsed.toISOString(), '2026-10-02T02:00:00.000Z')
    assert.equal(utcCalendarDate(parsed), '2026-10-02')
    // the same-day test near UTC midnight: created 2026-10-02T00:30Z, paid 2026-10-02T23:30Z are the SAME UTC day whatever the server zone
    assert.equal(utcCalendarDate(parseWcGmtInstant('2026-10-02T00:30:00')), utcCalendarDate(parseWcGmtInstant('2026-10-02T23:30:00')))
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})

test('no WooCommerce connector source reads a WooCommerce date string with new Date()', (t) => {
  const roots = ['lib/connectors/woocommerce']
  const files: string[] = []
  const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p) } }
  for (const r of roots) walk(r)
  t.diagnostic(`files scanned: ${files.length}`)
  assert.ok(files.length > 10)
  const bad: string[] = []
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/new Date\(\s*(?:`[^`]*`|[A-Za-z_.()]*(?:\.date_[a-z_]+|date_[a-z_]+))/.test(line) && /date_(created|paid|modified|completed)/.test(line)) bad.push(`${f}:${i + 1}`)
    })
  }
  assert.deepEqual(bad, [])
})
