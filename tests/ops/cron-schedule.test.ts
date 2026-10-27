import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isValidCronSchedule, validateCronSchedule } from '../../lib/crontab-sync.ts'

const ok = (schedule: string) => assert.equal(isValidCronSchedule(schedule), true, schedule)
const bad = (schedule: string, field: string, why?: RegExp) => {
  const check = validateCronSchedule(schedule)
  assert.equal(check.ok, false, schedule)
  if (!check.ok) {
    assert.equal(check.field, field, schedule)
    if (why) assert.match(check.error, why, schedule)
  }
}

test('every field accepts its lowest and highest value', () => {
  ok('0 0 1 1 0')
  ok('59 23 31 12 7')
})

test('values one past the end of a field are rejected, naming the field', () => {
  bad('60 * * * *', 'minute', /out of range \(0-59\)/)
  bad('* 24 * * *', 'hour', /out of range \(0-23\)/)
  bad('* * 32 * *', 'day of month', /out of range \(1-31\)/)
  bad('* * 0 * *', 'day of month')
  bad('* * * 13 *', 'month', /out of range \(1-12\)/)
  bad('* * * 0 *', 'month')
  bad('* * * * 8', 'day of week', /out of range \(0-7\)/)
  bad('99 * * * *', 'minute')
})

test('lists, ranges and steps are accepted when every number is in range', () => {
  for (const s of ['*/5 * * * *', '0,15,30,45 * * * *', '10-20 * * * *', '10-20/5 * * * *', '*/15 */2 * * *', '0 1-5 * * 1-5', '0 0 1,15 * *', '*/59 * * * *']) ok(s)
})

test('a step of 0, a step on a single value, a reversed range and malformed fields are rejected', () => {
  bad('*/0 * * * *', 'minute', /step of 0/)
  bad('0-30/0 * * * *', 'minute', /step of 0/)
  bad('5/10 * * * *', 'minute', /step on a single value/)
  bad('30-10 * * * *', 'minute', /reversed range/)
  bad('1-2-3 * * * *', 'minute')
  bad('1,,2 * * * *', 'minute')
  bad('*/ * * * *', 'minute')
  bad('-5 * * * *', 'minute')
  bad('*/60 * * * *', 'minute', /step larger than 59/)
  bad('0-60 * * * *', 'minute', /out of range/)
})

test('the format is exactly five single-space-separated fields; names and macros are not supported (as before)', () => {
  bad('* * * *', 'schedule')
  bad('* * * * * *', 'schedule')
  bad('*  * * * *', 'schedule')
  bad('', 'schedule')
  bad('@hourly', 'schedule')
  bad('0 0 * jan *', 'month')
  bad('0 0 * * sun', 'day of week')
})
