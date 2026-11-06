import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Zone-less Mintsoft despatch datetimes are read as Europe/London local time in the pre-cutover verification ONLY. Pure functions,
 * no database. The result must not depend on the host timezone (CI runs these under TZ=UTC and TZ=Europe/London).
 */

const LONDON = { zoneless: 'europe-london' } as const

async function mod() {
  return import('@/lib/domain/wms/dispatch-sweep')
}

test('summer: a zone-less value is BST (UTC+1)', async () => {
  const { preciseDespatchInstant } = await mod()
  assert.equal(preciseDespatchInstant('2026-07-15T09:00:00', LONDON)?.toISOString(), '2026-07-15T08:00:00.000Z')
})

test('winter: a zone-less value is GMT (UTC+0)', async () => {
  const { preciseDespatchInstant } = await mod()
  assert.equal(preciseDespatchInstant('2026-01-15T09:00:00', LONDON)?.toISOString(), '2026-01-15T09:00:00.000Z')
})

test('the clock-change days either side of the change convert correctly', async () => {
  const { preciseDespatchInstant } = await mod()
  assert.equal(preciseDespatchInstant('2026-03-29T00:59:59', LONDON)?.toISOString(), '2026-03-29T00:59:59.000Z') // last GMT second
  assert.equal(preciseDespatchInstant('2026-03-29T02:00:00', LONDON)?.toISOString(), '2026-03-29T01:00:00.000Z') // first BST second
  assert.equal(preciseDespatchInstant('2026-10-25T00:59:59', LONDON)?.toISOString(), '2026-10-24T23:59:59.000Z') // still BST
  assert.equal(preciseDespatchInstant('2026-10-25T02:00:00', LONDON)?.toISOString(), '2026-10-25T02:00:00.000Z') // GMT again
})

test('spring-forward gap: a local time that does not exist is unknown', async () => {
  const { preciseDespatchInstant } = await mod()
  assert.equal(preciseDespatchInstant('2026-03-29T01:30:00', LONDON), null)
  assert.equal(preciseDespatchInstant('2026-03-29T01:00:00', LONDON), null)
  assert.equal(preciseDespatchInstant('2026-03-29T01:59:59', LONDON), null)
})

test('autumn fall-back hour: a local time that happens twice is unknown', async () => {
  const { preciseDespatchInstant } = await mod()
  assert.equal(preciseDespatchInstant('2026-10-25T01:30:00', LONDON), null)
  assert.equal(preciseDespatchInstant('2026-10-25T01:00:00', LONDON), null)
  assert.equal(preciseDespatchInstant('2026-10-25T01:59:59', LONDON), null)
})

test('fractions and the space separator are handled', async () => {
  const { preciseDespatchInstant } = await mod()
  assert.equal(preciseDespatchInstant('2026-07-15T09:00:00.123', LONDON)?.toISOString(), '2026-07-15T08:00:00.123Z')
  assert.equal(preciseDespatchInstant('2026-07-15T09:00:00.1234567', LONDON)?.toISOString(), '2026-07-15T08:00:00.123Z')
  assert.equal(preciseDespatchInstant('2026-07-15 09:00:00', LONDON)?.toISOString(), '2026-07-15T08:00:00.000Z')
  assert.equal(preciseDespatchInstant('2026-01-15 09:00:00.5', LONDON)?.toISOString(), '2026-01-15T09:00:00.500Z')
  assert.equal(preciseDespatchInstant('2026-07-15T09:00', LONDON)?.toISOString(), '2026-07-15T08:00:00.000Z')
})

test('values with Z or an offset keep their behaviour, with or without the reading', async () => {
  const { preciseDespatchInstant } = await mod()
  for (const options of [undefined, LONDON]) {
    assert.equal(preciseDespatchInstant('2026-07-15T09:00:00Z', options)?.toISOString(), '2026-07-15T09:00:00.000Z')
    assert.equal(preciseDespatchInstant('2026-07-15T09:00:00+01:00', options)?.toISOString(), '2026-07-15T08:00:00.000Z')
    assert.equal(preciseDespatchInstant('2026-07-15T09:00:00-0500', options)?.toISOString(), '2026-07-15T14:00:00.000Z')
    // a zoned value in the clock-change hour is still an instant: the zone is explicit
    assert.equal(preciseDespatchInstant('2026-03-29T01:30:00Z', options)?.toISOString(), '2026-03-29T01:30:00.000Z')
  }
})

test('date-only, impossible and malformed values stay unknown even with the reading', async () => {
  const { preciseDespatchInstant } = await mod()
  for (const bad of ['2026-07-15', '2026-02-31T09:00:00', '2026-07-15T25:00:00', '2026-07-15T09:60:00', '2026-07-15T', 'x', '', null, undefined]) {
    assert.equal(preciseDespatchInstant(bad, LONDON), null, String(bad))
  }
})

test('without the reading (any non-Mintsoft source) a zone-less value is unknown', async () => {
  const { preciseDespatchInstant, strictLatestDespatchTime } = await mod()
  assert.equal(preciseDespatchInstant('2026-07-15T09:00:00'), null)
  assert.equal(preciseDespatchInstant('2026-07-15T09:00:00', {}), null)
  assert.equal(strictLatestDespatchTime([{ despatchedAt: '2026-07-15T09:00:00' }]), null)
})

test('the production deps carry the reading for Mintsoft only', async () => {
  const { createPrismaDispatchDeps } = await mod()
  assert.equal(createPrismaDispatchDeps('mintsoft' as never, {} as never).zonelessDespatchReading, 'europe-london')
  assert.equal(createPrismaDispatchDeps('other' as never, {} as never).zonelessDespatchReading, undefined)
})

test('strictLatestDespatchTime: mixed zoned and zone-less entries compare as instants; one unknown makes it unknown', async () => {
  const { strictLatestDespatchTime } = await mod()
  assert.equal(
    strictLatestDespatchTime([{ despatchedAt: '2026-07-15T09:00:00' }, { despatchedAt: '2026-07-15T08:30:00Z' }], LONDON)?.toISOString(),
    '2026-07-15T08:30:00.000Z',
  )
  assert.equal(strictLatestDespatchTime([{ despatchedAt: '2026-07-15T09:00:00' }, { despatchedAt: '2026-07-15T08:30:00Z' }])?.toISOString(), undefined)
  assert.equal(strictLatestDespatchTime([{ despatchedAt: '2026-07-15T09:00:00' }, { despatchedAt: '2026-10-25T01:30:00' }], LONDON), null)
  assert.equal(strictLatestDespatchTime([{ despatchedAt: '2026-07-15T09:00:00' }, { despatchedAt: '2026-07-15' }], LONDON), null)
  assert.equal(strictLatestDespatchTime([], LONDON), null)
})
