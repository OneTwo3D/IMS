import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * A BASE-CURRENCY CHANGE DECIDES WHETHER IT IS REFUSED ONLY INSIDE THE FX TABLE LOCK (app/actions/company.ts updateOrganisation).
 * Two requests change the base to the same code. The second one is held up (a pooled connection that is slow to arrive, a queue for the lock) AFTER it has read the base currency and BEFORE it
 * reads the lock marker. The first one commits in that gap and sets the marker. A check made outside the lock then finds "marker set, and the base I saw is not the target" and refuses a request
 * that, under the lock, is no change at all. The gap is forced here (the pre-lock read of the marker is parked until the first request has finished), so the failure does not depend on timing.
 * Real Postgres. Mutation: write the lock marker after the lock transaction, or not at all -> a queued different-base change is applied as well; put a base / marker check back before the lock -> the second request is refused; read the in-lock state off the global client -> the lock holder asks the pool for a second
 * connection; drop the in-lock marker check -> the lock test refuses nothing.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

async function waitingOnAdvisoryLock(db: { $queryRaw: <T>(q: TemplateStringsArray) => Promise<T> }): Promise<number> {
  let waiting = 0
  for (let i = 0; i < 100 && waiting === 0; i++) {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
    waiting = Number(rows[0]?.n ?? 0)
    if (waiting === 0) await new Promise((r) => setTimeout(r, 50))
  }
  return waiting
}

test('a base change that read the old base before an earlier identical change committed is not refused by the lock marker that change set', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { withFxTableWriteLock } = await import('@/lib/currencies/fx-table-lock')
  const realBaseCurrency = await import('@/lib/base-currency')
  // The lock marker alone decides here (the rest of the tier leaves master data behind). A pre-lock read (no client) of the FIRST caller that reaches it parks on the gate; every other read is plain.
  const gate: { armed: boolean; parked: Promise<void>; release: () => void } = { armed: false, parked: Promise.resolve(), release: () => {} }
  let signalParked: () => void = () => {}
  const markerLocked = async (client?: typeof db) => (await (client ?? db).setting.findUnique({ where: { key: 'base_currency_locked' } }))?.value === 'true'
  mock.module('@/lib/base-currency', {
    namedExports: {
      ...realBaseCurrency,
      isBaseCurrencyLocked: async (client?: typeof db) => {
        if (!client && gate.armed) {
          gate.armed = false
          const released = new Promise<void>((r) => { gate.release = r })
          signalParked()
          await released
        }
        return markerLocked(client)
      },
    },
  })
  const { updateOrganisation } = await import('@/app/actions/company')

  const orgExisted = await db.organisation.findFirst({ select: { id: true, baseCurrency: true } })
  const org = orgExisted ?? await db.organisation.create({ data: { name: 'Base lock test org', baseCurrency: 'GBP' }, select: { id: true, baseCurrency: true } })
  const lockedSetting = await db.setting.findUnique({ where: { key: 'base_currency_locked' } })
  const sourceKeys = ['fx_rate_source', 'fx_rate_source_since', 'fx_rate_source_history']
  const savedSource = await db.setting.findMany({ where: { key: { in: sourceKeys } } })
  const gbpExisted = (await db.currency.count({ where: { code: 'GBP' } })) > 0
  const aud = await db.currency.findUnique({ where: { code: 'AUD' } })
  t.after(async () => {
    gate.release()
    if (orgExisted) await db.organisation.update({ where: { id: org.id }, data: { baseCurrency: org.baseCurrency } })
    else await db.organisation.deleteMany({ where: { id: org.id } })
    if (!gbpExisted) await db.currency.deleteMany({ where: { code: 'GBP' } })
    if (aud) await db.currency.update({ where: { code: 'AUD' }, data: { active: aud.active } })
    else await db.currency.deleteMany({ where: { code: 'AUD' } })
    await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
    for (const s of [...savedSource, ...(lockedSetting ? [lockedSetting] : [])]) await db.setting.create({ data: { key: s.key, value: s.value } })
  })

  // PRECONDITION: base GBP, unlocked, FX source not Aelia
  await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
  await db.organisation.updateMany({ data: { baseCurrency: 'GBP' } })
  await db.currency.upsert({ where: { code: 'GBP' }, update: {}, create: { code: 'GBP', name: 'GBP', symbol: 'GBP', active: true } })
  await db.currency.upsert({ where: { code: 'AUD' }, update: { active: false }, create: { code: 'AUD', name: 'AUD', symbol: 'AUD', active: false } })

  gate.parked = new Promise<void>((r) => { signalParked = r })
  gate.armed = true
  let releaseHolder: () => void = () => {}
  const holderGate = new Promise<void>((r) => { releaseHolder = r })
  let holderIn: () => void = () => {}
  const holderEntered = new Promise<void>((r) => { holderIn = r })
  const holder = withFxTableWriteLock(async () => { holderIn(); await holderGate })
  await holderEntered

  // The second request (B) starts first, while the lock is held. With a pre-lock check it reads the base (GBP) and parks before it reads the marker; without one it queues for the lock.
  const second = updateOrganisation({ baseCurrency: 'aud ' })
  const parkedOrQueued = await Promise.race([gate.parked.then(() => 'parked'), waitingOnAdvisoryLock(db).then((n) => (n >= 1 ? 'queued' : 'neither'))])
  assert.notEqual(parkedOrQueued, 'neither', 'PRECONDITION: the second request is parked before the lock, or queued for it')

  // The lock holder lets go; an earlier-arriving-in-effect request (A) changes the base to the same code, commits and sets the marker.
  releaseHolder()
  await holder
  const first = await updateOrganisation({ baseCurrency: 'AUD' })
  assert.deepEqual(first, { success: true })
  assert.equal((await db.setting.findUnique({ where: { key: 'base_currency_locked' } }))?.value, 'true', 'PRECONDITION: the first change set the lock marker')

  // Now the second request goes on. Under the lock the base is already AUD: no change, nothing to refuse.
  gate.release()
  assert.deepEqual(await second, { success: true }, 'the second change to the same base is not refused by the marker the first one set')
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'AUD')
})

test('under the lock a change to a DIFFERENT base is still refused once the lock marker is set, and nothing is written', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  // (company.ts is already loaded with the marker-only isBaseCurrencyLocked from the first test, whose gate is disarmed here)
  const { updateOrganisation } = await import('@/app/actions/company')
  const orgExisted = await db.organisation.findFirst({ select: { id: true, baseCurrency: true } })
  const org = orgExisted ?? await db.organisation.create({ data: { name: 'Base lock test org', baseCurrency: 'GBP' }, select: { id: true, baseCurrency: true } })
  const lockedSetting = await db.setting.findUnique({ where: { key: 'base_currency_locked' } })
  const sourceKeys = ['fx_rate_source', 'fx_rate_source_since', 'fx_rate_source_history']
  const savedSource = await db.setting.findMany({ where: { key: { in: sourceKeys } } })
  const nzdExisted = (await db.currency.count({ where: { code: 'NZD' } })) > 0
  const gbpExisted = (await db.currency.count({ where: { code: 'GBP' } })) > 0 // a base change (even to the current base) creates the base currency row when it is missing
  t.after(async () => {
    if (!gbpExisted) await db.currency.deleteMany({ where: { code: 'GBP' } })
    if (orgExisted) await db.organisation.update({ where: { id: org.id }, data: { baseCurrency: org.baseCurrency } })
    else await db.organisation.deleteMany({ where: { id: org.id } })
    if (!nzdExisted) await db.currency.deleteMany({ where: { code: 'NZD' } })
    await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
    for (const s of [...savedSource, ...(lockedSetting ? [lockedSetting] : [])]) await db.setting.create({ data: { key: s.key, value: s.value } })
  })
  await db.setting.deleteMany({ where: { key: { in: sourceKeys } } })
  await db.organisation.updateMany({ data: { baseCurrency: 'GBP' } })
  await db.setting.upsert({ where: { key: 'base_currency_locked' }, create: { key: 'base_currency_locked', value: 'true' }, update: { value: 'true' } })
  const refused = await updateOrganisation({ baseCurrency: 'NZD' })
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /locked after setup/)
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'GBP', 'the base currency was not changed')
  assert.equal(await db.currency.count({ where: { code: 'NZD' } }), nzdExisted ? 1 : 0, 'the would-be base currency was not created')
  assert.deepEqual(await updateOrganisation({ baseCurrency: 'GBP' }), { success: true }, 'the current base is no change, so the lock does not refuse it')
})

test('two queued changes to DIFFERENT bases on an empty install: the first commits the base and the lock marker together, the second is refused in the lock', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { withFxTableWriteLock } = await import('@/lib/currencies/fx-table-lock')
  const { updateOrganisation } = await import('@/app/actions/company')
  const orgExisted = await db.organisation.findFirst({ select: { id: true, baseCurrency: true } })
  const org = orgExisted ?? await db.organisation.create({ data: { name: 'Base lock test org', baseCurrency: 'GBP' }, select: { id: true, baseCurrency: true } })
  const lockedSetting = await db.setting.findUnique({ where: { key: 'base_currency_locked' } })
  const sourceKeys = ['fx_rate_source', 'fx_rate_source_since', 'fx_rate_source_history']
  const savedSource = await db.setting.findMany({ where: { key: { in: sourceKeys } } })
  const existing = new Set((await db.currency.findMany({ where: { code: { in: ['AUD', 'NZD', 'GBP'] } }, select: { code: true } })).map((c) => c.code))
  let releaseMarkerHold: () => void = () => {}
  t.after(async () => {
    releaseMarkerHold()
    if (orgExisted) await db.organisation.update({ where: { id: org.id }, data: { baseCurrency: org.baseCurrency } })
    else await db.organisation.deleteMany({ where: { id: org.id } })
    await db.currency.deleteMany({ where: { code: { in: ['AUD', 'NZD', 'GBP'].filter((c) => !existing.has(c)) } } })
    await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
    for (const s of [...savedSource, ...(lockedSetting ? [lockedSetting] : [])]) await db.setting.create({ data: { key: s.key, value: s.value } })
  })
  await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
  await db.organisation.updateMany({ data: { baseCurrency: 'GBP' } })

  // Another session has the marker row inserted and uncommitted (value false: not locked). Whoever writes the marker waits for it. A marker written INSIDE the lock transaction makes the lock holder wait here
  // with the FX lock still held, so the second request cannot get in; a marker written AFTER the lock is released leaves the second request free to take the lock and find no marker.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const markerHeld = new Promise<void>((r) => { releaseMarkerHold = r })
  let markerIn: () => void = () => {}
  const markerInserted = new Promise<void>((r) => { markerIn = r })
  const markerSession = db.$transaction(async (tx) => {
    await tx.setting.create({ data: { key: 'base_currency_locked', value: 'false' } })
    markerIn()
    await markerHeld
    throw new Error('rollback the held marker row')
  }, { timeout: 60_000 }).catch(() => {})
  await markerInserted

  let releaseHolder: () => void = () => {}
  const holderGate = new Promise<void>((r) => { releaseHolder = r })
  let holderIn: () => void = () => {}
  const holderEntered = new Promise<void>((r) => { holderIn = r })
  const holder = withFxTableWriteLock(async () => { holderIn(); await holderGate })
  await holderEntered
  const a = updateOrganisation({ baseCurrency: 'AUD' })
  const b = updateOrganisation({ baseCurrency: 'NZD' })
  let queued = 0
  for (let i = 0; i < 100 && queued < 2; i++) {
    queued = Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)[0]?.n ?? 0)
    if (queued < 2) await sleep(50)
  }
  assert.equal(queued, 2, 'PRECONDITION: both changes wait on the FX table lock')
  releaseHolder()
  await holder
  // Release the marker row only when the database shows where each request is: one is blocked on the marker row (a transaction id it waits for), and the other is either still waiting on the FX lock (the lock
  // was kept) or has already finished (the lock was let go and it took it).
  let settled = 0
  const aWatched = a.finally(() => { settled++ })
  const bWatched = b.finally(() => { settled++ })
  let observed = false
  for (let i = 0; i < 200 && !observed; i++) {
    const [row] = await db.$queryRaw<Array<{ blocked: bigint; queued: bigint }>>`SELECT
      count(*) FILTER (WHERE locktype = 'transactionid' AND NOT granted)::bigint AS blocked,
      count(*) FILTER (WHERE locktype = 'advisory' AND NOT granted)::bigint AS queued FROM pg_locks`
    observed = Number(row?.blocked ?? 0) >= 1 && (Number(row?.queued ?? 0) >= 1 || settled >= 1)
    if (!observed) await sleep(50)
  }
  assert.ok(observed, 'PRECONDITION: a marker write is blocked on the held marker row, and the other change is queued on the FX lock or finished')
  releaseMarkerHold()
  await markerSession
  await Promise.all([aWatched, bWatched])
  const results = await Promise.all([a, b])
  assert.equal(results.filter((r) => r.success).length, 1, 'exactly one of the two different-base changes is applied')
  const refused = results.find((r) => !r.success)
  assert.match(refused?.error ?? '', /locked after setup/, 'the other was refused in the lock')
  const winner = results[0].success ? 'AUD' : 'NZD'
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, winner)
  assert.equal((await db.setting.findUnique({ where: { key: 'base_currency_locked' } }))?.value, 'true', 'the marker committed with the base')
})

test('a base value that is empty, blank, malformed or in lower case is normalised and checked, and never skips the lock', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { updateOrganisation } = await import('@/app/actions/company')
  const orgExisted = await db.organisation.findFirst({ select: { id: true, baseCurrency: true, name: true } })
  const org = orgExisted ?? await db.organisation.create({ data: { name: 'Base lock test org', baseCurrency: 'GBP' }, select: { id: true, baseCurrency: true, name: true } })
  const lockedSetting = await db.setting.findUnique({ where: { key: 'base_currency_locked' } })
  const sourceKeys = ['fx_rate_source', 'fx_rate_source_since', 'fx_rate_source_history']
  const savedSource = await db.setting.findMany({ where: { key: { in: sourceKeys } } })
  const codes = ['', 'NZD', 'GBP']
  const existing = new Set((await db.currency.findMany({ where: { code: { in: codes } }, select: { code: true } })).map((c) => c.code))
  t.after(async () => {
    if (orgExisted) await db.organisation.update({ where: { id: org.id }, data: { baseCurrency: org.baseCurrency, name: org.name } })
    else await db.organisation.deleteMany({ where: { id: org.id } })
    await db.currency.deleteMany({ where: { code: { in: codes.filter((c) => !existing.has(c)) } } })
    await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
    for (const s of [...savedSource, ...(lockedSetting ? [lockedSetting] : [])]) await db.setting.create({ data: { key: s.key, value: s.value } })
  })
  await db.setting.deleteMany({ where: { key: { in: sourceKeys } } })
  await db.currency.upsert({ where: { code: 'GBP' }, update: {}, create: { code: 'GBP', name: 'GBP', symbol: 'GBP', active: true } })
  await db.organisation.updateMany({ data: { baseCurrency: 'GBP' } })
  await db.setting.upsert({ where: { key: 'base_currency_locked' }, create: { key: 'base_currency_locked', value: 'true' }, update: { value: 'true' } })
  const currencyCount = await db.currency.count()

  for (const bad of ['   ', '', 'ab', 'EURO', 'E1R', ' e r ', '\t']) {
    const result = await updateOrganisation({ baseCurrency: bad })
    assert.equal(result.success, false, `${JSON.stringify(bad)} is refused`)
    assert.match(result.error ?? '', /valid base currency/, `${JSON.stringify(bad)} is refused as not a currency code`)
    assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'GBP', `${JSON.stringify(bad)} wrote nothing`)
    assert.equal(await db.currency.count(), currencyCount, `${JSON.stringify(bad)} created no currency`)
  }
  const nullBase = await updateOrganisation({ baseCurrency: null as unknown as string })
  assert.equal(nullBase.success, false, 'null is refused')
  const differentLower = await updateOrganisation({ baseCurrency: ' nzd ' })
  assert.equal(differentLower.success, false)
  assert.match(differentLower.error ?? '', /locked after setup/, 'a lower-case padded code is normalised and reaches the lock')
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'GBP')
  assert.equal(await db.currency.count({ where: { code: 'NZD' } }), existing.has('NZD') ? 1 : 0, 'the refused code was not created')
  assert.deepEqual(await updateOrganisation({ baseCurrency: ' gbp ' }), { success: true }, 'the same base, lower case and padded, is normalised and is no change')
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'GBP')
  assert.deepEqual(await updateOrganisation({ name: 'Renamed' }), { success: true }, 'a request with no base at all does not touch it')
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'GBP')
})

test('on an unlocked install an unsupported three-letter code is refused with nothing written, and a supported but inactive ISO code still becomes the base', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { updateOrganisation } = await import('@/app/actions/company')
  const orgExisted = await db.organisation.findFirst({ select: { id: true, baseCurrency: true } })
  const org = orgExisted ?? await db.organisation.create({ data: { name: 'Base lock test org', baseCurrency: 'GBP' }, select: { id: true, baseCurrency: true } })
  const lockedSetting = await db.setting.findUnique({ where: { key: 'base_currency_locked' } })
  const sourceKeys = ['fx_rate_source', 'fx_rate_source_since', 'fx_rate_source_history']
  const savedSource = await db.setting.findMany({ where: { key: { in: sourceKeys } } })
  const codes = ['ZZZ', 'XYZ', 'NOK', 'GBP']
  const existing = new Map((await db.currency.findMany({ where: { code: { in: codes } }, select: { code: true, active: true } })).map((c) => [c.code, c.active]))
  t.after(async () => {
    if (orgExisted) await db.organisation.update({ where: { id: org.id }, data: { baseCurrency: org.baseCurrency } })
    else await db.organisation.deleteMany({ where: { id: org.id } })
    await db.currency.deleteMany({ where: { code: { in: codes.filter((c) => !existing.has(c)) } } })
    for (const [code, active] of existing) await db.currency.update({ where: { code }, data: { active } })
    await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
    for (const s of [...savedSource, ...(lockedSetting ? [lockedSetting] : [])]) await db.setting.create({ data: { key: s.key, value: s.value } })
  })
  await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
  await db.currency.upsert({ where: { code: 'GBP' }, update: {}, create: { code: 'GBP', name: 'GBP', symbol: 'GBP', active: true } })
  await db.currency.upsert({ where: { code: 'NOK' }, update: { active: false }, create: { code: 'NOK', name: 'NOK', symbol: 'kr', active: false } })
  await db.organisation.updateMany({ data: { baseCurrency: 'GBP' } })
  const currencyCount = await db.currency.count()

  for (const bad of ['ZZZ', ' xyz ']) {
    const result = await updateOrganisation({ baseCurrency: bad })
    assert.equal(result.success, false, `${JSON.stringify(bad)} is refused`)
    assert.match(result.error ?? '', /valid base currency/)
    assert.equal(await db.currency.count(), currencyCount, `${JSON.stringify(bad)} created no currency`)
    assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'GBP')
    assert.equal(await db.setting.findUnique({ where: { key: 'base_currency_locked' } }), null, `${JSON.stringify(bad)} did not lock the base currency`)
  }
  assert.deepEqual(await updateOrganisation({ baseCurrency: ' nok ' }), { success: true }, 'a supported ISO code that is inactive becomes the base')
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'NOK')
  assert.equal((await db.currency.findUnique({ where: { code: 'NOK' } }))?.active, true, 'and is activated')
  assert.equal((await db.setting.findUnique({ where: { key: 'base_currency_locked' } }))?.value, 'true')
})

test('pool size + 2 concurrent changes to DIFFERENT bases: exactly one is applied, the rest are refused in the lock, and none asks the pool for a second connection', SKIP, async (t) => {
  loadEnv()
  const { db, dbPoolConfig, DB_POOL_ACQUISITION_TIMEOUT_MS } = await import('@/lib/db')
  const { updateOrganisation } = await import('@/app/actions/company')
  const poolSize = dbPoolConfig().max
  const many = poolSize + 2
  const { PACK_KNOWN_CURRENCIES } = await import('@/lib/reconciliation-pack/constants')
  const codes = [...PACK_KNOWN_CURRENCIES].filter((c) => c !== 'GBP').slice(0, many) // real ISO codes: an unknown one is refused before the lock
  const existingRows = await db.currency.findMany({ where: { code: { in: codes } }, select: { code: true, active: true } })
  const existingCodes = new Set(existingRows.map((c) => c.code))
  const orgExisted = await db.organisation.findFirst({ select: { id: true, baseCurrency: true } })
  const org = orgExisted ?? await db.organisation.create({ data: { name: 'Base lock test org', baseCurrency: 'GBP' }, select: { id: true, baseCurrency: true } })
  const lockedSetting = await db.setting.findUnique({ where: { key: 'base_currency_locked' } })
  const sourceKeys = ['fx_rate_source', 'fx_rate_source_since', 'fx_rate_source_history']
  const savedSource = await db.setting.findMany({ where: { key: { in: sourceKeys } } })
  const gbpExisted = (await db.currency.count({ where: { code: 'GBP' } })) > 0
  t.after(async () => {
    if (orgExisted) await db.organisation.update({ where: { id: org.id }, data: { baseCurrency: org.baseCurrency } })
    else await db.organisation.deleteMany({ where: { id: org.id } })
    await db.currency.deleteMany({ where: { code: { in: codes.filter((c) => !existingCodes.has(c)) } } })
    for (const row of existingRows) await db.currency.update({ where: { code: row.code }, data: { active: row.active } })
    if (!gbpExisted) await db.currency.deleteMany({ where: { code: 'GBP' } })
    await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
    for (const s of [...savedSource, ...(lockedSetting ? [lockedSetting] : [])]) await db.setting.create({ data: { key: s.key, value: s.value } })
  })
  await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
  await db.organisation.updateMany({ data: { baseCurrency: 'GBP' } })

  // every request has a target other than the base it will find, so every one of them reaches the lock marker read inside the lock; a request that reads it on the global client needs a second connection
  // from a pool the waiters have used up
  const started = Date.now()
  const results = await Promise.all(codes.map((code) => updateOrganisation({ baseCurrency: code })))
  const elapsed = Date.now() - started
  assert.equal(results.filter((r) => r.success).length, 1, 'exactly one change is applied: the marker commits with the base, so every request behind it is refused in the lock')
  assert.deepEqual(results.filter((r) => !r.success && !/locked after setup/.test(r.error ?? '')), [], 'the rest are refused by the lock marker; none fails for want of a connection')
  assert.ok(elapsed < DB_POOL_ACQUISITION_TIMEOUT_MS, `and the lot finishes without waiting out the pool's acquisition timeout (${elapsed} ms)`)
})
