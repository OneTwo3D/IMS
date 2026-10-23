import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  PACK_SCHEDULE_CHILD_TIMEOUT_MS, PACK_SCHEDULE_DEFAULT_CRON, PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_FAILURES, PACK_SCHEDULE_NOT_A_FAULT_CODES,
  PACK_SCHEDULE_PHASE_SETTING, PACK_SCHEDULE_RECORD_ACTION, PACK_SCHEDULE_RECORD_FIELDS, PACK_SCHEDULE_REFUSALS, PACK_SCHEDULE_SLUG,
  PACK_SCHEDULE_VENDOR_READS_SETTING, PACK_SCHEDULE_VENDOR_WINDOW_MS,
} from '../../lib/reconciliation-pack/schedule-constants'

/** The operator documentation says what the code does: the closed codes, the settings, the defaults and the limits are compared with the constants. */
const doc = readFileSync('docs/installation.md', 'utf8')
const start = doc.indexOf('### Scheduling the pack')
const section = doc.slice(start, doc.indexOf('\n## ', start))

test('the section exists and names the job, its route, its settings and its record action', () => {
  assert.ok(start > 0 && section.length > 2000)
  for (const text of [PACK_SCHEDULE_SLUG, `/api/cron/${PACK_SCHEDULE_SLUG}`, PACK_SCHEDULE_ENABLED_SETTING, PACK_SCHEDULE_PHASE_SETTING, PACK_SCHEDULE_VENDOR_READS_SETTING, PACK_SCHEDULE_RECORD_ACTION]) {
    assert.ok(section.includes(`\`${text}\``) || section.includes(text), text)
  }
  assert.match(section, /\*\*It is off by default\*\*/)
  assert.match(section, /\*\*There is no default phase\*\*/)
  assert.match(section, /\*\*Off even when the schedule is on\.\*\*/)
  assert.match(section, /daily at 03:00/)
  assert.equal(PACK_SCHEDULE_DEFAULT_CRON, '0 3 * * *')
})

test('every closed code of the job is in the documented table with its exact sentence, and the table has no other row', () => {
  const codes = { ...PACK_SCHEDULE_REFUSALS, ...PACK_SCHEDULE_FAILURES }
  const rows = section.split('\n').filter((line) => /^\| [A-Z][A-Z_]+ \| /.test(line))
  console.log(`# documented codes: ${rows.length}, defined: ${Object.keys(codes).length}`)
  assert.equal(rows.length, Object.keys(codes).length)
  for (const [code, meaning] of Object.entries(codes)) assert.ok(rows.includes(`| ${code} | ${meaning} |`), code)
})

test('every record field is documented, the level rule names exactly the faults-not codes, and the limits equal the constants', () => {
  for (const { field } of PACK_SCHEDULE_RECORD_FIELDS) assert.ok(section.includes(`\`${field}\``), field)
  for (const code of PACK_SCHEDULE_NOT_A_FAULT_CODES) assert.ok(section.includes(`\`${code}\``), code)
  assert.equal(PACK_SCHEDULE_CHILD_TIMEOUT_MS, 45 * 60 * 1000)
  assert.match(section, /45 minutes/)
  assert.equal(PACK_SCHEDULE_VENDOR_WINDOW_MS, 20 * 60 * 60 * 1000)
  assert.match(section, /20 hours/)
  // the cron tables list the route
  assert.ok(doc.includes('`/api/cron/reconciliation-pack` | Run the whole reconciliation pack'))
  assert.ok(readFileSync('docs/settings.md', 'utf8').includes('`/api/cron/reconciliation-pack`'))
})
